// User-safe error categories (spec section 69). Services throw AppError; API routes
// translate it to an HTTP response. Provider stack traces never reach participants.

export const PARTICIPANT_ERROR_CODES = [
  "MICROPHONE_PERMISSION_DENIED",
  "RECORDING_FAILED",
  "UPLOAD_FAILED",
  "SESSION_EXPIRED",
  "STUDY_CLOSED",
] as const;

export const ADMIN_ERROR_CODES = [
  "ASR_PROVIDER_ERROR",
  "TRANSLATION_PROVIDER_ERROR",
  "TTS_PROVIDER_ERROR",
  "MEDIA_NOT_FOUND",
  "INVALID_AUDIO",
  "DATABASE_ERROR",
  "STORAGE_ERROR",
] as const;

export const GENERAL_ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "IMMUTABLE_RECORD",
  "INVALID_STATE",
  "RATE_LIMITED",
  "CONFIGURATION_MISSING",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;

export const ERROR_CODES = [
  ...PARTICIPANT_ERROR_CODES,
  ...ADMIN_ERROR_CODES,
  ...GENERAL_ERROR_CODES,
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  MICROPHONE_PERMISSION_DENIED: 400,
  RECORDING_FAILED: 400,
  UPLOAD_FAILED: 500,
  SESSION_EXPIRED: 401,
  STUDY_CLOSED: 403,
  ASR_PROVIDER_ERROR: 502,
  TRANSLATION_PROVIDER_ERROR: 502,
  TTS_PROVIDER_ERROR: 502,
  MEDIA_NOT_FOUND: 404,
  INVALID_AUDIO: 422,
  DATABASE_ERROR: 500,
  STORAGE_ERROR: 500,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  IMMUTABLE_RECORD: 409,
  INVALID_STATE: 409,
  RATE_LIMITED: 429,
  CONFIGURATION_MISSING: 422,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

// Names of AppError and of its subclasses (AiProviderError in @dialect/ai,
// WavParseError in @dialect/storage). A new subclass adds its name here.
export const APP_ERROR_NAMES: readonly string[] = ["AppError", "AiProviderError", "WavParseError"];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

// True for an AppError of this module and for an error of the same shape made
// by another copy of the class.
//
// One process can hold more than one copy of this module: the production web
// build bundles it once per group of routes, and a development server keeps
// old copies after a hot reload. Objects that live for the whole process (the
// AI provider registry, the storage adapter) are created by one copy and used
// by code of another, so an error thrown by them fails `instanceof AppError`
// there (defect E2E-2). The check is therefore structural: an Error whose
// `name` is one of APP_ERROR_NAMES and whose `code` is one of ERROR_CODES.
// `instanceof` stays as the fast path.
export function isAppError(value: unknown): value is AppError {
  if (value instanceof AppError) return true;
  if (!(value instanceof Error)) return false;
  const code = (value as { code?: unknown }).code;
  return APP_ERROR_NAMES.includes(value.name) && typeof code === "string" && ERROR_CODE_SET.has(code);
}

// HTTP status of an AppError, also of one made by another copy of the class.
export function httpStatusOf(error: AppError): number {
  return HTTP_STATUS[error.code] ?? 500;
}

// Shape of every JSON error body returned by the API.
export type ApiErrorBody = {
  error: { code: ErrorCode; message: string; details?: unknown };
};
