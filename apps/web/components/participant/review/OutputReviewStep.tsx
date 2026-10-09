"use client";

import { useState, type ReactNode } from "react";
import type { sessionSchemas } from "@dialect/domain";
import { AudioPlayer } from "@/components/ui/AudioPlayer";
import { Button } from "@/components/ui/Button";
import { InlineMessage } from "@/components/ui/InlineMessage";
import { LoadingState } from "@/components/ui/States";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { format, type Dictionary } from "@/lib/i18n";
import { ParticipantCard } from "../ParticipantCard";
import { ParticipantHeading } from "../ParticipantHeading";
import { StepActions } from "../StepActions";
import { STEP_HEADING_ID } from "../flow/FlowShell";

type Content = sessionSchemas.OutputReviewContent;
type Item = sessionSchemas.OutputReviewItemContent;
type Answer = sessionSchemas.OutputReviewAnswerBody;
type AudioSource = "source";

export interface OutputReviewStepProps {
  t: Dictionary;
  review: Content;
  /** The address of a play button of the current screen. */
  audioUrl: (itemId: string, which: AudioSource) => string;
  /** Sends the answers of one screen. Reject to keep them and show `error`. */
  onAnswer: (itemId: string, answer: Answer) => Promise<void>;
  onSkip: () => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * The review of the participant's own recordings, one page per recording
 * (docs/PARTICIPANT-UI.md, "Output review"): the speech recognition text with
 * "Is this what you said?", then the two English versions side by side (stacked
 * on a phone), each with two fully labelled 5-point questions and "I can't say".
 * The versions are only ever called "Version 1" and "Version 2". Presentational:
 * the study page sends the answers and asks again while the recordings are
 * being prepared.
 */
export function OutputReviewStep(props: OutputReviewStepProps) {
  const { t, review } = props;
  if (review.status === "preparing") {
    return (
      <div>
        <ParticipantHeading id={STEP_HEADING_ID} title={t.review.preparingTitle} />
        <ParticipantCard as="section" aria-labelledby={STEP_HEADING_ID}>
          <p className="mb-4 text-base text-slate-700">{t.review.preparingBody}</p>
          <div aria-busy="true">
            <LoadingState label={t.common.loading} />
          </div>
        </ParticipantCard>
        <StepActions
          primary={
            <Button size="lg" variant="secondary" onClick={props.onSkip} disabled={props.busy}>
              {t.review.skip}
            </Button>
          }
        />
      </div>
    );
  }
  // One form per screen: its state starts empty for every new item.
  return <ReviewScreen key={review.item.id} {...props} item={review.item} itemNumber={review.itemNumber} totalItems={review.totalItems} />;
}

type Rating = number | "cant_judge" | null;
type VersionRatings = { meaning: Rating; representation: Rating };
const EMPTY_VERSION: VersionRatings = { meaning: null, representation: null };

/** One question with its five labelled points and "I can't say", as one radio group. */
function ScaleQuestion({
  label,
  points,
  cantSay,
  value,
  onChange,
}: {
  label: string;
  points: readonly string[];
  cantSay: string;
  value: Rating;
  onChange: (value: Rating) => void;
}) {
  return (
    <RadioGroup
      label={label}
      value={value === null ? null : String(value)}
      onChange={(next) => onChange(next === "cant_judge" ? "cant_judge" : Number(next))}
      options={[
        ...points.map((point, index) => ({ value: String(index + 1), label: point })),
        { value: "cant_judge", label: cantSay },
      ]}
    />
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ParticipantCard as="section" className="space-y-5">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {children}
    </ParticipantCard>
  );
}

function ReviewScreen({
  t,
  item,
  itemNumber,
  totalItems,
  audioUrl,
  onAnswer,
  onSkip,
  busy = false,
  error = null,
}: OutputReviewStepProps & { item: Item; itemNumber: number; totalItems: number }) {
  const [said, setSaid] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<"1" | "2", VersionRatings>>({ "1": EMPTY_VERSION, "2": EMPTY_VERSION });
  const [incomplete, setIncomplete] = useState(false);

  const setRating = (slot: "1" | "2", key: keyof VersionRatings, value: Rating) =>
    setVersions((current) => ({ ...current, [slot]: { ...current[slot], [key]: value } }));

  const submit = () => {
    const ratings = Object.values(versions).flatMap((v) => Object.values(v));
    if (said === null || ratings.some((value) => value === null)) return setIncomplete(true);
    const asBody = (v: VersionRatings) => v as { [K in keyof VersionRatings]: number | "cant_judge" };
    const answer: Answer = {
      source: { said: said as Answer["source"]["said"] },
      versions: { "1": asBody(versions["1"]), "2": asBody(versions["2"]) },
    };
    setIncomplete(false);
    void onAnswer(item.id, answer).catch(() => undefined);
  };

  return (
    <div className="space-y-6">
      <div>
        <ParticipantHeading id={STEP_HEADING_ID} title={t.review.heading} />
        <p className="text-sm text-slate-500" aria-live="polite">
          {format(t.review.progress, { current: itemNumber, total: totalItems })}
        </p>
      </div>

      <Section title={t.review.recognizedHeading}>
        {item.audio.source && <AudioPlayer src={audioUrl(item.id, "source")} label={t.review.ownRecording} />}
        <p className="text-lg leading-8 text-slate-900" lang="fi" data-testid="review-source-text">
          {item.sourceText}
        </p>
        <RadioGroup
          label={t.review.said}
          layout="buttons"
          orientation="horizontal"
          value={said}
          onChange={setSaid}
          options={[
            { value: "yes", label: t.review.saidYes },
            { value: "partly", label: t.review.saidPartly },
            { value: "no", label: t.review.saidNo },
          ]}
        />
      </Section>

      <Section title={t.review.versionsHeading}>
        <div className="grid gap-6 md:grid-cols-2">
          {item.versions.map((version) => {
            const slot = String(version.slot) as "1" | "2";
            const v = versions[slot];
            return (
              <div key={slot} className="space-y-5 rounded-lg border border-slate-200 p-4" data-testid={`review-version-${slot}`}>
                <p className="text-sm font-semibold text-slate-900">{format(t.review.version, { slot })}</p>
                <p className="text-base leading-7 text-slate-900" lang="en">
                  {version.text}
                </p>
                <ScaleQuestion
                  label={t.review.meaning}
                  points={t.review.meaningScale}
                  cantSay={t.review.cantSay}
                  value={v.meaning}
                  onChange={(r) => setRating(slot, "meaning", r)}
                />
                <ScaleQuestion
                  label={t.review.representation}
                  points={t.review.representationScale}
                  cantSay={t.review.cantSay}
                  value={v.representation}
                  onChange={(r) => setRating(slot, "representation", r)}
                />
              </div>
            );
          })}
        </div>
      </Section>

      {incomplete && <InlineMessage variant="error">{t.review.answerAll}</InlineMessage>}
      {error && <InlineMessage variant="error">{error}</InlineMessage>}
      <StepActions
        primary={
          <Button size="lg" onClick={submit} loading={busy} loadingLabel={t.review.sending}>
            {t.review.next}
          </Button>
        }
        secondary={
          <Button size="lg" variant="secondary" onClick={onSkip} disabled={busy}>
            {t.review.skip}
          </Button>
        }
      />
    </div>
  );
}
