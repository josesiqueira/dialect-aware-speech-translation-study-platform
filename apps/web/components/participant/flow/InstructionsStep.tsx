"use client";

import { Button } from "@/components/ui/Button";
import { InlineMessage } from "@/components/ui/InlineMessage";
import type { Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import { StepActions } from "../StepActions";
import { STEP_HEADING_ID } from "./FlowShell";
import { StudyText } from "./StudyText";

export interface InstructionsStepProps {
  t: Dictionary;
  /** The instruction text of the protocol, shown as it is (spec 6.4). */
  content: string;
  onStart: () => void;
  busy?: boolean;
  error?: string | null;
}

/** The study instructions, then "Start". */
export function InstructionsStep({ t, content, onStart, busy = false, error = null }: InstructionsStepProps) {
  return (
    <div>
      <ParticipantHeading id={STEP_HEADING_ID} title={t.instructions.heading} />
      <ParticipantCard as="section" aria-labelledby={STEP_HEADING_ID}>
        <StudyText text={content} />
      </ParticipantCard>
      {error && (
        <InlineMessage variant="error" className="mt-6">
          {error}
        </InlineMessage>
      )}
      <StepActions
        primary={
          <Button size="lg" onClick={onStart} loading={busy} loadingLabel={t.instructions.starting}>
            {t.instructions.start}
          </Button>
        }
      />
    </div>
  );
}
