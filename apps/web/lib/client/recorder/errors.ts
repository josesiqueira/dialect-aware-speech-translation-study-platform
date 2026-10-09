// Recorder errors use the participant error categories of @dialect/domain (spec 69)
// plus a message key that the page localizes. The `message` field is technical
// English for the console and is never shown to a participant.
import type { ErrorCode } from "@dialect/domain";

export type RecorderErrorCode = Extract<
  ErrorCode,
  "MICROPHONE_PERMISSION_DENIED" | "RECORDING_FAILED" | "UPLOAD_FAILED"
>;

export const RECORDER_MESSAGE_KEYS = [
  /** The participant or the browser settings refused the microphone. */
  "microphone.permission_denied",
  /** No audio input device exists. */
  "microphone.not_found",
  /** The device exists but cannot be opened (used by another program, or a hardware error). */
  "microphone.busy",
  /** The browser has no microphone API here (old browser, or a page not served over HTTPS). */
  "microphone.unsupported",
  /** The microphone was unplugged or switched off while recording. */
  "recording.device_disconnected",
  /** The browser suspended or closed audio processing while recording. */
  "recording.interrupted",
  /** The recorder could not be started. */
  "recording.start_failed",
  /** The recording contains no audio. */
  "recording.empty",
  /** A second recording was started while one is active. */
  "recording.already_active",
  /** The upload did not succeed. The recording is kept. */
  "upload.failed",
] as const;
export type RecorderMessageKey = (typeof RECORDER_MESSAGE_KEYS)[number];

export class RecorderError extends Error {
  readonly code: RecorderErrorCode;
  readonly messageKey: RecorderMessageKey;

  constructor(code: RecorderErrorCode, messageKey: RecorderMessageKey, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RecorderError";
    this.code = code;
    this.messageKey = messageKey;
  }
}

export function isRecorderError(value: unknown): value is RecorderError {
  if (value instanceof RecorderError) return true;
  // Also an error of the same shape made by another copy of the class.
  return (
    value instanceof Error &&
    value.name === "RecorderError" &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { messageKey?: unknown }).messageKey === "string"
  );
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Maps a getUserMedia rejection to a participant error category. The names are
 * the ones defined for getUserMedia in the Media Capture and Streams specification.
 */
export function mapGetUserMediaError(error: unknown): RecorderError {
  if (isRecorderError(error)) return error;
  const detail = errorText(error);
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError": // old Chromium name
      return new RecorderError("MICROPHONE_PERMISSION_DENIED", "microphone.permission_denied", detail, { cause: error });
    case "NotFoundError":
    case "DevicesNotFoundError": // old Chromium name
    case "OverconstrainedError":
      return new RecorderError("RECORDING_FAILED", "microphone.not_found", detail, { cause: error });
    case "NotReadableError":
    case "TrackStartError": // old Chromium name
    case "AbortError":
      return new RecorderError("RECORDING_FAILED", "microphone.busy", detail, { cause: error });
    case "TypeError":
    case "NotSupportedError":
      return new RecorderError("RECORDING_FAILED", "microphone.unsupported", detail, { cause: error });
    default:
      return new RecorderError("RECORDING_FAILED", "recording.start_failed", detail, { cause: error });
  }
}

/** Wraps any other failure as RECORDING_FAILED, keeping an existing RecorderError unchanged. */
export function toRecorderError(error: unknown, messageKey: RecorderMessageKey = "recording.start_failed"): RecorderError {
  if (isRecorderError(error)) return error;
  return new RecorderError("RECORDING_FAILED", messageKey, errorText(error), { cause: error });
}
