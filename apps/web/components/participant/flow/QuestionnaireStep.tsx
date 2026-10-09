"use client";

import type { sessionSchemas } from "@dialect/domain";
import { InlineMessage } from "@/components/ui/InlineMessage";
import { QuestionnaireForm } from "@/components/questionnaire/QuestionnaireForm";
import type { QuestionnaireFormLabels } from "@/components/questionnaire/labels";
import { format, type Dictionary } from "@/lib/i18n";
import { ParticipantHeading } from "../ParticipantHeading";
import { STEP_HEADING_ID } from "./FlowShell";

/** One problem the server found in a submitted answer: the item and the error code of the API. */
export interface QuestionnaireServerIssue {
  itemKey: string;
  code: string;
}

export interface QuestionnaireStepProps {
  t: Dictionary;
  /** Name, description and items of the questionnaire version, shown as the researchers wrote them. */
  questionnaire: Pick<sessionSchemas.QuestionnaireContent, "name" | "description" | "items">;
  /** Sends the validated answers. Reject to keep the answers and show the "could not be sent" message. */
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  /** Problems the server reported for the last submit (details.issues of a VALIDATION_ERROR). */
  serverIssues?: QuestionnaireServerIssue[];
  /** A failure that is not about single answers, in plain language. */
  error?: string | null;
}

function issueText(
  item: sessionSchemas.QuestionnaireItemContent,
  code: string,
  labels: QuestionnaireFormLabels,
): string {
  const { config } = item;
  switch (code) {
    case "required":
      return labels.errors.required;
    case "not_integer":
      return labels.errors.notInteger;
    case "too_long":
      return config.maxLength !== undefined ? format(labels.errors.tooLong, { max: config.maxLength }) : labels.errors.invalid;
    case "out_of_range": {
      const min = item.type === "likert" ? (config.scaleMin ?? 1) : config.min;
      const max = item.type === "likert" ? (config.scaleMax ?? 5) : config.max;
      if (min !== undefined && max !== undefined) return format(labels.errors.outOfRange, { min, max });
      if (min !== undefined) return format(labels.errors.atLeast, { min });
      if (max !== undefined) return format(labels.errors.atMost, { max });
      return labels.errors.invalid;
    }
    default:
      return labels.errors.invalid;
  }
}

/**
 * A questionnaire of the study (spec 11, 12): the shared QuestionnaireForm
 * with the interface text of the participant's language. The form validates
 * with the same rules as the server. If the server still reports a problem,
 * each one is listed with the question it belongs to.
 */
export function QuestionnaireStep({ t, questionnaire, onSubmit, serverIssues = [], error = null }: QuestionnaireStepProps) {
  const labels = t.questionnaire.form;
  const listed = serverIssues
    .map((issue) => {
      const item = questionnaire.items.find((candidate) => candidate.itemKey === issue.itemKey);
      return item ? { itemKey: issue.itemKey, prompt: item.prompt, text: issueText(item, issue.code, labels) } : null;
    })
    .filter((entry): entry is { itemKey: string; prompt: string; text: string } => entry !== null);

  return (
    <div>
      <ParticipantHeading
        id={STEP_HEADING_ID}
        title={questionnaire.name}
        description={questionnaire.description ?? undefined}
      />
      {listed.length > 0 && (
        <InlineMessage
          variant="error"
          className="mb-6"
          title={format(labels.errorSummary, { count: listed.length })}
        >
          <ul className="mt-1 list-disc space-y-1 pl-5" data-testid="questionnaire-server-issues">
            {listed.map((entry) => (
              <li key={entry.itemKey}>
                <span className="font-medium">{entry.prompt}</span> {entry.text}
              </li>
            ))}
          </ul>
        </InlineMessage>
      )}
      {error && listed.length === 0 && (
        <InlineMessage variant="error" className="mb-6">
          {error}
        </InlineMessage>
      )}
      <QuestionnaireForm
        items={questionnaire.items}
        labels={labels}
        submitLabel={t.questionnaire.submit}
        onSubmit={onSubmit}
      />
    </div>
  );
}
