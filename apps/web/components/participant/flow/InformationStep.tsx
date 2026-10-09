"use client";

import { Button } from "@/components/ui/Button";
import type { Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import { StepActions } from "../StepActions";
import { STEP_HEADING_ID } from "./FlowShell";
import { StudyText } from "./StudyText";

export interface InformationStepProps {
  t: Dictionary;
  /** The participant information text of the protocol. */
  content: string;
  onContinue: () => void;
}

/** First screen of the consent step (spec 6.2): the participant information text. */
export function InformationStep({ t, content, onContinue }: InformationStepProps) {
  return (
    <div>
      <ParticipantHeading id={STEP_HEADING_ID} title={t.information.heading} />
      <ParticipantCard as="section" aria-labelledby={STEP_HEADING_ID}>
        <StudyText text={content} />
      </ParticipantCard>
      <StepActions
        primary={
          <Button size="lg" onClick={onContinue}>
            {t.information.continue}
          </Button>
        }
      />
    </div>
  );
}
