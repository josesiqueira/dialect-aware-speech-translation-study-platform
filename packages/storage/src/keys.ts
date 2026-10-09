// Object key validation and key builders (spec 36, 123, Appendix B).
// Keys are built from UUIDs and the study slug only. Participant names and
// participant codes never appear in a key.
import { AppError } from "@dialect/domain";
import { storageError } from "./errors";

const MAX_KEY_LENGTH = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STUDY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The local driver keeps temporary files in this directory under its root.
export const RESERVED_KEY_PREFIX = ".tmp";

// Throws AppError("STORAGE_ERROR") when the key could address anything outside the
// storage root: absolute paths, "." or ".." segments, empty segments, backslashes,
// null bytes or other control characters. All drivers call this on every operation.
export function assertValidObjectKey(key: string): void {
  const reject = (reason: string): never => {
    throw storageError(`Invalid storage key: ${reason}.`, undefined, { reason });
  };
  if (typeof key !== "string" || key.length === 0) reject("the key is empty");
  if (key.length > MAX_KEY_LENGTH) reject("the key is too long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) reject("the key contains a control character");
  if (key.includes("\\")) reject("the key contains a backslash");
  if (key.startsWith("/")) reject("the key is an absolute path");
  if (/^[A-Za-z]:/.test(key)) reject("the key is an absolute path");
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "") reject("the key contains an empty path segment");
    if (segment === "." || segment === "..") reject("the key contains a relative path segment");
  }
  if (segments[0] === RESERVED_KEY_PREFIX) reject("the key uses a reserved prefix");
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function uuidPart(name: string, value: string): string {
  if (!isUuid(value)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a UUID.`, { field: name });
  }
  return value.toLowerCase();
}

function slugPart(value: string): string {
  if (typeof value !== "string" || !STUDY_SLUG_PATTERN.test(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "studySlug must contain only lowercase letters, digits and hyphens.",
      { field: "studySlug" },
    );
  }
  return value;
}

function extensionPart(value: string): string {
  const extension = typeof value === "string" ? value.replace(/^\./, "").toLowerCase() : "";
  if (!EXTENSION_PATTERN.test(extension)) {
    throw new AppError("VALIDATION_ERROR", "extension must be 1 to 8 letters or digits.", {
      field: "extension",
    });
  }
  return extension;
}

// studies/{study}/sessions/{session}/utterances/{utterance}/source/{asset}.{ext}
// Used for the raw upload and, with its own asset id, for a derived canonical WAV.
export function sourceAudioKey(input: {
  studySlug: string;
  sessionId: string;
  utteranceId: string;
  assetId: string;
  extension: string;
}): string {
  return [
    "studies",
    slugPart(input.studySlug),
    "sessions",
    uuidPart("sessionId", input.sessionId),
    "utterances",
    uuidPart("utteranceId", input.utteranceId),
    "source",
    `${uuidPart("assetId", input.assetId)}.${extensionPart(input.extension)}`,
  ].join("/");
}

// studies/{study}/generated/syntheses/{synthesis}/{asset}.{ext}
export function ttsAudioKey(input: {
  studySlug: string;
  synthesisId: string;
  assetId: string;
  extension: string;
}): string {
  return [
    "studies",
    slugPart(input.studySlug),
    "generated",
    "syntheses",
    uuidPart("synthesisId", input.synthesisId),
    `${uuidPart("assetId", input.assetId)}.${extensionPart(input.extension)}`,
  ].join("/");
}

// studies/{study}/exports/{exportJob}/{fileName}
// fileName is a file name chosen by the export code (for example "dataset.zip"),
// never text typed by a participant.
export function exportArchiveKey(input: {
  studySlug: string;
  exportJobId: string;
  fileName: string;
}): string {
  if (
    typeof input.fileName !== "string" ||
    !FILE_NAME_PATTERN.test(input.fileName) ||
    input.fileName.includes("..")
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "fileName must contain only letters, digits, dots, hyphens and underscores.",
      { field: "fileName" },
    );
  }
  return [
    "studies",
    slugPart(input.studySlug),
    "exports",
    uuidPart("exportJobId", input.exportJobId),
    input.fileName,
  ].join("/");
}
