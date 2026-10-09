// Data collected from participants: sessions, consent, the exact task sequence,
// utterances, media metadata and questionnaire responses (spec 37.6 to 37.10, 37.23, 37.24).
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  mediaKindEnum,
  pk,
  presentationStatusEnum,
  sessionStatusEnum,
  studyModeEnum,
  ts,
  updatedAt,
  utteranceStatusEnum,
} from "./_shared";
import {
  consentVersions,
  protocolTaskFollowups,
  protocolTasks,
  protocolVersions,
  questionnaireItems,
  questionnaireVersions,
  studies,
} from "./protocol";
import type {
  AudioEnvironment,
  BrowserInfo,
  ConsentResponse,
  MediaMetadata,
  RandomizationMetadata,
  UtteranceQuality,
} from "../json-types";

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    // Random pseudonymous display code such as P-7K4M9Q. Never sequential.
    participantCode: text("participant_code").notNull().unique(),
    protocolVersionId: uuid("protocol_version_id")
      .notNull()
      .references(() => protocolVersions.id, { onDelete: "restrict" }),
    // Stored explicitly. Never inferred from the URL after data are stored (spec 78).
    mode: studyModeEnum("mode").notNull(),
    status: sessionStatusEnum("status").notNull().default("created"),
    // SHA-256 of the opaque participant session token kept in the HttpOnly cookie.
    tokenHash: text("token_hash").unique(),
    tokenExpiresAt: ts("token_expires_at"),
    locale: text("locale"),
    // Seed used for reproducible task-order randomization (spec 8).
    orderSeed: text("order_seed"),
    startedAt: ts("started_at").notNull().defaultNow(),
    consentedAt: ts("consented_at"),
    completedAt: ts("completed_at"),
    withdrawnAt: ts("withdrawn_at"),
    abandonedAt: ts("abandoned_at"),
    lastActivityAt: ts("last_activity_at").notNull().defaultNow(),
    browserInfoJson: jsonb("browser_info_json").$type<BrowserInfo>(),
    audioEnvironmentJson: jsonb("audio_environment_json").$type<AudioEnvironment>(),
    appVersion: text("app_version").notNull(),
    gitCommitSha: text("git_commit_sha"),
    flagged: boolean("flagged").notNull().default(false),
    flagNotes: text("flag_notes"),
    // Exclusion keeps the data but removes it from analysis exports (spec 70).
    excluded: boolean("excluded").notNull().default(false),
    exclusionReason: text("exclusion_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sessions_study_started_idx").on(t.studyId, t.startedAt),
    index("sessions_protocol_idx").on(t.protocolVersionId),
    index("sessions_mode_status_idx").on(t.mode, t.status),
  ],
);

export const sessionConsents = pgTable(
  "session_consents",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    consentVersionId: uuid("consent_version_id")
      .notNull()
      .references(() => consentVersions.id, { onDelete: "restrict" }),
    // Every item shown, with its text snapshot and whether it was accepted.
    responsesJson: jsonb("responses_json").$type<ConsentResponse[]>().notNull(),
    acceptedAt: ts("accepted_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("session_consents_session_uq").on(t.sessionId)],
);

// What the participant actually saw, in the exact order shown (spec 8, 37.8).
export const taskPresentations = pgTable(
  "task_presentations",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    protocolTaskId: uuid("protocol_task_id")
      .notNull()
      .references(() => protocolTasks.id, { onDelete: "restrict" }),
    sequenceIndex: integer("sequence_index").notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    promptSnapshot: text("prompt_snapshot").notNull(),
    contextSnapshot: text("context_snapshot"),
    instructionsSnapshot: text("instructions_snapshot"),
    // The locale the four snapshot texts are in. Null for rows written before texts had translations.
    snapshotLocale: text("snapshot_locale"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    status: presentationStatusEnum("status").notNull().default("pending"),
    randomizationMetadataJson: jsonb("randomization_metadata_json").$type<RandomizationMetadata>(),
  },
  (t) => [
    uniqueIndex("task_presentations_session_sequence_uq").on(t.sessionId, t.sequenceIndex),
    uniqueIndex("task_presentations_session_task_uq").on(t.sessionId, t.protocolTaskId),
    check("task_presentations_sequence_index_ck", sql`${t.sequenceIndex} >= 0`),
  ],
);

export const utterances = pgTable(
  "utterances",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    taskPresentationId: uuid("task_presentation_id")
      .notNull()
      .references(() => taskPresentations.id, { onDelete: "restrict" }),
    // Null for the main prompt of a task, set for a predefined follow-up.
    followupId: uuid("followup_id").references(() => protocolTaskFollowups.id, {
      onDelete: "restrict",
    }),
    // Exact prompt text the participant answered (task prompt or follow-up prompt).
    promptSnapshot: text("prompt_snapshot").notNull(),
    // 0 for the main prompt, 1..n for follow-ups, within one task presentation.
    turnIndex: integer("turn_index").notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    acceptedMediaAssetId: uuid("accepted_media_asset_id").references(
      (): AnyPgColumn => mediaAssets.id,
      { onDelete: "restrict" },
    ),
    submittedAt: ts("submitted_at"),
    durationMs: integer("duration_ms"),
    status: utteranceStatusEnum("status").notNull().default("recording"),
    exclusionReason: text("exclusion_reason"),
    flagged: boolean("flagged").notNull().default(false),
    flagNotes: text("flag_notes"),
    // Optional lightweight checks such as peak amplitude and silence ratio (spec 85).
    qualityJson: jsonb("quality_json").$type<UtteranceQuality>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("utterances_session_idx").on(t.sessionId),
    index("utterances_task_presentation_idx").on(t.taskPresentationId),
    uniqueIndex("utterances_presentation_turn_uq").on(t.taskPresentationId, t.turnIndex),
    // Finds the utterance that accepted a media asset (also speeds up the foreign key check).
    index("utterances_accepted_media_idx").on(t.acceptedMediaAssetId),
    check("utterances_attempt_count_ck", sql`${t.attemptCount} >= 1`),
    check("utterances_turn_index_ck", sql`${t.turnIndex} >= 0`),
    check("utterances_duration_ms_ck", sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`),
    // A submitted utterance always has its accepted recording and submission time.
    check(
      "utterances_submitted_has_media_ck",
      sql`${t.status} <> 'submitted'
        OR (${t.acceptedMediaAssetId} IS NOT NULL AND ${t.submittedAt} IS NOT NULL)`,
    ),
  ],
);

// Metadata only. The audio bytes live in the storage layer, never in PostgreSQL (spec 34).
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "restrict" }),
    utteranceId: uuid("utterance_id").references((): AnyPgColumn => utterances.id, {
      onDelete: "restrict",
    }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    kind: mediaKindEnum("kind").notNull(),
    storageDriver: text("storage_driver").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    mimeType: text("mime_type").notNull(),
    container: text("container"),
    codec: text("codec"),
    sampleRateHz: integer("sample_rate_hz"),
    channels: integer("channels"),
    bitDepth: integer("bit_depth"),
    durationMs: integer("duration_ms"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    captureMethod: text("capture_method"),
    captureQualityClass: text("capture_quality_class"),
    // Parent asset when this file was derived from another (spec 64).
    derivedFromMediaAssetId: uuid("derived_from_media_asset_id").references(
      (): AnyPgColumn => mediaAssets.id,
      { onDelete: "restrict" },
    ),
    // Requested constraints, actual track settings, user agent, derivation tool and command.
    metadataJson: jsonb("metadata_json").$type<MediaMetadata>().notNull().default({}),
    createdAt: createdAt(),
    // Set by the audited media deletion workflow. The row stays as provenance.
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("media_assets_utterance_idx").on(t.utteranceId),
    index("media_assets_sha256_idx").on(t.sha256),
    index("media_assets_session_idx").on(t.sessionId),
    index("media_assets_entity_idx").on(t.entityType, t.entityId),
    // Lowercase hexadecimal SHA-256, as produced by Node's digest("hex").
    check("media_assets_sha256_ck", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("media_assets_size_bytes_ck", sql`${t.sizeBytes} >= 0`),
    check("media_assets_duration_ms_ck", sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`),
    check(
      "media_assets_audio_format_ck",
      sql`(${t.sampleRateHz} IS NULL OR ${t.sampleRateHz} > 0)
        AND (${t.channels} IS NULL OR ${t.channels} > 0)
        AND (${t.bitDepth} IS NULL OR ${t.bitDepth} > 0)`,
    ),
  ],
);

export const questionnaireResponses = pgTable(
  "questionnaire_responses",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    questionnaireVersionId: uuid("questionnaire_version_id")
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: "restrict" }),
    submittedAt: ts("submitted_at").notNull().default(sql`now()`),
  },
  (t) => [
    index("questionnaire_responses_session_idx").on(t.sessionId),
    uniqueIndex("questionnaire_responses_session_version_uq").on(t.sessionId, t.questionnaireVersionId),
  ],
);

export const questionnaireAnswers = pgTable(
  "questionnaire_answers",
  {
    id: pk(),
    responseId: uuid("response_id")
      .notNull()
      .references(() => questionnaireResponses.id, { onDelete: "restrict" }),
    questionnaireItemId: uuid("questionnaire_item_id")
      .notNull()
      .references(() => questionnaireItems.id, { onDelete: "restrict" }),
    valueJson: jsonb("value_json").$type<unknown>(),
  },
  (t) => [uniqueIndex("questionnaire_answers_response_item_uq").on(t.responseId, t.questionnaireItemId)],
);
