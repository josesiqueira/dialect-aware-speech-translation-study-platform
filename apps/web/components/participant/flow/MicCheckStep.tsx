"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { InlineMessage } from "@/components/ui/InlineMessage";
import { LoadingState } from "@/components/ui/States";
import { micCheckLabels, type Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import { MicCheck, type MicCheckProps, type MicCheckResult } from "../recorder/MicCheck";
import { STEP_HEADING_ID } from "./FlowShell";

export interface MicCheckStepProps {
  t: Dictionary;
  /**
   * Called when the participant confirms the test, and again when a failed
   * save is retried. Receives technical settings only: the test audio never
   * leaves the MicCheck component.
   */
  onContinue: (result: MicCheckResult) => void;
  /** The confirmation is being saved. */
  busy?: boolean;
  /** Failure of the save, in plain language. The participant can retry without a new test. */
  error?: string | null;
  /** For tests. */
  dependencies?: MicCheckProps["dependencies"];
}

/**
 * The microphone check (spec 6.3). The microphone permission is requested
 * here for the first time, by the participant pressing "Allow microphone".
 */
export function MicCheckStep({ t, onContinue, busy = false, error = null, dependencies }: MicCheckStepProps) {
  // The technical result of a confirmed test. Kept so that a failed save can be retried.
  const [confirmed, setConfirmed] = useState<MicCheckResult | null>(null);

  return (
    <div>
      <ParticipantHeading id={STEP_HEADING_ID} title={t.micCheck.heading} />
      {confirmed === null ? (
        <MicCheck
          labels={micCheckLabels(t)}
          dependencies={dependencies}
          onContinue={(result) => {
            setConfirmed(result);
            onContinue(result);
          }}
        />
      ) : (
        <ParticipantCard aria-busy={busy}>
          {error ? (
            <div className="space-y-4 text-center">
              <InlineMessage variant="error" className="text-left">
                {error}
              </InlineMessage>
              <Button size="lg" onClick={() => onContinue(confirmed)} loading={busy} loadingLabel={t.micCheck.saving}>
                {t.common.tryAgain}
              </Button>
            </div>
          ) : (
            <LoadingState size="sm" label={t.micCheck.saving} />
          )}
        </ParticipantCard>
      )}
    </div>
  );
}
