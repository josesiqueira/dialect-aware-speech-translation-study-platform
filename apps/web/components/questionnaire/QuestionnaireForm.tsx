"use client";

/**
 * QuestionnaireForm: renders one questionnaire version and collects the answers.
 * Used by the participant flow, the Study Flow preview and the Questionnaires
 * admin preview. Import from "@/components/questionnaire".
 *
 * PROPS
 *
 *   items            QuestionnaireItemDefinition[]   the items, in the order to show them. Each needs
 *                                                    { itemKey, type, prompt, helpText, required, config }.
 *                                                    QuestionnaireItemView (admin API) and
 *                                                    QuestionnaireItemContent (participant API) both fit.
 *   onSubmit         (values) => Promise<void> | void   called with the validated, typed answers, keyed by
 *                                                    item key. Unanswered optional items are left out.
 *                                                    While the promise is pending the form is locked and
 *                                                    the button shows labels.submitting. If it rejects,
 *                                                    labels.submitFailed is shown and the answers are kept.
 *                                                    Not called in readOnly mode.
 *   submitLabel      string                          text of the submit button ("Continue").
 *   labels           QuestionnaireFormLabels         interface text in the participant's language. Use
 *                                                    QUESTIONNAIRE_FORM_LABELS_EN, QUESTIONNAIRE_FORM_LABELS_FI
 *                                                    or QUESTIONNAIRE_FORM_LABELS[locale] from "./labels".
 *   initialValues?   Record<string, unknown>         answers to start with, keyed by item key, in the
 *                                                    answer value shape below (read once, on mount).
 *   secondaryAction? ReactNode                       a second button next to submit, for example
 *                                                    <Button size="lg" variant="secondary">Back</Button>.
 *   disabled?        boolean                         locks every control and the submit button.
 *   readOnly?        boolean                         preview: fully interactive and validated, but nothing
 *                                                    is sent. A valid submit shows labels.previewNotice.
 *   title?           string                          optional heading inside the card (the questionnaire name).
 *   description?     string                          optional muted line under the title.
 *   className?       string
 *
 * ANSWER VALUE SHAPE (what onSubmit receives, and what initialValues takes)
 *
 *   likert         number    within config.scaleMin..config.scaleMax (default 1..5)
 *   single_choice  string    one option value
 *   multi_choice   string[]  option values
 *   free_text      string
 *   short_text     string
 *   integer        number    a whole number within config.min..config.max
 *   boolean        boolean
 *
 * The same rules run again on the server: validateQuestionnaireAnswers in
 * "@dialect/domain" (questionnaireSchemas) is the one definition of a valid answer.
 *
 * ACCESSIBILITY
 *
 * Choice items are a fieldset with a legend holding native radio or checkbox
 * inputs, so a scale is one tab stop and the arrow keys move and select. Text
 * items are a label with a native input. Required items say so in text. On an
 * invalid submit each error appears under its item, linked with
 * aria-describedby, a summary is announced (role="alert") and focus moves to
 * the first item with a problem. There is no time limit.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { questionnaireSchemas } from "@dialect/domain";
import { ParticipantCard, StepActions } from "@/components/participant";
import { Button, cn, inputBase, inputSizes, labelBase } from "@/components/ui";
import { segmentLabelClasses } from "@/components/ui/RadioGroup";
import type { QuestionnaireFormLabels } from "./labels";

type Item = questionnaireSchemas.QuestionnaireItemDefinition;
type AnswerValues = questionnaireSchemas.QuestionnaireAnswerValues;

export interface QuestionnaireFormProps {
  items: readonly Item[];
  onSubmit?: (values: AnswerValues) => Promise<void> | void;
  submitLabel: string;
  labels: QuestionnaireFormLabels;
  initialValues?: Record<string, unknown>;
  secondaryAction?: ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
  title?: string;
  description?: string;
  className?: string;
}

const WHOLE_NUMBER = /^[+-]?\d+$/;

// The value a control holds while editing. A number item holds the typed text.
function toDraftValue(item: Item, value: unknown): unknown {
  if (value === undefined || value === null) return item.type === "multi_choice" ? [] : item.type === "integer" ? "" : null;
  if (item.type === "integer") return String(value);
  return value;
}

// The value handed to validation: the typed text of a number item becomes a number.
function toAnswerValue(item: Item, draft: unknown): unknown {
  if (item.type !== "integer") return draft;
  const text = typeof draft === "string" ? draft.trim() : "";
  if (text === "") return undefined;
  return WHOLE_NUMBER.test(text) ? Number.parseInt(text, 10) : Number.NaN;
}

function fill(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (values[name] === undefined ? match : String(values[name])));
}

function errorText(item: Item, code: questionnaireSchemas.AnswerErrorCode, labels: QuestionnaireFormLabels): string {
  const config = item.config ?? {};
  switch (code) {
    case "required":
      return labels.errors.required;
    case "not_integer":
      return labels.errors.notInteger;
    case "invalid_type":
      return item.type === "integer" ? labels.errors.notInteger : labels.errors.invalid;
    case "out_of_range": {
      const bounds: { min?: number; max?: number } =
        item.type === "likert" ? questionnaireSchemas.likertBounds(config) : { min: config.min, max: config.max };
      if (bounds.min !== undefined && bounds.max !== undefined) return fill(labels.errors.outOfRange, bounds);
      if (bounds.min !== undefined) return fill(labels.errors.atLeast, bounds);
      return fill(labels.errors.atMost, bounds);
    }
    case "too_long":
      return fill(labels.errors.tooLong, {
        max: questionnaireSchemas.textMaxLength(item.type === "short_text" ? "short_text" : "free_text", config),
      });
    default:
      return labels.errors.invalid;
  }
}

const choiceRowClasses =
  "flex cursor-pointer items-start gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-700 " +
  "transition-colors hover:bg-slate-50 has-checked:border-slate-900 has-checked:bg-slate-50 has-checked:text-slate-900 " +
  "has-disabled:cursor-not-allowed has-disabled:opacity-60";
const choiceInputClasses =
  "mt-0.5 h-5 w-5 shrink-0 accent-slate-900 focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-blue-600 focus-visible:ring-offset-1";

export function QuestionnaireForm({
  items,
  onSubmit,
  submitLabel,
  labels,
  initialValues,
  secondaryAction,
  disabled = false,
  readOnly = false,
  title,
  description,
  className,
}: QuestionnaireFormProps) {
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [drafts, setDrafts] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(items.map((item) => [item.itemKey, toDraftValue(item, initialValues?.[item.itemKey])])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "preview"; text: string } | null>(null);

  // The number of problems found by the last submit. It is announced once and
  // not again while the participant corrects the answers one by one.
  const [summaryCount, setSummaryCount] = useState(0);

  const locked = disabled || submitting;
  const hasErrors = Object.keys(errors).length > 0;

  function setValue(itemKey: string, value: unknown) {
    setDrafts((current) => ({ ...current, [itemKey]: value }));
    setNotice(null);
    setErrors((current) => {
      if (!(itemKey in current)) return current;
      const next = { ...current };
      delete next[itemKey];
      return next;
    });
  }

  function focusItem(itemKey: string) {
    const group = formRef.current?.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(itemKey)}"]`);
    const control =
      group?.querySelector<HTMLElement>("input:checked") ?? group?.querySelector<HTMLElement>("input, textarea");
    control?.focus();
    (group ?? control)?.scrollIntoView?.({ block: "center" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    setNotice(null);
    const answers: Record<string, unknown> = {};
    for (const item of items) {
      const value = toAnswerValue(item, drafts[item.itemKey] ?? toDraftValue(item, undefined));
      if (value !== undefined) answers[item.itemKey] = value;
    }
    const result = questionnaireSchemas.validateQuestionnaireAnswers(items, answers);
    if (!result.ok) {
      const next: Record<string, string> = {};
      for (const item of items) {
        const code = result.errorCodes[item.itemKey];
        if (code) next[item.itemKey] = errorText(item, code, labels);
      }
      setErrors(next);
      setSummaryCount(Object.keys(next).length);
      const first = items.find((item) => next[item.itemKey]);
      if (first) focusItem(first.itemKey);
      return;
    }
    setErrors({});
    if (readOnly) {
      setNotice({ kind: "preview", text: labels.previewNotice });
      return;
    }
    if (!onSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(result.values);
    } catch {
      setNotice({ kind: "error", text: labels.submitFailed });
    } finally {
      setSubmitting(false);
    }
  }

  function renderItem(item: Item) {
    const config = item.config ?? {};
    const baseId = `${formId}-${item.itemKey}`;
    const error = errors[item.itemKey];
    const helpId = item.helpText ? `${baseId}-help` : undefined;
    const errorId = error ? `${baseId}-error` : undefined;
    const draft = drafts[item.itemKey] ?? toDraftValue(item, undefined);

    const promptText = (
      <>
        {item.prompt}
        {item.required && " "}
        {item.required && <span className="font-normal text-slate-500">{labels.required}</span>}
      </>
    );
    const help = item.helpText && (
      <p id={helpId} className="-mt-1 mb-2 text-xs text-slate-500">
        {item.helpText}
      </p>
    );
    const errorLine = error && (
      <p id={errorId} className="mt-1.5 text-sm text-rose-700">
        {error}
      </p>
    );

    if (item.type === "free_text" || item.type === "short_text" || item.type === "integer") {
      const shared = {
        id: baseId,
        value: typeof draft === "string" ? draft : "",
        disabled: locked,
        placeholder: config.placeholder,
        "aria-describedby": [helpId, errorId].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? (true as const) : undefined,
        "aria-required": item.required || undefined,
      };
      return (
        <div key={item.itemKey} data-item-key={item.itemKey}>
          <label htmlFor={baseId} className={cn(labelBase, "mb-2")}>
            {promptText}
          </label>
          {help}
          {item.type === "free_text" ? (
            <textarea
              {...shared}
              rows={3}
              maxLength={questionnaireSchemas.textMaxLength("free_text", config)}
              onChange={(event) => setValue(item.itemKey, event.target.value)}
              className={cn(inputBase, inputSizes.lg)}
            />
          ) : item.type === "short_text" ? (
            <input
              {...shared}
              type="text"
              maxLength={questionnaireSchemas.textMaxLength("short_text", config)}
              onChange={(event) => setValue(item.itemKey, event.target.value)}
              className={cn(inputBase, inputSizes.lg)}
            />
          ) : (
            <input
              {...shared}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              onChange={(event) => setValue(item.itemKey, event.target.value)}
              className={cn(inputBase, inputSizes.lg, "max-w-40 tabular-nums")}
            />
          )}
          {errorLine}
        </div>
      );
    }

    const anchorsId =
      item.type === "likert" && (config.scaleMinLabel || config.scaleMaxLabel) ? `${baseId}-anchors` : undefined;
    const hintId = item.type === "multi_choice" ? `${baseId}-hint` : undefined;
    const inputDescribedBy = errorId;

    let control: ReactNode;
    if (item.type === "likert") {
      const { min, max } = questionnaireSchemas.likertBounds(config);
      const points: number[] = [];
      for (let n = min; n <= max && points.length < questionnaireSchemas.LIKERT_MAX_POINTS; n += 1) points.push(n);
      control = (
        <>
          <div className={cn("mb-1 flex", points.length > 7 ? "gap-1 sm:gap-2" : "gap-2")}>
            {points.map((n) => (
              <label key={n} className={cn(segmentLabelClasses, "min-w-0 py-2.5 text-base font-medium tabular-nums")}>
                <input
                  type="radio"
                  className="sr-only"
                  name={baseId}
                  value={n}
                  checked={draft === n}
                  onChange={() => setValue(item.itemKey, n)}
                  aria-describedby={inputDescribedBy}
                />
                {n}
              </label>
            ))}
          </div>
          {anchorsId && (
            <div id={anchorsId} className="flex justify-between gap-4 px-1 text-xs text-slate-500">
              <span>
                <span className="sr-only">{min}: </span>
                {config.scaleMinLabel}
              </span>
              <span className="text-right">
                <span className="sr-only">{max}: </span>
                {config.scaleMaxLabel}
              </span>
            </div>
          )}
        </>
      );
    } else if (item.type === "boolean") {
      control = (
        <div className="flex gap-3">
          {[true, false].map((option) => (
            <label key={String(option)} className={cn(segmentLabelClasses, "px-2 py-2.5 text-sm")}>
              <input
                type="radio"
                className="sr-only"
                name={baseId}
                value={String(option)}
                checked={draft === option}
                onChange={() => setValue(item.itemKey, option)}
                aria-describedby={inputDescribedBy}
              />
              {option ? labels.yes : labels.no}
            </label>
          ))}
        </div>
      );
    } else if (item.type === "single_choice") {
      control = (
        <div className="space-y-2">
          {(config.options ?? []).map((option) => (
            <label key={option.value} className={choiceRowClasses}>
              <input
                type="radio"
                className={choiceInputClasses}
                name={baseId}
                value={option.value}
                checked={draft === option.value}
                onChange={() => setValue(item.itemKey, option.value)}
                aria-describedby={inputDescribedBy}
              />
              <span className="min-w-0 text-base">{option.label}</span>
            </label>
          ))}
        </div>
      );
    } else {
      const chosen = Array.isArray(draft) ? (draft as string[]) : [];
      control = (
        <div className="space-y-2">
          {(config.options ?? []).map((option) => (
            <label key={option.value} className={choiceRowClasses}>
              <input
                type="checkbox"
                className={cn(choiceInputClasses, "rounded")}
                name={baseId}
                value={option.value}
                checked={chosen.includes(option.value)}
                onChange={(event) =>
                  setValue(
                    item.itemKey,
                    event.target.checked ? [...chosen, option.value] : chosen.filter((value) => value !== option.value),
                  )
                }
                aria-describedby={inputDescribedBy}
              />
              <span className="min-w-0 text-base">{option.label}</span>
            </label>
          ))}
        </div>
      );
    }

    return (
      <fieldset
        key={item.itemKey}
        data-item-key={item.itemKey}
        className="min-w-0"
        disabled={locked}
        aria-describedby={[helpId, hintId, anchorsId, errorId].filter(Boolean).join(" ") || undefined}
      >
        <legend className={cn(labelBase, "mb-2")}>{promptText}</legend>
        {help}
        {hintId && (
          <p id={hintId} className="-mt-1 mb-2 text-xs text-slate-500">
            {labels.selectAllThatApply}
          </p>
        )}
        {control}
        {errorLine}
      </fieldset>
    );
  }

  const submitButton = (
    <Button type="submit" size="lg" className="px-8" loading={submitting} loadingLabel={labels.submitting} disabled={disabled}>
      {submitLabel}
    </Button>
  );

  return (
    <form ref={formRef} noValidate onSubmit={handleSubmit} className={cn("space-y-6", className)} aria-busy={submitting || undefined}>
      <div role="alert">
        {hasErrors && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            {fill(labels.errorSummary, { count: summaryCount })}
          </p>
        )}
      </div>

      <ParticipantCard as="section" className="space-y-5">
        {(title || description) && (
          <div>
            {title && <h2 className="font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
        )}
        {items.map(renderItem)}
      </ParticipantCard>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={cn(
            "rounded-lg border px-4 py-2 text-sm",
            notice.kind === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-blue-200 bg-blue-50 text-blue-900",
          )}
        >
          {notice.text}
        </p>
      )}

      {secondaryAction ? (
        <StepActions className="mt-0" primary={submitButton} secondary={secondaryAction} />
      ) : (
        <div className="flex justify-center">{submitButton}</div>
      )}
    </form>
  );
}
