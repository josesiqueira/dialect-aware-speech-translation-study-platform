"use client";

import { useEffect, useRef } from "react";
import { DEFAULT_RECORDER_ERROR_LABELS, useRecorder, type RecordingCandidate } from "@/components/participant/recorder";
import { Button, InlineMessage } from "@/components/ui";
import type { RecorderFallbackInfo } from "@/lib/client/recorder";
import { formatDurationMs } from "@/lib/format";

export interface PipelineTestRecorderProps {
  maxDurationMs: number;
  /** "pcm": lossless WAV as in the study. "compressed": the browser codec. */
  prefer: "pcm" | "compressed";
  /** True while a test runs: the controls are disabled. */
  disabled: boolean;
  /** Runs the test with the clip. Resolves when the test finished, rejects when it could not run. */
  onRun: (candidate: RecordingCandidate, fallback: RecorderFallbackInfo | null) => Promise<void>;
}

/**
 * The compact recorder of the pipeline test, in the admin visual family. It
 * uses the same recorder hook as the participant flow (same capture path, same
 * microphone handling) with admin-sized controls.
 */
export function PipelineTestRecorder({ maxDurationMs, prefer, disabled, onRun }: PipelineTestRecorderProps) {
  const fallbackRef = useRef<RecorderFallbackInfo | null>(null);
  const recorder = useRecorder({
    maxDurationMs,
    minDurationMs: 500,
    prefer,
    onFallback: (fallback) => {
      fallbackRef.current = fallback;
    },
  });
  const { state, candidate, reset } = recorder;

  // After a test the recorder is ready for the next clip.
  useEffect(() => {
    if (state === "submitted") reset();
  }, [state, reset]);

  const run = () =>
    void recorder.submit(async (current) => {
      await onRun(current, fallbackRef.current);
    });

  const hasClip = state === "stopped" || state === "uploading" || state === "upload_failed";

  return (
    <div className="space-y-3" data-testid="pipeline-test-recorder" data-state={state}>
      <p role="status" aria-live="polite" className="sr-only">
        {state === "recording"
          ? "Recording started."
          : state === "stopped"
            ? "Recording stopped. You can listen to the clip, record again, or run the test with it."
            : ""}
      </p>

      {(state === "idle" || state === "requesting_permission" || state === "error" || state === "submitted") && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void recorder.start()}
            disabled={disabled}
            loading={state === "requesting_permission"}
            loadingLabel="Waiting for microphone..."
          >
            {state === "error" ? "Try again" : "Record a test clip"}
          </Button>
          <span className="text-xs text-slate-500">
            Up to {formatDurationMs(maxDurationMs)}. Say one sentence in the source language.
          </span>
        </div>
      )}

      {state === "error" && recorder.error && (
        <InlineMessage variant="error">{DEFAULT_RECORDER_ERROR_LABELS[recorder.error.messageKey]}</InlineMessage>
      )}

      {state === "recording" && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="danger" onClick={() => void recorder.stop()}>
            Stop
          </Button>
          <span className="text-sm text-slate-700 tabular-nums">Recording {formatDurationMs(recorder.elapsedMs)}</span>
        </div>
      )}

      {hasClip && candidate && (
        <div className="space-y-3">
          <audio controls preload="metadata" aria-label="Test clip" className="block w-full max-w-md">
            <source src={candidate.url} type={candidate.mimeType} />
          </audio>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={run}
              disabled={disabled || !recorder.canSubmit}
              loading={state === "uploading"}
              loadingLabel="Running the test..."
            >
              Run pipeline test with this clip
            </Button>
            <Button variant="secondary" onClick={() => void recorder.recordAgain()} disabled={disabled || state === "uploading"}>
              Record again
            </Button>
            <span className="text-xs text-slate-500 tabular-nums">
              {formatDurationMs(candidate.durationMs)}, {candidate.captureQualityClass.replace(/_/g, " ")}
            </span>
          </div>
          {recorder.belowMinimumDuration && (
            <p className="text-xs text-slate-600">The clip is too short. Record at least half a second.</p>
          )}
        </div>
      )}
    </div>
  );
}
