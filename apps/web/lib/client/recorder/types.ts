// Shared types of the browser recorder (spec 9, 10, 31, 32).
// Nothing in this folder talks to the server: the recorder produces a recording
// object and capture metadata, and the page decides what to do with them.
import type { CaptureMethod, CaptureQualityClass } from "@dialect/domain";
import type { RecorderError } from "./errors";

/** The audio constraints that were passed to getUserMedia, as a plain JSON object. */
export type RequestedAudioConstraints = Record<string, unknown>;

/** The result of MediaStreamTrack.getSettings(), copied to a plain JSON object. */
export type ActualTrackSettings = Record<string, unknown>;

/**
 * One difference between what was asked for and what the browser reports.
 * "not_honored": the track reports another value (for example echo cancellation is still on).
 * "not_reported": the browser does not report this setting, so nothing is known about it.
 * "context_rate_differs": the AudioContext ran at another rate than the track,
 * so the browser resampled the signal before the recorder received it.
 */
export interface ConstraintMismatch {
  constraint: string;
  kind: "not_honored" | "not_reported" | "context_rate_differs";
  requested: unknown;
  actual: unknown;
}

/** An open microphone with the facts about it. Returned by requestMicrophone. */
export interface MicrophoneAccess {
  stream: MediaStream;
  track: MediaStreamTrack;
  requestedConstraints: RequestedAudioConstraints;
  actualTrackSettings: ActualTrackSettings;
  /**
   * Class of the input device (built_in, usb, bluetooth, headset, unknown),
   * derived from the device label. The label itself is never kept. Null when
   * the browser gives no label.
   */
  deviceLabel: string | null;
  /** MediaStreamTrack.getCapabilities(), when the browser provides it. */
  capabilities: Record<string, unknown> | null;
  constraintMismatches: ConstraintMismatch[];
}

export type RecorderImplementation = "pcm" | "compressed";
export type StoppedBy = "user" | "max_duration";
export type PcmBitDepth = 16 | 24;

/** The finished recording. This is what the page uploads together with its metadata. */
export interface RecordingResult {
  blob: Blob;
  /** "audio/wav" for the PCM recorder, the MediaRecorder's own type for the fallback. */
  mimeType: string;
  durationMs: number;
  /**
   * PCM: the real AudioContext rate, which is also the rate in the WAV header.
   * Fallback: the rate reported by the track, or null when the browser does not report it
   * (the server determines the rate of a compressed file from its bytes).
   */
  sampleRateHz: number | null;
  /** PCM: always 1. Fallback: the track's channel count, or null when not reported. */
  channels: number | null;
  /** PCM: 16 or 24. Fallback: null (a lossy codec has no bit depth). */
  bitDepth: PcmBitDepth | null;
  sizeBytes: number;
  captureMethod: CaptureMethod;
  captureQualityClass: CaptureQualityClass;
  requestedConstraints: RequestedAudioConstraints;
  actualTrackSettings: ActualTrackSettings;
  /** PCM: the rate the AudioContext really ran at. Fallback: null (no AudioContext is used). */
  audioContextSampleRate: number | null;
  deviceLabel: string | null;
  /** Mismatches of the microphone request plus, for PCM, a context rate that differs from the track. */
  constraintMismatches: ConstraintMismatch[];
  stoppedBy: StoppedBy;
  /** Largest absolute sample value before conversion, 0 to 1 and above when clipped. Null for the fallback. */
  peak: number | null;
  /** ISO 8601 time at which capture started (browser clock). */
  startedAt: string;
  /** PCM only: number of channels the capture node received. Above 1 means channel 0 was kept. */
  inputChannelCount: number | null;
  /** PCM only: samples at or beyond full scale, which were limited to full scale in the file. */
  clippedSampleCount: number | null;
}

export interface RecorderProgress {
  /** PCM: from the sample count. Fallback: from the monotonic clock. */
  elapsedMs: number;
  /** Peak of the latest block, 0 to 1. Null when the implementation cannot measure it. */
  peak: number | null;
}

export interface RecorderCallbacks {
  onProgress?: (progress: RecorderProgress) => void;
  /** The recorder reached maxDurationMs and stopped by itself. result.stoppedBy is "max_duration". */
  onAutoStop?: (result: RecordingResult) => void;
  /** Capture broke while recording (device unplugged, audio graph suspended). The data is dropped. */
  onError?: (error: RecorderError) => void;
}

export interface RecorderOptions extends RecorderCallbacks {
  maxDurationMs: number;
}

export type RecorderState = "ready" | "recording" | "stopping" | "closed";

/** One recording. Create a new recorder for each attempt (createRecorder). */
export interface Recorder {
  readonly implementation: RecorderImplementation;
  readonly captureMethod: CaptureMethod;
  readonly captureQualityClass: CaptureQualityClass;
  readonly state: RecorderState;
  /** Begins capture. Throws RecorderError if another recording is active. */
  start(): void;
  /** Ends capture and returns the recording. The audio graph is closed; the stream stays open. */
  stop(): Promise<RecordingResult>;
  /** Ends capture and drops the data. Safe to call in any state. */
  cancel(): Promise<void>;
}

export interface RecorderFallbackInfo {
  /** Why the PCM recorder was not used. */
  reason: "audio_worklet_unavailable" | "audio_worklet_failed";
  /** Technical detail for the stored metadata and the console, not for the participant. */
  detail: string;
}

export interface CreatedRecorder {
  recorder: Recorder;
  implementation: RecorderImplementation;
  captureMethod: CaptureMethod;
  captureQualityClass: CaptureQualityClass;
  /** Set when "pcm" was preferred and the compressed recorder is used instead. */
  fallback: RecorderFallbackInfo | null;
}
