// Session Detail read model (spec 44, 45, 84, 109, 140, 158, 169): everything a
// researcher needs to inspect what happened to one session and each utterance.
// Read-only. Transcripts are edited on the Review page.
import { and, asc, desc, eq, inArray, or, sql, type SQLWrapper } from "drizzle-orm";
import {
  consentVersions,
  englishChecks,
  outputReviewItems,
  outputReviews,
  jobs,
  mediaAssets,
  modelRuns,
  processingBatches,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireAnswers,
  questionnaireItems,
  questionnaireResponses,
  questionnaireVersions,
  researchFlags,
  researchNotes,
  sessionConsents,
  sessions,
  studies,
  taskPresentations,
  utterances,
  type DbOrTx,
  type QuestionnaireItemConfig,
} from "@dialect/db";
import { AppError, corpusSchemas, sessionSchemas, type InputDeviceClass, type QuestionnaireItemType } from "@dialect/domain";
import type { ServiceContext } from "../context";
import {
  loadModelRunLookup,
  loadUtteranceLineages,
  toModelRunSummary,
  type LineageData,
  type UtteranceLineage,
} from "./lineage";
import { adminTimezoneOf, toIso, toMediaView, type MediaAssetRow, type ModelRunRow } from "./shared";

type UtteranceRow = typeof utterances.$inferSelect;
type PresentationRow = typeof taskPresentations.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

const PROCESSING_HISTORY_LIMIT = 500;

// ---------------------------------------------------------------------------
// Questionnaire answers
// ---------------------------------------------------------------------------

function displayAnswer(type: QuestionnaireItemType, config: QuestionnaireItemConfig, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const labelOf = (option: unknown): string => {
    const match = config.options?.find((candidate) => candidate.value === String(option));
    return match ? match.label : String(option);
  };
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (type === "multi_choice" && Array.isArray(value)) {
    return value.length === 0 ? null : value.map(labelOf).join("; ");
  }
  if (type === "single_choice") return labelOf(value);
  if (type === "likert" && config.scaleMin !== undefined && config.scaleMax !== undefined) {
    return `${String(value)} (scale ${config.scaleMin} to ${config.scaleMax})`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// The questionnaires a session submitted. The questionnaires area offers the
// same data as questionnaires.getQuestionnaireResponsesForSession; this is the
// independent query of Session Detail.
export async function loadQuestionnaireResponses(
  db: DbOrTx,
  sessionId: string,
): Promise<corpusSchemas.QuestionnaireResponseView[]> {
  const responses = await db
    .select({
      responseId: questionnaireResponses.id,
      submittedAt: questionnaireResponses.submittedAt,
      versionId: questionnaireVersions.id,
      key: questionnaireVersions.key,
      versionNumber: questionnaireVersions.versionNumber,
      name: questionnaireVersions.name,
    })
    .from(questionnaireResponses)
    .innerJoin(questionnaireVersions, eq(questionnaireVersions.id, questionnaireResponses.questionnaireVersionId))
    .where(eq(questionnaireResponses.sessionId, sessionId))
    .orderBy(asc(questionnaireResponses.submittedAt));
  if (responses.length === 0) return [];

  const items = await db
    .select()
    .from(questionnaireItems)
    .where(
      inArray(
        questionnaireItems.questionnaireVersionId,
        responses.map((response) => response.versionId),
      ),
    )
    .orderBy(asc(questionnaireItems.orderIndex), asc(questionnaireItems.itemKey));
  const answers = await db
    .select()
    .from(questionnaireAnswers)
    .where(
      inArray(
        questionnaireAnswers.responseId,
        responses.map((response) => response.responseId),
      ),
    );
  const values = new Map(answers.map((answer) => [`${answer.responseId}:${answer.questionnaireItemId}`, answer.valueJson]));

  return responses.map((response) => ({
    responseId: response.responseId,
    submittedAt: toIso(response.submittedAt),
    questionnaire: {
      versionId: response.versionId,
      key: response.key,
      versionNumber: response.versionNumber,
      name: response.name,
    },
    answers: items
      .filter((item) => item.questionnaireVersionId === response.versionId)
      .map((item) => {
        const value = values.get(`${response.responseId}:${item.id}`) ?? null;
        return {
          itemId: item.id,
          itemKey: item.itemKey,
          type: item.type,
          prompt: item.prompt,
          required: item.required,
          orderIndex: item.orderIndex,
          value,
          display: displayAnswer(item.type, item.configJson ?? {}, value),
        };
      }),
  }));
}

// ---------------------------------------------------------------------------
// Quality indicators (spec 84). Informational: nothing is excluded here.
// ---------------------------------------------------------------------------

function qualityIndicators(input: {
  utterance: UtteranceRow;
  source: MediaAssetRow | null;
  minDurationSeconds: number | null;
  lineage: UtteranceLineage | undefined;
  asrFailed: boolean;
}): corpusSchemas.QualityIndicator[] {
  const { utterance, source, lineage } = input;
  const indicators: corpusSchemas.QualityIndicator[] = [];
  const hasAudio = source !== null && source.deletedAt === null;
  if (!hasAudio) indicators.push("missing_audio");

  const durationMs = utterance.durationMs ?? source?.durationMs ?? null;
  const minimumMs =
    input.minDurationSeconds !== null && input.minDurationSeconds > 0
      ? input.minDurationSeconds * 1000
      : corpusSchemas.SHORT_AUDIO_THRESHOLD_MS;
  if (hasAudio && durationMs !== null && durationMs < minimumMs) indicators.push("too_short");

  const warnings = utterance.qualityJson?.warnings ?? [];
  if (warnings.includes("possible_clipping")) indicators.push("possible_clipping");
  if (warnings.includes("low_signal")) indicators.push("low_signal");
  if (warnings.includes("mostly_silent")) indicators.push("mostly_silent");
  if (source?.captureQualityClass === "compressed_fallback") indicators.push("compressed_fallback");
  if (input.asrFailed) indicators.push("asr_failed");

  const cell = (type: string) => lineage?.transcripts.find((transcript) => transcript.type === type);
  const b = cell("human_dialect");
  const c = cell("normalized");
  if (!b?.current) indicators.push("missing_b");
  else if (b.status !== "verified") indicators.push("unverified_b");
  if (!c?.current) indicators.push("missing_c");
  else if (c.status !== "verified") indicators.push("unverified_c");
  return indicators;
}

// ---------------------------------------------------------------------------
// Completeness checks (spec 109). They assist the researcher; the raw fields
// stay visible in the same view.
// ---------------------------------------------------------------------------

function completenessChecks(input: {
  expectedTasks: number;
  presentations: PresentationRow[];
  utteranceRows: UtteranceRow[];
  mediaById: Map<string, MediaAssetRow>;
  lineage: LineageData;
  backgroundExpected: boolean;
  postExpected: boolean;
  background: corpusSchemas.QuestionnaireResponseView | null;
  post: corpusSchemas.QuestionnaireResponseView | null;
  openFailures: number;
  pendingJobs: number;
}): corpusSchemas.CompletenessCheck[] {
  const { utteranceRows, lineage } = input;
  const hasStoredAudio = (utterance: UtteranceRow): boolean => {
    const asset = utterance.acceptedMediaAssetId ? input.mediaById.get(utterance.acceptedMediaAssetId) : undefined;
    return utterance.submittedAt !== null && asset !== undefined && asset.deletedAt === null;
  };

  // Source audio: every task of the protocol was presented and its main prompt
  // (turn 0) has a stored recording.
  const tasksWithAudio = input.presentations.filter((presentation) =>
    utteranceRows.some(
      (utterance) =>
        utterance.taskPresentationId === presentation.id && utterance.turnIndex === 0 && hasStoredAudio(utterance),
    ),
  ).length;
  const withoutAudio = utteranceRows.filter(
    (utterance) => utterance.status !== "invalid" && utterance.status !== "recording" && !hasStoredAudio(utterance),
  ).length;
  const sourceAudio: corpusSchemas.CompletenessCheck = {
    key: "source_audio_complete",
    applicable: true,
    complete: input.expectedTasks > 0 && tasksWithAudio >= input.expectedTasks && withoutAudio === 0,
    detail:
      `${tasksWithAudio} of ${input.expectedTasks} tasks have a stored recording for the main prompt` +
      (withoutAudio > 0 ? `; ${withoutAudio} utterances have no stored recording` : ""),
  };

  const questionnaireCheck = (
    key: "background_complete" | "post_questionnaire_complete",
    expected: boolean,
    response: corpusSchemas.QuestionnaireResponseView | null,
  ): corpusSchemas.CompletenessCheck => {
    if (!expected) {
      return { key, applicable: false, complete: true, detail: "The protocol of this session has no such questionnaire" };
    }
    if (!response) return { key, applicable: true, complete: false, detail: "Not submitted" };
    const required = response.answers.filter((answer) => answer.required);
    const answered = required.filter((answer) => answer.display !== null).length;
    return {
      key,
      applicable: true,
      complete: answered === required.length,
      detail: `Submitted; ${answered} of ${required.length} required items answered`,
    };
  };

  // Transcripts: every submitted utterance has a verified B and a verified C.
  const submitted = utteranceRows.filter((utterance) => utterance.status === "submitted");
  const verified = (utteranceId: string, type: "human_dialect" | "normalized"): boolean =>
    lineage.byUtterance.get(utteranceId)?.transcripts.find((transcript) => transcript.type === type)?.status ===
    "verified";
  const verifiedB = submitted.filter((utterance) => verified(utterance.id, "human_dialect")).length;
  const verifiedC = submitted.filter((utterance) => verified(utterance.id, "normalized")).length;
  const transcriptsCheck: corpusSchemas.CompletenessCheck = {
    key: "required_transcripts_complete",
    applicable: true,
    complete: submitted.length > 0 && verifiedB === submitted.length && verifiedC === submitted.length,
    detail: `Verified B for ${verifiedB} of ${submitted.length} utterances, verified C for ${verifiedC} of ${submitted.length}`,
  };

  // Processing: for every batch that produced or should produce outputs for this
  // session, each configured translation and synthesis exists, and nothing is
  // waiting or failed.
  const submittedIds = new Set(submitted.map((utterance) => utterance.id));
  const transcriptById = new Map(lineage.transcripts.map((row) => [row.id, row]));
  const revisionById = new Map(lineage.revisions.map((row) => [row.id, row]));
  let expectedOutputs = 0;
  let presentOutputs = 0;
  let coveringBatches = 0;
  for (const batch of lineage.batches) {
    if (batch.status === "draft" || batch.status === "cancelled") continue;
    const snapshot = batch.configurationSnapshotJson;
    const batchTranslations = lineage.translations.filter((row) => row.processingBatchId === batch.id);
    const covered = new Set<string>(
      (snapshot?.utteranceIds ?? []).filter((utteranceId) => submittedIds.has(utteranceId)),
    );
    for (const translation of batchTranslations) {
      const revision = revisionById.get(translation.sourceTranscriptRevisionId);
      const transcript = revision ? transcriptById.get(revision.transcriptId) : undefined;
      if (transcript && submittedIds.has(transcript.utteranceId)) covered.add(transcript.utteranceId);
    }
    if (covered.size === 0) continue;
    coveringBatches += 1;
    const conditionKeys = (snapshot?.translations ?? []).map((config) => config.conditionKey ?? config.key);
    const ttsKeys = (snapshot?.tts ?? []).map((config) => config.conditionKey ?? config.key);
    for (const utteranceId of covered) {
      for (const type of snapshot?.transcriptTypes ?? []) {
        const transcript = lineage.transcripts.find((row) => row.utteranceId === utteranceId && row.type === type);
        if (!transcript) continue;
        const revisionIds = new Set(
          lineage.revisions.filter((row) => row.transcriptId === transcript.id).map((row) => row.id),
        );
        if (revisionIds.size === 0) continue;
        for (const conditionKey of conditionKeys) {
          expectedOutputs += 1;
          const produced = batchTranslations.filter(
            (row) => revisionIds.has(row.sourceTranscriptRevisionId) && row.conditionKey === conditionKey,
          );
          if (produced.length > 0) presentOutputs += 1;
          for (const ttsKey of ttsKeys) {
            expectedOutputs += 1;
            const synthesized = lineage.syntheses.some(
              (row) =>
                row.processingBatchId === batch.id &&
                row.conditionKey === ttsKey &&
                produced.some((translation) => translation.id === row.translationId),
            );
            if (synthesized) presentOutputs += 1;
          }
        }
      }
    }
  }
  const processingDetail =
    coveringBatches === 0
      ? "No processing batch has produced outputs for this session yet"
      : `${presentOutputs} of ${expectedOutputs} configured outputs present in ${coveringBatches} ` +
        `${coveringBatches === 1 ? "batch" : "batches"}; ${input.openFailures} open failed runs; ` +
        `${input.pendingJobs} jobs waiting or failed`;
  const processing: corpusSchemas.CompletenessCheck = {
    key: "processing_complete",
    applicable: true,
    complete:
      coveringBatches > 0 && presentOutputs === expectedOutputs && input.openFailures === 0 && input.pendingJobs === 0,
    detail: processingDetail,
  };

  return [
    sourceAudio,
    questionnaireCheck("background_complete", input.backgroundExpected, input.background),
    questionnaireCheck("post_questionnaire_complete", input.postExpected, input.post),
    transcriptsCheck,
    processing,
  ];
}

// ---------------------------------------------------------------------------
// Processing history
// ---------------------------------------------------------------------------

function textIn(column: SQLWrapper, key: string, ids: string[]) {
  return inArray(sql<string>`${column}->>${key}`, ids);
}

async function loadProcessingHistory(
  db: DbOrTx,
  ids: { utteranceIds: string[]; mediaIds: string[]; revisionIds: string[]; translationIds: string[] },
): Promise<{ runs: ModelRunRow[]; jobs: JobRow[] }> {
  const sourceIds = [...ids.utteranceIds, ...ids.mediaIds, ...ids.revisionIds, ...ids.translationIds];
  if (ids.utteranceIds.length === 0 && sourceIds.length === 0) return { runs: [], jobs: [] };

  const runs = await db
    .select()
    .from(modelRuns)
    .where(
      or(
        inArray(modelRuns.sourceEntityId, sourceIds),
        ids.utteranceIds.length > 0 ? textIn(modelRuns.inputManifestJson, "utteranceId", ids.utteranceIds) : undefined,
      ),
    )
    .orderBy(desc(modelRuns.startedAt))
    .limit(PROCESSING_HISTORY_LIMIT);

  const jobConditions = [
    ids.utteranceIds.length > 0 ? textIn(jobs.payloadJson, "utteranceId", ids.utteranceIds) : undefined,
    ids.mediaIds.length > 0 ? textIn(jobs.payloadJson, "mediaAssetId", ids.mediaIds) : undefined,
    ids.revisionIds.length > 0 ? textIn(jobs.payloadJson, "sourceTranscriptRevisionId", ids.revisionIds) : undefined,
    ids.translationIds.length > 0 ? textIn(jobs.payloadJson, "translationId", ids.translationIds) : undefined,
  ].filter((condition) => condition !== undefined);
  const jobRows =
    jobConditions.length === 0
      ? []
      : await db
          .select()
          .from(jobs)
          .where(or(...jobConditions))
          .orderBy(desc(jobs.createdAt))
          .limit(PROCESSING_HISTORY_LIMIT);
  return { runs, jobs: jobRows };
}

// ---------------------------------------------------------------------------
// Recorder facts of a recording
// ---------------------------------------------------------------------------

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// A requested or actual constraint value as short JSON text.
function jsonText(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return (JSON.stringify(value) ?? null)?.slice(0, 200) ?? null;
  } catch {
    return null;
  }
}

// The coarse class of the input device. The upload service stores the class in
// the field `deviceLabel` (the field kept its name). A row stored before that
// change may hold the raw device name there: it is reduced to its class with
// the same keyword rule, so the raw name never reaches the admin.
function deviceClassOf(facts: Record<string, unknown>): InputDeviceClass | null {
  for (const value of [facts.deviceClass, facts.deviceLabel]) {
    if (typeof value === "string" && value.trim() !== "") return sessionSchemas.toInputDeviceClass(value);
  }
  return null;
}

// The facts the browser recorder declared with an upload (spec 31.1, 32, 84).
// The upload service stores them under `declared` in media_assets.metadata_json
// (sessions/tasks.ts, demo/recording.ts). The column is free JSON, so every
// value is checked. Returns null when the row holds none of these facts.
export function captureDetailsOf(metadata: unknown): corpusSchemas.CaptureDetailsView | null {
  const declared =
    metadata !== null && typeof metadata === "object" ? (metadata as { declared?: unknown }).declared : undefined;
  if (declared === null || typeof declared !== "object") return null;
  const facts = declared as Record<string, unknown>;

  const constraintMismatches: corpusSchemas.CaptureConstraintMismatch[] = [];
  if (Array.isArray(facts.constraintMismatches)) {
    for (const entry of facts.constraintMismatches) {
      if (entry === null || typeof entry !== "object") continue;
      const mismatch = entry as Record<string, unknown>;
      const constraint = text(mismatch.constraint);
      if (!constraint) continue;
      constraintMismatches.push({
        constraint,
        kind: text(mismatch.kind) ?? "not_reported",
        requested: jsonText(mismatch.requested),
        actual: jsonText(mismatch.actual),
      });
    }
  }

  const details: corpusSchemas.CaptureDetailsView = {
    constraintMismatches,
    deviceClass: deviceClassOf(facts),
    fallbackReason: text(facts.fallbackReason),
    fallbackDetail: text(facts.fallbackDetail),
    inputChannelCount: finite(facts.inputChannelCount),
    clippedSampleCount: finite(facts.clippedSampleCount),
    peak: finite(facts.peak),
    declaredBitDepth: finite(facts.bitDepth),
    stoppedBy: text(facts.stoppedBy),
  };
  const { constraintMismatches: mismatches, ...rest } = details;
  const empty = mismatches.length === 0 && Object.values(rest).every((value) => value === null);
  return empty ? null : details;
}

// ---------------------------------------------------------------------------
// getSessionDetail
// ---------------------------------------------------------------------------

// The English check and the output review of one session (sessions/output-review.ts).
async function loadOutputReview(
  db: DbOrTx,
  sessionId: string,
): Promise<Pick<corpusSchemas.SessionDetail, "englishCheck" | "outputReview">> {
  const [check] = await db.select().from(englishChecks).where(eq(englishChecks.sessionId, sessionId));
  const [review] = await db.select().from(outputReviews).where(eq(outputReviews.sessionId, sessionId));
  const items = review
    ? await db
        .select()
        .from(outputReviewItems)
        .where(eq(outputReviewItems.reviewId, review.id))
        .orderBy(asc(outputReviewItems.presentationIndex))
    : [];
  return {
    englishCheck: check
      ? {
          testVersion: check.testVersion,
          score: Number(check.score),
          wordsCorrect: check.wordsCorrect,
          nonwordsCorrect: check.nonwordsCorrect,
          submittedAt: toIso(check.submittedAt),
        }
      : null,
    outputReview: review
      ? {
          status: review.status as corpusSchemas.OutputReviewView["status"],
          scaleVersion: review.scaleVersion,
          skippedAtStep: review.skippedAtStep,
          startedAt: toIso(review.startedAt),
          finishedAt: review.finishedAt ? toIso(review.finishedAt) : null,
          selection: review.selectionJson as Record<string, unknown>,
          items: items.map((item) => {
            const shown = item.shownJson;
            const tokens = shown.sourceTokens ?? [];
            const marked = item.markedWordsJson ?? null;
            return {
              id: item.id,
              position: item.presentationIndex + 1,
              kind: item.kind as corpusSchemas.OutputReviewItemView["kind"],
              utteranceId: item.utteranceId,
              transcriptRevisionId: item.transcriptRevisionId,
              sourceText: shown.sourceText,
              version1: { text: shown.version1, conditionKey: item.leftConditionKey, translationId: item.leftTranslationId },
              version2: { text: shown.version2, conditionKey: item.rightConditionKey, translationId: item.rightTranslationId },
              changedSlot: shown.changedSlot ?? null,
              ratings: item.ratingsJson ?? null,
              choice: item.choice,
              markedTokens: marked,
              markedWords: (marked ?? []).map((index) => tokens[index] ?? "").filter(Boolean),
              cantJudge: item.cantJudgeJson ?? [],
              scaleVersion: item.scaleVersion,
              answeredAt: item.answeredAt ? toIso(item.answeredAt) : null,
            };
          }),
        }
      : null,
  };
}

export async function getSessionDetail(ctx: ServiceContext, sessionId: string): Promise<corpusSchemas.SessionDetail> {
  const db = ctx.db;
  const [row] = await db
    .select({ session: sessions, protocol: protocolVersions, settings: studies.settingsJson })
    .from(sessions)
    .innerJoin(protocolVersions, eq(protocolVersions.id, sessions.protocolVersionId))
    .innerJoin(studies, eq(studies.id, sessions.studyId))
    .where(eq(sessions.id, sessionId));
  if (!row) throw new AppError("NOT_FOUND", "The session does not exist.", { sessionId });
  const { session, protocol } = row;

  const [consentRow] = await db
    .select({ consent: sessionConsents, version: consentVersions })
    .from(sessionConsents)
    .innerJoin(consentVersions, eq(consentVersions.id, sessionConsents.consentVersionId))
    .where(eq(sessionConsents.sessionId, sessionId));

  const presentationRows = await db
    .select({ presentation: taskPresentations, task: protocolTasks })
    .from(taskPresentations)
    .innerJoin(protocolTasks, eq(protocolTasks.id, taskPresentations.protocolTaskId))
    .where(eq(taskPresentations.sessionId, sessionId))
    .orderBy(asc(taskPresentations.sequenceIndex));
  const sequenceOf = new Map(presentationRows.map((entry) => [entry.presentation.id, entry.presentation.sequenceIndex]));
  const taskOf = new Map(presentationRows.map((entry) => [entry.presentation.id, entry.task]));

  const [enabledTasks] = await db
    .select({ total: sql<string>`count(*)` })
    .from(protocolTasks)
    .where(and(eq(protocolTasks.protocolVersionId, protocol.id), eq(protocolTasks.enabled, true)));
  // The participant flow creates one presentation per enabled task when the
  // tasks begin, so the two numbers are equal for a session that got that far.
  const expectedTasks = Math.max(presentationRows.length, Number(enabledTasks?.total ?? 0));

  const utteranceRows = (
    await db
      .select({ utterance: utterances, followupKey: protocolTaskFollowups.followupKey })
      .from(utterances)
      .leftJoin(protocolTaskFollowups, eq(protocolTaskFollowups.id, utterances.followupId))
      .where(eq(utterances.sessionId, sessionId))
  ).sort(
    (a, b) =>
      (sequenceOf.get(a.utterance.taskPresentationId) ?? 0) - (sequenceOf.get(b.utterance.taskPresentationId) ?? 0) ||
      a.utterance.turnIndex - b.utterance.turnIndex,
  );
  const utteranceIds = utteranceRows.map((entry) => entry.utterance.id);

  const mediaRows = await db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, sessionId));
  const mediaById = new Map(mediaRows.map((asset) => [asset.id, asset]));

  const lineage = await loadUtteranceLineages(db, utteranceIds);
  const history = await loadProcessingHistory(db, {
    utteranceIds,
    mediaIds: mediaRows.map((asset) => asset.id),
    revisionIds: lineage.revisions.map((revision) => revision.id),
    translationIds: lineage.translations.map((translation) => translation.id),
  });

  // Which utterance a run belongs to.
  const revisionUtterance = new Map<string, string>();
  const transcriptUtterance = new Map(lineage.transcripts.map((transcript) => [transcript.id, transcript.utteranceId]));
  for (const revision of lineage.revisions) {
    const utteranceId = transcriptUtterance.get(revision.transcriptId);
    if (utteranceId) revisionUtterance.set(revision.id, utteranceId);
  }
  const translationUtterance = new Map<string, string>();
  for (const translation of lineage.translations) {
    const utteranceId = revisionUtterance.get(translation.sourceTranscriptRevisionId);
    if (utteranceId) translationUtterance.set(translation.id, utteranceId);
  }
  const utteranceIdSet = new Set(utteranceIds);
  const utteranceOfRun = (run: ModelRunRow): string | null => {
    if (utteranceIdSet.has(run.sourceEntityId)) return run.sourceEntityId;
    const manifestId = run.inputManifestJson?.utteranceId;
    return (
      mediaById.get(run.sourceEntityId)?.utteranceId ??
      revisionUtterance.get(run.sourceEntityId) ??
      translationUtterance.get(run.sourceEntityId) ??
      (typeof manifestId === "string" && utteranceIdSet.has(manifestId) ? manifestId : null)
    );
  };

  const sameWork = (a: ModelRunRow, b: ModelRunRow): boolean =>
    a.stage === b.stage &&
    a.sourceEntityType === b.sourceEntityType &&
    a.sourceEntityId === b.sourceEntityId &&
    a.conditionKey === b.conditionKey &&
    a.processingBatchId === b.processingBatchId;
  // A failed run with no later successful run of the same work.
  const openFailures = history.runs.filter(
    (run) =>
      run.status === "failed" &&
      !history.runs.some(
        (other) => other.status === "succeeded" && sameWork(run, other) && other.startedAt >= run.startedAt,
      ),
  );
  const asrFailedFor = new Set(
    openFailures.filter((run) => run.stage === "asr").map((run) => utteranceOfRun(run)),
  );

  const historyBatchIds = [
    ...new Set(history.runs.map((run) => run.processingBatchId).filter((id): id is string => id !== null)),
  ];
  const historyBatches =
    historyBatchIds.length === 0
      ? []
      : await db
          .select({ id: processingBatches.id, name: processingBatches.name })
          .from(processingBatches)
          .where(inArray(processingBatches.id, historyBatchIds));
  const batchName = new Map(historyBatches.map((batch) => [batch.id, batch.name]));
  const runLookup = await loadModelRunLookup(db, history.runs);

  const responses = await loadQuestionnaireResponses(db, sessionId);
  const responseFor = (versionId: string | null) =>
    versionId ? (responses.find((response) => response.questionnaire.versionId === versionId) ?? null) : null;
  const background = responseFor(protocol.backgroundQuestionnaireVersionId);
  const post = responseFor(protocol.postQuestionnaireVersionId);

  const entityIds = [
    sessionId,
    ...utteranceIds,
    ...lineage.translations.map((translation) => translation.id),
    ...lineage.syntheses.map((synthesis) => synthesis.id),
  ];
  const flagRows = await db
    .select()
    .from(researchFlags)
    .where(inArray(researchFlags.entityId, entityIds))
    .orderBy(desc(researchFlags.createdAt));
  const noteRows = await db
    .select()
    .from(researchNotes)
    .where(inArray(researchNotes.entityId, entityIds))
    .orderBy(desc(researchNotes.createdAt));

  const utteranceDetails = utteranceRows.map(({ utterance, followupKey }, index): corpusSchemas.UtteranceDetail => {
    const source = utterance.acceptedMediaAssetId ? (mediaById.get(utterance.acceptedMediaAssetId) ?? null) : null;
    const derived =
      source === null
        ? null
        : (mediaRows.find(
            (asset) => asset.derivedFromMediaAssetId === source.id && asset.kind === "source_audio_derived",
          ) ?? null);
    const own = lineage.byUtterance.get(utterance.id);
    const quality = utterance.qualityJson ?? {};
    return {
      id: utterance.id,
      ordinal: index + 1,
      taskPresentationId: utterance.taskPresentationId,
      turnIndex: utterance.turnIndex,
      isFollowup: utterance.followupId !== null,
      followupKey,
      promptSnapshot: utterance.promptSnapshot,
      attemptCount: utterance.attemptCount,
      status: utterance.status,
      exclusionReason: utterance.exclusionReason,
      flagged: utterance.flagged,
      flagNotes: utterance.flagNotes,
      submittedAt: toIso(utterance.submittedAt),
      durationMs: utterance.durationMs,
      quality: {
        peakAmplitude: quality.peakAmplitude ?? null,
        clippedSampleRatio: quality.clippedSampleRatio ?? null,
        silenceRatio: quality.silenceRatio ?? null,
        rmsDb: quality.rmsDb ?? null,
        warnings: quality.warnings ?? [],
      },
      qualityIndicators: qualityIndicators({
        utterance,
        source,
        minDurationSeconds: taskOf.get(utterance.taskPresentationId)?.minDurationSeconds ?? null,
        lineage: own,
        asrFailed: asrFailedFor.has(utterance.id) && !own?.transcripts.find((cell) => cell.type === "asr")?.current,
      }),
      sourceMedia: source ? toMediaView(source) : null,
      derivedMedia: derived ? toMediaView(derived) : null,
      captureDetails: source ? captureDetailsOf(source.metadataJson) : null,
      transcripts: own?.transcripts ?? [],
      translationBatches: own?.translationBatches ?? [],
    };
  });

  const scopeOf = new Map((consentRow?.version.itemsJson ?? []).map((item) => [item.id, item.scope ?? null]));

  return {
    adminTimezone: adminTimezoneOf(row.settings),
    session: {
      id: session.id,
      participantCode: session.participantCode,
      mode: session.mode,
      status: session.status,
      locale: session.locale,
      startedAt: toIso(session.startedAt),
      consentedAt: toIso(session.consentedAt),
      completedAt: toIso(session.completedAt),
      withdrawnAt: toIso(session.withdrawnAt),
      abandonedAt: toIso(session.abandonedAt),
      lastActivityAt: toIso(session.lastActivityAt),
      flagged: session.flagged,
      flagNotes: session.flagNotes,
      excluded: session.excluded,
      exclusionReason: session.exclusionReason,
      appVersion: session.appVersion,
      gitCommitSha: session.gitCommitSha,
      orderSeed: session.orderSeed,
    },
    protocol: { id: protocol.id, versionNumber: protocol.versionNumber, name: protocol.name, status: protocol.status },
    consent: consentRow
      ? {
          consentVersionId: consentRow.version.id,
          versionNumber: consentRow.version.versionNumber,
          title: consentRow.version.title,
          acceptedAt: toIso(consentRow.consent.acceptedAt),
          items: consentRow.consent.responsesJson.map((response) => ({
            itemId: response.itemId,
            textSnapshot: response.textSnapshot,
            required: response.required,
            accepted: response.accepted,
            scope: scopeOf.get(response.itemId) ?? null,
          })),
        }
      : null,
    capture: {
      browserInfo: session.browserInfoJson ?? null,
      audioEnvironment: session.audioEnvironmentJson ?? null,
    },
    taskSequence: presentationRows.map(({ presentation, task }) => ({
      presentationId: presentation.id,
      sequenceIndex: presentation.sequenceIndex,
      status: presentation.status,
      taskKey: task.taskKey,
      taskType: task.taskType,
      blockKey: task.blockKey,
      titleSnapshot: presentation.titleSnapshot,
      promptSnapshot: presentation.promptSnapshot,
      contextSnapshot: presentation.contextSnapshot,
      instructionsSnapshot: presentation.instructionsSnapshot,
      startedAt: toIso(presentation.startedAt),
      completedAt: toIso(presentation.completedAt),
      randomization: presentation.randomizationMetadataJson ?? null,
      utteranceIds: utteranceRows
        .filter((entry) => entry.utterance.taskPresentationId === presentation.id)
        .map((entry) => entry.utterance.id),
    })),
    utterances: utteranceDetails,
    questionnaires: {
      background,
      post,
      backgroundExpected: protocol.backgroundQuestionnaireVersionId !== null,
      postExpected: protocol.postQuestionnaireVersionId !== null,
      postReview: responseFor(protocol.postReviewQuestionnaireVersionId),
      postReviewExpected: protocol.postReviewQuestionnaireVersionId !== null,
    },
    ...(await loadOutputReview(db, session.id)),
    flags: flagRows.map((flag) => ({
      id: flag.id,
      entityType: flag.entityType,
      entityId: flag.entityId,
      reasonCode: flag.reasonCode,
      notes: flag.notes,
      createdByLabel: flag.createdByLabel,
      createdAt: toIso(flag.createdAt),
      resolvedAt: toIso(flag.resolvedAt),
    })),
    notes: noteRows.map((note) => ({
      id: note.id,
      entityType: note.entityType,
      entityId: note.entityId,
      body: note.body,
      createdByLabel: note.createdByLabel,
      createdAt: toIso(note.createdAt),
    })),
    processing: {
      modelRuns: history.runs.map((run) => ({
        ...toModelRunSummary(run, runLookup),
        utteranceId: utteranceOfRun(run),
        batchName: run.processingBatchId ? (batchName.get(run.processingBatchId) ?? null) : null,
      })),
      jobs: history.jobs.map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        lastError: job.lastError,
        processingBatchId: job.processingBatchId,
        createdAt: toIso(job.createdAt),
        finishedAt: toIso(job.finishedAt),
      })),
    },
    completeness: completenessChecks({
      expectedTasks,
      presentations: presentationRows.map((entry) => entry.presentation),
      utteranceRows: utteranceRows.map((entry) => entry.utterance),
      mediaById,
      lineage,
      backgroundExpected: protocol.backgroundQuestionnaireVersionId !== null,
      postExpected: protocol.postQuestionnaireVersionId !== null,
      background,
      post,
      openFailures: openFailures.length,
      pendingJobs: history.jobs.filter((job) => ["queued", "running", "failed"].includes(job.status)).length,
    }),
  };
}
