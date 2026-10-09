"use client";

/**
 * RecordingControlFrame: the visual structure of a recording task (spec 0B.4).
 *
 *   [white prompt card]
 *           microphone icon
 *          Start recording
 *        Recording 00:14  (rose dot)
 *               Stop
 *         [audio playback]
 *   [Record again]   [Submit and continue]
 *
 * Purely presentational. It holds no recorder, timer or upload logic: the
 * recorder passes the state and the callbacks. It never shows a transcript,
 * a translation, a dialect label or a confidence value.
 *
 * Accessibility (spec 0E):
 * - Each state change is announced once through a polite live region. The
 *   announced text depends only on `state`, so re-renders caused by the
 *   running timer do not announce anything.
 * - The elapsed time is not in a live region (role="timer" is silent by
 *   default), so it is not read out every second.
 * - Playback uses the native <audio controls> element.
 * - The buttons of one state are replaced by those of the next. Keyboard focus
 *   follows: Stop while recording; the player once stopped (listening is the
 *   next step, and Record again and Submit come right after it in tab order,
 *   so nothing is submitted by a repeated key press); the retry button after a
 *   failed upload. See useFocusAfterStateChange for when focus is moved.
 * - No glowing orb and no decorative waveform. The only motion is the small
 *   pulsing dot while recording, which stops under prefers-reduced-motion.
 */

import { useId, type ReactNode } from "react";
import { formatDurationMs } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { IconMic, IconStop } from "@/components/ui/icons";
import { InlineMessage } from "@/components/ui/InlineMessage";
import { ParticipantCard } from "./ParticipantCard";
import { STATE_FOCUS_PROPS, useFocusAfterStateChange } from "./useFocusAfterStateChange";

export type RecordingControlState =
  /** Nothing recorded yet. Shows "Start recording". */
  | "idle"
  /** The browser permission prompt is open. */
  | "requesting_permission"
  /** The microphone is live. Shows the timer and Stop. */
  | "recording"
  /** A candidate recording exists. Shows playback, "Record again" and "Submit and continue". */
  | "stopped"
  /** The candidate is being uploaded. */
  | "uploading"
  /** The upload failed. The candidate is kept; the participant can retry without re-recording. */
  | "upload_failed"
  /** The microphone could not be used (permission denied, no device, recorder failure). */
  | "error";

/** Every visible and announced string. Pass localized values; the defaults are English. */
export interface RecordingControlLabels {
  start: string;
  requestingPermission: string;
  permissionHint: string;
  recording: string;
  stop: string;
  playbackLabel: string;
  recordAgain: string;
  submit: string;
  uploading: string;
  uploadFailed: string;
  retryUpload: string;
  tryAgain: string;
  defaultError: string;
  announceIdle: string;
  announceRequestingPermission: string;
  announceRecording: string;
  announceStopped: string;
  announceUploading: string;
  announceUploadFailed: string;
  announceError: string;
}

export const DEFAULT_RECORDING_LABELS: RecordingControlLabels = {
  start: "Start recording",
  requestingPermission: "Waiting for microphone...",
  permissionHint: "Your browser is asking for permission to use the microphone. Choose Allow to continue.",
  recording: "Recording",
  stop: "Stop",
  playbackLabel: "Your recording",
  recordAgain: "Record again",
  submit: "Submit and continue",
  uploading: "Uploading...",
  uploadFailed: "The recording could not be uploaded. It is still here: you do not need to record again.",
  retryUpload: "Try uploading again",
  tryAgain: "Try again",
  defaultError: "The microphone could not be used. Check that a microphone is connected and that this page is allowed to use it.",
  announceIdle: "",
  announceRequestingPermission: "Waiting for microphone permission.",
  announceRecording: "Recording started.",
  announceStopped: "Recording stopped. You can listen to it, record again, or submit.",
  announceUploading: "Uploading the recording.",
  announceUploadFailed: "Upload failed. The recording is kept. You can try again.",
  announceError: "The microphone could not be used.",
};

export interface RecordingControlFrameProps {
  state: RecordingControlState;
  /** Content of the white prompt card above the control (the task text). Omit to render no card. */
  prompt?: ReactNode;
  /** Elapsed recording time in milliseconds, shown while recording. The recorder updates it. */
  elapsedMs?: number;
  /** Object URL of the candidate recording for playback in the stopped, uploading and upload_failed states. */
  candidateUrl?: string | null;
  /** MIME type of the candidate, when known. */
  candidateType?: string;
  /** Duration of the candidate in milliseconds, shown next to the playback label. */
  candidateDurationMs?: number | null;
  /** Plain-language message for the error state. Falls back to labels.defaultError. */
  errorMessage?: ReactNode;
  /** Set false to disable "Submit and continue" (for example while a minimum duration is not met). */
  canSubmit?: boolean;
  /** Short muted guidance under the control, for example "Speak for about 30 seconds." */
  hint?: ReactNode;
  /** Optional restrained level meter rendered under the timer while recording. Keep it neutral. */
  levelMeter?: ReactNode;
  onStart: () => void;
  onStop: () => void;
  onRecordAgain: () => void;
  onSubmit: () => void;
  /** Retry the upload of the kept candidate. Defaults to onSubmit. */
  onRetryUpload?: () => void;
  labels?: Partial<RecordingControlLabels>;
  className?: string;
}

function announcementFor(state: RecordingControlState, l: RecordingControlLabels): string {
  switch (state) {
    case "idle":
      return l.announceIdle;
    case "requesting_permission":
      return l.announceRequestingPermission;
    case "recording":
      return l.announceRecording;
    case "stopped":
      return l.announceStopped;
    case "uploading":
      return l.announceUploading;
    case "upload_failed":
      return l.announceUploadFailed;
    case "error":
      return l.announceError;
  }
}

export function RecordingControlFrame({
  state,
  prompt,
  elapsedMs = 0,
  candidateUrl,
  candidateType,
  candidateDurationMs,
  errorMessage,
  canSubmit = true,
  hint,
  levelMeter,
  onStart,
  onStop,
  onRecordAgain,
  onSubmit,
  onRetryUpload,
  labels,
  className,
}: RecordingControlFrameProps) {
  const l: RecordingControlLabels = { ...DEFAULT_RECORDING_LABELS, ...labels };
  const playbackLabelId = useId();
  const isRecording = state === "recording";
  const hasCandidate = state === "stopped" || state === "uploading" || state === "upload_failed";
  const beforeRecording = state === "idle" || state === "requesting_permission" || state === "error";
  const focusHandling = useFocusAfterStateChange(state, state !== "requesting_permission" && state !== "uploading");

  return (
    <div className={cn("space-y-6", className)} data-state={state}>
      {prompt !== undefined && <ParticipantCard>{prompt}</ParticipantCard>}

      {/* One announcement per state change. The timer below is outside this region. */}
      <p role="status" aria-live="polite" className="sr-only" data-testid="recording-announcement">
        {announcementFor(state, l)}
      </p>

      <div className="flex flex-col items-center gap-4 text-center" {...focusHandling}>
        {(beforeRecording || isRecording) && (
          <div
            aria-hidden="true"
            className={cn(
              "flex h-16 w-16 items-center justify-center rounded-full border transition-colors",
              isRecording
                ? "border-rose-200 bg-rose-50 text-rose-600"
                : "border-slate-200 bg-white text-slate-500",
            )}
          >
            <IconMic className="h-7 w-7" />
          </div>
        )}

        {state === "error" && (
          <InlineMessage variant="error" className="w-full text-left">
            {errorMessage ?? l.defaultError}
          </InlineMessage>
        )}

        {state === "idle" && (
          <Button size="lg" onClick={onStart} {...STATE_FOCUS_PROPS}>
            {l.start}
          </Button>
        )}

        {state === "error" && (
          <Button size="lg" onClick={onStart} {...STATE_FOCUS_PROPS}>
            {l.tryAgain}
          </Button>
        )}

        {state === "requesting_permission" && (
          <>
            <Button size="lg" loading loadingLabel={l.requestingPermission}>
              {l.start}
            </Button>
            <p className="max-w-sm text-sm text-slate-500">{l.permissionHint}</p>
          </>
        )}

        {isRecording && (
          <>
            <p className="flex items-center gap-2 text-lg font-medium text-slate-900">
              <span>{l.recording}</span>
              <span role="timer" aria-live="off" className="font-mono tabular-nums">
                {formatDurationMs(elapsedMs)}
              </span>
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-full bg-rose-600 motion-safe:animate-pulse"
              />
            </p>
            {levelMeter}
            <Button size="lg" variant="danger" onClick={onStop} {...STATE_FOCUS_PROPS}>
              <IconStop className="h-4 w-4 fill-current" />
              {l.stop}
            </Button>
          </>
        )}

        {hasCandidate && (
          <div className="w-full space-y-4 text-left">
            {state === "upload_failed" && <InlineMessage variant="error">{l.uploadFailed}</InlineMessage>}
            {candidateUrl && (
              <div>
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <p id={playbackLabelId} className="text-sm font-medium text-slate-700">
                    {l.playbackLabel}
                  </p>
                  {typeof candidateDurationMs === "number" && (
                    <p className="font-mono text-xs tabular-nums text-slate-500">
                      {formatDurationMs(candidateDurationMs)}
                    </p>
                  )}
                </div>
                {/* The source is an in-memory object URL, so metadata preload costs no network. */}
                {/* tabIndex 0 is what browsers already do for a player with controls; it is written out
                    so that focus can be moved here after Stop. After a failed upload the retry button is focused. */}
                <audio
                  controls
                  preload="metadata"
                  aria-labelledby={playbackLabelId}
                  tabIndex={0}
                  className="block w-full"
                  key={candidateUrl}
                  {...(state === "stopped" ? STATE_FOCUS_PROPS : {})}
                >
                  {candidateType ? <source src={candidateUrl} type={candidateType} /> : <source src={candidateUrl} />}
                </audio>
              </div>
            )}
            <div className="flex flex-col gap-3 *:w-full sm:flex-row-reverse sm:items-center sm:justify-between sm:*:w-auto">
              {state === "upload_failed" ? (
                <Button size="lg" onClick={onRetryUpload ?? onSubmit} {...STATE_FOCUS_PROPS}>
                  {l.retryUpload}
                </Button>
              ) : (
                <Button
                  size="lg"
                  onClick={onSubmit}
                  disabled={!canSubmit}
                  loading={state === "uploading"}
                  loadingLabel={l.uploading}
                  {...STATE_FOCUS_PROPS}
                >
                  {l.submit}
                </Button>
              )}
              <Button
                size="lg"
                variant="secondary"
                onClick={onRecordAgain}
                disabled={state === "uploading"}
                {...STATE_FOCUS_PROPS}
              >
                {l.recordAgain}
              </Button>
            </div>
          </div>
        )}

        {hint && <p className="text-sm text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}
