// Test doubles for the recorder hook and components. Used by tests only.
// They replace the browser APIs (microphone, recorder, object URLs), so the
// state logic runs in jsdom without any audio.
import { vi } from "vitest";
import type {
  CreatedRecorder,
  CreateRecorderOptions,
  MicrophoneAccess,
  Recorder,
  RecorderState,
  RecordingResult,
} from "@/lib/client/recorder";
import type { RecorderDependencies } from "./useRecorder";

export function makeMicrophone(): MicrophoneAccess {
  const track = { readyState: "live", label: "Test microphone", stop: vi.fn() };
  return {
    stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream,
    track: track as unknown as MediaStreamTrack,
    requestedConstraints: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    actualTrackSettings: { channelCount: 1, echoCancellation: true, sampleRate: 48000 },
    deviceLabel: "Test microphone",
    capabilities: null,
    constraintMismatches: [{ constraint: "echoCancellation", kind: "not_honored", requested: false, actual: true }],
  };
}

export function makeResult(overrides: Partial<RecordingResult> = {}): RecordingResult {
  const blob = new Blob([new Uint8Array(44 + 9600)], { type: "audio/wav" });
  return {
    blob,
    mimeType: "audio/wav",
    durationMs: 3000,
    sampleRateHz: 48000,
    channels: 1,
    bitDepth: 16,
    sizeBytes: blob.size,
    captureMethod: "audio_worklet_pcm",
    captureQualityClass: "lossless_pcm",
    requestedConstraints: { channelCount: 1 },
    actualTrackSettings: { channelCount: 1, sampleRate: 48000 },
    audioContextSampleRate: 48000,
    deviceLabel: "Test microphone",
    constraintMismatches: [],
    stoppedBy: "user",
    peak: 0.4,
    startedAt: "2026-10-03T10:00:00.000Z",
    inputChannelCount: 1,
    clippedSampleCount: 0,
    ...overrides,
  };
}

export interface FakeRecorder extends Recorder {
  options: CreateRecorderOptions;
  cancelled: boolean;
  /** What stop() resolves with. Change it before stopping. */
  nextResult: RecordingResult;
}

export interface FakeEnvironment {
  dependencies: RecorderDependencies;
  microphones: MicrophoneAccess[];
  recorders: FakeRecorder[];
  createdUrls: string[];
  revokedUrls: string[];
  /** Makes the next requestMicrophone call reject with this error. */
  failNextMicrophone: (error: unknown) => void;
  /** Result overrides for recorders created from now on. */
  setResult: (overrides: Partial<RecordingResult>) => void;
  /** Makes recorders report the compressed fallback from now on. */
  useFallback: () => void;
}

export function makeFakeEnvironment(): FakeEnvironment {
  const microphones: MicrophoneAccess[] = [];
  const recorders: FakeRecorder[] = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  let microphoneError: unknown = null;
  let resultOverrides: Partial<RecordingResult> = {};
  let fallback = false;

  const dependencies: RecorderDependencies = {
    requestMicrophone: vi.fn(async () => {
      if (microphoneError) {
        const error = microphoneError;
        microphoneError = null;
        throw error;
      }
      const microphone = makeMicrophone();
      microphones.push(microphone);
      return microphone;
    }),
    createRecorder: vi.fn(async (_microphone: MicrophoneAccess, options: CreateRecorderOptions): Promise<CreatedRecorder> => {
      let state: RecorderState = "ready";
      const recorder: FakeRecorder = {
        implementation: fallback ? "compressed" : "pcm",
        captureMethod: fallback ? "media_recorder" : "audio_worklet_pcm",
        captureQualityClass: fallback ? "compressed_fallback" : "lossless_pcm",
        options,
        cancelled: false,
        nextResult: makeResult(resultOverrides),
        get state() {
          return state;
        },
        start() {
          state = "recording";
        },
        async stop() {
          state = "closed";
          return recorder.nextResult;
        },
        async cancel() {
          state = "closed";
          recorder.cancelled = true;
        },
      };
      recorders.push(recorder);
      return {
        recorder,
        implementation: recorder.implementation,
        captureMethod: recorder.captureMethod,
        captureQualityClass: recorder.captureQualityClass,
        fallback: fallback ? { reason: "audio_worklet_failed", detail: "test" } : null,
      };
    }),
    releaseMicrophone: vi.fn((microphone: MicrophoneAccess) => {
      for (const track of microphone.stream.getTracks()) track.stop();
    }),
    createObjectURL: vi.fn(() => {
      const url = `blob:test/${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
  };

  return {
    dependencies,
    microphones,
    recorders,
    createdUrls,
    revokedUrls,
    failNextMicrophone: (error) => {
      microphoneError = error;
    },
    setResult: (overrides) => {
      resultOverrides = overrides;
    },
    useFallback: () => {
      fallback = true;
    },
  };
}
