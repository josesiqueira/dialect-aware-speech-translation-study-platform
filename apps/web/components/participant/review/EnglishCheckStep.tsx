"use client";

import { useState } from "react";
import type { sessionSchemas } from "@dialect/domain";
import { Button } from "@/components/ui/Button";
import { InlineMessage } from "@/components/ui/InlineMessage";
import { format, type Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import { StepActions } from "../StepActions";
import { STEP_HEADING_ID } from "../flow/FlowShell";

export interface EnglishCheckStepProps {
  t: Dictionary;
  englishCheck: sessionSchemas.EnglishCheckContent;
  /** Sends one yes (true) or no (false) per item, in order. Reject to keep the answers and show `error`. */
  onSubmit: (answers: boolean[]) => Promise<void>;
  onSkip: () => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * The English vocabulary test (LexTALE, www.lextale.com). The published
 * instructions, then one letter string at a time with "Yes" and "No", in the
 * published order, without a time limit. The answers are sent together at the
 * end; the server scores them. Presentational: the study page sends the answers.
 */
export function EnglishCheckStep({ t, englishCheck, onSubmit, onSkip, busy = false, error = null }: EnglishCheckStepProps) {
  const [started, setStarted] = useState(false);
  const [answers, setAnswers] = useState<boolean[]>([]);
  const total = englishCheck.items.length;
  const current = englishCheck.items[answers.length];

  const answer = (value: boolean) => {
    const next = [...answers, value];
    setAnswers(next);
    if (next.length === total) {
      // On a failure the last answer is taken back, so it can be given again.
      onSubmit(next).catch(() => setAnswers(next.slice(0, -1)));
    }
  };

  if (!started) {
    return (
      <div>
        <ParticipantHeading id={STEP_HEADING_ID} title={t.englishCheck.heading} />
        <ParticipantCard as="section" aria-labelledby={STEP_HEADING_ID} className="space-y-3 text-base leading-7 text-slate-800">
          <p>{t.englishCheck.partIntro}</p>
          {t.englishCheck.instructions.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </ParticipantCard>
        <StepActions
          primary={
            <Button size="lg" onClick={() => setStarted(true)}>
              {t.englishCheck.start}
            </Button>
          }
          secondary={
            <Button size="lg" variant="secondary" onClick={onSkip} disabled={busy}>
              {t.englishCheck.skip}
            </Button>
          }
        />
      </div>
    );
  }

  const done = answers.length >= total;
  return (
    <div>
      <ParticipantHeading id={STEP_HEADING_ID} title={t.englishCheck.heading} />
      <ParticipantCard as="section" aria-labelledby={STEP_HEADING_ID} padding="lg" className="text-center">
        <p className="text-sm text-slate-500" aria-live="polite">
          {format(t.englishCheck.progress, { current: Math.min(answers.length + 1, total), total })}
        </p>
        <p className="my-8 text-3xl font-semibold tracking-wide text-slate-900" lang="en" data-testid="english-check-item">
          {done ? "" : current?.text}
        </p>
        <div className="flex justify-center gap-4">
          <Button size="lg" onClick={() => answer(true)} disabled={done || busy} className="min-w-28">
            {t.englishCheck.yes}
          </Button>
          <Button size="lg" variant="secondary" onClick={() => answer(false)} disabled={done || busy} className="min-w-28">
            {t.englishCheck.no}
          </Button>
        </div>
        {done && busy && <p className="mt-6 text-sm text-slate-500">{t.englishCheck.sending}</p>}
      </ParticipantCard>
      {error && (
        <InlineMessage variant="error" className="mt-6">
          {error}
        </InlineMessage>
      )}
    </div>
  );
}
