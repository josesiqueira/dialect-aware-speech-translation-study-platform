// The state machine behind useRecorder. A pure reducer: it holds no browser
// object and performs no side effect, so every transition is unit tested.
// The hook performs the side effects (microphone, recorder, blob URLs) and then
// dispatches the event that describes what happened.
//
//   idle -> requesting_permission -> idle (microphone open) -> recording -> stopped
//   stopped -> uploading -> submitted
//                        -> upload_failed -> uploading (retry, same candidate)
//   stopped | upload_failed -> idle -> recording (record again, candidate discarded)
//   requesting_permission | recording -> error -> (try again)
import type { CaptureMethod, CaptureQualityClass } from "@dialect/domain";
import type { RecorderErrorCode, RecorderFallbackInfo, RecorderMessageKey, RecordingResult } from "@/lib/client/recorder";
import type { RecordingControlState } from "../RecordingControlFrame";

/** The states of RecordingControlFrame plus "submitted" (the server confirmed storage; the candidate is released). */
export type RecorderStatus = RecordingControlState | "submitted";

/** A finished recording that waits for the participant's decision, with a blob URL for playback. */
export interface RecordingCandidate extends RecordingResult {
  /** Object URL of `blob` for the native audio element. Revoked when the candidate is released. */
  url: string;
  /** 1 for the first recording of this task, 2 after one re-recording, and so on. */
  attempt: number;
}

export interface RecorderErrorInfo {
  code: RecorderErrorCode;
  messageKey: RecorderMessageKey;
  /** Technical detail for the console. Never shown to the participant. */
  detail?: string;
}

/** Which recorder implementation the current or latest recording uses. */
export interface CaptureInfo {
  captureMethod: CaptureMethod;
  captureQualityClass: CaptureQualityClass;
  fallback: RecorderFallbackInfo | null;
}

export interface RecorderMachineState {
  status: RecorderStatus;
  /** Number of recordings started for this task. Sent to the server on submit (spec 10). */
  attemptCount: number;
  candidate: RecordingCandidate | null;
  error: RecorderErrorInfo | null;
  /** Fraction 0 to 1 while uploading, when the page reports progress. */
  uploadProgress: number | null;
  capture: CaptureInfo | null;
}

export type RecorderEvent =
  /** The browser permission prompt (or the opening of the device) is pending. */
  | { type: "PERMISSION_REQUESTED" }
  /** The microphone is open and nothing is being recorded. */
  | { type: "MICROPHONE_READY" }
  /** Capture began. Counts as a new attempt. */
  | { type: "RECORDING_STARTED"; capture: CaptureInfo }
  | { type: "RECORDING_FINISHED"; candidate: RecordingCandidate }
  /** Opening the microphone or recording failed. */
  | { type: "FAILED"; error: RecorderErrorInfo }
  /** The candidate was dropped from memory (record again, discard, leaving the step). */
  | { type: "CANDIDATE_DISCARDED" }
  | { type: "UPLOAD_STARTED" }
  | { type: "UPLOAD_PROGRESS"; fraction: number }
  | { type: "UPLOAD_SUCCEEDED" }
  | { type: "UPLOAD_FAILED"; error: RecorderErrorInfo }
  /** Back to the first state, with the attempt count at zero (a new task). */
  | { type: "RESET" };

export const INITIAL_RECORDER_STATE: RecorderMachineState = {
  status: "idle",
  attemptCount: 0,
  candidate: null,
  error: null,
  uploadProgress: null,
  capture: null,
};

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** An event that is not valid in the current state leaves the state unchanged. */
export function recorderReducer(state: RecorderMachineState, event: RecorderEvent): RecorderMachineState {
  switch (event.type) {
    case "PERMISSION_REQUESTED":
      if (state.status !== "idle" && state.status !== "error") return state;
      return { ...state, status: "requesting_permission", error: null, candidate: null, uploadProgress: null };

    case "MICROPHONE_READY":
      if (state.status !== "requesting_permission" && state.status !== "error") return state;
      return { ...state, status: "idle", error: null };

    case "RECORDING_STARTED":
      if (state.status !== "idle" && state.status !== "requesting_permission" && state.status !== "error") return state;
      return {
        ...state,
        status: "recording",
        attemptCount: state.attemptCount + 1,
        candidate: null,
        error: null,
        uploadProgress: null,
        capture: event.capture,
      };

    case "RECORDING_FINISHED":
      if (state.status !== "recording") return state;
      return { ...state, status: "stopped", candidate: event.candidate, error: null };

    case "FAILED":
      if (state.status === "uploading" || state.status === "submitted") return state;
      return { ...state, status: "error", candidate: null, error: event.error, uploadProgress: null };

    case "CANDIDATE_DISCARDED":
      // While uploading the candidate is in use. Everything else returns to the first screen.
      if (state.status === "uploading") return state;
      return { ...state, status: "idle", candidate: null, error: null, uploadProgress: null };

    case "UPLOAD_STARTED":
      if ((state.status !== "stopped" && state.status !== "upload_failed") || !state.candidate) return state;
      return { ...state, status: "uploading", error: null, uploadProgress: null };

    case "UPLOAD_PROGRESS":
      if (state.status !== "uploading") return state;
      return { ...state, uploadProgress: clampFraction(event.fraction) };

    case "UPLOAD_SUCCEEDED":
      if (state.status !== "uploading") return state;
      return { ...state, status: "submitted", candidate: null, error: null, uploadProgress: null };

    case "UPLOAD_FAILED":
      if (state.status !== "uploading") return state;
      // The candidate is kept, so a retry sends the same recording (spec 62).
      return { ...state, status: "upload_failed", error: event.error, uploadProgress: null };

    case "RESET":
      return INITIAL_RECORDER_STATE;
  }
}

/** True when the candidate is shorter than the task's minimum duration. */
export function isBelowMinimumDuration(candidate: RecordingCandidate | null, minDurationMs: number | undefined): boolean {
  if (!candidate || !minDurationMs || minDurationMs <= 0) return false;
  return candidate.durationMs < minDurationMs;
}

/** Peak below this value (about -54 dBFS) is treated as "the microphone seems silent". */
export const SILENT_PEAK_THRESHOLD = 0.002;

/** True only when a peak was measured and it is close to zero. An unknown peak is not "silent". */
export function seemsSilent(peak: number | null | undefined): boolean {
  return typeof peak === "number" && peak < SILENT_PEAK_THRESHOLD;
}
