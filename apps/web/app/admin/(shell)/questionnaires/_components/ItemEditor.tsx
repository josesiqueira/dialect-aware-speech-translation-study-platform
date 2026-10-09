"use client";

// One item of a draft: a summary row with Move up, Move down and Remove, and the
// inline form (item key, prompt, help text, required, response type, options,
// scale) when the item is open.
import {
  questionnaireSchemas as s,
  STUDY_TEXT_LOCALE_NAMES,
  STUDY_TEXT_TRANSLATION_LOCALES,
  type QuestionnaireItemType,
} from "@dialect/domain";
import { Badge, Button, Checkbox, FormField, InlineMessage, Select, TextArea, TextInput } from "@/components/ui";
import {
  ITEM_TYPE_OPTIONS,
  defaultEditorConfig,
  emptyItemTexts,
  itemConfig,
  nextUid,
  type EditorItem,
  type EditorItemTexts,
  type EditorOption,
} from "./model";

export interface ItemEditorProps {
  item: EditorItem;
  index: number;
  count: number;
  open: boolean;
  keyError?: string;
  disabled?: boolean;
  onToggle: () => void;
  onChange: (item: EditorItem) => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
}

function numberOrUndefined(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

export function ItemEditor({ item, index, count, open, keyError, disabled, onToggle, onChange, onMove, onRemove }: ItemEditorProps) {
  const position = index + 1;
  const name = item.prompt.trim() || "(no prompt yet)";
  const panelId = `item-panel-${item.uid}`;
  const config = itemConfig(item);
  const configCheck = s.validateItemConfig(item.type, config);
  const warnings = s.findIdentifyingFieldWarnings({ itemKey: item.itemKey, prompt: item.prompt });

  const set = (patch: Partial<EditorItem>) => onChange({ ...item, ...patch });
  const setConfig = (patch: Partial<EditorItem["config"]>) => set({ config: { ...item.config, ...patch } });

  function changePrompt(prompt: string) {
    set(item.autoKey ? { prompt, itemKey: s.slugifyKey(prompt) } : { prompt });
  }

  function changeType(type: QuestionnaireItemType) {
    // Options are kept, so switching between radio and checkboxes loses nothing.
    set({ type, config: defaultEditorConfig(type) });
  }

  function setOptions(options: EditorOption[]) {
    set({ options });
  }

  function changeOption(uid: string, patch: Partial<EditorOption>) {
    setOptions(
      item.options.map((option) => {
        if (option.uid !== uid) return option;
        const next = { ...option, ...patch };
        if (patch.label !== undefined && option.autoValue) next.value = s.slugifyKey(patch.label);
        if (patch.value !== undefined) next.autoValue = false;
        return next;
      }),
    );
  }

  function moveOption(optionIndex: number, direction: -1 | 1) {
    const target = optionIndex + direction;
    if (target < 0 || target >= item.options.length) return;
    const options = [...item.options];
    [options[optionIndex], options[target]] = [options[target]!, options[optionIndex]!];
    setOptions(options);
  }

  const isChoice = item.type === "single_choice" || item.type === "multi_choice";
  const isText = item.type === "short_text" || item.type === "free_text";

  return (
    <li className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span className="w-5 text-right text-sm text-slate-500 tabular-nums">{position}.</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{name}</p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <span className="font-mono">{item.itemKey || "(no key)"}</span>
            <span>{s.QUESTIONNAIRE_ITEM_TYPE_LABELS[item.type]}</span>
            {item.required && <span>Required</span>}
            {!item.id && <Badge size="sm">New</Badge>}
            {(!configCheck.ok || keyError || item.prompt.trim() === "") && (
              <Badge size="sm" variant="needs-review">
                Incomplete
              </Badge>
            )}
            {warnings.length > 0 && (
              <Badge size="sm" variant="warning">
                Check: identifying detail
              </Badge>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => onMove("up")} disabled={disabled || index === 0} aria-label={`Move item ${position} up`}>
            Move up
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMove("down")}
            disabled={disabled || index === count - 1}
            aria-label={`Move item ${position} down`}
          >
            Move down
          </Button>
          <Button size="sm" variant="secondary" onClick={onToggle} aria-expanded={open} aria-controls={panelId} aria-label={`${open ? "Close" : "Edit"} item ${position}`}>
            {open ? "Close" : "Edit"}
          </Button>
        </div>
      </div>

      {open && (
        <div id={panelId} className="space-y-4 border-t border-slate-100 px-4 py-4">
          {warnings.map((warning) => (
            <InlineMessage key={warning} variant="warning">
              {warning} Add such a field only when a separately justified recruitment or contact workflow requires it.
            </InlineMessage>
          ))}

          <FormField label="Prompt" help="The question as the participant reads it." required>
            <TextArea rows={2} value={item.prompt} onChange={(event) => changePrompt(event.target.value)} disabled={disabled} />
          </FormField>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormField
              label="Item key"
              help="Names the variable in exports. Keep it the same across versions so answers stay comparable."
              error={keyError}
              required
            >
              <TextInput
                mono
                value={item.itemKey}
                onChange={(event) => set({ itemKey: event.target.value, autoKey: false })}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
              />
            </FormField>
            <FormField label="Response type">
              <Select
                value={item.type}
                onChange={(event) => changeType(event.target.value as QuestionnaireItemType)}
                options={ITEM_TYPE_OPTIONS}
                disabled={disabled}
              />
            </FormField>
          </div>

          <FormField label="Help text" help="Optional. One short line under the prompt.">
            <TextInput value={item.helpText} onChange={(event) => set({ helpText: event.target.value })} disabled={disabled} />
          </FormField>

          <Checkbox
            label="Required"
            description="The participant must answer before continuing."
            checked={item.required}
            onChange={(event) => set({ required: event.target.checked })}
            disabled={disabled}
          />

          {item.type === "likert" && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <FormField label="Scale minimum">
                <TextInput
                  type="number"
                  mono
                  value={item.config.scaleMin ?? ""}
                  onChange={(event) => setConfig({ scaleMin: numberOrUndefined(event.target.value) })}
                  disabled={disabled}
                />
              </FormField>
              <FormField label="Scale maximum">
                <TextInput
                  type="number"
                  mono
                  value={item.config.scaleMax ?? ""}
                  onChange={(event) => setConfig({ scaleMax: numberOrUndefined(event.target.value) })}
                  disabled={disabled}
                />
              </FormField>
              <FormField label="Label of the lowest point" className="col-span-2 md:col-span-1">
                <TextInput
                  value={item.config.scaleMinLabel ?? ""}
                  onChange={(event) => setConfig({ scaleMinLabel: event.target.value })}
                  placeholder="Not at all"
                  disabled={disabled}
                />
              </FormField>
              <FormField label="Label of the highest point" className="col-span-2 md:col-span-1">
                <TextInput
                  value={item.config.scaleMaxLabel ?? ""}
                  onChange={(event) => setConfig({ scaleMaxLabel: event.target.value })}
                  placeholder="Completely"
                  disabled={disabled}
                />
              </FormField>
            </div>
          )}

          {isChoice && (
            <fieldset className="min-w-0">
              <legend className="mb-1 block text-sm font-medium text-slate-700">Options</legend>
              <p className="mb-2 text-xs text-slate-500">
                The label is shown to the participant. The value is stored and exported: keep it the same across versions.
              </p>
              {item.options.length === 0 ? (
                <p className="mb-2 text-sm text-slate-500">No options yet.</p>
              ) : (
                <ol className="mb-2 space-y-2">
                  {item.options.map((option, optionIndex) => (
                    <li key={option.uid} className="flex flex-wrap items-center gap-2">
                      <span className="w-5 text-right text-xs text-slate-500 tabular-nums">{optionIndex + 1}.</span>
                      <TextInput
                        aria-label={`Label of option ${optionIndex + 1}`}
                        placeholder="Label"
                        value={option.label}
                        onChange={(event) => changeOption(option.uid, { label: event.target.value })}
                        disabled={disabled}
                        className="min-w-40 flex-2"
                      />
                      <TextInput
                        aria-label={`Value of option ${optionIndex + 1}`}
                        placeholder="value"
                        mono
                        value={option.value}
                        onChange={(event) => changeOption(option.uid, { value: event.target.value })}
                        disabled={disabled}
                        spellCheck={false}
                        className="min-w-28 flex-1"
                      />
                      <Button size="sm" variant="ghost" onClick={() => moveOption(optionIndex, -1)} disabled={disabled || optionIndex === 0} aria-label={`Move option ${optionIndex + 1} up`}>
                        Up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => moveOption(optionIndex, 1)}
                        disabled={disabled || optionIndex === item.options.length - 1}
                        aria-label={`Move option ${optionIndex + 1} down`}
                      >
                        Down
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOptions(item.options.filter((other) => other.uid !== option.uid))}
                        disabled={disabled}
                        aria-label={`Remove option ${optionIndex + 1}`}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setOptions([...item.options, { uid: nextUid(), value: "", label: "", autoValue: true, translations: {} }])
                }
                disabled={disabled}
              >
                Add option
              </Button>
            </fieldset>
          )}

          {item.type === "integer" && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <FormField label="Minimum" help="Optional.">
                <TextInput
                  type="number"
                  mono
                  value={item.config.min ?? ""}
                  onChange={(event) => setConfig({ min: numberOrUndefined(event.target.value) })}
                  disabled={disabled}
                />
              </FormField>
              <FormField label="Maximum" help="Optional.">
                <TextInput
                  type="number"
                  mono
                  value={item.config.max ?? ""}
                  onChange={(event) => setConfig({ max: numberOrUndefined(event.target.value) })}
                  disabled={disabled}
                />
              </FormField>
            </div>
          )}

          {isText && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <FormField label="Maximum length" help="Characters.">
                <TextInput
                  type="number"
                  mono
                  value={item.config.maxLength ?? ""}
                  onChange={(event) => setConfig({ maxLength: numberOrUndefined(event.target.value) })}
                  disabled={disabled}
                />
              </FormField>
              <FormField label="Placeholder" help="Optional." className="col-span-2 md:col-span-3">
                <TextInput
                  value={item.config.placeholder ?? ""}
                  onChange={(event) => setConfig({ placeholder: event.target.value })}
                  disabled={disabled}
                />
              </FormField>
            </div>
          )}

          {item.type === "boolean" && <p className="text-sm text-slate-500">Shown as two buttons: Yes and No.</p>}

          {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => {
            const language = STUDY_TEXT_LOCALE_NAMES[locale] ?? locale;
            const texts = item.texts[locale] ?? emptyItemTexts();
            const setText = (field: keyof EditorItemTexts, value: string) =>
              set({ texts: { ...item.texts, [locale]: { ...texts, [field]: value } } });
            return (
              <fieldset key={locale} className="min-w-0 space-y-4 rounded-md border border-slate-200 p-4">
                <legend className="px-1 text-sm font-medium text-slate-700">
                  {language} texts ({locale})
                </legend>
                <p className="text-xs text-slate-500">
                  Shown to participants who choose this language. An empty field shows the English text.
                </p>
                <FormField label={`${language} prompt (${locale})`}>
                  <TextArea
                    lang={locale}
                    rows={2}
                    value={texts.prompt}
                    onChange={(event) => setText("prompt", event.target.value)}
                    disabled={disabled}
                  />
                </FormField>
                <FormField label={`${language} help text (${locale})`}>
                  <TextInput
                    lang={locale}
                    value={texts.helpText}
                    onChange={(event) => setText("helpText", event.target.value)}
                    disabled={disabled}
                  />
                </FormField>
                {item.type === "likert" && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <FormField label={`Lowest point label in ${language} (${locale})`}>
                      <TextInput
                        lang={locale}
                        value={texts.scaleMinLabel}
                        onChange={(event) => setText("scaleMinLabel", event.target.value)}
                        disabled={disabled}
                      />
                    </FormField>
                    <FormField label={`Highest point label in ${language} (${locale})`}>
                      <TextInput
                        lang={locale}
                        value={texts.scaleMaxLabel}
                        onChange={(event) => setText("scaleMaxLabel", event.target.value)}
                        disabled={disabled}
                      />
                    </FormField>
                  </div>
                )}
                {isChoice && item.options.length > 0 && (
                  <ol className="space-y-2">
                    {item.options.map((option, optionIndex) => (
                      <li key={option.uid} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-40 flex-1 text-sm text-slate-600">{option.label || `Option ${optionIndex + 1}`}</span>
                        <TextInput
                          lang={locale}
                          aria-label={`Option ${optionIndex + 1} in ${language} (${locale})`}
                          value={option.translations[locale] ?? ""}
                          onChange={(event) =>
                            changeOption(option.uid, {
                              translations: { ...option.translations, [locale]: event.target.value },
                            })
                          }
                          disabled={disabled}
                          className="min-w-40 flex-2"
                        />
                      </li>
                    ))}
                  </ol>
                )}
                {isText && (
                  <FormField label={`${language} placeholder (${locale})`} help="Optional.">
                    <TextInput
                      lang={locale}
                      value={texts.placeholder}
                      onChange={(event) => setText("placeholder", event.target.value)}
                      disabled={disabled}
                    />
                  </FormField>
                )}
              </fieldset>
            );
          })}

          {!configCheck.ok && (
            <InlineMessage variant="info" announce="none" title="Needed before publishing">
              {configCheck.errors.join(" ")}
            </InlineMessage>
          )}

          <div className="flex justify-end">
            <Button size="sm" variant="ghost" className="text-rose-700 hover:bg-rose-50 hover:text-rose-700" onClick={onRemove} disabled={disabled}>
              Remove item
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
