// The twelve scientific invariants of spec 110, tested at the service level.
// One describe per invariant, numbered as in the specification. Each test goes
// through the services first and, where a database trigger is the safety net,
// through a direct update second.
//
// The shared world (built once in beforeAll, through the services of scenario.ts):
// a study with a published protocol, one completed research session whose four
// recordings went through automatic ASR, human review of B and C, and a
// completed processing batch ("batch one") with the full matrix.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderRegistry } from "@dialect/ai";
import {
  consentVersions,
  isImmutableRecordError,
  isUniqueViolation,
  mediaAssets,
  modelRuns,
  processingBatches,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireItems,
  sessions as sessionRows,
  syntheses,
  taskPresentations,
  transcriptRevisions,
  transcripts as transcriptRows,
  translations,
  utterances,
  type DbOrTx,
} from "@dialect/db";
import { sha256OfBuffer, storageConfigFromEnv } from "@dialect/storage";
import * as aiConfig from "../ai-config";
import { silentLogger, type Logger, type ServiceContext } from "../context";
import * as corpus from "../corpus";
import * as exportsArea from "../exports";
import { csvObjects, streamToBuffer } from "../exports/test-helpers";
import type * as Queue from "../jobs/queue";
import * as processing from "../processing";
import * as protocols from "../protocols";
import * as questionnaires from "../questionnaires";
import * as sessions from "../sessions";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import * as transcripts from "../transcripts";
import {
  activateMockConfig,
  buildExportArchive,
  deepKeysAndStrings,
  drainQueue,
  finishSession,
  jobsOf,
  mediaRow,
  recordCurrentTurn,
  recording,
  reviewUtterance,
  runSession,
  setupStudy,
  storedBytes,
  utteranceRow,
  type ParticipantState,
  type ReviewedUtterance,
  type ScenarioStudy,
  type SessionRun,
} from "./scenario";

// Invariant 8 makes job enqueueing fail. The queue module is replaced so that
// enqueueJob throws while the switch is on, and behaves normally otherwise.
const queueSwitch = vi.hoisted(() => ({ failing: false }));
vi.mock("../jobs/queue", async (importOriginal) => {
  const original = await importOriginal<typeof Queue>();
  return {
    ...original,
    enqueueJob: async (dbOrTx: DbOrTx, input: Queue.EnqueueJobInput) => {
      if (queueSwitch.failing) throw new Error("the queue is not available");
      return original.enqueueJob(dbOrTx, input);
    },
  };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

// Each test drives whole scenarios (sessions, queue, batches, exports) against
// a database. The default of 5 seconds per test is too
// short when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestServiceContext;
let db: TestServiceContext["testDb"]["db"];
let study: ScenarioStudy;
let main: SessionRun;
const reviewed = new Map<string, ReviewedUtterance>();
let batchOne: processing.BatchDetail;

async function expectImmutable(change: Promise<unknown>): Promise<void> {
  const error = await change.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "the direct change was accepted").not.toBeNull();
  expect(isImmutableRecordError(error), String(error)).toBe(true);
}

async function translationsOfBatch(batchId: string) {
  return db.select().from(translations).where(eq(translations.processingBatchId, batchId)).orderBy(asc(translations.id));
}
async function synthesesOfBatch(batchId: string) {
  return db.select().from(syntheses).where(eq(syntheses.processingBatchId, batchId)).orderBy(asc(syntheses.id));
}
async function runsOfBatch(batchId: string) {
  return db.select().from(modelRuns).where(eq(modelRuns.processingBatchId, batchId)).orderBy(asc(modelRuns.id));
}
async function revisionsOfUtterance(utteranceId: string, type: (typeof transcriptRows.$inferSelect)["type"]) {
  return db
    .select({ revision: transcriptRevisions })
    .from(transcriptRevisions)
    .innerJoin(transcriptRows, eq(transcriptRows.id, transcriptRevisions.transcriptId))
    .where(and(eq(transcriptRows.utteranceId, utteranceId), eq(transcriptRows.type, type)))
    .orderBy(asc(transcriptRevisions.revisionNumber))
    .then((rows) => rows.map((row) => row.revision));
}

beforeAll(async () => {
  t = await createTestServiceContext();
  db = t.testDb.db;
  study = await setupStudy(t);
  main = await runSession(t.ctx, study.slug);
  await drainQueue(t.ctx);
  for (const [index, turn] of main.turns.entries()) {
    reviewed.set(
      turn.utteranceId,
      await reviewUtterance(t.adminCtx, turn.utteranceId, {
        b: `Mie en tiiä, lausuma ${index + 1}.`,
        c: `Minä en tiedä, lausuma ${index + 1}.`,
      }),
    );
  }
  const created = await processing.createBatch(t.adminCtx, { studyId: study.study.id, name: "batch one" });
  await processing.startBatch(t.adminCtx, created.id);
  await drainQueue(t.ctx);
  batchOne = await processing.getBatch(t.adminCtx, created.id);
  expect(batchOne).toMatchObject({ status: "completed", outputCounts: { translations: 24, syntheses: 24 } });
}, 120_000);

afterAll(async () => {
  await t.cleanup();
});

describe("1. a published protocol never mutates", () => {
  it("refuses every service call that would change the published protocol, its consent or its questionnaires", async () => {
    const { protocol, tasks } = study.protocol;
    const task = tasks[1]!;
    const followup = task.followups[0]!;
    const refused = { code: "IMMUTABLE_RECORD" };
    await expect(protocols.updateProtocolDraft(t.adminCtx, protocol.id, { welcomeContent: "Changed." })).rejects.toMatchObject(refused);
    await expect(protocols.updateTask(t.adminCtx, task.id, { participantPrompt: "Changed." })).rejects.toMatchObject(refused);
    await expect(protocols.setTaskEnabled(t.adminCtx, task.id, false)).rejects.toMatchObject(refused);
    await expect(protocols.deleteTask(t.adminCtx, task.id)).rejects.toMatchObject(refused);
    await expect(protocols.moveTask(t.adminCtx, task.id, "up")).rejects.toMatchObject(refused);
    await expect(
      protocols.addTask(t.adminCtx, protocol.id, { taskType: "controlled", blockKey: "controlled", title: "New" }),
    ).rejects.toMatchObject(refused);
    await expect(protocols.addFollowup(t.adminCtx, task.id, { promptText: "New follow-up?" })).rejects.toMatchObject(refused);
    await expect(protocols.updateFollowup(t.adminCtx, followup.id, { promptText: "Changed?" })).rejects.toMatchObject(refused);
    await expect(protocols.deleteFollowup(t.adminCtx, followup.id)).rejects.toMatchObject(refused);
    await expect(protocols.deleteProtocolDraft(t.adminCtx, protocol.id)).rejects.toMatchObject(refused);
    await expect(protocols.updateConsentDraft(t.adminCtx, study.consent.id, { title: "Changed" })).rejects.toMatchObject(refused);
    await expect(protocols.deleteConsentDraft(t.adminCtx, study.consent.id)).rejects.toMatchObject(refused);
    const background = await questionnaires.getQuestionnaireVersion(t.adminCtx, study.backgroundVersionId);
    await expect(
      questionnaires.updateItem(t.adminCtx, background.items[0]!.id, { prompt: "Changed?" }),
    ).rejects.toMatchObject(refused);
    await expect(
      questionnaires.addItem(t.adminCtx, background.id, { type: "boolean", prompt: "New item?" }),
    ).rejects.toMatchObject(refused);
    await expect(questionnaires.deleteItem(t.adminCtx, background.items[0]!.id)).rejects.toMatchObject(refused);
    await expect(questionnaires.deleteQuestionnaireDraft(t.adminCtx, background.id)).rejects.toMatchObject(refused);

    // Nothing changed.
    const after = await protocols.getProtocolVersion(t.adminCtx, protocol.id);
    expect(after.protocol).toEqual(protocol);
    expect(after.tasks).toEqual(tasks);
    expect(await questionnaires.getQuestionnaireVersion(t.adminCtx, background.id)).toEqual(background);
  });

  it("refuses direct updates and deletes of the published rows", async () => {
    const { protocol, tasks } = study.protocol;
    const task = tasks[0]!;
    const followup = tasks[1]!.followups[0]!;
    await expectImmutable(db.update(protocolVersions).set({ welcomeContent: "Changed." }).where(eq(protocolVersions.id, protocol.id)));
    await expectImmutable(db.update(protocolVersions).set({ status: "draft" }).where(eq(protocolVersions.id, protocol.id)));
    await expectImmutable(db.update(protocolTasks).set({ participantPrompt: "Changed." }).where(eq(protocolTasks.id, task.id)));
    await expectImmutable(db.delete(protocolTasks).where(eq(protocolTasks.id, task.id)));
    await expectImmutable(
      db.update(protocolTaskFollowups).set({ promptText: "Changed?" }).where(eq(protocolTaskFollowups.id, followup.id)),
    );
    await expectImmutable(db.update(consentVersions).set({ title: "Changed" }).where(eq(consentVersions.id, study.consent.id)));
    await expectImmutable(
      db
        .update(questionnaireItems)
        .set({ prompt: "Changed?" })
        .where(eq(questionnaireItems.questionnaireVersionId, study.backgroundVersionId)),
    );
    // What the participant of the completed session saw cannot be rewritten either.
    await expectImmutable(
      db
        .update(taskPresentations)
        .set({ promptSnapshot: "Changed." })
        .where(eq(taskPresentations.id, main.turns[0]!.presentationId)),
    );
  });

  it("keeps a session that started earlier on its version and its prompt snapshots after a new version is published", async () => {
    // A participant starts under version 1 and records the first turn.
    const early = await runSession(t.ctx, study.slug, { until: "consent" });
    await sessions.confirmMicCheck(t.ctx, early.session, {});
    await sessions.acknowledgeInstructions(t.ctx, early.session);
    const first = await recordCurrentTurn(t.ctx, early.session);
    const snapshotsBefore = await db
      .select()
      .from(taskPresentations)
      .where(eq(taskPresentations.sessionId, early.session.id))
      .orderBy(asc(taskPresentations.sequenceIndex));
    const versionOneBefore = await protocols.getProtocolVersion(t.adminCtx, study.protocol.protocol.id);

    // The researcher publishes version 2 with other prompt texts.
    const draft = await protocols.cloneProtocolVersion(t.adminCtx, study.protocol.protocol.id);
    for (const task of draft.tasks) {
      await protocols.updateTask(t.adminCtx, task.id, { participantPrompt: `VERSION TWO: ${task.participantPrompt}` });
      for (const followup of task.followups) {
        await protocols.updateFollowup(t.adminCtx, followup.id, { promptText: `VERSION TWO: ${followup.promptText}` });
      }
    }
    const published = await protocols.publishProtocol(t.adminCtx, draft.protocol.id);
    expect(published.protocol.protocol).toMatchObject({ versionNumber: 2, status: "published", isCurrent: true });

    // Version 1 is unchanged, apart from no longer being the current version.
    const versionOneAfter = await protocols.getProtocolVersion(t.adminCtx, study.protocol.protocol.id);
    expect(versionOneAfter.tasks).toEqual(versionOneBefore.tasks);
    expect({ ...versionOneAfter.protocol, isCurrent: true }).toEqual(versionOneBefore.protocol);

    // The early session continues with exactly the texts of version 1.
    expect(
      await db
        .select()
        .from(taskPresentations)
        .where(eq(taskPresentations.sessionId, early.session.id))
        .orderBy(asc(taskPresentations.sequenceIndex))
        .then((rows) => rows.map((row) => ({ ...row, status: null, startedAt: null, completedAt: null }))),
    ).toEqual(snapshotsBefore.map((row) => ({ ...row, status: null, startedAt: null, completedAt: null })));
    const prompts = [first.turn.promptText];
    for (let state = first.state; state.step === "tasks"; ) {
      const next = await recordCurrentTurn(t.ctx, early.session);
      prompts.push(next.turn.promptText);
      state = next.state;
    }
    expect(prompts).toEqual(main.turns.map((turn) => turn.promptText));
    expect(prompts.some((prompt) => prompt.includes("VERSION TWO"))).toBe(false);
    const [earlyRow] = await db.select().from(sessionRows).where(eq(sessionRows.id, early.session.id));
    expect(earlyRow!.protocolVersionId).toBe(study.protocol.protocol.id);
    await expectImmutable(
      db.update(sessionRows).set({ protocolVersionId: draft.protocol.id }).where(eq(sessionRows.id, early.session.id)),
    );

    // A new session receives version 2.
    const late = await runSession(t.ctx, study.slug, { until: "tasks" });
    expect(late.session.protocolVersionId).toBe(draft.protocol.id);
    expect(late.turns.every((turn) => turn.promptText.startsWith("VERSION TWO: "))).toBe(true);
    // Leave no automatic ASR job behind for the later tests.
    await drainQueue(t.ctx);
  });
});

describe("2. a stored source recording never mutates", () => {
  it("refuses to replace, discard or re-submit an accepted recording", async () => {
    const run = await runSession(t.ctx, study.slug, { until: "consent" });
    await sessions.confirmMicCheck(t.ctx, run.session, {});
    await sessions.acknowledgeInstructions(t.ctx, run.session);
    const { turn } = await recordCurrentTurn(t.ctx, run.session);
    const before = await mediaRow(t.ctx, turn.mediaAssetId);

    // The session is still recording, so the refusals are about the utterance, not the session.
    expect((await sessions.getParticipantState(t.ctx, run.session)).step).toBe("tasks");
    await expect(
      sessions.uploadUtteranceAudio(t.ctx, run.session, { utteranceId: turn.utteranceId, data: recording(), declaredMimeType: "audio/wav" }),
    ).rejects.toMatchObject({ code: "IMMUTABLE_RECORD" });
    await expect(sessions.discardCandidate(t.ctx, run.session, { utteranceId: turn.utteranceId })).rejects.toMatchObject({
      code: "IMMUTABLE_RECORD",
    });
    await expect(
      sessions.submitUtterance(t.ctx, run.session, { utteranceId: turn.utteranceId, mediaAssetId: main.turns[0]!.mediaAssetId }),
    ).rejects.toMatchObject({ code: "IMMUTABLE_RECORD" });
    await expect(
      sessions.createUtterance(t.ctx, run.session, { presentationId: turn.presentationId, turnIndex: turn.turnIndex }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(IMMUTABLE_RECORD|INVALID_STATE|CONFLICT)$/) });

    expect(await mediaRow(t.ctx, turn.mediaAssetId)).toEqual(before);
    expect((await utteranceRow(t.ctx, turn.utteranceId)).acceptedMediaAssetId).toBe(turn.mediaAssetId);
    expect((await storedBytes(t.ctx, before.storageKey)).equals(turn.audio)).toBe(true);
    // Exactly one stored source file for the utterance.
    const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.utteranceId, turn.utteranceId));
    expect(assets.map((asset) => asset.id)).toEqual([turn.mediaAssetId]);
    await drainQueue(t.ctx);
  });

  it("refuses an overwrite in storage and a direct change of the media row or the accepted link", async () => {
    const turn = main.turns[0]!;
    const media = await mediaRow(t.ctx, turn.mediaAssetId);
    await expect(t.storage.put({ key: media.storageKey, body: recording(), contentType: "audio/wav" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await storedBytes(t.ctx, media.storageKey)).equals(turn.audio)).toBe(true);

    const other = main.turns[1]!;
    const otherMedia = await mediaRow(t.ctx, other.mediaAssetId);
    await expectImmutable(db.update(mediaAssets).set({ sha256: otherMedia.sha256 }).where(eq(mediaAssets.id, media.id)));
    await expectImmutable(db.update(mediaAssets).set({ storageKey: "studies/x/other.wav" }).where(eq(mediaAssets.id, media.id)));
    await expectImmutable(db.update(mediaAssets).set({ sizeBytes: 1 }).where(eq(mediaAssets.id, media.id)));
    await expectImmutable(
      db.update(utterances).set({ acceptedMediaAssetId: other.mediaAssetId }).where(eq(utterances.id, turn.utteranceId)),
    );
    await expectImmutable(db.update(utterances).set({ promptSnapshot: "Changed." }).where(eq(utterances.id, turn.utteranceId)));
    expect(await mediaRow(t.ctx, turn.mediaAssetId)).toEqual(media);
  });

  it("still holds the uploaded bytes, with the recorded SHA-256, after the whole pipeline ran", async () => {
    for (const turn of main.turns) {
      const media = await mediaRow(t.ctx, turn.mediaAssetId);
      const bytes = await storedBytes(t.ctx, media.storageKey);
      expect(bytes.equals(turn.audio)).toBe(true);
      expect(sha256OfBuffer(bytes)).toBe(media.sha256);
      expect(media.sha256).toBe(turn.sha256);
      expect(media.sizeBytes).toBe(turn.audio.length);
      expect(media.deletedAt).toBeNull();
      // ASR, translation and TTS ran on this utterance.
      const lineage = await processing.getUtteranceLineage(t.adminCtx, turn.utteranceId);
      expect(lineage.batches[0]!.translations.length).toBeGreaterThan(0);
      expect(lineage.sourceAsset).toMatchObject({ id: media.id, sha256: turn.sha256 });
    }
  });
});

describe("3. a model output never mutates", () => {
  it("offers no service that edits an ASR transcript, and a new ASR run adds a revision instead", async () => {
    const turn = main.turns[0]!;
    const [asrBefore] = await revisionsOfUtterance(turn.utteranceId, "asr");
    await expect(
      // @ts-expect-error the ASR transcript is not a type a researcher can save
      transcripts.saveTranscriptRevision(t.adminCtx, { utteranceId: turn.utteranceId, type: "asr", text: "Edited ASR." }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      transcripts.saveRevisionForTranscript(t.adminCtx, { transcriptId: asrBefore!.transcriptId, text: "Edited ASR." }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(VALIDATION_ERROR|INVALID_STATE|IMMUTABLE_RECORD)$/) });
    await expect(
      transcripts.verifyTranscript(t.adminCtx, { transcriptId: asrBefore!.transcriptId, revisionId: asrBefore!.id }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await revisionsOfUtterance(turn.utteranceId, "asr")).toEqual([asrBefore]);

    // A second ASR run (a batch that runs ASR only) adds revision 2 and keeps revision 1 as it was.
    const rerun = await processing.createBatch(t.adminCtx, {
      studyId: study.study.id,
      name: "asr rerun",
      selection: { utteranceIds: [turn.utteranceId] },
      runAsr: true,
      translationModelConfigIds: [],
      ttsModelConfigIds: [],
    });
    await processing.startBatch(t.adminCtx, rerun.id);
    await drainQueue(t.ctx);
    const after = await revisionsOfUtterance(turn.utteranceId, "asr");
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual({ ...asrBefore, isCurrent: false });
    expect(after[1]).toMatchObject({ revisionNumber: 2, isCurrent: true, createdByType: "model" });
    expect(after[1]!.sourceModelRunId).not.toBe(asrBefore!.sourceModelRunId);
  });

  it("lets the output status change and nothing else, and never runs a finished batch again", async () => {
    const [translation] = await translationsOfBatch(batchOne.id);
    const [synthesis] = await synthesesOfBatch(batchOne.id);
    await corpus.setOutputStatus(t.adminCtx, {
      entityType: "translation",
      entityId: translation!.id,
      status: "reviewed",
      ...({ translatedText: "Edited translation.", text: "Edited translation." } as object),
    });
    await corpus.setOutputStatus(t.adminCtx, { entityType: "synthesis", entityId: synthesis!.id, status: "reviewed" });
    const [translationAfter] = await db.select().from(translations).where(eq(translations.id, translation!.id));
    const [synthesisAfter] = await db.select().from(syntheses).where(eq(syntheses.id, synthesis!.id));
    expect(translationAfter).toEqual({ ...translation, status: "reviewed" });
    expect(synthesisAfter).toEqual({ ...synthesis, status: "reviewed" });
    await corpus.setOutputStatus(t.adminCtx, { entityType: "translation", entityId: translation!.id, status: "generated" });
    await corpus.setOutputStatus(t.adminCtx, { entityType: "synthesis", entityId: synthesis!.id, status: "generated" });

    const before = { translations: await translationsOfBatch(batchOne.id), runs: await runsOfBatch(batchOne.id) };
    await expect(processing.startBatch(t.adminCtx, batchOne.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await processing.retryFailedJobs(t.adminCtx, batchOne.id)).retried).toBe(0);
    expect(await drainQueue(t.ctx)).toBe(0);
    expect(await translationsOfBatch(batchOne.id)).toEqual(before.translations);
    expect(await runsOfBatch(batchOne.id)).toEqual(before.runs);
  });

  it("refuses direct updates and deletes of ASR text, translation text, synthesis text and finished model runs", async () => {
    const turn = main.turns[1]!;
    const [asr] = await revisionsOfUtterance(turn.utteranceId, "asr");
    const [translation] = await translationsOfBatch(batchOne.id);
    const [synthesis] = await synthesesOfBatch(batchOne.id);
    const [run] = await runsOfBatch(batchOne.id);
    expect(asr!.createdByType).toBe("model");
    expect(run!.status).toBe("succeeded");

    await expectImmutable(db.update(transcriptRevisions).set({ text: "Edited." }).where(eq(transcriptRevisions.id, asr!.id)));
    await expectImmutable(db.update(transcriptRevisions).set({ sourceModelRunId: null }).where(eq(transcriptRevisions.id, asr!.id)));
    await expectImmutable(db.delete(transcriptRevisions).where(eq(transcriptRevisions.id, asr!.id)));
    await expectImmutable(db.update(translations).set({ translatedText: "Edited." }).where(eq(translations.id, translation!.id)));
    await expectImmutable(db.update(translations).set({ conditionKey: "default2" }).where(eq(translations.id, translation!.id)));
    await expectImmutable(db.delete(translations).where(eq(translations.id, translation!.id)));
    await expectImmutable(db.update(syntheses).set({ sourceText: "Edited." }).where(eq(syntheses.id, synthesis!.id)));
    await expectImmutable(db.update(syntheses).set({ voiceKey: "other" }).where(eq(syntheses.id, synthesis!.id)));
    await expectImmutable(db.delete(syntheses).where(eq(syntheses.id, synthesis!.id)));
    await expectImmutable(db.update(modelRuns).set({ returnedModel: "other" }).where(eq(modelRuns.id, run!.id)));
    await expectImmutable(db.update(modelRuns).set({ status: "failed" }).where(eq(modelRuns.id, run!.id)));
    await expectImmutable(db.update(modelRuns).set({ parametersJson: {} }).where(eq(modelRuns.id, run!.id)));
    await expectImmutable(db.delete(modelRuns).where(eq(modelRuns.id, run!.id)));
    // The generated audio file is protected like a source recording.
    const [ttsAsset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, synthesis!.mediaAssetId));
    await expectImmutable(db.update(mediaAssets).set({ sha256: asr!.id.replace(/-/g, "").padEnd(64, "0") }).where(eq(mediaAssets.id, ttsAsset!.id)));
    await expect(t.storage.put({ key: ttsAsset!.storageKey, body: recording(), contentType: "audio/wav" })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await revisionsOfUtterance(turn.utteranceId, "asr")).toEqual([asr]);
    expect((await translationsOfBatch(batchOne.id))[0]).toEqual(translation);
    expect((await synthesesOfBatch(batchOne.id))[0]).toEqual(synthesis);
    expect((await runsOfBatch(batchOne.id))[0]).toEqual(run);
  });
});

describe("4. human corrections create revisions", () => {
  it("keeps every earlier revision, with exactly one current revision", async () => {
    const turn = main.turns[3]!;
    const review = reviewed.get(turn.utteranceId)!;
    const [verified] = await revisionsOfUtterance(turn.utteranceId, "normalized");
    expect(verified).toMatchObject({ id: review.c.revisionId, isCurrent: true, text: review.c.text });
    expect(verified!.verifiedAt).not.toBeNull();

    // A verified transcript is changed only with a reason.
    await expect(
      transcripts.saveTranscriptRevision(t.adminCtx, { utteranceId: turn.utteranceId, type: "normalized", text: "Minä en tiedä sitä." }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    t.clock.advance(1000);
    const second = await transcripts.saveTranscriptRevision(t.adminCtx, {
      utteranceId: turn.utteranceId,
      type: "normalized",
      text: "Minä en tiedä sitä.",
      changeReason: "Missing object added after listening again.",
    });
    expect(second).toMatchObject({ created: true, revision: { revisionNumber: 2 }, transcript: { status: "draft" } });
    t.clock.advance(1000);
    const third = await transcripts.saveTranscriptRevision(t.adminCtx, {
      utteranceId: turn.utteranceId,
      type: "normalized",
      text: "Minä en tiedä sitä oikeastaan.",
    });
    // Saving the same text again writes nothing.
    const again = await transcripts.saveTranscriptRevision(t.adminCtx, {
      utteranceId: turn.utteranceId,
      type: "normalized",
      text: "Minä en tiedä sitä oikeastaan.",
    });
    expect(again).toMatchObject({ created: false, revision: { id: third.revision.id } });

    const all = await revisionsOfUtterance(turn.utteranceId, "normalized");
    expect(all.map((revision) => [revision.revisionNumber, revision.text, revision.isCurrent])).toEqual([
      [1, review.c.text, false],
      [2, "Minä en tiedä sitä.", false],
      [3, "Minä en tiedä sitä oikeastaan.", true],
    ]);
    // The verified revision is unchanged apart from is_current.
    expect(all[0]).toEqual({ ...verified, isCurrent: false });
    expect(all[1]!.changeReason).toBe("Missing object added after listening again.");
    expect(all.filter((revision) => revision.isCurrent)).toHaveLength(1);

    const history = await transcripts.getTranscriptHistory(t.adminCtx, review.c.transcriptId);
    expect(history.revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    const lineage = await processing.getUtteranceLineage(t.adminCtx, turn.utteranceId);
    const c = lineage.transcripts.find((transcript) => transcript.type === "normalized")!;
    expect(c.revisions.map((revision) => revision.isCurrent)).toEqual([false, false, true]);
    expect(c.currentRevisionId).toBe(third.revision.id);
    // The translation made from revision 1 still points at revision 1.
    const fromFirst = lineage.batches[0]!.translations.filter((translation) => translation.source.transcriptType === "normalized");
    expect(fromFirst.map((translation) => translation.source.transcriptRevisionId)).toEqual([verified!.id, verified!.id]);
  });

  it("refuses to edit a human revision in place or to have two current revisions", async () => {
    const turn = main.turns[3]!;
    const all = await revisionsOfUtterance(turn.utteranceId, "normalized");
    await expectImmutable(db.update(transcriptRevisions).set({ text: "Edited in place." }).where(eq(transcriptRevisions.id, all[0]!.id)));
    await expectImmutable(db.delete(transcriptRevisions).where(eq(transcriptRevisions.id, all[0]!.id)));
    const second = await db
      .update(transcriptRevisions)
      .set({ isCurrent: true })
      .where(eq(transcriptRevisions.id, all[0]!.id))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isUniqueViolation(second, "transcript_revisions_one_current_uq")).toBe(true);
    expect(await revisionsOfUtterance(turn.utteranceId, "normalized")).toEqual(all);
  });
});

describe("5. every derived output traces to a source and a configuration", () => {
  it("links every translation to a revision, a model run, a batch and a model configuration", async () => {
    const outputs = await db
      .select({ translation: translations, run: modelRuns })
      .from(translations)
      .leftJoin(modelRuns, eq(modelRuns.id, translations.modelRunId));
    expect(outputs.length).toBeGreaterThanOrEqual(24);
    const revisionIds = new Set((await db.select({ id: transcriptRevisions.id }).from(transcriptRevisions)).map((row) => row.id));
    const batchIds = new Set((await db.select({ id: processingBatches.id }).from(processingBatches)).map((row) => row.id));
    for (const { translation, run } of outputs) {
      expect(revisionIds.has(translation.sourceTranscriptRevisionId)).toBe(true);
      expect(batchIds.has(translation.processingBatchId)).toBe(true);
      expect(translation.translatedText.length).toBeGreaterThan(0);
      expect(run).not.toBeNull();
      expect(run).toMatchObject({
        stage: "translation",
        status: "succeeded",
        sourceEntityType: "transcript_revision",
        sourceEntityId: translation.sourceTranscriptRevisionId,
        processingBatchId: translation.processingBatchId,
        conditionKey: translation.conditionKey,
        appVersion: "test",
      });
      expect(run!.modelConfigId).not.toBeNull();
      expect(run!.promptVersionId).not.toBeNull();
      // The frozen configuration of the batch names the same configuration.
      const [batch] = await db.select().from(processingBatches).where(eq(processingBatches.id, translation.processingBatchId));
      expect(JSON.stringify(batch!.configurationSnapshotJson)).toContain(run!.modelConfigId!);
    }
  });

  it("links every synthesis to its translation, the exact text, a model run, a configuration and a hashed file", async () => {
    const outputs = await db
      .select({ synthesis: syntheses, run: modelRuns, asset: mediaAssets, translation: translations })
      .from(syntheses)
      .leftJoin(modelRuns, eq(modelRuns.id, syntheses.modelRunId))
      .leftJoin(mediaAssets, eq(mediaAssets.id, syntheses.mediaAssetId))
      .leftJoin(translations, eq(translations.id, syntheses.translationId));
    expect(outputs.length).toBeGreaterThanOrEqual(24);
    for (const { synthesis, run, asset, translation } of outputs) {
      expect(translation).not.toBeNull();
      expect(synthesis.sourceText).toBe(translation!.translatedText);
      expect(synthesis.voiceKey).toBe("mock-voice");
      expect(run).toMatchObject({ stage: "tts", status: "succeeded", sourceEntityId: translation!.id });
      expect(run!.modelConfigId).not.toBeNull();
      expect(asset).toMatchObject({ kind: "tts_audio" });
      expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256OfBuffer(await storedBytes(t.ctx, asset!.storageKey))).toBe(asset!.sha256);
    }
  });

  it("cannot store a translation or a synthesis without its source and provenance", async () => {
    const [translation] = await translationsOfBatch(batchOne.id);
    const [synthesis] = await synthesesOfBatch(batchOne.id);
    const insertTranslation = (values: Record<string, unknown>) =>
      db.insert(translations).values({
        sourceTranscriptRevisionId: translation!.sourceTranscriptRevisionId,
        conditionKey: "untraceable",
        processingBatchId: translation!.processingBatchId,
        modelRunId: translation!.modelRunId,
        translatedText: "No provenance.",
        ...values,
      } as typeof translations.$inferInsert);
    await expect(insertTranslation({ sourceTranscriptRevisionId: null })).rejects.toThrow();
    await expect(insertTranslation({ modelRunId: null })).rejects.toThrow();
    await expect(insertTranslation({ processingBatchId: null })).rejects.toThrow();
    // A model run belongs to one output: it cannot be reused for a second translation.
    await expect(insertTranslation({})).rejects.toThrow();

    const insertSynthesis = (values: Record<string, unknown>) =>
      db.insert(syntheses).values({
        translationId: synthesis!.translationId,
        sourceText: synthesis!.sourceText,
        conditionKey: "untraceable",
        processingBatchId: synthesis!.processingBatchId,
        modelRunId: synthesis!.modelRunId,
        mediaAssetId: synthesis!.mediaAssetId,
        voiceKey: "mock-voice",
        ...values,
      } as typeof syntheses.$inferInsert);
    await expect(insertSynthesis({ sourceText: null })).rejects.toThrow();
    await expect(insertSynthesis({ mediaAssetId: null })).rejects.toThrow();
    await expect(insertSynthesis({ modelRunId: null })).rejects.toThrow();
    await expect(insertSynthesis({ processingBatchId: null })).rejects.toThrow();
    await expect(insertSynthesis({})).rejects.toThrow();
    // A media row cannot exist without a hash.
    await expect(
      db.insert(mediaAssets).values({
        studyId: study.study.id,
        kind: "tts_audio",
        storageDriver: "memory",
        storageKey: "studies/x/no-hash.wav",
        mimeType: "audio/wav",
        sizeBytes: 10,
        sha256: null,
      } as unknown as typeof mediaAssets.$inferInsert),
    ).rejects.toThrow();
    expect(await db.select().from(translations).where(eq(translations.conditionKey, "untraceable"))).toEqual([]);
    expect(await db.select().from(syntheses).where(eq(syntheses.conditionKey, "untraceable"))).toEqual([]);
  });
});

describe("6. TEST and DEMO data never enter a research export by default", () => {
  let testRun: SessionRun;
  let demoRun: SessionRun;
  let testBatch: processing.BatchDetail;

  it("leaves test and demo sessions, their outputs and their audio out of the default dataset package", async () => {
    testRun = await runSession(t.ctx, study.slug, { mode: "test" });
    demoRun = await runSession(t.ctx, study.slug, { mode: "demo" });
    await drainQueue(t.ctx);
    const created = await processing.createBatch(t.adminCtx, {
      studyId: study.study.id,
      name: "test-mode outputs",
      selection: { mode: "test" },
      transcriptTypes: ["asr"],
    });
    await processing.startBatch(t.adminCtx, created.id);
    await drainQueue(t.ctx);
    testBatch = await processing.getBatch(t.adminCtx, created.id);
    expect(testBatch.outputCounts.translations).toBeGreaterThan(0);

    const { files } = await buildExportArchive(t.adminCtx, {
      exportType: "dataset_package",
      options: { includeSourceAudio: true, includeGeneratedAudio: true },
    });
    const sessionRows = csvObjects(files.get("sessions.csv")!.toString("utf8"));
    expect(sessionRows.map((row) => row.mode)).toEqual(sessionRows.map(() => "research"));
    expect(sessionRows.map((row) => row.session_id)).toContain(main.session.id);

    const testOutputs = await translationsOfBatch(testBatch.id);
    const forbidden = [
      testRun.session.id,
      testRun.participantCode,
      demoRun.session.id,
      demoRun.participantCode,
      testBatch.id,
      ...[...testRun.turns, ...demoRun.turns].flatMap((turn) => [turn.utteranceId, turn.mediaAssetId, turn.sha256]),
      ...testOutputs.map((row) => row.id),
      ...(await synthesesOfBatch(testBatch.id)).map((row) => row.id),
      ...(await runsOfBatch(testBatch.id)).map((row) => row.id),
    ];
    const otherAudio = [...testRun.turns, ...demoRun.turns].map((turn) => turn.audio);
    for (const [name, content] of files) {
      if (name.startsWith("source_audio/") || name.startsWith("generated_audio/")) {
        expect(name.includes(testRun.participantCode) || name.includes(demoRun.participantCode), name).toBe(false);
        expect(otherAudio.some((audio) => audio.equals(content)), name).toBe(false);
      } else {
        const body = content.toString("utf8");
        for (const value of forbidden) expect(body.includes(value), `${name} contains ${value}`).toBe(false);
      }
    }
  });

  it("applies the same default to the audio archives, the single table exports, the preview and a research batch", async () => {
    const audio = await buildExportArchive(t.adminCtx, { exportType: "source_audio_zip" });
    const names = [...audio.files.keys()].filter((name) => name.startsWith("source_audio/"));
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((name) => name.includes(testRun.participantCode) || name.includes(demoRun.participantCode))).toBe(false);
    const generated = await buildExportArchive(t.adminCtx, { exportType: "tts_audio_zip" });
    expect([...generated.files.keys()].some((name) => name.includes(testRun.participantCode))).toBe(false);

    for (const table of ["sessions", "utterances", "transcripts", "translations", "syntheses"] as const) {
      const exported = await exportsArea.openTableExport(t.adminCtx, { table, format: "csv" });
      const body = (await streamToBuffer(exported.stream)).toString("utf8");
      for (const value of [testRun.session.id, demoRun.session.id, testRun.participantCode, demoRun.participantCode, testBatch.id]) {
        expect(body.includes(value), `${table} contains ${value}`).toBe(false);
      }
    }
    const selection = await exportsArea.resolveSelection(db);
    expect(selection.filters.modes).toEqual(["research"]);

    // A research batch never selects them, and naming them is refused.
    const preview = await processing.previewBatch(t.adminCtx, { studyId: study.study.id, selection: { verifiedTranscriptsOnly: false } });
    expect(JSON.stringify(preview)).not.toContain(testRun.turns[0]!.utteranceId);
    expect(JSON.stringify(preview)).not.toContain(demoRun.turns[0]!.utteranceId);
    await expect(
      processing.createBatch(t.adminCtx, {
        studyId: study.study.id,
        name: "research with a demo session",
        selection: { sessionIds: [demoRun.session.id] },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Asked for explicitly, they are exported.
    const withBoth = await buildExportArchive(t.adminCtx, {
      exportType: "dataset_package",
      filters: { includeTest: true, includeDemo: true },
    });
    const ids = csvObjects(withBoth.files.get("sessions.csv")!.toString("utf8")).map((row) => row.session_id);
    expect(ids).toEqual(expect.arrayContaining([testRun.session.id, demoRun.session.id, main.session.id]));
  });
});

describe("7. a new model or prompt experiment creates a new batch", () => {
  it("leaves the rows of the earlier batch byte-identical when a new prompt version is activated and run", async () => {
    const snapshot = async () => ({
      batch: await db.select().from(processingBatches).where(eq(processingBatches.id, batchOne.id)),
      translations: await translationsOfBatch(batchOne.id),
      syntheses: await synthesesOfBatch(batchOne.id),
      runs: await runsOfBatch(batchOne.id),
    });
    const before = await snapshot();
    const beforeText = JSON.stringify(before);
    const audioBefore = new Map<string, string>();
    for (const synthesis of before.syntheses) {
      const asset = await mediaRow(t.ctx, synthesis.mediaAssetId);
      audioBefore.set(asset.storageKey, sha256OfBuffer(await storedBytes(t.ctx, asset.storageKey)));
    }

    // The experiment: a new version of the preservation prompt, and a new
    // configuration version that uses it.
    t.clock.advance(3_600_000);
    const promptDraft = await aiConfig.clonePromptVersion(t.adminCtx, study.ai.prompts.translationPreserve.id);
    await aiConfig.updatePromptDraft(t.adminCtx, promptDraft.id, {
      promptText: "Translate into English. Keep dialect markers, hesitations and register. Return only the translation.",
    });
    const activated = await aiConfig.activatePromptVersion(t.adminCtx, promptDraft.id);
    expect(activated.prompt).toMatchObject({ versionNumber: 2, status: "active" });
    const configDraft = await aiConfig.cloneModelConfig(t.adminCtx, study.ai.configs.translationPreserve.id, { useActivePrompt: true });
    const newConfig = (await aiConfig.activateModelConfig(t.adminCtx, configDraft.id)).config;
    expect(newConfig).toMatchObject({ versionNumber: 2, status: "active", promptVersionId: promptDraft.id });

    // Activation alone changed nothing of batch one.
    expect(JSON.stringify(await snapshot())).toBe(beforeText);
    // The old batch cannot be made to run under the new configuration.
    await expect(processing.startBatch(t.adminCtx, batchOne.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expectImmutable(
      db
        .update(processingBatches)
        .set({ configurationSnapshotJson: { ...before.batch[0]!.configurationSnapshotJson, targetLanguage: "de" } })
        .where(eq(processingBatches.id, batchOne.id)),
    );
    // A second batch cannot take the name of the first.
    await expect(processing.createBatch(t.adminCtx, { studyId: study.study.id, name: "batch one" })).rejects.toMatchObject({
      code: expect.stringMatching(/^(CONFLICT|VALIDATION_ERROR)$/),
    });

    // The experiment runs as a new batch on the same utterances.
    const created = await processing.createBatch(t.adminCtx, {
      studyId: study.study.id,
      name: "batch two, preservation prompt v2",
      selection: { sessionIds: [main.session.id] },
      transcriptTypes: ["human_dialect"],
    });
    expect(created.id).not.toBe(batchOne.id);
    await processing.startBatch(t.adminCtx, created.id);
    await drainQueue(t.ctx);
    const batchTwo = await processing.getBatch(t.adminCtx, created.id);
    expect(batchTwo.status).toBe("completed");
    expect(batchTwo.config.translations.map((config) => [config.key, config.versionNumber]).sort()).toEqual([
      ["translation_default", 1],
      ["translation_preserve", 2],
    ]);

    // Batch one: every row and every generated file is as it was.
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(beforeText);
    for (const [storageKey, hash] of audioBefore) {
      expect(sha256OfBuffer(await storedBytes(t.ctx, storageKey))).toBe(hash);
    }
    // Its frozen configuration still holds prompt version 1 with its text.
    const frozen = JSON.stringify(after.batch[0]!.configurationSnapshotJson);
    expect(frozen).toContain(study.ai.prompts.translationPreserve.promptText);
    expect(frozen).not.toContain("Keep dialect markers, hesitations and register");
    expect(after.runs.every((run) => run.promptVersionId !== promptDraft.id && run.modelConfigId !== newConfig.id)).toBe(true);

    // Batch two: its own rows, made with prompt version 2, next to the old ones.
    const newTranslations = await translationsOfBatch(batchTwo.id);
    expect(newTranslations.length).toBeGreaterThan(0);
    const oldIds = new Set(before.translations.map((row) => row.id));
    expect(newTranslations.some((row) => oldIds.has(row.id))).toBe(false);
    const newRuns = await runsOfBatch(batchTwo.id);
    const preserveRuns = newRuns.filter((run) => run.stage === "translation" && run.conditionKey === "preservation");
    expect(preserveRuns.length).toBeGreaterThan(0);
    expect(preserveRuns.every((run) => run.promptVersionId === promptDraft.id && run.modelConfigId === newConfig.id)).toBe(true);
    // The same revision under the same condition now has one translation per batch, with different text.
    const turn = main.turns[0]!;
    const lineage = await processing.getUtteranceLineage(t.adminCtx, turn.utteranceId);
    const byBatch = lineage.batches
      .map((entry) => ({
        batchId: entry.batch.id,
        preserve: entry.translations.find(
          (translation) => translation.source.transcriptType === "human_dialect" && translation.conditionKey === "preservation",
        ),
      }))
      .filter((entry) => entry.preserve);
    expect(byBatch.map((entry) => entry.batchId)).toEqual([batchOne.id, batchTwo.id]);
    expect(byBatch[0]!.preserve!.source.transcriptRevisionId).toBe(byBatch[1]!.preserve!.source.transcriptRevisionId);
    expect(byBatch[0]!.preserve!.translatedText).not.toBe(byBatch[1]!.preserve!.translatedText);
    expect(byBatch[0]!.preserve!.provenance.promptVersion?.versionNumber).toBe(1);
    expect(byBatch[1]!.preserve!.provenance.promptVersion?.versionNumber).toBe(2);
  });
});

describe("8. participant collection does not depend on AI availability", () => {
  // A registry in which every provider access throws: no AI service can be reached at all.
  const unreachable: ProviderRegistry = new Proxy({} as ProviderRegistry, {
    get() {
      throw new Error("AI providers are not reachable");
    },
  });

  it("lets the participant submit every recording and complete while the provider fails permanently, and the recordings are transcribed later", async () => {
    const other = await setupStudy(t, { aiConfigs: false });
    const failing = await activateMockConfig(t.adminCtx, other.study.id, {
      key: "asr_default",
      stage: "asr",
      parameters: { language: "fi", mockFail: "permanent" },
    });

    const participantCtx: ServiceContext = { ...t.ctx, providers: unreachable };
    const run = await runSession(participantCtx, other.slug);
    expect(run.finalState.step).toBe("completed");
    expect(run.turns).toHaveLength(4);
    for (const turn of run.turns) {
      expect(await utteranceRow(t.ctx, turn.utteranceId)).toMatchObject({ status: "submitted", acceptedMediaAssetId: turn.mediaAssetId });
      expect((await storedBytes(t.ctx, (await mediaRow(t.ctx, turn.mediaAssetId)).storageKey)).equals(turn.audio)).toBe(true);
    }

    // The worker runs the automatic ASR jobs: the provider refuses every call.
    await drainQueue(t.ctx);
    const utteranceIds = run.turns.map((turn) => turn.utteranceId);
    const ownJobs = async () =>
      (await jobsOf(t.ctx, { type: "asr" })).filter((job) => utteranceIds.includes((job.payloadJson as { utteranceId: string }).utteranceId));
    const failedJobs = await ownJobs();
    expect(failedJobs.map((job) => job.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(failedJobs.every((job) => (job.lastError ?? "").length > 0)).toBe(true);
    const failedRuns = await db.select().from(modelRuns).where(inArray(modelRuns.sourceEntityId, utteranceIds));
    expect(failedRuns.map((row) => [row.status, row.modelConfigId])).toEqual(utteranceIds.map(() => ["failed", failing.id]));
    // The failures are visible to the researcher.
    const dashboard = await corpus.getDashboard(t.adminCtx, other.study.id);
    expect(dashboard.processingErrors).toMatchObject({ failedJobs: 4, failedModelRuns: 4 });
    expect(dashboard.participants).toMatchObject({ started: 1, completed: 1 });
    const lineage = await processing.getUtteranceLineage(t.adminCtx, utteranceIds[0]!);
    expect(lineage.failedRuns).toHaveLength(1);
    expect(lineage.failedRuns[0]).toMatchObject({ stage: "asr", status: "failed" });
    expect(lineage.failedRuns[0]!.errorCode).not.toBeNull();
    expect(lineage.transcripts).toEqual([]);

    // Later the provider works again (a new configuration version). An automatic
    // job stays tied to the configuration that was active when the recording was
    // submitted, so the recordings are transcribed by an ASR batch that uses the
    // new configuration.
    const draft = await aiConfig.cloneModelConfig(t.adminCtx, failing.id);
    await aiConfig.updateModelConfigDraft(t.adminCtx, draft.id, { parameters: { language: "fi" } });
    await aiConfig.activateModelConfig(t.adminCtx, draft.id);
    const recovery = await processing.createBatch(t.adminCtx, {
      studyId: other.study.id,
      name: "asr after provider outage",
      runAsr: true,
      translationModelConfigIds: [],
      ttsModelConfigIds: [],
      selection: { sessionIds: [run.session.id] },
    });
    await processing.startBatch(t.adminCtx, recovery.id);
    await drainQueue(t.ctx);
    expect(await processing.getBatch(t.adminCtx, recovery.id)).toMatchObject({
      status: "completed",
      outputCounts: { asrRevisions: 4 },
    });
    const recovered = await processing.getUtteranceLineage(t.adminCtx, utteranceIds[0]!);
    expect(recovered.transcripts.map((transcript) => transcript.type)).toEqual(["asr"]);
    expect(recovered.transcripts[0]!.revisions[0]!.provenance?.modelRun).toMatchObject({ status: "succeeded", attemptNumber: 1 });
    // The earlier failure stays on record.
    expect(recovered.failedRuns).toHaveLength(1);
  });

  it("lets the participant complete when enqueueing a job throws, and the recordings are processed later", async () => {
    const logged: Array<Record<string, unknown> | string> = [];
    const logger: Logger = { ...silentLogger, error: (entry) => void logged.push(entry) };
    const participantCtx: ServiceContext = { ...t.ctx, providers: unreachable, logger };
    const jobsBefore = (await jobsOf(t.ctx)).length;

    queueSwitch.failing = true;
    let run: SessionRun;
    try {
      run = await runSession(participantCtx, study.slug);
    } finally {
      queueSwitch.failing = false;
    }
    expect(run.finalState.step).toBe("completed");
    expect(run.turns).toHaveLength(4);
    for (const turn of run.turns) {
      expect(await utteranceRow(t.ctx, turn.utteranceId)).toMatchObject({ status: "submitted", acceptedMediaAssetId: turn.mediaAssetId });
    }
    // No job was created, and every failure was logged for the operator.
    expect((await jobsOf(t.ctx)).length).toBe(jobsBefore);
    expect(logged).toHaveLength(4);
    expect(logged[0]).toMatchObject({ jobType: "asr" });

    // The researcher runs ASR for the session later, in a batch.
    const created = await processing.createBatch(t.adminCtx, {
      studyId: study.study.id,
      name: "late ASR after a queue outage",
      selection: { sessionIds: [run.session.id] },
      runAsr: true,
      translationModelConfigIds: [],
      ttsModelConfigIds: [],
    });
    await processing.startBatch(t.adminCtx, created.id);
    await drainQueue(t.ctx);
    expect((await processing.getBatch(t.adminCtx, created.id)).status).toBe("completed");
    for (const turn of run.turns) {
      expect(await revisionsOfUtterance(turn.utteranceId, "asr")).toHaveLength(1);
    }
  });
});

describe("9. Research Mode never exposes AI output to the participant", () => {
  it("returns no transcript, translation or model data in any participant state, even when the outputs already exist", async () => {
    // A participant who has finished recording but not the questionnaires.
    const run = await runSession(t.ctx, study.slug, { until: "tasks" });
    expect(run.session.mode).toBe("research");
    await drainQueue(t.ctx);
    // ASR text, translations and synthesized audio already exist for this session.
    const created = await processing.createBatch(t.adminCtx, {
      studyId: study.study.id,
      name: "outputs during a running session",
      selection: { sessionIds: [run.session.id], completedSessionsOnly: false, verifiedTranscriptsOnly: false },
      transcriptTypes: ["asr"],
    });
    await processing.startBatch(t.adminCtx, created.id);
    await drainQueue(t.ctx);
    const outputs = await translationsOfBatch(created.id);
    expect(outputs).toHaveLength(8);
    expect(await synthesesOfBatch(created.id)).toHaveLength(8);
    const asrTexts: string[] = [];
    for (const turn of run.turns) {
      const [revision] = await revisionsOfUtterance(turn.utteranceId, "asr");
      asrTexts.push(revision!.text);
    }
    const runs = await runsOfBatch(created.id);
    const aiStrings = [
      ...asrTexts,
      ...outputs.map((row) => row.translatedText),
      ...outputs.map((row) => row.id),
      ...runs.map((row) => row.id),
      "[mock-transkriptio",
      "[mock translation",
      "mock-asr",
      "mock-translation",
      "mock-tts",
      "mock-voice",
      created.id,
    ];

    const states: ParticipantState[] = [
      ...run.states,
      await sessions.getParticipantState(t.ctx, run.session),
      // The state a page reload gets, through the session cookie token.
      await sessions.getParticipantState(t.ctx, await sessions.getSessionByToken(t.ctx, run.token)),
      ...(await finishSession(t.ctx, run.session)),
      await sessions.getParticipantState(t.ctx, run.session),
    ];
    // Also every state of the session that went through the whole pipeline.
    states.push(...main.states, await sessions.getParticipantState(t.ctx, main.session));
    expect(states.map((state) => state.step)).toEqual(expect.arrayContaining(["consent", "tasks", "background", "post_recording", "completed"]));

    const forbiddenKey = /transcript|translation|translat|asr|model|synthes|tts|provider|batch|condition|dialect|revision/i;
    for (const state of states) {
      const serialized = JSON.stringify(state);
      for (const value of aiStrings) expect(serialized.includes(value), `${state.step} state contains ${value}`).toBe(false);
      const { keys } = deepKeysAndStrings(state);
      expect(keys.filter((key) => forbiddenKey.test(key)), `${state.step} state`).toEqual([]);
    }
    // The public study information is equally free of it.
    const info = await sessions.getPublicStudyInfo(t.ctx, { studySlug: study.slug });
    expect(deepKeysAndStrings(info).keys.filter((key) => forbiddenKey.test(key))).toEqual([]);
  });
});

describe("10. audio is never publicly addressable", () => {
  it("puts no storage key and no URL of a recording in any participant state or admin list payload", async () => {
    const assets = await db.select().from(mediaAssets);
    expect(assets.length).toBeGreaterThan(20);
    const keys = assets.map((asset) => asset.storageKey);

    const payloads: Array<[string, unknown]> = [
      ["participant states", main.states],
      ["participant state", await sessions.getParticipantState(t.ctx, main.session)],
      ["public study info", await sessions.getPublicStudyInfo(t.ctx, { studySlug: study.slug })],
      ["sessions list", await corpus.listSessions(t.adminCtx, { studyId: study.study.id })],
      ["sessions list, test mode", await corpus.listSessions(t.adminCtx, { studyId: study.study.id, mode: "test" })],
      ["review queue", await transcripts.listReviewQueue(t.adminCtx, { modes: ["research", "test", "demo"] })],
      ["batch list", await processing.listBatches(t.adminCtx, { studyId: study.study.id })],
      ["batch jobs", await processing.listBatchJobs(t.adminCtx, batchOne.id)],
      ["export jobs", await exportsArea.listExportJobs(t.adminCtx)],
      ["dashboard", await corpus.getDashboard(t.adminCtx, study.study.id)],
      ["session detail", await corpus.getSessionDetail(t.adminCtx, main.session.id)],
      ["utterance for review", await transcripts.getUtteranceForReview(t.adminCtx, main.turns[0]!.utteranceId)],
    ];
    const urlKey = /storage_?key|signed|public_?url|download_?url|^url$|^src$/i;
    for (const [name, payload] of payloads) {
      const serialized = JSON.stringify(payload);
      for (const key of keys) expect(serialized.includes(key), `${name} contains the storage key ${key}`).toBe(false);
      const found = deepKeysAndStrings(payload);
      expect(found.keys.filter((key) => urlKey.test(key)), name).toEqual([]);
      expect(found.strings.filter((value) => /^https?:\/\//i.test(value) && /\.(wav|webm|mp3|ogg|m4a|flac)(\?|$)/i.test(value)), name).toEqual([]);
      expect(found.strings.filter((value) => value.startsWith("studies/")), name).toEqual([]);
    }
    // The storage used here issues no signed URLs at all.
    expect((t.ctx.storage as { getSignedDownloadUrl?: unknown }).getSignedDownloadUrl).toBeUndefined();
  });

  it("serves media only by id through services that the admin routes call", async () => {
    const turn = main.turns[0]!;
    const asset = await corpus.getMediaForStreaming(t.adminCtx, turn.mediaAssetId);
    // The download name is built from pseudonymous codes, never from the storage key.
    const name = await corpus.getMediaDownloadName(t.adminCtx, asset);
    expect(name).toBe(`${main.participantCode}_U-01_source.wav`);
    expect(name).not.toContain("/");
    // A storage key is not an id: it cannot be used to address the file.
    await expect(corpus.getMediaForStreaming(t.adminCtx, asset.storageKey)).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
  });

  it("keeps the local storage root outside every public directory", () => {
    const defaults = Object.fromEntries(
      readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8")
        .split("\n")
        .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[1]!, match[2]!.replace(/^["']|["']$/g, "")]),
    );
    expect(defaults.STORAGE_DRIVER).toBe("local");
    const config = storageConfigFromEnv(defaults, { baseDir: REPO_ROOT });
    if (config.driver !== "local") throw new Error("Expected the local storage driver.");
    const root = config.localRoot;
    const publicDir = path.join(REPO_ROOT, "apps", "web", "public");
    expect(path.isAbsolute(root)).toBe(true);
    expect(path.relative(publicDir, root).startsWith("..")).toBe(true);
    expect(root.split(path.sep)).not.toContain("public");
    expect(root.split(path.sep)).not.toContain(".next");
    expect(root.split(path.sep)).not.toContain("static");
    // And no audio file was placed in the web server's public directory.
    const audio = listFiles(publicDir).filter((file) => /\.(wav|webm|mp3|ogg|m4a|flac|zip)$/i.test(file));
    expect(audio).toEqual([]);
  });
});

describe("11. no provider key reaches browser code", () => {
  const webRoot = path.join(REPO_ROOT, "apps", "web");
  const isSource = (file: string) => /\.(ts|tsx|js|jsx|mjs)$/.test(file) && !/\.(test|spec)\.[tj]sx?$/.test(file) && !file.endsWith(".d.ts");
  const read = (file: string) => readFileSync(file, "utf8");
  const isClientFile = (source: string) => /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*["']use client["']/.test(source);

  // The module specifiers a file imports at run time. `import type` and
  // `export type` statements are erased by the compiler and are left out.
  function runtimeImports(source: string): string[] {
    const specifiers: string[] = [];
    const statement = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;'"]*?\sfrom\s+)?["']([^"']+)["']/g;
    for (let match = statement.exec(source); match; match = statement.exec(source)) {
      if (!match[2]) specifiers.push(match[4]!);
    }
    const dynamic = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
    for (let match = dynamic.exec(source); match; match = dynamic.exec(source)) specifiers.push(match[1]!);
    return specifiers;
  }

  function resolveLocal(fromFile: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith("@/")) base = path.join(webRoot, specifier.slice(2));
    else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }

  // Every file that ends up in a browser bundle: files marked "use client" under
  // apps/web/app, everything in components and lib/client, and whatever those import.
  function browserFiles(): Map<string, string[]> {
    const entries = [
      ...listFiles(path.join(webRoot, "app")).filter((file) => isSource(file) && isClientFile(read(file))),
      ...listFiles(path.join(webRoot, "components")).filter(isSource),
      ...listFiles(path.join(webRoot, "lib", "client")).filter(isSource),
    ];
    const reached = new Map<string, string[]>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (reached.has(file)) continue;
      const imports = runtimeImports(read(file));
      reached.set(file, imports);
      for (const specifier of imports) {
        const resolved = resolveLocal(file, specifier);
        if (resolved && !reached.has(resolved)) queue.push(resolved);
      }
    }
    return reached;
  }

  it("has no provider key, provider environment variable or provider SDK in any browser file", () => {
    const files = browserFiles();
    // The scan really covered the client code.
    expect(files.size).toBeGreaterThan(40);
    expect([...files.keys()].some((file) => file.includes(`${path.sep}lib${path.sep}client${path.sep}`))).toBe(true);
    expect([...files.keys()].some((file) => file.includes(`${path.sep}app${path.sep}`))).toBe(true);

    const problems: string[] = [];
    const serverOnlyPackages = ["@dialect/ai", "openai", "@dialect/db", "@dialect/storage", "@dialect/research"];
    for (const [file, imports] of files) {
      const source = read(file);
      const relative = path.relative(REPO_ROOT, file);
      if (source.includes("OPENAI_API_KEY")) problems.push(`${relative}: mentions OPENAI_API_KEY`);
      if (/process\.env\.OPENAI/.test(source)) problems.push(`${relative}: reads process.env.OPENAI*`);
      if (/process\.env\.(?!NODE_ENV\b|NEXT_PUBLIC_)[A-Z0-9_]*(KEY|SECRET|PASSWORD|TOKEN)/.test(source)) {
        problems.push(`${relative}: reads a secret from process.env`);
      }
      if (/\bsk-[A-Za-z0-9_-]{20,}/.test(source)) problems.push(`${relative}: contains something shaped like an API key`);
      for (const specifier of imports) {
        if (serverOnlyPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
          problems.push(`${relative}: imports ${specifier}`);
        }
        if (/(^|\/)lib\/server(\/|$)/.test(specifier)) problems.push(`${relative}: imports server code ${specifier}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("exposes no secret through a NEXT_PUBLIC variable", () => {
    const names = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8")
      .split("\n")
      .map((line) => /^([A-Z0-9_]+)=/.exec(line.trim())?.[1])
      .filter((name): name is string => Boolean(name));
    expect(names).toContain("OPENAI_API_KEY");
    expect(names.filter((name) => name.startsWith("NEXT_PUBLIC_") && /KEY|SECRET|PASSWORD|TOKEN/.test(name))).toEqual([]);
    const nextConfig = readFileSync(path.join(webRoot, "next.config.ts"), "utf8");
    expect(nextConfig).not.toMatch(/OPENAI|ADMIN_PASSWORD|SESSION_SECRET/);
  });

  it("returns no key material from the provider status the admin page shows", async () => {
    const status = await aiConfig.listProviderStatus(t.adminCtx);
    const found = deepKeysAndStrings(status);
    expect(found.keys.filter((key) => /key|secret|token/i.test(key))).toEqual([]);
    expect(found.strings.filter((value) => /^sk-/.test(value))).toEqual([]);
  });
});

describe("12. the admin can inspect exactly what happened to any utterance", () => {
  it("shows failed runs, retries and the final outputs in the lineage and in the session detail", async () => {
    const other = await setupStudy(t, { aiConfigs: false, settings: { autoQueueAsr: false } });
    const asr = await activateMockConfig(t.adminCtx, other.study.id, {
      key: "asr_default",
      stage: "asr",
      parameters: { language: "fi" },
    });
    // The first call for each input fails with an error the queue retries.
    const flaky = await activateMockConfig(t.adminCtx, other.study.id, {
      key: "translation_default",
      stage: "translation",
      conditionKey: "default",
      promptText: "Translate into English. Return only the translation.",
      parameters: { mockFail: "retryable", mockFailTimes: 1 },
    });
    // The first call for each input fails with an error that is not retried.
    const refusing = await activateMockConfig(t.adminCtx, other.study.id, {
      key: "tts_baseline",
      stage: "tts",
      conditionKey: "baseline",
      promptText: "Speak naturally.",
      parameters: { voice: "mock-voice", response_format: "wav", mockFail: "permanent", mockFailTimes: 1 },
    });

    const run = await runSession(t.ctx, other.slug);
    const turn = run.turns[0]!;
    const review = await reviewUtterance(t.adminCtx, turn.utteranceId, { b: "Mie lähen kottiin.", c: "Minä lähden kotiin." });
    const created = await processing.createBatch(t.adminCtx, {
      studyId: other.study.id,
      name: "batch with failures",
      selection: { utteranceIds: [turn.utteranceId] },
      transcriptTypes: ["asr", "human_dialect"],
      runAsr: true,
      asrModelConfigId: asr.id,
      translationModelConfigIds: [flaky.id],
      ttsModelConfigIds: [refusing.id],
    });
    await processing.startBatch(t.adminCtx, created.id);

    // First pass: ASR succeeds, both translations fail once and wait for their retry.
    await drainQueue(t.ctx);
    let lineage = await processing.getUtteranceLineage(t.adminCtx, turn.utteranceId);
    expect(lineage.failedRuns.map((failed) => [failed.stage, failed.attemptNumber]).sort()).toEqual([
      ["translation", 1],
      ["translation", 1],
    ]);
    expect(lineage.batches).toEqual([]);

    // The queue retries after the backoff: the translations succeed, then TTS fails permanently.
    t.clock.advance(10 * 60_000);
    await drainQueue(t.ctx);
    let batch = await processing.getBatch(t.adminCtx, created.id);
    expect(batch.status).toBe("completed_with_errors");
    expect(batch.jobCounts).toMatchObject({ failed: 2 });
    expect(batch.failedJobs.map((job) => job.type)).toEqual(["tts", "tts"]);

    // The researcher retries the failed jobs: the same batch, the same frozen configuration.
    const retried = await processing.retryFailedJobs(t.adminCtx, created.id);
    expect(retried.retried).toBe(2);
    await drainQueue(t.ctx);
    batch = await processing.getBatch(t.adminCtx, created.id);
    expect(batch).toMatchObject({ status: "completed", outputCounts: { asrRevisions: 1, translations: 2, syntheses: 2 } });

    // The lineage tells the whole story of the utterance.
    lineage = await processing.getUtteranceLineage(t.adminCtx, turn.utteranceId);
    expect(lineage.sourceAsset).toMatchObject({ id: turn.mediaAssetId, sha256: turn.sha256 });
    expect(lineage.transcripts.map((transcript) => transcript.label)).toEqual(["A", "B", "C"]);
    expect(lineage.transcripts[0]!.revisions[0]!.provenance?.modelRun).toMatchObject({ stage: "asr", status: "succeeded" });
    expect(lineage.transcripts[1]!.revisions[0]).toMatchObject({ id: review.b.revisionId, createdByType: "researcher" });
    const failed = lineage.failedRuns.map((entry) => [entry.stage, entry.status, entry.attemptNumber]).sort();
    expect(failed).toEqual([
      ["translation", "failed", 1],
      ["translation", "failed", 1],
      ["tts", "failed", 1],
      ["tts", "failed", 1],
    ]);
    for (const entry of lineage.failedRuns) {
      expect(entry.errorCode).not.toBeNull();
      expect(entry.errorMessage).not.toBeNull();
      expect(entry.finishedAt).not.toBeNull();
      expect(entry.processingBatchId).toBe(created.id);
    }
    const outputs = lineage.batches[0]!.translations;
    expect(outputs.map((translation) => translation.source.transcriptLabel).sort()).toEqual(["A", "B"]);
    for (const translation of outputs) {
      // The stored output comes from the second attempt.
      expect(translation.provenance.modelRun).toMatchObject({ status: "succeeded", attemptNumber: 2 });
      expect(translation.provenance.modelConfig?.id).toBe(flaky.id);
      expect(translation.syntheses).toHaveLength(1);
      expect(translation.syntheses[0]!.provenance.modelRun).toMatchObject({ status: "succeeded", attemptNumber: 2 });
      expect(translation.syntheses[0]!.sourceText).toBe(translation.translatedText);
    }

    // The session detail lists the same runs and jobs.
    const detail = await corpus.getSessionDetail(t.adminCtx, run.session.id);
    const history = JSON.stringify(detail);
    for (const entry of lineage.failedRuns) expect(history).toContain(entry.id);
    for (const translation of outputs) expect(history).toContain(translation.provenance.modelRun.id);
    // And the audit log says who did what, in order.
    const batchAudit = await corpus.getAuditHistory(t.adminCtx, { entityType: "processing_batch", entityId: created.id });
    expect(batchAudit.items.map((item) => item.action).sort()).toEqual(["batch.create", "batch.retry_failed", "batch.start"]);
    const sessionAudit = await corpus.getSessionAuditHistory(t.adminCtx, run.session.id);
    expect(sessionAudit.items.map((item) => item.action)).toEqual(
      expect.arrayContaining(["transcript.save_revision", "transcript.verify"]),
    );
  });
});

function listFiles(directory: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...listFiles(full));
    else found.push(full);
  }
  return found;
}
