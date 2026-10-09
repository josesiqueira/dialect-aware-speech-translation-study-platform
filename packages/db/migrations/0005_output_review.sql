-- The output review at the end of a session (docs/RESEARCH-DESIGN.md, section 3;
-- docs/DATA-MODEL.md, "Output review").
--
-- english_checks:      one English vocabulary test (LexTALE) per session. Insert only.
-- output_reviews:      the review part of a session. Only the status of a review
--                      that is in progress may move on, once, together with
--                      finished_at and skipped_at_step; selection_json never changes.
-- output_review_items: one screen. The plan (kind, recording, translations, the
--                      left and right placement, the texts shown) never changes.
--                      The answer columns are set once; an answered item is frozen.
-- All three: DELETE only through the test data reset, never for research rows;
-- TRUNCATE never.
--
-- protocol_versions.post_review_questionnaire_version_id pins the questionnaire
-- after the review. The protocol guard of 0003 is replaced to check that it is
-- published before the protocol, like the other two questionnaires.
CREATE TABLE "english_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"test_version" text NOT NULL,
	"responses_json" jsonb NOT NULL,
	"words_correct" integer NOT NULL,
	"nonwords_correct" integer NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "output_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"presentation_index" integer NOT NULL,
	"kind" text NOT NULL,
	"utterance_id" uuid,
	"transcript_revision_id" uuid,
	"prepared_example_key" text,
	"left_translation_id" uuid,
	"right_translation_id" uuid,
	"left_condition_key" text,
	"right_condition_key" text,
	"left_synthesis_id" uuid,
	"right_synthesis_id" uuid,
	"shown_json" jsonb NOT NULL,
	"scale_version" text NOT NULL,
	"ratings_json" jsonb,
	"choice" text,
	"marked_words_json" jsonb,
	"cant_judge_json" jsonb,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "output_review_items_kind_ck" CHECK ("output_review_items"."kind" IN ('practice', 'utterance', 'check', 'audio')),
	CONSTRAINT "output_review_items_choice_ck" CHECK ("output_review_items"."choice" IS NULL OR "output_review_items"."choice" IN ('1', '2', 'no_difference'))
);
--> statement-breakpoint
CREATE TABLE "output_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text NOT NULL,
	"scale_version" text NOT NULL,
	"selection_json" jsonb NOT NULL,
	"skipped_at_step" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "output_reviews_status_ck" CHECK ("output_reviews"."status" IN ('in_progress', 'completed', 'skipped', 'unavailable'))
);
--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD COLUMN "post_review_questionnaire_version_id" uuid;--> statement-breakpoint
ALTER TABLE "english_checks" ADD CONSTRAINT "english_checks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_review_items" ADD CONSTRAINT "output_review_items_review_id_output_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."output_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_review_items" ADD CONSTRAINT "output_review_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_review_items" ADD CONSTRAINT "output_review_items_utterance_id_utterances_id_fk" FOREIGN KEY ("utterance_id") REFERENCES "public"."utterances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_review_items" ADD CONSTRAINT "output_review_items_transcript_revision_id_transcript_revisions_id_fk" FOREIGN KEY ("transcript_revision_id") REFERENCES "public"."transcript_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_review_items" ADD CONSTRAINT "output_review_items_left_translation_id_translations_id_fk" FOREIGN KEY ("left_translation_id") REFERENCES "public"."translations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_review_items" ADD CONSTRAINT "output_review_items_right_translation_id_translations_id_fk" FOREIGN KEY ("right_translation_id") REFERENCES "public"."translations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_review_items" ADD CONSTRAINT "output_review_items_left_synthesis_id_syntheses_id_fk" FOREIGN KEY ("left_synthesis_id") REFERENCES "public"."syntheses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_review_items" ADD CONSTRAINT "output_review_items_right_synthesis_id_syntheses_id_fk" FOREIGN KEY ("right_synthesis_id") REFERENCES "public"."syntheses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_reviews" ADD CONSTRAINT "output_reviews_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "english_checks_session_uq" ON "english_checks" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "output_review_items_session_idx" ON "output_review_items" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "output_review_items_review_position_uq" ON "output_review_items" USING btree ("review_id","presentation_index");--> statement-breakpoint
CREATE UNIQUE INDEX "output_reviews_session_uq" ON "output_reviews" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_post_review_questionnaire_version_id_questionnaire_versions_id_fk" FOREIGN KEY ("post_review_questionnaire_version_id") REFERENCES "public"."questionnaire_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_guard_protocol_versions() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_consent_published timestamptz;
  v_status public.publication_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      PERFORM public.dialect_raise_immutable(
        TG_TABLE_NAME, format('a %s protocol version cannot be deleted', OLD.status));
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF OLD.status = 'published' AND NEW.status = 'retired' THEN
      PERFORM public.dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
        ARRAY['status', 'retired_at', 'updated_at'],
        'retiring a published protocol version may only set status and retired_at');
    ELSE
      PERFORM public.dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['updated_at'],
        format('a %s protocol version cannot change, clone it as a new draft', OLD.status));
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT, or UPDATE of a draft. Leaving draft means publishing.
  IF NEW.status <> 'draft' THEN
    IF NEW.status <> 'published' THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a draft protocol version can only become published');
    END IF;
    IF NEW.consent_version_id IS NULL THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a protocol version cannot be published without a consent version');
    END IF;
    SELECT c.published_at INTO v_consent_published
    FROM public.consent_versions c WHERE c.id = NEW.consent_version_id;
    IF v_consent_published IS NULL THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'the consent version must be published before the protocol version');
    END IF;
    IF NEW.background_questionnaire_version_id IS NOT NULL THEN
      SELECT q.status INTO v_status
      FROM public.questionnaire_versions q WHERE q.id = NEW.background_questionnaire_version_id;
      IF v_status = 'draft' THEN
        PERFORM public.dialect_raise_invalid_state(
          TG_TABLE_NAME, 'the background questionnaire must be published before the protocol version');
      END IF;
    END IF;
    IF NEW.post_questionnaire_version_id IS NOT NULL THEN
      SELECT q.status INTO v_status
      FROM public.questionnaire_versions q WHERE q.id = NEW.post_questionnaire_version_id;
      IF v_status = 'draft' THEN
        PERFORM public.dialect_raise_invalid_state(
          TG_TABLE_NAME, 'the post-recording questionnaire must be published before the protocol version');
      END IF;
    END IF;
    IF NEW.post_review_questionnaire_version_id IS NOT NULL THEN
      SELECT q.status INTO v_status
      FROM public.questionnaire_versions q WHERE q.id = NEW.post_review_questionnaire_version_id;
      IF v_status = 'draft' THEN
        PERFORM public.dialect_raise_invalid_state(
          TG_TABLE_NAME, 'the post-review questionnaire must be published before the protocol version');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION public.dialect_guard_english_checks() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
      'a stored English check cannot change');
    RETURN NEW;
  END IF;
  SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = OLD.session_id;
  PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON public.english_checks
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_english_checks();
--> statement-breakpoint

CREATE FUNCTION public.dialect_guard_output_reviews() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'in_progress' THEN
      PERFORM public.dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
        format('a %s output review cannot change', OLD.status));
      RETURN NEW;
    END IF;
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['status', 'finished_at', 'skipped_at_step'],
      'only the status, the end time and the skipped step of an output review can change');
    PERFORM public.dialect_assert_set_once(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['finished_at', 'skipped_at_step'],
      'the end of an output review is recorded once');
    RETURN NEW;
  END IF;
  SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = OLD.session_id;
  PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON public.output_reviews
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_output_reviews();
--> statement-breakpoint

CREATE FUNCTION public.dialect_guard_output_review_items() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.answered_at IS NOT NULL THEN
      PERFORM public.dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
        'an answered review item cannot change');
      RETURN NEW;
    END IF;
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['ratings_json', 'choice', 'marked_words_json', 'cant_judge_json', 'answered_at'],
      'the plan of a review item (what is shown and where) cannot change');
    RETURN NEW;
  END IF;
  SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = OLD.session_id;
  PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON public.output_review_items
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_output_review_items();
--> statement-breakpoint

CREATE TRIGGER dialect_05_no_truncate BEFORE TRUNCATE ON public.english_checks
  FOR EACH STATEMENT EXECUTE FUNCTION public.dialect_guard_truncate();
--> statement-breakpoint
CREATE TRIGGER dialect_05_no_truncate BEFORE TRUNCATE ON public.output_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.dialect_guard_truncate();
--> statement-breakpoint
CREATE TRIGGER dialect_05_no_truncate BEFORE TRUNCATE ON public.output_review_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.dialect_guard_truncate();
