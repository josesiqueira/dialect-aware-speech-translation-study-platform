// Chooses the recorder implementation for one recording and reports which one
// is in use (spec 31). The lossless PCM recorder is preferred; the compressed
// recorder is used when the page asks for it or when AudioWorklet is missing or
// fails to start. A fallback is always reported, never silent.
import { toRecorderError } from "./errors";
import { MediaRecorderFallback } from "./MediaRecorderFallback";
import { isAudioWorkletSupported, PcmRecorder } from "./PcmRecorder";
import type { CreatedRecorder, MicrophoneAccess, PcmBitDepth, RecorderCallbacks, RecorderFallbackInfo } from "./types";

export interface CreateRecorderOptions extends RecorderCallbacks {
  /** "pcm" (default) for research recordings. "compressed" only where a lossy file is acceptable (Demo Mode). */
  prefer?: "pcm" | "compressed";
  /** The recorder stops by itself at this limit and reports stoppedBy "max_duration". */
  maxDurationMs: number;
  /** PCM only: 16 (default) or 24. */
  bitDepth?: PcmBitDepth;
  /** PCM only: URL of the worklet script. */
  workletUrl?: string;
}

/**
 * Prepares a recorder for the open microphone. The returned recorder is ready:
 * call `recorder.start()` to begin and `recorder.stop()` to get the recording.
 * `fallback` is set when "pcm" was preferred but the compressed recorder is in
 * use; the page should store that fact with the recording.
 * Throws RecorderError (RECORDING_FAILED) when no implementation can start.
 */
export async function createRecorder(microphone: MicrophoneAccess, options: CreateRecorderOptions): Promise<CreatedRecorder> {
  const { prefer = "pcm", ...recorderOptions } = options;
  let fallback: RecorderFallbackInfo | null = null;

  if (prefer === "pcm") {
    if (!isAudioWorkletSupported()) {
      fallback = { reason: "audio_worklet_unavailable", detail: "AudioWorklet is not available in this browser." };
    } else {
      try {
        const recorder = await PcmRecorder.create(microphone, recorderOptions);
        return {
          recorder,
          implementation: recorder.implementation,
          captureMethod: recorder.captureMethod,
          captureQualityClass: recorder.captureQualityClass,
          fallback: null,
        };
      } catch (error) {
        fallback = { reason: "audio_worklet_failed", detail: toRecorderError(error).message };
      }
    }
  }

  const recorder = MediaRecorderFallback.create(microphone, {
    maxDurationMs: options.maxDurationMs,
    onProgress: options.onProgress,
    onAutoStop: options.onAutoStop,
    onError: options.onError,
  });
  return {
    recorder,
    implementation: recorder.implementation,
    captureMethod: recorder.captureMethod,
    captureQualityClass: recorder.captureQualityClass,
    fallback,
  };
}
