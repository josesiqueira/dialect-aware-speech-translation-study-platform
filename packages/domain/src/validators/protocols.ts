// Request schemas and shared types for protocol versions, their tasks and
// follow-ups, and consent versions (spec 6.2, 7, 8, 47 to 49, 60, 76, 141).
// Shared by the browser and the server.
//
// A draft may be incomplete: empty texts are accepted here. Completeness is
// checked when the draft is published (validateProtocolForPublish).
import { z } from "zod";
import {
  consentTranslationsSchema,
  followupTranslationsSchema,
  protocolTranslationsSchema,
  taskTranslationsSchema,
} from "../localization";
import { ORDER_MODES, TASK_TYPES } from "../enums";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_CONTENT_LENGTH = 50000;
export const MAX_PROMPT_LENGTH = 5000;
export const MAX_NOTES_LENGTH = 5000;
export const MAX_KEY_LENGTH = 64;
export const MAX_DURATION_SECONDS = 3600;
export const MAX_BLOCKS = 20;
export const MAX_TOPIC_SUGGESTIONS = 20;
export const MAX_CONSENT_ITEMS = 30;

// Markers of example study text. They are defined here once and used by the
// development seed (packages/db/src/seed/content.ts) and by the check that
// keeps research sessions closed while example text is still in the current
// protocol (validateProtocolForPublish, currentProtocolHasExampleText).
//
// EXAMPLE_TEXT_NOTICE is the sentence a participant may see at the top of a
// seeded study text. EXAMPLE_TEXT_PREFIX is its wording without the brackets,
// which also starts the bracketed notes inside seeded texts.
// ADMIN_PLACEHOLDER_MARKER is used only in fields a participant never sees.
export const EXAMPLE_TEXT_PREFIX = "Example text, to be replaced by the research team";
export const EXAMPLE_TEXT_NOTICE = `[${EXAMPLE_TEXT_PREFIX}.]`;
// The same notice in the Finnish translations of the seed.
export const EXAMPLE_TEXT_PREFIX_FI = "Esimerkkiteksti, jonka tutkimusryhmä korvaa";
export const EXAMPLE_TEXT_NOTICE_FI = `[${EXAMPLE_TEXT_PREFIX_FI}.]`;
export const ADMIN_PLACEHOLDER_MARKER = "[PLACEHOLDER";
export const EXAMPLE_TEXT_MARKERS = [EXAMPLE_TEXT_PREFIX, EXAMPLE_TEXT_PREFIX_FI, ADMIN_PLACEHOLDER_MARKER] as const;

// True when the text still carries one of the example markers.
export function containsExampleText(text: string | null | undefined): boolean {
  if (!text) return false;
  return EXAMPLE_TEXT_MARKERS.some((marker) => text.includes(marker));
}

// Title shown to participants when the study has no participant-facing title.
// It names nothing about the research focus (spec 6.1, 6.4).
export const NEUTRAL_PARTICIPANT_TITLE = "Research study";
const NEUTRAL_PARTICIPANT_TITLES: Record<string, string> = { en: NEUTRAL_PARTICIPANT_TITLE, fi: "Tutkimus" };
export function neutralParticipantTitle(locale?: string | null): string {
  return (locale ? NEUTRAL_PARTICIPANT_TITLES[locale] : undefined) ?? NEUTRAL_PARTICIPANT_TITLE;
}
export const MAX_PARTICIPANT_TITLE_LENGTH = 120;

export const FOLLOWUP_MODES = ["always", "optional"] as const;
export type FollowupMode = (typeof FOLLOWUP_MODES)[number];

export const MOVE_DIRECTIONS = ["up", "down"] as const;
export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

// The questionnaire keys a protocol can select a version of.
export const BACKGROUND_QUESTIONNAIRE_KEY = "background";
export const POST_QUESTIONNAIRE_KEY = "post_recording";
// The questionnaire after the output review (docs/RESEARCH-DESIGN.md, section 3).
export const POST_REVIEW_QUESTIONNAIRE_KEY = "post_review";

// Stable keys (task_key, followup_key, block key, consent item id): lowercase
// letters, digits and underscores, starting with a letter or digit.
const KEY_PATTERN = /^[a-z0-9][a-z0-9_]*$/;

export const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_KEY_LENGTH)
  .regex(KEY_PATTERN, "Use lowercase letters, digits and underscores only.");

// Turns free text into a key: "Controlled 1: Invitation" gives "controlled_1_invitation".
export function slugifyKey(text: string, fallback = "item"): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH)
    .replace(/_+$/g, "");
  return slug || fallback;
}

const idSchema = z.uuid();
// The updated_at value the editor loaded, for optimistic concurrency.
const expectedUpdatedAtSchema = z.iso.datetime({ offset: true });
const content = z.string().max(MAX_CONTENT_LENGTH);
const optionalText = (max: number) => z.string().max(max).nullable();
const durationSeconds = z.number().int().min(0).max(MAX_DURATION_SECONDS).nullable();

export const idParamsSchema = z.object({ id: idSchema });
export const taskParamsSchema = z.object({ id: idSchema, taskId: idSchema });
export const followupParamsSchema = z.object({ id: idSchema, taskId: idSchema, followupId: idSchema });

// ---------------------------------------------------------------------------
// Protocol versions
// ---------------------------------------------------------------------------

export const orderConfigSchema = z
  .object({
    blocks: z
      .array(
        z.object({
          key: keySchema,
          title: z.string().trim().max(MAX_NAME_LENGTH).optional(),
          orderMode: z.enum(ORDER_MODES),
        }),
      )
      .max(MAX_BLOCKS),
  })
  .refine((value) => new Set(value.blocks.map((block) => block.key)).size === value.blocks.length, {
    message: "Block keys must be unique.",
    path: ["blocks"],
  });

export const createProtocolDraftSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
});
export type CreateProtocolDraftBody = z.output<typeof createProtocolDraftSchema>;

export const protocolDraftChangesSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    description: optionalText(MAX_DESCRIPTION_LENGTH),
    welcomeContent: content,
    informationContent: content,
    instructionContent: content,
    debriefContent: content,
    // The texts above in other languages (packages/domain/src/localization.ts).
    translations: protocolTranslationsSchema,
    consentVersionId: idSchema.nullable(),
    backgroundQuestionnaireVersionId: idSchema.nullable(),
    postQuestionnaireVersionId: idSchema.nullable(),
    postReviewQuestionnaireVersionId: idSchema.nullable(),
    orderConfig: orderConfigSchema,
  })
  .partial();
export type ProtocolDraftChanges = z.output<typeof protocolDraftChangesSchema>;

export const updateProtocolDraftSchema = protocolDraftChangesSchema.extend({
  expectedUpdatedAt: expectedUpdatedAtSchema,
});
export type UpdateProtocolDraftBody = z.output<typeof updateProtocolDraftSchema>;

// Every change to a draft (tasks and follow-ups included) may carry the
// updated_at the editor loaded. When present it is checked.
export const concurrencySchema = z.object({ expectedUpdatedAt: expectedUpdatedAtSchema.optional() });
export const concurrencyQuerySchema = concurrencySchema;

export const diffQuerySchema = z.object({ against: idSchema.optional() });

// ---------------------------------------------------------------------------
// Tasks and follow-ups
// ---------------------------------------------------------------------------

const taskFieldsSchema = z.object({
  internalName: optionalText(MAX_NAME_LENGTH),
  title: z.string().max(MAX_NAME_LENGTH),
  taskType: z.enum(TASK_TYPES),
  participantPrompt: z.string().max(MAX_PROMPT_LENGTH),
  contextText: optionalText(MAX_PROMPT_LENGTH),
  instructionsText: optionalText(MAX_PROMPT_LENGTH),
  blockKey: keySchema,
  enabled: z.boolean(),
  minDurationSeconds: durationSeconds,
  suggestedDurationSeconds: durationSeconds,
  maxDurationSeconds: z.number().int().min(1).max(MAX_DURATION_SECONDS).nullable(),
  privacyReminder: z.boolean(),
  researcherNotes: optionalText(MAX_NOTES_LENGTH),
  topicSuggestions: z.array(z.string().trim().min(1).max(500)).max(MAX_TOPIC_SUGGESTIONS),
  followupMode: z.enum(FOLLOWUP_MODES),
  // False keeps the task at its own position inside a shuffled block.
  randomizationEligible: z.boolean(),
  // Title, prompt, context, instructions and topic suggestions in other languages.
  translations: taskTranslationsSchema,
});

// Only the type and the block are needed to add a task. The key is derived from
// the internal name or the title when it is not given.
export const taskInputSchema = taskFieldsSchema
  .partial()
  .required({ taskType: true, blockKey: true })
  .extend({ taskKey: keySchema.optional() });
export type TaskInput = z.output<typeof taskInputSchema>;

// The task key is not part of the changes: it identifies the task across versions.
export const taskChangesSchema = taskFieldsSchema.partial();
export type TaskChanges = z.output<typeof taskChangesSchema>;

export const addTaskSchema = taskInputSchema.extend(concurrencySchema.shape);
export const updateTaskSchema = taskChangesSchema.extend(concurrencySchema.shape);
export const setTaskEnabledSchema = concurrencySchema.extend({ enabled: z.boolean() });
export const moveSchema = concurrencySchema.extend({ direction: z.enum(MOVE_DIRECTIONS) });

const followupFieldsSchema = z.object({
  promptText: z.string().max(MAX_PROMPT_LENGTH),
  isRequired: z.boolean(),
  enabled: z.boolean(),
  translations: followupTranslationsSchema,
});
export const followupInputSchema = followupFieldsSchema
  .partial()
  .required({ promptText: true })
  .extend({ followupKey: keySchema.optional() });
export type FollowupInput = z.output<typeof followupInputSchema>;
export const followupChangesSchema = followupFieldsSchema.partial();
export type FollowupChanges = z.output<typeof followupChangesSchema>;

export const addFollowupSchema = followupInputSchema.extend(concurrencySchema.shape);
export const updateFollowupSchema = followupChangesSchema.extend(concurrencySchema.shape);

// ---------------------------------------------------------------------------
// Consent versions
// ---------------------------------------------------------------------------

export const consentItemSchema = z.object({
  // Stable id. It is kept when a consent version is cloned and is never reused
  // for a different meaning.
  id: keySchema,
  text: z.string().max(MAX_PROMPT_LENGTH),
  required: z.boolean(),
  // Free scope label, for example participation or voice_recording (spec 6.2).
  scope: z.string().trim().max(MAX_KEY_LENGTH).optional(),
});
export type ConsentItemInput = z.output<typeof consentItemSchema>;

const consentFieldsSchema = z.object({
  title: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  informationText: content,
  privacyNoticeUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullable(),
  contactText: optionalText(MAX_PROMPT_LENGTH),
  items: z
    .array(consentItemSchema)
    .max(MAX_CONSENT_ITEMS)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
      message: "Consent item ids must be unique.",
    }),
  // Title, information, contact and item texts in other languages (items by id).
  translations: consentTranslationsSchema,
});

export const createConsentDraftSchema = consentFieldsSchema.partial().required({ title: true });
export type CreateConsentDraftBody = z.output<typeof createConsentDraftSchema>;
export const updateConsentDraftSchema = consentFieldsSchema.partial();
export type ConsentDraftChanges = z.output<typeof updateConsentDraftSchema>;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

// The JSON form of a service result: dates arrive in the browser as ISO strings.
// Usage: apiFetch<Serialized<ProtocolDetail>>(...) with a type-only import of
// the service type.
export type Serialized<T> = T extends Date
  ? string
  : T extends Array<infer Item>
    ? Array<Serialized<Item>>
    : T extends object
      ? { [Key in keyof T]: Serialized<T[Key]> }
      : T;

export type ProblemSeverity = "error" | "warning";

// One finding of the publish check (spec 49). An error blocks publishing, a
// warning is a methodological note that the researcher decides about.
export type ProtocolProblem = {
  severity: ProblemSeverity;
  code: string;
  message: string;
  // The protocol field or task the problem belongs to, when there is one.
  field?: string;
  taskId?: string;
  taskKey?: string;
  // Section of the specification behind a methodological warning, for example "6.1".
  specRef?: string;
};
