"use client";

import { useState } from "react";
import type { corpusSchemas } from "@dialect/domain";
import { Card, CardBody, CardHeader, Checkbox, FormField, TextInput } from "@/components/ui";
import { Actions, numberValue, useSection } from "./EditableSections";

type Settings = corpusSchemas.SettingsView;

function reviewOf(settings: Settings) {
  const review = settings.outputReview;
  return {
    enabled: review.enabled,
    englishCheckEnabled: review.englishCheckEnabled,
    maxItems: String(review.maxItems),
  };
}

/**
 * The output review at the end of a session (docs/RESEARCH-DESIGN.md, section
 * 3; docs/ADMIN.md, "Settings"). It runs only for participants who accepted the
 * consent item of scope output_review. The number of reviewed recordings is a
 * starting value until the pilot sets it.
 */
export function OutputReviewSection({ settings, onSaved }: { settings: Settings; onSaved: () => Promise<void> }) {
  const [review, setReview] = useState(() => reviewOf(settings));
  const section = useSection(onSaved);
  const stored = reviewOf(settings);
  const dirty = JSON.stringify(review) !== JSON.stringify(stored);

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Output review"
        description="At the end of a session, participants see the speech recognition text and the two English versions of their recordings, one recording per screen, and rate each version."
        actions={
          <Actions
            dirty={dirty}
            section={section}
            onCancel={() => {
              setReview(stored);
              section.reset();
            }}
            onSave={() =>
              void section
                .save({
                  outputReviewEnabled: review.enabled,
                  englishCheckEnabled: review.englishCheckEnabled,
                  outputReviewMaxItems: numberValue(review.maxItems),
                })
                .then((saved) => saved && setReview(reviewOf(saved)))
            }
          />
        }
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Checkbox
            label="Run the output review"
            description="Off: no session gets the review or the post-review questionnaire."
            checked={review.enabled}
            onChange={(event) => setReview({ ...review, enabled: event.target.checked })}
          />
          <Checkbox
            label="English vocabulary test before the review"
            description="LexTALE, a 5-minute test (www.lextale.com). Off by default: the background questionnaire asks participants to rate how well they understand written English."
            checked={review.englishCheckEnabled}
            onChange={(event) => setReview({ ...review, englishCheckEnabled: event.target.checked })}
          />
        </div>
        <FormField
          label="Recordings per participant"
          help="The most of the participant's own recordings shown, spread across tasks. The default of 5 was chosen by the project owner to keep the session short (4 ratings per recording); the research report suggests 8 to 12 as an assumption to test in the pilot."
        >
          <TextInput
            type="number"
            min={1}
            max={20}
            className="tabular-nums sm:w-32"
            value={review.maxItems}
            onChange={(event) => setReview({ ...review, maxItems: event.target.value })}
          />
        </FormField>
      </CardBody>
    </Card>
  );
}
