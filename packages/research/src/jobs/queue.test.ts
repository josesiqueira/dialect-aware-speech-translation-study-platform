import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, jobs, processingBatches } from "@dialect/db";
import { createTestDatabase, type TestDatabase } from "@dialect/db/testing";
import { AppError } from "@dialect/domain";
import {
  cancelQueuedJobsForBatch,
  claimNextJob,
  completeJob,
  computeBackoffMs,
  enqueueJob,
  enqueueJobs,
  extendJobLock,
  failJob,
  getJob,
  getJobCountsForBatch,
  getQueueStats,
  listJobs,
  releaseStaleJobs,
  retryFailedJobsForBatch,
  retryJob,
  sanitizeErrorMessage,
} from "./queue";
import { createBatch } from "./test-helpers";

const T0 = new Date("2026-10-03T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const noJitter = { random: () => 0 };

let t: TestDatabase;
let keyCounter = 0;
const key = (label = "job") => `${label}-${(keyCounter += 1)}`;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(jobs);
});

async function enqueue(overrides: Partial<Parameters<typeof enqueueJob>[1]> = {}) {
  const { job } = await enqueueJob(t.db, {
    type: "asr",
    payload: { utteranceId: "u" },
    idempotencyKey: key(),
    availableAt: T0,
    ...overrides,
  });
  return job;
}

describe("enqueueJob", () => {
  it("returns the existing job when the same idempotency key is enqueued twice", async () => {
    const input = { type: "asr", payload: { utteranceId: "u1" }, idempotencyKey: key("same") };
    const first = await enqueueJob(t.db, input);
    const second = await enqueueJob(t.db, { ...input, payload: { utteranceId: "other" } });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.payloadJson).toEqual({ utteranceId: "u1" });
    expect(await t.db.select().from(jobs)).toHaveLength(1);
    expect(first.job.status).toBe("queued");
    expect(first.job.attempts).toBe(0);
    expect(first.job.maxAttempts).toBe(3);
  });

  it("creates one row when the same key is enqueued concurrently", async () => {
    const input = { type: "asr", payload: {}, idempotencyKey: key("race") };
    const results = await Promise.all(Array.from({ length: 8 }, () => enqueueJob(t.db, input)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(await t.db.select().from(jobs)).toHaveLength(1);
  });

  it("leaves nothing behind when the caller's transaction rolls back", async () => {
    const idempotencyKey = key("rollback");
    await expect(
      t.db.transaction(async (tx) => {
        const result = await enqueueJob(tx, { type: "asr", payload: {}, idempotencyKey });
        expect(result.created).toBe(true);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await t.db.select().from(jobs)).toHaveLength(0);
  });

  it("rejects an invalid maxAttempts", async () => {
    await expect(
      enqueueJob(t.db, { type: "asr", payload: {}, idempotencyKey: key(), maxAttempts: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("enqueueJobs", () => {
  it("inserts new jobs and returns existing ones without duplicates", async () => {
    const existing = await enqueue({ idempotencyKey: "bulk-a" });
    const result = await enqueueJobs(t.db, [
      { type: "translation", payload: {}, idempotencyKey: "bulk-a" },
      { type: "translation", payload: {}, idempotencyKey: "bulk-b" },
      { type: "translation", payload: {}, idempotencyKey: "bulk-c" },
      { type: "translation", payload: {}, idempotencyKey: "bulk-b" },
    ]);
    expect(result.createdCount).toBe(2);
    expect(result.jobs.map((job) => job.idempotencyKey)).toEqual(["bulk-a", "bulk-b", "bulk-c", "bulk-b"]);
    expect(result.jobs[0]!.id).toBe(existing.id);
    expect(result.jobs[0]!.type).toBe("asr");
    expect(result.jobs[1]!.id).toBe(result.jobs[3]!.id);
    expect(await t.db.select().from(jobs)).toHaveLength(3);
  });

  it("handles more rows than one insert statement carries", async () => {
    const inputs = Array.from({ length: 1201 }, (_, index) => ({
      type: "tts",
      payload: { index },
      idempotencyKey: `many-${index}`,
    }));
    const result = await enqueueJobs(t.db, inputs);
    expect(result.createdCount).toBe(1201);
    expect(result.jobs).toHaveLength(1201);
    const again = await enqueueJobs(t.db, inputs);
    expect(again.createdCount).toBe(0);
    expect((await listJobs(t.db, { limit: 1 })).total).toBe(1201);
  });
});

describe("claimNextJob", () => {
  it("claims the oldest available job and marks it running", async () => {
    const later = await enqueue({ availableAt: at(1000) });
    const earlier = await enqueue({ availableAt: at(0) });
    await enqueue({ availableAt: at(60_000) });

    const first = await claimNextJob(t.db, { workerId: "w1", now: at(2000) });
    expect(first?.id).toBe(earlier.id);
    expect(first?.status).toBe("running");
    expect(first?.lockedBy).toBe("w1");
    expect(first?.lockedAt).toEqual(at(2000));
    expect(first?.attempts).toBe(1);

    const second = await claimNextJob(t.db, { workerId: "w1", now: at(2000) });
    expect(second?.id).toBe(later.id);
    // The third job is not available yet.
    expect(await claimNextJob(t.db, { workerId: "w1", now: at(2000) })).toBeNull();
  });

  it("filters by job type", async () => {
    await enqueue({ type: "asr" });
    const tts = await enqueue({ type: "tts" });
    expect((await claimNextJob(t.db, { workerId: "w1", types: ["tts", "export"], now: at(0) }))?.id).toBe(tts.id);
    expect(await claimNextJob(t.db, { workerId: "w1", types: ["tts"], now: at(0) })).toBeNull();
    expect(await claimNextJob(t.db, { workerId: "w1", types: [], now: at(0) })).toBeNull();
  });

  it("filters by processing batch", async () => {
    const batchA = await createBatch(t.db);
    const batchB = await createBatch(t.db);
    await enqueue({ processingBatchId: batchA });
    const inB = await enqueue({ processingBatchId: batchB });
    const claimed = await claimNextJob(t.db, { workerId: "w1", processingBatchId: batchB, now: at(0) });
    expect(claimed?.id).toBe(inB.id);
  });

  it("gives each of 20 jobs to exactly one of 5 concurrent claimers", async () => {
    await enqueueJobs(
      t.db,
      Array.from({ length: 20 }, (_, index) => ({
        type: "asr",
        payload: { index },
        idempotencyKey: `concurrent-${index}`,
        availableAt: T0,
      })),
    );

    // Each claimer has its own connection, like separate worker replicas.
    const claimers = Array.from({ length: 5 }, (_, index) => ({
      workerId: `replica-${index}`,
      handle: createDatabase(t.url, { max: 1 }),
    }));
    try {
      const claimedPerWorker = await Promise.all(
        claimers.map(async ({ workerId, handle }) => {
          const claimed: string[] = [];
          for (;;) {
            const job = await claimNextJob(handle.db, { workerId, now: at(1000) });
            if (!job) return claimed;
            claimed.push(job.id);
            expect(await completeJob(handle.db, job.id, workerId, at(2000))).not.toBeNull();
          }
        }),
      );
      const all = claimedPerWorker.flat();
      expect(all).toHaveLength(20);
      expect(new Set(all).size).toBe(20);
    } finally {
      await Promise.all(claimers.map(({ handle }) => handle.close()));
    }

    const rows = await t.db.select().from(jobs);
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.status === "succeeded" && row.attempts === 1)).toBe(true);
  });

  it("does not claim jobs of a cancelled batch", async () => {
    const batchId = await createBatch(t.db, "running");
    await enqueue({ processingBatchId: batchId });
    await t.db.update(processingBatches).set({ status: "cancelled" }).where(eq(processingBatches.id, batchId));
    expect(await claimNextJob(t.db, { workerId: "w1", now: at(0) })).toBeNull();

    // A job without a batch is still claimed.
    const free = await enqueue();
    expect((await claimNextJob(t.db, { workerId: "w1", now: at(0) }))?.id).toBe(free.id);
  });
});

describe("completeJob", () => {
  it("marks the job succeeded and clears the lock", async () => {
    const job = await enqueue();
    await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    const done = await completeJob(t.db, job.id, "w1", at(500));
    expect(done).toMatchObject({ status: "succeeded", lockedAt: null, lockedBy: null, attempts: 1 });
    expect(done?.finishedAt).toEqual(at(500));
  });

  it("refuses a worker that does not hold the lock", async () => {
    const job = await enqueue();
    await claimNextJob(t.db, { workerId: "w1", now: at(0) });

    expect(await completeJob(t.db, job.id, "w2", at(500))).toBeNull();
    expect(await failJob(t.db, job.id, "w2", { message: "x", retryable: false }, at(500))).toBeNull();
    expect(await extendJobLock(t.db, job.id, "w2", at(500))).toBe(false);
    expect(await getJob(t.db, job.id)).toMatchObject({ status: "running", lockedBy: "w1", lastError: null });

    // A job that is not running cannot be completed either.
    const queued = await enqueue();
    expect(await completeJob(t.db, queued.id, "w1", at(500))).toBeNull();
  });
});

describe("failJob", () => {
  it("requeues a retryable failure with exponential backoff until attempts run out", async () => {
    const job = await enqueue({ maxAttempts: 3 });

    await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    const first = await failJob(t.db, job.id, "w1", { message: "timeout 1", retryable: true }, at(100), noJitter);
    expect(first).toMatchObject({ status: "queued", attempts: 1, lockedBy: null, lastError: "timeout 1" });
    expect(first?.availableAt).toEqual(at(100 + 5_000));
    expect(first?.finishedAt).toBeNull();

    // Not available before the backoff delay has passed.
    expect(await claimNextJob(t.db, { workerId: "w1", now: at(5_000) })).toBeNull();
    expect((await claimNextJob(t.db, { workerId: "w1", now: at(5_100) }))?.attempts).toBe(2);
    const second = await failJob(t.db, job.id, "w1", { message: "timeout 2", retryable: true }, at(6_000), noJitter);
    expect(second?.status).toBe("queued");
    expect(second?.availableAt).toEqual(at(6_000 + 10_000));

    expect((await claimNextJob(t.db, { workerId: "w1", now: at(20_000) }))?.attempts).toBe(3);
    const third = await failJob(t.db, job.id, "w1", { message: "timeout 3", retryable: true }, at(21_000), noJitter);
    expect(third).toMatchObject({ status: "failed", attempts: 3, lastError: "timeout 3", lockedBy: null });
    expect(third?.finishedAt).toEqual(at(21_000));
    expect(await claimNextJob(t.db, { workerId: "w1", now: at(10_000_000) })).toBeNull();
  });

  it("fails a non-retryable error at once", async () => {
    const job = await enqueue({ maxAttempts: 5 });
    await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    const failed = await failJob(t.db, job.id, "w1", { message: "bad input", retryable: false }, at(100));
    expect(failed).toMatchObject({ status: "failed", attempts: 1, lastError: "bad input" });
    expect(failed?.finishedAt).toEqual(at(100));
  });

  it("stores a truncated message without secrets", async () => {
    const job = await enqueue();
    await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    const message = `Incorrect API key provided: sk-proj-abc123DEF456ghi789. ${"x".repeat(3000)}`;
    const failed = await failJob(t.db, job.id, "w1", { message, retryable: false }, at(100));
    expect(failed?.lastError).not.toContain("sk-proj");
    expect(failed?.lastError).toContain("[redacted]");
    expect(failed?.lastError?.length).toBeLessThanOrEqual(1000);
  });
});

describe("computeBackoffMs and sanitizeErrorMessage", () => {
  it("doubles the delay, caps it and adds bounded jitter", () => {
    expect(computeBackoffMs(1, noJitter)).toBe(5_000);
    expect(computeBackoffMs(2, noJitter)).toBe(10_000);
    expect(computeBackoffMs(3, noJitter)).toBe(20_000);
    expect(computeBackoffMs(7, noJitter)).toBe(300_000);
    expect(computeBackoffMs(500, noJitter)).toBe(300_000);
    expect(computeBackoffMs(1, { random: () => 0.5 })).toBe(5_500);
    expect(computeBackoffMs(500, { random: () => 0.999999 })).toBeLessThanOrEqual(360_000);
    expect(computeBackoffMs(2, { baseMs: 100, capMs: 150, random: () => 0 })).toBe(150);
    for (let index = 0; index < 50; index += 1) {
      const delay = computeBackoffMs(2);
      expect(delay).toBeGreaterThanOrEqual(10_000);
      expect(delay).toBeLessThanOrEqual(12_000);
    }
  });

  it("removes key material", () => {
    expect(sanitizeErrorMessage("failed with Bearer abcdefghijklmnop")).toBe("failed with Bearer [redacted]");
    expect(sanitizeErrorMessage("connect postgresql://user:hunter2@db:5432/x failed")).toBe(
      "connect postgresql://[redacted]@db:5432/x failed",
    );
    expect(sanitizeErrorMessage("OPENAI_API_KEY=abc123 rejected")).toBe("OPENAI_API_KEY=[redacted] rejected");
    expect(sanitizeErrorMessage("the value my-own-secret-value leaked", ["my-own-secret-value"])).toBe(
      "the value [redacted] leaked",
    );
    expect(sanitizeErrorMessage("Rate limit reached, 429")).toBe("Rate limit reached, 429");
  });
});

describe("releaseStaleJobs", () => {
  it("requeues a stale running job with attempts left and fails one without", async () => {
    const retryable = await enqueue({ maxAttempts: 2 });
    const exhausted = await enqueue({ maxAttempts: 1 });
    const fresh = await enqueue();
    expect((await claimNextJob(t.db, { workerId: "crashed", now: at(0) }))?.id).toBe(retryable.id);
    expect((await claimNextJob(t.db, { workerId: "crashed", now: at(0) }))?.id).toBe(exhausted.id);
    expect((await claimNextJob(t.db, { workerId: "alive", now: at(50_000) }))?.id).toBe(fresh.id);

    // Not stale yet.
    expect(await releaseStaleJobs(t.db, { lockTimeoutMs: 60_000, now: at(30_000) })).toMatchObject({
      requeued: 0,
      failed: 0,
    });

    const released = await releaseStaleJobs(t.db, { lockTimeoutMs: 60_000, now: at(61_000) });
    expect(released).toMatchObject({ requeued: 1, failed: 1 });
    expect(released.jobIds.sort()).toEqual([retryable.id, exhausted.id].sort());

    const requeued = await getJob(t.db, retryable.id);
    expect(requeued).toMatchObject({ status: "queued", attempts: 1, lockedAt: null, lockedBy: null, finishedAt: null });
    expect(requeued?.availableAt).toEqual(at(61_000));
    expect(requeued?.lastError).toContain("Lock expired: worker crashed stopped responding during attempt 1 of 2");

    const failed = await getJob(t.db, exhausted.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, lockedAt: null, lockedBy: null });
    expect(failed?.finishedAt).toEqual(at(61_000));
    expect(failed?.lastError).toContain("No attempts remain");

    expect(await getJob(t.db, fresh.id)).toMatchObject({ status: "running", lockedBy: "alive" });

    // The crashed worker can no longer complete the released job.
    expect(await completeJob(t.db, retryable.id, "crashed", at(62_000))).toBeNull();
    expect((await claimNextJob(t.db, { workerId: "alive", now: at(62_000) }))?.attempts).toBe(2);
  });

  it("keeps a job whose lock was extended", async () => {
    const job = await enqueue();
    await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    expect(await extendJobLock(t.db, job.id, "w1", at(50_000))).toBe(true);
    expect((await releaseStaleJobs(t.db, { lockTimeoutMs: 60_000, now: at(100_000) })).jobIds).toEqual([]);
    expect((await releaseStaleJobs(t.db, { lockTimeoutMs: 60_000, now: at(111_000) })).jobIds).toEqual([job.id]);
  });
});

describe("explicit retry", () => {
  async function failedJob(batchId: string | null, maxAttempts = 1) {
    const job = await enqueue({ processingBatchId: batchId, maxAttempts });
    await claimNextJob(t.db, { workerId: "w1", now: at(0), types: ["asr"] });
    await failJob(t.db, job.id, "w1", { message: "provider down", retryable: false }, at(100));
    return job;
  }

  it("retryJob requeues a failed job, keeps attempts and extends max_attempts", async () => {
    const job = await failedJob(null, 2);
    const retried = await retryJob(t.db, job.id, { now: at(5000) });
    expect(retried).toMatchObject({
      status: "queued",
      attempts: 1,
      maxAttempts: 4,
      finishedAt: null,
      lockedBy: null,
      lastError: "provider down",
    });
    expect(retried.availableAt).toEqual(at(5000));
    expect((await claimNextJob(t.db, { workerId: "w1", now: at(5000) }))?.attempts).toBe(2);
  });

  it("retryJob refuses jobs that are not failed", async () => {
    const queued = await enqueue();
    await expect(retryJob(t.db, queued.id)).rejects.toMatchObject({ code: "INVALID_STATE" });

    await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    await completeJob(t.db, queued.id, "w1", at(10));
    await expect(retryJob(t.db, queued.id)).rejects.toBeInstanceOf(AppError);
    expect((await getJob(t.db, queued.id))?.status).toBe("succeeded");

    await expect(retryJob(t.db, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("retryFailedJobsForBatch requeues only failed jobs of that batch", async () => {
    const batchId = await createBatch(t.db);
    const otherBatchId = await createBatch(t.db);

    const succeeded = await enqueue({ processingBatchId: batchId });
    await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    await completeJob(t.db, succeeded.id, "w1", at(10));
    const failedA = await failedJob(batchId);
    const failedB = await failedJob(batchId);
    const failedOther = await failedJob(otherBatchId);
    const queued = await enqueue({ processingBatchId: batchId, availableAt: at(90_000) });
    const before = await getJob(t.db, succeeded.id);

    const result = await retryFailedJobsForBatch(t.db, batchId, { now: at(1000), additionalAttempts: 2 });
    expect(result.retried).toBe(2);
    expect(result.jobIds.sort()).toEqual([failedA.id, failedB.id].sort());

    expect(await getJob(t.db, failedA.id)).toMatchObject({ status: "queued", attempts: 1, maxAttempts: 3 });
    expect(await getJob(t.db, failedB.id)).toMatchObject({ status: "queued", attempts: 1, maxAttempts: 3 });
    expect(await getJob(t.db, failedOther.id)).toMatchObject({ status: "failed", maxAttempts: 1 });
    expect(await getJob(t.db, queued.id)).toMatchObject({ status: "queued", attempts: 0 });
    // The succeeded job is exactly as it was.
    expect(await getJob(t.db, succeeded.id)).toEqual(before);

    expect(await getJobCountsForBatch(t.db, batchId)).toEqual({
      queued: 3,
      running: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      total: 4,
    });
  });
});

describe("cancelQueuedJobsForBatch", () => {
  it("cancels queued jobs and lets running ones finish", async () => {
    const batchId = await createBatch(t.db);
    const running = await enqueue({ processingBatchId: batchId });
    await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    const queuedA = await enqueue({ processingBatchId: batchId });
    const queuedB = await enqueue({ processingBatchId: batchId });
    const unrelated = await enqueue();

    expect(await cancelQueuedJobsForBatch(t.db, batchId, at(500))).toEqual({ cancelled: 2 });
    const cancelled = await getJob(t.db, queuedA.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.finishedAt).toEqual(at(500));
    expect((await getJob(t.db, queuedB.id))?.status).toBe("cancelled");
    expect((await getJob(t.db, unrelated.id))?.status).toBe("queued");

    expect((await completeJob(t.db, running.id, "w1", at(600)))?.status).toBe("succeeded");
    // Cancelled jobs are not claimed; only the unrelated job is left.
    expect((await claimNextJob(t.db, { workerId: "w1", now: at(700) }))?.id).toBe(unrelated.id);
    expect(await claimNextJob(t.db, { workerId: "w1", now: at(700) })).toBeNull();
  });
});

describe("reading", () => {
  it("getQueueStats counts by status and reports the oldest queued age", async () => {
    expect(await getQueueStats(t.db, { now: at(0) })).toEqual({
      queued: 0,
      running: 0,
      failed: 0,
      oldestQueuedAt: null,
      oldestQueuedAgeMs: null,
    });

    await enqueue({ availableAt: at(-30_000), maxAttempts: 1 });
    await enqueue({ availableAt: at(-20_000) });
    await enqueue({ availableAt: at(-10_000) });
    await enqueue({ availableAt: at(-5_000) });
    const failing = await claimNextJob(t.db, { workerId: "w1", now: at(0) });
    await failJob(t.db, failing!.id, "w1", { message: "x", retryable: true }, at(0));
    await claimNextJob(t.db, { workerId: "w1", now: at(0) });

    const stats = await getQueueStats(t.db, { now: at(0) });
    expect(stats).toMatchObject({ queued: 2, running: 1, failed: 1, oldestQueuedAgeMs: 10_000 });
    expect(stats.oldestQueuedAt).toEqual(at(-10_000));
  });

  it("listJobs filters and pages", async () => {
    const batchId = await createBatch(t.db);
    for (let index = 0; index < 5; index += 1) await enqueue({ type: "asr", processingBatchId: batchId });
    for (let index = 0; index < 3; index += 1) await enqueue({ type: "tts" });
    await claimNextJob(t.db, { workerId: "w1", types: ["tts"], now: at(0) });

    const all = await listJobs(t.db);
    expect(all.total).toBe(8);
    expect(all.jobs).toHaveLength(8);

    const page = await listJobs(t.db, { type: "asr", limit: 2, offset: 4 });
    expect(page).toMatchObject({ total: 5, limit: 2, offset: 4 });
    expect(page.jobs).toHaveLength(1);

    expect((await listJobs(t.db, { status: "running" })).total).toBe(1);
    expect((await listJobs(t.db, { status: ["queued", "running"], type: ["tts"] })).total).toBe(3);
    expect((await listJobs(t.db, { processingBatchId: batchId })).total).toBe(5);

    const firstPage = await listJobs(t.db, { limit: 4 });
    const secondPage = await listJobs(t.db, { limit: 4, offset: 4 });
    const ids = [...firstPage.jobs, ...secondPage.jobs].map((job) => job.id);
    expect(new Set(ids).size).toBe(8);
  });
});
