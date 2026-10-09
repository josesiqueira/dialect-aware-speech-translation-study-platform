// PostgreSQL-backed job queue on the `jobs` table (spec 29, 30, 127, 128, 145).
//
// Rules this file keeps:
// - Enqueueing the same logical work twice (same idempotency key) returns the
//   existing job and never creates a second row.
// - Several worker replicas never claim the same job (FOR UPDATE SKIP LOCKED).
// - Only the worker that holds the lock can complete or fail a job.
// - A retry is explicit and visible: `attempts` is never reset, and a succeeded
//   job is never run again.
import { and, asc, count, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { jobs, type DbOrTx, type JobPayload } from "@dialect/db";
import { AppError, JOB_STATUSES, type JobStatus } from "@dialect/domain";

export type Job = typeof jobs.$inferSelect;

export const DEFAULT_MAX_ATTEMPTS = 3;
// Stored error messages are cut to this many characters.
export const MAX_ERROR_MESSAGE_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Error message cleaning
// ---------------------------------------------------------------------------

// Removes key material from an error message and cuts it to a bounded length
// before it is stored in jobs.last_error or written to a log. `secrets` are exact
// strings to remove (for example the configured API key).
export function sanitizeErrorMessage(
  message: string,
  secrets: Array<string | null | undefined> = [],
): string {
  let result = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) result = result.split(secret).join("[redacted]");
  }
  result = result
    // OpenAI style keys, including the partly masked form echoed in provider errors.
    .replace(/\bsk-[A-Za-z0-9_\-*.]{3,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9_\-*.=+/]{8,}/gi, "Bearer [redacted]")
    // Credentials inside a URL, for example a database connection string.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    // AWS access key ids.
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    // name=value pairs whose name says the value is a secret.
    .replace(
      /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2[redacted]",
    );
  if (result.length > MAX_ERROR_MESSAGE_LENGTH) {
    const suffix = " ... [truncated]";
    result = result.slice(0, MAX_ERROR_MESSAGE_LENGTH - suffix.length) + suffix;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export type BackoffOptions = {
  // Delay before the second attempt. Default 5000 ms.
  baseMs?: number;
  // Upper limit of the delay before jitter. Default 300000 ms (5 minutes).
  capMs?: number;
  // Largest share of the delay added as jitter. Default 0.2 (up to 20 percent).
  jitterRatio?: number;
  // Returns a number in [0, 1). Injectable so tests are deterministic.
  random?: () => number;
};

export const DEFAULT_BACKOFF = { baseMs: 5_000, capMs: 300_000, jitterRatio: 0.2 } as const;

// Exponential backoff with jitter:
//
//   delay = min(capMs, baseMs * 2^(attempts - 1)) * (1 + jitterRatio * random())
//
// `attempts` is the number of attempts already made (1 after the first failure).
// With the defaults the delays are about 5 s, 10 s, 20 s, 40 s and so on, never
// more than 5 minutes plus up to 20 percent jitter. The jitter spreads out jobs
// that failed together (for example during a provider outage) so they do not
// all retry at the same moment.
export function computeBackoffMs(attempts: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const capMs = options.capMs ?? DEFAULT_BACKOFF.capMs;
  const jitterRatio = options.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio;
  const random = options.random ?? Math.random;
  const exponent = Math.min(Math.max(attempts, 1) - 1, 30);
  const delay = Math.min(capMs, baseMs * 2 ** exponent);
  return Math.round(delay * (1 + jitterRatio * random()));
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export type EnqueueJobInput = {
  type: string;
  payload: JobPayload;
  // Identifies the logical work. A second enqueue with the same key returns the
  // existing job.
  idempotencyKey: string;
  processingBatchId?: string | null;
  maxAttempts?: number;
  // When the job may first run. Defaults to the database time of the insert.
  availableAt?: Date;
};

function toInsertRow(input: EnqueueJobInput): typeof jobs.$inferInsert {
  if (!input.type) throw new AppError("VALIDATION_ERROR", "A job needs a type.");
  if (!input.idempotencyKey) throw new AppError("VALIDATION_ERROR", "A job needs an idempotency key.");
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) {
    throw new AppError("VALIDATION_ERROR", "maxAttempts must be an integer of at least 1.");
  }
  return {
    type: input.type,
    payloadJson: input.payload,
    idempotencyKey: input.idempotencyKey,
    processingBatchId: input.processingBatchId ?? null,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    ...(input.availableAt ? { availableAt: input.availableAt } : {}),
  };
}

// Inserts a job, or returns the existing job with the same idempotency key.
// Works on a database handle or inside the caller's transaction.
export async function enqueueJob(
  dbOrTx: DbOrTx,
  input: EnqueueJobInput,
): Promise<{ job: Job; created: boolean }> {
  const [inserted] = await dbOrTx
    .insert(jobs)
    .values(toInsertRow(input))
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();
  if (inserted) return { job: inserted, created: true };

  const [existing] = await dbOrTx
    .select()
    .from(jobs)
    .where(eq(jobs.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) {
    // Only possible when the caller's transaction uses a snapshot older than the
    // conflicting row (REPEATABLE READ or stricter).
    throw new AppError(
      "CONFLICT",
      "A job with this idempotency key was created concurrently and is not visible to this transaction.",
    );
  }
  return { job: existing, created: false };
}

const ENQUEUE_CHUNK_SIZE = 500;

// Bulk version of enqueueJob. `jobs` has one entry per input, in input order;
// inputs that share an idempotency key (with each other or with an existing row)
// map to the same job. `createdCount` is the number of new rows.
export async function enqueueJobs(
  dbOrTx: DbOrTx,
  inputs: EnqueueJobInput[],
): Promise<{ jobs: Job[]; createdCount: number }> {
  if (inputs.length === 0) return { jobs: [], createdCount: 0 };
  const rows = inputs.map(toInsertRow);
  const byKey = new Map<string, Job>();
  let createdCount = 0;

  for (let start = 0; start < rows.length; start += ENQUEUE_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + ENQUEUE_CHUNK_SIZE);
    const inserted = await dbOrTx
      .insert(jobs)
      .values(chunk)
      .onConflictDoNothing({ target: jobs.idempotencyKey })
      .returning();
    createdCount += inserted.length;
    for (const job of inserted) byKey.set(job.idempotencyKey, job);

    const missingKeys = [...new Set(chunk.map((row) => row.idempotencyKey))].filter(
      (key) => !byKey.has(key),
    );
    if (missingKeys.length > 0) {
      const existing = await dbOrTx.select().from(jobs).where(inArray(jobs.idempotencyKey, missingKeys));
      for (const job of existing) byKey.set(job.idempotencyKey, job);
    }
  }

  const result = inputs.map((input) => {
    const job = byKey.get(input.idempotencyKey);
    if (!job) {
      throw new AppError(
        "CONFLICT",
        "A job with this idempotency key was created concurrently and is not visible to this transaction.",
      );
    }
    return job;
  });
  return { jobs: result, createdCount };
}

// ---------------------------------------------------------------------------
// Claim, complete, fail
// ---------------------------------------------------------------------------

export type ClaimNextJobOptions = {
  workerId: string;
  // Restrict the claim to these job types. Omit to claim any type.
  types?: string[];
  // Restrict the claim to one processing batch (used by synchronous paths that
  // must not pick up unrelated work).
  processingBatchId?: string;
  now: Date;
};

// Claims the oldest available queued job in one statement. The inner SELECT
// locks the row with FOR UPDATE SKIP LOCKED, so concurrent workers skip rows
// another worker is claiming and each job is claimed once. Jobs of a cancelled
// batch are never claimed.
export async function claimNextJob(db: DbOrTx, options: ClaimNextJobOptions): Promise<Job | null> {
  if (options.types && options.types.length === 0) return null;
  const nowText = options.now.toISOString();
  const typeFilter =
    options.types && options.types.length > 0
      ? sql`AND j.type IN (${sql.join(
          options.types.map((type) => sql`${type}`),
          sql`, `,
        )})`
      : sql``;
  const batchFilter = options.processingBatchId
    ? sql`AND j.processing_batch_id = ${options.processingBatchId}::uuid`
    : sql``;

  const [claimed] = await db
    .update(jobs)
    .set({
      status: "running",
      lockedAt: options.now,
      lockedBy: options.workerId,
      attempts: sql`${jobs.attempts} + 1`,
      updatedAt: options.now,
    })
    .where(
      sql`${jobs.id} = (
        SELECT j.id
        FROM jobs j
        WHERE j.status = 'queued'
          AND j.available_at <= ${nowText}::timestamptz
          ${typeFilter}
          ${batchFilter}
          AND NOT EXISTS (
            SELECT 1 FROM processing_batches b
            WHERE b.id = j.processing_batch_id AND b.status = 'cancelled'
          )
        ORDER BY j.available_at ASC, j.created_at ASC, j.id ASC
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )`,
    )
    .returning();
  return claimed ?? null;
}

function heldBy(jobId: string, workerId: string): SQL {
  return and(eq(jobs.id, jobId), eq(jobs.status, "running"), eq(jobs.lockedBy, workerId)) as SQL;
}

// Marks a running job as succeeded. Returns null (and changes nothing) when the
// job is not running or its lock is held by another worker.
export async function completeJob(
  db: DbOrTx,
  jobId: string,
  workerId: string,
  now: Date = new Date(),
): Promise<Job | null> {
  const [done] = await db
    .update(jobs)
    .set({ status: "succeeded", finishedAt: now, lockedAt: null, lockedBy: null, updatedAt: now })
    .where(heldBy(jobId, workerId))
    .returning();
  return done ?? null;
}

export type JobFailure = { message: string; retryable: boolean };

// Records a failed attempt. A retryable failure with attempts left puts the job
// back in the queue with a backoff delay (see computeBackoffMs); otherwise the
// job becomes `failed`. Returns null (and changes nothing) when the job is not
// running or its lock is held by another worker.
export async function failJob(
  db: DbOrTx,
  jobId: string,
  workerId: string,
  error: JobFailure,
  now: Date,
  backoff: BackoffOptions = {},
): Promise<Job | null> {
  const message = sanitizeErrorMessage(error.message);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(jobs).where(heldBy(jobId, workerId)).for("update");
    if (!current) return null;

    if (error.retryable && current.attempts < current.maxAttempts) {
      const delayMs = computeBackoffMs(current.attempts, backoff);
      const [requeued] = await tx
        .update(jobs)
        .set({
          status: "queued",
          availableAt: new Date(now.getTime() + delayMs),
          lockedAt: null,
          lockedBy: null,
          lastError: message,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId))
        .returning();
      return requeued ?? null;
    }

    const [failed] = await tx
      .update(jobs)
      .set({
        status: "failed",
        finishedAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: message,
        updatedAt: now,
      })
      .where(eq(jobs.id, jobId))
      .returning();
    return failed ?? null;
  });
}

// Moves the lock time of a running job forward. The worker calls this while a
// handler is still running, so a long job is not mistaken for a crashed worker.
// Returns false when the lock is no longer held by this worker.
export async function extendJobLock(db: DbOrTx, jobId: string, workerId: string, now: Date): Promise<boolean> {
  const updated = await db
    .update(jobs)
    .set({ lockedAt: now, updatedAt: now })
    .where(heldBy(jobId, workerId))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

// Handles jobs whose worker stopped without finishing them (crash, kill, lost
// connection): a `running` job whose lock is older than `lockTimeoutMs` goes back
// to `queued` when attempts remain, otherwise it becomes `failed`.
export async function releaseStaleJobs(
  db: DbOrTx,
  options: { lockTimeoutMs: number; now: Date },
): Promise<{ requeued: number; failed: number; jobIds: string[] }> {
  const cutoff = new Date(options.now.getTime() - options.lockTimeoutMs);
  const hasAttemptsLeft = sql`${jobs.attempts} < ${jobs.maxAttempts}`;
  const released = await db
    .update(jobs)
    .set({
      status: sql`CASE WHEN ${hasAttemptsLeft} THEN 'queued'::job_status ELSE 'failed'::job_status END`,
      availableAt: sql`CASE WHEN ${hasAttemptsLeft} THEN ${options.now.toISOString()}::timestamptz ELSE ${jobs.availableAt} END`,
      finishedAt: sql`CASE WHEN ${hasAttemptsLeft} THEN NULL ELSE ${options.now.toISOString()}::timestamptz END`,
      lastError: sql`CASE WHEN ${hasAttemptsLeft}
        THEN 'Lock expired: worker ' || coalesce(${jobs.lockedBy}, 'unknown') || ' stopped responding during attempt ' || ${jobs.attempts} || ' of ' || ${jobs.maxAttempts} || '. The job was queued again.'
        ELSE 'Lock expired: worker ' || coalesce(${jobs.lockedBy}, 'unknown') || ' stopped responding during attempt ' || ${jobs.attempts} || ' of ' || ${jobs.maxAttempts} || '. No attempts remain.'
        END`,
      lockedAt: null,
      lockedBy: null,
      updatedAt: options.now,
    })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id, status: jobs.status });
  const requeued = released.filter((row) => row.status === "queued").length;
  return { requeued, failed: released.length - requeued, jobIds: released.map((row) => row.id) };
}

// ---------------------------------------------------------------------------
// Explicit retry and cancellation
// ---------------------------------------------------------------------------

export type RetryOptions = {
  now?: Date;
  // How many further attempts the retried job may make. Default 3.
  additionalAttempts?: number;
};

function retryChanges(options: RetryOptions) {
  const now = options.now ?? new Date();
  const additional = options.additionalAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(additional) || additional < 1) {
    throw new AppError("VALIDATION_ERROR", "additionalAttempts must be an integer of at least 1.");
  }
  return {
    status: "queued" as const,
    // `attempts` keeps its value, so the history of earlier attempts stays visible.
    maxAttempts: sql`${jobs.attempts} + ${additional}`,
    availableAt: now,
    finishedAt: null,
    lockedAt: null,
    lockedBy: null,
    updatedAt: now,
  };
}

// Puts one failed job back in the queue. Only a `failed` job can be retried.
// `last_error` is kept until the next attempt finishes.
export async function retryJob(db: DbOrTx, jobId: string, options: RetryOptions = {}): Promise<Job> {
  const changes = retryChanges(options);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!current) throw new AppError("NOT_FOUND", "Job not found.", { jobId });
    if (current.status !== "failed") {
      throw new AppError("INVALID_STATE", `Only a failed job can be retried. This job is ${current.status}.`, {
        jobId,
        status: current.status,
      });
    }
    const [retried] = await tx.update(jobs).set(changes).where(eq(jobs.id, jobId)).returning();
    return retried as Job;
  });
}

// Puts every failed job of a batch back in the queue. Jobs in any other status,
// in particular succeeded ones, are not touched (spec 145).
export async function retryFailedJobsForBatch(
  dbOrTx: DbOrTx,
  batchId: string,
  options: RetryOptions = {},
): Promise<{ retried: number; jobIds: string[] }> {
  const rows = await dbOrTx
    .update(jobs)
    .set(retryChanges(options))
    .where(and(eq(jobs.processingBatchId, batchId), eq(jobs.status, "failed")))
    .returning({ id: jobs.id });
  return { retried: rows.length, jobIds: rows.map((row) => row.id) };
}

// Cancels the queued jobs of a batch. Running jobs are left alone and finish.
export async function cancelQueuedJobsForBatch(
  dbOrTx: DbOrTx,
  batchId: string,
  now: Date = new Date(),
): Promise<{ cancelled: number }> {
  const rows = await dbOrTx
    .update(jobs)
    .set({ status: "cancelled", finishedAt: now, updatedAt: now })
    .where(and(eq(jobs.processingBatchId, batchId), eq(jobs.status, "queued")))
    .returning({ id: jobs.id });
  return { cancelled: rows.length };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type JobCounts = Record<JobStatus, number> & { total: number };

function emptyCounts(): JobCounts {
  return { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, total: 0 };
}

export async function getJobCountsForBatch(db: DbOrTx, batchId: string): Promise<JobCounts> {
  const rows = await db
    .select({ status: jobs.status, value: count() })
    .from(jobs)
    .where(eq(jobs.processingBatchId, batchId))
    .groupBy(jobs.status);
  const counts = emptyCounts();
  for (const row of rows) {
    counts[row.status] = row.value;
    counts.total += row.value;
  }
  return counts;
}

export type QueueStats = {
  queued: number;
  running: number;
  failed: number;
  // The earliest time at which a still queued job became available, and how long
  // ago that was. Null when nothing is waiting. A job waiting for a backoff
  // delay has an age of 0.
  oldestQueuedAt: Date | null;
  oldestQueuedAgeMs: number | null;
};

export async function getQueueStats(db: DbOrTx, options: { now?: Date } = {}): Promise<QueueStats> {
  const now = options.now ?? new Date();
  const rows = await db
    .select({
      status: jobs.status,
      value: count(),
      oldest: sql<string | null>`min(${jobs.availableAt})`,
    })
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running", "failed"]))
    .groupBy(jobs.status);
  const stats: QueueStats = { queued: 0, running: 0, failed: 0, oldestQueuedAt: null, oldestQueuedAgeMs: null };
  for (const row of rows) {
    if (row.status === "queued") {
      stats.queued = row.value;
      if (row.oldest) {
        stats.oldestQueuedAt = new Date(row.oldest);
        stats.oldestQueuedAgeMs = Math.max(0, now.getTime() - stats.oldestQueuedAt.getTime());
      }
    } else if (row.status === "running") stats.running = row.value;
    else if (row.status === "failed") stats.failed = row.value;
  }
  return stats;
}

export async function getJob(db: DbOrTx, jobId: string): Promise<Job | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return job ?? null;
}

export type ListJobsFilters = {
  status?: JobStatus | JobStatus[];
  type?: string | string[];
  processingBatchId?: string;
  // Page size, 1 to 500. Default 50.
  limit?: number;
  offset?: number;
};

// Newest first. `total` is the number of jobs matching the filters, for paging.
export async function listJobs(
  db: DbOrTx,
  filters: ListJobsFilters = {},
): Promise<{ jobs: Job[]; total: number; limit: number; offset: number }> {
  const conditions: SQL[] = [];
  if (filters.status !== undefined) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    for (const status of statuses) {
      if (!JOB_STATUSES.includes(status)) {
        throw new AppError("VALIDATION_ERROR", `Unknown job status "${String(status)}".`);
      }
    }
    if (statuses.length === 0) return { jobs: [], total: 0, limit: 0, offset: 0 };
    conditions.push(inArray(jobs.status, statuses));
  }
  if (filters.type !== undefined) {
    const types = Array.isArray(filters.type) ? filters.type : [filters.type];
    if (types.length === 0) return { jobs: [], total: 0, limit: 0, offset: 0 };
    conditions.push(inArray(jobs.type, types));
  }
  if (filters.processingBatchId) conditions.push(eq(jobs.processingBatchId, filters.processingBatchId));

  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 50), 1), 500);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalRow] = await db.select({ value: count() }).from(jobs).where(where);
  const rows = await db
    .select()
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.createdAt), asc(jobs.id))
    .limit(limit)
    .offset(offset);
  return { jobs: rows, total: totalRow?.value ?? 0, limit, offset };
}
