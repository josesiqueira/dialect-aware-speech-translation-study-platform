// Handler registry, worker loop and worker heartbeat (spec 29, 68, 128).
//
// The loop claims one job at a time per slot, runs the handler registered for
// the job type, and records the result. Participant uploads never wait for this
// loop: a failed job stays in the table and is retried later.
import { desc } from "drizzle-orm";
import { workerHeartbeats, type DbOrTx } from "@dialect/db";
import { AppError, isAppError, type ErrorCode } from "@dialect/domain";
import type { ServiceContext } from "../context";
import {
  claimNextJob,
  completeJob,
  extendJobLock,
  failJob,
  releaseStaleJobs,
  sanitizeErrorMessage,
  type BackoffOptions,
  type Job,
  type JobFailure,
} from "./queue";

export type JobHandlerDeps = {
  ctx: ServiceContext;
  // ProviderRegistry from @dialect/ai. Typed properly once the registry is part
  // of ServiceContext.
  providers?: unknown;
};
export type JobHandler = (deps: JobHandlerDeps, job: Job) => Promise<void>;
export type JobHandlerRegistry = Record<string, JobHandler>;

export const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_CONCURRENCY = 16;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

// AppError codes that a retry cannot fix: someone has to change the data or the
// configuration first.
const NON_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFIGURATION_MISSING",
  "IMMUTABLE_RECORD",
  "INVALID_STATE",
]);

// Decides whether a handler error is worth another attempt:
// 1. an error with a boolean `retryable` property (AiProviderError) says so itself;
// 2. an AppError with one of the codes above is not retryable;
// 3. anything else is retryable, limited by the job's max_attempts.
export function classifyJobError(error: unknown, secrets: Array<string | null | undefined> = []): JobFailure {
  let retryable = true;
  let message: string;
  if (error instanceof Error) {
    const flag = (error as { retryable?: unknown }).retryable;
    if (typeof flag === "boolean") retryable = flag;
    else if (isAppError(error) && NON_RETRYABLE_CODES.has(error.code)) retryable = false;
    message = isAppError(error) ? `${error.code}: ${error.message}` : `${error.name}: ${error.message}`;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = "The handler threw a value that is not an Error.";
  }
  return { message: sanitizeErrorMessage(message, secrets), retryable };
}

// ---------------------------------------------------------------------------
// Single step
// ---------------------------------------------------------------------------

export type ProcessOneJobOptions = {
  deps: JobHandlerDeps;
  handlers: JobHandlerRegistry;
  workerId: string;
  // Restrict the claim to these job types. Omit to claim any type, so that a job
  // of an unknown type fails visibly instead of waiting forever.
  types?: string[];
  // Restrict the claim to one processing batch.
  processingBatchId?: string;
  backoff?: BackoffOptions;
  // Exact strings removed from stored and logged error messages.
  secrets?: Array<string | null | undefined>;
};

type StepHooks = { onStart?: (job: Job) => void; onEnd?: (job: Job) => void };

async function step(options: ProcessOneJobOptions, hooks: StepHooks): Promise<"processed" | "idle"> {
  const { deps, handlers, workerId } = options;
  const { ctx } = deps;
  const job = await claimNextJob(ctx.db, {
    workerId,
    now: ctx.now(),
    ...(options.types ? { types: options.types } : {}),
    ...(options.processingBatchId ? { processingBatchId: options.processingBatchId } : {}),
  });
  if (!job) return "idle";

  // Only identifiers and counters are logged, never the payload (spec 68).
  const logFields = {
    jobId: job.id,
    jobType: job.type,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    processingBatchId: job.processingBatchId,
    workerId,
  };
  hooks.onStart?.(job);
  const startedMs = performance.now();
  try {
    const handler = Object.hasOwn(handlers, job.type) ? handlers[job.type] : undefined;
    let failure: JobFailure | null = null;
    if (!handler) {
      failure = {
        message: `No handler is registered for job type "${job.type}". The job cannot run on this worker.`,
        retryable: false,
      };
    } else {
      ctx.logger.info(logFields, "job started");
      try {
        await handler(deps, job);
      } catch (error) {
        failure = classifyJobError(error, options.secrets);
      }
    }
    const durationMs = Math.round(performance.now() - startedMs);

    if (!failure) {
      const done = await completeJob(ctx.db, job.id, workerId, ctx.now());
      if (done) ctx.logger.info({ ...logFields, durationMs }, "job succeeded");
      else ctx.logger.warn({ ...logFields, durationMs }, "job finished but its lock was lost, result not recorded");
      return "processed";
    }

    const failed = await failJob(ctx.db, job.id, workerId, failure, ctx.now(), options.backoff);
    if (!failed) {
      ctx.logger.warn({ ...logFields, durationMs }, "job failed but its lock was lost, result not recorded");
    } else if (failed.status === "queued") {
      ctx.logger.warn(
        { ...logFields, durationMs, error: failure.message, nextAttemptAt: failed.availableAt.toISOString() },
        "job failed, will retry",
      );
    } else {
      ctx.logger.error(
        { ...logFields, durationMs, error: failure.message, retryable: failure.retryable },
        "job failed permanently",
      );
    }
    return "processed";
  } finally {
    hooks.onEnd?.(job);
  }
}

// Claims and runs at most one job. Returns "idle" when no job was available.
// Used by tests and by synchronous paths such as Demo Mode.
export async function processOneJob(options: ProcessOneJobOptions): Promise<"processed" | "idle"> {
  return step(options, {});
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export type WorkerHeartbeatInput = {
  workerId: string;
  now: Date;
  info: Record<string, unknown>;
  // Set when the process starts, to reset started_at for a reused worker id.
  startedAt?: Date;
};

export async function recordWorkerHeartbeat(db: DbOrTx, input: WorkerHeartbeatInput): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      workerId: input.workerId,
      lastSeenAt: input.now,
      startedAt: input.startedAt ?? input.now,
      infoJson: input.info,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        lastSeenAt: input.now,
        infoJson: input.info,
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      },
    });
}

export type WorkerState = "running" | "stopped" | "stale";

export type WorkerStatusEntry = {
  workerId: string;
  // running: heartbeat is recent. stopped: the worker shut down cleanly.
  // stale: no recent heartbeat and no clean shutdown (crashed or unreachable).
  state: WorkerState;
  healthy: boolean;
  lastSeenAt: Date;
  startedAt: Date;
  lastSeenAgeMs: number;
  info: Record<string, unknown>;
};

export type WorkerStatus = { healthy: boolean; workers: WorkerStatusEntry[] };

// For the dashboard and the settings page (spec 42, 59). `healthy` is true when
// at least one worker sent a heartbeat within `staleAfterMs` and has not stopped.
export async function getWorkerStatus(
  db: DbOrTx,
  options: { now: Date; staleAfterMs: number },
): Promise<WorkerStatus> {
  const rows = await db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt));
  const workers = rows.map((row): WorkerStatusEntry => {
    const lastSeenAgeMs = Math.max(0, options.now.getTime() - row.lastSeenAt.getTime());
    const state: WorkerState =
      row.infoJson.state === "stopped" ? "stopped" : lastSeenAgeMs > options.staleAfterMs ? "stale" : "running";
    return {
      workerId: row.workerId,
      state,
      healthy: state === "running",
      lastSeenAt: row.lastSeenAt,
      startedAt: row.startedAt,
      lastSeenAgeMs,
      info: row.infoJson,
    };
  });
  return { healthy: workers.some((worker) => worker.healthy), workers };
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

export type RunWorkerOptions = {
  deps: JobHandlerDeps;
  handlers: JobHandlerRegistry;
  workerId: string;
  // Wait between claims when the queue is empty.
  pollIntervalMs: number;
  // A running job whose lock is older than this is treated as abandoned.
  // Default 10 minutes. The lock of a job that is still running is renewed at
  // every heartbeat, so a long job is not released while its worker is alive.
  lockTimeoutMs?: number;
  // Default 10 seconds. Must be at most half of lockTimeoutMs.
  heartbeatIntervalMs?: number;
  // Number of jobs run at the same time in this process. Default 1.
  concurrency?: number;
  // After the signal aborts, how long to wait for running jobs. Default 30 seconds.
  shutdownTimeoutMs?: number;
  types?: string[];
  backoff?: BackoffOptions;
  secrets?: Array<string | null | undefined>;
  // Abort to shut down: no new job is claimed, running jobs are allowed to finish.
  signal: AbortSignal;
};

// Resolves after `ms` or as soon as the signal aborts.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorText(error: unknown, secrets: Array<string | null | undefined> | undefined): string {
  return classifyJobError(error, secrets).message;
}

// Runs until the signal aborts. Resolves after running jobs finished or the
// shutdown wait ran out. A job still running at that point keeps its lock and
// is released by releaseStaleJobs of any worker after lockTimeoutMs.
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const { deps, handlers, workerId, signal } = options;
  const { ctx } = deps;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const concurrency = Math.min(Math.max(Math.trunc(options.concurrency ?? 1), 1), MAX_CONCURRENCY);
  if (!workerId) throw new AppError("VALIDATION_ERROR", "The worker needs a workerId.");
  if (!(options.pollIntervalMs > 0)) throw new AppError("VALIDATION_ERROR", "pollIntervalMs must be positive.");
  if (!(heartbeatIntervalMs > 0) || heartbeatIntervalMs * 2 > lockTimeoutMs) {
    throw new AppError(
      "VALIDATION_ERROR",
      "heartbeatIntervalMs must be positive and at most half of lockTimeoutMs, otherwise running jobs would be released while their worker is alive.",
    );
  }

  const inFlight = new Map<string, Job>();
  const startedAt = ctx.now();
  const baseInfo = {
    pid: process.pid,
    jobTypes: Object.keys(handlers).sort(),
    appVersion: ctx.appVersion,
    gitCommitSha: ctx.gitCommitSha,
    concurrency,
  };

  // Fails fast when the database is unreachable or not migrated.
  await recordWorkerHeartbeat(ctx.db, {
    workerId,
    now: startedAt,
    startedAt,
    info: { ...baseInfo, state: "running" },
  });
  ctx.logger.info({ workerId, ...baseInfo, pollIntervalMs: options.pollIntervalMs, lockTimeoutMs }, "worker started");

  const releaseStale = async () => {
    const released = await releaseStaleJobs(ctx.db, { lockTimeoutMs, now: ctx.now() });
    if (released.jobIds.length > 0) {
      ctx.logger.warn(
        { workerId, requeued: released.requeued, failed: released.failed, jobIds: released.jobIds },
        "released jobs with an expired lock",
      );
    }
  };

  // Heartbeat, lock renewal for running jobs, and stale lock release.
  const maintenanceStop = new AbortController();
  const maintenance = (async () => {
    for (;;) {
      try {
        await releaseStale();
      } catch (error) {
        ctx.logger.error({ workerId, error: errorText(error, options.secrets) }, "stale job release failed");
      }
      await sleep(heartbeatIntervalMs, maintenanceStop.signal);
      if (maintenanceStop.signal.aborted) return;
      try {
        const now = ctx.now();
        await recordWorkerHeartbeat(ctx.db, { workerId, now, info: { ...baseInfo, state: "running" } });
        for (const jobId of [...inFlight.keys()]) await extendJobLock(ctx.db, jobId, workerId, now);
      } catch (error) {
        ctx.logger.error({ workerId, error: errorText(error, options.secrets) }, "worker heartbeat failed");
      }
    }
  })();

  const stepOptions: ProcessOneJobOptions = {
    deps,
    handlers,
    workerId,
    ...(options.types ? { types: options.types } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  };
  const hooks: StepHooks = {
    onStart: (job) => inFlight.set(job.id, job),
    onEnd: (job) => inFlight.delete(job.id),
  };
  const slot = async () => {
    while (!signal.aborted) {
      let result: "processed" | "idle" = "idle";
      try {
        result = await step(stepOptions, hooks);
      } catch (error) {
        // For example the database is unreachable. Wait and try again.
        ctx.logger.error({ workerId, error: errorText(error, options.secrets) }, "worker step failed");
      }
      if (result === "idle") await sleep(options.pollIntervalMs, signal);
    }
  };
  const slots = Promise.all(Array.from({ length: concurrency }, slot)).then(() => "drained" as const);

  // Bounded wait: once the signal aborts, running jobs get shutdownTimeoutMs.
  let shutdownTimer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    const arm = () => {
      shutdownTimer = setTimeout(() => resolve("timeout"), shutdownTimeoutMs);
    };
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
  });
  const outcome = await Promise.race([slots, timedOut]);
  if (shutdownTimer) clearTimeout(shutdownTimer);

  maintenanceStop.abort();
  await maintenance;

  if (outcome === "timeout") {
    ctx.logger.warn(
      { workerId, jobIds: [...inFlight.keys()], shutdownTimeoutMs },
      "shutdown wait ran out with jobs still running, their locks expire after the lock timeout",
    );
  }
  try {
    await recordWorkerHeartbeat(ctx.db, {
      workerId,
      now: ctx.now(),
      info: { ...baseInfo, state: "stopped" },
    });
  } catch (error) {
    ctx.logger.error({ workerId, error: errorText(error, options.secrets) }, "final worker heartbeat failed");
  }
  ctx.logger.info({ workerId }, "worker stopped");
}
