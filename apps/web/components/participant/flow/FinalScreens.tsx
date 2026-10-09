"use client";

import type { ReactNode } from "react";
import type { sessionSchemas } from "@dialect/domain";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { StepActions } from "../StepActions";
import { ContactBlock, ParticipantCode } from "./DebriefStep";
import { STEP_HEADING_ID } from "./FlowShell";
import { StudyText } from "./StudyText";

/** The h1 of the centered cards, as on the reference thank-you page. */
function CardHeading({ children }: { children: ReactNode }) {
  return (
    <h1 id={STEP_HEADING_ID} tabIndex={-1} className="mb-4 text-2xl font-bold text-slate-900 focus:outline-none">
      {children}
    </h1>
  );
}

export interface CompletedStepProps {
  t: Dictionary;
  /** Study laptop mode: show "Start next participant" (spec 137). */
  studyLaptopMode: boolean;
  /** Returns to a clean welcome page. Required in study laptop mode. */
  onStartNext?: () => void;
}

/** The final screen. Use inside a shell with width "md" and `centered`. No celebration, no score. */
export function CompletedStep({ t, studyLaptopMode, onStartNext }: CompletedStepProps) {
  return (
    <ParticipantCard padding="lg" className="text-center" data-testid="completed-step">
      <CardHeading>{t.completed.heading}</CardHeading>
      <p className="text-slate-600">{studyLaptopMode ? t.completed.laptopNote : t.completed.body}</p>
      {studyLaptopMode && onStartNext && (
        <StepActions
          layout="stack"
          primary={
            <Button size="lg" onClick={onStartNext}>
              {t.completed.startNext}
            </Button>
          }
        />
      )}
    </ParticipantCard>
  );
}

export interface WithdrawnStepProps {
  t: Dictionary;
  /**
   * True when the participant chose "I do not want to participate" on the
   * consent screen. Nothing was collected, so no code and no debrief are shown.
   */
  declined?: boolean;
  /** Debrief and contact text returned by the API for the ended session. */
  debrief?: sessionSchemas.DebriefContent | null;
  participantCode?: string | null;
  onBackToStart: () => void;
}

/**
 * Shown after "End participation" (spec 86). It states what happened and shows
 * the debrief and contact information of the protocol. It promises nothing
 * about the data that the protocol text does not state.
 */
export function WithdrawnStep({ t, declined = false, debrief = null, participantCode = null, onBackToStart }: WithdrawnStepProps) {
  return (
    <ParticipantCard padding="lg" data-testid="withdrawn-step">
      <div>
        <CardHeading>{declined ? t.withdrawn.declinedHeading : t.withdrawn.heading}</CardHeading>
        <p className="text-slate-600">{declined ? t.withdrawn.declinedBody : t.withdrawn.body}</p>
        {!declined && debrief?.content && (
          <StudyText text={debrief.content} className="mt-6 border-t border-slate-200 pt-5" />
        )}
        {!declined && participantCode && (
          <ParticipantCode t={t} code={participantCode} className="mt-6 border-t border-slate-200 pt-5" />
        )}
        <ContactBlock t={t} contactText={debrief?.contactText} className="mt-6 border-t border-slate-200 pt-5" />
        <StepActions
          primary={
            <Button size="lg" variant="secondary" onClick={onBackToStart}>
              {t.common.backToStart}
            </Button>
          }
        />
      </div>
    </ParticipantCard>
  );
}

export interface MessageScreenProps {
  title: string;
  /** Plain-language explanation. Never a stack trace or a provider message. */
  message: string;
  /** The way forward, for example "Try again" or "Back to the first page". */
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}

/** A calm centered card for a state that stops the flow: session ended, study closed, loading failed. */
export function MessageScreen({ title, message, actionLabel, onAction, secondaryLabel, onSecondary }: MessageScreenProps) {
  return (
    <ParticipantCard padding="lg" className="text-center" data-testid="message-screen">
      <CardHeading>{title}</CardHeading>
      <p className="text-slate-600" role="status">
        {message}
      </p>
      {actionLabel && onAction && (
        <StepActions
          layout="stack"
          primary={
            <Button size="lg" onClick={onAction}>
              {actionLabel}
            </Button>
          }
          secondary={
            secondaryLabel && onSecondary ? (
              <Button size="lg" variant="secondary" onClick={onSecondary}>
                {secondaryLabel}
              </Button>
            ) : undefined
          }
        />
      )}
    </ParticipantCard>
  );
}

export interface EndParticipationDialogProps {
  t: Dictionary;
  open: boolean;
  /** True while the withdrawal request runs. */
  busy?: boolean;
  /** Failure of the withdrawal request, in plain language. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation of "End participation" (spec 86), in plain language. The
 * confirm button is not styled as danger: ending participation is the
 * participant's right, not an error.
 */
export function EndParticipationDialog({ t, open, busy = false, error = null, onConfirm, onCancel }: EndParticipationDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title={t.endParticipation.title}
      confirmLabel={t.endParticipation.confirm}
      cancelLabel={t.endParticipation.cancel}
      busy={busy}
      busyLabel={t.endParticipation.busy}
      error={error ?? undefined}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>{t.endParticipation.body}</p>
      <p>{t.endParticipation.bodySubmitted}</p>
    </ConfirmDialog>
  );
}
