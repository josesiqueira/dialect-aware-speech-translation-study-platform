"use client";

// Preview mode (spec 55, 130): the questionnaire as a participant sees it, with
// the shared QuestionnaireForm in readOnly mode. Nothing is sent or stored.
import { useState } from "react";
import type { questionnaireSchemas as s } from "@dialect/domain";
import { PreviewBanner } from "@/components/participant";
import { QUESTIONNAIRE_FORM_LABELS, QuestionnaireForm } from "@/components/questionnaire";
import { EmptyState, RadioGroup } from "@/components/ui";

const SUBMIT_LABELS = { en: "Continue", fi: "Jatka" } as const;

export interface QuestionnairePreviewProps {
  name: string;
  description: string | null;
  items: s.QuestionnaireItemView[];
  // "background v2 (draft)"
  versionLabel: string;
}

export function QuestionnairePreview({ name, description, items, versionLabel }: QuestionnairePreviewProps) {
  const [locale, setLocale] = useState<"en" | "fi">("en");
  return (
    <div className="space-y-3">
      <RadioGroup
        label="Interface text of the preview"
        help="Only the words the form adds (required, error messages). The questions are shown as written."
        orientation="horizontal"
        options={[
          { value: "en", label: "English" },
          { value: "fi", label: "Finnish" },
        ]}
        value={locale}
        onChange={(value) => setLocale(value === "fi" ? "fi" : "en")}
      />
      <div className="overflow-hidden rounded-lg border border-slate-300">
        <PreviewBanner className="static">{versionLabel}</PreviewBanner>
        <div className="bg-linear-to-b from-slate-50 to-white px-4 py-8" lang={locale}>
          <div className="mx-auto max-w-2xl">
            {items.length === 0 ? (
              <EmptyState title="This questionnaire has no items yet." />
            ) : (
              <>
                <h2 className="mb-2 text-center text-2xl font-bold text-slate-900">{name || "Untitled questionnaire"}</h2>
                {description && <p className="mb-8 text-center text-slate-500">{description}</p>}
                <QuestionnaireForm
                  // A new form when the language changes, so messages are not left in the old language.
                  key={locale}
                  className={description ? undefined : "mt-8"}
                  items={items}
                  labels={QUESTIONNAIRE_FORM_LABELS[locale]}
                  submitLabel={SUBMIT_LABELS[locale]}
                  readOnly
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
