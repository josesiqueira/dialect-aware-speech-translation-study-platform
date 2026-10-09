"use client";

import { useId, useState } from "react";
import type { sessionSchemas } from "@dialect/domain";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/components/ui/cn";
import { InlineMessage } from "@/components/ui/InlineMessage";
import { focusRing } from "@/components/ui/styles";
import type { Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import { StepActions } from "../StepActions";
import { STEP_HEADING_ID, useContentLanguage } from "./FlowShell";
import { StudyText } from "./StudyText";

export type ConsentResponses = Array<{ itemId: string; accepted: boolean }>;

export interface ConsentStepProps {
  t: Dictionary;
  /** The consent version of the session: title, text, items, privacy notice link, contact. */
  consent: Pick<
    sessionSchemas.ConsentContent,
    "title" | "informationText" | "items" | "privacyNoticeUrl" | "contactText"
  >;
  /** Called with one answer per item when the participant agrees. Every required item is accepted. */
  onAgree: (responses: ConsentResponses) => void;
  /** "I do not want to participate": ends the visit. No consent is stored. */
  onDecline: () => void;
  /** Returns to the information text. Omit to hide the action. */
  onBack?: () => void;
  busy?: boolean;
  /** Failure of the last attempt, in plain language. */
  error?: string | null;
}

/** Only http and https links are rendered as links. Anything else is shown as nothing. */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The consent form (spec 6.2). No box is ever checked in advance, and the
 * choices live only in this component until the participant agrees: a page
 * reload shows every box unchecked again (spec 61).
 */
export function ConsentStep({ t, consent, onAgree, onDecline, onBack, busy = false, error = null }: ConsentStepProps) {
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const contentLang = useContentLanguage();
  const noteId = useId();
  const itemsHeadingId = useId();
  const contactHeadingId = useId();
  const allRequiredAccepted = consent.items.every((item) => !item.required || accepted[item.id] === true);
  const privacyUrl = safeHttpUrl(consent.privacyNoticeUrl);

  const agree = () => {
    if (!allRequiredAccepted || busy) return;
    onAgree(consent.items.map((item) => ({ itemId: item.id, accepted: accepted[item.id] === true })));
  };

  return (
    <div>
      <ParticipantHeading id={STEP_HEADING_ID} title={consent.title} titleLang={contentLang} />

      <ParticipantCard as="section" className="mb-6" aria-labelledby={STEP_HEADING_ID}>
        <StudyText text={consent.informationText} />
      </ParticipantCard>

      <ParticipantCard as="section" aria-labelledby={itemsHeadingId}>
        <div>
          <h2 id={itemsHeadingId} className="text-lg font-semibold text-slate-900">
            {t.consent.itemsHeading}
          </h2>
          <p id={noteId} className="mt-1 text-sm text-slate-500">
            {t.consent.requiredNote}
          </p>
          <ul className="mt-5 space-y-4">
            {consent.items.map((item) => (
              <li key={item.id}>
                <Checkbox
                  density="participant"
                  checked={accepted[item.id] === true}
                  disabled={busy}
                  aria-required={item.required || undefined}
                  data-consent-item={item.id}
                  onChange={(event) => setAccepted((current) => ({ ...current, [item.id]: event.target.checked }))}
                  label={
                    <>
                      {item.text}{" "}
                      <span className="text-sm text-slate-500">
                        {item.required ? t.consent.itemRequired : t.consent.itemOptional}
                      </span>
                    </>
                  }
                />
              </li>
            ))}
          </ul>

          {privacyUrl && (
            <p className="mt-6 text-sm">
              <a
                href={privacyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn("rounded font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700", focusRing)}
              >
                {t.consent.privacyNotice}
              </a>{" "}
              <span className="text-slate-500">{t.common.opensInNewTab}</span>
            </p>
          )}

          {consent.contactText && (
            <section aria-labelledby={contactHeadingId} className="mt-6 border-t border-slate-200 pt-5">
              <h2 id={contactHeadingId} className="mb-2 text-sm font-semibold text-slate-900">
                {t.common.contactHeading}
              </h2>
              <StudyText text={consent.contactText} size="sm" headingLevel={3} />
            </section>
          )}
        </div>
      </ParticipantCard>

      {error && (
        <InlineMessage variant="error" className="mt-6">
          {error}
        </InlineMessage>
      )}

      <StepActions
        primary={
          <Button
            size="lg"
            onClick={agree}
            disabled={!allRequiredAccepted}
            loading={busy}
            loadingLabel={t.consent.saving}
            aria-describedby={noteId}
          >
            {t.consent.agree}
          </Button>
        }
        secondary={
          <Button size="lg" variant="secondary" onClick={onDecline} disabled={busy}>
            {t.consent.decline}
          </Button>
        }
      />
      {onBack && (
        <p className="mt-1 text-center sm:text-left">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className={cn(
              // py-3 makes the pressable area 44 px tall; the text keeps its size.
              "rounded py-3 text-sm text-slate-500 underline underline-offset-2 hover:text-slate-800",
              focusRing,
            )}
          >
            {t.consent.backToInformation}
          </button>
        </p>
      )}
    </div>
  );
}
