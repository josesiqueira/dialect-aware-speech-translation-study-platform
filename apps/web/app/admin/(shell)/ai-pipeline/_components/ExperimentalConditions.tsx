"use client";

import { useState } from "react";
import { aiConfigSchemas } from "@dialect/domain";
import { Badge, Button, FormField, InlineMessage, Select, TextArea, TextInput } from "@/components/ui";
import { createPrompt, errorMessage } from "./api";
import { STANDARD_SECTIONS } from "./sections";
import { StageSection } from "./StageSection";
import type { ModelConfig, PageContext, PromptVersion, SectionDefinition, Stage } from "./types";

const STAGE_PREFIX: Record<"translation" | "tts", string> = { translation: "translation", tts: "tts" };

type NewCondition = { stage: "translation" | "tts"; conditionKey: string; name: string; promptText: string };

const { AI_KEY_PATTERN } = aiConfigSchemas;

const EMPTY: NewCondition = { stage: "translation", conditionKey: "", name: "", promptText: "" };

export interface ExperimentalConditionsProps {
  sections: SectionDefinition[];
  prompts: PromptVersion[];
  configs: ModelConfig[];
  page: PageContext;
}

/**
 * Collapsed section for conditions beyond the two translation conditions and
 * the baseline voice (spec 50, 166). Nothing here exists or runs unless a
 * researcher adds it.
 */
export function ExperimentalConditions({ sections, prompts, configs, page }: ExperimentalConditionsProps) {
  const [form, setForm] = useState<NewCondition>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = `${STAGE_PREFIX[form.stage]}_${form.conditionKey.trim()}`;
  const takenKeys = new Set<string>([
    ...STANDARD_SECTIONS.flatMap((section) => [section.promptKey, section.configKey]),
    ...prompts.map((prompt) => prompt.key),
    ...configs.map((config) => config.key),
  ]);
  const isDirty = form.conditionKey !== "" || form.name !== "" || form.promptText !== "";

  function change(next: NewCondition) {
    setForm(next);
    page.setDirty("experimental:new", next.conditionKey !== "" || next.name !== "" || next.promptText !== "");
  }

  async function add() {
    const conditionKey = form.conditionKey.trim();
    if (!AI_KEY_PATTERN.test(conditionKey) || !AI_KEY_PATTERN.test(key)) {
      setError("The condition key needs 2 or more characters: lower case letters, digits and underscores, starting with a letter.");
      return;
    }
    if (takenKeys.has(key)) {
      setError(`The key ${key} already exists. Choose another condition key.`);
      return;
    }
    if (form.name.trim() === "") {
      setError("Give the condition a name.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await createPrompt({
        key,
        stage: form.stage as Stage,
        conditionKey,
        name: form.name,
        promptText: form.promptText,
      });
      change(EMPTY);
      await page.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setAdding(false);
    }
  }

  return (
    <details
      className="rounded-lg border border-slate-200 bg-white shadow-sm"
      data-testid="experimental-conditions"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-3 rounded-lg px-6 py-4 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none">
        <h2 className="text-base font-semibold text-slate-900">Optional experimental conditions</h2>
        <Badge variant="neutral">Not enabled by default</Badge>
        <span className="text-xs text-slate-500 tabular-nums">
          {sections.length === 0
            ? "None defined"
            : `${sections.length} ${sections.length === 1 ? "condition" : "conditions"} defined`}
        </span>
      </summary>
      <div className="space-y-4 border-t border-slate-100 px-6 py-5">
        <p className="text-sm text-slate-600">
          The main experiment uses the two translation conditions and the one baseline voice above. A condition added
          here gets its own prompt key and config key. It takes part in processing only after its prompt and its model
          configuration are activated and a processing batch selects it.
        </p>

        {sections.length === 0 ? (
          <p className="rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
            No experimental conditions are defined.
          </p>
        ) : (
          <div className="space-y-4">
            {sections.map((section) => (
              <StageSection key={section.id} section={section} prompts={prompts} configs={configs} page={page} />
            ))}
          </div>
        )}

        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Add a condition</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Creates the first prompt draft of a new key. The model configuration is added in the new section afterwards.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
            <FormField label="Stage">
              <Select
                value={form.stage}
                options={[
                  { value: "translation", label: "Translation" },
                  { value: "tts", label: "TTS" },
                ]}
                onChange={(event) => change({ ...form, stage: event.target.value as NewCondition["stage"] })}
              />
            </FormField>
            <FormField label="Condition key" required help="For example formal_register.">
              <TextInput
                mono
                value={form.conditionKey}
                spellCheck={false}
                onChange={(event) => change({ ...form, conditionKey: event.target.value })}
              />
            </FormField>
            <FormField label="Name" required>
              <TextInput value={form.name} onChange={(event) => change({ ...form, name: event.target.value })} />
            </FormField>
          </div>
          <FormField
            className="mt-4"
            label={form.stage === "tts" ? "Instructions" : "Instruction text"}
            help="The first draft of the prompt. It can be edited before activation."
          >
            <TextArea
              mono
              rows={5}
              value={form.promptText}
              onChange={(event) => change({ ...form, promptText: event.target.value })}
            />
          </FormField>
          {error && (
            <InlineMessage variant="error" className="mt-3">
              {error}
            </InlineMessage>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={add} loading={adding} loadingLabel="Adding..." disabled={!isDirty}>
              Add condition
            </Button>
            {form.conditionKey.trim() !== "" && (
              <span className="text-xs text-slate-500">
                Prompt key and config key: <span className="font-mono">{key}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}
