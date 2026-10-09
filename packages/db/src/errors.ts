// Helpers to recognize the errors raised by the database triggers and constraints
// (migration 0002_immutability_triggers.sql, docs/DATA-MODEL.md).
// Services use these to translate a database error into an AppError.

// Raised with the message "IMMUTABLE_RECORD: <table>: <reason>".
export const IMMUTABLE_RECORD_SQLSTATE = "IMMUT";
// Raised with the message "INVALID_STATE: <table>: <reason>".
export const INVALID_STATE_SQLSTATE = "INVST";
export const UNIQUE_VIOLATION_SQLSTATE = "23505";
export const CHECK_VIOLATION_SQLSTATE = "23514";
export const FOREIGN_KEY_VIOLATION_SQLSTATE = "23503";

export type PgErrorInfo = {
  code: string;
  message: string;
  constraint?: string;
  table?: string;
};

// Drizzle wraps the node-postgres error and keeps it as `cause`. This walks the
// cause chain and returns the first error that carries a five character SQLSTATE.
export function getPgError(error: unknown): PgErrorInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (typeof current === "object") {
      const candidate = current as { code?: unknown; message?: unknown; constraint?: unknown; table?: unknown };
      if (typeof candidate.code === "string" && candidate.code.length === 5) {
        return {
          code: candidate.code,
          message: typeof candidate.message === "string" ? candidate.message : "",
          constraint: typeof candidate.constraint === "string" ? candidate.constraint : undefined,
          table: typeof candidate.table === "string" ? candidate.table : undefined,
        };
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      return null;
    }
  }
  return null;
}

export function isImmutableRecordError(error: unknown): boolean {
  return getPgError(error)?.code === IMMUTABLE_RECORD_SQLSTATE;
}

export function isInvalidStateError(error: unknown): boolean {
  return getPgError(error)?.code === INVALID_STATE_SQLSTATE;
}

// Optionally checks the constraint or unique index name, for example "jobs_idempotency_key_unique".
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = getPgError(error);
  if (pgError?.code !== UNIQUE_VIOLATION_SQLSTATE) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const pgError = getPgError(error);
  if (pgError?.code !== CHECK_VIOLATION_SQLSTATE) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

// The trigger message without its "IMMUTABLE_RECORD: " or "INVALID_STATE: " prefix,
// suitable as the AppError message for an admin.
export function triggerErrorReason(error: unknown): string | null {
  const pgError = getPgError(error);
  if (!pgError) return null;
  if (pgError.code !== IMMUTABLE_RECORD_SQLSTATE && pgError.code !== INVALID_STATE_SQLSTATE) return null;
  return pgError.message.replace(/^(IMMUTABLE_RECORD|INVALID_STATE): /, "");
}
