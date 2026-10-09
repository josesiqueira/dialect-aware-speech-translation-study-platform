// Questionnaires as research instruments (spec 11, 12, 55): the item and answer
// model, the ONE definition of answer validity, item configuration rules for the
// editor, and the request schemas and response types of the admin API
// (/api/admin/questionnaires). Shared by the browser and the server. This file
// must stay free of server-only imports.
//
// ANSWER VALUE SHAPE (stored in questionnaire_answers.value_json), per item type:
//
//   likert         number   an integer within config.scaleMin..config.scaleMax (default 1..5)
//   single_choice  string   the `value` of one of config.options
//   multi_choice   string[] distinct `value`s of config.options, at least one
//   free_text      string   trimmed, at most config.maxLength characters (default 5000)
//   short_text     string   trimmed, at most config.maxLength characters (default 500)
//   integer        number   an integer within config.min..config.max (each bound optional)
//   boolean        boolean  true (yes) or false (no)
//
// An unanswered optional item is absent from the answers. On input, undefined,
// null, "" (also only spaces) and [] all count as "not answered".
import { z } from "zod";
import { QUESTIONNAIRE_ITEM_TYPES, type PublicationStatus, type QuestionnaireItemType } from "../enums";
import {
  questionnaireItemTranslationsSchema,
  questionnaireTranslationsSchema,
  type QuestionnaireItemTranslations,
  type QuestionnaireTranslations,
} from "../localization";

// ---------------------------------------------------------------------------
// Item model
// ---------------------------------------------------------------------------

// Same shape as questionnaire_items.config_json (QuestionnaireItemConfig in @dialect/db).
export type QuestionnaireItemConfig = {
  options?: Array<{ value: string; label: string }>;
  scaleMin?: number;
  scaleMax?: number;
  scaleMinLabel?: string;
  scaleMaxLabel?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
};

// One item as the admin API returns it.
export type QuestionnaireItemView = {
  id: string;
  itemKey: string;
  type: QuestionnaireItemType;
  prompt: string;
  helpText: string | null;
  required: boolean;
  orderIndex: number;
  config: QuestionnaireItemConfig;
  // Prompt, help text and labels in other languages (packages/domain/src/localization.ts).
  translations?: QuestionnaireItemTranslations;
};

// The part of an item that rendering and answer validation need. Both
// QuestionnaireItemView and the participant API's QuestionnaireItemContent fit it.
export type QuestionnaireItemDefinition = Pick<
  QuestionnaireItemView,
  "itemKey" | "type" | "prompt" | "helpText" | "required" | "config"
>;

export type QuestionnaireAnswerValue = number | string | string[] | boolean;
export type QuestionnaireAnswerValues = Record<string, QuestionnaireAnswerValue>;

export const DEFAULT_LIKERT_MIN = 1;
export const DEFAULT_LIKERT_MAX = 5;
export const LIKERT_MIN_POINTS = 2;
export const LIKERT_MAX_POINTS = 11;
export const DEFAULT_SHORT_TEXT_MAX_LENGTH = 500;
export const DEFAULT_FREE_TEXT_MAX_LENGTH = 5000;

export function likertBounds(config: QuestionnaireItemConfig): { min: number; max: number } {
  return { min: config.scaleMin ?? DEFAULT_LIKERT_MIN, max: config.scaleMax ?? DEFAULT_LIKERT_MAX };
}

export function textMaxLength(type: "free_text" | "short_text", config: QuestionnaireItemConfig): number {
  if (typeof config.maxLength === "number" && config.maxLength > 0) return config.maxLength;
  return type === "short_text" ? DEFAULT_SHORT_TEXT_MAX_LENGTH : DEFAULT_FREE_TEXT_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

export const ANSWER_ERROR_CODES = [
  "required",
  "invalid_type",
  "not_integer",
  "out_of_range",
  "unknown_option",
  "too_long",
  "unknown_item",
] as const;
// The form maps these codes to localized text; `errors` holds the English text.
export type AnswerErrorCode = (typeof ANSWER_ERROR_CODES)[number];

export type AnswerValidationResult =
  | { ok: true; values: QuestionnaireAnswerValues }
  | { ok: false; errors: Record<string, string>; errorCodes: Record<string, AnswerErrorCode> };

export function isUnanswered(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

type ItemCheck = { value: QuestionnaireAnswerValue } | { code: AnswerErrorCode; message: string };

function integerInRange(value: unknown, min: number | undefined, max: number | undefined): ItemCheck {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { code: "invalid_type", message: "The answer must be a number." };
  }
  if (!Number.isInteger(value)) return { code: "not_integer", message: "The answer must be a whole number." };
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    const range =
      min !== undefined && max !== undefined
        ? `between ${min} and ${max}`
        : min !== undefined
          ? `${min} or more`
          : `${max} or less`;
    return { code: "out_of_range", message: `The answer must be ${range}.` };
  }
  return { value };
}

function checkAnswer(item: QuestionnaireItemDefinition, raw: unknown): ItemCheck {
  const config = item.config ?? {};
  switch (item.type) {
    case "likert": {
      const { min, max } = likertBounds(config);
      return integerInRange(raw, min, max);
    }
    case "integer":
      return integerInRange(raw, config.min, config.max);
    case "single_choice": {
      if (typeof raw !== "string") return { code: "invalid_type", message: "Choose one of the options." };
      const known = (config.options ?? []).some((option) => option.value === raw);
      return known ? { value: raw } : { code: "unknown_option", message: "The answer is not one of the options." };
    }
    case "multi_choice": {
      if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
        return { code: "invalid_type", message: "Choose from the options." };
      }
      const allowed = new Set((config.options ?? []).map((option) => option.value));
      const chosen = [...new Set(raw as string[])];
      if (chosen.some((entry) => !allowed.has(entry))) {
        return { code: "unknown_option", message: "An answer is not one of the options." };
      }
      // Stored in the order of the options, so equal selections compare equal.
      return { value: [...allowed].filter((entry) => chosen.includes(entry)) };
    }
    case "free_text":
    case "short_text": {
      if (typeof raw !== "string") return { code: "invalid_type", message: "The answer must be text." };
      const text = raw.trim();
      const limit = textMaxLength(item.type, config);
      if (text.length > limit) {
        return { code: "too_long", message: `The answer can be at most ${limit} characters.` };
      }
      return { value: text };
    }
    case "boolean":
      return typeof raw === "boolean"
        ? { value: raw }
        : { code: "invalid_type", message: "Choose yes or no." };
    default:
      return { code: "invalid_type", message: "This item type is not supported." };
  }
}

// The one definition of answer validity. `answers` is keyed by item key.
// - every required item must be answered;
// - every given answer must have the right type and be within the item's limits;
// - a key that is not an item of this questionnaire is rejected.
// On success `values` holds the normalized answers of the answered items only.
export function validateQuestionnaireAnswers(
  items: readonly QuestionnaireItemDefinition[],
  answers: Record<string, unknown>,
): AnswerValidationResult {
  const errors: Record<string, string> = {};
  const errorCodes: Record<string, AnswerErrorCode> = {};
  const values: QuestionnaireAnswerValues = {};
  const itemKeys = new Set(items.map((item) => item.itemKey));

  for (const key of Object.keys(answers)) {
    if (!itemKeys.has(key)) {
      errors[key] = "This is not an item of the questionnaire.";
      errorCodes[key] = "unknown_item";
    }
  }

  for (const item of items) {
    const raw = Object.prototype.hasOwnProperty.call(answers, item.itemKey) ? answers[item.itemKey] : undefined;
    if (isUnanswered(raw)) {
      if (item.required) {
        errors[item.itemKey] = "Please answer this question.";
        errorCodes[item.itemKey] = "required";
      }
      continue;
    }
    const check = checkAnswer(item, raw);
    if ("code" in check) {
      errors[item.itemKey] = check.message;
      errorCodes[item.itemKey] = check.code;
    } else {
      values[item.itemKey] = check.value;
    }
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors, errorCodes } : { ok: true, values };
}

// A stored answer as a display string for the admin (option labels resolved).
// Returns null for an unanswered item. `yes` and `no` label a boolean answer.
export function formatAnswerForDisplay(
  item: Pick<QuestionnaireItemDefinition, "type" | "config">,
  value: unknown,
  words: { yes: string; no: string } = { yes: "Yes", no: "No" },
): string | null {
  if (isUnanswered(value)) return null;
  const config = item.config ?? {};
  const labelOf = (optionValue: unknown): string => {
    const option = (config.options ?? []).find((candidate) => candidate.value === optionValue);
    return option ? option.label : `${String(optionValue)} (not an option of this version)`;
  };
  switch (item.type) {
    case "likert": {
      const { min, max } = likertBounds(config);
      return `${String(value)} (scale ${min} to ${max})`;
    }
    case "single_choice":
      return labelOf(value);
    case "multi_choice":
      return Array.isArray(value) ? value.map(labelOf).join("; ") : labelOf(value);
    case "boolean":
      return value === true ? words.yes : value === false ? words.no : String(value);
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

// ---------------------------------------------------------------------------
// Item configuration (editor and publish validation)
// ---------------------------------------------------------------------------

export const ITEM_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
export const ITEM_KEY_MAX_LENGTH = 64;
export const QUESTIONNAIRE_KEY_PATTERN = ITEM_KEY_PATTERN;

export const QUESTIONNAIRE_ITEM_TYPE_LABELS: Record<QuestionnaireItemType, string> = {
  likert: "Likert scale",
  single_choice: "Radio (one choice)",
  multi_choice: "Checkboxes (several choices)",
  free_text: "Free text",
  integer: "Number",
  short_text: "Short text",
  boolean: "Yes or no",
};

// Lower case letters, digits and underscores, starting with a letter, at most
// `maxLength` characters. "How natural did it feel?" gives "how_natural_did_it_feel".
export function slugifyKey(text: string, maxLength: number = 40): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9]+_*/, "");
  if (slug.length <= maxLength) return slug;
  // Cut at a word boundary where there is one, so the key does not end in half a word.
  const cut = slug.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf("_");
  return (boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, maxLength)).replace(/_+$/, "");
}

export type ItemConfigValidationResult =
  | { ok: true; config: QuestionnaireItemConfig }
  | { ok: false; errors: string[] };

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

// Checks the configuration of one item type and returns it reduced to the keys
// that the type uses. Publishing requires this to pass for every item.
export function validateItemConfig(type: QuestionnaireItemType, config: unknown): ItemConfigValidationResult {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: ["The item configuration must be an object."] };
  }
  const source = config as Record<string, unknown>;
  const errors: string[] = [];
  const result: QuestionnaireItemConfig = {};

  const optionalLabel = (key: "scaleMinLabel" | "scaleMaxLabel" | "placeholder", name: string) => {
    const value = source[key];
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string") errors.push(`${name} must be text.`);
    else if (value.length > 200) errors.push(`${name} can be at most 200 characters.`);
    else result[key] = value;
  };

  switch (type) {
    case "likert": {
      const { scaleMin, scaleMax } = source;
      if (!isInteger(scaleMin) || !isInteger(scaleMax)) {
        errors.push("Scale minimum and maximum must be whole numbers.");
      } else if (scaleMin >= scaleMax) {
        errors.push("Scale minimum must be lower than scale maximum.");
      } else if (scaleMax - scaleMin + 1 > LIKERT_MAX_POINTS) {
        errors.push(`A scale can have ${LIKERT_MIN_POINTS} to ${LIKERT_MAX_POINTS} points.`);
      } else {
        result.scaleMin = scaleMin;
        result.scaleMax = scaleMax;
      }
      optionalLabel("scaleMinLabel", "The label of the lowest point");
      optionalLabel("scaleMaxLabel", "The label of the highest point");
      break;
    }
    case "single_choice":
    case "multi_choice": {
      const options = source.options;
      if (!Array.isArray(options) || options.length < 2) {
        errors.push("Add at least two options.");
        break;
      }
      const seen = new Set<string>();
      const cleaned: Array<{ value: string; label: string }> = [];
      options.forEach((option, index) => {
        const entry = (option ?? {}) as { value?: unknown; label?: unknown };
        const value = typeof entry.value === "string" ? entry.value.trim() : "";
        const label = typeof entry.label === "string" ? entry.label.trim() : "";
        if (!value) errors.push(`Option ${index + 1} needs a value.`);
        else if (value.length > 100) errors.push(`The value of option ${index + 1} can be at most 100 characters.`);
        else if (seen.has(value)) errors.push(`The option value "${value}" is used more than once.`);
        if (!label) errors.push(`Option ${index + 1} needs a label.`);
        else if (label.length > 300) errors.push(`The label of option ${index + 1} can be at most 300 characters.`);
        seen.add(value);
        cleaned.push({ value, label });
      });
      result.options = cleaned;
      break;
    }
    case "integer": {
      for (const key of ["min", "max"] as const) {
        const value = source[key];
        if (value === undefined || value === null) continue;
        if (!isInteger(value)) errors.push(`The ${key === "min" ? "minimum" : "maximum"} must be a whole number.`);
        else result[key] = value;
      }
      if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
        errors.push("The minimum cannot be higher than the maximum.");
      }
      optionalLabel("placeholder", "The placeholder");
      break;
    }
    case "free_text":
    case "short_text": {
      const maxLength = source.maxLength;
      if (maxLength !== undefined && maxLength !== null) {
        if (!isInteger(maxLength) || maxLength < 1 || maxLength > 20000) {
          errors.push("The maximum length must be a whole number between 1 and 20000.");
        } else {
          result.maxLength = maxLength;
        }
      }
      optionalLabel("placeholder", "The placeholder");
      break;
    }
    case "boolean":
      break;
    default:
      errors.push("Unknown item type.");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: result };
}

// A sensible starting configuration when an item is added or its type changes.
export function defaultItemConfig(type: QuestionnaireItemType): QuestionnaireItemConfig {
  switch (type) {
    case "likert":
      return { scaleMin: DEFAULT_LIKERT_MIN, scaleMax: DEFAULT_LIKERT_MAX };
    case "single_choice":
    case "multi_choice":
      return { options: [] };
    case "short_text":
      return { maxLength: 200 };
    case "free_text":
      return { maxLength: 2000 };
    default:
      return {};
  }
}

// Everything that stops a version from being published (spec 55). Empty when it can be.
export function findPublishProblems(
  items: ReadonlyArray<Pick<QuestionnaireItemView, "itemKey" | "type" | "prompt" | "config">>,
): string[] {
  const problems: string[] = [];
  if (items.length === 0) problems.push("Add at least one item.");
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const name = item.itemKey ? `Item "${item.itemKey}"` : `Item ${index + 1}`;
    if (!ITEM_KEY_PATTERN.test(item.itemKey) || item.itemKey.length > ITEM_KEY_MAX_LENGTH) {
      problems.push(`${name}: the item key must start with a letter and use only a to z, 0 to 9 and underscores.`);
    }
    if (seen.has(item.itemKey)) problems.push(`${name}: the item key is used more than once.`);
    seen.add(item.itemKey);
    if (item.prompt.trim() === "") problems.push(`${name}: the prompt is empty.`);
    const config = validateItemConfig(item.type, item.config);
    if (!config.ok) for (const error of config.errors) problems.push(`${name}: ${error}`);
  });
  return problems;
}

// Spec 153: the study does not ask for a full name, home address, personal
// identity code or email. Returns a warning for each of those that an item key
// or prompt appears to ask for. The editor shows the warnings and does not block.
const IDENTIFYING_PATTERNS: Array<{ label: string; key: RegExp; prompt: RegExp }> = [
  {
    label: "a name",
    key: /(^|_)(name|fullname|firstname|lastname|surname|nimi|etunimi|sukunimi)(_|$)/,
    prompt: /\b(your|full|first|last|family|given) name\b|\bsurname\b|\b(etu|suku)?nimesi\b|\b(etu|suku)nimi\b|\bkoko nimi\b/i,
  },
  {
    label: "a home address",
    key: /(^|_)(address|street|postcode|zip|osoite|katuosoite|postinumero)(_|$)/,
    prompt: /\b(home|street|postal) address\b|\byour address\b|\bpostal code\b|\bpostcode\b|\b(katu|koti)?osoit|\bpostinumero/i,
  },
  {
    label: "a personal identity code",
    key: /(^|_)(ssn|hetu|henkilotunnus|identity_code|personal_id|national_id)(_|$)/,
    prompt: /\bidentity (code|number)\b|\bsocial security\b|\bpersonal id\b|\bnational id\b|\bhenkilötunnu|\bhetu\b/i,
  },
  {
    label: "an email address",
    key: /(^|_)(email|e_mail|mail|sahkoposti)(_|$)/,
    prompt: /\be-?mail\b|\bsähköposti/i,
  },
];

export function findIdentifyingFieldWarnings(item: { itemKey: string; prompt: string }): string[] {
  const key = item.itemKey.toLowerCase();
  return IDENTIFYING_PATTERNS.filter((pattern) => pattern.key.test(key) || pattern.prompt.test(item.prompt)).map(
    (pattern) =>
      `This item looks like it asks for ${pattern.label}. The study does not collect directly identifying details (spec 153).`,
  );
}

// ---------------------------------------------------------------------------
// Differences between two versions
// ---------------------------------------------------------------------------

export const ITEM_CHANGE_KINDS = ["wording", "help_text", "type", "required", "scale", "options", "limits", "order"] as const;
export type ItemChangeKind = (typeof ITEM_CHANGE_KINDS)[number];

export const ITEM_CHANGE_LABELS: Record<ItemChangeKind, string> = {
  wording: "wording",
  help_text: "help text",
  type: "response type",
  required: "required",
  scale: "scale",
  options: "options",
  limits: "limits",
  order: "position",
};

export type QuestionnaireVersionRef = { id: string; key: string; versionNumber: number; status: PublicationStatus };

type DiffItem = Pick<QuestionnaireItemView, "itemKey" | "type" | "prompt" | "helpText" | "required" | "orderIndex" | "config">;

export type QuestionnaireDiff = {
  // The version compared against (the older one). Null: there is no earlier version, every item counts as added.
  from: QuestionnaireVersionRef | null;
  to: QuestionnaireVersionRef;
  nameChanged: boolean;
  descriptionChanged: boolean;
  added: DiffItem[];
  removed: DiffItem[];
  // Items with the same item key in both versions that differ.
  changed: Array<{ itemKey: string; changes: ItemChangeKind[]; before: DiffItem; after: DiffItem }>;
  unchangedCount: number;
  identical: boolean;
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Items are matched by item key. Position is compared among the items that both versions have.
export function diffQuestionnaireItems(
  before: readonly DiffItem[],
  after: readonly DiffItem[],
): Pick<QuestionnaireDiff, "added" | "removed" | "changed" | "unchangedCount"> {
  const byOrder = (a: DiffItem, b: DiffItem) => a.orderIndex - b.orderIndex;
  const beforeSorted = [...before].sort(byOrder);
  const afterSorted = [...after].sort(byOrder);
  const beforeByKey = new Map(beforeSorted.map((item) => [item.itemKey, item]));
  const afterKeys = new Set(afterSorted.map((item) => item.itemKey));
  const sharedBefore = beforeSorted.filter((item) => afterKeys.has(item.itemKey)).map((item) => item.itemKey);
  const sharedAfter = afterSorted.filter((item) => beforeByKey.has(item.itemKey)).map((item) => item.itemKey);

  const changed: QuestionnaireDiff["changed"] = [];
  let unchangedCount = 0;
  for (const item of afterSorted) {
    const old = beforeByKey.get(item.itemKey);
    if (!old) continue;
    const changes: ItemChangeKind[] = [];
    if (old.prompt !== item.prompt) changes.push("wording");
    if ((old.helpText ?? "") !== (item.helpText ?? "")) changes.push("help_text");
    if (old.type !== item.type) changes.push("type");
    if (old.required !== item.required) changes.push("required");
    const a = old.config ?? {};
    const b = item.config ?? {};
    if (
      !same(a.scaleMin, b.scaleMin) ||
      !same(a.scaleMax, b.scaleMax) ||
      !same(a.scaleMinLabel, b.scaleMinLabel) ||
      !same(a.scaleMaxLabel, b.scaleMaxLabel)
    ) {
      changes.push("scale");
    }
    if (!same(a.options, b.options)) changes.push("options");
    if (!same(a.min, b.min) || !same(a.max, b.max) || !same(a.maxLength, b.maxLength)) changes.push("limits");
    if (sharedBefore.indexOf(item.itemKey) !== sharedAfter.indexOf(item.itemKey)) changes.push("order");
    if (changes.length > 0) changed.push({ itemKey: item.itemKey, changes, before: old, after: item });
    else unchangedCount += 1;
  }

  return {
    added: afterSorted.filter((item) => !beforeByKey.has(item.itemKey)),
    removed: beforeSorted.filter((item) => !afterKeys.has(item.itemKey)),
    changed,
    unchangedCount,
  };
}

// ---------------------------------------------------------------------------
// Admin API: request schemas
// ---------------------------------------------------------------------------

const keySchema = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what} is required`)
    .max(ITEM_KEY_MAX_LENGTH)
    .regex(ITEM_KEY_PATTERN, `${what} must start with a letter and use only a to z, 0 to 9 and underscores`);

export const questionnaireKeySchema = keySchema("The questionnaire key");
export const itemKeySchema = keySchema("The item key");

const nameSchema = z.string().trim().min(1, "The name is required").max(200);
const descriptionSchema = z.string().trim().max(2000).nullable();

// The shape of a draft item's configuration. A draft may be incomplete (for example
// a choice item without options yet); validateItemConfig decides at publish time.
export const itemConfigSchema = z
  .object({
    options: z
      .array(z.object({ value: z.string().max(100), label: z.string().max(300) }).strict())
      .max(100)
      .optional(),
    scaleMin: z.number().int().min(-1000).max(1000).optional(),
    scaleMax: z.number().int().min(-1000).max(1000).optional(),
    scaleMinLabel: z.string().max(200).optional(),
    scaleMaxLabel: z.string().max(200).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    maxLength: z.number().int().min(1).max(20000).optional(),
    placeholder: z.string().max(200).optional(),
  })
  .strict();

const itemTypeSchema = z.enum(QUESTIONNAIRE_ITEM_TYPES);
const promptSchema = z.string().trim().max(2000);
const helpTextSchema = z.string().trim().max(1000).nullable();

// POST /api/admin/questionnaires
export const createDraftBodySchema = z
  .object({ key: questionnaireKeySchema, name: nameSchema, description: descriptionSchema.optional() })
  .strict();
export type CreateDraftBody = z.infer<typeof createDraftBodySchema>;

// One item in a whole-draft save. With `id`: an existing item of the draft.
// Without: a new item. The array order becomes the item order.
export const draftItemSchema = z
  .object({
    id: z.uuid().optional(),
    itemKey: itemKeySchema,
    type: itemTypeSchema,
    prompt: promptSchema,
    helpText: helpTextSchema.optional(),
    required: z.boolean(),
    config: itemConfigSchema,
    translations: questionnaireItemTranslationsSchema.optional(),
  })
  .strict();
export type DraftItemInput = z.infer<typeof draftItemSchema>;

// PUT /api/admin/questionnaires/:id
// `items`, when present, replaces the whole item list of the draft in one transaction.
export const updateDraftBodySchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    // Name and description in other languages.
    translations: questionnaireTranslationsSchema.optional(),
    items: z.array(draftItemSchema).max(200).optional(),
  })
  .strict();
export type UpdateDraftBody = z.infer<typeof updateDraftBodySchema>;

// POST /api/admin/questionnaires/:id/items
// Without `itemKey` the key is derived from the prompt and made unique.
export const addItemBodySchema = z
  .object({
    itemKey: itemKeySchema.optional(),
    type: itemTypeSchema,
    prompt: promptSchema,
    helpText: helpTextSchema.optional(),
    required: z.boolean().optional(),
    config: itemConfigSchema.optional(),
    translations: questionnaireItemTranslationsSchema.optional(),
  })
  .strict();
export type AddItemBody = z.infer<typeof addItemBodySchema>;

// PUT /api/admin/questionnaires/:id/items/:itemId
export const updateItemBodySchema = z
  .object({
    itemKey: itemKeySchema.optional(),
    type: itemTypeSchema.optional(),
    prompt: promptSchema.optional(),
    helpText: helpTextSchema.optional(),
    required: z.boolean().optional(),
    config: itemConfigSchema.optional(),
    translations: questionnaireItemTranslationsSchema.optional(),
  })
  .strict();
export type UpdateItemBody = z.infer<typeof updateItemBodySchema>;

// POST /api/admin/questionnaires/:id/items/:itemId/move
export const moveItemBodySchema = z.object({ direction: z.enum(["up", "down"]) }).strict();
export type MoveItemBody = z.infer<typeof moveItemBodySchema>;

export const versionParamSchema = z.object({ id: z.uuid() });
export const itemParamSchema = z.object({ id: z.uuid(), itemId: z.uuid() });
// GET /api/admin/questionnaires/:id/diff?against=<version id>
export const diffQuerySchema = z.object({ against: z.uuid().optional() });

// ---------------------------------------------------------------------------
// Admin API: response types (timestamps are ISO 8601 strings)
// ---------------------------------------------------------------------------

export type QuestionnaireVersionSummary = {
  id: string;
  studyId: string;
  key: string;
  versionNumber: number;
  status: PublicationStatus;
  name: string;
  description: string | null;
  translations?: QuestionnaireTranslations;
  itemCount: number;
  createdAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
  createdByLabel: string | null;
};

// One questionnaire: every version of one key, newest first.
export type QuestionnaireGroup = { key: string; versions: QuestionnaireVersionSummary[] };

export type QuestionnaireProtocolUse = {
  protocolVersionId: string;
  versionNumber: number;
  name: string;
  status: PublicationStatus;
  // True when this protocol is the one given to new sessions.
  isCurrent: boolean;
  role: "background" | "post_recording" | "post_review";
};

export type QuestionnaireVersionDetail = QuestionnaireVersionSummary & {
  items: QuestionnaireItemView[];
  // Protocol versions that select this questionnaire version.
  usedByProtocols: QuestionnaireProtocolUse[];
};

// GET /api/admin/questionnaires
export type ListQuestionnairesResponse = { studyId: string; adminTimezone: string; questionnaires: QuestionnaireGroup[] };
// Every route that returns one version.
export type QuestionnaireVersionResponse = { version: QuestionnaireVersionDetail };
// GET /api/admin/questionnaires/:id/diff
export type QuestionnaireDiffResponse = { diff: QuestionnaireDiff };

// One submitted questionnaire of a session, for the admin session detail page.
export type SessionQuestionnaireResponse = {
  responseId: string;
  submittedAt: string;
  questionnaire: { versionId: string; key: string; versionNumber: number; name: string };
  // Every item of that version in order, answered or not.
  answers: Array<{
    itemId: string;
    itemKey: string;
    type: QuestionnaireItemType;
    prompt: string;
    orderIndex: number;
    // The stored value_json, or null when the item was not answered.
    value: unknown;
    // The answer as text with option labels resolved, or null when not answered.
    display: string | null;
  }>;
};
