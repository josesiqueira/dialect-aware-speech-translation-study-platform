// Fallback recorder (spec 31.2): the browser's MediaRecorder with a lossy codec.
// Used when AudioWorklet is missing or fails to start, and in Demo Mode when
// the page asks for it. Every result is marked "compressed_fallback" and
// carries the MIME type the recorder really used, so a compressed recording is
// never presented as lossless.
//
// Differences from the PCM recorder, by design of the MediaRecorder API:
// the duration comes from the monotonic clock (there are no sample counts), and
// no peak level is available.
import { claimRecording, releaseRecording } from "./activeRecording";
import { RecorderError, toRecorderError } from "./errors";
import type { MicrophoneAccess, Recorder, RecorderOptions, RecorderState, RecordingResult, StoppedBy } from "./types";

/** Preferred container and codec, best first. The server accepts exactly these families. */
export const FALLBACK_MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"] as const;

/** How often MediaRecorder hands over data, and how often progress is reported. */
const TIMESLICE_MS = 250;

/** The first type of the ordered list that the browser can record, or null. */
export function selectFallbackMimeType(
  isTypeSupported: (mimeType: string) => boolean,
  candidates: readonly string[] = FALLBACK_MIME_TYPES,
): string | null {
  for (const candidate of candidates) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // Treat a throwing check as "not supported".
    }
  }
  return null;
}

export function isMediaRecorderSupported(): boolean {
  return typeof window !== "undefined" && typeof window.MediaRecorder === "function";
}

export class MediaRecorderFallback implements Recorder {
  readonly implementation = "compressed" as const;
  readonly captureMethod = "media_recorder" as const;
  readonly captureQualityClass = "compressed_fallback" as const;

  private currentState: RecorderState = "ready";
  private readonly recorder: MediaRecorder;
  private chunks: Blob[] = [];
  private startedAt: string | null = null;
  private startClock = 0;
  private stopClock = 0;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPromise: Promise<RecordingResult> | null = null;
  private readonly onTrackEnded = () => this.fail("recording.device_disconnected", "The microphone track ended.");

  private constructor(
    private readonly microphone: MicrophoneAccess,
    private readonly options: RecorderOptions,
    mimeType: string,
  ) {
    this.recorder = new MediaRecorder(microphone.stream, { mimeType });
    this.recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) this.chunks.push(event.data);
      if (this.currentState === "recording") {
        this.options.onProgress?.({ elapsedMs: performance.now() - this.startClock, peak: null });
      }
    };
    this.recorder.onerror = () => this.fail("recording.interrupted", "MediaRecorder reported an error.");
    microphone.track.addEventListener("ended", this.onTrackEnded);
  }

  static create(microphone: MicrophoneAccess, options: RecorderOptions): MediaRecorderFallback {
    if (!isMediaRecorderSupported()) {
      throw new RecorderError("RECORDING_FAILED", "recording.start_failed", "MediaRecorder is not available in this browser.");
    }
    if (microphone.track.readyState !== "live") {
      throw new RecorderError("RECORDING_FAILED", "recording.device_disconnected", "The microphone track is not live.");
    }
    const mimeType = selectFallbackMimeType((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      throw new RecorderError(
        "RECORDING_FAILED",
        "recording.start_failed",
        `MediaRecorder supports none of: ${FALLBACK_MIME_TYPES.join(", ")}.`,
      );
    }
    try {
      return new MediaRecorderFallback(microphone, options, mimeType);
    } catch (error) {
      throw toRecorderError(error);
    }
  }

  get state(): RecorderState {
    return this.currentState;
  }

  start(): void {
    if (this.currentState !== "ready") {
      throw new RecorderError("RECORDING_FAILED", "recording.start_failed", `The recorder cannot start in state "${this.currentState}".`);
    }
    claimRecording(this);
    try {
      this.recorder.start(TIMESLICE_MS);
    } catch (error) {
      this.close();
      throw toRecorderError(error);
    }
    this.startedAt = new Date().toISOString();
    this.startClock = performance.now();
    this.currentState = "recording";
    this.limitTimer = setTimeout(() => {
      if (this.currentState !== "recording") return;
      this.finish("max_duration").then(
        (result) => this.options.onAutoStop?.(result),
        (error: unknown) => this.options.onError?.(toRecorderError(error)),
      );
    }, this.options.maxDurationMs);
  }

  stop(): Promise<RecordingResult> {
    if (this.stopPromise) return this.stopPromise;
    if (this.currentState !== "recording") {
      return Promise.reject(
        new RecorderError("RECORDING_FAILED", "recording.start_failed", `The recorder cannot stop in state "${this.currentState}".`),
      );
    }
    return this.finish("user");
  }

  async cancel(): Promise<void> {
    if (this.currentState === "closed") return;
    this.chunks = [];
    this.close();
  }

  private finish(stoppedBy: StoppedBy): Promise<RecordingResult> {
    this.currentState = "stopping";
    this.stopClock = performance.now();
    this.stopPromise = new Promise<RecordingResult>((resolve, reject) => {
      this.recorder.onstop = () => {
        try {
          const result = this.buildResult(stoppedBy);
          this.chunks = [];
          this.close();
          if (result.sizeBytes === 0) {
            throw new RecorderError("RECORDING_FAILED", "recording.empty", "MediaRecorder produced no data.");
          }
          resolve(result);
        } catch (error) {
          this.close();
          reject(toRecorderError(error));
        }
      };
      try {
        // stop() delivers the last data through ondataavailable and then fires onstop.
        this.recorder.stop();
      } catch (error) {
        this.chunks = [];
        this.close();
        reject(toRecorderError(error));
      }
    });
    return this.stopPromise;
  }

  private buildResult(stoppedBy: StoppedBy): RecordingResult {
    const { microphone } = this;
    // The recorder's own mimeType is what was really produced. It can be more specific than the request.
    const mimeType = this.recorder.mimeType || this.chunks[0]?.type || "application/octet-stream";
    const blob = new Blob(this.chunks, { type: mimeType });
    const settings = microphone.actualTrackSettings;
    const elapsed = this.stopClock - this.startClock;
    return {
      blob,
      mimeType,
      durationMs: stoppedBy === "max_duration" ? Math.min(elapsed, this.options.maxDurationMs) : elapsed,
      sampleRateHz: typeof settings.sampleRate === "number" ? settings.sampleRate : null,
      channels: typeof settings.channelCount === "number" ? settings.channelCount : null,
      bitDepth: null,
      sizeBytes: blob.size,
      captureMethod: this.captureMethod,
      captureQualityClass: this.captureQualityClass,
      requestedConstraints: microphone.requestedConstraints,
      actualTrackSettings: settings,
      audioContextSampleRate: null,
      deviceLabel: microphone.deviceLabel,
      constraintMismatches: microphone.constraintMismatches,
      stoppedBy,
      peak: null,
      startedAt: this.startedAt ?? new Date().toISOString(),
      inputChannelCount: null,
      clippedSampleCount: null,
    };
  }

  private fail(messageKey: "recording.device_disconnected" | "recording.interrupted", detail: string): void {
    if (this.currentState !== "recording") return;
    this.chunks = [];
    this.close();
    this.options.onError?.(new RecorderError("RECORDING_FAILED", messageKey, detail));
  }

  private close(): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    releaseRecording(this);
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    this.microphone.track.removeEventListener("ended", this.onTrackEnded);
    this.recorder.ondataavailable = null;
    this.recorder.onerror = null;
    this.recorder.onstop = null;
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // Already inactive.
    }
  }
}
