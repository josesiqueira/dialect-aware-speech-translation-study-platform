// Cost limits of Demo Mode (spec 67, 80). Every stage of the demo pipeline is a
// paid call to an external provider, and a public demo is open to anyone.
//
// Two limits live here:
// 1. The daily budget of the study: at most `demoDailyRunLimit` pipeline runs in
//    24 hours over all visitors (study setting, default 200). One run is one
//    recording whose pipeline was started. The count is kept in rate_limit_hits
//    (bucket `demo-daily-runs:<study id>`), not derived from model_runs, because
//    the rows of a demo session are deleted when the study does not keep demo data.
// 2. The number of attempts of one step of one recording (see MAX_STEP_ATTEMPTS
//    and attemptsExhausted): a step that keeps failing is not paid for again and again.
import { and, eq, gt, sql } from "drizzle-orm";
import { modelRuns, rateLimitHits } from "@dialect/db";
import { AppError, type demoSchemas } from "@dialect/domain";
import type { ServiceContext } from "../context";

export const DEMO_BUDGET_WINDOW_SECONDS = 24 * 3600;

// Attempts of one pipeline step (ASR of a recording, one translation, one
// synthesis) in Demo Mode. Each attempt is a new provider call.
export const MAX_STEP_ATTEMPTS = 3;

export function demoBudgetBucket(studyId: string): string {
  return `demo-daily-runs:${studyId}`;
}

export function demoBudgetReachedError(limit: number, retryAfterSeconds: number): AppError {
  return new AppError(
    "RATE_LIMITED",
    `The demonstration has reached its limit of ${limit} runs in 24 hours. Please try again later.`,
    { reason: "demo_daily_budget", limit, retryAfterSeconds },
  );
}

// Takes one run from the daily budget of the study, or throws RATE_LIMITED.
// Count and insert are one transaction, serialized per study with an advisory
// lock, so parallel requests cannot go past the limit.
export async function consumeDemoRunBudget(
  ctx: ServiceContext,
  input: { studyId: string; limit: number },
): Promise<{ used: number; limit: number }> {
  const now = ctx.now();
  const bucket = demoBudgetBucket(input.studyId);
  const windowStart = new Date(now.getTime() - DEMO_BUDGET_WINDOW_SECONDS * 1000);
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${bucket}, 0))`);
    const [row] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        oldest: sql<Date | string | null>`min(${rateLimitHits.createdAt})`,
      })
      .from(rateLimitHits)
      .where(and(eq(rateLimitHits.bucketKey, bucket), gt(rateLimitHits.createdAt, windowStart)));
    const used = row?.count ?? 0;
    if (used >= input.limit) {
      const oldest = row?.oldest ? new Date(row.oldest) : now;
      const freeAt = oldest.getTime() + DEMO_BUDGET_WINDOW_SECONDS * 1000;
      throw demoBudgetReachedError(input.limit, Math.max(1, Math.ceil((freeAt - now.getTime()) / 1000)));
    }
    await tx.insert(rateLimitHits).values({ bucketKey: bucket, createdAt: now });
    return { used: used + 1, limit: input.limit };
  });
}

// Attempts already made for one logical step (the base idempotency key of the
// step, see processing/steps.ts), and whether one of them succeeded.
export async function stepAttempts(
  ctx: ServiceContext,
  baseKey: string,
): Promise<{ attempts: number; succeeded: boolean }> {
  const [row] = await ctx.db
    .select({
      attempts: sql<number>`count(*)::int`,
      succeeded: sql<boolean>`coalesce(bool_or(${modelRuns.status} = 'succeeded'), false)`,
    })
    .from(modelRuns)
    .where(sql`starts_with(${modelRuns.idempotencyKey}, ${`${baseKey}#`})`);
  return { attempts: row?.attempts ?? 0, succeeded: row?.succeeded === true };
}

// True when the step failed `max` times and never succeeded. A step that
// succeeded is never exhausted: the step functions return its stored output
// without a new provider call.
export async function attemptsExhausted(ctx: ServiceContext, baseKey: string, max: number): Promise<boolean> {
  const { attempts, succeeded } = await stepAttempts(ctx, baseKey);
  return !succeeded && attempts >= max;
}

export function attemptLimitError(stage: "transcription" | "translation" | "speech synthesis", max: number): demoSchemas.PipelineStageError {
  return {
    code: "RATE_LIMITED",
    reason: "attempt_limit",
    message: `The ${stage} of this recording failed ${max} times and is not tried again. Make a new recording to try again.`,
    retryable: false,
  };
}
