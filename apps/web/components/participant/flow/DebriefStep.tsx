"use client";

import { useId } from "react";
import type { sessionSchemas } from "@dialect/domain";
import { Button } from "@/components/ui/Button";
import { InlineMessage } from "@/components/ui/InlineMessage";
import type { Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import { StepActions } from "../StepActions";
import { STEP_HEADING_ID } from "./FlowShell";
import { StudyText } from "./StudyText";

export interface ParticipantCodeProps {
  t: Dictionary;
  code: string;
  className?: string;
}

/** The participant code in monospace, with the plain explanation of what it is for (spec 13, 14). */
export function ParticipantCode({ t, code, className }: ParticipantCodeProps) {
  const labelId = useId();
  const explanationId = useId();
  return (
    <div className={className} role="group" aria-labelledby={labelId} aria-describedby={explanationId}>
      <p id={labelId} className="text-sm font-medium text-slate-700">
        {t.debrief.codeLabel}
      </p>
      <p
        className="mt-1 inline-block rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 font-mono text-2xl font-semibold tracking-wider text-slate-900 select-all"
        data-testid="participant-code"
      >
        {code}
      </p>
      <p id={explanationId} className="mt-2 text-sm text-slate-500">
        {t.debrief.codeExplanation}
      </p>
    </div>
  );
}

export interface ContactBlockProps {
  t: Dictionary;
  contactText: string | null | undefined;
  className?: string;
}

/** The contact text of the consent version under a small heading. Renders nothing without a text. */
export function ContactBlock({ t, contactText, className }: ContactBlockProps) {
  const headingId = useId();
  if (!contactText || contactText.trim() === "") return null;
  return (
    <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId} className="mb-2 text-sm font-semibold text-slate-900">
        {t.common.contactHeading}
      </h2>
      <StudyText text={contactText} size="sm" headingLevel={3} />
    </section>
  );
}

export interface DebriefStepProps {
  t: Dictionary;
  /** Debrief text of the protocol and contact text of the consent version, shown as they are. */
  debrief: sessionSchemas.DebriefContent;
  participantCode: string;
  onFinish: () => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * The debrief (spec 13): the debrief text, the contact details and the
 * participant code, then "Finish". The interface adds no promise of its own
 * about the data: what applies is what the protocol text says.
 */
export function DebriefStep({ t, debrief, participantCode, onFinish, busy = false, error = null }: DebriefStepProps) {
  return (
    <div>
      <ParticipantHeading id={STEP_HEADING_ID} title={t.debrief.heading} />
      <ParticipantCard as="section" aria-labelledby={STEP_HEADING_ID}>
        <div>
          <StudyText text={debrief.content} />
          <ParticipantCode t={t} code={participantCode} className="mt-6 border-t border-slate-200 pt-5" />
          <ContactBlock t={t} contactText={debrief.contactText} className="mt-6 border-t border-slate-200 pt-5" />
        </div>
      </ParticipantCard>
      {error && (
        <InlineMessage variant="error" className="mt-6">
          {error}
        </InlineMessage>
      )}
      <StepActions
        primary={
          <Button size="lg" onClick={onFinish} loading={busy} loadingLabel={t.debrief.finishing}>
            {t.debrief.finish}
          </Button>
        }
      />
    </div>
  );
}
