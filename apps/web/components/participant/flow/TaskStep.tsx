"use client";

import { useCallback, useId, useState } from "react";
import type { sessionSchemas } from "@dialect/domain";
import { Button } from "@/components/ui/Button";
import { InlineMessage } from "@/components/ui/InlineMessage";
import { durationText, format, recordingTaskLabels, type Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import type { RecorderStatus, RecordingCandidate } from "../recorder/recorderMachine";
import { RecordingTask, type RecordingTaskProps } from "../recorder/RecordingTask";
import type { SubmitContext } from "../recorder/useRecorder";
import { STEP_HEADING_ID, useContentLanguage } from "./FlowShell";
import { StudyText } from "./StudyText";

/**
 * What the step shows of a task. The task category is deliberately absent: the
 * participant never sees a category name, because it could influence how they speak.
 */
export type TaskStepTask = Pick<
  sessionSchemas.CurrentTask,
  | "title"
  | "prompt"
  | "context"
  | "instructions"
  | "minDurationSeconds"
  | "suggestedDurationSeconds"
  | "maxDurationSeconds"
  | "privacyReminder"
  | "topicSuggestions"
> & {
  turn: Pick<sessionSchemas.CurrentTurn, "turnIndex" | "totalTurns" | "promptText" | "isFollowup" | "isOptional">;
};

export interface TaskStepProps {
  t: Dictionary;
  task: TaskStepTask;
  /**
   * Uploads and submits the recording. Resolve only after the server stored
   * it. Reject to keep the recording and offer Retry. A rejection whose `code`
   * is "INVALID_AUDIO" or "PAYLOAD_TOO_LARGE" tells the participant that the
   * recording itself was refused and must be made again.
   */
  onSubmitRecording: (candidate: RecordingCandidate, context: SubmitContext) => Promise<void>;
  /** Skips an optional follow-up turn. The action is shown only when the turn is optional. */
  onSkip?: () => void;
  skipBusy?: boolean;
  /** Neutral note above the control, for example after a page reload removed an unsent recording. */
  notice?: string | null;
  /** Failure of preparing or skipping the turn, in plain language. */
  error?: string | null;
  /** The candidate changed (new recording, discarded, released). */
  onCandidateChange?: (candidate: RecordingCandidate | null) => void;
  onRecorderStateChange?: (state: RecorderStatus) => void;
  onFallback?: RecordingTaskProps["onFallback"];
  /** For tests. */
  dependencies?: RecordingTaskProps["dependencies"];
}

type UploadProblem = "retry" | "invalid_audio" | "too_large";

function uploadProblemOf(error: unknown): UploadProblem {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
  if (code === "INVALID_AUDIO") return "invalid_audio";
  if (code === "PAYLOAD_TOO_LARGE") return "too_large";
  return "retry";
}

/**
 * One turn of one speaking task (spec 7, 9, 10): the texts of the task, the
 * prompt card and the recording control. Presentational: the page passes the
 * upload function.
 *
 * Give it a `key` per task and turn (presentation id plus turn index), so the
 * attempt count and the candidate recording never carry over.
 *
 * It never shows a transcript, a translation, any model output or any label
 * for the way the participant speaks (spec 3.1, 83).
 */
export function TaskStep({
  t,
  task,
  onSubmitRecording,
  onSkip,
  skipBusy = false,
  notice = null,
  error = null,
  onCandidateChange,
  onRecorderStateChange,
  onFallback,
  dependencies,
}: TaskStepProps) {
  const { turn } = task;
  const promptLabelId = useId();
  const topicsHeadingId = useId();
  // Task texts are study content: they carry the declared content language, when there is one.
  const contentLang = useContentLanguage();
  const [uploadProblem, setUploadProblem] = useState<UploadProblem>("retry");
  const [recorderState, setRecorderState] = useState<RecorderStatus>("idle");

  const submit = useCallback(
    async (candidate: RecordingCandidate, context: SubmitContext) => {
      try {
        await onSubmitRecording(candidate, context);
      } catch (failure) {
        setUploadProblem(uploadProblemOf(failure));
        throw failure;
      }
    },
    [onSubmitRecording],
  );

  const labels = recordingTaskLabels(t);
  if (uploadProblem !== "retry") {
    const refused = uploadProblem === "invalid_audio" ? t.upload.invalidAudio : t.upload.tooLarge;
    labels.uploadFailed = refused;
    labels.announceUploadFailed = refused;
  }

  const hint =
    typeof task.suggestedDurationSeconds === "number" && task.suggestedDurationSeconds > 0 && !turn.isFollowup
      ? format(t.task.suggestedDuration, { duration: durationText(t, task.suggestedDurationSeconds) })
      : undefined;

  const recorderBusy = recorderState === "recording" || recorderState === "uploading";

  return (
    <div data-testid="task-step" data-turn-index={turn.turnIndex}>
      <ParticipantHeading
        id={STEP_HEADING_ID}
        eyebrow={turn.isFollowup ? t.task.followupLabel : t.task.typeLabel}
        title={task.title}
        titleLang={contentLang}
      />

      {!turn.isFollowup && (task.context || task.instructions) && (
        <div className="mb-6 space-y-4">
          {task.context && (
            <section>
              <h2 className="mb-1 text-sm font-semibold text-slate-900">{t.task.contextHeading}</h2>
              <StudyText text={task.context} headingLevel={3} />
            </section>
          )}
          {task.instructions && (
            <section>
              <h2 className="mb-1 text-sm font-semibold text-slate-900">{t.task.instructionsHeading}</h2>
              <StudyText text={task.instructions} headingLevel={3} />
            </section>
          )}
        </div>
      )}

      <ParticipantCard as="section" className="mb-6" aria-labelledby={promptLabelId} data-testid="task-prompt">
        {turn.isFollowup && (
          <div className="mb-4 border-b border-slate-200 pb-4">
            <p className="mb-1 text-xs font-medium text-slate-500">{t.task.earlierPrompt}</p>
            <p lang={contentLang} className="text-sm leading-relaxed text-slate-500" data-testid="task-original-prompt">
              {task.prompt}
            </p>
          </div>
        )}
        <h2 id={promptLabelId} className="sr-only">
          {turn.isFollowup ? t.task.followupLabel : t.task.promptHeading}
        </h2>
        <p
          lang={contentLang}
          className="whitespace-pre-line text-lg leading-relaxed text-slate-900"
          data-testid="task-current-prompt"
        >
          {turn.promptText}
        </p>
      </ParticipantCard>

      {task.privacyReminder && (
        <InlineMessage variant="info" announce="none" className="mb-6 rounded-xl border-blue-100 p-4 text-blue-800">
          {t.task.privacyReminder}
        </InlineMessage>
      )}

      {task.topicSuggestions.length > 0 && !turn.isFollowup && (
        <section aria-labelledby={topicsHeadingId} className="mb-6">
          <h2 id={topicsHeadingId} className="mb-2 text-sm font-semibold text-slate-900">
            {t.task.topicSuggestionsHeading}
          </h2>
          <ul
            lang={contentLang}
            className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-700 marker:text-slate-400"
          >
            {task.topicSuggestions.map((topic, index) => (
              <li key={index}>{topic}</li>
            ))}
          </ul>
        </section>
      )}

      {notice && (
        <InlineMessage variant="info" className="mb-6">
          {notice}
        </InlineMessage>
      )}
      {error && (
        <InlineMessage variant="error" className="mb-6">
          {error}
        </InlineMessage>
      )}

      <RecordingTask
        maxDurationMs={task.maxDurationSeconds * 1000}
        minDurationMs={
          typeof task.minDurationSeconds === "number" && task.minDurationSeconds > 0
            ? task.minDurationSeconds * 1000
            : undefined
        }
        onSubmit={submit}
        labels={labels}
        hint={hint}
        onCandidateChange={onCandidateChange}
        onStateChange={(state) => {
          setRecorderState(state);
          onRecorderStateChange?.(state);
        }}
        onFallback={onFallback}
        dependencies={dependencies}
      />

      {turn.isOptional && onSkip && (
        <div className="mt-8 border-t border-slate-200 pt-5 text-center">
          <p className="mb-3 text-sm text-slate-500">{t.task.optionalNote}</p>
          <Button
            size="lg"
            variant="secondary"
            onClick={onSkip}
            disabled={recorderBusy}
            loading={skipBusy}
            loadingLabel={t.task.skipping}
          >
            {t.task.skip}
          </Button>
        </div>
      )}
    </div>
  );
}
