import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, sessions, studies } from "@dialect/db";
import {
  insertActiveAiConfigs,
  insertModelRun,
  insertPublishedProtocol,
  insertSession,
  insertSessionWithUtterance,
  insertStudy,
} from "@dialect/db/testing-builders";
import { enqueueJob, recordWorkerHeartbeat } from "../jobs";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { getDashboard } from "./dashboard";
import { processUtterance } from "./test-helpers";

let t: TestServiceContext;
let studyId: string;
let protocolVersionNumber: number;

// The test clock is 2026-10-03T12:00:00Z. In Europe/Helsinki that is 15:00.
const today = new Date("2026-10-03T09:00:00.000Z");
const yesterday = new Date("2026-10-02T09:00:00.000Z");
// 22:30 UTC on the 2nd is already the 3rd in Helsinki.
const lateYesterdayUtc = new Date("2026-10-02T22:30:00.000Z");

beforeAll(async () => {
  t = await createTestServiceContext();
  const db = t.ctx.db;
  const study = await insertStudy(db, {
    settingsJson: { adminTimezone: "Europe/Helsinki", allowNewSessions: true },
  });
  studyId = study.id;
  const { protocol } = await insertPublishedProtocol(db, { studyId });
  protocolVersionNumber = protocol.versionNumber;
  const base = { studyId, protocolVersionId: protocol.id };
  const ai = await insertActiveAiConfigs(db, { studyId });

  // Research: two completed, one abandoned, one withdrawn, one recording, one not consented.
  const reviewed = await insertSessionWithUtterance(db, {
    ...base,
    session: { status: "completed", startedAt: today, completedAt: new Date("2026-10-03T09:20:00.000Z") },
    utterance: { durationMs: 4000 },
  });
  await processUtterance(db, { studyId, utteranceId: reviewed.utterance.id, ai });
  const unreviewed = await insertSessionWithUtterance(db, {
    ...base,
    session: { status: "completed", startedAt: lateYesterdayUtc, completedAt: new Date("2026-10-02T23:00:00.000Z") },
    utterance: { durationMs: 6000, flagged: true },
  });
  await insertSessionWithUtterance(db, {
    ...base,
    session: { status: "abandoned", startedAt: yesterday, abandonedAt: yesterday, flagged: true },
    utterance: { durationMs: 1000 },
  });
  await insertSession(db, { ...base, status: "withdrawn", startedAt: yesterday, consentedAt: yesterday });
  await insertSession(db, { ...base, status: "recording", startedAt: today, consentedAt: today });
  await insertSession(db, { ...base, status: "created", startedAt: yesterday });

  // Demo and test sessions must never be counted as research.
  await insertSessionWithUtterance(db, {
    ...base,
    session: { mode: "demo", status: "completed", startedAt: today, completedAt: today },
    utterance: { durationMs: 50_000 },
  });
  for (const flagged of [true, false]) {
    await insertSessionWithUtterance(db, {
      ...base,
      session: { mode: "test", status: "completed", startedAt: today, completedAt: today, flagged },
      utterance: { durationMs: 70_000, flagged },
    });
  }

  // One failed run that was retried successfully, one that is still open.
  const retried = {
    stage: "asr" as const,
    sourceEntityType: "utterance",
    sourceEntityId: reviewed.utterance.id,
  };
  await insertModelRun(db, {
    ...retried,
    status: "failed",
    errorCode: "ASR_PROVIDER_ERROR",
    startedAt: new Date("2026-10-03T09:30:00.000Z"),
  });
  await insertModelRun(db, { ...retried, status: "succeeded", startedAt: new Date("2026-10-03T09:31:00.000Z") });
  await insertModelRun(db, {
    stage: "asr",
    sourceEntityType: "utterance",
    sourceEntityId: unreviewed.utterance.id,
    status: "failed",
    errorCode: "ASR_PROVIDER_ERROR",
    errorMessage: "The provider timed out.",
    startedAt: new Date("2026-10-03T10:00:00.000Z"),
  });
});

afterAll(async () => {
  await t.cleanup();
});

describe("getDashboard", () => {
  it("counts research sessions only and reports demo and test separately", async () => {
    const dashboard = await getDashboard(t.adminCtx, studyId);

    expect(dashboard.participants).toEqual({
      started: 6,
      consented: 5,
      completed: 2,
      abandoned: 1,
      withdrawn: 1,
      inProgress: 2,
      completionRate: 2 / 6,
    });
    // Research utterances: 4000 + 6000 + 1000 ms. The demo and test recordings are far longer.
    expect(dashboard.utterancesSubmitted).toBe(3);
    expect(dashboard.sourceAudioDurationMs).toBe(11_000);
    expect(dashboard.flagged).toEqual({ sessions: 1, utterances: 1 });
    expect(dashboard.otherModes).toEqual({
      demo: { sessions: 1, completed: 1, utterances: 1 },
      test: { sessions: 2, completed: 2, utterances: 2 },
    });
  });

  it("does not count research sessions that were abandoned before consent", async () => {
    const before = await getDashboard(t.adminCtx, studyId, { days: 3 });
    const [existing] = await t.ctx.db
      .select({ protocolVersionId: sessions.protocolVersionId })
      .from(sessions)
      .where(eq(sessions.studyId, studyId))
      .limit(1);
    for (let index = 0; index < 5; index += 1) {
      await insertSession(t.ctx.db, {
        studyId,
        protocolVersionId: existing!.protocolVersionId,
        status: "abandoned",
        startedAt: new Date("2026-10-03T08:00:00.000Z"),
        abandonedAt: new Date("2026-10-03T08:31:00.000Z"),
        consentedAt: null,
      });
    }
    const after = await getDashboard(t.adminCtx, studyId, { days: 3 });
    expect(after.participants).toEqual(before.participants);
    expect(after.sessionsToday).toBe(before.sessionsToday);
    expect(after.sessionsPerDay).toEqual(before.sessionsPerDay);
  });

  it("counts utterances that lack a verified B or C as awaiting review", async () => {
    const dashboard = await getDashboard(t.adminCtx, studyId);
    // Three research utterances, one of them has verified B and C.
    expect(dashboard.awaitingTranscriptionReview).toBe(2);
  });

  it("uses the admin time zone for today and for the sessions per day", async () => {
    const dashboard = await getDashboard(t.adminCtx, studyId, { days: 3 });
    expect(dashboard.adminTimezone).toBe("Europe/Helsinki");
    // Two sessions started on the 3rd in UTC, plus the one at 22:30 UTC on the 2nd.
    expect(dashboard.sessionsToday).toBe(3);
    expect(dashboard.sessionsPerDay).toEqual([
      { date: "2026-10-01", research: 0, demo: 0, test: 0 },
      { date: "2026-10-02", research: 3, demo: 0, test: 0 },
      { date: "2026-10-03", research: 3, demo: 1, test: 2 },
    ]);
  });

  it("reports open processing errors, not failures that a retry resolved", async () => {
    await enqueueJob(t.ctx.db, { type: "asr", payload: {}, idempotencyKey: "dashboard-test-job" });
    await t.ctx.db
      .update(jobs)
      .set({ status: "failed", lastError: "boom" })
      .where(eq(jobs.idempotencyKey, "dashboard-test-job"));
    // A cancelled job is not an error: the sample session seed cancels the
    // automatic transcription jobs it replaces.
    await enqueueJob(t.ctx.db, { type: "asr", payload: {}, idempotencyKey: "dashboard-test-cancelled-job" });
    await t.ctx.db
      .update(jobs)
      .set({ status: "cancelled", lastError: "Cancelled by the development seed (sample session)." })
      .where(eq(jobs.idempotencyKey, "dashboard-test-cancelled-job"));
    const dashboard = await getDashboard(t.adminCtx, studyId);
    expect(dashboard.processingErrors).toEqual({ failedJobs: 1, failedModelRuns: 1, total: 2 });
    expect(dashboard.recent.processingErrors.map((entry) => entry.kind).sort()).toEqual(["job", "model_run", "model_run"]);
  });

  it("shows the study state, the protocol, the active AI configurations and the health checks", async () => {
    let dashboard = await getDashboard(t.adminCtx, studyId);
    expect(dashboard.study).toMatchObject({ status: "active", allowNewSessions: true, acceptingNewSessions: true });
    expect(dashboard.status.protocol?.versionNumber).toBe(protocolVersionNumber);
    expect(dashboard.status.configs.asr).toEqual([
      expect.objectContaining({
        key: "asr_default",
        versionNumber: 1,
        provider: "mock",
        modelId: "mock-asr",
        promptKey: "asr_context",
        promptVersionNumber: 1,
      }),
    ]);
    expect(dashboard.status.configs.translation.map((config) => config.key)).toEqual([
      "translation_default",
      "translation_preserve",
    ]);
    expect(dashboard.status.configs.tts.map((config) => config.key)).toEqual(["tts_baseline"]);
    expect(dashboard.status.database).toEqual({ ok: true });
    expect(dashboard.status.storage).toEqual({ ok: true, driver: "memory" });
    expect(dashboard.status.worker.healthy).toBe(false);

    await recordWorkerHeartbeat(t.ctx.db, { workerId: "worker-test", now: t.clock.now(), info: {} });
    await t.ctx.db.update(studies).set({ status: "paused" }).where(eq(studies.id, studyId));
    dashboard = await getDashboard(t.adminCtx, studyId);
    expect(dashboard.status.worker).toMatchObject({ healthy: true, workerCount: 1 });
    expect(dashboard.study).toMatchObject({ status: "paused", acceptingNewSessions: false });
    await t.ctx.db.update(studies).set({ status: "active" }).where(eq(studies.id, studyId));
  });

  it("lists recent activity with the mode of each session", async () => {
    const dashboard = await getDashboard(t.adminCtx, studyId);
    expect(dashboard.recent.completedSessions).toHaveLength(5);
    expect(dashboard.recent.completedSessions.map((session) => session.utteranceCount)).toEqual([1, 1, 1, 1, 1]);
    expect(new Set(dashboard.recent.completedSessions.map((session) => session.mode))).toEqual(
      new Set(["research", "demo", "test"]),
    );
    // B and C of the reviewed utterance.
    expect(dashboard.recent.transcriptVerifications.map((entry) => entry.transcriptType).sort()).toEqual([
      "human_dialect",
      "normalized",
    ]);
    expect(dashboard.recent.transcriptVerifications[0]?.verifiedByLabel).toBe("JS");
  });

  it("contains no outcome comparison and no participant background data", async () => {
    const dashboard = await getDashboard(t.adminCtx, studyId);
    const text = JSON.stringify(dashboard).toLowerCase();
    for (const word of ["effect", "preservation_vs", "significance", "p_value", "mean_score", "questionnaire", "answer"]) {
      expect(text).not.toContain(word);
    }
    expect(dashboard.excluded).toEqual({ sessions: 0, utterances: 0 });
  });

  it("rejects an unknown study", async () => {
    await expect(getDashboard(t.adminCtx, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
