// Processing batches (spec 28, 53, 54, 143, 145, 150).
//
// A batch is one run of the offline computational experiment over a frozen set
// of utterances with a frozen configuration. Creating a batch copies every model
// configuration and prompt text into `configuration_snapshot_json`. Nothing that
// is activated, retired or edited afterwards changes what the batch uses.
//
// Job graph (see docs/AI-PROVENANCE.md):
//   start        -> one `asr` job per utterance (when runAsr)
//                -> one `translation` job per source revision and translation config
//   asr handler  -> on success, the `translation` jobs of the new ASR revision
//   translation  -> on success, one `tts` job per TTS config of the batch
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  aiPromptVersions,
  isUniqueViolation,
  jobs,
  modelConfigs,
  modelRuns,
  processingBatches,
  protocolTasks,
  protocolVersions,
  sessions,
  syntheses,
  taskPresentations,
  transcriptRevisions,
  transcripts,
  translations,
  utterances,
  type BatchConfigurationSnapshot,
  type DbOrTx,
  type ModelConfigSnapshot,
} from "@dialect/db";
import {
  AppError,
  processingSchemas,
  type BatchStatus,
  type JobStatus,
  type ProcessingStage,
  type PublicationStatus,
  type StudyMode,
  type TranscriptType,
} from "@dialect/domain";
import { recordAudit } from "../audit";
import type { ServiceContext } from "../context";
import {
  cancelQueuedJobsForBatch,
  enqueueJobs,
  getJobCountsForBatch,
  listJobs,
  retryFailedJobsForBatch,
  type EnqueueJobInput,
  type Job,
  type JobCounts,
} from "../jobs/queue";
import { loadActiveModelConfigSnapshot, loadModelConfigSnapshot, resolveStudy } from "./config";
import { assertProviderAllowedForMode, assertSingleTtsInstruction, encodeKeyPart } from "./steps";

export type ProcessingBatchRow = typeof processingBatches.$inferSelect;

// Keys of the configurations a batch uses when the wizard input names none.
export const DEFAULT_ASR_CONFIG_KEY = "asr_default";
export const DEFAULT_TRANSLATION_CONFIG_KEYS = ["translation_default", "translation_preserve"] as const;
export const DEFAULT_TTS_CONFIG_KEY = "tts_baseline";

const CHUNK = 5000;

function chunks<T>(values: T[], size = CHUNK): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

// The condition a configuration stands for. A configuration without its own
// condition key is identified by its configuration key.
export function conditionKeyOf(config: ModelConfigSnapshot): string {
  return config.conditionKey ?? config.key;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

type Selection = BatchConfigurationSnapshot["selection"];

// A date without a time covers the whole day in UTC.
function selectionDate(value: string, edge: "from" | "to"): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (dateOnly && edge === "to") date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

// The utterances a selection covers, in a stable order (session start, task
// order, turn). Withdrawn sessions and utterances without an accepted recording
// are never selected.
async function resolveUtterances(
  db: DbOrTx,
  studyId: string,
  selection: Selection,
): Promise<Array<{ utteranceId: string; sessionId: string }>> {
  const mode = selection.mode[0];
  if (!mode) return [];
  const conditions: SQL[] = [
    eq(sessions.studyId, studyId),
    eq(sessions.mode, mode),
    sql`${sessions.status} <> 'withdrawn'`,
    sql`${utterances.acceptedMediaAssetId} IS NOT NULL`,
  ];
  if (selection.completedSessionsOnly) conditions.push(eq(sessions.status, "completed"));
  if (selection.excludeExcluded) {
    conditions.push(eq(utterances.status, "submitted"), eq(sessions.excluded, false));
  } else {
    conditions.push(inArray(utterances.status, ["submitted", "excluded"]));
  }
  if (selection.excludeFlagged) conditions.push(eq(sessions.flagged, false), eq(utterances.flagged, false));
  if (selection.protocolVersionIds?.length) {
    conditions.push(inArray(sessions.protocolVersionId, selection.protocolVersionIds));
  }
  if (selection.taskTypes?.length) conditions.push(inArray(protocolTasks.taskType, selection.taskTypes));
  if (selection.dateFrom) conditions.push(sql`${sessions.startedAt} >= ${selectionDate(selection.dateFrom, "from").toISOString()}::timestamptz`);
  if (selection.dateTo) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(selection.dateTo);
    const limit = selectionDate(selection.dateTo, "to").toISOString();
    conditions.push(
      dateOnly
        ? sql`${sessions.startedAt} < ${limit}::timestamptz`
        : sql`${sessions.startedAt} <= ${limit}::timestamptz`,
    );
  }
  if (selection.sessionIds?.length) conditions.push(inArray(sessions.id, selection.sessionIds));
  if (selection.utteranceIds?.length) conditions.push(inArray(utterances.id, selection.utteranceIds));

  return db
    .select({ utteranceId: utterances.id, sessionId: sessions.id })
    .from(utterances)
    .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
    .innerJoin(taskPresentations, eq(taskPresentations.id, utterances.taskPresentationId))
    .innerJoin(protocolTasks, eq(protocolTasks.id, taskPresentations.protocolTaskId))
    .where(and(...conditions))
    .orderBy(sessions.startedAt, sessions.id, taskPresentations.sequenceIndex, utterances.turnIndex);
}

// A batch never mixes data modes. Sessions or utterances that are named
// explicitly must all have the mode of the batch, otherwise the request is
// rejected instead of silently dropping them.
async function assertExplicitIdsMatchMode(db: DbOrTx, mode: StudyMode, selection: Selection): Promise<void> {
  const otherModes = new Set<StudyMode>();
  for (const ids of chunks(selection.sessionIds ?? [])) {
    const rows = await db.selectDistinct({ mode: sessions.mode }).from(sessions).where(inArray(sessions.id, ids));
    for (const row of rows) if (row.mode !== mode) otherModes.add(row.mode);
  }
  for (const ids of chunks(selection.utteranceIds ?? [])) {
    const rows = await db
      .selectDistinct({ mode: sessions.mode })
      .from(utterances)
      .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
      .where(inArray(utterances.id, ids));
    for (const row of rows) if (row.mode !== mode) otherModes.add(row.mode);
  }
  if (otherModes.size > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `A ${mode} batch cannot include ${[...otherModes].join(" or ")} data. A batch never mixes data modes.`,
      { mode, otherModes: [...otherModes] },
    );
  }
}

export type SourceRevision = {
  utteranceId: string;
  transcriptType: TranscriptType;
  transcriptRevisionId: string;
};

// The transcript revisions a batch translates: always the CURRENT revision of
// each selected transcript type. With `verifiedTranscriptsOnly` a human
// transcript (A*, B, C) counts only when its current revision is verified. The
// ASR transcript (A) is a model output with no human verification, so it is
// always eligible. A revision with empty text is skipped: there is nothing to
// translate.
export async function resolveSourceRevisions(
  db: DbOrTx,
  input: { utteranceIds: string[]; transcriptTypes: TranscriptType[]; verifiedTranscriptsOnly: boolean },
): Promise<SourceRevision[]> {
  if (input.utteranceIds.length === 0 || input.transcriptTypes.length === 0) return [];
  const result: SourceRevision[] = [];
  for (const ids of chunks(input.utteranceIds)) {
    const rows = await db
      .select({
        utteranceId: transcripts.utteranceId,
        transcriptType: transcripts.type,
        transcriptRevisionId: transcriptRevisions.id,
        verifiedAt: transcriptRevisions.verifiedAt,
        isEmpty: sql<boolean>`btrim(${transcriptRevisions.text}) = ''`,
      })
      .from(transcriptRevisions)
      .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
      .where(
        and(
          inArray(transcripts.utteranceId, ids),
          inArray(transcripts.type, input.transcriptTypes),
          eq(transcriptRevisions.isCurrent, true),
        ),
      );
    for (const row of rows) {
      if (row.isEmpty) continue;
      if (input.verifiedTranscriptsOnly && row.transcriptType !== "asr" && row.verifiedAt === null) continue;
      result.push({
        utteranceId: row.utteranceId,
        transcriptType: row.transcriptType,
        transcriptRevisionId: row.transcriptRevisionId,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Planning: preview and create
// ---------------------------------------------------------------------------

export type BatchPreview = {
  studyId: string;
  dataMode: StudyMode;
  utteranceCount: number;
  sessionCount: number;
  // Number of transcripts of each selected type that can be translated now. For
  // the ASR type with `runAsr` this is the number of utterances, because the
  // transcript is produced by the batch itself.
  sourceTranscriptCounts: Partial<Record<TranscriptType, number>>;
  // An estimate made when the batch is planned. The real jobs are decided when
  // the batch starts.
  estimatedJobCounts: { asr: number; translation: number; tts: number; total: number };
  // Notes for the researcher. A warning never blocks the batch.
  warnings: BatchWarning[];
  configuration: BatchConfigurationSnapshot;
};

export type BatchWarning = {
  code: "normalized_from_older_dialect_revision" | "normalized_older_than_dialect_revision";
  message: string;
  // How many selected utterances the warning is about, and which (at most 50 ids).
  utteranceCount: number;
  utteranceIds: string[];
};

const WARNING_ID_LIMIT = 50;

// The normalized transcript (C) is written from the dialect transcript (B). When
// B was changed after C, the two no longer describe the same wording, and a
// B versus C comparison would mix a transcription difference into the
// normalization difference. This only reports it: the researcher decides.
//
// Two cases, per utterance whose current C revision the batch would translate:
// - C records the B revision it was copied from (`derived_from_revision_id`,
//   set by the copy button of the review screen) and that revision is no longer
//   the current B revision;
// - C records no derivation and the current B revision was created after the
//   current C revision.
export async function findStaleNormalizedTranscripts(
  db: DbOrTx,
  normalizedRevisionIds: string[],
): Promise<BatchWarning[]> {
  const derivedFromOlder: string[] = [];
  const olderThanDialect: string[] = [];
  for (const ids of chunks(normalizedRevisionIds)) {
    const normalized = await db
      .select({
        utteranceId: transcripts.utteranceId,
        createdAt: transcriptRevisions.createdAt,
        derivedFromRevisionId: transcriptRevisions.derivedFromRevisionId,
      })
      .from(transcriptRevisions)
      .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
      .where(and(inArray(transcriptRevisions.id, ids), eq(transcripts.type, "normalized")));
    if (normalized.length === 0) continue;
    const dialectRows = await db
      .select({
        utteranceId: transcripts.utteranceId,
        revisionId: transcriptRevisions.id,
        createdAt: transcriptRevisions.createdAt,
        isCurrent: transcriptRevisions.isCurrent,
      })
      .from(transcriptRevisions)
      .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
      .where(
        and(
          inArray(
            transcripts.utteranceId,
            normalized.map((row) => row.utteranceId),
          ),
          eq(transcripts.type, "human_dialect"),
        ),
      );
    const currentDialect = new Map(dialectRows.filter((row) => row.isCurrent).map((row) => [row.utteranceId, row]));
    const dialectRevisionIds = new Set(dialectRows.map((row) => row.revisionId));
    for (const row of normalized) {
      const current = currentDialect.get(row.utteranceId);
      if (!current) continue;
      // A derivation from another transcript type (for example A*) says nothing
      // about B, so the time comparison applies.
      if (row.derivedFromRevisionId && dialectRevisionIds.has(row.derivedFromRevisionId)) {
        if (row.derivedFromRevisionId !== current.revisionId) derivedFromOlder.push(row.utteranceId);
      } else if (current.createdAt.getTime() > row.createdAt.getTime()) {
        olderThanDialect.push(row.utteranceId);
      }
    }
  }
  const warnings: BatchWarning[] = [];
  const plural = (count: number) => (count === 1 ? "1 utterance" : `${count} utterances`);
  if (derivedFromOlder.length > 0) {
    warnings.push({
      code: "normalized_from_older_dialect_revision",
      message: `For ${plural(derivedFromOlder.length)} the normalized transcript (C) was copied from an earlier revision of the dialect transcript (B). B was changed afterwards. Check C on the Review page before comparing B and C.`,
      utteranceCount: derivedFromOlder.length,
      utteranceIds: derivedFromOlder.slice(0, WARNING_ID_LIMIT),
    });
  }
  if (olderThanDialect.length > 0) {
    warnings.push({
      code: "normalized_older_than_dialect_revision",
      message: `For ${plural(olderThanDialect.length)} the dialect transcript (B) was changed after the normalized transcript (C) was last saved, and C does not record which B revision it was written from. Check C on the Review page before comparing B and C.`,
      utteranceCount: olderThanDialect.length,
      utteranceIds: olderThanDialect.slice(0, WARNING_ID_LIMIT),
    });
  }
  return warnings;
}

type BatchPlan = BatchPreview & { name?: string; description?: string | null };

function requireVoice(config: ModelConfigSnapshot): void {
  const voice = config.parameters.voice;
  if (typeof voice !== "string" || voice.length === 0) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The TTS configuration "${config.key}" version ${config.versionNumber} has no voice. A voice is never chosen automatically.`,
      { modelConfigId: config.modelConfigId },
    );
  }
}

function requirePrompt(config: ModelConfigSnapshot): void {
  if (config.promptText === null || config.promptText.trim().length === 0) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The translation configuration "${config.key}" version ${config.versionNumber} has no prompt version with an instruction.`,
      { modelConfigId: config.modelConfigId },
    );
  }
}

function assertDistinctConditions(configs: ModelConfigSnapshot[], stage: string): void {
  const seen = new Set<string>();
  for (const config of configs) {
    const key = conditionKeyOf(config);
    if (seen.has(key)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Two ${stage} configurations of the batch have the condition "${key}". Each condition can appear once per batch.`,
        { conditionKey: key },
      );
    }
    seen.add(key);
  }
}

async function planBatch(ctx: ServiceContext, raw: unknown): Promise<BatchPlan> {
  const input = processingSchemas.previewBatchSchema.parse(raw);
  const study = await resolveStudy(ctx.db, input.studyId);
  const db = ctx.db;

  const selection: Selection = {
    mode: [input.selection.mode],
    completedSessionsOnly: input.selection.completedSessionsOnly,
    verifiedTranscriptsOnly: input.selection.verifiedTranscriptsOnly,
    excludeFlagged: input.selection.excludeFlagged,
    excludeExcluded: input.selection.excludeExcluded,
    ...(input.selection.protocolVersionIds?.length ? { protocolVersionIds: input.selection.protocolVersionIds } : {}),
    ...(input.selection.taskTypes?.length ? { taskTypes: input.selection.taskTypes } : {}),
    dateFrom: input.selection.dateFrom ?? null,
    dateTo: input.selection.dateTo ?? null,
    ...(input.selection.sessionIds?.length ? { sessionIds: input.selection.sessionIds } : {}),
    ...(input.selection.utteranceIds?.length ? { utteranceIds: input.selection.utteranceIds } : {}),
  };

  // Configurations. Every missing piece is an explicit error (spec 143).
  const asr = input.runAsr
    ? input.asrModelConfigId
      ? await loadModelConfigSnapshot(db, {
          modelConfigId: input.asrModelConfigId,
          studyId: study.id,
          stage: "asr",
          requireActive: true,
        })
      : await loadActiveModelConfigSnapshot(db, { studyId: study.id, key: DEFAULT_ASR_CONFIG_KEY, stage: "asr" })
    : null;

  const translationConfigs: ModelConfigSnapshot[] = [];
  if (input.translationModelConfigIds === undefined) {
    for (const key of DEFAULT_TRANSLATION_CONFIG_KEYS) {
      translationConfigs.push(await loadActiveModelConfigSnapshot(db, { studyId: study.id, key, stage: "translation" }));
    }
  } else {
    for (const modelConfigId of new Set(input.translationModelConfigIds)) {
      translationConfigs.push(
        await loadModelConfigSnapshot(db, { modelConfigId, studyId: study.id, stage: "translation", requireActive: true }),
      );
    }
  }
  translationConfigs.forEach(requirePrompt);
  assertDistinctConditions(translationConfigs, "translation");

  const ttsConfigs: ModelConfigSnapshot[] = [];
  if (input.ttsModelConfigIds === undefined) {
    if (translationConfigs.length > 0) {
      ttsConfigs.push(await loadActiveModelConfigSnapshot(db, { studyId: study.id, key: DEFAULT_TTS_CONFIG_KEY, stage: "tts" }));
    }
  } else {
    for (const modelConfigId of new Set(input.ttsModelConfigIds)) {
      ttsConfigs.push(await loadModelConfigSnapshot(db, { modelConfigId, studyId: study.id, stage: "tts", requireActive: true }));
    }
  }
  ttsConfigs.forEach(requireVoice);
  ttsConfigs.forEach((config) => assertSingleTtsInstruction(config));
  assertDistinctConditions(ttsConfigs, "TTS");

  // The mock provider never processes research data (see steps.ts).
  for (const config of [...(asr ? [asr] : []), ...translationConfigs, ...ttsConfigs]) {
    assertProviderAllowedForMode(config, input.selection.mode);
  }

  if (!input.runAsr && translationConfigs.length === 0) {
    throw new AppError("VALIDATION_ERROR", "The batch has nothing to do. Select ASR or at least one translation condition.");
  }
  if (translationConfigs.length === 0 && ttsConfigs.length > 0) {
    throw new AppError("VALIDATION_ERROR", "TTS needs the translations of the same batch. Select at least one translation condition.");
  }
  if (translationConfigs.length > 0 && input.transcriptTypes.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Select at least one transcript type to translate.");
  }

  // The languages are part of the frozen configuration of the batch. A research
  // batch never stores an empty language, also when it only runs ASR: the
  // snapshot is exported as the description of the experiment. A test or demo
  // batch without translation may leave them empty.
  const sourceLanguage = study.settingsJson.sourceLanguage ?? "";
  const targetLanguage = study.settingsJson.targetLanguage ?? "";
  const languagesRequired = translationConfigs.length > 0 || input.selection.mode === "research";
  if (languagesRequired && (!sourceLanguage || !targetLanguage)) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The study settings do not name the source language and the target language. Set both on the Settings page before creating a ${translationConfigs.length > 0 ? "translation" : "research"} batch.`,
    );
  }

  await assertExplicitIdsMatchMode(db, input.selection.mode, selection);
  const selected = await resolveUtterances(db, study.id, selection);
  const utteranceIds = selected.map((row) => row.utteranceId);
  const transcriptTypes = translationConfigs.length > 0 ? input.transcriptTypes : [];

  const sourceRevisions = await resolveSourceRevisions(db, {
    utteranceIds,
    transcriptTypes,
    verifiedTranscriptsOnly: selection.verifiedTranscriptsOnly,
  });
  const sourceTranscriptCounts: Partial<Record<TranscriptType, number>> = {};
  for (const type of transcriptTypes) sourceTranscriptCounts[type] = 0;
  for (const revision of sourceRevisions) {
    sourceTranscriptCounts[revision.transcriptType] = (sourceTranscriptCounts[revision.transcriptType] ?? 0) + 1;
  }
  if (input.runAsr && transcriptTypes.includes("asr")) sourceTranscriptCounts.asr = utteranceIds.length;

  const sourceCount = Object.values(sourceTranscriptCounts).reduce((sum, value) => sum + (value ?? 0), 0);
  const normalizedRevisionIds = sourceRevisions
    .filter((revision) => revision.transcriptType === "normalized")
    .map((revision) => revision.transcriptRevisionId);
  const warnings = await findStaleNormalizedTranscripts(db, normalizedRevisionIds);

  const asrJobs = input.runAsr ? utteranceIds.length : 0;
  const translationJobs = sourceCount * translationConfigs.length;
  const ttsJobs = translationJobs * ttsConfigs.length;

  const configuration: BatchConfigurationSnapshot = {
    selection,
    transcriptTypes,
    runAsr: input.runAsr,
    asr,
    translations: translationConfigs,
    tts: ttsConfigs,
    sourceLanguage,
    targetLanguage,
    utteranceIds,
    estimatedJobCounts: { asr: asrJobs, translation: translationJobs, tts: ttsJobs },
  };

  return {
    studyId: study.id,
    dataMode: input.selection.mode,
    utteranceCount: utteranceIds.length,
    sessionCount: new Set(selected.map((row) => row.sessionId)).size,
    sourceTranscriptCounts,
    estimatedJobCounts: { asr: asrJobs, translation: translationJobs, tts: ttsJobs, total: asrJobs + translationJobs + ttsJobs },
    warnings,
    configuration,
  };
}

// Resolves the selection and the configuration without storing anything.
export async function previewBatch(ctx: ServiceContext, input: processingSchemas.PreviewBatchInput): Promise<BatchPreview> {
  return planBatch(ctx, input);
}

// Stores a batch as a draft with its frozen configuration snapshot.
export async function createBatch(ctx: ServiceContext, input: processingSchemas.CreateBatchInput): Promise<BatchDetail> {
  const { name, description, ...planInput } = processingSchemas.createBatchSchema.parse(input);
  const plan = await planBatch(ctx, planInput);
  if (plan.utteranceCount === 0) {
    throw new AppError("VALIDATION_ERROR", "The selection matches no utterances. Change the filters and try again.");
  }
  const [duplicate] = await ctx.db
    .select({ id: processingBatches.id })
    .from(processingBatches)
    .where(and(eq(processingBatches.studyId, plan.studyId), eq(processingBatches.name, name)))
    .limit(1);
  if (duplicate) {
    throw new AppError("CONFLICT", `A batch named "${name}" already exists. Batch names are unique.`, { name });
  }

  let batchId: string;
  try {
    batchId = await ctx.db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(processingBatches)
        .values({
          studyId: plan.studyId,
          name,
          description: description ?? null,
          status: "draft",
          dataMode: plan.dataMode,
          configurationSnapshotJson: plan.configuration,
          createdByLabel: ctx.actorLabel,
          createdAt: ctx.now(),
        })
        .returning();
      if (!batch) throw new AppError("DATABASE_ERROR", "The batch could not be stored.");
      await recordAudit(tx, {
        action: "batch.create",
        entityType: "processing_batch",
        entityId: batch.id,
        after: {
          name,
          dataMode: plan.dataMode,
          utteranceCount: plan.utteranceCount,
          estimatedJobCounts: plan.estimatedJobCounts,
          modelConfigIds: configSummary(plan.configuration),
          // The notes the researcher saw in the preview when the batch was created.
          warnings: plan.warnings.map((warning) => ({ code: warning.code, utteranceCount: warning.utteranceCount })),
        },
        actorLabel: ctx.actorLabel,
      });
      return batch.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, "processing_batches_study_name_uq")) {
      throw new AppError("CONFLICT", `A batch named "${name}" already exists. Batch names are unique.`, { name });
    }
    throw error;
  }
  return getBatch(ctx, batchId);
}

function configSummary(snapshot: BatchConfigurationSnapshot) {
  return {
    asr: snapshot.asr?.modelConfigId ?? null,
    translations: snapshot.translations.map((config) => config.modelConfigId),
    tts: snapshot.tts.map((config) => config.modelConfigId),
  };
}

// ---------------------------------------------------------------------------
// Job construction
// ---------------------------------------------------------------------------

// Job idempotency keys are deterministic: "batch:<batch id>:<stage>:<source id>...".
// Jobs become available at the time of the service clock (`now`), the same
// clock the worker uses to claim them.
const batchKey = (batchId: string, rest: string) => `batch:${batchId}:${rest}`;

export function asrJobForUtterance(
  batchId: string,
  snapshot: BatchConfigurationSnapshot,
  utterance: { utteranceId: string; mediaAssetId: string },
  now: Date,
): EnqueueJobInput {
  if (!snapshot.asr) throw new AppError("INVALID_STATE", "The batch has no ASR configuration.");
  return {
    type: "asr",
    payload: {
      type: "asr",
      utteranceId: utterance.utteranceId,
      mediaAssetId: utterance.mediaAssetId,
      modelConfigId: snapshot.asr.modelConfigId,
      processingBatchId: batchId,
    },
    idempotencyKey: batchKey(batchId, `asr:${utterance.utteranceId}`),
    processingBatchId: batchId,
    availableAt: now,
  };
}

// One translation job per translation configuration of the batch.
export function translationJobsForRevision(
  batchId: string,
  snapshot: BatchConfigurationSnapshot,
  source: { utteranceId: string; transcriptRevisionId: string },
  now: Date,
): EnqueueJobInput[] {
  return snapshot.translations.map((config) => ({
    type: "translation",
    payload: {
      type: "translation",
      sourceTranscriptRevisionId: source.transcriptRevisionId,
      utteranceId: source.utteranceId,
      modelConfigId: config.modelConfigId,
      processingBatchId: batchId,
      repetitionIndex: 0,
    },
    idempotencyKey: batchKey(
      batchId,
      `translation:${source.transcriptRevisionId}:${encodeKeyPart(conditionKeyOf(config))}:0`,
    ),
    processingBatchId: batchId,
    availableAt: now,
  }));
}

// One TTS job per TTS configuration of the batch. Every translation of the
// batch gets the same TTS configurations, so the voice never differs between
// translation conditions (spec 22).
export function ttsJobsForTranslation(
  batchId: string,
  snapshot: BatchConfigurationSnapshot,
  translationId: string,
  now: Date,
): EnqueueJobInput[] {
  return snapshot.tts.map((config) => ({
    type: "tts",
    payload: {
      type: "tts",
      translationId,
      modelConfigId: config.modelConfigId,
      processingBatchId: batchId,
      repetitionIndex: 0,
    },
    idempotencyKey: batchKey(batchId, `tts:${translationId}:${encodeKeyPart(conditionKeyOf(config))}:0`),
    processingBatchId: batchId,
    availableAt: now,
  }));
}

// ---------------------------------------------------------------------------
// Start, cancel, retry
// ---------------------------------------------------------------------------

async function lockBatch(tx: DbOrTx, batchId: string): Promise<ProcessingBatchRow> {
  const [batch] = await tx.select().from(processingBatches).where(eq(processingBatches.id, batchId)).for("update");
  if (!batch) throw new AppError("NOT_FOUND", "Processing batch not found.", { batchId });
  return batch;
}

// Starts a draft batch: the status becomes `queued` and the first jobs are
// enqueued, in one transaction. The source revisions are resolved now, so the
// batch translates the transcripts as they are at this moment.
export async function startBatch(ctx: ServiceContext, batchId: string): Promise<BatchDetail> {
  await ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (batch.status !== "draft") {
      throw new AppError("INVALID_STATE", `Only a draft batch can be started. This batch is ${batch.status}.`, {
        batchId,
        status: batch.status,
      });
    }
    const snapshot = batch.configurationSnapshotJson;

    // Utterances that were excluded after the batch was created are left out.
    const eligible: Array<{ utteranceId: string; mediaAssetId: string }> = [];
    const allowedStatuses = snapshot.selection.excludeExcluded ? ["submitted"] : ["submitted", "excluded"];
    for (const ids of chunks(snapshot.utteranceIds)) {
      const rows = await tx
        .select({ id: utterances.id, status: utterances.status, mediaAssetId: utterances.acceptedMediaAssetId })
        .from(utterances)
        .where(inArray(utterances.id, ids));
      for (const row of rows) {
        if (!allowedStatuses.includes(row.status) || !row.mediaAssetId) continue;
        eligible.push({ utteranceId: row.id, mediaAssetId: row.mediaAssetId });
      }
    }
    const order = new Map(snapshot.utteranceIds.map((id, index) => [id, index]));
    eligible.sort((a, b) => (order.get(a.utteranceId) ?? 0) - (order.get(b.utteranceId) ?? 0));
    const eligibleIds = eligible.map((row) => row.utteranceId);

    const now = ctx.now();
    const inputs: EnqueueJobInput[] = [];
    if (snapshot.runAsr) {
      for (const utterance of eligible) inputs.push(asrJobForUtterance(batchId, snapshot, utterance, now));
    }
    // With runAsr the translations of the ASR transcript are enqueued by the ASR
    // handler, once the batch's own ASR revision exists.
    const typesNow = snapshot.transcriptTypes.filter((type) => !(snapshot.runAsr && type === "asr"));
    const sources = await resolveSourceRevisions(tx, {
      utteranceIds: eligibleIds,
      transcriptTypes: typesNow,
      verifiedTranscriptsOnly: snapshot.selection.verifiedTranscriptsOnly,
    });
    sources.sort((a, b) => (order.get(a.utteranceId) ?? 0) - (order.get(b.utteranceId) ?? 0));
    for (const source of sources) inputs.push(...translationJobsForRevision(batchId, snapshot, source, now));

    if (inputs.length === 0) {
      throw new AppError(
        "INVALID_STATE",
        "The batch has no work: no selected utterance has a transcript that can be translated, and ASR is not part of the batch.",
        { batchId },
      );
    }

    await tx.update(processingBatches).set({ status: "queued", startedAt: now }).where(eq(processingBatches.id, batchId));
    const { createdCount } = await enqueueJobs(tx, inputs);
    await recordAudit(tx, {
      action: "batch.start",
      entityType: "processing_batch",
      entityId: batchId,
      before: { status: "draft" },
      after: { status: "queued", enqueuedJobs: createdCount },
      actorLabel: ctx.actorLabel,
    });
  });
  return getBatch(ctx, batchId);
}

// Cancels a batch: queued jobs are cancelled, running jobs finish, and no
// follow-up job is added. The batch and its outputs stay visible (spec 54).
export async function cancelBatch(ctx: ServiceContext, batchId: string): Promise<BatchDetail> {
  await ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (!["draft", "queued", "running"].includes(batch.status)) {
      throw new AppError(
        "INVALID_STATE",
        `Only a draft, queued or running batch can be cancelled. This batch is ${batch.status}.`,
        { batchId, status: batch.status },
      );
    }
    const now = ctx.now();
    const { cancelled } = await cancelQueuedJobsForBatch(tx, batchId, now);
    await tx
      .update(processingBatches)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(processingBatches.id, batchId));
    await recordAudit(tx, {
      action: "batch.cancel",
      entityType: "processing_batch",
      entityId: batchId,
      before: { status: batch.status },
      after: { status: "cancelled", cancelledJobs: cancelled },
      actorLabel: ctx.actorLabel,
    });
  });
  return getBatch(ctx, batchId);
}

// Puts the failed jobs of a batch back in the queue, under the same frozen
// configuration. Succeeded jobs are never run again (spec 145).
export async function retryFailedJobs(
  ctx: ServiceContext,
  batchId: string,
): Promise<{ retried: number; batch: BatchDetail }> {
  const retried = await ctx.db.transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (batch.status === "cancelled") {
      throw new AppError("INVALID_STATE", "A cancelled batch cannot be retried. Create a new batch instead.", { batchId });
    }
    if (batch.status === "draft") {
      throw new AppError("INVALID_STATE", "The batch has not been started yet.", { batchId });
    }
    const now = ctx.now();
    const result = await retryFailedJobsForBatch(tx, batchId, { now });
    if (result.retried > 0) {
      await tx
        .update(processingBatches)
        .set({ status: "running", completedAt: null })
        .where(eq(processingBatches.id, batchId));
    }
    await recordAudit(tx, {
      action: "batch.retry_failed",
      entityType: "processing_batch",
      entityId: batchId,
      before: { status: batch.status },
      after: { status: result.retried > 0 ? "running" : batch.status, retriedJobs: result.retried },
      actorLabel: ctx.actorLabel,
    });
    return result.retried;
  });
  return { retried, batch: await getBatch(ctx, batchId) };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type RefreshBatchStatusOptions = {
  // A handler calls this while its own job is still `running`. It passes the
  // status the job is about to get, so the last job of a batch can close it.
  assume?: { jobId: string; status: JobStatus };
};

function deriveStatus(current: BatchStatus, counts: JobCounts): BatchStatus {
  if (counts.total === 0) return current;
  if (counts.queued + counts.running > 0) {
    const untouched = counts.queued === counts.total;
    return untouched && current === "queued" ? "queued" : "running";
  }
  return counts.failed > 0 ? "completed_with_errors" : "completed";
}

// Derives `queued`, `running`, `completed` or `completed_with_errors` from the
// job counts. A draft or cancelled batch is never changed.
export async function refreshBatchStatus(
  ctx: ServiceContext,
  batchId: string,
  options: RefreshBatchStatusOptions = {},
): Promise<BatchStatus> {
  const [batch] = await ctx.db
    .select({ status: processingBatches.status })
    .from(processingBatches)
    .where(eq(processingBatches.id, batchId))
    .limit(1);
  if (!batch) throw new AppError("NOT_FOUND", "Processing batch not found.", { batchId });
  if (batch.status === "draft" || batch.status === "cancelled") return batch.status;

  const counts = await getJobCountsForBatch(ctx.db, batchId);
  if (options.assume) {
    const [job] = await ctx.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.id, options.assume.jobId), eq(jobs.processingBatchId, batchId)))
      .limit(1);
    if (job && job.status !== options.assume.status) {
      counts[job.status] -= 1;
      counts[options.assume.status] += 1;
    }
  }
  const next = deriveStatus(batch.status, counts);
  if (next === batch.status) return next;
  const finished = next === "completed" || next === "completed_with_errors";
  // The status condition keeps this from overwriting a cancel made meanwhile.
  await ctx.db
    .update(processingBatches)
    .set({ status: next, completedAt: finished ? ctx.now() : null })
    .where(and(eq(processingBatches.id, batchId), eq(processingBatches.status, batch.status)));
  return next;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type BatchConfigLabel = {
  modelConfigId: string;
  key: string;
  versionNumber: number;
  conditionKey: string;
  provider: string;
  modelId: string;
  promptKey: string | null;
  promptVersionNumber: number | null;
};

// Operational figure only, never scientific data. Null when no model run of the
// batch has a cost estimate (no price table is configured by default).
export type BatchCostEstimate = { isEstimate: true; amount: number };

export type BatchSummary = {
  id: string;
  studyId: string;
  name: string;
  description: string | null;
  status: BatchStatus;
  dataMode: StudyMode;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdByLabel: string | null;
  utteranceCount: number;
  jobCounts: JobCounts;
  transcriptTypes: TranscriptType[];
  config: { asr: BatchConfigLabel | null; translations: BatchConfigLabel[]; tts: BatchConfigLabel[] };
  estimatedJobCounts: { asr: number; translation: number; tts: number } | null;
  estimatedCost: BatchCostEstimate | null;
};

export type BatchJobView = {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  availableAt: Date;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  // Identifiers only: utterance, revision, translation and configuration ids.
  payload: Record<string, unknown>;
};

export type BatchDetail = BatchSummary & {
  // The frozen configuration, including the prompt texts.
  configuration: BatchConfigurationSnapshot;
  outputCounts: { asrRevisions: number; translations: number; syntheses: number };
  modelRunCounts: { succeeded: number; failed: number; running: number };
  // The newest failed jobs, at most 50. Use listBatchJobs for all of them.
  failedJobs: BatchJobView[];
};

function label(config: ModelConfigSnapshot): BatchConfigLabel {
  return {
    modelConfigId: config.modelConfigId,
    key: config.key,
    versionNumber: config.versionNumber,
    conditionKey: conditionKeyOf(config),
    provider: config.provider,
    modelId: config.modelId,
    promptKey: config.promptKey,
    promptVersionNumber: config.promptVersionNumber,
  };
}

function emptyCounts(): JobCounts {
  return { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, total: 0 };
}

function toSummary(batch: ProcessingBatchRow, jobCounts: JobCounts, cost: number | null): BatchSummary {
  const snapshot = batch.configurationSnapshotJson;
  return {
    id: batch.id,
    studyId: batch.studyId,
    name: batch.name,
    description: batch.description,
    status: batch.status,
    dataMode: batch.dataMode,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    cancelledAt: batch.cancelledAt,
    createdByLabel: batch.createdByLabel,
    utteranceCount: snapshot.utteranceIds.length,
    jobCounts,
    transcriptTypes: snapshot.transcriptTypes,
    config: {
      asr: snapshot.asr ? label(snapshot.asr) : null,
      translations: snapshot.translations.map(label),
      tts: snapshot.tts.map(label),
    },
    estimatedJobCounts: snapshot.estimatedJobCounts ?? null,
    estimatedCost: cost === null ? null : { isEstimate: true, amount: cost },
  };
}

async function loadSummaries(ctx: ServiceContext, batches: ProcessingBatchRow[]): Promise<BatchSummary[]> {
  if (batches.length === 0) return [];
  const ids = batches.map((batch) => batch.id);
  const countRows = await ctx.db
    .select({ batchId: jobs.processingBatchId, status: jobs.status, value: count() })
    .from(jobs)
    .where(inArray(jobs.processingBatchId, ids))
    .groupBy(jobs.processingBatchId, jobs.status);
  const countsByBatch = new Map<string, JobCounts>();
  for (const row of countRows) {
    if (!row.batchId) continue;
    const counts = countsByBatch.get(row.batchId) ?? emptyCounts();
    counts[row.status] = row.value;
    counts.total += row.value;
    countsByBatch.set(row.batchId, counts);
  }
  const costRows = await ctx.db
    .select({ batchId: modelRuns.processingBatchId, value: sql<string | null>`sum(${modelRuns.estimatedCost})` })
    .from(modelRuns)
    .where(inArray(modelRuns.processingBatchId, ids))
    .groupBy(modelRuns.processingBatchId);
  const costByBatch = new Map<string, number>();
  for (const row of costRows) {
    if (row.batchId && row.value !== null) costByBatch.set(row.batchId, Number(row.value));
  }
  return batches.map((batch) =>
    toSummary(batch, countsByBatch.get(batch.id) ?? emptyCounts(), costByBatch.get(batch.id) ?? null),
  );
}

export type ListBatchesResult = { batches: BatchSummary[]; total: number; page: number; pageSize: number };

// Newest first, paginated on the server (50 per page by default, spec 134).
// Batches that are still active get their status refreshed first.
export async function listBatches(
  ctx: ServiceContext,
  input: processingSchemas.ListBatchesQuery = {},
): Promise<ListBatchesResult> {
  const query = processingSchemas.listBatchesQuerySchema.parse(input);
  const study = await resolveStudy(ctx.db, query.studyId);
  const where = eq(processingBatches.studyId, study.id);

  const active = await ctx.db
    .select({ id: processingBatches.id })
    .from(processingBatches)
    .where(and(where, inArray(processingBatches.status, ["queued", "running"])));
  for (const batch of active) await refreshBatchStatus(ctx, batch.id);

  const [totalRow] = await ctx.db.select({ value: count() }).from(processingBatches).where(where);
  const rows = await ctx.db
    .select()
    .from(processingBatches)
    .where(where)
    .orderBy(desc(processingBatches.createdAt), desc(processingBatches.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return {
    batches: await loadSummaries(ctx, rows),
    total: totalRow?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

function toJobView(job: Job): BatchJobView {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    availableAt: job.availableAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    payload: job.payloadJson,
  };
}

export async function getBatch(ctx: ServiceContext, batchId: string): Promise<BatchDetail> {
  const [found] = await ctx.db.select().from(processingBatches).where(eq(processingBatches.id, batchId)).limit(1);
  if (!found) throw new AppError("NOT_FOUND", "Processing batch not found.", { batchId });
  let batch = found;
  if (batch.status === "queued" || batch.status === "running") {
    await refreshBatchStatus(ctx, batchId);
    const [fresh] = await ctx.db.select().from(processingBatches).where(eq(processingBatches.id, batchId)).limit(1);
    if (fresh) batch = fresh;
  }
  const [summary] = await loadSummaries(ctx, [batch]);
  if (!summary) throw new AppError("NOT_FOUND", "Processing batch not found.", { batchId });

  const [translationCount] = await ctx.db
    .select({ value: count() })
    .from(translations)
    .where(eq(translations.processingBatchId, batchId));
  const [synthesisCount] = await ctx.db
    .select({ value: count() })
    .from(syntheses)
    .where(eq(syntheses.processingBatchId, batchId));
  const [asrCount] = await ctx.db
    .select({ value: count() })
    .from(transcriptRevisions)
    .innerJoin(modelRuns, eq(modelRuns.id, transcriptRevisions.sourceModelRunId))
    .where(eq(modelRuns.processingBatchId, batchId));
  const runRows = await ctx.db
    .select({ status: modelRuns.status, value: count() })
    .from(modelRuns)
    .where(eq(modelRuns.processingBatchId, batchId))
    .groupBy(modelRuns.status);
  const modelRunCounts = { succeeded: 0, failed: 0, running: 0 };
  for (const row of runRows) modelRunCounts[row.status] = row.value;

  const failed = await listJobs(ctx.db, { processingBatchId: batchId, status: "failed", limit: 50 });
  return {
    ...summary,
    configuration: batch.configurationSnapshotJson,
    outputCounts: {
      asrRevisions: asrCount?.value ?? 0,
      translations: translationCount?.value ?? 0,
      syntheses: synthesisCount?.value ?? 0,
    },
    modelRunCounts,
    failedJobs: failed.jobs.map(toJobView),
  };
}

export type ListBatchJobsResult = { jobs: BatchJobView[]; total: number; page: number; pageSize: number };

// Jobs of one batch, newest first, optionally filtered by status.
export async function listBatchJobs(
  ctx: ServiceContext,
  batchId: string,
  input: processingSchemas.ListBatchJobsQuery = {},
): Promise<ListBatchJobsResult> {
  const query = processingSchemas.listBatchJobsQuerySchema.parse(input);
  const [batch] = await ctx.db
    .select({ id: processingBatches.id })
    .from(processingBatches)
    .where(eq(processingBatches.id, batchId))
    .limit(1);
  if (!batch) throw new AppError("NOT_FOUND", "Processing batch not found.", { batchId });
  const result = await listJobs(ctx.db, {
    processingBatchId: batchId,
    ...(query.status ? { status: query.status } : {}),
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return { jobs: result.jobs.map(toJobView), total: result.total, page: query.page, pageSize: query.pageSize };
}

// ---------------------------------------------------------------------------
// Choices for the "Create batch" wizard
// ---------------------------------------------------------------------------

export type BatchConfigOption = {
  id: string;
  key: string;
  stage: ProcessingStage;
  versionNumber: number;
  name: string | null;
  conditionKey: string | null;
  provider: string;
  modelId: string;
  promptKey: string | null;
  promptVersionNumber: number | null;
  hasPrompt: boolean;
  voice: string | null;
  // True for the configurations a batch uses when none is named.
  isDefault: boolean;
};

export type BatchOptions = {
  studyId: string;
  // IANA time zone of the admin display, or null when the study sets none.
  adminTimezone: string | null;
  sourceLanguage: string | null;
  targetLanguage: string | null;
  // Active configurations only: a batch can only be created from active ones.
  modelConfigs: BatchConfigOption[];
  protocolVersions: Array<{ id: string; versionNumber: number; name: string; status: PublicationStatus }>;
};

const DEFAULT_CONFIG_KEYS: readonly string[] = [
  DEFAULT_ASR_CONFIG_KEY,
  ...DEFAULT_TRANSLATION_CONFIG_KEYS,
  DEFAULT_TTS_CONFIG_KEY,
];

// What the wizard can choose from: active model configurations and the
// protocol versions that sessions can belong to.
export async function getBatchOptions(ctx: ServiceContext, input: { studyId?: string } = {}): Promise<BatchOptions> {
  const study = await resolveStudy(ctx.db, input.studyId);
  const configRows = await ctx.db
    .select({ config: modelConfigs, prompt: aiPromptVersions })
    .from(modelConfigs)
    .leftJoin(aiPromptVersions, eq(aiPromptVersions.id, modelConfigs.promptVersionId))
    .where(and(eq(modelConfigs.studyId, study.id), eq(modelConfigs.status, "active")))
    .orderBy(modelConfigs.stage, modelConfigs.key);
  const protocolRows = await ctx.db
    .select({
      id: protocolVersions.id,
      versionNumber: protocolVersions.versionNumber,
      name: protocolVersions.name,
      status: protocolVersions.status,
    })
    .from(protocolVersions)
    .where(and(eq(protocolVersions.studyId, study.id), inArray(protocolVersions.status, ["published", "retired"])))
    .orderBy(desc(protocolVersions.versionNumber));
  return {
    studyId: study.id,
    adminTimezone: study.settingsJson.adminTimezone ?? null,
    sourceLanguage: study.settingsJson.sourceLanguage ?? null,
    targetLanguage: study.settingsJson.targetLanguage ?? null,
    modelConfigs: configRows
      .filter(({ config }) => ["asr", "translation", "tts"].includes(config.stage))
      .map(({ config, prompt }) => ({
        id: config.id,
        key: config.key,
        stage: config.stage,
        versionNumber: config.versionNumber,
        name: config.name,
        conditionKey: config.conditionKey,
        provider: config.provider,
        modelId: config.modelId,
        promptKey: prompt?.key ?? null,
        promptVersionNumber: prompt?.versionNumber ?? null,
        hasPrompt: Boolean(prompt && prompt.promptText.trim().length > 0),
        voice: typeof config.parametersJson?.voice === "string" ? config.parametersJson.voice : null,
        isDefault: DEFAULT_CONFIG_KEYS.includes(config.key),
      })),
    protocolVersions: protocolRows,
  };
}
