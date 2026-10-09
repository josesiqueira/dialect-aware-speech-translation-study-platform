"use client";

import { Button } from "@/components/ui/Button";
import { InlineMessage } from "@/components/ui/InlineMessage";
import type { Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import { STEP_HEADING_ID, useContentLanguage } from "./FlowShell";
import { StudyText } from "./StudyText";

export interface WelcomeStepProps {
  t: Dictionary;
  /** Study name from the study settings. The h1 of the page. */
  studyName: string;
  /** Welcome text of the published protocol. Null when there is none. */
  welcomeContent: string | null;
  /**
   * Set when the study takes no new participants: the text to show instead of
   * the Begin button (spec 87). Null while the study is open.
   */
  closedMessage?: string | null;
  /** This browser has a running session: the button continues it. */
  resumable?: boolean;
  /** Neutral note above the button, for example the test entry note. */
  notice?: string | null;
  /** Failure of the last attempt to begin, in plain language. */
  error?: string | null;
  busy?: boolean;
  onBegin: () => void;
}

/** The welcome page (spec 6.1): study name, welcome text, one primary action. */
export function WelcomeStep({
  t,
  studyName,
  welcomeContent,
  closedMessage = null,
  resumable = false,
  notice = null,
  error = null,
  busy = false,
  onBegin,
}: WelcomeStepProps) {
  const closed = closedMessage !== null && !resumable;
  const contentLang = useContentLanguage();
  return (
    <div>
      <ParticipantHeading id={STEP_HEADING_ID} size="lg" title={studyName} titleLang={contentLang} />
      {welcomeContent && (
        <ParticipantCard className="mb-6">
          <StudyText text={welcomeContent} />
        </ParticipantCard>
      )}
      {resumable && (
        <InlineMessage variant="info" announce="none" className="mb-6 rounded-xl border-blue-100 p-4 text-blue-800">
          {t.welcome.resumeNote}
        </InlineMessage>
      )}
      {notice && (
        <InlineMessage variant="info" announce="none" className="mb-6 rounded-xl border-blue-100 p-4 text-blue-800">
          {notice}
        </InlineMessage>
      )}
      {error && (
        <InlineMessage variant="error" className="mb-6 rounded-xl p-4">
          {error}
        </InlineMessage>
      )}
      {closed ? (
        <ParticipantCard className="text-center" data-testid="study-closed">
          <p className="font-medium text-slate-900">{closedMessage}</p>
        </ParticipantCard>
      ) : (
        <Button
          size="lg"
          fullWidth
          className="py-4 text-lg"
          onClick={onBegin}
          loading={busy}
          loadingLabel={t.welcome.starting}
        >
          {resumable ? t.welcome.continueSession : t.welcome.begin}
        </Button>
      )}
    </div>
  );
}
