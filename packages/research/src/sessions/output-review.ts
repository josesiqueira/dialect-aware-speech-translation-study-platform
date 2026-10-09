// The output review at the end of a session (docs/RESEARCH-DESIGN.md, section 3;
// reports/Source speaker output evaluation.md).
//
// After all speaking tasks and the first questionnaires, a participant who
// accepted the consent item of scope output_review (and external AI processing):
//   1. takes the English vocabulary test (LexTALE), only when a researcher turned
//      it on (off by default since 2026-10-09);
//   2. rates the AI output of some of their own recordings, one screen per
//      recording: "Is this what you said?" about the speech recognition text, then
//      the two English versions side by side, each with two questions (meaning and
//      representation, scale version output-review-v2);
//   3. answers the post-review questionnaire.
// The part can be skipped at any point.
//
// This module is the only participant module that reads transcripts,
// translations and syntheses. It does so only for the step "output_review",
// only for the session's own recordings, and never sends a condition name, a
// model name or a prompt: the two versions are "Version 1" and "Version 2".
// It never calls a model: it shows what the automatic processing already made.
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  consentVersions,
  englishChecks,
  mediaAssets,
  outputReviewItems,
  outputReviews,
  questionnaireResponses,
  sessionConsents,
  syntheses,
  taskPresentations,
  transcriptRevisions,
  transcripts,
  translations,
  utterances,
  type DbOrTx,
  type OutputReviewSelection,
  type OutputReviewShown,
} from "@dialect/db";
import {
  AppError,
  CONSENT_SCOPE_EXTERNAL_AI_PROCESSING,
  CONSENT_SCOPE_OUTPUT_REVIEW,
  LEXTALE_EN_ITEMS,
  LEXTALE_EN_VERSION,
  OUTPUT_REVIEW_CONDITION_KEYS,
  OUTPUT_REVIEW_SCALE_VERSION,
  scoreLexTale,
  type OutputReviewItemKind,
  type sessionSchemas,
} from "@dialect/domain";
import type { ServiceContext } from "../context";
import { invalidState, lockActiveSession, type MediaRow, type ProtocolRow, type SessionRef, type SessionRow } from "./internal";
import { blockSeed, mulberry32, seededShuffle } from "./ordering";
import type { EffectiveSettings } from "./settings";

type ReviewRow = typeof outputReviews.$inferSelect;
type ItemRow = typeof outputReviewItems.$inferSelect;

// How long the review waits for the automatic processing of the last recordings
// before it goes on with what is ready.
export const OUTPUT_REVIEW_MAX_WAIT_SECONDS = 120;
export const OUTPUT_REVIEW_SELECTION_ALGORITHM = "spread_across_tasks_mulberry32_sha256_v1";

const [CONDITION_A, CONDITION_B] = OUTPUT_REVIEW_CONDITION_KEYS;

// ---------------------------------------------------------------------------
// Eligibility and the step
// ---------------------------------------------------------------------------

export type ReviewEligibility = { eligible: true } | { eligible: false; reason: string };

// The review part runs only when the study enables it, for research and test
// sessions, and only when the participant accepted both an item of scope
// output_review and an item of scope external_ai_processing.
export async function reviewEligibility(
  db: DbOrTx,
  session: Pick<SessionRow, "id" | "mode">,
  settings: Pick<EffectiveSettings, "outputReviewEnabled">,
): Promise<ReviewEligibility> {
  if (!settings.outputReviewEnabled) return { eligible: false, reason: "disabled_in_settings" };
  if (session.mode === "demo") return { eligible: false, reason: "demo_session" };
  const [consent] = await db
    .select({ responses: sessionConsents.responsesJson, items: consentVersions.itemsJson })
    .from(sessionConsents)
    .innerJoin(consentVersions, eq(consentVersions.id, sessionConsents.consentVersionId))
    .where(eq(sessionConsents.sessionId, session.id))
    .limit(1);
  if (!consent) return { eligible: false, reason: "no_consent_record" };
  const accepted = (scope: string) => {
    const ids = consent.items.filter((item) => item.scope === scope).map((item) => item.id);
    return consent.responses.some((response) => response.accepted === true && ids.includes(response.itemId));
  };
  if (!accepted(CONSENT_SCOPE_OUTPUT_REVIEW)) return { eligible: false, reason: "output_review_not_accepted" };
  if (!accepted(CONSENT_SCOPE_EXTERNAL_AI_PROCESSING)) {
    return { eligible: false, reason: "external_ai_processing_not_accepted" };
  }
  return { eligible: true };
}

async function loadReview(db: DbOrTx, sessionId: string): Promise<ReviewRow | null> {
  const [review] = await db.select().from(outputReviews).where(eq(outputReviews.sessionId, sessionId));
  return review ?? null;
}

async function hasEnglishCheck(db: DbOrTx, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: englishChecks.id })
    .from(englishChecks)
    .where(eq(englishChecks.sessionId, sessionId))
    .limit(1);
  return Boolean(row);
}

// The review step a session is at, after the post-recording questionnaire, or
// null when the review part is over or does not apply (the session goes to the debrief).
export async function reviewStepOf(
  db: DbOrTx,
  session: SessionRow,
  protocol: ProtocolRow,
  settings: EffectiveSettings,
): Promise<"english_check" | "output_review" | "post_review" | null> {
  if (!(await reviewEligibility(db, session, settings)).eligible) return null;
  const review = await loadReview(db, session.id);
  if (review && (review.status === "skipped" || review.status === "unavailable")) return null;
  if (!review && settings.englishCheckEnabled && !(await hasEnglishCheck(db, session.id))) return "english_check";
  if (!review || review.status === "in_progress") return "output_review";
  const postReviewId = protocol.postReviewQuestionnaireVersionId;
  if (postReviewId) {
    const [response] = await db
      .select({ id: questionnaireResponses.id })
      .from(questionnaireResponses)
      .where(and(eq(questionnaireResponses.sessionId, session.id), eq(questionnaireResponses.questionnaireVersionId, postReviewId)))
      .limit(1);
    if (!response) return "post_review";
  }
  return null;
}

// When the step "output_review" began: the last answer the participant gave
// before it (a questionnaire or the English check).
async function reviewStepStartedAt(db: DbOrTx, session: SessionRow): Promise<Date> {
  const [lastResponse] = await db
    .select({ at: questionnaireResponses.submittedAt })
    .from(questionnaireResponses)
    .where(eq(questionnaireResponses.sessionId, session.id))
    .orderBy(desc(questionnaireResponses.submittedAt))
    .limit(1);
  const [check] = await db
    .select({ at: englishChecks.submittedAt })
    .from(englishChecks)
    .where(eq(englishChecks.sessionId, session.id));
  const times = [lastResponse?.at, check?.at, session.lastActivityAt].filter((value): value is Date => value instanceof Date);
  return new Date(Math.max(...times.map((time) => time.getTime())));
}

// ---------------------------------------------------------------------------
// English check (LexTALE)
// ---------------------------------------------------------------------------

export function englishCheckContent(): sessionSchemas.EnglishCheckContent {
  return {
    version: LEXTALE_EN_VERSION,
    // Exactly the published order, never shuffled (the test is standardized).
    items: LEXTALE_EN_ITEMS.map((item, index) => ({ index, text: item.item })),
  };
}

export async function submitEnglishCheck(
  ctx: ServiceContext,
  session: SessionRef,
  input: { answers: boolean[] },
  stepOf: (tx: DbOrTx) => Promise<string>,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    if (await hasEnglishCheck(tx, locked.id)) return;
    const step = await stepOf(tx);
    if (step !== "english_check") {
      throw invalidState("The English check cannot be answered at this point of the study.", { step });
    }
    if (input.answers.length !== LEXTALE_EN_ITEMS.length) {
      throw new AppError("VALIDATION_ERROR", `The English check needs ${LEXTALE_EN_ITEMS.length} answers.`, {
        issues: [{ path: "answers", message: "Every item needs an answer.", code: "required" }],
      });
    }
    const score = scoreLexTale(input.answers);
    await tx.insert(englishChecks).values({
      sessionId: locked.id,
      testVersion: LEXTALE_EN_VERSION,
      responsesJson: LEXTALE_EN_ITEMS.map((item, index) => ({
        index,
        text: item.item,
        isWord: item.isWord,
        dummy: item.dummy,
        answer: input.answers[index] === true,
      })),
      wordsCorrect: score.wordsCorrect,
      nonwordsCorrect: score.nonwordsCorrect,
      score: score.score.toFixed(2),
      submittedAt: ctx.now(),
    });
  });
}

// ---------------------------------------------------------------------------
// Which recordings are ready, and the selection
// ---------------------------------------------------------------------------

export type ReadyOutput = {
  utteranceId: string;
  revisionId: string;
  text: string;
  // Per condition key: the translation and its synthesis.
  outputs: Record<string, { translationId: string; text: string; synthesisId: string }>;
};

type Candidate = { utteranceId: string; sequenceIndex: number; turnIndex: number };

async function reviewCandidates(db: DbOrTx, sessionId: string): Promise<Candidate[]> {
  return db
    .select({
      utteranceId: utterances.id,
      sequenceIndex: taskPresentations.sequenceIndex,
      turnIndex: utterances.turnIndex,
    })
    .from(utterances)
    .innerJoin(taskPresentations, eq(taskPresentations.id, utterances.taskPresentationId))
    .where(and(eq(utterances.sessionId, sessionId), eq(utterances.status, "submitted")))
    .orderBy(asc(taskPresentations.sequenceIndex), asc(utterances.turnIndex));
}

// Spreads the recordings across tasks: the tasks in a seeded random order, one
// recording of each task per round, the recordings of one task in a seeded random
// order. The same session always gives the same order.
export function spreadAcrossTasks(candidates: readonly Candidate[], orderSeed: string): string[] {
  const byTask = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const list = byTask.get(candidate.sequenceIndex) ?? [];
    list.push(candidate);
    byTask.set(candidate.sequenceIndex, list);
  }
  const taskOrder = seededShuffle(
    [...byTask.keys()].sort((a, b) => a - b),
    mulberry32(blockSeed(orderSeed, "output-review:tasks")),
  );
  const queues = taskOrder.map((sequenceIndex) =>
    seededShuffle(
      (byTask.get(sequenceIndex) ?? []).map((candidate) => candidate.utteranceId).sort(),
      mulberry32(blockSeed(orderSeed, `output-review:task:${sequenceIndex}`)),
    ),
  );
  const order: string[] = [];
  for (let round = 0; queues.some((queue) => round < queue.length); round += 1) {
    for (const queue of queues) {
      const id = queue[round];
      if (id) order.push(id);
    }
  }
  return order;
}

// The outputs of each recording that the review can show: the current speech
// recognition revision with text, and for both review conditions a translation
// of exactly that revision with a stored synthesis. Excluded outputs are left out.
export async function readyOutputs(
  db: DbOrTx,
  utteranceIds: readonly string[],
): Promise<{ ready: Map<string, ReadyOutput>; reasons: Map<string, string> }> {
  const ready = new Map<string, ReadyOutput>();
  const reasons = new Map<string, string>();
  if (utteranceIds.length === 0) return { ready, reasons };

  const revisions = await db
    .select({ utteranceId: transcripts.utteranceId, revisionId: transcriptRevisions.id, text: transcriptRevisions.text })
    .from(transcriptRevisions)
    .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
    .where(
      and(
        inArray(transcripts.utteranceId, [...utteranceIds]),
        eq(transcripts.type, "asr"),
        eq(transcriptRevisions.isCurrent, true),
      ),
    );
  const revisionOf = new Map(revisions.map((row) => [row.utteranceId, row]));
  const revisionIds = revisions.map((row) => row.revisionId);

  const rows =
    revisionIds.length === 0
      ? []
      : await db
          .select({
            revisionId: translations.sourceTranscriptRevisionId,
            translationId: translations.id,
            conditionKey: translations.conditionKey,
            text: translations.translatedText,
            translationStatus: translations.status,
            translatedAt: translations.createdAt,
            synthesisId: syntheses.id,
            synthesisStatus: syntheses.status,
            synthesizedAt: syntheses.createdAt,
            mediaDeletedAt: mediaAssets.deletedAt,
          })
          .from(translations)
          .leftJoin(syntheses, eq(syntheses.translationId, translations.id))
          .leftJoin(mediaAssets, eq(mediaAssets.id, syntheses.mediaAssetId))
          .where(
            and(
              inArray(translations.sourceTranscriptRevisionId, revisionIds),
              inArray(translations.conditionKey, [...OUTPUT_REVIEW_CONDITION_KEYS]),
            ),
          )
          .orderBy(desc(translations.createdAt), desc(syntheses.createdAt));

  for (const utteranceId of utteranceIds) {
    const revision = revisionOf.get(utteranceId);
    if (!revision) {
      reasons.set(utteranceId, "no_speech_recognition_yet");
      continue;
    }
    if (!revision.text.trim()) {
      reasons.set(utteranceId, "empty_speech_recognition_text");
      continue;
    }
    const outputs: ReadyOutput["outputs"] = {};
    for (const condition of OUTPUT_REVIEW_CONDITION_KEYS) {
      // The newest usable translation of this condition that has a usable synthesis.
      const match = rows.find(
        (row) =>
          row.revisionId === revision.revisionId &&
          row.conditionKey === condition &&
          row.translationStatus !== "excluded" &&
          row.synthesisId !== null &&
          row.synthesisStatus !== "excluded" &&
          row.mediaDeletedAt === null,
      );
      if (match?.synthesisId) {
        outputs[condition] = { translationId: match.translationId, text: match.text, synthesisId: match.synthesisId };
      }
    }
    if (Object.keys(outputs).length < OUTPUT_REVIEW_CONDITION_KEYS.length) {
      reasons.set(utteranceId, "translations_or_speech_not_ready");
      continue;
    }
    ready.set(utteranceId, { utteranceId, revisionId: revision.revisionId, text: revision.text, outputs });
  }
  return { ready, reasons };
}

type PlannedItem = Omit<typeof outputReviewItems.$inferInsert, "reviewId" | "sessionId">;

// The plan of the review: one screen per chosen recording, in the chosen order.
// Left and right are random per screen. The random choices come from the session
// seed, so the plan can be reproduced; it is stored as it was shown.
export function planReviewItems(input: { orderSeed: string; chosen: ReadyOutput[] }): PlannedItem[] {
  const random = mulberry32(blockSeed(input.orderSeed, "output-review:plan"));
  const base = { scaleVersion: OUTPUT_REVIEW_SCALE_VERSION };

  const own: PlannedItem[] = input.chosen.map((output) => {
    const leftIsA = random() < 0.5;
    const left = leftIsA ? CONDITION_A : CONDITION_B;
    const right = leftIsA ? CONDITION_B : CONDITION_A;
    const leftOut = output.outputs[left as string]!;
    const rightOut = output.outputs[right as string]!;
    return {
      ...base,
      presentationIndex: 0,
      kind: "utterance" as OutputReviewItemKind,
      utteranceId: output.utteranceId,
      transcriptRevisionId: output.revisionId,
      leftTranslationId: leftOut.translationId,
      rightTranslationId: rightOut.translationId,
      leftConditionKey: left,
      rightConditionKey: right,
      leftSynthesisId: leftOut.synthesisId,
      rightSynthesisId: rightOut.synthesisId,
      shownJson: {
        display: "own",
        sourceText: output.text,
        sourceTokens: null,
        version1: leftOut.text,
        version2: rightOut.text,
      } satisfies OutputReviewShown,
    };
  });
  return own.map((item, index) => ({ ...item, presentationIndex: index }));
}

// POST /api/study/output-review/start. Selects the recordings and stores the
// plan, or answers "preparing" while recordings are still being processed and the
// waiting time is not over. Repeating it changes nothing once the plan exists.
export async function startOutputReview(
  ctx: ServiceContext,
  session: SessionRef,
  stepOf: (tx: DbOrTx) => Promise<string>,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked, settings } = await lockActiveSession(tx, session.id);
    if (await loadReview(tx, locked.id)) return;
    const step = await stepOf(tx);
    if (step !== "output_review") {
      throw invalidState("The review cannot start at this point of the study.", { step });
    }
    const now = ctx.now();
    const waitedSeconds = Math.max(0, Math.floor((now.getTime() - (await reviewStepStartedAt(tx, locked)).getTime()) / 1000));
    const candidates = spreadAcrossTasks(await reviewCandidates(tx, locked.id), locked.orderSeed ?? locked.id);
    const { ready, reasons } = await readyOutputs(tx, candidates);
    const readyInOrder = candidates.filter((id) => ready.has(id));
    const maxItems = settings.outputReviewMaxItems;
    const enough = readyInOrder.length >= Math.min(maxItems, candidates.length) && candidates.length > 0;
    const timeUp = waitedSeconds >= OUTPUT_REVIEW_MAX_WAIT_SECONDS;
    if (!enough && !timeUp && candidates.length > 0) return; // still preparing

    const chosenIds = readyInOrder.slice(0, maxItems);
    const selection: OutputReviewSelection = {
      algorithm: OUTPUT_REVIEW_SELECTION_ALGORITHM,
      maxItems,
      candidates,
      ready: readyInOrder,
      chosen: chosenIds,
      unavailable: candidates
        .filter((id) => !ready.has(id))
        .map((id) => ({ utteranceId: id, reason: reasons.get(id) ?? "unknown" })),
      waitedSeconds,
    };
    if (chosenIds.length === 0) {
      selection.reason = candidates.length === 0 ? "no_submitted_recordings" : "no_recording_ready_in_time";
      await tx.insert(outputReviews).values({
        sessionId: locked.id,
        status: "unavailable",
        scaleVersion: OUTPUT_REVIEW_SCALE_VERSION,
        selectionJson: selection,
        startedAt: now,
        finishedAt: now,
      });
      ctx.logger.info({ sessionId: locked.id, reason: selection.reason }, "output review unavailable");
      return;
    }
    const [review] = await tx
      .insert(outputReviews)
      .values({
        sessionId: locked.id,
        status: "in_progress",
        scaleVersion: OUTPUT_REVIEW_SCALE_VERSION,
        selectionJson: selection,
        startedAt: now,
      })
      .returning();
    if (!review) throw new AppError("DATABASE_ERROR", "The review could not be stored.");
    const plan = planReviewItems({
      orderSeed: locked.orderSeed ?? locked.id,
      chosen: chosenIds.map((id) => ready.get(id)!),
    });
    await tx.insert(outputReviewItems).values(plan.map((item) => ({ ...item, reviewId: review.id, sessionId: locked.id })));
  });
}

// ---------------------------------------------------------------------------
// What the participant sees
// ---------------------------------------------------------------------------

async function nextItem(db: DbOrTx, reviewId: string): Promise<{ item: ItemRow | null; total: number }> {
  const items = await db
    .select()
    .from(outputReviewItems)
    .where(eq(outputReviewItems.reviewId, reviewId))
    .orderBy(asc(outputReviewItems.presentationIndex));
  return { item: items.find((row) => row.answeredAt === null) ?? null, total: items.length };
}

export function itemContent(item: ItemRow): sessionSchemas.OutputReviewItemContent {
  const shown = item.shownJson;
  const versions: sessionSchemas.OutputReviewItemContent["versions"] = [];
  if (shown.version1 !== null) versions.push({ slot: 1, text: shown.version1 });
  if (shown.version2 !== null) versions.push({ slot: 2, text: shown.version2 });
  return {
    id: item.id,
    sourceText: shown.sourceText ?? "",
    versions,
    audio: { source: item.utteranceId !== null },
  };
}

export async function outputReviewContent(db: DbOrTx, session: SessionRow, now: Date): Promise<sessionSchemas.OutputReviewContent> {
  const review = await loadReview(db, session.id);
  if (review?.status === "in_progress") {
    const { item, total } = await nextItem(db, review.id);
    if (item) {
      return { status: "ready", itemNumber: item.presentationIndex + 1, totalItems: total, item: itemContent(item) };
    }
  }
  const startedAt = await reviewStepStartedAt(db, session);
  return {
    status: "preparing",
    waitedSeconds: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
    maxWaitSeconds: OUTPUT_REVIEW_MAX_WAIT_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Answers and skipping
// ---------------------------------------------------------------------------

// Normalizes one answer of a screen (scale version output-review-v2). Returns the
// stored columns. "Can't say" is stored as null and listed in cantJudgeJson.
export function normalizeAnswer(body: sessionSchemas.OutputReviewAnswerBody): {
  ratingsJson: Record<string, unknown>;
  choice: null;
  markedWordsJson: null;
  cantJudgeJson: string[];
} {
  const cantJudge: string[] = [];
  const versions: Record<string, Record<string, number | null>> = {};
  for (const slot of ["1", "2"] as const) {
    const stored: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(body.versions[slot])) {
      if (value === "cant_judge") {
        stored[key] = null;
        cantJudge.push(`versions.${slot}.${key}`);
      } else stored[key] = value;
    }
    versions[slot] = stored;
  }
  return {
    ratingsJson: { transcript: { said: body.source.said }, versions },
    choice: null,
    markedWordsJson: null,
    cantJudgeJson: cantJudge,
  };
}

export async function answerReviewItem(
  ctx: ServiceContext,
  session: SessionRef,
  input: { itemId: string; body: sessionSchemas.OutputReviewAnswerBody },
  stepOf: (tx: DbOrTx) => Promise<string>,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    const [item] = await tx
      .select()
      .from(outputReviewItems)
      .where(and(eq(outputReviewItems.id, input.itemId), eq(outputReviewItems.sessionId, locked.id)));
    if (!item) throw new AppError("NOT_FOUND", "This review item does not exist.");
    if (item.answeredAt) return; // a repeated answer changes nothing
    const step = await stepOf(tx);
    if (step !== "output_review") throw invalidState("The review is not running.", { step });
    const review = await loadReview(tx, locked.id);
    if (!review || review.status !== "in_progress") throw invalidState("The review is not running.");
    const { item: current } = await nextItem(tx, review.id);
    if (current?.id !== item.id) throw invalidState("Answer the review items in order.", { expected: current?.id ?? null });

    if (item.kind !== "utterance") throw invalidState("This review screen can no longer be answered.");
    const normalized = normalizeAnswer(input.body);
    const now = ctx.now();
    await tx
      .update(outputReviewItems)
      .set({ ...normalized, answeredAt: now })
      .where(and(eq(outputReviewItems.id, item.id), isNull(outputReviewItems.answeredAt)));
    const { item: after } = await nextItem(tx, review.id);
    if (!after) {
      await tx.update(outputReviews).set({ status: "completed", finishedAt: now }).where(eq(outputReviews.id, review.id));
    }
  });
}

// "Skip this part": ends the review part. What was answered stays.
export async function skipOutputReview(
  ctx: ServiceContext,
  session: SessionRef,
  stepOf: (tx: DbOrTx) => Promise<string>,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    const step = await stepOf(tx);
    if (step !== "english_check" && step !== "output_review") {
      throw invalidState("There is nothing to skip at this point of the study.", { step });
    }
    const now = ctx.now();
    const review = await loadReview(tx, locked.id);
    if (!review) {
      await tx.insert(outputReviews).values({
        sessionId: locked.id,
        status: "skipped",
        scaleVersion: OUTPUT_REVIEW_SCALE_VERSION,
        selectionJson: {},
        skippedAtStep: step === "english_check" ? "english_check" : "output_review:preparing",
        startedAt: now,
        finishedAt: now,
      });
      return;
    }
    if (review.status !== "in_progress") return;
    const { item } = await nextItem(tx, review.id);
    await tx
      .update(outputReviews)
      .set({
        status: "skipped",
        finishedAt: now,
        skippedAtStep: `output_review:${item ? item.presentationIndex + 1 : "end"}`,
      })
      .where(eq(outputReviews.id, review.id));
  });
}

// ---------------------------------------------------------------------------
// Audio for the review screens
// ---------------------------------------------------------------------------

// The stored file behind the play button of a review screen: the participant's
// own recording. Only for an item of the participant's own session and only while
// the review is running. Never a URL: the route streams it.
export async function reviewAudioFile(
  ctx: ServiceContext,
  session: SessionRef,
  input: { itemId: string; which: "source" },
  stepOf: (tx: DbOrTx) => Promise<string>,
): Promise<MediaRow> {
  const db = ctx.db;
  const [item] = await db
    .select()
    .from(outputReviewItems)
    .where(and(eq(outputReviewItems.id, input.itemId), eq(outputReviewItems.sessionId, session.id)));
  if (!item) throw new AppError("NOT_FOUND", "This recording is not available.");
  const step = await stepOf(db);
  if (step !== "output_review") throw new AppError("NOT_FOUND", "This recording is not available.");
  const content = itemContent(item);
  let mediaId: string | null = null;
  if (input.which === "source" && content.audio.source && item.utteranceId) {
    const [utterance] = await db
      .select({ mediaId: utterances.acceptedMediaAssetId })
      .from(utterances)
      .where(and(eq(utterances.id, item.utteranceId), eq(utterances.sessionId, session.id)));
    mediaId = utterance?.mediaId ?? null;
  }
  if (!mediaId) throw new AppError("NOT_FOUND", "This recording is not available.");
  const [media] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
  if (!media || media.deletedAt) throw new AppError("NOT_FOUND", "This recording is not available.");
  return media;
}
