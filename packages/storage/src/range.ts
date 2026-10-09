// Byte range handling shared by the drivers (spec 135).
import { storageError } from "./errors";
import type { GetObjectOptions } from "./StorageAdapter";

// Returns the inclusive range clamped to the object size, or null when no range
// was requested. Throws AppError("STORAGE_ERROR") with
// details.reason = "range_not_satisfiable" when the range cannot be served, so a
// route handler can answer with HTTP 416. Callers that serve HTTP Range requests
// should call stat() first and validate the header against the size.
export function resolveRange(
  range: GetObjectOptions["range"],
  sizeBytes: number,
): { start: number; end: number } | null {
  if (!range) return null;
  const { start } = range;
  const end = range.end === undefined ? sizeBytes - 1 : Math.min(range.end, sizeBytes - 1);
  const valid =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    start < sizeBytes &&
    end >= start;
  if (!valid) {
    throw storageError("The requested byte range cannot be served.", undefined, {
      reason: "range_not_satisfiable",
      sizeBytes,
    });
  }
  return { start, end };
}
