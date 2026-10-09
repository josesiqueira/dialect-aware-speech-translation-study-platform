// Request schemas of the Processing Runs area (spec 53, 60) and the payload
// schemas of the processing jobs (asr, translation, tts, derive_wav).
import { z } from "zod";
import { JOB_STATUSES, STUDY_MODES, TASK_TYPES, TRANSCRIPT_TYPES } from "../enums";

const uuid = z.uuid();

// A calendar date (2026-10-03) or a full ISO 8601 timestamp.
const dateOrDateTime = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) && !Number.isNaN(Date.parse(value)), {
    message: "Use a date such as 2026-10-03 or an ISO 8601 timestamp.",
  });

// Which utterances a batch processes. The defaults are the ones of spec 53 and
// 150: research mode, completed sessions, no flagged and no excluded data,
// verified transcripts only.
export const batchSelectionSchema = z.strictObject({
  // One data mode per batch. Research data is never mixed with demo or test data.
  mode: z.enum(STUDY_MODES).default("research"),
  completedSessionsOnly: z.boolean().default(true),
  verifiedTranscriptsOnly: z.boolean().default(true),
  excludeFlagged: z.boolean().default(true),
  excludeExcluded: z.boolean().default(true),
  protocolVersionIds: z.array(uuid).max(200).optional(),
  taskTypes: z.array(z.enum(TASK_TYPES)).optional(),
  dateFrom: dateOrDateTime.nullish(),
  dateTo: dateOrDateTime.nullish(),
  sessionIds: z.array(uuid).max(5000).optional(),
  utteranceIds: z.array(uuid).max(20000).optional(),
});
export type BatchSelectionInput = z.input<typeof batchSelectionSchema>;

const batchPlanShape = {
  // The single study is used when this is left out.
  studyId: uuid.optional(),
  selection: batchSelectionSchema.default(() => batchSelectionSchema.parse({})),
  // Transcript types to translate. The core matrix of spec 21 is A, B and C.
  transcriptTypes: z
    .array(z.enum(TRANSCRIPT_TYPES))
    .refine((types) => new Set(types).size === types.length, { message: "A transcript type is listed twice." })
    .default(["asr", "human_dialect", "normalized"]),
  runAsr: z.boolean().default(false),
  // Default: the active asr_default configuration.
  asrModelConfigId: uuid.optional(),
  // Default: the active translation_default and translation_preserve configurations.
  // An empty list means the batch runs no translation.
  translationModelConfigIds: z.array(uuid).max(20).optional(),
  // Default: the active tts_baseline configuration. An empty list means no synthesis.
  ttsModelConfigIds: z.array(uuid).max(20).optional(),
};

// POST /api/admin/processing/preview
export const previewBatchSchema = z.strictObject(batchPlanShape);
export type PreviewBatchInput = z.input<typeof previewBatchSchema>;

// POST /api/admin/processing
export const createBatchSchema = z.strictObject({
  name: z.string().trim().min(1, "A batch needs a name.").max(200),
  description: z.string().trim().max(2000).nullish(),
  ...batchPlanShape,
});
export type CreateBatchInput = z.input<typeof createBatchSchema>;

const pageNumber = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(50);

// GET /api/admin/processing
export const listBatchesQuerySchema = z.object({
  studyId: uuid.optional(),
  page: pageNumber,
  pageSize,
});
export type ListBatchesQuery = z.input<typeof listBatchesQuerySchema>;

// GET /api/admin/processing/:id/jobs
export const listBatchJobsQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  page: pageNumber,
  pageSize,
});
export type ListBatchJobsQuery = z.input<typeof listBatchJobsQuerySchema>;

export const batchIdParamsSchema = z.object({ id: uuid });

// ---------------------------------------------------------------------------
// Job payloads
// ---------------------------------------------------------------------------

// ASR of one utterance. Without `processingBatchId` and `modelConfigId` this is
// the automatic ASR after an upload: the handler uses the active asr_default
// configuration at run time.
export const asrJobPayloadSchema = z.looseObject({
  utteranceId: uuid,
  mediaAssetId: uuid.optional(),
  modelConfigId: uuid.optional(),
  processingBatchId: uuid.nullish(),
  trigger: z.string().max(100).optional(),
});
export type AsrJobPayload = z.infer<typeof asrJobPayloadSchema>;

// Translation of one transcript revision under one condition of a batch.
export const translationJobPayloadSchema = z.looseObject({
  sourceTranscriptRevisionId: uuid,
  // The utterance the revision must belong to. Checked before the model call.
  utteranceId: uuid.optional(),
  modelConfigId: uuid,
  processingBatchId: uuid,
  repetitionIndex: z.number().int().min(0).default(0),
});
export type TranslationJobPayload = z.infer<typeof translationJobPayloadSchema>;

// Synthesis of one stored translation with one TTS configuration of a batch.
export const ttsJobPayloadSchema = z.looseObject({
  translationId: uuid,
  modelConfigId: uuid,
  processingBatchId: uuid,
  repetitionIndex: z.number().int().min(0).default(0),
});
export type TtsJobPayload = z.infer<typeof ttsJobPayloadSchema>;

// Canonical WAV derivation of a compressed fallback recording.
export const deriveWavJobPayloadSchema = z.looseObject({
  mediaAssetId: uuid,
});
export type DeriveWavJobPayload = z.infer<typeof deriveWavJobPayloadSchema>;
