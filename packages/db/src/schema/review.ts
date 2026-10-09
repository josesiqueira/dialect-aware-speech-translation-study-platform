// The output review at the end of a session (docs/RESEARCH-DESIGN.md, section 3;
// docs/DATA-MODEL.md). After all speaking tasks and the first questionnaires the
// participant takes an English vocabulary test and rates the AI output of some
// of their own recordings. These rows are research data like questionnaire
// answers: an answer is written once and never changed (triggers of migration 0005).
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { OUTPUT_REVIEW_ITEM_KINDS, OUTPUT_REVIEW_STATUSES } from "@dialect/domain";
import { createdAt, pk, ts } from "./_shared";
import { sessions, utterances } from "./collection";
import { syntheses, transcriptRevisions, translations } from "./processing";
import type { OutputReviewSelection, OutputReviewShown } from "../json-types";

const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

// One English vocabulary test (LexTALE) per session.
export const englishChecks = pgTable(
  "english_checks",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    // The item list used, for example "lextale-en-2011".
    testVersion: text("test_version").notNull(),
    // One entry per item in the order shown: { index, text, isWord, dummy, answer }.
    responsesJson: jsonb("responses_json")
      .$type<Array<{ index: number; text: string; isWord: boolean; dummy: boolean; answer: boolean }>>()
      .notNull(),
    wordsCorrect: integer("words_correct").notNull(),
    nonwordsCorrect: integer("nonwords_correct").notNull(),
    // "% correct av" of the published scoring, 0 to 100.
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    submittedAt: ts("submitted_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("english_checks_session_uq").on(t.sessionId)],
);

// The review part of one session: its status and how the recordings were chosen.
export const outputReviews = pgTable(
  "output_reviews",
  {
    id: pk(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    // Version of the questions and scales (OUTPUT_REVIEW_SCALE_VERSION).
    scaleVersion: text("scale_version").notNull(),
    selectionJson: jsonb("selection_json").$type<OutputReviewSelection | Record<string, never>>().notNull(),
    // Set when the participant skipped: "english_check", or "output_review:<item number>".
    skippedAtStep: text("skipped_at_step"),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("output_reviews_session_uq").on(t.sessionId),
    check("output_reviews_status_ck", sql`${t.status} IN (${inList(OUTPUT_REVIEW_STATUSES)})`),
  ],
);

// One review screen. Created when the review starts (the plan, including the
// random left and right placement), answered once.
export const outputReviewItems = pgTable(
  "output_review_items",
  {
    id: pk(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => outputReviews.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    // 0-based position in the review.
    presentationIndex: integer("presentation_index").notNull(),
    kind: text("kind").notNull(),
    // Own recordings and the audio item.
    utteranceId: uuid("utterance_id").references(() => utterances.id, { onDelete: "restrict" }),
    transcriptRevisionId: uuid("transcript_revision_id").references(() => transcriptRevisions.id, {
      onDelete: "restrict",
    }),
    // Prepared examples: "practice" or "check" (the settings example used).
    preparedExampleKey: text("prepared_example_key"),
    // Version 1 is the left one, Version 2 the right one.
    leftTranslationId: uuid("left_translation_id").references(() => translations.id, { onDelete: "restrict" }),
    rightTranslationId: uuid("right_translation_id").references(() => translations.id, { onDelete: "restrict" }),
    leftConditionKey: text("left_condition_key"),
    rightConditionKey: text("right_condition_key"),
    leftSynthesisId: uuid("left_synthesis_id").references(() => syntheses.id, { onDelete: "restrict" }),
    rightSynthesisId: uuid("right_synthesis_id").references(() => syntheses.id, { onDelete: "restrict" }),
    shownJson: jsonb("shown_json").$type<OutputReviewShown>().notNull(),
    scaleVersion: text("scale_version").notNull(),
    // Set once, when the participant answers the screen.
    ratingsJson: jsonb("ratings_json").$type<Record<string, unknown>>(),
    // "1", "2" or "no_difference".
    choice: text("choice"),
    markedWordsJson: jsonb("marked_words_json").$type<number[]>(),
    // The ratings answered with "I can't judge the English", as paths such as "versions.1.meaning".
    cantJudgeJson: jsonb("cant_judge_json").$type<string[]>(),
    answeredAt: ts("answered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("output_review_items_session_idx").on(t.sessionId),
    uniqueIndex("output_review_items_review_position_uq").on(t.reviewId, t.presentationIndex),
    check("output_review_items_kind_ck", sql`${t.kind} IN (${inList(OUTPUT_REVIEW_ITEM_KINDS)})`),
    check(
      "output_review_items_choice_ck",
      sql`${t.choice} IS NULL OR ${t.choice} IN ('1', '2', 'no_difference')`,
    ),
  ],
);
