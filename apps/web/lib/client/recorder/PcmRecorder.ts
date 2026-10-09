// Research recorder (spec 31.1): mono PCM captured with an AudioWorkletNode and
// written as a WAV file whose header carries the rate the AudioContext really ran at.
//
// Audio graph:
//   MediaStreamAudioSourceNode -> AudioWorkletNode("pcm-capture") -> destination
// The processor writes nothing to its output, so the connection to the
// destination carries silence. It exists only so that every browser keeps
// processing the node. The microphone is never routed to the speakers.
//
// No sample is changed in JavaScript: no resampling, gain, normalization, noise
// reduction or trimming (spec 85). The only conversion is float to integer PCM
// (see wav.ts).
import { claimRecording, releaseRecording } from "./activeRecording";
import { contextRateMismatch } from "./constraints";
import { RecorderError, toRecorderError } from "./errors";
import type {
  MicrophoneAccess,
  PcmBitDepth,
  Recorder,
  RecorderOptions,
  RecorderState,
  RecordingResult,
  StoppedBy,
} from "./types";
import { maxFramesForDuration, PcmChunkCollector, WAV_MIME_TYPE } from "./wav";

export const PCM_WORKLET_URL = "/worklets/pcm-capture.worklet.js";
export const PCM_WORKLET_PROCESSOR = "pcm-capture";
export const DEFAULT_PCM_BIT_DEPTH: PcmBitDepth = 16;

/** How long stop() waits for the audio thread to hand over its last buffer. */
const FLUSH_TIMEOUT_MS = 1000;
/** How long create() waits for a suspended AudioContext to start. */
const RESUME_TIMEOUT_MS = 2000;

export interface PcmRecorderOptions extends RecorderOptions {
  /** 16 (default) or 24 bit PCM. */
  bitDepth?: PcmBitDepth;
  /** URL of the worklet script. Default: PCM_WORKLET_URL (a static file in public/worklets). */
  workletUrl?: string;
}

type WorkletMessage =
  | { type: "chunk"; samples: Float32Array }
  | { type: "done"; frames: number; inputChannelCount: number };

export function isAudioWorkletSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.AudioContext === "function" &&
    typeof window.AudioWorkletNode === "function" &&
    "audioWorklet" in window.AudioContext.prototype
  );
}

/**
 * Creates the AudioContext at the track's own sample rate when the browser
 * allows it, so that no resampling happens between the device and the file.
 * When the track does not report a rate, or the browser refuses that rate, the
 * context runs at its default rate. The caller always reads the real rate from
 * `context.sampleRate`.
 */
function createContextForTrack(trackSampleRate: unknown): AudioContext {
  if (typeof trackSampleRate === "number" && trackSampleRate > 0) {
    try {
      return new AudioContext({ sampleRate: trackSampleRate, latencyHint: "interactive" });
    } catch {
      // NotSupportedError: the rate is outside what this browser supports. Use the default rate.
    }
  }
  return new AudioContext({ latencyHint: "interactive" });
}

export class PcmRecorder implements Recorder {
  readonly implementation = "pcm" as const;
  readonly captureMethod = "audio_worklet_pcm" as const;
  readonly captureQualityClass = "lossless_pcm" as const;

  private currentState: RecorderState = "ready";
  private collector: PcmChunkCollector;
  private startedAt: string | null = null;
  private inputChannelCount = 0;
  private stopPromise: Promise<RecordingResult> | null = null;
  private resolveDone: (() => void) | null = null;
  private readonly onTrackEnded = () => this.fail("recording.device_disconnected", "The microphone track ended.");
  private readonly onContextStateChange = () => {
    if (this.currentState === "recording" && this.context.state !== "running") {
      this.fail("recording.interrupted", `The AudioContext changed to state "${this.context.state}".`);
    }
  };

  private constructor(
    private readonly microphone: MicrophoneAccess,
    private readonly options: PcmRecorderOptions,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode,
  ) {
    const bitDepth = options.bitDepth ?? DEFAULT_PCM_BIT_DEPTH;
    this.collector = new PcmChunkCollector({
      sampleRateHz: context.sampleRate,
      bitDepth,
      maxFrames: maxFramesForDuration(options.maxDurationMs, context.sampleRate),
    });
    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.onWorkletMessage(event.data);
    node.onprocessorerror = () => this.fail("recording.interrupted", "The audio worklet processor threw an error.");
    microphone.track.addEventListener("ended", this.onTrackEnded);
    context.addEventListener("statechange", this.onContextStateChange);
  }

  /**
   * Builds the audio graph and loads the worklet. Rejects when AudioWorklet is
   * missing or cannot start: createRecorder then uses the compressed fallback.
   */
  static async create(microphone: MicrophoneAccess, options: PcmRecorderOptions): Promise<PcmRecorder> {
    if (!isAudioWorkletSupported()) {
      throw new RecorderError("RECORDING_FAILED", "recording.start_failed", "AudioWorklet is not available in this browser.");
    }
    if (microphone.track.readyState !== "live") {
      throw new RecorderError("RECORDING_FAILED", "recording.device_disconnected", "The microphone track is not live.");
    }
    const context = createContextForTrack(microphone.actualTrackSettings.sampleRate);
    try {
      if (context.state !== "running") {
        // resume() can stay pending when the browser blocks audio, so it is given a time limit.
        await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))]);
      }
      if (context.state !== "running") {
        throw new Error(`The AudioContext is in state "${context.state}" and cannot be started.`);
      }
      await context.audioWorklet.addModule(options.workletUrl ?? PCM_WORKLET_URL);
      const source = context.createMediaStreamSource(microphone.stream);
      const node = new AudioWorkletNode(context, PCM_WORKLET_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      source.connect(node);
      node.connect(context.destination);
      return new PcmRecorder(microphone, options, context, source, node);
    } catch (error) {
      void context.close().catch(() => undefined);
      throw toRecorderError(error);
    }
  }

  get state(): RecorderState {
    return this.currentState;
  }

  /** The rate the audio graph really runs at. This is the rate written to the WAV header. */
  get audioContextSampleRate(): number {
    return this.context.sampleRate;
  }

  start(): void {
    if (this.currentState !== "ready") {
      throw new RecorderError("RECORDING_FAILED", "recording.start_failed", `The recorder cannot start in state "${this.currentState}".`);
    }
    claimRecording(this);
    this.startedAt = new Date().toISOString();
    this.currentState = "recording";
    this.node.port.postMessage({ type: "start" });
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
    this.collector.clear();
    await this.close();
  }

  private finish(stoppedBy: StoppedBy): Promise<RecordingResult> {
    this.currentState = "stopping";
    this.stopPromise = (async () => {
      try {
        // The processor hands over its partly filled buffer and reports the channel count.
        // After a limit stop the collector is full and ignores those last samples.
        await this.flushWorklet();
        const result = this.buildResult(stoppedBy);
        // The Blob now holds the audio. Drop the recorder's own copy.
        this.collector.clear();
        await this.close();
        if (result.sizeBytes <= 44 || result.durationMs <= 0) {
          throw new RecorderError("RECORDING_FAILED", "recording.empty", "No audio samples were captured.");
        }
        return result;
      } catch (error) {
        this.collector.clear();
        await this.close();
        throw toRecorderError(error);
      }
    })();
    return this.stopPromise;
  }

  /** Asks the processor for its partly filled buffer and waits for the "done" message. */
  private flushWorklet(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveDone = null;
        resolve();
      }, FLUSH_TIMEOUT_MS);
      this.resolveDone = () => {
        clearTimeout(timer);
        this.resolveDone = null;
        resolve();
      };
      this.node.port.postMessage({ type: "stop" });
    });
  }

  private onWorkletMessage(message: WorkletMessage): void {
    if (message.type === "done") {
      this.inputChannelCount = message.inputChannelCount;
      this.resolveDone?.();
      return;
    }
    if (message.type !== "chunk") return;
    if (this.currentState !== "recording" && this.currentState !== "stopping") return;
    const appended = this.collector.append(message.samples);
    if (appended.acceptedFrames > 0 && this.currentState === "recording") {
      this.options.onProgress?.({ elapsedMs: this.collector.durationMs, peak: appended.peak });
    }
    if (appended.limitReached && this.currentState === "recording") {
      // Maximum duration (spec 9): stop by ourselves and tell the caller it was a limit stop.
      this.finish("max_duration").then(
        (result) => this.options.onAutoStop?.(result),
        (error: unknown) => this.options.onError?.(toRecorderError(error)),
      );
    }
  }

  private buildResult(stoppedBy: StoppedBy): RecordingResult {
    const { microphone, collector, context } = this;
    const parts = collector.toWavParts();
    const blob = new Blob(parts as BlobPart[], { type: WAV_MIME_TYPE });
    const rateMismatch = contextRateMismatch(microphone.actualTrackSettings.sampleRate, context.sampleRate);
    return {
      blob,
      mimeType: WAV_MIME_TYPE,
      durationMs: collector.durationMs,
      sampleRateHz: context.sampleRate,
      channels: 1,
      bitDepth: collector.bitDepth,
      sizeBytes: blob.size,
      captureMethod: this.captureMethod,
      captureQualityClass: this.captureQualityClass,
      requestedConstraints: microphone.requestedConstraints,
      actualTrackSettings: microphone.actualTrackSettings,
      audioContextSampleRate: context.sampleRate,
      deviceLabel: microphone.deviceLabel,
      constraintMismatches: rateMismatch ? [...microphone.constraintMismatches, rateMismatch] : microphone.constraintMismatches,
      stoppedBy,
      peak: collector.peak,
      startedAt: this.startedAt ?? new Date().toISOString(),
      inputChannelCount: this.inputChannelCount > 0 ? this.inputChannelCount : null,
      clippedSampleCount: collector.clippedSamples,
    };
  }

  /** Capture broke while recording: drop the data and tell the caller. */
  private fail(messageKey: "recording.device_disconnected" | "recording.interrupted", detail: string): void {
    if (this.currentState !== "recording") return;
    this.collector.clear();
    void this.close();
    this.options.onError?.(new RecorderError("RECORDING_FAILED", messageKey, detail));
  }

  /** Disconnects and closes the audio graph. The stream itself stays open for the next attempt. */
  private async close(): Promise<void> {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    releaseRecording(this);
    this.microphone.track.removeEventListener("ended", this.onTrackEnded);
    this.context.removeEventListener("statechange", this.onContextStateChange);
    this.node.port.onmessage = null;
    this.node.onprocessorerror = null;
    try {
      this.node.port.postMessage({ type: "stop" });
      this.source.disconnect();
      this.node.disconnect();
    } catch {
      // Already disconnected.
    }
    try {
      if (this.context.state !== "closed") await this.context.close();
    } catch {
      // Already closed.
    }
  }
}
