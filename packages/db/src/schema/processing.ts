// Transcripts, AI configuration, processing batches, model runs, derived outputs
// and the job queue (spec 37.11 to 37.18, 27 to 30).
// Model outputs never mutate. Human corrections create new revisions.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  batchStatusEnum,
  configStatusEnum,
  createdAt,
  exportJobStatusEnum,
  jobStatusEnum,
  modelRunStageEnum,
  modelRunStatusEnum,
  outputStatusEnum,
  pk,
  processingStageEnum,
  reviewStatusEnum,
  revisionAuthorTypeEnum,
  studyModeEnum,
  transcriptTypeEnum,
  ts,
  updatedAt,
} from "./_shared";
import { mediaAssets, utterances } from "./collection";
import { studies } from "./protocol";
import type {
  BatchConfigurationSnapshot,
  ExportFilters,
  JobPayload,
  ModelParameters,
  ModelRunInputManifest,
} from "../json-types";

// One logical transcript per utterance and type. The text lives in revisions.
export const transcripts = pgTable(
  "transcripts",
  {
    id: pk(),
    utteranceId: uuid("utterance_id")
      .notNull()
      .references(() => utterances.id, { onDelete: "restrict" }),
    type: transcriptTypeEnum("type").notNull(),
    status: reviewStatusEnum("status").notNull().default("not_started"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("transcripts_utterance_type_uq").on(t.utteranceId, t.type)],
);

export const transcriptRevisions = pgTable(
  "transcript_revisions",
  {
    id: pk(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "restrict" }),
    revisionNumber: integer("revision_number").notNull(),
    // Exact text. For ASR this is the raw model output, never cleaned up.
    text: text("text").notNull(),
    // Segment and timestamp data when the ASR provider returns it (spec 148).
    segmentsJson: jsonb("segments_json").$type<unknown>(),
    sourceModelRunId: uuid("source_model_run_id").references((): AnyPgColumn => modelRuns.id, {
      onDelete: "restrict",
    }),
    // The revision this text was derived from, for example B when writing C.
    derivedFromRevisionId: uuid("derived_from_revision_id").references(
      (): AnyPgColumn => transcriptRevisions.id,
      { onDelete: "restrict" },
    ),
    createdByType: revisionAuthorTypeEnum("created_by_type").notNull(),
    createdByLabel: text("created_by_label"),
    changeReason: text("change_reason"),
    transcriptionConventionVersion: text("transcription_convention_version"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: createdAt(),
    verifiedAt: ts("verified_at"),
    verifiedByLabel: text("verified_by_label"),
    verificationNotes: text("verification_notes"),
  },
  (t) => [
    uniqueIndex("transcript_revisions_transcript_number_uq").on(t.transcriptId, t.revisionNumber),
    // Only one current revision per transcript.
    uniqueIndex("transcript_revisions_one_current_uq").on(t.transcriptId).where(sql`${t.isCurrent}`),
    check("transcript_revisions_revision_number_ck", sql`${t.revisionNumber} >= 1`),
  ],
);

export const aiPromptVersions = pgTable(
  "ai_prompt_versions",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    // For example translation_default, translation_preserve, asr_context, tts_baseline.
    key: text("key").notNull(),
    stage: processingStageEnum("stage").notNull(),
    conditionKey: text("condition_key"),
    versionNumber: integer("version_number").notNull(),
    status: configStatusEnum("status").notNull().default("draft"),
    name: text("name").notNull(),
    promptText: text("prompt_text").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    activatedAt: ts("activated_at"),
    retiredAt: ts("retired_at"),
    createdByLabel: text("created_by_label"),
  },
  (t) => [
    uniqueIndex("ai_prompt_versions_study_key_version_uq").on(t.studyId, t.key, t.versionNumber),
    // At most one active version per key.
    uniqueIndex("ai_prompt_versions_one_active_uq").on(t.studyId, t.key).where(sql`${t.status} = 'active'`),
    check("ai_prompt_versions_version_number_ck", sql`${t.versionNumber} >= 1`),
  ],
);

export const modelConfigs = pgTable(
  "model_configs",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    // For example asr_default, translation_default, translation_preserve, tts_baseline.
    key: text("key").notNull(),
    stage: processingStageEnum("stage").notNull(),
    conditionKey: text("condition_key"),
    versionNumber: integer("version_number").notNull(),
    status: configStatusEnum("status").notNull().default("draft"),
    name: text("name"),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    // Voice, output format, language hint, temperature and so on. Only parameters
    // the provider really accepts are stored (spec 103).
    parametersJson: jsonb("parameters_json").$type<ModelParameters>().notNull().default({}),
    promptVersionId: uuid("prompt_version_id").references(() => aiPromptVersions.id, {
      onDelete: "restrict",
    }),
    notes: text("notes"),
    createdAt: createdAt(),
    activatedAt: ts("activated_at"),
    retiredAt: ts("retired_at"),
    createdByLabel: text("created_by_label"),
  },
  (t) => [
    uniqueIndex("model_configs_study_key_version_uq").on(t.studyId, t.key, t.versionNumber),
    uniqueIndex("model_configs_one_active_uq").on(t.studyId, t.key).where(sql`${t.status} = 'active'`),
    check("model_configs_version_number_ck", sql`${t.versionNumber} >= 1`),
  ],
);

export const processingBatches = pgTable(
  "processing_batches",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    status: batchStatusEnum("status").notNull().default("draft"),
    // research for corpus batches, demo or test for Demo Mode and pipeline tests.
    dataMode: studyModeEnum("data_mode").notNull().default("research"),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    cancelledAt: ts("cancelled_at"),
    // Frozen copy of the selection filters, prompts and model configs. Immutable
    // once the batch has started (spec 54).
    configurationSnapshotJson: jsonb("configuration_snapshot_json")
      .$type<BatchConfigurationSnapshot>()
      .notNull(),
    createdByLabel: text("created_by_label"),
  },
  (t) => [uniqueIndex("processing_batches_study_name_uq").on(t.studyId, t.name)],
);

// One row per AI operation, including failed ones (spec 27).
export const modelRuns = pgTable(
  "model_runs",
  {
    id: pk(),
    stage: modelRunStageEnum("stage").notNull(),
    provider: text("provider").notNull(),
    requestedModel: text("requested_model").notNull(),
    returnedModel: text("returned_model"),
    modelConfigId: uuid("model_config_id").references(() => modelConfigs.id, {
      onDelete: "restrict",
    }),
    promptVersionId: uuid("prompt_version_id").references(() => aiPromptVersions.id, {
      onDelete: "restrict",
    }),
    processingBatchId: uuid("processing_batch_id").references(() => processingBatches.id, {
      onDelete: "restrict",
    }),
    conditionKey: text("condition_key"),
    sourceEntityType: text("source_entity_type").notNull(),
    sourceEntityId: uuid("source_entity_id").notNull(),
    parametersJson: jsonb("parameters_json").$type<ModelParameters>().notNull().default({}),
    // Inputs identified by ids and hashes, plus the final effective instruction.
    inputManifestJson: jsonb("input_manifest_json").$type<ModelRunInputManifest>().notNull(),
    providerRequestId: text("provider_request_id"),
    status: modelRunStatusEnum("status").notNull().default("running"),
    // 1 for the first attempt. A retry of a failed run creates a new row.
    attemptNumber: integer("attempt_number").notNull().default(1),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    latencyMs: integer("latency_ms"),
    usageJson: jsonb("usage_json").$type<unknown>(),
    // Always an estimate, labelled as such in the UI (spec 102).
    estimatedCost: numeric("estimated_cost", { precision: 12, scale: 6 }),
    responseMetadataJson: jsonb("response_metadata_json").$type<unknown>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    appVersion: text("app_version").notNull(),
    gitCommitSha: text("git_commit_sha"),
    // Same logical work submitted twice must not create a second successful run (spec 30).
    idempotencyKey: text("idempotency_key").notNull().unique(),
  },
  (t) => [
    index("model_runs_stage_status_idx").on(t.stage, t.status),
    index("model_runs_batch_idx").on(t.processingBatchId),
    index("model_runs_source_idx").on(t.sourceEntityType, t.sourceEntityId),
    check("model_runs_attempt_number_ck", sql`${t.attemptNumber} >= 1`),
    check("model_runs_latency_ms_ck", sql`${t.latencyMs} IS NULL OR ${t.latencyMs} >= 0`),
  ],
);

export const translations = pgTable(
  "translations",
  {
    id: pk(),
    sourceTranscriptRevisionId: uuid("source_transcript_revision_id")
      .notNull()
      .references(() => transcriptRevisions.id, { onDelete: "restrict" }),
    conditionKey: text("condition_key").notNull(),
    processingBatchId: uuid("processing_batch_id")
      .notNull()
      .references(() => processingBatches.id, { onDelete: "restrict" }),
    modelRunId: uuid("model_run_id")
      .notNull()
      .references(() => modelRuns.id, { onDelete: "restrict" }),
    // Raw model output. Never normalized or cleaned by another model (spec 146, 147).
    translatedText: text("translated_text").notNull(),
    targetLanguage: text("target_language").notNull().default("en"),
    // Allows intentional repeated generations inside one batch (spec 103).
    repetitionIndex: integer("repetition_index").notNull().default(0),
    status: outputStatusEnum("status").notNull().default("generated"),
    createdAt: createdAt(),
  },
  (t) => [
    index("translations_source_revision_idx").on(t.sourceTranscriptRevisionId),
    index("translations_batch_idx").on(t.processingBatchId),
    uniqueIndex("translations_identity_uq").on(
      t.sourceTranscriptRevisionId,
      t.conditionKey,
      t.processingBatchId,
      t.repetitionIndex,
    ),
    uniqueIndex("translations_model_run_uq").on(t.modelRunId),
    check("translations_repetition_index_ck", sql`${t.repetitionIndex} >= 0`),
  ],
);

// A translation can have several syntheses (spec 23).
export const syntheses = pgTable(
  "syntheses",
  {
    id: pk(),
    translationId: uuid("translation_id").references(() => translations.id, {
      onDelete: "restrict",
    }),
    // Snapshot of the exact text that was synthesized.
    sourceText: text("source_text").notNull(),
    conditionKey: text("condition_key").notNull(),
    processingBatchId: uuid("processing_batch_id")
      .notNull()
      .references(() => processingBatches.id, { onDelete: "restrict" }),
    modelRunId: uuid("model_run_id")
      .notNull()
      .references(() => modelRuns.id, { onDelete: "restrict" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    voiceKey: text("voice_key").notNull(),
    repetitionIndex: integer("repetition_index").notNull().default(0),
    status: outputStatusEnum("status").notNull().default("generated"),
    createdAt: createdAt(),
  },
  (t) => [
    index("syntheses_translation_idx").on(t.translationId),
    index("syntheses_batch_idx").on(t.processingBatchId),
    uniqueIndex("syntheses_identity_uq").on(
      t.translationId,
      t.conditionKey,
      t.processingBatchId,
      t.repetitionIndex,
    ),
    uniqueIndex("syntheses_model_run_uq").on(t.modelRunId),
    // Speeds up the foreign key check when a media row is removed.
    index("syntheses_media_asset_idx").on(t.mediaAssetId),
    check("syntheses_repetition_index_ck", sql`${t.repetitionIndex} >= 0`),
  ],
);

// PostgreSQL-backed queue. Workers claim rows with FOR UPDATE SKIP LOCKED (spec 29).
export const jobs = pgTable(
  "jobs",
  {
    id: pk(),
    type: text("type").notNull(),
    payloadJson: jsonb("payload_json").$type<JobPayload>().notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: ts("available_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    processingBatchId: uuid("processing_batch_id").references(() => processingBatches.id, {
      onDelete: "restrict",
    }),
    // Enqueueing the same logical work twice returns the existing job (spec 30).
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("jobs_status_available_idx").on(t.status, t.availableAt),
    index("jobs_queued_available_idx").on(t.availableAt).where(sql`${t.status} = 'queued'`),
    index("jobs_batch_status_idx").on(t.processingBatchId, t.status),
    check("jobs_attempts_ck", sql`${t.attempts} >= 0`),
    check("jobs_max_attempts_ck", sql`${t.maxAttempts} >= 1`),
  ],
);

export const exportJobs = pgTable(
  "export_jobs",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    // For example dataset_package, source_audio_zip, tts_audio_zip, session_package.
    exportType: text("export_type").notNull(),
    privacyTier: text("privacy_tier").notNull().default("internal_full"),
    filtersJson: jsonb("filters_json").$type<ExportFilters>().notNull(),
    status: exportJobStatusEnum("status").notNull().default("queued"),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, {
      onDelete: "restrict",
    }),
    fileName: text("file_name"),
    summaryJson: jsonb("summary_json").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdByLabel: text("created_by_label"),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [index("export_jobs_study_created_idx").on(t.studyId, t.createdAt)],
);
