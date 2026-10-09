import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  jobs,
  mediaAssets,
  modelRuns,
  processingBatches,
  questionnaireResponses,
  sessionConsents,
  sessions,
  syntheses,
  transcripts,
  translations,
  utterances,
} from "@dialect/db";
import { createTestStudy, type TestStudy } from "../sessions/test-support";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { SAMPLE_SEED_MARKER, seedSampleTestSessions } from "./index";

let t: TestServiceContext;
let study: TestStudy;

beforeAll(async () => {
  t = await createTestServiceContext();
  study = await createTestStudy(t.testDb.db, {
    settings: { sourceLanguage: "fi", targetLanguage: "en", autoQueueAsr: true },
  });
});

afterAll(async () => {
  await t.cleanup();
});

describe("seedSampleTestSessions", () => {
  it("creates complete TEST sessions through the real services", async () => {
    const result = await seedSampleTestSessions(t.adminCtx, { count: 3 });
    expect(result.created).toHaveLength(3);
    expect(result.existing).toBe(0);

    const rows = await t.testDb.db.select().from(sessions).where(eq(sessions.studyId, study.study.id));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ mode: "test", status: "completed" });
      expect((row.browserInfoJson as { sampleSeed?: { marker: string } }).sampleSeed?.marker).toBe(SAMPLE_SEED_MARKER);
      expect(await t.testDb.db.select().from(sessionConsents).where(eq(sessionConsents.sessionId, row.id))).toHaveLength(1);
      expect(
        await t.testDb.db.select().from(questionnaireResponses).where(eq(questionnaireResponses.sessionId, row.id)),
      ).toHaveLength(2);
      const recorded = await t.testDb.db.select().from(utterances).where(eq(utterances.sessionId, row.id));
      // Six enabled tasks, and the semi-structured task has two follow-ups.
      expect(recorded).toHaveLength(8);
      expect(recorded.every((utterance) => utterance.status === "submitted")).toBe(true);
      const audio = await t.testDb.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, row.id));
      const sources = audio.filter((asset) => asset.kind === "source_audio");
      expect(sources).toHaveLength(8);
      for (const asset of sources) expect(await t.storage.exists(asset.storageKey)).toBe(true);
    }

    const [first, second, third] = result.created;
    expect(first).toMatchObject({ index: 1, utterances: 8, humanTranscripts: 16, translations: 18, syntheses: 18 });
    expect(second).toMatchObject({ index: 2, humanTranscripts: 16, translations: 18 });
    expect(third).toMatchObject({ index: 3, humanTranscripts: 0, translations: 0, syntheses: 0 });

    const statusesOf = async (sessionId: string) => {
      const found = await t.testDb.db
        .select({ type: transcripts.type, status: transcripts.status })
        .from(transcripts)
        .innerJoin(utterances, eq(utterances.id, transcripts.utteranceId))
        .where(eq(utterances.sessionId, sessionId));
      return found;
    };
    const firstTranscripts = await statusesOf(first!.sessionId);
    expect(firstTranscripts.filter((row) => row.type === "human_dialect").every((row) => row.status === "verified")).toBe(true);
    expect(firstTranscripts.filter((row) => row.type === "asr")).toHaveLength(8);
    const secondTranscripts = await statusesOf(second!.sessionId);
    expect(secondTranscripts.filter((row) => row.type === "normalized").every((row) => row.status === "draft")).toBe(true);
    expect(await statusesOf(third!.sessionId)).toHaveLength(0);

    // Every model output is mock output in a test batch.
    const batches = await t.testDb.db.select().from(processingBatches).where(eq(processingBatches.studyId, study.study.id));
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.dataMode === "test" && batch.status === "completed")).toBe(true);
    const runs = await t.testDb.db.select().from(modelRuns);
    expect(runs.length).toBe(2 * (8 + 18 + 18));
    expect(runs.every((run) => run.provider === "mock" && run.status === "succeeded")).toBe(true);
    expect(await t.testDb.db.select().from(translations)).toHaveLength(36);
    expect(await t.testDb.db.select().from(syntheses)).toHaveLength(36);
    // The automatic ASR jobs of the sample recordings do not stay in the queue.
    const queued = (await t.testDb.db.select().from(jobs)).filter((job) => job.status === "queued" && job.type === "asr");
    expect(queued).toHaveLength(0);
  }, 120_000);

  it("creates nothing when it runs again, and only adds what is missing for a larger count", async () => {
    const before = await t.testDb.db.select().from(sessions);
    const again = await seedSampleTestSessions(t.adminCtx, { count: 3 });
    expect(again.created).toHaveLength(0);
    expect(again.existing).toBe(3);
    expect(await t.testDb.db.select().from(sessions)).toHaveLength(before.length);
    expect(await t.testDb.db.select().from(translations)).toHaveLength(36);

    const more = await seedSampleTestSessions(t.adminCtx, { count: 4 });
    expect(more.created.map((session) => session.index)).toEqual([4]);
    const all = await t.testDb.db.select().from(sessions);
    expect(all).toHaveLength(4);
    expect(all.every((session) => session.mode === "test")).toBe(true);
  }, 120_000);
});
