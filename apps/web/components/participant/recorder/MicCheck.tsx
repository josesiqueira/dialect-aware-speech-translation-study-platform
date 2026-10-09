"use client";

/**
 * MicCheck: the microphone permission and test step (spec 6.3).
 *
 *   Allow microphone -> Record test (about 5 seconds, stops by itself) -> Stop
 *   -> Play -> Try again | Continue
 *
 * "Play" is the native audio player: there is no second Play button next to it.
 * Keyboard focus follows the controls as they are replaced (Record test, Stop,
 * the player), see useFocusAfterStateChange.
 *
 * Privacy rule (spec 6.3, 160.4): the test audio exists only in browser memory.
 * This component has no upload prop and never passes the audio to its parent.
 * `onContinue` receives only non-content technical settings. The test recording
 * is dropped and its blob URL revoked on Try again, on Continue and on unmount.
 */

import { useId } from "react";
import type { CaptureMethod } from "@dialect/domain";
import { formatDurationMs } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { IconMic, IconStop } from "@/components/ui/icons";
import { InlineMessage } from "@/components/ui/InlineMessage";
import type { ConstraintMismatch, RecorderFallbackInfo } from "@/lib/client/recorder";
import { ParticipantCard } from "../ParticipantCard";
import { STATE_FOCUS_PROPS, useFocusAfterStateChange } from "../useFocusAfterStateChange";
import { DEFAULT_MIC_CHECK_LABELS, fillLabel, type MicCheckLabels } from "./labels";
import { LevelMeter } from "./LevelMeter";
import { seemsSilent } from "./recorderMachine";
import { useRecorder, type RecorderDependencies } from "./useRecorder";

export const DEFAULT_MIC_TEST_DURATION_MS = 5000;

/**
 * What the mic check reports to the page. No audio and nothing derived from
 * the content of the audio. `audioEnvironment` and `browserInfo` have the shape
 * of `micCheckBodySchema` in @dialect/domain.
 */
export interface MicCheckResult {
  audioEnvironment: {
    deviceLabel?: string;
    requestedConstraints: Record<string, unknown>;
    actualTrackSettings: Record<string, unknown>;
    /** Absent for the compressed fallback, which uses no AudioContext. */
    audioContextSampleRate?: number;
    captureMethod: CaptureMethod;
  };
  browserInfo: {
    userAgent: string;
    language: string;
  };
  /** Requested capture settings that the browser did not confirm. For the page to store with the session. */
  constraintMismatches: ConstraintMismatch[];
  /** Set when the lossless recorder could not be used during the test. */
  fallback: RecorderFallbackInfo | null;
}

export interface MicCheckProps {
  /** Called when the participant confirms the test. Receives technical settings only. */
  onContinue: (result: MicCheckResult) => void;
  /** Localized strings. Missing keys fall back to English. */
  labels?: Partial<Omit<MicCheckLabels, "errors">> & { errors?: Partial<MicCheckLabels["errors"]> };
  /** Length of the test recording. Default 5000. */
  testDurationMs?: number;
  /** "pcm" (default). Use the same value as the recording tasks that follow. */
  prefer?: "pcm" | "compressed";
  className?: string;
  /** For tests. */
  dependencies?: Partial<RecorderDependencies>;
}

export function MicCheck({
  onContinue,
  labels,
  testDurationMs = DEFAULT_MIC_TEST_DURATION_MS,
  prefer,
  className,
  dependencies,
}: MicCheckProps) {
  const l: MicCheckLabels = {
    ...DEFAULT_MIC_CHECK_LABELS,
    ...labels,
    errors: { ...DEFAULT_MIC_CHECK_LABELS.errors, ...labels?.errors },
  };
  const recorder = useRecorder({ maxDurationMs: testDurationMs, prefer, dependencies });
  const { state, candidate, microphone } = recorder;
  const playbackLabelId = useId();

  const microphoneOpen = microphone !== null;
  const focusHandling = useFocusAfterStateChange(`${state}:${microphoneOpen}`, state !== "requesting_permission");
  const silent = seemsSilent(candidate?.peak);

  let announcement = "";
  if (state === "requesting_permission") announcement = l.announceRequestingPermission;
  else if (state === "idle" && microphoneOpen) announcement = l.announceReady;
  else if (state === "recording") announcement = l.announceRecording;
  else if (state === "stopped") announcement = l.announceStopped;
  else if (state === "error") announcement = l.announceError;

  const handleContinue = () => {
    if (!candidate) return;
    const result: MicCheckResult = {
      audioEnvironment: {
        ...(candidate.deviceLabel ? { deviceLabel: candidate.deviceLabel } : {}),
        requestedConstraints: candidate.requestedConstraints,
        actualTrackSettings: candidate.actualTrackSettings,
        ...(candidate.audioContextSampleRate !== null ? { audioContextSampleRate: candidate.audioContextSampleRate } : {}),
        captureMethod: candidate.captureMethod,
      },
      browserInfo: { userAgent: navigator.userAgent, language: navigator.language },
      constraintMismatches: candidate.constraintMismatches,
      fallback: recorder.capture?.fallback ?? null,
    };
    // The test audio leaves memory and the microphone is released before the page moves on.
    recorder.discard();
    onContinue(result);
  };

  return (
    <ParticipantCard className={cn("space-y-5", className)} data-state={state} data-testid="mic-check">
      <p role="status" aria-live="polite" className="sr-only" data-testid="mic-check-announcement">
        {announcement}
      </p>

      <div className="flex flex-col items-center gap-4 text-center" {...focusHandling}>
        {state !== "stopped" && (
          <div
            aria-hidden="true"
            className={cn(
              "flex h-16 w-16 items-center justify-center rounded-full border transition-colors",
              state === "recording" ? "border-rose-200 bg-rose-50 text-rose-600" : "border-slate-200 bg-white text-slate-500",
            )}
          >
            <IconMic className="h-7 w-7" />
          </div>
        )}

        {state === "error" && (
          <>
            <InlineMessage variant="error" className="w-full text-left">
              {recorder.error ? l.errors[recorder.error.messageKey] : l.errors["recording.start_failed"]}
            </InlineMessage>
            <Button size="lg" onClick={() => void recorder.openMicrophone()} {...STATE_FOCUS_PROPS}>
              {l.tryAgain}
            </Button>
          </>
        )}

        {state === "idle" && !microphoneOpen && (
          <>
            <p className="max-w-md text-slate-700">{l.intro}</p>
            <Button size="lg" onClick={() => void recorder.openMicrophone()} {...STATE_FOCUS_PROPS}>
              {l.allow}
            </Button>
          </>
        )}

        {state === "requesting_permission" && (
          <>
            <Button size="lg" loading loadingLabel={l.requestingPermission}>
              {l.allow}
            </Button>
            <p className="max-w-sm text-sm text-slate-500">{l.permissionHint}</p>
          </>
        )}

        {state === "idle" && microphoneOpen && (
          <>
            <p className="max-w-md text-slate-700">
              {fillLabel(l.recordInstruction, { seconds: Math.round(testDurationMs / 1000) })}
            </p>
            <Button size="lg" onClick={() => void recorder.start()} {...STATE_FOCUS_PROPS}>
              {l.recordTest}
            </Button>
          </>
        )}

        {state === "recording" && (
          <>
            <p className="flex items-center gap-2 text-lg font-medium text-slate-900">
              <span>{l.recording}</span>
              <span role="timer" aria-live="off" className="font-mono tabular-nums">
                {formatDurationMs(recorder.elapsedMs)}
              </span>
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-rose-600 motion-safe:animate-pulse" />
            </p>
            {recorder.level !== null && <LevelMeter level={recorder.level} />}
            <Button size="lg" variant="danger" onClick={() => void recorder.stop()} {...STATE_FOCUS_PROPS}>
              <IconStop className="h-4 w-4 fill-current" />
              {l.stop}
            </Button>
          </>
        )}

        {state === "stopped" && candidate && (
          <div className="w-full space-y-4 text-left">
            {silent ? (
              <InlineMessage variant="warning">{l.silentWarning}</InlineMessage>
            ) : (
              <p className="text-slate-700">{l.listenInstruction}</p>
            )}
            <div>
              <p id={playbackLabelId} className="mb-1 text-sm font-medium text-slate-700">
                {l.playbackLabel}
              </p>
              {/* The source is an in-memory object URL. Nothing is fetched from or sent to the network.
                  tabIndex 0 is what browsers already do for a player with controls; it is written out
                  so that focus can be moved here when the test stops. */}
              <audio
                controls
                preload="metadata"
                aria-labelledby={playbackLabelId}
                tabIndex={0}
                className="block w-full"
                key={candidate.url}
                {...STATE_FOCUS_PROPS}
              >
                <source src={candidate.url} type={candidate.mimeType} />
              </audio>
            </div>
            <div className="flex flex-col gap-3 *:w-full sm:flex-row-reverse sm:items-center sm:justify-between sm:*:w-auto">
              <Button size="lg" onClick={handleContinue}>
                {l.continue}
              </Button>
              <Button size="lg" variant="secondary" onClick={() => void recorder.recordAgain()}>
                {l.tryAgain}
              </Button>
            </div>
          </div>
        )}

        <p className="text-sm text-slate-500">{l.privacyNote}</p>
      </div>
    </ParticipantCard>
  );
}
