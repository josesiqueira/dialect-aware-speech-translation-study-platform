// Proves the guards of migration 0003_hardening_guards.sql (docs/DATA-MODEL.md,
// "Hardening rules"). Each block names the review finding it closes: the bad
// statement now fails, and the service path next to it still works.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import { getPgError, IMMUTABLE_RECORD_SQLSTATE, INVALID_STATE_SQLSTATE } from "./errors";
import {
  aiPromptVersions,
  consentVersions,
  mediaAssets,
  modelConfigs,
  processingBatches,
  protocolVersions,
  questionnaireAnswers,
  questionnaireResponses,
  questionnaireVersions,
  sessions,
  syntheses,
  taskPresentations,
  transcriptRevisions,
  transcripts,
  translations,
  utterances,
} from "./schema";
import { allowTestDataReset, deleteDemoAndTestData } from "./test-data-reset";
import { createTestDatabase, type TestDatabase } from "./testing";
import {
  insertActiveAiConfigs,
  insertConsentVersion,
  insertDraftProtocol,
  insertMediaAsset,
  insertModelRun,
  insertProcessingBatch,
  insertPublishedProtocol,
  insertQuestionnaire,
  insertSession,
  insertSessionConsent,
  insertSessionWithUtterance,
  insertStudy,
  insertSynthesis,
  insertTaskPresentation,
  insertTranscriptWithRevision,
  insertTranslation,
} from "./testing-builders";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.cleanup();
});

type Mode = "research" | "demo" | "test";

async function failure(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the statement to fail, but it succeeded");
}

async function expectImmutable(action: () => Promise<unknown>, table?: string): Promise<void> {
  const pgError = getPgError(await failure(action));
  expect(pgError?.code, pgError?.message).toBe(IMMUTABLE_RECORD_SQLSTATE);
  if (table) expect(pgError?.message).toContain(`IMMUTABLE_RECORD: ${table}: `);
}

async function expectInvalidState(action: () => Promise<unknown>, table?: string): Promise<void> {
  const pgError = getPgError(await failure(action));
  expect(pgError?.code, pgError?.message).toBe(INVALID_STATE_SQLSTATE);
  if (table) expect(pgError?.message).toContain(`INVALID_STATE: ${table}: `);
}

// Runs the action in a transaction that has the reset setting on.
function withReset<T>(action: (tx: Transaction) => Promise<T>): Promise<T> {
  return t.db.transaction(async (tx) => {
    await allowTestDataReset(tx);
    return action(tx);
  });
}

// A consented session with a submitted utterance, a questionnaire response with
// one answer, transcripts A and B, a batch, a translation and a synthesis.
async function insertFullSession(mode: Mode, studyId?: string, protocolVersionId?: string) {
  const collected = await insertSessionWithUtterance(t.db, { studyId, protocolVersionId, session: { mode } });
  const questionnaire = await insertQuestionnaire(t.db, { studyId: collected.study.id, key: `post_${collected.session.id}` });
  const [response] = await t.db
    .insert(questionnaireResponses)
    .values({ sessionId: collected.session.id, questionnaireVersionId: questionnaire.version.id })
    .returning();
  const [answer] = await t.db
    .insert(questionnaireAnswers)
    .values({ responseId: response!.id, questionnaireItemId: questionnaire.items[0]!.id, valueJson: 4 })
    .returning();
  const asr = await insertTranscriptWithRevision(t.db, { utteranceId: collected.utterance.id, type: "asr" });
  const dialect = await insertTranscriptWithRevision(t.db, { utteranceId: collected.utterance.id });
  const batch = await insertProcessingBatch(t.db, { studyId: collected.study.id, dataMode: mode, status: "completed" });
  const { translation } = await insertTranslation(t.db, {
    sourceTranscriptRevisionId: dialect.revision.id,
    processingBatchId: batch.id,
  });
  const { synthesis, media: ttsMedia } = await insertSynthesis(t.db, {
    studyId: collected.study.id,
    translationId: translation.id,
    processingBatchId: batch.id,
  });
  return { ...collected, questionnaire, response: response!, answer: answer!, asr, dialect, batch, translation, synthesis, ttsMedia };
}

// An utterance that is still open (not submitted), with one uploaded candidate.
async function insertOpenUtterance(mode: Mode) {
  const collected = await insertSessionWithUtterance(t.db, { session: { mode } });
  const presentation = await insertTaskPresentation(t.db, {
    sessionId: collected.session.id,
    protocolTaskId: collected.tasks[1]!.id,
  });
  const [open] = await t.db
    .insert(utterances)
    .values({ sessionId: collected.session.id, taskPresentationId: presentation.id, promptSnapshot: "p", turnIndex: 0 })
    .returning();
  const candidate = await insertMediaAsset(t.db, {
    studyId: collected.study.id,
    sessionId: collected.session.id,
    utteranceId: open!.id,
  });
  await t.db.update(utterances).set({ status: "uploading" }).where(eq(utterances.id, open!.id));
  return { ...collected, openPresentation: presentation, open: open!, candidate };
}

describe("finding 1: DELETE guards on collected data", () => {
  it("refuses to delete a submitted research utterance and its accepted recording in one statement", async () => {
    const { utterance, media } = await insertSessionWithUtterance(t.db);
    const statement = sql`
      WITH gone_media AS (DELETE FROM media_assets WHERE id = ${media.id} RETURNING id),
           gone_utterance AS (DELETE FROM utterances WHERE id = ${utterance.id} RETURNING id)
      SELECT (SELECT count(*) FROM gone_media), (SELECT count(*) FROM gone_utterance)`;
    await expectImmutable(() => t.db.execute(statement));
    await expectImmutable(() => withReset((tx) => tx.execute(statement)));
    expect(await t.db.select().from(utterances).where(eq(utterances.id, utterance.id))).toHaveLength(1);
    expect(await t.db.select().from(mediaAssets).where(eq(mediaAssets.id, media.id))).toHaveLength(1);
  });

  it("never deletes research rows, with or without the reset setting", async () => {
    const full = await insertFullSession("research");
    const statements: Array<[string, (db: Transaction | typeof t.db) => Promise<unknown>]> = [
      ["questionnaire_answers", (db) => db.delete(questionnaireAnswers).where(eq(questionnaireAnswers.id, full.answer.id))],
      ["questionnaire_responses", (db) => db.delete(questionnaireResponses).where(eq(questionnaireResponses.id, full.response.id))],
      ["transcripts", (db) => db.delete(transcripts).where(eq(transcripts.id, full.asr.transcript.id))],
      ["utterances", (db) => db.delete(utterances).where(eq(utterances.id, full.utterance.id))],
      ["media_assets", (db) => db.delete(mediaAssets).where(eq(mediaAssets.id, full.media.id))],
      ["task_presentations", (db) => db.delete(taskPresentations).where(eq(taskPresentations.id, full.presentation.id))],
      ["sessions", (db) => db.delete(sessions).where(eq(sessions.id, full.session.id))],
    ];
    for (const [table, statement] of statements) {
      await expectImmutable(() => statement(t.db), table);
      await expectImmutable(() => withReset((tx) => statement(tx)), table);
    }
  });

  it("deletes demo and test rows only with the reset setting", async () => {
    for (const mode of ["demo", "test"] as const) {
      const full = await insertFullSession(mode);
      await expectImmutable(() => t.db.delete(questionnaireAnswers).where(eq(questionnaireAnswers.id, full.answer.id)), "questionnaire_answers");
      await expectImmutable(() => t.db.delete(questionnaireResponses).where(eq(questionnaireResponses.id, full.response.id)), "questionnaire_responses");
      await expectImmutable(() => t.db.delete(transcripts).where(eq(transcripts.id, full.asr.transcript.id)), "transcripts");
      await expectImmutable(() => t.db.delete(utterances).where(eq(utterances.id, full.utterance.id)), "utterances");
      await expectImmutable(() => t.db.delete(mediaAssets).where(eq(mediaAssets.id, full.media.id)), "media_assets");
      await expectImmutable(() => t.db.delete(taskPresentations).where(eq(taskPresentations.id, full.presentation.id)), "task_presentations");
      await expectImmutable(() => t.db.delete(sessions).where(eq(sessions.id, full.session.id)), "sessions");
      // With the setting the answer (a leaf row) can go.
      await withReset((tx) => tx.delete(questionnaireAnswers).where(eq(questionnaireAnswers.id, full.answer.id)));
      expect(await t.db.select().from(questionnaireAnswers).where(eq(questionnaireAnswers.id, full.answer.id))).toEqual([]);
    }
  });

  it("keeps the re-record path: a candidate of an open utterance can be deleted in research mode", async () => {
    const { open, candidate } = await insertOpenUtterance("research");
    // What removeCandidateRows does: delete the row, set the utterance back to recording.
    await t.db.delete(mediaAssets).where(eq(mediaAssets.id, candidate.id));
    await t.db.update(utterances).set({ status: "recording" }).where(eq(utterances.id, open.id));
    expect(await t.db.select().from(mediaAssets).where(eq(mediaAssets.id, candidate.id))).toEqual([]);
    // What skipTurn does next: the open utterance row itself is removed.
    await t.db.delete(utterances).where(eq(utterances.id, open.id));
    expect(await t.db.select().from(utterances).where(eq(utterances.id, open.id))).toEqual([]);
  });

  it("does not treat other media rows as candidates", async () => {
    const { study, session, utterance, media, open } = await insertOpenUtterance("research");
    // A second source row on a submitted utterance.
    const extra = await insertMediaAsset(t.db, { studyId: study.id, sessionId: session.id, utteranceId: utterance.id });
    await expectImmutable(() => t.db.delete(mediaAssets).where(eq(mediaAssets.id, extra.id)), "media_assets");
    // A derived file, even on an open utterance.
    const derived = await insertMediaAsset(t.db, {
      studyId: study.id, sessionId: session.id, utteranceId: open.id, kind: "source_audio_derived", derivedFromMediaAssetId: media.id,
    });
    await expectImmutable(() => t.db.delete(mediaAssets).where(eq(mediaAssets.id, derived.id)), "media_assets");
    await expectImmutable(() => withReset((tx) => tx.delete(mediaAssets).where(eq(mediaAssets.id, derived.id))));
    // A candidate that an open utterance already points at as its accepted asset.
    const accepted = await insertMediaAsset(t.db, { studyId: study.id, sessionId: session.id, utteranceId: open.id });
    await t.db.update(utterances).set({ acceptedMediaAssetId: accepted.id }).where(eq(utterances.id, open.id));
    await expectImmutable(() => t.db.delete(mediaAssets).where(eq(mediaAssets.id, accepted.id)), "media_assets");
    // An open utterance that has an accepted asset is no longer a free row either.
    await expectImmutable(() => t.db.delete(utterances).where(eq(utterances.id, open.id)), "utterances");
  });

  it("never deletes an export archive row, and keeps the media soft delete working", async () => {
    const study = await insertStudy(t.db);
    const archive = await insertMediaAsset(t.db, {
      studyId: study.id, kind: "export_archive", entityType: "export_job", mimeType: "application/zip",
    });
    const where = eq(mediaAssets.id, archive.id);
    await expectImmutable(() => t.db.delete(mediaAssets).where(where), "media_assets");
    await expectImmutable(() => withReset((tx) => tx.delete(mediaAssets).where(where)), "media_assets");
    // The audited deletion workflow keeps the row and sets deleted_at.
    const [marked] = await t.db
      .update(mediaAssets)
      .set({ deletedAt: new Date(), metadataJson: { deletion: { reason: "retention period over" } } })
      .where(where)
      .returning();
    expect(marked?.deletedAt).not.toBeNull();
    const { media } = await insertSessionWithUtterance(t.db);
    const [source] = await t.db.update(mediaAssets).set({ deletedAt: new Date() }).where(eq(mediaAssets.id, media.id)).returning();
    expect(source?.deletedAt).not.toBeNull();
  });

  it("lets an empty demo or test session be removed, and no other session", async () => {
    const study = await insertStudy(t.db);
    const { protocol, consent } = await insertPublishedProtocol(t.db, { studyId: study.id });
    const base = { studyId: study.id, protocolVersionId: protocol.id };
    // The pipeline test removes its empty test session when the recording is unusable.
    const emptyTest = await insertSession(t.db, { ...base, mode: "test" });
    await t.db.delete(sessions).where(eq(sessions.id, emptyTest.id));
    expect(await t.db.select().from(sessions).where(eq(sessions.id, emptyTest.id))).toEqual([]);
    // A research visitor who left at the welcome step stays as a record.
    const emptyResearch = await insertSession(t.db, { ...base, mode: "research" });
    await expectImmutable(() => t.db.delete(sessions).where(eq(sessions.id, emptyResearch.id)), "sessions");
    await expectImmutable(() => withReset((tx) => tx.delete(sessions).where(eq(sessions.id, emptyResearch.id))), "sessions");
    // A demo session with a consent record needs the reset.
    const consented = await insertSession(t.db, { ...base, mode: "demo" });
    await insertSessionConsent(t.db, { sessionId: consented.id, consentVersionId: consent.id });
    await expectImmutable(() => t.db.delete(sessions).where(eq(sessions.id, consented.id)), "sessions");
  });

  it("the guarded reset removes a full demo and test session and keeps the research one", async () => {
    const research = await insertFullSession("research");
    const studyId = research.study.id;
    const test = await insertFullSession("test", studyId, research.protocol.id);
    const demo = await insertFullSession("demo", studyId, research.protocol.id);
    const result = await t.db.transaction((tx) => deleteDemoAndTestData(tx, { studyId }));
    expect(result.deleted).toMatchObject({
      sessions: 2,
      session_consents: 2,
      task_presentations: 2,
      utterances: 2,
      media_assets: 4,
      questionnaire_responses: 2,
      questionnaire_answers: 2,
      transcripts: 4,
      transcript_revisions: 4,
      translations: 2,
      syntheses: 2,
      model_runs: 4,
      processing_batches: 2,
    });
    for (const gone of [test, demo]) {
      expect(await t.db.select().from(sessions).where(eq(sessions.id, gone.session.id))).toEqual([]);
      expect(await t.db.select().from(mediaAssets).where(eq(mediaAssets.id, gone.ttsMedia.id))).toEqual([]);
    }
    expect(await t.db.select().from(sessions).where(eq(sessions.studyId, studyId))).toHaveLength(1);
    expect(await t.db.select().from(questionnaireAnswers).where(eq(questionnaireAnswers.id, research.answer.id))).toHaveLength(1);
    expect(await t.db.select().from(transcripts).where(eq(transcripts.utteranceId, research.utterance.id))).toHaveLength(2);
    expect(await t.db.select().from(syntheses).where(eq(syntheses.id, research.synthesis.id))).toHaveLength(1);
  });
});

describe("finding 2: transcripts.type and utterance_id are fixed", () => {
  it("refuses to change the type or the utterance of a transcript", async () => {
    const research = await insertFullSession("research");
    const where = eq(transcripts.id, research.dialect.transcript.id);
    await expectImmutable(() => t.db.update(transcripts).set({ type: "normalized" }).where(where), "transcripts");
    const other = await insertSessionWithUtterance(t.db);
    await expectImmutable(() => t.db.update(transcripts).set({ utteranceId: other.utterance.id }).where(where), "transcripts");
    // The review status still changes.
    const [verified] = await t.db.update(transcripts).set({ status: "verified" }).where(where).returning();
    expect(verified?.status).toBe("verified");
  });

  it("cannot move a research transcript to a test utterance to make its revisions deletable", async () => {
    const research = await insertSessionWithUtterance(t.db);
    const { transcript, revision } = await insertTranscriptWithRevision(t.db, { utteranceId: research.utterance.id });
    const test = await insertSessionWithUtterance(t.db, { session: { mode: "test" } });
    await expectImmutable(
      () => t.db.update(transcripts).set({ utteranceId: test.utterance.id }).where(eq(transcripts.id, transcript.id)),
      "transcripts",
    );
    await expectImmutable(() =>
      withReset(async (tx) => {
        await tx.delete(transcriptRevisions).where(eq(transcriptRevisions.id, revision.id));
      }),
    );
    expect(await t.db.select().from(transcriptRevisions).where(eq(transcriptRevisions.id, revision.id))).toHaveLength(1);
  });
});

describe("finding 3: verification is set once, and a superseded revision stays superseded", () => {
  it("lets verification be recorded once and then refuses any change", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const { revision } = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id });
    const where = eq(transcriptRevisions.id, revision.id);
    const verifiedAt = new Date("2026-10-01T10:00:00Z");
    const [verified] = await t.db
      .update(transcriptRevisions)
      .set({ verifiedAt, verifiedByLabel: "JS", verificationNotes: "checked against the audio" })
      .where(where)
      .returning();
    expect(verified?.verifiedAt).toEqual(verifiedAt);
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ verifiedAt: new Date() }).where(where), "transcript_revisions");
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ verifiedAt: null }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ verifiedByLabel: "someone else" }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ verifiedByLabel: null }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ verificationNotes: "rewritten" }).where(where));
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ verificationNotes: null }).where(where));
  });

  it("refuses notes or a label added after verification, when verification left them empty", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const { revision } = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id });
    const where = eq(transcriptRevisions.id, revision.id);
    await t.db.update(transcriptRevisions).set({ verifiedAt: new Date(), verifiedByLabel: "JS" }).where(where);
    await expectImmutable(() => t.db.update(transcriptRevisions).set({ verificationNotes: "added later" }).where(where));
  });

  it("supersedes the current revision, and never makes an old revision current again", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const first = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id });
    // The service sequence: switch the old revision off, insert the new one.
    const second = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id, text: "second" });
    const rows = await t.db.select().from(transcriptRevisions).where(eq(transcriptRevisions.transcriptId, first.transcript.id));
    expect(rows.filter((row) => row.isCurrent).map((row) => row.id)).toEqual([second.revision.id]);
    await t.db.update(transcriptRevisions).set({ isCurrent: false }).where(eq(transcriptRevisions.id, second.revision.id));
    await expectImmutable(
      () => t.db.update(transcriptRevisions).set({ isCurrent: true }).where(eq(transcriptRevisions.id, first.revision.id)),
      "transcript_revisions",
    );
  });
});

describe("finding 4: final records of utterances, sessions and batches", () => {
  it("freezes attempt_count and duration_ms of a submitted utterance", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const where = eq(utterances.id, utterance.id);
    await expectImmutable(() => t.db.update(utterances).set({ attemptCount: 9 }).where(where), "utterances");
    await expectImmutable(() => t.db.update(utterances).set({ durationMs: 1 }).where(where), "utterances");
    // Curation still works.
    const [flagged] = await t.db.update(utterances).set({ flagged: true, flagNotes: "check" }).where(where).returning();
    expect(flagged?.flagged).toBe(true);
  });

  it("fixes the session and presentation of an utterance from the start", async () => {
    const { open } = await insertOpenUtterance("research");
    const other = await insertSessionWithUtterance(t.db, { session: { mode: "test" } });
    await expectImmutable(
      () => t.db.update(utterances).set({ sessionId: other.session.id, taskPresentationId: other.presentation.id, turnIndex: 5 }).where(eq(utterances.id, open.id)),
      "utterances",
    );
  });

  it("makes the session timestamps set-once", async () => {
    const study = await insertStudy(t.db);
    const { protocol } = await insertPublishedProtocol(t.db, { studyId: study.id });
    const session = await insertSession(t.db, { studyId: study.id, protocolVersionId: protocol.id });
    const where = eq(sessions.id, session.id);
    const at = new Date("2026-10-01T10:00:00Z");
    // The service path: each step sets its timestamp once.
    await t.db.update(sessions).set({ status: "consented", consentedAt: at, lastActivityAt: at }).where(where);
    await t.db.update(sessions).set({ status: "completed", completedAt: at, lastActivityAt: at }).where(where);
    await expectImmutable(() => t.db.update(sessions).set({ startedAt: new Date(0) }).where(where), "sessions");
    await expectImmutable(() => t.db.update(sessions).set({ consentedAt: new Date() }).where(where), "sessions");
    await expectImmutable(() => t.db.update(sessions).set({ consentedAt: null }).where(where));
    await expectImmutable(() => t.db.update(sessions).set({ completedAt: new Date() }).where(where));
    await expectImmutable(() => t.db.update(sessions).set({ completedAt: null }).where(where));

    const withdrawn = await insertSession(t.db, { studyId: study.id, protocolVersionId: protocol.id });
    const abandoned = await insertSession(t.db, { studyId: study.id, protocolVersionId: protocol.id });
    await t.db.update(sessions).set({ status: "withdrawn", withdrawnAt: at }).where(eq(sessions.id, withdrawn.id));
    await t.db.update(sessions).set({ status: "abandoned", abandonedAt: at }).where(eq(sessions.id, abandoned.id));
    await expectImmutable(() => t.db.update(sessions).set({ withdrawnAt: new Date() }).where(eq(sessions.id, withdrawn.id)));
    await expectImmutable(() => t.db.update(sessions).set({ abandonedAt: null }).where(eq(sessions.id, abandoned.id)));
    // Activity time, flags and exclusion still change.
    await t.db.update(sessions).set({ lastActivityAt: new Date(), flagged: true, excluded: true, exclusionReason: "pilot" }).where(where);
  });

  it("allows the batch status moves of the batch service, including retry of failed jobs", async () => {
    const study = await insertStudy(t.db);
    const batch = await insertProcessingBatch(t.db, { studyId: study.id });
    const where = eq(processingBatches.id, batch.id);
    const move = async (values: Partial<typeof processingBatches.$inferInsert>) => {
      const [row] = await t.db.update(processingBatches).set(values).where(where).returning();
      return row!;
    };
    const now = new Date();
    await move({ status: "queued", startedAt: now }); // startBatch
    await move({ status: "running", completedAt: null }); // refreshBatchStatus
    await move({ status: "completed_with_errors", completedAt: now }); // refreshBatchStatus
    await move({ status: "running", completedAt: null }); // retryFailedJobs
    const done = await move({ status: "completed", completedAt: new Date() }); // refreshBatchStatus
    expect(done.status).toBe("completed");
    await move({ status: "completed_with_errors", completedAt: new Date() }); // a later failed stage of a synchronous batch
    await move({ status: "completed", completedAt: new Date() });
  });

  it("refuses batch status moves the service never makes, and freezes name and started_at", async () => {
    const study = await insertStudy(t.db);
    const batch = await insertProcessingBatch(t.db, { studyId: study.id, status: "completed", startedAt: new Date(), completedAt: new Date() });
    const where = eq(processingBatches.id, batch.id);
    await expectImmutable(() => t.db.update(processingBatches).set({ status: "queued" }).where(where), "processing_batches");
    await expectImmutable(() => t.db.update(processingBatches).set({ status: "cancelled", cancelledAt: new Date() }).where(where));
    await expectImmutable(() => t.db.update(processingBatches).set({ status: "draft" }).where(where));
    await expectImmutable(() => t.db.update(processingBatches).set({ name: "renamed" }).where(where));
    await expectImmutable(() => t.db.update(processingBatches).set({ startedAt: new Date(0) }).where(where));
    await expectImmutable(() => t.db.update(processingBatches).set({ startedAt: null }).where(where));
    // completed_at of a research batch only changes together with the status.
    await expectImmutable(() => t.db.update(processingBatches).set({ completedAt: new Date(0) }).where(where));
    // A synchronous demo batch is finished again after every run, with a new time.
    const demoBatch = await insertProcessingBatch(t.db, { studyId: study.id, dataMode: "demo", status: "completed", startedAt: new Date(), completedAt: new Date(0) });
    await t.db.update(processingBatches).set({ status: "completed", completedAt: new Date() }).where(eq(processingBatches.id, demoBatch.id));

    const running = await insertProcessingBatch(t.db, { studyId: study.id, status: "running", startedAt: new Date() });
    await expectImmutable(() => t.db.update(processingBatches).set({ status: "queued" }).where(eq(processingBatches.id, running.id)));
  });

  it("freezes a cancelled batch completely", async () => {
    const study = await insertStudy(t.db);
    const batch = await insertProcessingBatch(t.db, { studyId: study.id });
    const where = eq(processingBatches.id, batch.id);
    await t.db.update(processingBatches).set({ status: "queued", startedAt: new Date() }).where(where);
    await t.db.update(processingBatches).set({ status: "cancelled", cancelledAt: new Date() }).where(where); // cancelBatch
    await expectImmutable(() => t.db.update(processingBatches).set({ status: "running" }).where(where), "processing_batches");
    await expectImmutable(() => t.db.update(processingBatches).set({ status: "completed", completedAt: new Date() }).where(where));
    await expectImmutable(() => t.db.update(processingBatches).set({ cancelledAt: new Date(0) }).where(where));
    await expectImmutable(() => t.db.update(processingBatches).set({ description: "rewritten" }).where(where));
  });

  it("fixes data_mode and study of a batch from the start, also for a draft", async () => {
    const study = await insertStudy(t.db);
    const other = await insertStudy(t.db);
    const batch = await insertProcessingBatch(t.db, { studyId: study.id });
    const where = eq(processingBatches.id, batch.id);
    await expectImmutable(() => t.db.update(processingBatches).set({ dataMode: "test" }).where(where), "processing_batches");
    await expectImmutable(() => t.db.update(processingBatches).set({ studyId: other.id }).where(where));
    await t.db.update(processingBatches).set({ name: "renamed draft", description: "still a draft" }).where(where);
  });
});

describe("finding 5: randomization metadata", () => {
  it("is fixed at insert", async () => {
    const { session, tasks } = await insertSessionWithUtterance(t.db);
    const presentation = await insertTaskPresentation(t.db, {
      sessionId: session.id,
      protocolTaskId: tasks[1]!.id,
      randomizationMetadataJson: { blockKey: "semi_structured", orderMode: "fixed" } as never,
    });
    const where = eq(taskPresentations.id, presentation.id);
    await expectImmutable(
      () => t.db.update(taskPresentations).set({ randomizationMetadataJson: { blockKey: "other" } as never }).where(where),
      "task_presentations",
    );
    await expectImmutable(() => t.db.update(taskPresentations).set({ randomizationMetadataJson: null }).where(where));
    const [started] = await t.db.update(taskPresentations).set({ status: "started", startedAt: new Date() }).where(where).returning();
    expect(started?.status).toBe("started");
  });
});

describe("finding 6: collected rows cannot reference drafts", () => {
  it("refuses a session on a draft protocol version", async () => {
    const study = await insertStudy(t.db);
    const consent = await insertConsentVersion(t.db, { studyId: study.id });
    const draft = await insertDraftProtocol(t.db, { studyId: study.id, consentVersionId: consent.id });
    await expectInvalidState(() => insertSession(t.db, { studyId: study.id, protocolVersionId: draft.protocol.id }), "sessions");
    await expectInvalidState(() => insertSession(t.db, { studyId: study.id, protocolVersionId: draft.protocol.id, mode: "test" }));
    // Published, and later retired, versions are accepted.
    await t.db.update(protocolVersions).set({ status: "published", publishedAt: new Date() }).where(eq(protocolVersions.id, draft.protocol.id));
    const session = await insertSession(t.db, { studyId: study.id, protocolVersionId: draft.protocol.id });
    await t.db.update(protocolVersions).set({ status: "retired", retiredAt: new Date() }).where(eq(protocolVersions.id, draft.protocol.id));
    await t.db.update(sessions).set({ status: "consented", consentedAt: new Date() }).where(eq(sessions.id, session.id));
  });

  it("refuses a consent record on a draft consent version", async () => {
    const study = await insertStudy(t.db);
    const { protocol } = await insertPublishedProtocol(t.db, { studyId: study.id });
    const session = await insertSession(t.db, { studyId: study.id, protocolVersionId: protocol.id });
    const draft = await insertConsentVersion(t.db, { studyId: study.id, publishedAt: null });
    await expectInvalidState(() => insertSessionConsent(t.db, { sessionId: session.id, consentVersionId: draft.id }), "session_consents");
    await t.db.update(consentVersions).set({ publishedAt: new Date() }).where(eq(consentVersions.id, draft.id));
    await insertSessionConsent(t.db, { sessionId: session.id, consentVersionId: draft.id });
  });

  it("refuses a questionnaire response on a draft questionnaire version", async () => {
    const { study, session } = await insertSessionWithUtterance(t.db);
    const draft = await insertQuestionnaire(t.db, { studyId: study.id, status: "draft" });
    const values = { sessionId: session.id, questionnaireVersionId: draft.version.id };
    await expectInvalidState(() => t.db.insert(questionnaireResponses).values(values), "questionnaire_responses");
    await t.db.update(questionnaireVersions).set({ status: "published", publishedAt: new Date() }).where(eq(questionnaireVersions.id, draft.version.id));
    await t.db.insert(questionnaireResponses).values(values);
  });

  it("keeps a stored questionnaire response and its answers unchanged", async () => {
    const full = await insertFullSession("research");
    const other = await insertSessionWithUtterance(t.db, { session: { mode: "test" } });
    await expectImmutable(
      () => t.db.update(questionnaireResponses).set({ sessionId: other.session.id }).where(eq(questionnaireResponses.id, full.response.id)),
      "questionnaire_responses",
    );
    await expectImmutable(
      () => t.db.update(questionnaireAnswers).set({ valueJson: 1 }).where(eq(questionnaireAnswers.id, full.answer.id)),
      "questionnaire_answers",
    );
  });

  it("refuses a model run on a draft config or a draft prompt, and accepts active and retired ones", async () => {
    const { study, utterance } = await insertSessionWithUtterance(t.db);
    const active = await insertActiveAiConfigs(t.db, { studyId: study.id });
    const [draftPrompt] = await t.db
      .insert(aiPromptVersions)
      .values({ studyId: study.id, key: "translation_default", stage: "translation", versionNumber: 2, name: "draft", promptText: "x" })
      .returning();
    const [draftConfig] = await t.db
      .insert(modelConfigs)
      .values({ studyId: study.id, key: "translation_default", stage: "translation", versionNumber: 2, provider: "mock", modelId: "m" })
      .returning();
    const source = { sourceEntityType: "utterance", sourceEntityId: utterance.id };
    await expectInvalidState(() => insertModelRun(t.db, { ...source, modelConfigId: draftConfig!.id }), "model_runs");
    await expectInvalidState(() => insertModelRun(t.db, { ...source, promptVersionId: draftPrompt!.id }), "model_runs");
    // A running run cannot be pointed at a draft afterwards.
    const run = await insertModelRun(t.db, { ...source, modelConfigId: active.configs.translationDefault.id });
    await expectInvalidState(() =>
      t.db.execute(sql`UPDATE model_runs SET model_config_id = ${draftConfig!.id} WHERE id = ${run.id}`),
    );
    // The reserved mock configs of Demo Mode are stored as retired: accepted.
    const [retiredConfig] = await t.db
      .insert(modelConfigs)
      .values({
        studyId: study.id, key: "demo_mock_translation", stage: "translation", versionNumber: 1, provider: "mock", modelId: "m",
        status: "retired", retiredAt: new Date(),
      })
      .returning();
    await insertModelRun(t.db, { ...source, modelConfigId: retiredConfig!.id });
    await insertModelRun(t.db, { ...source, modelConfigId: active.configs.asrDefault.id, promptVersionId: active.prompts.asrContext.id });
    // A run without a config (an ad hoc run) is still accepted.
    await insertModelRun(t.db, source);
  });
});

describe("finding 7: outputs match the mode of their batch, and the author type matches the transcript type", () => {
  it("refuses a translation whose source session mode differs from the batch data_mode", async () => {
    const test = await insertSessionWithUtterance(t.db, { session: { mode: "test" } });
    const { revision } = await insertTranscriptWithRevision(t.db, { utteranceId: test.utterance.id });
    const researchBatch = await insertProcessingBatch(t.db, { studyId: test.study.id, status: "running" });
    await expectInvalidState(
      () => insertTranslation(t.db, { sourceTranscriptRevisionId: revision.id, processingBatchId: researchBatch.id }),
      "translations",
    );
    const research = await insertSessionWithUtterance(t.db);
    const researchRevision = await insertTranscriptWithRevision(t.db, { utteranceId: research.utterance.id });
    const testBatch = await insertProcessingBatch(t.db, { studyId: research.study.id, dataMode: "test", status: "running" });
    await expectInvalidState(() =>
      insertTranslation(t.db, { sourceTranscriptRevisionId: researchRevision.revision.id, processingBatchId: testBatch.id }),
    );
    // Matching modes are accepted.
    const ownBatch = await insertProcessingBatch(t.db, { studyId: test.study.id, dataMode: "test", status: "running" });
    await insertTranslation(t.db, { sourceTranscriptRevisionId: revision.id, processingBatchId: ownBatch.id });
  });

  it("refuses a synthesis whose translation comes from a session of another mode than its batch", async () => {
    const full = await insertFullSession("test");
    const researchBatch = await insertProcessingBatch(t.db, { studyId: full.study.id, status: "running" });
    await expectInvalidState(
      () => insertSynthesis(t.db, { studyId: full.study.id, translationId: full.translation.id, processingBatchId: researchBatch.id }),
      "syntheses",
    );
    await insertSynthesis(t.db, {
      studyId: full.study.id, translationId: full.translation.id, processingBatchId: full.batch.id, repetitionIndex: 1,
    });
  });

  it("accepts model revisions only on the asr transcript, and only model revisions there", async () => {
    const { utterance } = await insertSessionWithUtterance(t.db);
    const dialect = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id });
    const asr = await insertTranscriptWithRevision(t.db, { utteranceId: utterance.id, type: "asr" });
    expect(asr.revision.createdByType).toBe("model");
    await expectInvalidState(
      () => t.db.insert(transcriptRevisions).values({
        transcriptId: dialect.transcript.id, revisionNumber: 2, text: "model text", createdByType: "model", isCurrent: false,
      }),
      "transcript_revisions",
    );
    for (const createdByType of ["researcher", "system"] as const) {
      await expectInvalidState(
        () => t.db.insert(transcriptRevisions).values({
          transcriptId: asr.transcript.id, revisionNumber: 2, text: "human text", createdByType, isCurrent: false,
        }),
        "transcript_revisions",
      );
    }
    await t.db.insert(transcriptRevisions).values({
      transcriptId: dialect.transcript.id, revisionNumber: 2, text: "imported", createdByType: "system", isCurrent: false,
    });
  });
});

describe("finding 8: guard functions have a fixed search_path", () => {
  it("sets search_path on every dialect function", async () => {
    const result = await t.db.execute<{ proname: string; config: string[] | null }>(sql`
      SELECT p.proname, p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'dialect\_%'
      ORDER BY p.proname`);
    expect(result.rows.length).toBeGreaterThan(30);
    const missing = result.rows.filter((row) => !(row.config ?? []).some((entry) => entry.startsWith("search_path=pg_catalog, public")));
    expect(missing.map((row) => row.proname)).toEqual([]);
  });

  it("is not fooled by temporary tables with the names of the real tables", async () => {
    const research = await insertFullSession("research");
    await expectImmutable(() =>
      t.db.transaction(async (tx) => {
        await allowTestDataReset(tx);
        // Empty look-alike tables: a mode lookup through them would find nothing.
        for (const table of ["sessions", "utterances", "transcripts", "transcript_revisions", "translations", "processing_batches"]) {
          await tx.execute(sql.raw(`CREATE TEMP TABLE ${table} (LIKE public.${table}) ON COMMIT DROP`));
        }
        await tx.execute(sql`DELETE FROM public.syntheses WHERE id = ${research.synthesis.id}`);
      }),
      "syntheses",
    );
    await expectImmutable(() =>
      t.db.transaction(async (tx) => {
        await allowTestDataReset(tx);
        for (const table of ["sessions", "utterances", "transcripts"]) {
          await tx.execute(sql.raw(`CREATE TEMP TABLE ${table} (LIKE public.${table}) ON COMMIT DROP`));
        }
        await tx.execute(sql`DELETE FROM public.transcript_revisions WHERE id = ${research.dialect.revision.id}`);
      }),
      "transcript_revisions",
    );
  });
});

const TRUNCATE_GUARDED_TABLES = [
  "admin_audit_log",
  "ai_prompt_versions",
  "consent_versions",
  "difference_annotations",
  "export_jobs",
  "feature_annotations",
  "media_assets",
  "model_configs",
  "model_runs",
  "processing_batches",
  "protocol_task_followups",
  "protocol_tasks",
  "protocol_versions",
  "questionnaire_answers",
  "questionnaire_items",
  "questionnaire_responses",
  "questionnaire_versions",
  "research_flags",
  "research_notes",
  "session_consents",
  "sessions",
  "studies",
  "syntheses",
  "task_presentations",
  "transcript_revisions",
  "transcripts",
  "translations",
  "utterances",
];

describe("finding 9: TRUNCATE", () => {
  it("is refused on every table that holds study or audit records", async () => {
    await insertFullSession("research");
    await expectImmutable(() => t.db.execute(sql`TRUNCATE translations CASCADE`), "translations");
    await expectImmutable(() => t.db.execute(sql`TRUNCATE admin_audit_log`), "admin_audit_log");
    for (const table of TRUNCATE_GUARDED_TABLES) {
      await expectImmutable(() => t.db.execute(sql.raw(`TRUNCATE ${table} CASCADE`)));
      await expectImmutable(() => withReset((tx) => tx.execute(sql.raw(`TRUNCATE ${table} CASCADE`))));
    }
    expect(await t.db.select().from(translations)).not.toEqual([]);
  });

  it("covers every table except the operational ones", async () => {
    const result = await t.db.execute<{ table_name: string }>(sql`
      SELECT c.relname AS table_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (
          SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'dialect_05_no_truncate')
      ORDER BY c.relname`);
    expect(result.rows.map((row) => row.table_name)).toEqual(["jobs", "rate_limit_hits", "worker_heartbeats"]);
    // The operational tables can still be emptied.
    await t.db.execute(sql`TRUNCATE rate_limit_hits, worker_heartbeats`);
  });
});
