// Researcher-created records: annotations, flags, notes and the audit log
// (spec 37.19, 37.20, 37.25, 37.26, 88).
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { annotationScopeEnum, createdAt, pk, ts } from "./_shared";
import { utterances } from "./collection";
import { transcriptRevisions } from "./processing";

// Classifies differences between two transcript revisions, for example A vs B.
// Several categories may apply, so categories are a JSON array (spec 19).
export const differenceAnnotations = pgTable(
  "difference_annotations",
  {
    id: pk(),
    utteranceId: uuid("utterance_id")
      .notNull()
      .references(() => utterances.id, { onDelete: "restrict" }),
    sourceTranscriptRevisionId: uuid("source_transcript_revision_id").references(
      () => transcriptRevisions.id,
      { onDelete: "restrict" },
    ),
    targetTranscriptRevisionId: uuid("target_transcript_revision_id").references(
      () => transcriptRevisions.id,
      { onDelete: "restrict" },
    ),
    annotationScope: annotationScopeEnum("annotation_scope").notNull().default("utterance"),
    sourceStart: integer("source_start"),
    sourceEnd: integer("source_end"),
    targetStart: integer("target_start"),
    targetEnd: integer("target_end"),
    categoriesJson: jsonb("categories_json").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    annotatorLabel: text("annotator_label").notNull(),
    schemeVersion: text("scheme_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("difference_annotations_utterance_idx").on(t.utteranceId),
    check(
      "difference_annotations_spans_ck",
      sql`(${t.sourceStart} IS NULL OR ${t.sourceStart} >= 0)
        AND (${t.sourceEnd} IS NULL OR ${t.sourceStart} IS NULL OR ${t.sourceEnd} >= ${t.sourceStart})
        AND (${t.targetStart} IS NULL OR ${t.targetStart} >= 0)
        AND (${t.targetEnd} IS NULL OR ${t.targetStart} IS NULL OR ${t.targetEnd} >= ${t.targetStart})`,
    ),
  ],
);

// Flexible table for the later annotation framework (spec 72). Independent
// ratings by different annotators are separate rows and never overwrite each other.
export const featureAnnotations = pgTable(
  "feature_annotations",
  {
    id: pk(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    featureFamily: text("feature_family").notNull(),
    featureKey: text("feature_key").notNull(),
    sourceSpanJson: jsonb("source_span_json").$type<unknown>(),
    targetSpanJson: jsonb("target_span_json").$type<unknown>(),
    label: text("label").notNull(),
    functionLabel: text("function_label"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    notes: text("notes"),
    annotatorLabel: text("annotator_label").notNull(),
    schemeVersion: text("scheme_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("feature_annotations_target_idx").on(t.targetType, t.targetId),
    check(
      "feature_annotations_confidence_ck",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  ],
);

// A flag asks for attention. It is not an exclusion (spec 71).
export const researchFlags = pgTable(
  "research_flags",
  {
    id: pk(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    reasonCode: text("reason_code"),
    notes: text("notes"),
    createdByLabel: text("created_by_label"),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("research_flags_entity_idx").on(t.entityType, t.entityId)],
);

// Internal researcher notes on a session, utterance, transcript, output or annotation.
export const researchNotes = pgTable(
  "research_notes",
  {
    id: pk(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    body: text("body").notNull(),
    createdByLabel: text("created_by_label"),
    createdAt: createdAt(),
  },
  (t) => [index("research_notes_entity_idx").on(t.entityType, t.entityId)],
);

// Append-only. Rows are never updated or deleted (enforced by trigger).
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: pk(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    beforeJson: jsonb("before_json").$type<unknown>(),
    afterJson: jsonb("after_json").$type<unknown>(),
    actorLabel: text("actor_label"),
    createdAt: createdAt(),
  },
  (t) => [
    index("admin_audit_log_entity_idx").on(t.entityType, t.entityId),
    index("admin_audit_log_created_idx").on(t.createdAt),
  ],
);
