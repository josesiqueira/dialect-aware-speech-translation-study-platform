// Request schemas and shared constants for research data export (spec 56, 57,
// 60, 89). Shared by the browser, the route handlers and the services in
// @dialect/research (exports).
import { z } from "zod";
import {
  EXPORT_JOB_STATUSES,
  EXPORT_PRIVACY_TIERS,
  STUDY_MODES,
  TASK_TYPES,
  type ExportJobStatus,
  type ExportPrivacyTier,
  type StudyMode,
  type TaskType,
} from "../enums";

// Archive exports. Each one runs as a background export job.
export const EXPORT_TYPES = ["dataset_package", "source_audio_zip", "tts_audio_zip", "session_package"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

// Flat tables, one CSV file each (spec 56).
export const EXPORT_CSV_TABLES = [
  "sessions",
  "task_presentations",
  "utterances",
  "transcripts",
  "translations",
  "syntheses",
  "questionnaire_responses",
  // The output review at the end of a session (docs/RESEARCH-DESIGN.md, section 3).
  "english_checks",
  "output_reviews",
  "output_review_items",
  "annotations",
  "consents",
  "media_assets",
  "flags",
  "researcher_notes",
] as const;
export type ExportCsvTable = (typeof EXPORT_CSV_TABLES)[number];

// Nested provenance, exported as JSON or JSON Lines.
export const EXPORT_JSON_SETS = ["model_runs", "audit_log", "processing_batches"] as const;
export type ExportJsonSet = (typeof EXPORT_JSON_SETS)[number];

export const EXPORT_TABLE_NAMES = [...EXPORT_CSV_TABLES, ...EXPORT_JSON_SETS] as const;
export type ExportTableName = (typeof EXPORT_TABLE_NAMES)[number];

export const EXPORT_FORMATS = ["csv", "json", "jsonl"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// The privacy tier that has no approved policy yet (spec 89). The service rejects it.
export const UNSUPPORTED_PRIVACY_TIER: ExportPrivacyTier = "public_release";
export const DEFAULT_PRIVACY_TIER: ExportPrivacyTier = "internal_full";

// The background questionnaire item whose answer the region filter compares
// with. Another item key can be given per request with `regionItemKey`.
export const DEFAULT_REGION_ITEM_KEY = "region_grew_up";

const uuid = z.uuid();
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// A calendar day (YYYY-MM-DD, read as a UTC day) or a full ISO 8601 timestamp.
const dateValue = z
  .string()
  .trim()
  .refine((value) => DATE_PATTERN.test(value) || !Number.isNaN(Date.parse(value)), {
    message: "Use a date (YYYY-MM-DD) or an ISO 8601 timestamp.",
  });

const filterShape = {
  dateFrom: dateValue.nullable().optional(),
  dateTo: dateValue.nullable().optional(),
  protocolVersionIds: z.array(uuid).max(200).optional(),
  modes: z.array(z.enum(STUDY_MODES)).min(1).optional(),
  includeTest: z.boolean().optional(),
  includeDemo: z.boolean().optional(),
  completedOnly: z.boolean().optional(),
  taskTypes: z.array(z.enum(TASK_TYPES)).optional(),
  verifiedTranscriptsOnly: z.boolean().optional(),
  includeFlagged: z.boolean().optional(),
  includeExcluded: z.boolean().optional(),
  includeWithdrawn: z.boolean().optional(),
  processingBatchIds: z.array(uuid).max(200).optional(),
  participantRegion: z.string().trim().max(200).nullable().optional(),
  regionItemKey: z.string().trim().min(1).max(100).optional(),
  includeResearcherNotes: z.boolean().optional(),
  sessionIds: z.array(uuid).max(1000).optional(),
};

// Filters of an export (spec 57). Every field is optional. The defaults are
// applied by the service, in one place (resolveExportFilters in @dialect/research).
export const exportFilters = z.object(filterShape).strict();
export type ExportFiltersInput = z.infer<typeof exportFilters>;

export const exportOptions = z
  .object({
    // Audio is exported only in the internal_full tier.
    includeSourceAudio: z.boolean().optional(),
    includeGeneratedAudio: z.boolean().optional(),
    // collaboration_restricted leaves free-text answers out unless this is true.
    includeFreeTextAnswers: z.boolean().optional(),
  })
  .strict();
export type ExportOptionsInput = z.infer<typeof exportOptions>;

const privacyTier = z.enum(EXPORT_PRIVACY_TIERS);

export const createExportJobBody = z
  .object({
    exportType: z.enum(EXPORT_TYPES),
    privacyTier: privacyTier.optional(),
    filters: exportFilters.optional(),
    options: exportOptions.optional(),
  })
  .strict();
export type CreateExportJobBody = z.infer<typeof createExportJobBody>;

// ---------- Query string forms ----------
// In a query string a boolean is "true" or "false" and a list is a repeated
// parameter or one comma-separated value.

const queryBoolean = z.preprocess((value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());

function queryList<T extends z.ZodType>(item: T) {
  return z.preprocess((value) => {
    if (value === undefined) return undefined;
    const parts = Array.isArray(value) ? value : [value];
    return parts
      .flatMap((part) => (typeof part === "string" ? part.split(",") : [part]))
      .map((part) => (typeof part === "string" ? part.trim() : part))
      .filter((part) => part !== "");
  }, z.array(item));
}

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const queryFilterShape = {
  dateFrom: z.preprocess(emptyToUndefined, dateValue.optional()),
  dateTo: z.preprocess(emptyToUndefined, dateValue.optional()),
  protocolVersionIds: queryList(uuid).optional(),
  modes: queryList(z.enum(STUDY_MODES)).optional(),
  includeTest: queryBoolean.optional(),
  includeDemo: queryBoolean.optional(),
  completedOnly: queryBoolean.optional(),
  taskTypes: queryList(z.enum(TASK_TYPES)).optional(),
  verifiedTranscriptsOnly: queryBoolean.optional(),
  includeFlagged: queryBoolean.optional(),
  includeExcluded: queryBoolean.optional(),
  includeWithdrawn: queryBoolean.optional(),
  processingBatchIds: queryList(uuid).optional(),
  participantRegion: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
  regionItemKey: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(100).optional()),
  includeResearcherNotes: queryBoolean.optional(),
  sessionIds: queryList(uuid).optional(),
};

const queryCommonShape = {
  ...queryFilterShape,
  privacyTier: privacyTier.optional(),
  includeFreeTextAnswers: queryBoolean.optional(),
};

// GET /api/admin/export/preview
export const exportPreviewQuery = z.object(queryCommonShape).strict();

// GET /api/admin/export?table=...&format=...
export const tableExportQuery = z
  .object({
    table: z.enum(EXPORT_TABLE_NAMES),
    format: z.enum(EXPORT_FORMATS).optional(),
    ...queryCommonShape,
  })
  .strict();

// GET /api/admin/export/dictionary
export const dictionaryQuery = z
  .object({
    privacyTier: privacyTier.optional(),
    includeResearcherNotes: queryBoolean.optional(),
    // "markdown" returns the file itself, "json" returns the structured entries.
    format: z.enum(["markdown", "json"]).optional(),
  })
  .strict();

// GET /api/admin/export/jobs
export const listExportJobsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const exportJobParams = z.object({ id: uuid });

// Splits a parsed query into the filters and the rest.
const FILTER_KEYS = Object.keys(filterShape) as Array<keyof ExportFiltersInput>;
export function filtersFromQuery(query: Partial<Record<keyof ExportFiltersInput, unknown>>): ExportFiltersInput {
  const filters: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    if (query[key] !== undefined) filters[key] = query[key];
  }
  return filters as ExportFiltersInput;
}

// Builds the query string for the filters, for the browser.
export function filtersToSearchParams(
  filters: ExportFiltersInput,
  extra: Record<string, string | boolean | undefined> = {},
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

// ---------- Response types ----------

export type ExportPreview = {
  sessions: number;
  utterances: number;
  sourceAudioFiles: number;
  sourceAudioDurationMs: number;
  sourceAudioBytes: number;
  generatedAudioFiles: number;
  generatedAudioDurationMs: number;
  generatedAudioBytes: number;
  transcriptRevisions: number;
  translations: number;
  syntheses: number;
  // The filters after the defaults were applied.
  modes: StudyMode[];
  completedOnly: boolean;
};

export type ExportJobView = {
  id: string;
  exportType: string;
  privacyTier: string;
  status: ExportJobStatus;
  filters: ExportFiltersInput;
  fileName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  summary: Record<string, unknown> | null;
  errorMessage: string | null;
  createdByLabel: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ExportJobListResponse = {
  items: ExportJobView[];
  total: number;
  workerHealthy: boolean;
};

export type DataDictionaryField = {
  // Export table name, or the kind of configuration document.
  table: string;
  file: string;
  name: string;
  type: string;
  description: string;
  allowedValues: string[] | null;
  missing: string;
  source: string;
  identifying: boolean;
  identifyingNote: string | null;
  // Tiers in which the field is exported.
  tiers: ExportPrivacyTier[];
  // True when the field is exported only with includeResearcherNotes.
  researcherNote: boolean;
  // The three markers below apply to fields of the configuration documents
  // (protocol_versions/, prompts/, model_configs/), whose `name` is the path of
  // the key inside the JSON document. They are false for table columns.
  // An object or a list of objects: its keys are listed as separate fields.
  container: boolean;
  // The key can be absent from a stored JSON value.
  optional: boolean;
  // A JSON value whose keys are not fixed. The keys below it are not listed.
  openJson: boolean;
};

export { EXPORT_JOB_STATUSES, EXPORT_PRIVACY_TIERS, STUDY_MODES, TASK_TYPES };
export type { ExportJobStatus, ExportPrivacyTier, StudyMode, TaskType };
