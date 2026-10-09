// Error helpers for the storage package. Every failure that leaves this package is
// an AppError (spec 69); the original error is kept as `cause` for the server log.
import { AppError, isAppError } from "@dialect/domain";

export function storageError(message: string, cause?: unknown, details?: unknown): AppError {
  return new AppError("STORAGE_ERROR", message, details, { cause });
}

export function mediaNotFound(key: string, cause?: unknown): AppError {
  return new AppError("MEDIA_NOT_FOUND", "The requested media object does not exist.", { key }, { cause });
}

export function objectExists(key: string, cause?: unknown): AppError {
  return new AppError(
    "CONFLICT",
    "An object already exists at this key. Stored objects are never overwritten.",
    { key },
    { cause },
  );
}

// Passes an AppError through unchanged and wraps anything else as STORAGE_ERROR.
export function toStorageError(error: unknown, message: string, details?: unknown): AppError {
  if (isAppError(error)) return error;
  return storageError(message, error, details);
}

export function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
