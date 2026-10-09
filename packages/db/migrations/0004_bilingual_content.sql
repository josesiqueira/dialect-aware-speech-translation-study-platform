-- Study texts in more than one language (packages/domain/src/localization.ts).
--
-- Each versioned content table gets translations_json: per locale, the
-- participant-facing texts of the row in that language. The base text columns
-- are unchanged. The guards of 0003 list the columns that may change after a
-- version leaves draft, so translations_json is immutable once a version is
-- published without any change to those triggers.
--
-- task_presentations.snapshot_locale records the locale of the four snapshot
-- texts. It is written at insert and is immutable like the snapshots.
ALTER TABLE "consent_versions" ADD COLUMN "translations_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "protocol_task_followups" ADD COLUMN "translations_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "protocol_tasks" ADD COLUMN "translations_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD COLUMN "translations_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "questionnaire_items" ADD COLUMN "translations_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "questionnaire_versions" ADD COLUMN "translations_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_presentations" ADD COLUMN "snapshot_locale" text;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_guard_task_presentations() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = OLD.session_id;
    PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
    RETURN OLD;
  END IF;
  PERFORM public.dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['session_id', 'protocol_task_id', 'sequence_index', 'title_snapshot', 'prompt_snapshot',
          'context_snapshot', 'instructions_snapshot', 'snapshot_locale', 'randomization_metadata_json'],
    'the record of what the participant saw is immutable');
  RETURN NEW;
END;
$$;
