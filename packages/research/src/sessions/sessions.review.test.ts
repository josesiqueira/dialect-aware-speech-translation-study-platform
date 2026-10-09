// The output review at the end of a session (output-review.ts).
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { englishChecks, isImmutableRecordError, outputReviewItems, outputReviews, utterances } from "@dialect/db";
import {
  insertProcessingBatch,
  insertSynthesis,
  insertTranscriptWithRevision,
  insertTranslation,
} from "@dialect/db/testing-builders";
import { AppError, LEXTALE_EN_ITEMS } from "@dialect/domain";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  acknowledgeInstructions,
  completeSession,
  confirmMicCheck,
  createSession,
  getParticipantState,
  participantAnswerReview,
  participantEnglishCheck,
  participantReviewAudio,
  participantSkipReview,
  participantStartReview,
  recordConsent,
  submitQuestionnaire,
  type SessionRef,
} from "./index";
import { OUTPUT_REVIEW_MAX_WAIT_SECONDS, planReviewItems, spreadAcrossTasks } from "./output-review";
import { OUTPUT_REVIEW_DEFAULT_MAX_ITEMS } from "./settings";
import {
  answerAllTasks,
  CONSENT_ITEMS_WITH_REVIEW,
  createTestStudy,
  expectStep,
  VALID_BACKGROUND_ANSWERS,
  VALID_POST_ANSWERS,
  VALID_POST_REVIEW_ANSWERS,
  type TestStudy,
} from "./test-support";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestServiceContext;

beforeAll(async () => {
  t = await createTestServiceContext();
});
afterAll(async () => {
  await t.cleanup();
});

const PERFECT_ENGLISH = LEXTALE_EN_ITEMS.map((item) => item.isWord);
const ownAnswer = {
  source: { said: "partly" as const },
  versions: {
    "1": { meaning: 5, representation: 4 },
    "2": { meaning: "cant_judge" as const, representation: 2 },
  },
};

async function reviewStudy(options: { settings?: Record<string, unknown>; consentItems?: typeof CONSENT_ITEMS_WITH_REVIEW } = {}) {
  return createTestStudy(t.ctx.db, {
    consentItems: options.consentItems ?? CONSENT_ITEMS_WITH_REVIEW,
    withPostReview: true,
    settings: options.settings,
  });
}

// A session that finished all tasks and both first questionnaires.
async function sessionAfterQuestionnaires(study: TestStudy, accept: (id: string) => boolean = () => true) {
  const created = await createSession(t.ctx, { studySlug: study.slug });
  const session: SessionRef = created.session;
  const consent = expectStep(created.state, "consent");
  await recordConsent(t.ctx, session, {
    responses: consent.consent.items.map((item) => ({ itemId: item.id, accepted: item.required || accept(item.id) })),
  });
  await confirmMicCheck(t.ctx, session, {});
  await acknowledgeInstructions(t.ctx, session);
  await answerAllTasks(t.ctx, session);
  await submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS });
  const state = await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS });
  return { session, state };
}

// Neutral labels for the mock translation texts, so that a check for condition
// names in what the participant sees is not set off by the mock text itself.
const MOCK_LABEL: Record<string, string> = { default: "alpha", preservation: "beta" };

// What the automatic processing writes for one recording: the ASR revision, both
// translations of it and a synthesis of each.
async function addOutputs(study: TestStudy, utteranceId: string, text = "mä en oo ihan varma") {
  const { revision } = await insertTranscriptWithRevision(t.ctx.db, { utteranceId, type: "asr", text });
  const batch = await insertProcessingBatch(t.ctx.db, { studyId: study.study.id });
  for (const conditionKey of ["default", "preservation"]) {
    const { translation } = await insertTranslation(t.ctx.db, {
      sourceTranscriptRevisionId: revision.id,
      processingBatchId: batch.id,
      conditionKey,
      translatedText: `${MOCK_LABEL[conditionKey]} english of ${text}`,
    });
    await insertSynthesis(t.ctx.db, {
      studyId: study.study.id,
      translationId: translation.id,
      processingBatchId: batch.id,
      conditionKey,
    });
  }
}

async function utterancesOf(sessionId: string) {
  return t.ctx.db.select().from(utterances).where(eq(utterances.sessionId, sessionId)).orderBy(asc(utterances.createdAt));
}

async function itemsOf(sessionId: string) {
  return t.ctx.db
    .select()
    .from(outputReviewItems)
    .where(eq(outputReviewItems.sessionId, sessionId))
    .orderBy(asc(outputReviewItems.presentationIndex));
}

async function expectImmutable(change: Promise<unknown>): Promise<void> {
  const error = await change.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "the direct change was accepted").not.toBeNull();
  expect(isImmutableRecordError(error), String(error)).toBe(true);
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe("output review: the whole part", () => {
  let study: TestStudy;
  let session: SessionRef;

  beforeAll(async () => {
    // The English check is off by default; this study turns it on to show that it
    // still works for a researcher who wants it.
    study = await reviewStudy({ settings: { englishCheckEnabled: true } });
    ({ session } = await sessionAfterQuestionnaires(study));
  });

  it("starts with the English check when the study turns it on: the published items in their order, without the answers", async () => {
    const state = expectStep(await getParticipantState(t.ctx, session), "english_check");
    expect(state.englishCheck.items.map((item) => item.text)).toEqual(LEXTALE_EN_ITEMS.map((item) => item.item));
    expect(JSON.stringify(state)).not.toMatch(/isWord|dummy/);
    await expectAppError(participantEnglishCheck(t.ctx, session, { answers: [true] }), "VALIDATION_ERROR");
    const next = await participantEnglishCheck(t.ctx, session, { answers: PERFECT_ENGLISH });
    expect(next.step).toBe("output_review");
    const [check] = await t.ctx.db.select().from(englishChecks).where(eq(englishChecks.sessionId, session.id));
    expect(check).toMatchObject({ wordsCorrect: 40, nonwordsCorrect: 20, score: "100.00", testVersion: "lextale-en-2011" });
    expect(check!.responsesJson).toHaveLength(63);
    // Repeating changes nothing.
    await participantEnglishCheck(t.ctx, session, { answers: LEXTALE_EN_ITEMS.map(() => false) });
    const rows = await t.ctx.db.select().from(englishChecks).where(eq(englishChecks.sessionId, session.id));
    expect(rows).toHaveLength(1);
  });

  it("waits while the recordings are processed, and never calls a model", async () => {
    const state = expectStep(await participantStartReview(t.ctx, session), "output_review");
    expect(state.review.status).toBe("preparing");
    expect(await t.ctx.db.select().from(outputReviews).where(eq(outputReviews.sessionId, session.id))).toHaveLength(0);
  });

  it("plans the review once outputs exist: one screen per own recording, nothing else", async () => {
    for (const utterance of await utterancesOf(session.id)) await addOutputs(study, utterance.id);
    const state = expectStep(await participantStartReview(t.ctx, session), "output_review");
    expect(state.review.status).toBe("ready");
    const items = await itemsOf(session.id);
    expect(new Set(items.map((item) => item.kind))).toEqual(new Set(["utterance"]));
    // At most the cap of the study settings, and never more than the recordings that are ready.
    const ready = (await utterancesOf(session.id)).length;
    expect(items).toHaveLength(Math.min(OUTPUT_REVIEW_DEFAULT_MAX_ITEMS, ready));
    for (const item of items) {
      expect(item.scaleVersion).toBe("output-review-v2");
      expect(new Set([item.leftConditionKey, item.rightConditionKey])).toEqual(new Set(["default", "preservation"]));
      expect(item.shownJson.version1).toBe(`${MOCK_LABEL[item.leftConditionKey!]} english of mä en oo ihan varma`);
      expect(item.shownJson.sourceText).toBe("mä en oo ihan varma");
    }
    const [review] = await t.ctx.db.select().from(outputReviews).where(eq(outputReviews.sessionId, session.id));
    expect(review!.status).toBe("in_progress");
    expect(review!.selectionJson).toMatchObject({ maxItems: OUTPUT_REVIEW_DEFAULT_MAX_ITEMS, chosen: expect.any(Array), algorithm: expect.any(String) });
    // The participant sees "Version 1" and "Version 2", never the condition, the model or a translation id.
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/default|preservation|condition|model|translationId/i);
    if (state.review.status === "ready") {
      expect(state.review.item.sourceText).toBe("mä en oo ihan varma");
      expect(state.review.item.versions.map((version) => version.slot)).toEqual([1, 2]);
      expect(state.review.itemNumber).toBe(1);
      expect(state.review.totalItems).toBe(items.length);
    }
  });

  it("serves the participant's own recording, and only to the owning session", async () => {
    const items = await itemsOf(session.id);
    const own = items[0]!;
    const media = await participantReviewAudio(t.ctx, session, own.id, "source");
    const [utterance] = await t.ctx.db.select().from(utterances).where(eq(utterances.id, own.utteranceId!));
    expect(media.id).toBe(utterance!.acceptedMediaAssetId);
    const other = await sessionAfterQuestionnaires(study);
    await expectAppError(participantReviewAudio(t.ctx, other.session, own.id, "source"), "NOT_FOUND");
  });

  it("takes the answers in order and stores them once", async () => {
    const items = await itemsOf(session.id);
    if (items.length > 1) {
      await expectAppError(participantAnswerReview(t.ctx, session, items[1]!.id, ownAnswer), "INVALID_STATE");
    }
    for (const item of items) {
      const state = await getParticipantState(t.ctx, session);
      expect(state.step).toBe("output_review");
      await participantAnswerReview(t.ctx, session, item.id, ownAnswer);
    }
    const answered = await itemsOf(session.id);
    expect(answered.every((item) => item.answeredAt !== null)).toBe(true);
    const first = answered[0]!;
    expect(first).toMatchObject({ choice: null, markedWordsJson: null, cantJudgeJson: ["versions.2.meaning"] });
    expect(first.ratingsJson).toEqual({
      transcript: { said: "partly" },
      versions: { "1": { meaning: 5, representation: 4 }, "2": { meaning: null, representation: 2 } },
    });
    const [review] = await t.ctx.db.select().from(outputReviews).where(eq(outputReviews.sessionId, session.id));
    expect(review).toMatchObject({ status: "completed", finishedAt: expect.any(Date) });
    // A repeated answer changes nothing.
    await participantAnswerReview(t.ctx, session, first.id, { ...ownAnswer, source: { said: "yes" } });
    const [after] = await t.ctx.db.select().from(outputReviewItems).where(eq(outputReviewItems.id, first.id));
    expect(after!.ratingsJson).toEqual(first.ratingsJson);
  });

  it("ends with the post-review questionnaire and the debrief", async () => {
    const state = expectStep(await getParticipantState(t.ctx, session), "post_review");
    expect(state.questionnaire.key).toBe("post_review");
    const debrief = await submitQuestionnaire(t.ctx, session, { key: "post_review", answers: VALID_POST_REVIEW_ANSWERS });
    expect(debrief.step).toBe("debrief");
    expect((await completeSession(t.ctx, session)).step).toBe("completed");
  });

  it("the database refuses to change an answer, a finished review or an English check, and to delete research rows", async () => {
    const [item] = await itemsOf(session.id);
    await expectImmutable(t.ctx.db.update(outputReviewItems).set({ ratingsJson: {} }).where(eq(outputReviewItems.id, item!.id)));
    await expectImmutable(t.ctx.db.update(outputReviews).set({ status: "skipped" }).where(eq(outputReviews.sessionId, session.id)));
    await expectImmutable(t.ctx.db.update(englishChecks).set({ wordsCorrect: 1 }).where(eq(englishChecks.sessionId, session.id)));
    await expectImmutable(t.ctx.db.delete(outputReviewItems).where(eq(outputReviewItems.sessionId, session.id)));
    await expectImmutable(
      t.ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL dialect.allow_test_data_reset = 'on'`);
        await tx.delete(englishChecks).where(eq(englishChecks.sessionId, session.id));
      }),
    );
  });
});

describe("output review: when it runs and when it does not", () => {
  it("is skipped when the participant did not accept the review item", async () => {
    const study = await reviewStudy();
    const { state } = await sessionAfterQuestionnaires(study, (id) => id !== "output_review");
    expect(state.step).toBe("debrief");
  });

  it("is skipped without an item of scope output_review in the consent, and when the study turns it off", async () => {
    const without = await createTestStudy(t.ctx.db, { withPostReview: true });
    expect((await sessionAfterQuestionnaires(without)).state.step).toBe("debrief");
    const off = await reviewStudy({ settings: { outputReviewEnabled: false } });
    expect((await sessionAfterQuestionnaires(off)).state.step).toBe("debrief");
  });

  it("goes straight to the review by default: the English check is off unless a study turns it on", async () => {
    const study = await reviewStudy();
    expect((await sessionAfterQuestionnaires(study)).state.step).toBe("output_review");
  });

  it("can be skipped at the English check: the part and its questionnaire are left out", async () => {
    const study = await reviewStudy({ settings: { englishCheckEnabled: true } });
    const { session } = await sessionAfterQuestionnaires(study);
    const state = await participantSkipReview(t.ctx, session);
    expect(state.step).toBe("debrief");
    const [review] = await t.ctx.db.select().from(outputReviews).where(eq(outputReviews.sessionId, session.id));
    expect(review).toMatchObject({ status: "skipped", skippedAtStep: "english_check" });
  });

  it("can be skipped in the middle; the answers given so far stay", async () => {
    const study = await reviewStudy();
    const { session } = await sessionAfterQuestionnaires(study);
    for (const utterance of await utterancesOf(session.id)) await addOutputs(study, utterance.id);
    await participantStartReview(t.ctx, session);
    const [firstScreen] = await itemsOf(session.id);
    await participantAnswerReview(t.ctx, session, firstScreen!.id, ownAnswer);
    expect((await participantSkipReview(t.ctx, session)).step).toBe("debrief");
    const [review] = await t.ctx.db.select().from(outputReviews).where(eq(outputReviews.sessionId, session.id));
    expect(review).toMatchObject({ status: "skipped", skippedAtStep: "output_review:2" });
    expect((await itemsOf(session.id))[0]!.answeredAt).not.toBeNull();
  });

  it("after the waiting time goes on with what is ready, or shows nothing when nothing is", async () => {
    const study = await reviewStudy({ settings: { outputReviewMaxItems: 5 } });
    const partly = await sessionAfterQuestionnaires(study);
    const [first] = await utterancesOf(partly.session.id);
    await addOutputs(study, first!.id);
    expect(expectStep(await participantStartReview(t.ctx, partly.session), "output_review").review.status).toBe("preparing");

    const none = await sessionAfterQuestionnaires(study);
    t.clock.advance((OUTPUT_REVIEW_MAX_WAIT_SECONDS + 1) * 1000);
    await participantStartReview(t.ctx, partly.session);
    const items = await itemsOf(partly.session.id);
    expect(items.map((item) => item.utteranceId)).toEqual([first!.id]);
    const [review] = await t.ctx.db.select().from(outputReviews).where(eq(outputReviews.sessionId, partly.session.id));
    expect(review!.selectionJson).toMatchObject({ unavailable: expect.arrayContaining([expect.objectContaining({ reason: "no_speech_recognition_yet" })]) });

    expect((await participantStartReview(t.ctx, none.session)).step).toBe("debrief");
    const [empty] = await t.ctx.db.select().from(outputReviews).where(eq(outputReviews.sessionId, none.session.id));
    expect(empty).toMatchObject({ status: "unavailable", selectionJson: expect.objectContaining({ reason: "no_recording_ready_in_time" }) });
  });

  it("refuses review actions before the review step", async () => {
    const study = await reviewStudy({ settings: { englishCheckEnabled: true } });
    const created = await createSession(t.ctx, { studySlug: study.slug });
    await expectAppError(participantStartReview(t.ctx, created.session), "INVALID_STATE");
    await expectAppError(participantSkipReview(t.ctx, created.session), "INVALID_STATE");
    await expectAppError(participantEnglishCheck(t.ctx, created.session, { answers: PERFECT_ENGLISH }), "INVALID_STATE");
  });
});

describe("output review: AI output appears only at the review step", () => {
  it("keeps every state before the review free of AI output, also when it already exists", async () => {
    const study = await reviewStudy();
    const created = await createSession(t.ctx, { studySlug: study.slug });
    const session = created.session;
    const consent = expectStep(created.state, "consent");
    const states: unknown[] = [created.state];
    states.push(await recordConsent(t.ctx, session, { responses: consent.consent.items.map((item) => ({ itemId: item.id, accepted: true })) }));
    states.push(await confirmMicCheck(t.ctx, session, {}));
    states.push(await acknowledgeInstructions(t.ctx, session));
    let state = await getParticipantState(t.ctx, session);
    for (let guard = 0; state.step === "tasks" && guard < 50; guard += 1) {
      const { answerCurrentTurn } = await import("./test-support");
      const answered = await answerCurrentTurn(t.ctx, session);
      await addOutputs(study, answered.utteranceId, "ZZ_SECRET_ASR_TEXT");
      state = await getParticipantState(t.ctx, session);
      states.push(answered.state, state);
    }
    states.push(await submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS }));
    const atReview = await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS });
    expect(atReview.step).toBe("output_review");
    for (const entry of states) {
      expect(JSON.stringify(entry)).not.toMatch(/ZZ_SECRET_ASR_TEXT|english of/);
    }
    // At the review step, after the plan exists, the participant's own output is shown.
    const review = expectStep(await participantStartReview(t.ctx, session), "output_review");
    expect(review.review.status).toBe("ready");
  });
});

describe("output review: the plan", () => {
  it("spreads the recordings across tasks, the same way for the same seed", () => {
    const candidates = [
      { utteranceId: "a1", sequenceIndex: 0, turnIndex: 0 },
      { utteranceId: "a2", sequenceIndex: 0, turnIndex: 1 },
      { utteranceId: "b1", sequenceIndex: 1, turnIndex: 0 },
      { utteranceId: "c1", sequenceIndex: 2, turnIndex: 0 },
    ];
    const order = spreadAcrossTasks(candidates, "seed-1");
    expect(order).toEqual(spreadAcrossTasks(candidates, "seed-1"));
    expect(new Set(order.slice(0, 3).map((id) => id[0]))).toEqual(new Set(["a", "b", "c"]));
    expect(order).toHaveLength(4);
  });

  it("stores random left and right placement, one screen per recording", () => {
    const output = (id: string) => ({
      utteranceId: id,
      revisionId: `r-${id}`,
      text: "x y",
      outputs: {
        default: { translationId: `d-${id}`, text: "D", synthesisId: `sd-${id}` },
        preservation: { translationId: `p-${id}`, text: "P", synthesisId: `sp-${id}` },
      },
    });
    const sides = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      const plan = planReviewItems({ orderSeed: `seed-${seed}`, chosen: [output("u1"), output("u2")] });
      expect(plan.map((item) => item.presentationIndex)).toEqual([0, 1]);
      expect(plan.map((item) => item.utteranceId)).toEqual(["u1", "u2"]);
      for (const item of plan) {
        expect(item.kind).toBe("utterance");
        sides.add(item.leftConditionKey!);
        expect(item.shownJson.version1).toBe(item.leftConditionKey === "default" ? "D" : "P");
      }
    }
    expect(sides).toEqual(new Set(["default", "preservation"]));
  });
});

describe("output review: test data reset", () => {
  it("removes the review rows of a TEST session", async () => {
    const study = await reviewStudy({ settings: { englishCheckEnabled: true } });
    const created = await createSession(t.ctx, { studySlug: study.slug, mode: "test", callerIsAdmin: true });
    const session = created.session;
    const consent = expectStep(created.state, "consent");
    await recordConsent(t.ctx, session, { responses: consent.consent.items.map((item) => ({ itemId: item.id, accepted: true })) });
    await confirmMicCheck(t.ctx, session, {});
    await acknowledgeInstructions(t.ctx, session);
    await answerAllTasks(t.ctx, session);
    await submitQuestionnaire(t.ctx, session, { key: "background", answers: VALID_BACKGROUND_ANSWERS });
    await submitQuestionnaire(t.ctx, session, { key: "post_recording", answers: VALID_POST_ANSWERS });
    await participantEnglishCheck(t.ctx, session, { answers: PERFECT_ENGLISH });
    await participantSkipReview(t.ctx, session);
    const { deleteDemoAndTestData } = await import("@dialect/db");
    const result = await t.ctx.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId: study.study.id, modes: ["test"] }));
    expect(result.deleted).toMatchObject({ english_checks: 1, output_reviews: 1 });
    expect(
      await t.ctx.db.select().from(outputReviews).where(and(eq(outputReviews.sessionId, session.id))),
    ).toHaveLength(0);
  });
});
