"use client";

/**
 * RecordingTask: one recording prompt of the study (spec 9, 10, 62).
 * It connects useRecorder to the presentational RecordingControlFrame.
 *
 * The component does not know the participant API. The page passes `onSubmit`,
 * which uploads the candidate and resolves only when the server confirmed
 * durable storage. While it is pending the control shows "uploading". If it
 * rejects, the candidate is kept and Retry calls `onSubmit` again with the same
 * recording. When it resolves, the candidate is released from browser memory.
 *
 * Give the component a `key` per task (for example the presentation id), so
 * each task starts with a fresh state and an attempt count of zero.
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { formatDurationMs } from "@/lib/format";
import { InlineMessage } from "@/components/ui/InlineMessage";
import type { PcmBitDepth, RecorderFallbackInfo } from "@/lib/client/recorder";
import { ParticipantCard } from "../ParticipantCard";
import { RecordingControlFrame, type RecordingControlLabels } from "../RecordingControlFrame";
import { DEFAULT_RECORDING_TASK_LABELS, fillLabel, type RecordingTaskLabels } from "./labels";
import { LevelMeter } from "./LevelMeter";
import { seemsSilent, type RecorderStatus, type RecordingCandidate } from "./recorderMachine";
import { useRecorder, type RecorderDependencies, type SubmitContext } from "./useRecorder";

export interface RecordingTaskProps {
  /** The task text, rendered in the white prompt card. */
  prompt?: ReactNode;
  /** From the task: the recorder stops by itself at this limit. */
  maxDurationMs: number;
  /** From the task: below this duration submit is disabled and a hint is shown. */
  minDurationMs?: number;
  /**
   * Uploads the candidate. Resolve only after the server confirmed storage.
   * Reject to keep the candidate and show Retry.
   */
  onSubmit: (candidate: RecordingCandidate, context: SubmitContext) => Promise<void>;
  /** Localized strings. Missing keys fall back to English. */
  labels?: Partial<Omit<RecordingTaskLabels, "errors">> & { errors?: Partial<RecordingTaskLabels["errors"]> };
  /** Guidance shown under the control before recording, for example "Speak for about 30 seconds." */
  hint?: ReactNode;
  /** "pcm" (default) for research recordings. "compressed" only for Demo Mode. */
  prefer?: "pcm" | "compressed";
  bitDepth?: PcmBitDepth;
  /** Neutral input level bar while recording. Default true. */
  showLevelMeter?: boolean;
  /** The candidate changed (new recording, discarded, released). */
  onCandidateChange?: (candidate: RecordingCandidate | null) => void;
  /** The state changed. Useful for disabling page navigation while recording or uploading. */
  onStateChange?: (state: RecorderStatus) => void;
  /** The compressed recorder is used although "pcm" was preferred. Store this with the recording. */
  onFallback?: (fallback: RecorderFallbackInfo) => void;
  className?: string;
  /** For tests. */
  dependencies?: Partial<RecorderDependencies>;
}

export function RecordingTask({
  prompt,
  maxDurationMs,
  minDurationMs,
  onSubmit,
  labels,
  hint,
  prefer,
  bitDepth,
  showLevelMeter = true,
  onCandidateChange,
  onStateChange,
  onFallback,
  className,
  dependencies,
}: RecordingTaskProps) {
  const l: RecordingTaskLabels = {
    ...DEFAULT_RECORDING_TASK_LABELS,
    ...labels,
    errors: { ...DEFAULT_RECORDING_TASK_LABELS.errors, ...labels?.errors },
  };
  const recorder = useRecorder({ maxDurationMs, minDurationMs, prefer, bitDepth, onFallback, dependencies });
  const { state, candidate, submit } = recorder;

  const onSubmitRef = useRef(onSubmit);
  const onCandidateChangeRef = useRef(onCandidateChange);
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
    onCandidateChangeRef.current = onCandidateChange;
    onStateChangeRef.current = onStateChange;
  });
  useEffect(() => {
    onCandidateChangeRef.current?.(candidate);
  }, [candidate]);
  useEffect(() => {
    onStateChangeRef.current?.(state);
  }, [state]);

  const handleSubmit = useCallback(() => {
    void submit((current, context) => onSubmitRef.current(current, context));
  }, [submit]);

  if (state === "submitted") {
    return (
      <div className={className} data-state="submitted">
        {prompt !== undefined && <ParticipantCard className="mb-6">{prompt}</ParticipantCard>}
        <InlineMessage variant="success">{l.submitted}</InlineMessage>
      </div>
    );
  }

  const limitNote = fillLabel(l.maxDurationNote, { duration: formatDurationMs(maxDurationMs) });
  const minimumHint = fillLabel(l.minDurationHint, { seconds: Math.ceil((minDurationMs ?? 0) / 1000) });
  const limitStop = candidate?.stoppedBy === "max_duration";
  const silent = seemsSilent(candidate?.peak);

  // Notes about the candidate. They are also added to the one announcement of the
  // stopped state, so a screen reader user hears why Submit is not available.
  const candidateNotes: string[] = [];
  if (state === "stopped" || state === "upload_failed") {
    if (limitStop) candidateNotes.push(l.maxDurationReached);
    if (recorder.belowMinimumDuration) candidateNotes.push(minimumHint);
    if (silent) candidateNotes.push(l.silentHint);
  }

  let hintContent: ReactNode = null;
  if (state === "idle" || state === "recording") {
    hintContent = (
      <>
        {state === "idle" && hint ? <span className="block">{hint}</span> : null}
        <span className="block">{limitNote}</span>
      </>
    );
  } else if (candidateNotes.length > 0) {
    hintContent = candidateNotes.map((note) => (
      <span key={note} className="block text-slate-700">
        {note}
      </span>
    ));
  }

  const frameLabels: RecordingControlLabels = {
    ...l,
    announceStopped: [l.announceStopped, ...candidateNotes].join(" "),
    uploading:
      recorder.uploadProgress !== null
        ? fillLabel(l.uploadingProgress, { percent: Math.round(recorder.uploadProgress * 100) })
        : l.uploading,
  };

  return (
    <RecordingControlFrame
      className={className}
      state={state}
      prompt={prompt}
      elapsedMs={recorder.elapsedMs}
      candidateUrl={candidate?.url ?? null}
      candidateType={candidate?.mimeType}
      candidateDurationMs={candidate?.durationMs ?? null}
      errorMessage={recorder.error && state === "error" ? l.errors[recorder.error.messageKey] : undefined}
      canSubmit={recorder.canSubmit}
      hint={hintContent}
      levelMeter={showLevelMeter && recorder.level !== null ? <LevelMeter level={recorder.level} /> : undefined}
      onStart={() => void recorder.start()}
      onStop={() => void recorder.stop()}
      onRecordAgain={() => void recorder.recordAgain()}
      onSubmit={handleSubmit}
      onRetryUpload={handleSubmit}
      labels={frameLabels}
    />
  );
}
