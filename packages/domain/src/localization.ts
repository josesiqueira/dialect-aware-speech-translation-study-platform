// Study texts in more than one language.
//
// The text columns of a protocol version, task, follow-up, consent version,
// questionnaire version and questionnaire item hold the text in the base
// language. The column translations_json of the same row holds the same texts
// in other languages, keyed by locale:
//
//   { "fi": { "participantPrompt": "Kuvittele ...", "title": "Kutsu" } }
//
// A participant sees the text of the locale of the session. A field without a
// translation (missing or empty) falls back to the base column, so a study
// written in one language keeps working unchanged.
//
// translations_json is part of the version. Once a version leaves draft it is
// immutable like every other content column (database triggers).
import { z } from "zod";

// Locale codes as used in the study settings (participantLocales), for example "fi".
export const translationLocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Use a language code such as fi or en.");

const MAX_TRANSLATED_TEXT = 20_000;
const MAX_TRANSLATION_LOCALES = 10;
const text = z.string().max(MAX_TRANSLATED_TEXT);
const labelMap = z.record(z.string().max(200), z.string().max(2000));

function perLocale<T extends z.ZodType>(fields: T) {
  return z
    .record(translationLocaleSchema, fields)
    .refine((value) => Object.keys(value).length <= MAX_TRANSLATION_LOCALES, {
      message: `At most ${MAX_TRANSLATION_LOCALES} languages.`,
    });
}

// protocol_versions.translations_json
export const protocolTranslationsSchema = perLocale(
  z
    .object({
      welcomeContent: text,
      informationContent: text,
      instructionContent: text,
      debriefContent: text,
    })
    .partial()
    .strict(),
);
export type ProtocolTranslations = z.output<typeof protocolTranslationsSchema>;

// protocol_tasks.translations_json
export const taskTranslationsSchema = perLocale(
  z
    .object({
      title: text,
      participantPrompt: text,
      contextText: text,
      instructionsText: text,
      topicSuggestions: z.array(z.string().max(500)).max(20),
    })
    .partial()
    .strict(),
);
export type TaskTranslations = z.output<typeof taskTranslationsSchema>;

// protocol_task_followups.translations_json
export const followupTranslationsSchema = perLocale(z.object({ promptText: text }).partial().strict());
export type FollowupTranslations = z.output<typeof followupTranslationsSchema>;

// consent_versions.translations_json. Items are keyed by the consent item id.
export const consentTranslationsSchema = perLocale(
  z
    .object({
      title: text,
      informationText: text,
      contactText: text,
      items: labelMap,
    })
    .partial()
    .strict(),
);
export type ConsentTranslations = z.output<typeof consentTranslationsSchema>;

// questionnaire_versions.translations_json
export const questionnaireTranslationsSchema = perLocale(
  z.object({ name: text, description: text }).partial().strict(),
);
export type QuestionnaireTranslations = z.output<typeof questionnaireTranslationsSchema>;

// questionnaire_items.translations_json. Options are keyed by the option value,
// which stays the same in every language (answers store the value).
export const questionnaireItemTranslationsSchema = perLocale(
  z
    .object({
      prompt: text,
      helpText: text,
      placeholder: text,
      scaleMinLabel: text,
      scaleMaxLabel: text,
      options: labelMap,
    })
    .partial()
    .strict(),
);
export type QuestionnaireItemTranslations = z.output<typeof questionnaireItemTranslationsSchema>;

// Any of the shapes above, as stored.
export type ContentTranslations = Record<string, Record<string, unknown>>;

function localeEntry(translations: unknown, locale: string | null | undefined): Record<string, unknown> | null {
  if (!locale || !translations || typeof translations !== "object") return null;
  const entry = (translations as Record<string, unknown>)[locale];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// The text of one field in the given locale, or the base text when there is no
// translation for it.
export function localizeText<T extends string | null>(
  base: T,
  translations: unknown,
  locale: string | null | undefined,
  field: string,
): T | string {
  const value = localeEntry(translations, locale)?.[field];
  return nonEmpty(value) ? value : base;
}

// A text of a keyed list (consent items by id, options by value).
export function localizeKeyed(
  base: string,
  translations: unknown,
  locale: string | null | undefined,
  field: string,
  key: string,
): string {
  const map = localeEntry(translations, locale)?.[field];
  if (!map || typeof map !== "object" || Array.isArray(map)) return base;
  const value = (map as Record<string, unknown>)[key];
  return nonEmpty(value) ? value : base;
}

// A list of texts (topic suggestions): the translated list when it has entries.
export function localizeList(
  base: string[],
  translations: unknown,
  locale: string | null | undefined,
  field: string,
): string[] {
  const value = localeEntry(translations, locale)?.[field];
  if (!Array.isArray(value)) return base;
  const list = value.filter(nonEmpty);
  return list.length > 0 ? list : base;
}

// Every translated text of a translations value, for checks that scan all texts
// (for example the example-text check).
export function translatedTexts(translations: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  if (translations && typeof translations === "object") Object.values(translations).forEach(visit);
  return out;
}

// Removes empty strings, empty maps and empty locales, so that what is stored
// only holds real translations.
export function compactTranslations<T extends ContentTranslations>(translations: T | null | undefined): T {
  const out: ContentTranslations = {};
  for (const [locale, fields] of Object.entries(translations ?? {})) {
    if (!fields || typeof fields !== "object") continue;
    const kept: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === "string") {
        if (value.trim() !== "") kept[field] = value;
      } else if (Array.isArray(value)) {
        const list = value.filter(nonEmpty);
        if (list.length > 0) kept[field] = list;
      } else if (value && typeof value === "object") {
        const map = Object.fromEntries(Object.entries(value).filter(([, v]) => nonEmpty(v)));
        if (Object.keys(map).length > 0) kept[field] = map;
      }
    }
    if (Object.keys(kept).length > 0) out[locale] = kept;
  }
  return out as T;
}

// The base text columns are written in English. The editors offer one
// translation field per locale below, next to each participant-facing text.
// The participant interface has dictionaries for exactly these languages
// (apps/web/lib/i18n).
export const STUDY_TEXT_BASE_LOCALE = "en";
export const STUDY_TEXT_TRANSLATION_LOCALES = ["fi"] as const;
export const STUDY_TEXT_LOCALE_NAMES: Record<string, string> = { en: "English", fi: "Finnish" };

// The stored translation of one field, or "" when there is none (for editors).
export function translationOf(translations: unknown, locale: string, field: string): string {
  const value = localeEntry(translations, locale)?.[field];
  return typeof value === "string" ? value : "";
}

// A keyed translation (consent item, option label), or "" when there is none.
export function keyedTranslationOf(translations: unknown, locale: string, field: string, key: string): string {
  const map = localeEntry(translations, locale)?.[field];
  if (!map || typeof map !== "object" || Array.isArray(map)) return "";
  const value = (map as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

// A copy of the translations with one field of one locale set (or removed when
// the value is empty). The other fields and locales are kept.
export function withTranslation<T extends ContentTranslations>(
  translations: T | null | undefined,
  locale: string,
  field: string,
  value: unknown,
): T {
  const next: ContentTranslations = { ...(translations ?? {}) };
  next[locale] = { ...(next[locale] ?? {}), [field]: value };
  return compactTranslations(next) as T;
}
