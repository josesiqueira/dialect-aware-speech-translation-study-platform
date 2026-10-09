"use client";

/**
 * useRecorder: connects the browser recorder (lib/client/recorder) to React.
 *
 * It owns three things and releases each of them when it is no longer needed:
 * - the microphone stream: opened on the first start (never on mount), kept
 *   open while the component is mounted so a re-recording uses the same device
 *   without a new prompt, and released on unmount, discard, a failure, a
 *   successful submit and when the page is hidden for navigation (pagehide);
 * - the active recorder: one at a time, cancelled on unmount and discard;
 * - the candidate recording and its blob URL: revoked at once on record again,
 *   discard, unmount and after a successful submit (spec 10, 62, 138).
 *
 * The hook never uploads anything itself. `submit(upload)` runs the function the
 * page passes in and maps its outcome to the uploading, upload_failed and
 * submitted states.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRecorder as defaultCreateRecorder,
  releaseMicrophone as defaultReleaseMicrophone,
  requestMicrophone as defaultRequestMicrophone,
  toRecorderError,
  type ConstraintMismatch,
  type CreatedRecorder,
  type CreateRecorderOptions,
  type MicrophoneAccess,
  type PcmBitDepth,
  type Recorder,
  type RecorderFallbackInfo,
  type RecordingResult,
  type RequestMicrophoneOptions,
} from "@/lib/client/recorder";
import {
  INITIAL_RECORDER_STATE,
  isBelowMinimumDuration,
  recorderReducer,
  type CaptureInfo,
  type RecorderErrorInfo,
  type RecorderEvent,
  type RecorderMachineState,
  type RecorderStatus,
  type RecordingCandidate,
} from "./recorderMachine";

/** Browser functions the hook uses. Tests replace them; pages never need to. */
export interface RecorderDependencies {
  requestMicrophone: (options?: RequestMicrophoneOptions) => Promise<MicrophoneAccess>;
  createRecorder: (microphone: MicrophoneAccess, options: CreateRecorderOptions) => Promise<CreatedRecorder>;
  releaseMicrophone: (microphone: MicrophoneAccess) => void;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

const DEFAULT_DEPENDENCIES: RecorderDependencies = {
  requestMicrophone: defaultRequestMicrophone,
  createRecorder: defaultCreateRecorder,
  releaseMicrophone: defaultReleaseMicrophone,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

export interface UseRecorderOptions {
  /** The recorder stops by itself at this limit (from the task). */
  maxDurationMs: number;
  /** Below this duration submit is disabled and a hint is shown. Not an error. */
  minDurationMs?: number;
  /** "pcm" (default) for research recordings, "compressed" only for Demo Mode. */
  prefer?: "pcm" | "compressed";
  /** PCM bit depth: 16 (default) or 24. */
  bitDepth?: PcmBitDepth;
  /** Prefer one input device (deviceId from enumerateDevices). */
  deviceId?: string;
  /** Called when "pcm" was preferred and the compressed recorder is used instead. */
  onFallback?: (fallback: RecorderFallbackInfo) => void;
  /** For tests. */
  dependencies?: Partial<RecorderDependencies>;
}

/** Facts about the open microphone, without the stream itself. Contains no audio. */
export interface MicrophoneInfo {
  requestedConstraints: Record<string, unknown>;
  actualTrackSettings: Record<string, unknown>;
  deviceLabel: string | null;
  capabilities: Record<string, unknown> | null;
  constraintMismatches: ConstraintMismatch[];
}

export interface SubmitContext {
  /** Number of recordings made for this task, including the one being sent. */
  attemptCount: number;
  /** Report upload progress as a fraction between 0 and 1. */
  onProgress: (fraction: number) => void;
}

export type SubmitFunction = (candidate: RecordingCandidate, context: SubmitContext) => Promise<void>;

export interface UseRecorderResult {
  state: RecorderStatus;
  /** Opens the microphone if needed and starts a recording. Call from a button press. */
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Drops the candidate from memory, revokes its blob URL at once, and starts a new recording. */
  recordAgain: () => Promise<void>;
  /** Cancels any recording, drops the candidate, revokes its blob URL and releases the microphone. */
  discard: () => void;
  /** Like discard, and the attempt count returns to zero. Use when the same component serves a new task. */
  reset: () => void;
  /** Opens the microphone without recording (the "Allow microphone" step of the mic check). */
  openMicrophone: () => Promise<void>;
  /**
   * Runs the page's upload function with the candidate. While it is pending the
   * state is "uploading". If it rejects the state is "upload_failed" and the
   * candidate is kept, so calling submit again sends the same recording. When
   * it resolves the candidate is released and the state is "submitted".
   */
  submit: (upload: SubmitFunction) => Promise<void>;
  attemptCount: number;
  /** While recording: time recorded so far. Updated a few times per second. */
  elapsedMs: number;
  /** While recording: peak of the latest block, 0 to 1. Null when it cannot be measured. */
  level: number | null;
  candidate: RecordingCandidate | null;
  error: RecorderErrorInfo | null;
  /** False while there is no candidate or it is shorter than minDurationMs. */
  canSubmit: boolean;
  belowMinimumDuration: boolean;
  uploadProgress: number | null;
  /** The recorder implementation of the current or latest recording, with the fallback reason if any. */
  capture: CaptureInfo | null;
  /** Facts about the open microphone, or null while it is closed. */
  microphone: MicrophoneInfo | null;
}

/** Minimum time between two updates of elapsedMs and level, so the timer does not re-render every block. */
const PROGRESS_UPDATE_INTERVAL_MS = 100;

function toErrorInfo(error: unknown): RecorderErrorInfo {
  const recorderError = toRecorderError(error);
  return { code: recorderError.code, messageKey: recorderError.messageKey, detail: recorderError.message };
}

function toMicrophoneInfo(microphone: MicrophoneAccess): MicrophoneInfo {
  return {
    requestedConstraints: microphone.requestedConstraints,
    actualTrackSettings: microphone.actualTrackSettings,
    deviceLabel: microphone.deviceLabel,
    capabilities: microphone.capabilities,
    constraintMismatches: microphone.constraintMismatches,
  };
}

export function useRecorder(options: UseRecorderOptions): UseRecorderResult {
  const [machine, setMachine] = useState<RecorderMachineState>(INITIAL_RECORDER_STATE);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState<number | null>(null);
  const [microphone, setMicrophone] = useState<MicrophoneInfo | null>(null);

  // The reducer state is mirrored in a ref so that callbacks always see the latest value.
  const machineRef = useRef<RecorderMachineState>(INITIAL_RECORDER_STATE);
  const microphoneRef = useRef<MicrophoneAccess | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  // Every asynchronous step checks this number. discard, reset and unmount increase it,
  // so a step that finishes afterwards drops its result instead of using it.
  const generationRef = useRef(0);
  const startingRef = useRef(false);
  const lastProgressUpdateRef = useRef(0);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const dispatch = useCallback((event: RecorderEvent) => {
    const next = recorderReducer(machineRef.current, event);
    machineRef.current = next;
    setMachine(next);
  }, []);

  const dependencies = useCallback(
    (): RecorderDependencies => ({ ...DEFAULT_DEPENDENCIES, ...optionsRef.current.dependencies }),
    [],
  );

  /** Revokes the blob URL of the current candidate. The Blob itself is freed once nothing refers to it. */
  const releaseCandidate = useCallback(() => {
    const candidate = machineRef.current.candidate;
    if (candidate) dependencies().revokeObjectURL(candidate.url);
  }, [dependencies]);

  const closeMicrophone = useCallback(() => {
    const open = microphoneRef.current;
    microphoneRef.current = null;
    if (open) dependencies().releaseMicrophone(open);
    setMicrophone(null);
  }, [dependencies]);

  const cancelRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) void recorder.cancel().catch(() => undefined);
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      recorderRef.current = null;
      releaseCandidate();
      closeMicrophone();
      setLevel(null);
      dispatch({ type: "FAILED", error: toErrorInfo(error) });
    },
    [closeMicrophone, dispatch, releaseCandidate],
  );

  const finishRecording = useCallback(
    (recorder: Recorder, generation: number, result: RecordingResult) => {
      // A limit stop and a press on Stop can arrive together: only the first one is used.
      if (recorderRef.current !== recorder || generation !== generationRef.current) return;
      recorderRef.current = null;
      const candidate: RecordingCandidate = {
        ...result,
        url: dependencies().createObjectURL(result.blob),
        attempt: machineRef.current.attemptCount,
      };
      setElapsedMs(result.durationMs);
      setLevel(null);
      dispatch({ type: "RECORDING_FINISHED", candidate });
    },
    [dependencies, dispatch],
  );

  /** Returns the open microphone, opening it first when needed. Null when the step was left meanwhile. */
  const ensureMicrophone = useCallback(
    async (generation: number): Promise<MicrophoneAccess | null> => {
      const open = microphoneRef.current;
      if (open && open.track.readyState === "live") return open;
      if (open) closeMicrophone();
      dispatch({ type: "PERMISSION_REQUESTED" });
      const deps = dependencies();
      const opened = await deps.requestMicrophone({ deviceId: optionsRef.current.deviceId });
      if (generation !== generationRef.current) {
        deps.releaseMicrophone(opened);
        return null;
      }
      microphoneRef.current = opened;
      setMicrophone(toMicrophoneInfo(opened));
      return opened;
    },
    [closeMicrophone, dependencies, dispatch],
  );

  const openMicrophone = useCallback(async () => {
    const status = machineRef.current.status;
    if (startingRef.current || (status !== "idle" && status !== "error")) return;
    startingRef.current = true;
    const generation = generationRef.current;
    try {
      const opened = await ensureMicrophone(generation);
      if (opened) dispatch({ type: "MICROPHONE_READY" });
    } catch (error) {
      if (generation === generationRef.current) fail(error);
    } finally {
      startingRef.current = false;
    }
  }, [dispatch, ensureMicrophone, fail]);

  const start = useCallback(async () => {
    const status = machineRef.current.status;
    if (startingRef.current || recorderRef.current) return;
    if (status !== "idle" && status !== "error") return;
    startingRef.current = true;
    const generation = generationRef.current;
    try {
      const opened = await ensureMicrophone(generation);
      if (!opened) return;
      const current = optionsRef.current;
      const deps = dependencies();
      let recorder: Recorder | null = null;
      const created = await deps.createRecorder(opened, {
        prefer: current.prefer ?? "pcm",
        maxDurationMs: current.maxDurationMs,
        bitDepth: current.bitDepth,
        onProgress: (progress) => {
          if (recorderRef.current !== recorder) return;
          // The clock is used only to limit how often React re-renders. Elapsed time comes from the recorder.
          const now = performance.now();
          if (now - lastProgressUpdateRef.current < PROGRESS_UPDATE_INTERVAL_MS) return;
          lastProgressUpdateRef.current = now;
          setElapsedMs(progress.elapsedMs);
          setLevel(progress.peak);
        },
        onAutoStop: (result) => {
          if (recorder) finishRecording(recorder, generation, result);
        },
        onError: (error) => {
          if (recorderRef.current === recorder && generation === generationRef.current) fail(error);
        },
      });
      recorder = created.recorder;
      if (generation !== generationRef.current) {
        void recorder.cancel().catch(() => undefined);
        return;
      }
      try {
        recorder.start();
      } catch (error) {
        // For example another recording is active. Close the audio graph that was prepared.
        void recorder.cancel().catch(() => undefined);
        throw error;
      }
      recorderRef.current = recorder;
      lastProgressUpdateRef.current = 0;
      setElapsedMs(0);
      setLevel(null);
      dispatch({
        type: "RECORDING_STARTED",
        capture: {
          captureMethod: created.captureMethod,
          captureQualityClass: created.captureQualityClass,
          fallback: created.fallback,
        },
      });
      if (created.fallback) current.onFallback?.(created.fallback);
    } catch (error) {
      if (generation === generationRef.current) fail(error);
    } finally {
      startingRef.current = false;
    }
  }, [dependencies, dispatch, ensureMicrophone, fail, finishRecording]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || machineRef.current.status !== "recording") return;
    const generation = generationRef.current;
    try {
      const result = await recorder.stop();
      finishRecording(recorder, generation, result);
    } catch (error) {
      if (recorderRef.current === recorder && generation === generationRef.current) fail(error);
    }
  }, [fail, finishRecording]);

  const recordAgain = useCallback(async () => {
    const status = machineRef.current.status;
    if (status !== "stopped" && status !== "upload_failed") return;
    // The previous attempt leaves browser memory before the new one begins (spec 10).
    releaseCandidate();
    dispatch({ type: "CANDIDATE_DISCARDED" });
    await start();
  }, [dispatch, releaseCandidate, start]);

  /** Everything the hook holds is given back: recorder, candidate, blob URL, microphone. */
  const teardown = useCallback(() => {
    generationRef.current += 1;
    startingRef.current = false;
    cancelRecorder();
    releaseCandidate();
    closeMicrophone();
    setElapsedMs(0);
    setLevel(null);
  }, [cancelRecorder, closeMicrophone, releaseCandidate]);

  const discard = useCallback(() => {
    if (machineRef.current.status === "uploading") return;
    teardown();
    dispatch({ type: "CANDIDATE_DISCARDED" });
  }, [dispatch, teardown]);

  const reset = useCallback(() => {
    teardown();
    dispatch({ type: "RESET" });
  }, [dispatch, teardown]);

  const submit = useCallback(
    async (upload: SubmitFunction) => {
      const current = machineRef.current;
      const candidate = current.candidate;
      if (!candidate || (current.status !== "stopped" && current.status !== "upload_failed")) return;
      if (isBelowMinimumDuration(candidate, optionsRef.current.minDurationMs)) return;
      const generation = generationRef.current;
      dispatch({ type: "UPLOAD_STARTED" });
      try {
        await upload(candidate, {
          attemptCount: current.attemptCount,
          onProgress: (fraction) => {
            if (generation === generationRef.current) dispatch({ type: "UPLOAD_PROGRESS", fraction });
          },
        });
      } catch (error) {
        if (generation !== generationRef.current) return;
        const detail = error instanceof Error ? error.message : String(error);
        dispatch({ type: "UPLOAD_FAILED", error: { code: "UPLOAD_FAILED", messageKey: "upload.failed", detail } });
        return;
      }
      if (generation !== generationRef.current) return;
      // The server confirmed storage: the browser copy is released (spec 62, step 9).
      releaseCandidate();
      closeMicrophone();
      dispatch({ type: "UPLOAD_SUCCEEDED" });
    },
    [closeMicrophone, dispatch, releaseCandidate],
  );

  // Leaving the step (unmount) or the page (pagehide) releases everything (spec 138).
  useEffect(() => {
    const onPageHide = () => {
      teardown();
      dispatch({ type: "RESET" });
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      teardown();
      machineRef.current = { ...machineRef.current, candidate: null };
    };
  }, [dispatch, teardown]);

  const belowMinimumDuration = isBelowMinimumDuration(machine.candidate, options.minDurationMs);

  return useMemo(
    () => ({
      state: machine.status,
      start,
      stop,
      recordAgain,
      discard,
      reset,
      openMicrophone,
      submit,
      attemptCount: machine.attemptCount,
      elapsedMs,
      level,
      candidate: machine.candidate,
      error: machine.error,
      canSubmit: machine.candidate !== null && !belowMinimumDuration,
      belowMinimumDuration,
      uploadProgress: machine.uploadProgress,
      capture: machine.capture,
      microphone,
    }),
    [
      machine,
      start,
      stop,
      recordAgain,
      discard,
      reset,
      openMicrophone,
      submit,
      elapsedMs,
      level,
      belowMinimumDuration,
      microphone,
    ],
  );
}
