// Request schemas and response types for AI prompt versions and model
// configurations (spec 50, 51, 60, 142). Shared by the browser, the route
// handlers and the services in @dialect/research (aiConfig).
import { z } from "zod";
import { CONFIG_STATUSES, PROCESSING_STAGES, type ConfigStatus, type ProcessingStage } from "../enums";

// Keys of prompts and model configs, and condition keys: lower case letters,
// digits and underscores, starting with a letter. For example translation_default.
export const AI_KEY_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;
const KEY_MESSAGE =
  "Use 2 to 63 characters: lower case letters, digits and underscores, starting with a letter.";

export const PROMPT_TEXT_MAX_LENGTH = 20000;
export const NOTES_MAX_LENGTH = 4000;
export const NAME_MAX_LENGTH = 200;

export const aiKey = z.string().regex(AI_KEY_PATTERN, KEY_MESSAGE);
const stage = z.enum(PROCESSING_STAGES);
const status = z.enum(CONFIG_STATUSES);
const uuid = z.uuid();
const name = z.string().trim().min(1, "A name is required.").max(NAME_MAX_LENGTH);
const notes = z.string().max(NOTES_MAX_LENGTH).nullable();
const conditionKey = aiKey.nullable();
const promptText = z.string().max(PROMPT_TEXT_MAX_LENGTH);

// A plain JSON object. Which keys are accepted depends on the provider and the
// stage, and is checked by the service.
export const modelParameters = z.record(z.string(), z.unknown());

// ---------- Prompt versions ----------

export const listPromptsQuery = z.object({
  studyId: uuid.optional(),
  key: aiKey.optional(),
  stage: stage.optional(),
});

export const createPromptBody = z.object({
  // Optional in the API: the only study is used when it is not given.
  studyId: uuid.optional(),
  key: aiKey,
  stage,
  conditionKey: conditionKey.optional(),
  name,
  promptText,
  notes: notes.optional(),
});

export const updatePromptBody = z
  .object({
    conditionKey: conditionKey.optional(),
    name: name.optional(),
    promptText: promptText.optional(),
    notes: notes.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Give at least one field to change.",
  });

// ---------- Model configs ----------

export const listConfigsQuery = listPromptsQuery;

export const createConfigBody = z.object({
  studyId: uuid.optional(),
  key: aiKey,
  stage,
  conditionKey: conditionKey.optional(),
  name: z.string().trim().max(NAME_MAX_LENGTH).nullable().optional(),
  provider: z.string().trim().min(1, "A provider is required.").max(100),
  // Free text entered by the researcher. Never chosen by the application.
  modelId: z.string().trim().min(1, "A model identifier is required.").max(200),
  parameters: modelParameters,
  promptVersionId: uuid.nullable().optional(),
  notes: notes.optional(),
});

export const updateConfigBody = z
  .object({
    conditionKey: conditionKey.optional(),
    name: z.string().trim().max(NAME_MAX_LENGTH).nullable().optional(),
    provider: z.string().trim().min(1, "A provider is required.").max(100).optional(),
    modelId: z.string().trim().min(1, "A model identifier is required.").max(200).optional(),
    parameters: modelParameters.optional(),
    promptVersionId: uuid.nullable().optional(),
    notes: notes.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Give at least one field to change.",
  });

export const cloneConfigBody = z.object({
  // Link the new draft to the active version of the prompt the source config uses.
  useActivePrompt: z.boolean().optional(),
});

// ---------- Shared by both kinds ----------

export const idParams = z.object({ id: uuid });
export const compareQuery = z.object({ a: uuid, b: uuid });

export type ListPromptsQuery = z.infer<typeof listPromptsQuery>;
export type CreatePromptBody = z.infer<typeof createPromptBody>;
export type UpdatePromptBody = z.infer<typeof updatePromptBody>;
export type ListConfigsQuery = z.infer<typeof listConfigsQuery>;
export type CreateConfigBody = z.infer<typeof createConfigBody>;
export type UpdateConfigBody = z.infer<typeof updateConfigBody>;
export type CloneConfigBody = z.infer<typeof cloneConfigBody>;

// ---------- Response types (JSON: timestamps are ISO 8601 strings) ----------

export type PromptVersionDto = {
  id: string;
  studyId: string;
  key: string;
  stage: ProcessingStage;
  conditionKey: string | null;
  versionNumber: number;
  status: ConfigStatus;
  name: string;
  promptText: string;
  notes: string | null;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  createdByLabel: string | null;
};

// The prompt version a model config pins.
export type LinkedPromptDto = {
  id: string;
  key: string;
  versionNumber: number;
  status: ConfigStatus;
  name: string;
};

export type ModelConfigDto = {
  id: string;
  studyId: string;
  key: string;
  stage: ProcessingStage;
  conditionKey: string | null;
  versionNumber: number;
  status: ConfigStatus;
  name: string | null;
  provider: string;
  modelId: string;
  parametersJson: Record<string, unknown>;
  promptVersionId: string | null;
  notes: string | null;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  createdByLabel: string | null;
  prompt: LinkedPromptDto | null;
  // The active version of the linked prompt's key, or null when that key has
  // no active version (or the config has no prompt).
  activePrompt: LinkedPromptDto | null;
};

export type ProviderStatusDto = {
  name: string;
  // True when the server has what the provider needs (for openai: an API key).
  // The key itself is never sent to the browser.
  configured: boolean;
  // True for the built-in mock provider, which never calls a real model.
  isMock: boolean;
};

export type DiffPartDto = { type: "added" | "removed" | "unchanged"; value: string };

export type FieldChangeDto = { field: string; before: string | null; after: string | null; changed: boolean };

export type VersionSummaryDto = { id: string; key: string; versionNumber: number; status: ConfigStatus };

export type PromptDiffDto = {
  a: VersionSummaryDto;
  b: VersionSummaryDto;
  identical: boolean;
  fields: FieldChangeDto[];
  // Line level difference of the prompt text, from a to b.
  lines: DiffPartDto[];
  // Word level difference of the prompt text, from a to b.
  words: DiffPartDto[];
};

export type ConfigDiffDto = {
  a: VersionSummaryDto;
  b: VersionSummaryDto;
  identical: boolean;
  fields: FieldChangeDto[];
  // Line level difference of the parameters, printed as sorted JSON.
  parameterLines: DiffPartDto[];
  // Present when the two configs pin different prompt versions.
  promptText: { lines: DiffPartDto[] } | null;
};

export type ListPromptsResponse = { prompts: PromptVersionDto[] };
export type ListConfigsResponse = { configs: ModelConfigDto[]; providers: ProviderStatusDto[] };

export { status as configStatus, stage as processingStage };
