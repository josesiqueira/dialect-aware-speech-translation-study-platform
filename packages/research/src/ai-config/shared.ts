// Helpers shared by the prompt version and model config services.
import { eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type {
  aiPromptVersions,
  modelConfigs} from "@dialect/db";
import {
  getPgError,
  isImmutableRecordError,
  isInvalidStateError,
  isUniqueViolation,
  studies,
  triggerErrorReason,
  type DbOrTx,
  type Transaction,
} from "@dialect/db";
import { AppError, isAppError } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { resolveStudy as resolveSharedStudy } from "../study";

export type PromptVersion = typeof aiPromptVersions.$inferSelect;
export type ModelConfig = typeof modelConfigs.$inferSelect;
export type Study = typeof studies.$inferSelect;

// The model config the ASR job uses when its payload names no config
// (cross-slice agreement "Automatic ASR after upload" in the plan).
export const ASR_DEFAULT_CONFIG_KEY = "asr_default";

// Validates service input with a shared schema and reports a failure as an
// AppError, so that callers outside a route handler also get a clear error.
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  const text = issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join(" ");
  throw new AppError("VALIDATION_ERROR", text || "The input is not valid.", { issues });
}

// The study to work on. Routes may leave the study out: the installation has
// one study, and the oldest one is used.
// This area's function takes the service context. The shared implementation is
// in ../study.ts.
export function resolveStudy(ctx: ServiceContext, studyId?: string | null): Promise<Study> {
  return resolveSharedStudy(ctx.db, studyId);
}

export async function requireStudy(db: DbOrTx, studyId: string): Promise<void> {
  const [study] = await db.select({ id: studies.id }).from(studies).where(eq(studies.id, studyId)).limit(1);
  if (!study) throw new AppError("NOT_FOUND", "The study does not exist.", { studyId });
}

// Serializes every change to the versions of one key (create, update, activate,
// retire, delete). The lock ends with the transaction. Two activations of the
// same key therefore run one after the other, and the second one sees the
// result of the first.
export async function lockKey(
  tx: Transaction,
  kind: "ai_prompt" | "model_config",
  studyId: string,
  key: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${kind}:${studyId}:${key}`}, 0))`);
}

// Turns an error raised by the database triggers or unique indexes into an
// AppError. The services check the state first, so this is the safety net.
export function mapDatabaseError(error: unknown, what: string): unknown {
  if (isAppError(error)) return error;
  if (isImmutableRecordError(error)) {
    return new AppError(
      "IMMUTABLE_RECORD",
      `This ${what} is active or retired and can no longer be changed. Create a new draft version instead.`,
      { reason: triggerErrorReason(error) },
      { cause: error },
    );
  }
  if (isInvalidStateError(error)) {
    return new AppError(
      "INVALID_STATE",
      `The ${what} is not in a state that allows this change.`,
      { reason: triggerErrorReason(error) },
      { cause: error },
    );
  }
  if (isUniqueViolation(error)) {
    return new AppError(
      "CONFLICT",
      `Another change to this ${what} key happened at the same time. Reload and try again.`,
      { constraint: getPgError(error)?.constraint },
      { cause: error },
    );
  }
  return error;
}

// Runs a transaction and maps database errors.
export async function inTransaction<T>(
  ctx: ServiceContext,
  what: string,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await ctx.db.transaction(run);
  } catch (error) {
    throw mapDatabaseError(error, what);
  }
}

export function versionLabel(row: { key: string; versionNumber: number }): string {
  return `${row.key} v${row.versionNumber}`;
}
