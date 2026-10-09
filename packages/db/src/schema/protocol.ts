// Study, protocol, consent and questionnaire definitions (spec 37.1 to 37.5, 37.21, 37.22).
// Published versions are immutable. The database enforces this with triggers
// (see the hand-written migration), not only application code.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
  orderModeEnum,
  pk,
  publicationStatusEnum,
  questionnaireItemTypeEnum,
  studyStatusEnum,
  taskTypeEnum,
  ts,
  updatedAt,
} from "./_shared";
import type {
  ConsentTranslations,
  FollowupTranslations,
  ProtocolTranslations,
  QuestionnaireItemTranslations,
  QuestionnaireTranslations,
  TaskTranslations,
} from "@dialect/domain";
import type {
  ConsentItem,
  ProtocolOrderConfig,
  ProtocolTaskConfig,
  QuestionnaireItemConfig,
  StudySettings,
} from "../json-types";

export const studies = pgTable("studies", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: studyStatusEnum("status").notNull().default("active"),
  // The protocol given to NEW sessions. Existing sessions stay pinned to theirs.
  currentProtocolVersionId: uuid("current_protocol_version_id").references(
    (): AnyPgColumn => protocolVersions.id,
    { onDelete: "restrict" },
  ),
  // Operational settings (spec 59, 87): allow_new_sessions, maintenance message, limits.
  settingsJson: jsonb("settings_json").$type<StudySettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const consentVersions = pgTable(
  "consent_versions",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    informationText: text("information_text").notNull(),
    privacyNoticeUrl: text("privacy_notice_url"),
    contactText: text("contact_text"),
    // Each item has a stable id (spec 37.3).
    itemsJson: jsonb("items_json").$type<ConsentItem[]>().notNull().default([]),
    // The texts of this row in other languages (packages/domain/src/localization.ts).
    translationsJson: jsonb("translations_json").$type<ConsentTranslations>().notNull().default({}),
    createdAt: createdAt(),
    // Null while the consent version is still a draft.
    publishedAt: ts("published_at"),
    createdByLabel: text("created_by_label"),
  },
  (t) => [
    uniqueIndex("consent_versions_study_version_uq").on(t.studyId, t.versionNumber),
    check("consent_versions_version_number_ck", sql`${t.versionNumber} >= 1`),
  ],
);

export const questionnaireVersions = pgTable(
  "questionnaire_versions",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    // For example "background" or "post_recording".
    key: text("key").notNull(),
    versionNumber: integer("version_number").notNull(),
    status: publicationStatusEnum("status").notNull().default("draft"),
    name: text("name").notNull(),
    description: text("description"),
    // The texts of this row in other languages (packages/domain/src/localization.ts).
    translationsJson: jsonb("translations_json").$type<QuestionnaireTranslations>().notNull().default({}),
    createdAt: createdAt(),
    publishedAt: ts("published_at"),
    retiredAt: ts("retired_at"),
    createdByLabel: text("created_by_label"),
  },
  (t) => [
    uniqueIndex("questionnaire_versions_study_key_version_uq").on(t.studyId, t.key, t.versionNumber),
    check("questionnaire_versions_version_number_ck", sql`${t.versionNumber} >= 1`),
    // A published or retired version always records when it was published.
    check(
      "questionnaire_versions_published_at_ck",
      sql`${t.status} = 'draft' OR ${t.publishedAt} IS NOT NULL`,
    ),
  ],
);

export const questionnaireItems = pgTable(
  "questionnaire_items",
  {
    id: pk(),
    questionnaireVersionId: uuid("questionnaire_version_id")
      .notNull()
      .references(() => questionnaireVersions.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    type: questionnaireItemTypeEnum("type").notNull(),
    prompt: text("prompt").notNull(),
    helpText: text("help_text"),
    required: boolean("required").notNull().default(false),
    orderIndex: integer("order_index").notNull(),
    // Options, scale min/max and scale labels, depending on the item type.
    configJson: jsonb("config_json").$type<QuestionnaireItemConfig>().notNull().default({}),
    // The texts of this row in other languages (packages/domain/src/localization.ts).
    translationsJson: jsonb("translations_json").$type<QuestionnaireItemTranslations>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("questionnaire_items_version_key_uq").on(t.questionnaireVersionId, t.itemKey),
    index("questionnaire_items_version_order_idx").on(t.questionnaireVersionId, t.orderIndex),
  ],
);

export const protocolVersions = pgTable(
  "protocol_versions",
  {
    id: pk(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    status: publicationStatusEnum("status").notNull().default("draft"),
    name: text("name").notNull(),
    description: text("description"),
    welcomeContent: text("welcome_content").notNull().default(""),
    informationContent: text("information_content").notNull().default(""),
    instructionContent: text("instruction_content").notNull().default(""),
    debriefContent: text("debrief_content").notNull().default(""),
    // The texts of this row in other languages (packages/domain/src/localization.ts).
    translationsJson: jsonb("translations_json").$type<ProtocolTranslations>().notNull().default({}),
    // Nullable while drafting. Publishing validates that it is set and published.
    consentVersionId: uuid("consent_version_id").references(() => consentVersions.id, {
      onDelete: "restrict",
    }),
    backgroundQuestionnaireVersionId: uuid("background_questionnaire_version_id").references(
      () => questionnaireVersions.id,
      { onDelete: "restrict" },
    ),
    postQuestionnaireVersionId: uuid("post_questionnaire_version_id").references(
      () => questionnaireVersions.id,
      { onDelete: "restrict" },
    ),
    // The questionnaire after the output review (key post_review). Null: none.
    postReviewQuestionnaireVersionId: uuid("post_review_questionnaire_version_id").references(
      () => questionnaireVersions.id,
      { onDelete: "restrict" },
    ),
    orderConfigJson: jsonb("order_config_json").$type<ProtocolOrderConfig>().notNull().default({ blocks: [] }),
    clonedFromProtocolVersionId: uuid("cloned_from_protocol_version_id").references(
      (): AnyPgColumn => protocolVersions.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    publishedAt: ts("published_at"),
    retiredAt: ts("retired_at"),
    createdByLabel: text("created_by_label"),
  },
  (t) => [
    uniqueIndex("protocol_versions_study_version_uq").on(t.studyId, t.versionNumber),
    check("protocol_versions_version_number_ck", sql`${t.versionNumber} >= 1`),
    // A published or retired version always records when it was published.
    check(
      "protocol_versions_published_at_ck",
      sql`${t.status} = 'draft' OR ${t.publishedAt} IS NOT NULL`,
    ),
  ],
);

export const protocolTasks = pgTable(
  "protocol_tasks",
  {
    id: pk(),
    // Cascade is safe: a published protocol cannot be deleted (trigger and session FK).
    protocolVersionId: uuid("protocol_version_id")
      .notNull()
      .references(() => protocolVersions.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    internalName: text("internal_name"),
    taskType: taskTypeEnum("task_type").notNull(),
    title: text("title").notNull(),
    participantPrompt: text("participant_prompt").notNull(),
    contextText: text("context_text"),
    instructionsText: text("instructions_text"),
    // The texts of this row in other languages (packages/domain/src/localization.ts).
    translationsJson: jsonb("translations_json").$type<TaskTranslations>().notNull().default({}),
    blockKey: text("block_key").notNull(),
    orderIndex: integer("order_index").notNull(),
    orderMode: orderModeEnum("order_mode").notNull().default("fixed"),
    enabled: boolean("enabled").notNull().default(true),
    minDurationSeconds: integer("min_duration_seconds"),
    suggestedDurationSeconds: integer("suggested_duration_seconds"),
    maxDurationSeconds: integer("max_duration_seconds"),
    privacyReminder: boolean("privacy_reminder").notNull().default(false),
    researcherNotes: text("researcher_notes"),
    configJson: jsonb("config_json").$type<ProtocolTaskConfig>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("protocol_tasks_version_key_uq").on(t.protocolVersionId, t.taskKey),
    index("protocol_tasks_version_order_idx").on(t.protocolVersionId, t.orderIndex),
    check(
      "protocol_tasks_durations_ck",
      sql`(${t.minDurationSeconds} IS NULL OR ${t.minDurationSeconds} >= 0)
        AND (${t.suggestedDurationSeconds} IS NULL OR ${t.suggestedDurationSeconds} >= 0)
        AND (${t.maxDurationSeconds} IS NULL OR ${t.maxDurationSeconds} > 0)
        AND (${t.minDurationSeconds} IS NULL OR ${t.maxDurationSeconds} IS NULL
          OR ${t.minDurationSeconds} <= ${t.maxDurationSeconds})`,
    ),
  ],
);

// Predefined follow-ups only. No model-generated follow-ups in Research Mode (spec 7.2, 82).
export const protocolTaskFollowups = pgTable(
  "protocol_task_followups",
  {
    id: pk(),
    protocolTaskId: uuid("protocol_task_id")
      .notNull()
      .references(() => protocolTasks.id, { onDelete: "cascade" }),
    followupKey: text("followup_key").notNull(),
    promptText: text("prompt_text").notNull(),
    // The texts of this row in other languages (packages/domain/src/localization.ts).
    translationsJson: jsonb("translations_json").$type<FollowupTranslations>().notNull().default({}),
    orderIndex: integer("order_index").notNull(),
    isRequired: boolean("is_required").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [uniqueIndex("protocol_task_followups_task_key_uq").on(t.protocolTaskId, t.followupKey)],
);

// Simple per-key request counting for login and session-creation rate limits (spec 39, 67).
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    id: pk(),
    bucketKey: text("bucket_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("rate_limit_hits_bucket_created_idx").on(t.bucketKey, t.createdAt)],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  lastSeenAt: ts("last_seen_at").notNull().default(sql`now()`),
  startedAt: ts("started_at").notNull().default(sql`now()`),
  infoJson: jsonb("info_json").$type<Record<string, unknown>>().notNull().default({}),
});
