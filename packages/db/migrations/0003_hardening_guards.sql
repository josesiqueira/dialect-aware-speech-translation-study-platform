-- Hardening of the database-enforced invariants (spec 38, 70, 110, 111, 116).
-- Hand-written migration. Documented in docs/DATA-MODEL.md ("Hardening rules"),
-- tested in src/hardening.test.ts, src/roles.test.ts and src/invariants.test.ts.
--
-- What this migration does:
--   1. Recreates every trigger function of migration 0002 with a fixed
--      search_path and schema-qualified names, so a temporary table or function
--      with the same name cannot change what a guard reads.
--   2. Adds DELETE guards on sessions, task_presentations, utterances,
--      media_assets, transcripts, questionnaire_responses and questionnaire_answers.
--   3. Freezes more columns that are a scientific record once written.
--   4. Refuses rows that point at a draft version, outputs whose batch mode
--      differs from the mode of their session, and revisions whose author type
--      does not fit the transcript type.
--   5. Refuses TRUNCATE on every table that holds study or audit records.
--
-- The migration only replaces functions and triggers. It does not read or change
-- any row, so it applies on a database that already holds data.
--
-- Error contract (unchanged):
--   SQLSTATE 'IMMUT', message 'IMMUTABLE_RECORD: <table>: <reason>'
--   SQLSTATE 'INVST', message 'INVALID_STATE: <table>: <reason>'
--
-- Every function is created with
--   SET search_path = pg_catalog, public, pg_temp
-- pg_temp is listed last on purpose: when it is left out, PostgreSQL searches
-- it first for table names.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_raise_immutable(p_table text, p_reason text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: %: %', p_table, p_reason USING ERRCODE = 'IMMUT';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_raise_invalid_state(p_table text, p_reason text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'INVALID_STATE: %: %', p_table, p_reason USING ERRCODE = 'INVST';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_changed_columns(p_old jsonb, p_new jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}'::text[])
  FROM jsonb_each(p_new) AS n
  WHERE n.value IS DISTINCT FROM (p_old -> n.key)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_assert_only_changed(
  p_table text, p_old jsonb, p_new jsonb, p_allowed text[], p_reason text
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_bad text[];
BEGIN
  SELECT array_agg(c) INTO v_bad
  FROM unnest(public.dialect_changed_columns(p_old, p_new)) AS c
  WHERE NOT (c = ANY (p_allowed));
  IF v_bad IS NOT NULL THEN
    PERFORM public.dialect_raise_immutable(
      p_table, format('%s (attempted to change: %s)', p_reason, array_to_string(v_bad, ', ')));
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_assert_unchanged(
  p_table text, p_old jsonb, p_new jsonb, p_frozen text[], p_reason text
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_bad text[];
BEGIN
  SELECT array_agg(c) INTO v_bad
  FROM unnest(public.dialect_changed_columns(p_old, p_new)) AS c
  WHERE c = ANY (p_frozen);
  IF v_bad IS NOT NULL THEN
    PERFORM public.dialect_raise_immutable(
      p_table, format('%s (attempted to change: %s)', p_reason, array_to_string(v_bad, ', ')));
  END IF;
END;
$$;
--> statement-breakpoint

-- Raises if a column in p_columns already had a value and that value changed or
-- was cleared. Setting a column that was NULL is allowed.
CREATE FUNCTION public.dialect_assert_set_once(
  p_table text, p_old jsonb, p_new jsonb, p_columns text[], p_reason text
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_bad text[];
BEGIN
  SELECT array_agg(c) INTO v_bad
  FROM unnest(public.dialect_changed_columns(p_old, p_new)) AS c
  WHERE c = ANY (p_columns) AND (p_old -> c) IS DISTINCT FROM 'null'::jsonb;
  IF v_bad IS NOT NULL THEN
    PERFORM public.dialect_raise_immutable(
      p_table, format('%s (attempted to change: %s)', p_reason, array_to_string(v_bad, ', ')));
  END IF;
END;
$$;
--> statement-breakpoint

-- True only inside a transaction that ran:
--   SET LOCAL dialect.allow_test_data_reset = 'on'
CREATE OR REPLACE FUNCTION public.dialect_reset_allowed() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(current_setting('dialect.allow_test_data_reset', true), '') = 'on'
$$;
--> statement-breakpoint

-- Guard for DELETE on tables whose rows are normally never deleted.
-- Allowed only with the reset setting, and never for rows known to be research data.
-- p_mode is NULL when the trigger cannot tell which mode the row belongs to.
CREATE OR REPLACE FUNCTION public.dialect_guard_delete(p_table text, p_mode public.study_mode) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_mode = 'research' THEN
    PERFORM public.dialect_raise_immutable(
      p_table, 'research rows cannot be deleted, the test data reset only covers demo and test data');
  END IF;
  IF NOT public.dialect_reset_allowed() THEN
    PERFORM public.dialect_raise_immutable(p_table, 'rows cannot be deleted');
  END IF;
END;
$$;
--> statement-breakpoint

-- Mode of the session that owns an entity, looked up by id alone.
-- Returns NULL when the id is unknown or the entity has no session.
CREATE OR REPLACE FUNCTION public.dialect_entity_mode(p_id uuid) RETURNS public.study_mode
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
BEGIN
  SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM public.utterances u JOIN public.sessions s ON s.id = u.session_id
  WHERE u.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM public.media_assets m JOIN public.sessions s ON s.id = m.session_id
  WHERE m.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM public.transcripts t
  JOIN public.utterances u ON u.id = t.utterance_id
  JOIN public.sessions s ON s.id = u.session_id
  WHERE t.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM public.transcript_revisions r
  JOIN public.transcripts t ON t.id = r.transcript_id
  JOIN public.utterances u ON u.id = t.utterance_id
  JOIN public.sessions s ON s.id = u.session_id
  WHERE r.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM public.translations tr
  JOIN public.transcript_revisions r ON r.id = tr.source_transcript_revision_id
  JOIN public.transcripts t ON t.id = r.transcript_id
  JOIN public.utterances u ON u.id = t.utterance_id
  JOIN public.sessions s ON s.id = u.session_id
  WHERE tr.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- 'research' if either input is research, otherwise the first known mode.
CREATE OR REPLACE FUNCTION public.dialect_strictest_mode(p_a public.study_mode, p_b public.study_mode)
RETURNS public.study_mode
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_a = 'research' OR p_b = 'research' THEN 'research'::public.study_mode
    ELSE coalesce(p_a, p_b)
  END
$$;
--> statement-breakpoint

-- Mode of the session behind a transcript revision. NULL when unknown.
CREATE FUNCTION public.dialect_revision_mode(p_revision_id uuid) RETURNS public.study_mode
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.mode
  FROM public.transcript_revisions r
  JOIN public.transcripts t ON t.id = r.transcript_id
  JOIN public.utterances u ON u.id = t.utterance_id
  JOIN public.sessions s ON s.id = u.session_id
  WHERE r.id = p_revision_id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_set_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- protocol_versions, protocol_tasks, protocol_task_followups (rules unchanged)
-- ---------------------------------------------------------------------------

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
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_assert_protocol_is_draft(p_table text, p_protocol_version_id uuid)
RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status public.publication_status;
BEGIN
  SELECT p.status INTO v_status
  FROM public.protocol_versions p WHERE p.id = p_protocol_version_id FOR SHARE;
  IF FOUND AND v_status <> 'draft' THEN
    PERFORM public.dialect_raise_immutable(
      p_table, format('the protocol version is %s, only a draft can be edited', v_status));
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_guard_protocol_tasks() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.dialect_assert_protocol_is_draft(TG_TABLE_NAME, OLD.protocol_version_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.dialect_assert_protocol_is_draft(TG_TABLE_NAME, NEW.protocol_version_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_guard_protocol_task_followups() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_protocol_version_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT t.protocol_version_id INTO v_protocol_version_id
    FROM public.protocol_tasks t WHERE t.id = OLD.protocol_task_id;
    IF FOUND THEN
      PERFORM public.dialect_assert_protocol_is_draft(TG_TABLE_NAME, v_protocol_version_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.protocol_version_id INTO v_protocol_version_id
    FROM public.protocol_tasks t WHERE t.id = NEW.protocol_task_id;
    IF FOUND THEN
      PERFORM public.dialect_assert_protocol_is_draft(TG_TABLE_NAME, v_protocol_version_id);
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- consent_versions, questionnaire_versions, questionnaire_items (rules unchanged)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_consent_versions() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM public.dialect_raise_immutable(TG_TABLE_NAME, 'a published consent version cannot be deleted');
    END IF;
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
      'a published consent version cannot change, create a new version');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_guard_questionnaire_versions() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      PERFORM public.dialect_raise_immutable(
        TG_TABLE_NAME, format('a %s questionnaire version cannot be deleted', OLD.status));
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF OLD.status = 'published' AND NEW.status = 'retired' THEN
      PERFORM public.dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['status', 'retired_at'],
        'retiring a published questionnaire version may only set status and retired_at');
    ELSE
      PERFORM public.dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
        format('a %s questionnaire version cannot change, clone it as a new draft', OLD.status));
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'retired' THEN
    PERFORM public.dialect_raise_invalid_state(
      TG_TABLE_NAME, 'a draft questionnaire version can only become published');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_assert_questionnaire_is_draft(p_table text, p_questionnaire_version_id uuid)
RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status public.publication_status;
BEGIN
  SELECT q.status INTO v_status
  FROM public.questionnaire_versions q WHERE q.id = p_questionnaire_version_id FOR SHARE;
  IF FOUND AND v_status <> 'draft' THEN
    PERFORM public.dialect_raise_immutable(
      p_table, format('the questionnaire version is %s, only a draft can be edited', v_status));
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_guard_questionnaire_items() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.dialect_assert_questionnaire_is_draft(TG_TABLE_NAME, OLD.questionnaire_version_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.dialect_assert_questionnaire_is_draft(TG_TABLE_NAME, NEW.questionnaire_version_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ai_prompt_versions, model_configs (rules unchanged)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_ai_config() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      PERFORM public.dialect_raise_immutable(
        TG_TABLE_NAME, format('a version with status %s cannot be deleted', OLD.status));
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NEW.status = 'draft' THEN
      PERFORM public.dialect_raise_immutable(
        TG_TABLE_NAME, format('a version with status %s cannot go back to draft', OLD.status));
    END IF;
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['status', 'activated_at', 'retired_at'],
      format('the content of a version with status %s cannot change, create a new version', OLD.status));
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_check_model_config_prompt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status public.config_status;
BEGIN
  IF NEW.status <> 'draft' AND NEW.prompt_version_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT p.status INTO v_status
    FROM public.ai_prompt_versions p WHERE p.id = NEW.prompt_version_id FOR SHARE;
    IF v_status = 'draft' THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'the linked prompt version is still a draft, activate the prompt first');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- sessions
--   INSERT: the protocol version must not be a draft.
--   UPDATE: protocol, mode, study, participant code and started_at never change.
--           consented_at, completed_at, withdrawn_at, abandoned_at are set once.
--   DELETE: never for research. Demo and test: with the reset setting, or
--           without it only while the session has no rows below it (the
--           pipeline test removes its empty test session, spec 116).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_sessions() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status public.publication_status;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p.status INTO v_status
    FROM public.protocol_versions p WHERE p.id = NEW.protocol_version_id;
    IF FOUND AND v_status = 'draft' THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a session cannot use a draft protocol version, publish the protocol first');
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.mode = 'research' THEN
      PERFORM public.dialect_raise_immutable(TG_TABLE_NAME, 'a research session cannot be deleted');
    END IF;
    IF NOT public.dialect_reset_allowed() AND (
         EXISTS (SELECT 1 FROM public.session_consents c WHERE c.session_id = OLD.id)
      OR EXISTS (SELECT 1 FROM public.task_presentations p WHERE p.session_id = OLD.id)
      OR EXISTS (SELECT 1 FROM public.utterances u WHERE u.session_id = OLD.id)
      OR EXISTS (SELECT 1 FROM public.media_assets m WHERE m.session_id = OLD.id)
      OR EXISTS (SELECT 1 FROM public.questionnaire_responses q WHERE q.session_id = OLD.id)
    ) THEN
      PERFORM public.dialect_raise_immutable(
        TG_TABLE_NAME, 'a demo or test session with stored data can only be deleted by the test data reset');
    END IF;
    RETURN OLD;
  END IF;

  PERFORM public.dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['protocol_version_id', 'mode', 'study_id', 'participant_code', 'started_at'],
    'the protocol version, mode, study, participant code and start time of a session are immutable');
  PERFORM public.dialect_assert_set_once(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['consented_at', 'completed_at', 'withdrawn_at', 'abandoned_at'],
    'a session timestamp cannot change once it is set');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.sessions;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_sessions();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- session_consents
--   INSERT: the consent version must be published.
--   UPDATE: never. DELETE: only by the reset, never for research.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_session_consents() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
  v_published timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.published_at INTO v_published
    FROM public.consent_versions c WHERE c.id = NEW.consent_version_id;
    IF FOUND AND v_published IS NULL THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a consent record cannot refer to a consent version that is not published');
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.dialect_raise_immutable(TG_TABLE_NAME, 'a stored consent record cannot be updated');
  END IF;
  SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = OLD.session_id;
  PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.session_consents;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.session_consents
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_session_consents();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- task_presentations
--   UPDATE: the record of what was shown, and the randomization metadata, never change.
--   DELETE: only by the reset, never for research.
-- ---------------------------------------------------------------------------

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
          'context_snapshot', 'instructions_snapshot', 'randomization_metadata_json'],
    'the record of what the participant saw is immutable');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.task_presentations;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON public.task_presentations
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_task_presentations();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- utterances
--   UPDATE: session and task presentation never change. Once submitted or
--           excluded, the recording link, prompt, turn, submission time,
--           attempt count and duration are frozen too.
--   DELETE: an open utterance (status recording or uploading, never submitted,
--           no accepted asset) may be deleted in any mode: skipping an optional
--           follow-up relies on it. Every other utterance: only by the reset,
--           never for research.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_utterances() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('recording', 'uploading')
       AND OLD.accepted_media_asset_id IS NULL AND OLD.submitted_at IS NULL THEN
      RETURN OLD;
    END IF;
    SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = OLD.session_id;
    PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
    RETURN OLD;
  END IF;

  PERFORM public.dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['session_id', 'task_presentation_id'],
    'the session and task presentation of an utterance are immutable');
  IF OLD.status IN ('submitted', 'excluded') THEN
    IF NEW.status NOT IN ('submitted', 'excluded') THEN
      PERFORM public.dialect_raise_immutable(
        TG_TABLE_NAME,
        format('a %s utterance can only move between submitted and excluded', OLD.status));
    END IF;
    PERFORM public.dialect_assert_unchanged(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['accepted_media_asset_id', 'followup_id', 'prompt_snapshot', 'turn_index', 'submitted_at',
            'attempt_count', 'duration_ms'],
      'the source recording link, prompt, attempt count and duration of a submitted utterance are immutable');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.utterances;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON public.utterances
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_utterances();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- media_assets
--   UPDATE: identity and content columns never change, deleted_at is set once.
--   DELETE:
--     1. A candidate recording may be deleted in any mode, without the reset
--        setting: kind source_audio or source_audio_raw, its utterance is still
--        open (status recording or uploading), and no utterance has accepted it.
--        Re-recording, discarding, withdrawal and abandonment rely on this (spec 10).
--     2. An export archive row is never deleted. The audited media deletion
--        workflow removes the file and sets deleted_at.
--     3. Every other row: only by the reset, never for research. The mode is
--        the mode of the session of the row, or of its utterance, or of the
--        synthesis that uses it. A row with none of these (a TTS file whose
--        synthesis is already gone) is deletable with the reset setting.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_media_assets() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
  v_utterance_status public.utterance_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind IN ('source_audio', 'source_audio_raw') AND OLD.utterance_id IS NOT NULL THEN
      SELECT u.status INTO v_utterance_status FROM public.utterances u WHERE u.id = OLD.utterance_id;
      IF FOUND AND v_utterance_status IN ('recording', 'uploading')
         AND NOT EXISTS (SELECT 1 FROM public.utterances a WHERE a.accepted_media_asset_id = OLD.id) THEN
        RETURN OLD;
      END IF;
    END IF;
    IF OLD.kind = 'export_archive' THEN
      PERFORM public.dialect_raise_immutable(
        TG_TABLE_NAME, 'an export archive row is kept as the record of the export, use the media deletion workflow');
    END IF;

    IF OLD.session_id IS NOT NULL THEN
      SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = OLD.session_id;
    ELSIF OLD.utterance_id IS NOT NULL THEN
      SELECT s.mode INTO v_mode
      FROM public.utterances u JOIN public.sessions s ON s.id = u.session_id
      WHERE u.id = OLD.utterance_id;
    ELSE
      SELECT CASE WHEN bool_or(x.mode = 'research') THEN 'research'::public.study_mode ELSE min(x.mode) END
      INTO v_mode
      FROM (
        SELECT public.dialect_strictest_mode(b.data_mode, public.dialect_entity_mode(sy.translation_id)) AS mode
        FROM public.syntheses sy
        JOIN public.processing_batches b ON b.id = sy.processing_batch_id
        WHERE sy.media_asset_id = OLD.id
      ) AS x;
    END IF;
    PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
    RETURN OLD;
  END IF;

  PERFORM public.dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['storage_key', 'sha256', 'size_bytes', 'kind', 'study_id', 'session_id', 'utterance_id',
          'mime_type', 'container', 'codec', 'sample_rate_hz', 'channels', 'bit_depth', 'duration_ms',
          'capture_method', 'capture_quality_class', 'derived_from_media_asset_id', 'created_at'],
    'the identity and content columns of a stored media asset are immutable');
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    PERFORM public.dialect_raise_immutable(TG_TABLE_NAME, 'deleted_at cannot change once it is set');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.media_assets;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_media_assets();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- questionnaire_responses, questionnaire_answers
--   INSERT of a response: the questionnaire version must not be a draft.
--   UPDATE: never (the participant flow only inserts).
--   DELETE: only by the reset, never for research.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.dialect_guard_questionnaire_responses() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
  v_status public.publication_status;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT q.status INTO v_status
    FROM public.questionnaire_versions q WHERE q.id = NEW.questionnaire_version_id;
    IF FOUND AND v_status = 'draft' THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a questionnaire response cannot refer to a draft questionnaire version');
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
      'a stored questionnaire response cannot change');
    RETURN NEW;
  END IF;
  SELECT s.mode INTO v_mode FROM public.sessions s WHERE s.id = OLD.session_id;
  PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.questionnaire_responses
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_questionnaire_responses();
--> statement-breakpoint

CREATE FUNCTION public.dialect_guard_questionnaire_answers() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
      'a stored questionnaire answer cannot change');
    RETURN NEW;
  END IF;
  SELECT s.mode INTO v_mode
  FROM public.questionnaire_responses r JOIN public.sessions s ON s.id = r.session_id
  WHERE r.id = OLD.response_id;
  PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON public.questionnaire_answers
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_questionnaire_answers();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- transcripts
--   UPDATE: type and utterance_id never change. Without this a research
--           transcript could be moved to a test utterance, and the reset would
--           then delete its revisions.
--   DELETE: only by the reset, never for research.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.dialect_guard_transcripts() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT s.mode INTO v_mode
    FROM public.utterances u JOIN public.sessions s ON s.id = u.session_id
    WHERE u.id = OLD.utterance_id;
    PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
    RETURN OLD;
  END IF;
  PERFORM public.dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['type', 'utterance_id'],
    'the type and the utterance of a transcript are immutable');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON public.transcripts
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_transcripts();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- transcript_revisions
--   INSERT: created_by_type 'model' only on a transcript of type asr, and an
--           asr transcript only accepts 'model' revisions.
--   UPDATE: only is_current and the verification columns may change.
--           is_current may go from true to false (superseding), never back
--           (trigger dialect_20_stays_superseded below).
--           The verification columns are set once: after verified_at has a
--           value none of the three can change, and before that a label or
--           note that has a value cannot change or be cleared.
--   DELETE: only by the reset, never for research.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_transcript_revisions() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_mode public.study_mode;
  v_type public.transcript_type;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT t.type INTO v_type FROM public.transcripts t WHERE t.id = NEW.transcript_id;
    IF FOUND THEN
      IF NEW.created_by_type = 'model' AND v_type <> 'asr' THEN
        PERFORM public.dialect_raise_invalid_state(
          TG_TABLE_NAME, format('a model revision is only allowed on the asr transcript, not on %s', v_type));
      END IF;
      IF v_type = 'asr' AND NEW.created_by_type <> 'model' THEN
        PERFORM public.dialect_raise_invalid_state(
          TG_TABLE_NAME,
          format('the asr transcript only accepts model revisions, not %s revisions', NEW.created_by_type));
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT s.mode INTO v_mode
    FROM public.transcripts t
    JOIN public.utterances u ON u.id = t.utterance_id
    JOIN public.sessions s ON s.id = u.session_id
    WHERE t.id = OLD.transcript_id;
    PERFORM public.dialect_guard_delete(TG_TABLE_NAME, v_mode);
    RETURN OLD;
  END IF;

  PERFORM public.dialect_assert_only_changed(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['is_current', 'verified_at', 'verified_by_label', 'verification_notes'],
    'a transcript revision is immutable, save a new revision instead');
  IF OLD.verified_at IS NOT NULL THEN
    PERFORM public.dialect_assert_unchanged(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['verified_at', 'verified_by_label', 'verification_notes'],
      'the verification record of a revision cannot change once it is set');
  ELSE
    PERFORM public.dialect_assert_set_once(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['verified_by_label', 'verification_notes'],
      'the verification record of a revision cannot change once it is set');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.transcript_revisions;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.transcript_revisions
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_transcript_revisions();
--> statement-breakpoint

-- An AFTER trigger on purpose: when another revision is still current, the
-- unique index transcript_revisions_one_current_uq reports the conflict first,
-- as it did before this migration. This trigger then covers the case the index
-- allows: no revision is current and an old one is switched on again.
CREATE FUNCTION public.dialect_check_revision_stays_superseded() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.dialect_raise_immutable(
    TG_TABLE_NAME, 'a superseded revision cannot become current again, save a new revision instead');
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_20_stays_superseded AFTER UPDATE ON public.transcript_revisions
  FOR EACH ROW WHEN (NEW.is_current AND NOT OLD.is_current)
  EXECUTE FUNCTION public.dialect_check_revision_stays_superseded();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- model_runs
--   INSERT, and UPDATE of a running run: model_config_id and prompt_version_id
--           must not point at a draft (active and retired are accepted, the
--           reserved mock configs of Demo Mode are stored as retired).
--   UPDATE: a succeeded or failed run never changes.
--   DELETE: only by the reset, never for research.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_model_runs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_batch_mode public.study_mode;
  v_status public.config_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.processing_batch_id IS NOT NULL THEN
      SELECT b.data_mode INTO v_batch_mode
      FROM public.processing_batches b WHERE b.id = OLD.processing_batch_id;
    END IF;
    PERFORM public.dialect_guard_delete(
      TG_TABLE_NAME,
      public.dialect_strictest_mode(v_batch_mode, public.dialect_entity_mode(OLD.source_entity_id)));
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('succeeded', 'failed') THEN
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
      format('a %s model run is immutable, a retry creates a new run', OLD.status));
    RETURN NEW;
  END IF;

  IF NEW.model_config_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.model_config_id IS DISTINCT FROM OLD.model_config_id) THEN
    SELECT c.status INTO v_status FROM public.model_configs c WHERE c.id = NEW.model_config_id;
    IF FOUND AND v_status = 'draft' THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a model run cannot use a draft model config, activate the config first');
    END IF;
  END IF;
  IF NEW.prompt_version_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.prompt_version_id IS DISTINCT FROM OLD.prompt_version_id) THEN
    SELECT p.status INTO v_status FROM public.ai_prompt_versions p WHERE p.id = NEW.prompt_version_id;
    IF FOUND AND v_status = 'draft' THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a model run cannot use a draft prompt version, activate the prompt first');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.model_runs;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.model_runs
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_model_runs();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- translations, syntheses
--   INSERT: the mode of the session behind the source must equal the data_mode
--           of the batch (processing_batches.data_mode and sessions.mode never
--           change, so the check at insert holds for the life of the row).
--   UPDATE: only status. DELETE: only by the reset, never for research.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_translations() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_batch_mode public.study_mode;
  v_source_mode public.study_mode;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT b.data_mode INTO v_batch_mode
    FROM public.processing_batches b WHERE b.id = NEW.processing_batch_id;
    v_source_mode := public.dialect_revision_mode(NEW.source_transcript_revision_id);
    IF v_batch_mode IS DISTINCT FROM v_source_mode
       AND v_batch_mode IS NOT NULL AND v_source_mode IS NOT NULL THEN
      PERFORM public.dialect_raise_invalid_state(
        TG_TABLE_NAME,
        format('a %s batch cannot hold a translation of a %s session', v_batch_mode, v_source_mode));
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT b.data_mode INTO v_batch_mode
    FROM public.processing_batches b WHERE b.id = OLD.processing_batch_id;
    PERFORM public.dialect_guard_delete(
      TG_TABLE_NAME,
      public.dialect_strictest_mode(v_batch_mode, public.dialect_entity_mode(OLD.source_transcript_revision_id)));
    RETURN OLD;
  END IF;

  PERFORM public.dialect_assert_only_changed(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['status'],
    'a translation is an immutable model output, only its status may change');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.translations;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.translations
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_translations();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dialect_guard_syntheses() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_batch_mode public.study_mode;
  v_source_mode public.study_mode;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.translation_id IS NOT NULL THEN
      SELECT b.data_mode INTO v_batch_mode
      FROM public.processing_batches b WHERE b.id = NEW.processing_batch_id;
      v_source_mode := public.dialect_entity_mode(NEW.translation_id);
      IF v_batch_mode IS DISTINCT FROM v_source_mode
         AND v_batch_mode IS NOT NULL AND v_source_mode IS NOT NULL THEN
        PERFORM public.dialect_raise_invalid_state(
          TG_TABLE_NAME,
          format('a %s batch cannot hold a synthesis for a %s session', v_batch_mode, v_source_mode));
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT b.data_mode INTO v_batch_mode
    FROM public.processing_batches b WHERE b.id = OLD.processing_batch_id;
    PERFORM public.dialect_guard_delete(
      TG_TABLE_NAME,
      public.dialect_strictest_mode(v_batch_mode, public.dialect_entity_mode(OLD.translation_id)));
    RETURN OLD;
  END IF;

  PERFORM public.dialect_assert_only_changed(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['status'],
    'a synthesis is an immutable model output, only its status may change');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER dialect_10_guard ON public.syntheses;
--> statement-breakpoint
CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.syntheses
  FOR EACH ROW EXECUTE FUNCTION public.dialect_guard_syntheses();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- processing_batches
--   data_mode and study_id never change, also for a draft (the mode check of
--   translations and syntheses depends on it). started_at is set once.
--   Once the batch is not a draft: configuration and name are frozen, and the
--   status may only move as the batch service moves it:
--     queued                -> running, completed, completed_with_errors, cancelled
--     running               -> completed, completed_with_errors, cancelled
--     completed             -> running (retry), completed_with_errors
--     completed_with_errors -> running (retry), completed
--     cancelled             -> nothing, the whole row is frozen
--   completed_at of a research batch changes only together with the status.
--   DELETE: a draft freely, anything else only by the reset, never for research.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_processing_batches() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_allowed public.batch_status[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      PERFORM public.dialect_guard_delete(TG_TABLE_NAME, OLD.data_mode);
    END IF;
    RETURN OLD;
  END IF;

  PERFORM public.dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['data_mode', 'study_id'],
    'the data mode and study of a batch are immutable');
  PERFORM public.dialect_assert_set_once(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['started_at'],
    'the start time of a batch cannot change once it is set');

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' THEN
    PERFORM public.dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
      'a cancelled batch is final, create another batch');
    RETURN NEW;
  END IF;

  PERFORM public.dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['configuration_snapshot_json', 'name'],
    'the configuration and name of a started batch are frozen, create another batch for changed settings');

  IF NEW.status = 'draft' THEN
    PERFORM public.dialect_raise_immutable(TG_TABLE_NAME, 'a started batch cannot go back to draft');
  END IF;
  IF NEW.status <> OLD.status THEN
    v_allowed := CASE OLD.status
      WHEN 'queued' THEN ARRAY['running', 'completed', 'completed_with_errors', 'cancelled']::public.batch_status[]
      WHEN 'running' THEN ARRAY['completed', 'completed_with_errors', 'cancelled']::public.batch_status[]
      WHEN 'completed' THEN ARRAY['running', 'completed_with_errors']::public.batch_status[]
      WHEN 'completed_with_errors' THEN ARRAY['running', 'completed']::public.batch_status[]
      ELSE ARRAY[]::public.batch_status[]
    END;
    IF NOT (NEW.status = ANY (v_allowed)) THEN
      PERFORM public.dialect_raise_immutable(
        TG_TABLE_NAME, format('a %s batch cannot become %s', OLD.status, NEW.status));
    END IF;
  ELSIF OLD.data_mode = 'research' AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    PERFORM public.dialect_raise_immutable(
      TG_TABLE_NAME, 'completed_at of a research batch only changes together with its status');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- admin_audit_log: append-only, no exception for the reset (rule unchanged)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dialect_guard_admin_audit_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.dialect_raise_immutable(TG_TABLE_NAME, 'the audit log is append-only');
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- TRUNCATE: row triggers do not fire for it, so it is refused by a statement
-- trigger on every table that holds study or audit records. There is no
-- exception: the test data reset uses DELETE. The queue and the two purely
-- operational tables (jobs, rate_limit_hits, worker_heartbeats) are left out.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.dialect_guard_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.dialect_raise_immutable(
    TG_TABLE_NAME, 'TRUNCATE is not allowed on a table that holds study or audit records');
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'studies', 'consent_versions', 'questionnaire_versions', 'questionnaire_items',
    'protocol_versions', 'protocol_tasks', 'protocol_task_followups',
    'sessions', 'session_consents', 'task_presentations', 'utterances', 'media_assets',
    'questionnaire_responses', 'questionnaire_answers',
    'transcripts', 'transcript_revisions', 'ai_prompt_versions', 'model_configs',
    'processing_batches', 'model_runs', 'translations', 'syntheses', 'export_jobs',
    'difference_annotations', 'feature_annotations', 'research_flags', 'research_notes',
    'admin_audit_log'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER dialect_05_no_truncate BEFORE TRUNCATE ON public.%I
         FOR EACH STATEMENT EXECUTE FUNCTION public.dialect_guard_truncate()', v_table);
  END LOOP;
END;
$$;
