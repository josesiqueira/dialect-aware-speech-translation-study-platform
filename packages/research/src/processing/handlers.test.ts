import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { jobs, mediaAssets, modelRuns, syntheses, transcriptRevisions, transcripts, translations } from "@dialect/db";
import { insertMediaAsset } from "@dialect/db/testing-builders";
import { ffmpegAvailable, parseWavHeader, sha256OfBuffer } from "@dialect/storage";
import { enqueueJob, getJob } from "../jobs/queue";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import { createBatch, getBatch, startBatch } from "./batches";
import { addUtterance, drain, insertConfig, retireConfig, setupEnv, setupResearchEnv, type TestEnv } from "./test-helpers";

// The handlers run through the queue against a database, some with ffmpeg. The
// default of 5 seconds per test is too short when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestServiceContext;
let hasFfmpeg = false;

beforeAll(async () => {
  t = await createTestServiceContext();
  hasFfmpeg = (await ffmpegAvailable()).available;
});
afterAll(async () => {
  await t.cleanup();
});

const db = () => t.testDb.db;
let counter = 0;
const unique = (label: string) => `${label}-${(counter += 1)}`;

async function batchWith(env: TestEnv, translationConfigIds: string[], ttsModelConfigIds: string[] = []) {
  const batch = await createBatch(t.adminCtx, {
    studyId: env.study.id,
    name: unique("handler-batch"),
    transcriptTypes: ["human_dialect"],
    translationModelConfigIds: translationConfigIds,
    ttsModelConfigIds,
  });
  await startBatch(t.adminCtx, batch.id);
  return batch;
}

describe("translation and tts handlers", () => {
  it("retries a retryable failure through the queue: one translation, two runs", async () => {
    const env = await setupResearchEnv(t);
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Jono yrittää uudestaan.", verified: true } } });
    const flaky = await insertConfig(env, {
      key: "translation_retry",
      stage: "translation",
      conditionKey: "retry",
      parameters: { mockFail: "retryable", mockFailTimes: 1 },
      promptText: "Translate after a retry.",
    });
    const batch = await batchWith(env, [flaky.modelConfigId]);

    // First attempt fails and the job goes back to the queue with a backoff delay.
    expect(await drain(t.ctx)).toBe(1);
    const [waiting] = await db().select().from(jobs).where(eq(jobs.processingBatchId, batch.id));
    expect(waiting).toMatchObject({ status: "queued", attempts: 1 });
    expect(waiting!.lastError).toContain("TRANSLATION_PROVIDER_ERROR");
    expect(waiting!.availableAt.getTime()).toBeGreaterThan(t.clock.now().getTime());
    expect((await getBatch(t.adminCtx, batch.id)).status).toBe("running");

    t.clock.advance(10 * 60_000);
    expect(await drain(t.ctx)).toBe(1);

    const done = await getJob(db(), waiting!.id);
    expect(done).toMatchObject({ status: "succeeded", attempts: 2 });
    const rows = await db().select().from(translations).where(eq(translations.processingBatchId, batch.id));
    expect(rows).toHaveLength(1);
    const runs = await db()
      .select()
      .from(modelRuns)
      .where(eq(modelRuns.sourceEntityId, u.revisions.human_dialect!.id))
      .orderBy(modelRuns.attemptNumber);
    expect(runs.map((run) => [run.attemptNumber, run.status, run.errorCode])).toEqual([
      [1, "failed", "TRANSLATION_PROVIDER_ERROR"],
      [2, "succeeded", null],
    ]);
    expect(rows[0]!.modelRunId).toBe(runs[1]!.id);
    expect((await getBatch(t.adminCtx, batch.id)).status).toBe("completed");
  });

  it("creates nothing when a job is delivered again after it succeeded", async () => {
    const env = await setupResearchEnv(t);
    const u = await addUtterance(env, { transcripts: { human_dialect: { text: "Sama työ kahdesti.", verified: true } } });
    const batch = await batchWith(env, [env.ai.configs.translationDefault.id], [env.ai.configs.ttsBaseline.id]);
    expect(await drain(t.ctx)).toBe(2);

    const count = async () => ({
      runs: (await db().select().from(modelRuns).where(eq(modelRuns.processingBatchId, batch.id))).length,
      translations: (await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).length,
      syntheses: (await db().select().from(syntheses).where(eq(syntheses.processingBatchId, batch.id))).length,
      media: t.storage.keys().length,
    });
    const before = await count();
    expect(before).toMatchObject({ runs: 2, translations: 1, syntheses: 1 });

    // The same work arrives again under new job keys (a duplicate delivery).
    const batchJobs = await db().select().from(jobs).where(eq(jobs.processingBatchId, batch.id));
    for (const job of batchJobs) {
      await enqueueJob(db(), {
        type: job.type,
        payload: job.payloadJson,
        idempotencyKey: `${job.idempotencyKey}:duplicate`,
        processingBatchId: batch.id,
        availableAt: t.clock.now(),
      });
    }
    // Enqueueing with the original key returns the existing job.
    const same = await enqueueJob(db(), {
      type: batchJobs[0]!.type,
      payload: batchJobs[0]!.payloadJson,
      idempotencyKey: batchJobs[0]!.idempotencyKey,
      processingBatchId: batch.id,
    });
    expect(same.created).toBe(false);

    expect(await drain(t.ctx)).toBe(2);
    expect(await count()).toEqual(before);
    const all = await db().select().from(jobs).where(eq(jobs.processingBatchId, batch.id));
    expect(all.map((job) => job.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(u.utterance.id).toBeTruthy();
  });

  it("fails the job at once for a provider error that is not retryable", async () => {
    const env = await setupResearchEnv(t);
    await addUtterance(env, { transcripts: { human_dialect: { text: "Pysyvä virhe.", verified: true } } });
    const broken = await insertConfig(env, {
      key: "translation_permanent",
      stage: "translation",
      conditionKey: "permanent",
      parameters: { mockFail: "permanent" },
      promptText: "Translate, never.",
    });
    const batch = await batchWith(env, [broken.modelConfigId], [env.ai.configs.ttsBaseline.id]);
    expect(await drain(t.ctx)).toBe(1);

    const [job] = await db().select().from(jobs).where(eq(jobs.processingBatchId, batch.id));
    expect(job).toMatchObject({ status: "failed", attempts: 1, maxAttempts: 3 });
    // The last job of the batch closes it, with errors.
    const [row] = await db().select().from(jobs).where(eq(jobs.processingBatchId, batch.id));
    expect(row!.finishedAt).not.toBeNull();
    expect((await getBatch(t.adminCtx, batch.id)).status).toBe("completed_with_errors");
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(0);
  });

  it("never translates a revision of another utterance", async () => {
    const env = await setupResearchEnv(t);
    const inBatch = await addUtterance(env, { transcripts: { human_dialect: { text: "Erän lause.", verified: true } } });
    const batch = await createBatch(t.adminCtx, {
      studyId: env.study.id,
      name: unique("membership"),
      transcriptTypes: ["human_dialect"],
      ttsModelConfigIds: [],
    });
    // Added after the batch was created: not part of its selection.
    const outsider = await addUtterance(env, { transcripts: { human_dialect: { text: "Ulkopuolinen lause.", verified: true } } });
    await startBatch(t.adminCtx, batch.id);
    await drain(t.ctx);
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(2);

    const base = { modelConfigId: env.ai.configs.translationDefault.id, processingBatchId: batch.id, repetitionIndex: 1 };
    const wrongUtterance = await enqueueJob(db(), {
      type: "translation",
      // The payload names one utterance but carries a revision of another.
      payload: { ...base, utteranceId: inBatch.utterance.id, sourceTranscriptRevisionId: outsider.revisions.human_dialect!.id },
      idempotencyKey: unique("wrong-utterance"),
      processingBatchId: batch.id,
      availableAt: t.clock.now(),
    });
    const outsideBatch = await enqueueJob(db(), {
      type: "translation",
      payload: { ...base, sourceTranscriptRevisionId: outsider.revisions.human_dialect!.id },
      idempotencyKey: unique("outside-batch"),
      processingBatchId: batch.id,
      availableAt: t.clock.now(),
    });
    const badPayload = await enqueueJob(db(), {
      type: "translation",
      payload: { sourceTranscriptRevisionId: "not-a-uuid" },
      idempotencyKey: unique("bad-payload"),
      availableAt: t.clock.now(),
    });
    expect(await drain(t.ctx)).toBe(3);

    for (const { job } of [wrongUtterance, outsideBatch, badPayload]) {
      const after = await getJob(db(), job.id);
      expect(after).toMatchObject({ status: "failed", attempts: 1 });
      expect(after!.lastError).toContain("VALIDATION_ERROR");
    }
    expect(
      await db().select().from(modelRuns).where(eq(modelRuns.sourceEntityId, outsider.revisions.human_dialect!.id)),
    ).toHaveLength(0);
    expect(await db().select().from(translations).where(eq(translations.processingBatchId, batch.id))).toHaveLength(2);
  });
});

describe("asr handler", () => {
  it("runs automatic ASR with the configuration that is active at run time", async () => {
    const env = await setupResearchEnv(t);
    const u = await addUtterance(env, { sessionStatus: "recording" });
    const { job } = await enqueueJob(db(), {
      type: "asr",
      payload: { utteranceId: u.utterance.id, mediaAssetId: u.media.id, trigger: "auto_on_upload" },
      idempotencyKey: `asr:auto:${u.utterance.id}`,
      availableAt: t.clock.now(),
    });
    expect(await drain(t.ctx)).toBe(1);

    expect(await getJob(db(), job.id)).toMatchObject({ status: "succeeded", attempts: 1 });
    const [run] = await db().select().from(modelRuns).where(eq(modelRuns.sourceEntityId, u.utterance.id));
    expect(run).toMatchObject({
      stage: "asr",
      status: "succeeded",
      modelConfigId: env.ai.configs.asrDefault.id,
      processingBatchId: null,
    });
    const [transcript] = await db().select().from(transcripts).where(eq(transcripts.utteranceId, u.utterance.id));
    expect(transcript).toMatchObject({ type: "asr" });
    const revisions = await db().select().from(transcriptRevisions).where(eq(transcriptRevisions.transcriptId, transcript!.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ sourceModelRunId: run!.id, isCurrent: true, createdByType: "model" });
    // Automatic ASR never starts a translation.
    expect(await db().select().from(jobs).where(eq(jobs.type, "translation")).then((rows) => rows.filter((row) => JSON.stringify(row.payloadJson).includes(u.utterance.id)))).toHaveLength(0);
  });

  it("fails with CONFIGURATION_MISSING, without a retry, when no ASR configuration is active", async () => {
    const env = await setupResearchEnv(t);
    const u = await addUtterance(env);
    await retireConfig(env, env.ai.configs.asrDefault.id);
    const { job } = await enqueueJob(db(), {
      type: "asr",
      payload: { utteranceId: u.utterance.id, mediaAssetId: u.media.id, trigger: "auto_on_upload" },
      idempotencyKey: `asr:auto:${u.utterance.id}`,
      availableAt: t.clock.now(),
    });
    expect(await drain(t.ctx)).toBe(1);
    const after = await getJob(db(), job.id);
    expect(after).toMatchObject({ status: "failed", attempts: 1 });
    expect(after!.lastError).toContain("CONFIGURATION_MISSING");
    expect(after!.lastError).toContain("asr_default");
    // The recording is untouched and can be transcribed later.
    expect(await t.storage.exists(u.media.storageKey)).toBe(true);
    expect(await db().select().from(transcripts).where(eq(transcripts.utteranceId, u.utterance.id))).toHaveLength(0);
  });
});

describe("asr handler with AUTO_TRANSLATE_AFTER_ASR", () => {
  it("translates and synthesizes the recording in its own batch after automatic ASR", async () => {
    vi.stubEnv("AUTO_TRANSLATE_AFTER_ASR", "true");
    try {
      const env = await setupResearchEnv(t);
      const u = await addUtterance(env, { sessionStatus: "recording" });
      await enqueueJob(db(), {
        type: "asr",
        payload: { utteranceId: u.utterance.id, mediaAssetId: u.media.id, trigger: "auto_on_upload" },
        idempotencyKey: `asr:auto:${u.utterance.id}`,
        availableAt: t.clock.now(),
      });
      await drain(t.ctx);

      const [revision] = await db()
        .select({ id: transcriptRevisions.id })
        .from(transcriptRevisions)
        .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
        .where(and(eq(transcripts.utteranceId, u.utterance.id), eq(transcripts.type, "asr")));
      const made = await db().select().from(translations).where(eq(translations.sourceTranscriptRevisionId, revision!.id));
      // One translation per active condition (default and preservation), each in the automatic batch.
      expect(made.map((row) => row.conditionKey).sort()).toEqual(["default", "preservation"]);
      expect(new Set(made.map((row) => row.processingBatchId)).size).toBe(1);
      const batch = await getBatch(t.adminCtx, made[0]!.processingBatchId);
      expect(batch).toMatchObject({ status: "completed", dataMode: "research", utteranceCount: 1 });
      expect(batch.name.startsWith("Auto ")).toBe(true);
      const madeTts = await db().select().from(syntheses).where(eq(syntheses.processingBatchId, batch.id));
      expect(madeTts).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("asr handler and the mock provider", () => {
  it("refuses automatic ASR with a mock configuration for a research session, and runs it for a test session", async () => {
    const env = await setupEnv(t, { provider: "mock" });
    const research = await addUtterance(env, { sessionStatus: "recording" });
    const test = await addUtterance(env, { mode: "test", sessionStatus: "recording" });
    const enqueue = (u: typeof research) =>
      enqueueJob(db(), {
        type: "asr",
        payload: { utteranceId: u.utterance.id, mediaAssetId: u.media.id, trigger: "auto_on_upload" },
        idempotencyKey: `asr:auto:${u.utterance.id}`,
        availableAt: t.clock.now(),
      });
    const refused = await enqueue(research);
    const allowed = await enqueue(test);
    expect(await drain(t.ctx)).toBe(2);

    const after = await getJob(db(), refused.job.id);
    // Not retried: someone has to activate a real configuration first.
    expect(after).toMatchObject({ status: "failed", attempts: 1 });
    expect(after!.lastError).toContain("CONFIGURATION_MISSING");
    expect(after!.lastError).toContain("uses the mock provider");
    expect(await db().select().from(modelRuns).where(eq(modelRuns.sourceEntityId, research.utterance.id))).toHaveLength(0);
    expect(await db().select().from(transcripts).where(eq(transcripts.utteranceId, research.utterance.id))).toHaveLength(0);
    expect(await t.storage.exists(research.media.storageKey)).toBe(true);

    expect(await getJob(db(), allowed.job.id)).toMatchObject({ status: "succeeded" });
    const [run] = await db().select().from(modelRuns).where(eq(modelRuns.sourceEntityId, test.utterance.id));
    expect(run).toMatchObject({ provider: "mock", status: "succeeded" });
  });
});

describe("derive_wav handler", () => {
  it("stores a derived WAV next to the unchanged compressed recording", async (context) => {
    if (!hasFfmpeg) return context.skip();
    const env = await setupResearchEnv(t);
    const u = await addUtterance(env);

    const directory = mkdtempSync(path.join(os.tmpdir(), "dialect-processing-"));
    let compressed: Buffer;
    try {
      const file = path.join(directory, "sample.webm");
      execFileSync(
        "ffmpeg",
        ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000", "-c:a", "libopus", file],
        { stdio: "pipe" },
      );
      compressed = readFileSync(file);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const rawId = randomUUID();
    const rawKey = `studies/${env.study.slug}/sessions/${u.session.id}/utterances/${u.utterance.id}/source/${rawId}.webm`;
    const stored = await t.storage.put({ key: rawKey, body: compressed, contentType: "audio/webm" });
    const raw = await insertMediaAsset(db(), {
      id: rawId,
      studyId: env.study.id,
      sessionId: u.session.id,
      utteranceId: u.utterance.id,
      kind: "source_audio_raw",
      storageDriver: stored.driver,
      storageKey: rawKey,
      mimeType: "audio/webm",
      container: "webm",
      codec: "opus",
      bitDepth: null,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      captureMethod: "media_recorder",
      captureQualityClass: "compressed_fallback",
    });

    const enqueue = (key: string) =>
      enqueueJob(db(), { type: "derive_wav", payload: { mediaAssetId: raw.id }, idempotencyKey: key, availableAt: t.clock.now() });
    const first = await enqueue(`derive_wav:${raw.id}`);
    expect(await drain(t.ctx)).toBe(1);
    expect(await getJob(db(), first.job.id)).toMatchObject({ status: "succeeded" });

    const derivedRows = await db()
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.derivedFromMediaAssetId, raw.id), eq(mediaAssets.kind, "source_audio_derived")));
    expect(derivedRows).toHaveLength(1);
    const derived = derivedRows[0]!;
    expect(derived).toMatchObject({
      utteranceId: u.utterance.id,
      sessionId: u.session.id,
      mimeType: "audio/wav",
      container: "wav",
      codec: "pcm_s16le",
      sampleRateHz: 48000,
      channels: 1,
      bitDepth: 16,
      captureQualityClass: "compressed_fallback",
    });
    expect(derived.metadataJson.derivation).toMatchObject({ tool: "ffmpeg", command: expect.stringContaining("pcm_s16le") });
    expect(derived.storageKey).toBe(
      `studies/${env.study.slug}/sessions/${u.session.id}/utterances/${u.utterance.id}/source/${derived.id}.wav`,
    );
    const bytes = Buffer.concat(await (await t.storage.get(derived.storageKey)).toArray());
    expect(sha256OfBuffer(bytes)).toBe(derived.sha256);
    expect(parseWavHeader(bytes).sampleRateHz).toBe(48000);

    // The source file and its row are unchanged.
    const sourceBytes = Buffer.concat(await (await t.storage.get(rawKey)).toArray());
    expect(sourceBytes.equals(compressed)).toBe(true);
    const [rawAfter] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, raw.id));
    expect(rawAfter).toMatchObject({ kind: "source_audio_raw", sha256: stored.sha256, derivedFromMediaAssetId: null });

    // A second delivery creates no second derived asset and no second file.
    const keysBefore = t.storage.keys().length;
    await enqueue(`derive_wav:${raw.id}:again`);
    expect(await drain(t.ctx)).toBe(1);
    expect(
      await db().select().from(mediaAssets).where(eq(mediaAssets.derivedFromMediaAssetId, raw.id)),
    ).toHaveLength(1);
    expect(t.storage.keys()).toHaveLength(keysBefore);
  });

  it("refuses a file that is not a compressed source recording", async () => {
    const env = await setupResearchEnv(t);
    const u = await addUtterance(env);
    const { job } = await enqueueJob(db(), {
      type: "derive_wav",
      payload: { mediaAssetId: u.media.id },
      idempotencyKey: `derive_wav:${u.media.id}`,
      availableAt: t.clock.now(),
    });
    expect(await drain(t.ctx)).toBe(1);
    const after = await getJob(db(), job.id);
    expect(after).toMatchObject({ status: "failed", attempts: 1 });
    expect(after!.lastError).toContain("VALIDATION_ERROR");
  });
});
