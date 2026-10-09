import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobs, workerHeartbeats } from "@dialect/db";
import { createTestDatabase, type TestDatabase } from "@dialect/db/testing";
import { AppError } from "@dialect/domain";
import { claimNextJob, enqueueJob, getJob, type Job } from "./queue";
import { createClock, createRecordingLogger, createTestContext } from "./test-helpers";
import {
  classifyJobError,
  getWorkerStatus,
  processOneJob,
  recordWorkerHeartbeat,
  runWorker,
  type JobHandlerDeps,
  type JobHandlerRegistry,
} from "./worker";

let t: TestDatabase;
let keyCounter = 0;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(jobs);
  await t.db.delete(workerHeartbeats);
});

function setup() {
  const clock = createClock();
  const { logger, entries } = createRecordingLogger();
  const deps: JobHandlerDeps = { ctx: createTestContext(t.db, clock.now, logger), providers: { marker: "providers" } };
  return { clock, deps, entries };
}

async function enqueue(clock: { now: () => Date }, type = "asr", overrides: { maxAttempts?: number } = {}) {
  keyCounter += 1;
  const { job } = await enqueueJob(t.db, {
    type,
    payload: { text: "participant speech that must not be logged" },
    idempotencyKey: `worker-test-${keyCounter}`,
    availableAt: clock.now(),
    ...overrides,
  });
  return job;
}

// Waits until the condition holds, checking every few milliseconds.
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

describe("classifyJobError", () => {
  it("uses the retryable flag of the error when present", () => {
    expect(classifyJobError(new FakeProviderError("rate limited", true)).retryable).toBe(true);
    expect(classifyJobError(new FakeProviderError("invalid model", false)).retryable).toBe(false);
  });

  it("treats configuration and validation errors as not retryable", () => {
    for (const code of [
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "CONFIGURATION_MISSING",
      "IMMUTABLE_RECORD",
      "INVALID_STATE",
    ] as const) {
      expect(classifyJobError(new AppError(code, "no")).retryable).toBe(false);
    }
    expect(classifyJobError(new AppError("STORAGE_ERROR", "disk")).retryable).toBe(true);
    expect(classifyJobError(new AppError("NOT_FOUND", "Utterance not found.")).message).toBe(
      "NOT_FOUND: Utterance not found.",
    );
  });

  it("treats unknown errors as retryable and cleans the message", () => {
    expect(classifyJobError(new Error("socket hang up"))).toEqual({
      message: "Error: socket hang up",
      retryable: true,
    });
    expect(classifyJobError("plain string").retryable).toBe(true);
    expect(classifyJobError({ odd: true }).message).toBe("The handler threw a value that is not an Error.");
    expect(classifyJobError(new Error("key sk-abc123456789 rejected")).message).not.toContain("sk-abc");
  });
});

describe("processOneJob", () => {
  it("returns idle when the queue is empty", async () => {
    const { deps } = setup();
    expect(await processOneJob({ deps, handlers: {}, workerId: "w1" })).toBe("idle");
  });

  it("runs the handler with the deps and marks the job succeeded", async () => {
    const { deps, clock, entries } = setup();
    const job = await enqueue(clock);
    const seen: Array<{ deps: JobHandlerDeps; job: Job }> = [];
    const handlers: JobHandlerRegistry = {
      asr: async (handlerDeps, claimed) => {
        seen.push({ deps: handlerDeps, job: claimed });
      },
    };

    expect(await processOneJob({ deps, handlers, workerId: "w1" })).toBe("processed");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.deps).toBe(deps);
    expect(seen[0]!.job).toMatchObject({ id: job.id, status: "running", attempts: 1, lockedBy: "w1" });
    expect(await getJob(t.db, job.id)).toMatchObject({ status: "succeeded", lockedBy: null });

    // Logs carry the job id and type, never the payload.
    const logged = JSON.stringify(entries);
    expect(logged).toContain(job.id);
    expect(logged).toContain('"jobType":"asr"');
    expect(logged).not.toContain("participant speech");
  });

  it("requeues after a retryable error and fails after max attempts", async () => {
    const { deps, clock } = setup();
    const job = await enqueue(clock, "translation", { maxAttempts: 2 });
    const handlers: JobHandlerRegistry = {
      translation: async () => {
        throw new FakeProviderError("provider timeout", true);
      },
    };
    const options = { deps, handlers, workerId: "w1", backoff: { random: () => 0 } };

    expect(await processOneJob(options)).toBe("processed");
    const requeued = await getJob(t.db, job.id);
    expect(requeued).toMatchObject({ status: "queued", attempts: 1, lastError: "AiProviderError: provider timeout" });
    expect(requeued!.availableAt.getTime()).toBe(clock.now().getTime() + 5_000);

    // Still in backoff.
    expect(await processOneJob(options)).toBe("idle");
    clock.advance(5_000);
    expect(await processOneJob(options)).toBe("processed");
    expect(await getJob(t.db, job.id)).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("fails at once on a non-retryable error", async () => {
    const { deps, clock } = setup();
    const byFlag = await enqueue(clock, "tts", { maxAttempts: 5 });
    const byCode = await enqueue(clock, "export", { maxAttempts: 5 });
    const handlers: JobHandlerRegistry = {
      tts: async () => {
        throw new FakeProviderError("unknown voice", false);
      },
      export: async () => {
        throw new AppError("CONFIGURATION_MISSING", "No active model configuration.");
      },
    };
    expect(await processOneJob({ deps, handlers, workerId: "w1" })).toBe("processed");
    expect(await processOneJob({ deps, handlers, workerId: "w1" })).toBe("processed");
    expect(await getJob(t.db, byFlag.id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(await getJob(t.db, byCode.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "CONFIGURATION_MISSING: No active model configuration.",
    });
  });

  it("fails a job of an unknown type permanently with a clear message", async () => {
    const { deps, clock } = setup();
    const job = await enqueue(clock, "no_such_type", { maxAttempts: 5 });
    // A type name that exists on Object.prototype must not find a handler either.
    const inherited = await enqueue(clock, "toString", { maxAttempts: 5 });

    expect(await processOneJob({ deps, handlers: { asr: async () => {} }, workerId: "w1" })).toBe("processed");
    expect(await processOneJob({ deps, handlers: { asr: async () => {} }, workerId: "w1" })).toBe("processed");
    const failed = await getJob(t.db, job.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(failed?.lastError).toContain('No handler is registered for job type "no_such_type"');
    expect(failed?.finishedAt).not.toBeNull();
    expect((await getJob(t.db, inherited.id))?.status).toBe("failed");
  });

  it("does not record a result when the lock was lost while the handler ran", async () => {
    const { deps, clock, entries } = setup();
    const job = await enqueue(clock);
    const handlers: JobHandlerRegistry = {
      asr: async () => {
        // Another worker took the job over after a lock timeout.
        await t.db.update(jobs).set({ lockedBy: "other" });
      },
    };
    expect(await processOneJob({ deps, handlers, workerId: "w1" })).toBe("processed");
    expect(await getJob(t.db, job.id)).toMatchObject({ status: "running", lockedBy: "other" });
    expect(entries.some((entry) => entry.level === "warn" && entry.msg?.includes("lock was lost"))).toBe(true);
  });
});

describe("runWorker", () => {
  it("processes queued jobs, then stops cleanly on abort", async () => {
    const { deps, clock } = setup();
    const created: Job[] = [];
    for (let index = 0; index < 6; index += 1) created.push(await enqueue(clock));
    const handled: string[] = [];
    const handlers: JobHandlerRegistry = {
      asr: async (_deps, job) => {
        handled.push(job.id);
      },
    };

    const controller = new AbortController();
    const running = runWorker({
      deps,
      handlers,
      workerId: "loop-1",
      pollIntervalMs: 10,
      heartbeatIntervalMs: 20,
      lockTimeoutMs: 60_000,
      concurrency: 2,
      signal: controller.signal,
    });
    await waitFor(() => handled.length === 6);
    // A job enqueued while the worker is idle is picked up by polling.
    const late = await enqueue(clock);
    await waitFor(() => handled.length === 7);

    controller.abort();
    await running;

    expect(new Set(handled)).toEqual(new Set([...created, late].map((job) => job.id)));
    const rows = await t.db.select().from(jobs);
    expect(rows.every((row) => row.status === "succeeded" && row.attempts === 1)).toBe(true);

    // After the worker stopped, new jobs stay queued.
    const after = await enqueue(clock);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await getJob(t.db, after.id))?.status).toBe("queued");

    const status = await getWorkerStatus(t.db, { now: clock.now(), staleAfterMs: 60_000 });
    expect(status.healthy).toBe(false);
    expect(status.workers).toHaveLength(1);
    expect(status.workers[0]).toMatchObject({ workerId: "loop-1", state: "stopped", healthy: false });
    expect(status.workers[0]!.info).toMatchObject({
      pid: process.pid,
      jobTypes: ["asr"],
      appVersion: "test",
      concurrency: 2,
    });
  });

  it("lets the running job finish on abort and claims no new job", async () => {
    const { deps, clock } = setup();
    const first = await enqueue(clock);
    const second = await enqueue(clock);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const handlers: JobHandlerRegistry = {
      asr: async () => {
        started += 1;
        await gate;
      },
    };

    const controller = new AbortController();
    let finished = false;
    const running = runWorker({
      deps,
      handlers,
      workerId: "loop-2",
      pollIntervalMs: 10,
      concurrency: 1,
      signal: controller.signal,
    }).then(() => {
      finished = true;
    });
    await waitFor(() => started === 1);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finished).toBe(false);

    release();
    await running;
    expect(started).toBe(1);
    expect((await getJob(t.db, first.id))?.status).toBe("succeeded");
    expect((await getJob(t.db, second.id))?.status).toBe("queued");
  });

  it("stops waiting for a running job after the shutdown timeout", async () => {
    const { deps, clock, entries } = setup();
    const job = await enqueue(clock);
    let started = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlers: JobHandlerRegistry = {
      asr: async () => {
        started = true;
        await gate;
      },
    };
    const controller = new AbortController();
    const running = runWorker({
      deps,
      handlers,
      workerId: "loop-3",
      pollIntervalMs: 10,
      shutdownTimeoutMs: 40,
      signal: controller.signal,
    });
    await waitFor(() => started);
    controller.abort();
    await running;

    // The job keeps its lock until the lock timeout releases it.
    expect(await getJob(t.db, job.id)).toMatchObject({ status: "running", lockedBy: "loop-3" });
    expect(entries.some((entry) => entry.level === "warn" && entry.msg?.includes("shutdown wait ran out"))).toBe(true);
    release();
    await waitFor(async () => (await getJob(t.db, job.id))?.status === "succeeded");
  });

  it("releases stale jobs of a crashed worker and renews the lock of its own running job", async () => {
    const { deps, clock } = setup();
    const abandoned = await enqueue(clock);
    await claimNextJob(t.db, { workerId: "crashed", now: clock.now() });
    clock.advance(120_000);

    const long = await enqueue(clock, "tts");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handledTypes: string[] = [];
    const handlers: JobHandlerRegistry = {
      asr: async () => {
        handledTypes.push("asr");
      },
      tts: async () => {
        handledTypes.push("tts");
        await gate;
      },
    };
    const controller = new AbortController();
    const running = runWorker({
      deps,
      handlers,
      workerId: "loop-4",
      pollIntervalMs: 10,
      heartbeatIntervalMs: 15,
      lockTimeoutMs: 60_000,
      concurrency: 2,
      signal: controller.signal,
    });

    // The abandoned job is released at startup and processed again (attempt 2).
    await waitFor(async () => (await getJob(t.db, abandoned.id))?.status === "succeeded");
    expect((await getJob(t.db, abandoned.id))?.attempts).toBe(2);

    // While the long job runs, time passes beyond the lock timeout. The lock is
    // renewed at each heartbeat, so the job is not released.
    await waitFor(() => handledTypes.includes("tts"));
    for (let index = 0; index < 5; index += 1) {
      clock.advance(40_000);
      const lockedBefore = clock.now().getTime();
      await waitFor(async () => (await getJob(t.db, long.id))!.lockedAt!.getTime() >= lockedBefore);
    }
    expect(await getJob(t.db, long.id)).toMatchObject({ status: "running", attempts: 1, lockedBy: "loop-4" });

    release();
    await waitFor(async () => (await getJob(t.db, long.id))?.status === "succeeded");
    controller.abort();
    await running;
    expect(handledTypes.filter((type) => type === "tts")).toHaveLength(1);
  });

  it("keeps running when a step throws", async () => {
    const { deps, clock, entries } = setup();
    let failNext = false;
    let thrown = 0;
    const flakyDeps: JobHandlerDeps = {
      ...deps,
      ctx: {
        ...deps.ctx,
        now: () => {
          if (failNext) {
            failNext = false;
            thrown += 1;
            // Stands in for a database outage during a claim.
            throw new Error("clock failure");
          }
          return clock.now();
        },
      },
    };
    const controller = new AbortController();
    const running = runWorker({
      deps: flakyDeps,
      handlers: { asr: async () => {} },
      workerId: "loop-5",
      pollIntervalMs: 5,
      heartbeatIntervalMs: 30_000,
      lockTimeoutMs: 60_000,
      signal: controller.signal,
    });
    // The queue is empty, so the next clock read is a claim.
    await new Promise((resolve) => setTimeout(resolve, 30));
    failNext = true;
    await waitFor(() => thrown === 1);

    const job = await enqueue(clock);
    await waitFor(async () => (await getJob(t.db, job.id))?.status === "succeeded");
    controller.abort();
    await running;
    expect(entries.some((entry) => entry.level === "error" && entry.msg === "worker step failed")).toBe(true);
  });

  it("rejects a heartbeat interval that could let running jobs expire", async () => {
    const { deps } = setup();
    await expect(
      runWorker({
        deps,
        handlers: {},
        workerId: "loop-6",
        pollIntervalMs: 10,
        heartbeatIntervalMs: 40_000,
        lockTimeoutMs: 60_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("heartbeat and getWorkerStatus", () => {
  it("reports healthy with a recent heartbeat and unhealthy when stale", async () => {
    const clock = createClock();
    expect(await getWorkerStatus(t.db, { now: clock.now(), staleAfterMs: 30_000 })).toEqual({
      healthy: false,
      workers: [],
    });

    const startedAt = clock.now();
    await recordWorkerHeartbeat(t.db, {
      workerId: "worker-1",
      now: startedAt,
      startedAt,
      info: { pid: 1, jobTypes: ["asr"], appVersion: "1.2.3", state: "running" },
    });
    clock.advance(10_000);
    await recordWorkerHeartbeat(t.db, {
      workerId: "worker-1",
      now: clock.now(),
      info: { pid: 1, jobTypes: ["asr"], appVersion: "1.2.3", state: "running" },
    });
    expect(await t.db.select().from(workerHeartbeats)).toHaveLength(1);

    clock.advance(20_000);
    const healthy = await getWorkerStatus(t.db, { now: clock.now(), staleAfterMs: 30_000 });
    expect(healthy.healthy).toBe(true);
    expect(healthy.workers[0]).toMatchObject({
      workerId: "worker-1",
      state: "running",
      healthy: true,
      lastSeenAgeMs: 20_000,
      startedAt,
    });
    expect(healthy.workers[0]!.info).toMatchObject({ appVersion: "1.2.3", jobTypes: ["asr"] });

    clock.advance(10_001);
    const stale = await getWorkerStatus(t.db, { now: clock.now(), staleAfterMs: 30_000 });
    expect(stale.healthy).toBe(false);
    expect(stale.workers[0]).toMatchObject({ state: "stale", healthy: false, lastSeenAgeMs: 30_001 });

    // One live worker is enough.
    await recordWorkerHeartbeat(t.db, { workerId: "worker-2", now: clock.now(), info: { state: "running" } });
    const mixed = await getWorkerStatus(t.db, { now: clock.now(), staleAfterMs: 30_000 });
    expect(mixed.healthy).toBe(true);
    expect(mixed.workers.map((worker) => [worker.workerId, worker.state])).toEqual([
      ["worker-2", "running"],
      ["worker-1", "stale"],
    ]);
  });
});
