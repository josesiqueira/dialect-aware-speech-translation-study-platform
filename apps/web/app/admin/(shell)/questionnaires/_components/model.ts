// The editor's working copy of a draft, and its conversion to the save request.
import {
  compactTranslations,
  keyedTranslationOf,
  questionnaireSchemas as s,
  STUDY_TEXT_TRANSLATION_LOCALES,
  translationOf,
  type PublicationStatus,
  type QuestionnaireItemTranslations,
  type QuestionnaireItemType,
  type QuestionnaireTranslations,
} from "@dialect/domain";
import type { BadgeVariant } from "@/components/ui";

export type EditorOption = {
  uid: string;
  value: string;
  label: string;
  // True for an option added in this editing session whose value still follows its label.
  autoValue: boolean;
  // The label per translation locale.
  translations: Record<string, string>;
};

// The translated texts of one item in one locale.
export type EditorItemTexts = {
  prompt: string;
  helpText: string;
  scaleMinLabel: string;
  scaleMaxLabel: string;
  placeholder: string;
};

const ITEM_TEXT_FIELDS = ["prompt", "helpText", "scaleMinLabel", "scaleMaxLabel", "placeholder"] as const;

export function emptyItemTexts(): EditorItemTexts {
  return { prompt: "", helpText: "", scaleMinLabel: "", scaleMaxLabel: "", placeholder: "" };
}

export type EditorItem = {
  uid: string;
  // The stored item id. Undefined for an item that has not been saved yet.
  id?: string;
  itemKey: string;
  // True while the key of a new item still follows its prompt.
  autoKey: boolean;
  type: QuestionnaireItemType;
  prompt: string;
  helpText: string;
  required: boolean;
  config: Omit<s.QuestionnaireItemConfig, "options">;
  options: EditorOption[];
  // Per translation locale.
  texts: Record<string, EditorItemTexts>;
};

export type EditorDraft = {
  name: string;
  description: string;
  // Name and description per translation locale.
  translations: Record<string, { name: string; description: string }>;
  items: EditorItem[];
};

const perLocale = <T>(make: (locale: string) => T): Record<string, T> =>
  Object.fromEntries(STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => [locale, make(locale)]));

let uidCounter = 0;
export const nextUid = (): string => `e${(uidCounter += 1)}`;

export function toEditorDraft(version: s.QuestionnaireVersionDetail): EditorDraft {
  return {
    name: version.name,
    description: version.description ?? "",
    translations: perLocale((locale) => ({
      name: translationOf(version.translations, locale, "name"),
      description: translationOf(version.translations, locale, "description"),
    })),
    items: version.items.map((item) => {
      const { options, ...config } = item.config ?? {};
      const stored = item.translations;
      return {
        uid: nextUid(),
        id: item.id,
        itemKey: item.itemKey,
        autoKey: false,
        type: item.type,
        prompt: item.prompt,
        helpText: item.helpText ?? "",
        required: item.required,
        config,
        options: (options ?? []).map((option) => ({
          uid: nextUid(),
          ...option,
          autoValue: false,
          translations: perLocale((locale) => keyedTranslationOf(stored, locale, "options", option.value)),
        })),
        texts: perLocale((locale) => {
          const texts = emptyItemTexts();
          for (const field of ITEM_TEXT_FIELDS) texts[field] = translationOf(stored, locale, field);
          return texts;
        }),
      };
    }),
  };
}

// The starting configuration of a type, without the options (the editor keeps those separately).
export function defaultEditorConfig(type: QuestionnaireItemType): EditorItem["config"] {
  const config = { ...s.defaultItemConfig(type) };
  delete config.options;
  return config;
}

export function newEditorItem(type: QuestionnaireItemType = "likert"): EditorItem {
  const config = defaultEditorConfig(type);
  return {
    uid: nextUid(),
    itemKey: "",
    autoKey: true,
    type,
    prompt: "",
    helpText: "",
    required: false,
    config,
    options: [],
    texts: perLocale(() => emptyItemTexts()),
  };
}

// The translations of one item as stored: texts and option labels per locale.
export function itemTranslations(item: EditorItem): QuestionnaireItemTranslations {
  const out: QuestionnaireItemTranslations = {};
  for (const locale of STUDY_TEXT_TRANSLATION_LOCALES) {
    const texts = item.texts[locale] ?? emptyItemTexts();
    const options = isChoice(item.type)
      ? Object.fromEntries(
          item.options.map((option) => [option.value.trim(), (option.translations[locale] ?? "").trim()]),
        )
      : {};
    out[locale] = {
      prompt: texts.prompt.trim(),
      helpText: texts.helpText.trim(),
      ...(item.type === "likert"
        ? { scaleMinLabel: texts.scaleMinLabel.trim(), scaleMaxLabel: texts.scaleMaxLabel.trim() }
        : {}),
      ...(item.type === "short_text" || item.type === "free_text" ? { placeholder: texts.placeholder.trim() } : {}),
      options,
    };
  }
  return compactTranslations(out);
}

function isChoice(type: QuestionnaireItemType): boolean {
  return type === "single_choice" || type === "multi_choice";
}

// The configuration as it is stored: only defined values, options for choice items only.
export function itemConfig(item: EditorItem): s.QuestionnaireItemConfig {
  const config: s.QuestionnaireItemConfig = {};
  for (const [key, value] of Object.entries(item.config)) {
    if (value !== undefined && value !== "" && !(typeof value === "number" && Number.isNaN(value))) {
      (config as Record<string, unknown>)[key] = value;
    }
  }
  if (isChoice(item.type)) {
    config.options = item.options.map((option) => ({ value: option.value.trim(), label: option.label.trim() }));
  }
  return config;
}

// The item as the form and the validators read it.
export function toItemView(item: EditorItem, index: number): s.QuestionnaireItemView {
  return {
    id: item.id ?? item.uid,
    itemKey: item.itemKey.trim(),
    type: item.type,
    prompt: item.prompt.trim(),
    helpText: item.helpText.trim() || null,
    required: item.required,
    orderIndex: index,
    config: itemConfig(item),
  };
}

export function toSaveBody(draft: EditorDraft): s.UpdateDraftBody {
  const translations: QuestionnaireTranslations = compactTranslations(
    Object.fromEntries(
      Object.entries(draft.translations).map(([locale, texts]) => [
        locale,
        { name: texts.name.trim(), description: texts.description.trim() },
      ]),
    ),
  );
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    translations,
    items: draft.items.map((item, index) => {
      const view = toItemView(item, index);
      return {
        ...(item.id ? { id: item.id } : {}),
        itemKey: view.itemKey,
        type: view.type,
        prompt: view.prompt,
        helpText: view.helpText,
        required: view.required,
        config: view.config,
        translations: itemTranslations(item),
      };
    }),
  };
}

// Problems that stop a save, per item uid ("" holds the problems of the name).
export function findSaveProblems(draft: EditorDraft): Record<string, string> {
  const problems: Record<string, string> = {};
  if (draft.name.trim() === "") problems[""] = "Enter a name.";
  const seen = new Set<string>();
  for (const item of draft.items) {
    const key = item.itemKey.trim();
    if (key === "") problems[item.uid] = "Enter an item key.";
    else if (!s.ITEM_KEY_PATTERN.test(key) || key.length > s.ITEM_KEY_MAX_LENGTH) {
      problems[item.uid] = "Start with a letter and use only a to z, 0 to 9 and underscores (at most 64 characters).";
    } else if (seen.has(key)) problems[item.uid] = "Another item of this version already uses this key.";
    seen.add(key);
  }
  return problems;
}

export const STATUS_LABELS: Record<PublicationStatus, string> = {
  draft: "Draft",
  published: "Published",
  retired: "Retired",
};

export const STATUS_BADGES: Record<PublicationStatus, BadgeVariant> = {
  draft: "needs-review",
  published: "status",
  retired: "neutral",
};

export const ITEM_TYPE_OPTIONS = (Object.keys(s.QUESTIONNAIRE_ITEM_TYPE_LABELS) as QuestionnaireItemType[]).map(
  (type) => ({ value: type, label: s.QUESTIONNAIRE_ITEM_TYPE_LABELS[type] }),
);
