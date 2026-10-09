-- Database-enforced scientific invariants (spec 54, 76, 77, 110).
-- Hand-written migration. Documented in docs/DATA-MODEL.md, tested in src/invariants.test.ts.
--
-- Error contract for services:
--   SQLSTATE 'IMMUT', message 'IMMUTABLE_RECORD: <table>: <reason>'  maps to AppError("IMMUTABLE_RECORD")
--   SQLSTATE 'INVST', message 'INVALID_STATE: <table>: <reason>'     maps to AppError("INVALID_STATE")
--
-- Trigger names sort so that the guard (dialect_10_...) runs before the
-- updated_at trigger (dialect_90_...). PostgreSQL fires triggers of the same
-- kind in name order.

CREATE FUNCTION dialect_raise_immutable(p_table text, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD: %: %', p_table, p_reason USING ERRCODE = 'IMMUT';
END;
$$;
--> statement-breakpoint

CREATE FUNCTION dialect_raise_invalid_state(p_table text, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'INVALID_STATE: %: %', p_table, p_reason USING ERRCODE = 'INVST';
END;
$$;
--> statement-breakpoint

-- Names of the columns whose value differs between two versions of a row.
CREATE FUNCTION dialect_changed_columns(p_old jsonb, p_new jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}'::text[])
  FROM jsonb_each(p_new) AS n
  WHERE n.value IS DISTINCT FROM (p_old -> n.key)
$$;
--> statement-breakpoint

-- Raises unless every changed column is in p_allowed.
CREATE FUNCTION dialect_assert_only_changed(
  p_table text, p_old jsonb, p_new jsonb, p_allowed text[], p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_bad text[];
BEGIN
  SELECT array_agg(c) INTO v_bad
  FROM unnest(dialect_changed_columns(p_old, p_new)) AS c
  WHERE NOT (c = ANY (p_allowed));
  IF v_bad IS NOT NULL THEN
    PERFORM dialect_raise_immutable(
      p_table, format('%s (attempted to change: %s)', p_reason, array_to_string(v_bad, ', ')));
  END IF;
END;
$$;
--> statement-breakpoint

-- Raises if any column in p_frozen changed.
CREATE FUNCTION dialect_assert_unchanged(
  p_table text, p_old jsonb, p_new jsonb, p_frozen text[], p_reason text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_bad text[];
BEGIN
  SELECT array_agg(c) INTO v_bad
  FROM unnest(dialect_changed_columns(p_old, p_new)) AS c
  WHERE c = ANY (p_frozen);
  IF v_bad IS NOT NULL THEN
    PERFORM dialect_raise_immutable(
      p_table, format('%s (attempted to change: %s)', p_reason, array_to_string(v_bad, ', ')));
  END IF;
END;
$$;
--> statement-breakpoint

-- True only inside a transaction that ran:
--   SET LOCAL dialect.allow_test_data_reset = 'on'
CREATE FUNCTION dialect_reset_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('dialect.allow_test_data_reset', true), '') = 'on'
$$;
--> statement-breakpoint

-- Guard for DELETE on tables whose rows are normally never deleted.
-- Allowed only with the reset setting, and never for rows known to be research data.
-- p_mode is NULL when the trigger cannot tell which mode the row belongs to.
CREATE FUNCTION dialect_guard_delete(p_table text, p_mode study_mode) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT dialect_reset_allowed() THEN
    PERFORM dialect_raise_immutable(p_table, 'rows cannot be deleted');
  END IF;
  IF p_mode = 'research' THEN
    PERFORM dialect_raise_immutable(
      p_table, 'research rows cannot be deleted, the test data reset only covers demo and test data');
  END IF;
END;
$$;
--> statement-breakpoint

-- Mode of the session that owns an entity, looked up by id alone.
-- Returns NULL when the id is unknown or the entity has no session.
CREATE FUNCTION dialect_entity_mode(p_id uuid) RETURNS study_mode
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_mode study_mode;
BEGIN
  SELECT s.mode INTO v_mode FROM sessions s WHERE s.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM utterances u JOIN sessions s ON s.id = u.session_id
  WHERE u.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM media_assets m JOIN sessions s ON s.id = m.session_id
  WHERE m.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM transcripts t
  JOIN utterances u ON u.id = t.utterance_id
  JOIN sessions s ON s.id = u.session_id
  WHERE t.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM transcript_revisions r
  JOIN transcripts t ON t.id = r.transcript_id
  JOIN utterances u ON u.id = t.utterance_id
  JOIN sessions s ON s.id = u.session_id
  WHERE r.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  SELECT s.mode INTO v_mode
  FROM translations tr
  JOIN transcript_revisions r ON r.id = tr.source_transcript_revision_id
  JOIN transcripts t ON t.id = r.transcript_id
  JOIN utterances u ON u.id = t.utterance_id
  JOIN sessions s ON s.id = u.session_id
  WHERE tr.id = p_id;
  IF FOUND THEN RETURN v_mode; END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- 'research' if either input is research, otherwise the first known mode.
CREATE FUNCTION dialect_strictest_mode(p_a study_mode, p_b study_mode) RETURNS study_mode
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_a = 'research' OR p_b = 'research' THEN 'research'::study_mode
    ELSE coalesce(p_a, p_b)
  END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DO $$
DECLARE
  v_table text;
BEGIN
  FOR v_table IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema()
      AND c.column_name = 'updated_at'
      AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER dialect_90_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION dialect_set_updated_at()', v_table);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- protocol_versions, protocol_tasks, protocol_task_followups
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_protocol_versions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_consent_published timestamptz;
  v_status publication_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      PERFORM dialect_raise_immutable(
        TG_TABLE_NAME, format('a %s protocol version cannot be deleted', OLD.status));
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF OLD.status = 'published' AND NEW.status = 'retired' THEN
      PERFORM dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
        ARRAY['status', 'retired_at', 'updated_at'],
        'retiring a published protocol version may only set status and retired_at');
    ELSE
      PERFORM dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['updated_at'],
        format('a %s protocol version cannot change, clone it as a new draft', OLD.status));
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT, or UPDATE of a draft. Leaving draft means publishing.
  IF NEW.status <> 'draft' THEN
    IF NEW.status <> 'published' THEN
      PERFORM dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a draft protocol version can only become published');
    END IF;
    IF NEW.consent_version_id IS NULL THEN
      PERFORM dialect_raise_invalid_state(
        TG_TABLE_NAME, 'a protocol version cannot be published without a consent version');
    END IF;
    SELECT c.published_at INTO v_consent_published
    FROM consent_versions c WHERE c.id = NEW.consent_version_id;
    IF v_consent_published IS NULL THEN
      PERFORM dialect_raise_invalid_state(
        TG_TABLE_NAME, 'the consent version must be published before the protocol version');
    END IF;
    IF NEW.background_questionnaire_version_id IS NOT NULL THEN
      SELECT q.status INTO v_status
      FROM questionnaire_versions q WHERE q.id = NEW.background_questionnaire_version_id;
      IF v_status = 'draft' THEN
        PERFORM dialect_raise_invalid_state(
          TG_TABLE_NAME, 'the background questionnaire must be published before the protocol version');
      END IF;
    END IF;
    IF NEW.post_questionnaire_version_id IS NOT NULL THEN
      SELECT q.status INTO v_status
      FROM questionnaire_versions q WHERE q.id = NEW.post_questionnaire_version_id;
      IF v_status = 'draft' THEN
        PERFORM dialect_raise_invalid_state(
          TG_TABLE_NAME, 'the post-recording questionnaire must be published before the protocol version');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON protocol_versions
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_protocol_versions();
--> statement-breakpoint

-- Raises unless the protocol version is a draft. A missing parent is accepted:
-- that is the cascade from deleting a draft protocol version (the parent row is
-- already gone), and for INSERT the foreign key rejects a missing parent anyway.
-- FOR SHARE makes a concurrent publish wait, so a task cannot slip into a
-- protocol version while it is being published.
CREATE FUNCTION dialect_assert_protocol_is_draft(p_table text, p_protocol_version_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status publication_status;
BEGIN
  SELECT p.status INTO v_status
  FROM protocol_versions p WHERE p.id = p_protocol_version_id FOR SHARE;
  IF FOUND AND v_status <> 'draft' THEN
    PERFORM dialect_raise_immutable(
      p_table, format('the protocol version is %s, only a draft can be edited', v_status));
  END IF;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION dialect_guard_protocol_tasks() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM dialect_assert_protocol_is_draft(TG_TABLE_NAME, OLD.protocol_version_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM dialect_assert_protocol_is_draft(TG_TABLE_NAME, NEW.protocol_version_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON protocol_tasks
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_protocol_tasks();
--> statement-breakpoint

CREATE FUNCTION dialect_guard_protocol_task_followups() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_protocol_version_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT t.protocol_version_id INTO v_protocol_version_id
    FROM protocol_tasks t WHERE t.id = OLD.protocol_task_id;
    IF FOUND THEN
      PERFORM dialect_assert_protocol_is_draft(TG_TABLE_NAME, v_protocol_version_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.protocol_version_id INTO v_protocol_version_id
    FROM protocol_tasks t WHERE t.id = NEW.protocol_task_id;
    IF FOUND THEN
      PERFORM dialect_assert_protocol_is_draft(TG_TABLE_NAME, v_protocol_version_id);
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON protocol_task_followups
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_protocol_task_followups();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- consent_versions
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_consent_versions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM dialect_raise_immutable(TG_TABLE_NAME, 'a published consent version cannot be deleted');
    END IF;
    PERFORM dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
      'a published consent version cannot change, create a new version');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON consent_versions
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_consent_versions();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- questionnaire_versions, questionnaire_items
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_questionnaire_versions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      PERFORM dialect_raise_immutable(
        TG_TABLE_NAME, format('a %s questionnaire version cannot be deleted', OLD.status));
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF OLD.status = 'published' AND NEW.status = 'retired' THEN
      PERFORM dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['status', 'retired_at'],
        'retiring a published questionnaire version may only set status and retired_at');
    ELSE
      PERFORM dialect_assert_only_changed(
        TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
        format('a %s questionnaire version cannot change, clone it as a new draft', OLD.status));
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'retired' THEN
    PERFORM dialect_raise_invalid_state(
      TG_TABLE_NAME, 'a draft questionnaire version can only become published');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON questionnaire_versions
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_questionnaire_versions();
--> statement-breakpoint

CREATE FUNCTION dialect_assert_questionnaire_is_draft(p_table text, p_questionnaire_version_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status publication_status;
BEGIN
  SELECT q.status INTO v_status
  FROM questionnaire_versions q WHERE q.id = p_questionnaire_version_id FOR SHARE;
  IF FOUND AND v_status <> 'draft' THEN
    PERFORM dialect_raise_immutable(
      p_table, format('the questionnaire version is %s, only a draft can be edited', v_status));
  END IF;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION dialect_guard_questionnaire_items() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM dialect_assert_questionnaire_is_draft(TG_TABLE_NAME, OLD.questionnaire_version_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM dialect_assert_questionnaire_is_draft(TG_TABLE_NAME, NEW.questionnaire_version_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE INSERT OR UPDATE OR DELETE ON questionnaire_items
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_questionnaire_items();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ai_prompt_versions, model_configs
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_ai_config() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      PERFORM dialect_raise_immutable(
        TG_TABLE_NAME, format('a version with status %s cannot be deleted', OLD.status));
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NEW.status = 'draft' THEN
      PERFORM dialect_raise_immutable(
        TG_TABLE_NAME, format('a version with status %s cannot go back to draft', OLD.status));
    END IF;
    PERFORM dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['status', 'activated_at', 'retired_at'],
      format('the content of a version with status %s cannot change, create a new version', OLD.status));
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON ai_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_ai_config();
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON model_configs
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_ai_config();
--> statement-breakpoint

-- A model config that leaves draft must not point at a prompt that is still a
-- draft, otherwise the prompt text could change under an active config.
CREATE FUNCTION dialect_check_model_config_prompt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status config_status;
BEGIN
  IF NEW.status <> 'draft' AND NEW.prompt_version_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT p.status INTO v_status
    FROM ai_prompt_versions p WHERE p.id = NEW.prompt_version_id FOR SHARE;
    IF v_status = 'draft' THEN
      PERFORM dialect_raise_invalid_state(
        TG_TABLE_NAME, 'the linked prompt version is still a draft, activate the prompt first');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_20_check_prompt BEFORE INSERT OR UPDATE ON model_configs
  FOR EACH ROW EXECUTE FUNCTION dialect_check_model_config_prompt();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- transcript_revisions
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_transcript_revisions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mode study_mode;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT s.mode INTO v_mode
    FROM transcripts t
    JOIN utterances u ON u.id = t.utterance_id
    JOIN sessions s ON s.id = u.session_id
    WHERE t.id = OLD.transcript_id;
    PERFORM dialect_guard_delete(TG_TABLE_NAME, v_mode);
    RETURN OLD;
  END IF;

  PERFORM dialect_assert_only_changed(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['is_current', 'verified_at', 'verified_by_label', 'verification_notes'],
    'a transcript revision is immutable, save a new revision instead');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON transcript_revisions
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_transcript_revisions();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- model_runs, translations, syntheses
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_model_runs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_batch_mode study_mode;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.processing_batch_id IS NOT NULL THEN
      SELECT b.data_mode INTO v_batch_mode
      FROM processing_batches b WHERE b.id = OLD.processing_batch_id;
    END IF;
    PERFORM dialect_guard_delete(
      TG_TABLE_NAME,
      dialect_strictest_mode(v_batch_mode, dialect_entity_mode(OLD.source_entity_id)));
    RETURN OLD;
  END IF;

  IF OLD.status IN ('succeeded', 'failed') THEN
    PERFORM dialect_assert_only_changed(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY[]::text[],
      format('a %s model run is immutable, a retry creates a new run', OLD.status));
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON model_runs
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_model_runs();
--> statement-breakpoint

CREATE FUNCTION dialect_guard_translations() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_batch_mode study_mode;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT b.data_mode INTO v_batch_mode
    FROM processing_batches b WHERE b.id = OLD.processing_batch_id;
    PERFORM dialect_guard_delete(
      TG_TABLE_NAME,
      dialect_strictest_mode(v_batch_mode, dialect_entity_mode(OLD.source_transcript_revision_id)));
    RETURN OLD;
  END IF;

  PERFORM dialect_assert_only_changed(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['status'],
    'a translation is an immutable model output, only its status may change');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON translations
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_translations();
--> statement-breakpoint

CREATE FUNCTION dialect_guard_syntheses() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_batch_mode study_mode;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT b.data_mode INTO v_batch_mode
    FROM processing_batches b WHERE b.id = OLD.processing_batch_id;
    PERFORM dialect_guard_delete(
      TG_TABLE_NAME,
      dialect_strictest_mode(v_batch_mode, dialect_entity_mode(OLD.translation_id)));
    RETURN OLD;
  END IF;

  PERFORM dialect_assert_only_changed(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW), ARRAY['status'],
    'a synthesis is an immutable model output, only its status may change');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON syntheses
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_syntheses();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- media_assets (row DELETE stays allowed: foreign keys protect accepted and
-- referenced assets, and rejected re-record attempts must be removable, spec 10)
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_media_assets() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['storage_key', 'sha256', 'size_bytes', 'kind', 'study_id', 'session_id', 'utterance_id',
          'mime_type', 'container', 'codec', 'sample_rate_hz', 'channels', 'bit_depth', 'duration_ms',
          'capture_method', 'capture_quality_class', 'derived_from_media_asset_id', 'created_at'],
    'the identity and content columns of a stored media asset are immutable');
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    PERFORM dialect_raise_immutable(TG_TABLE_NAME, 'deleted_at cannot change once it is set');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_media_assets();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- utterances, task_presentations, session_consents, sessions
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_utterances() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('submitted', 'excluded') THEN
    IF NEW.status NOT IN ('submitted', 'excluded') THEN
      PERFORM dialect_raise_immutable(
        TG_TABLE_NAME,
        format('a %s utterance can only move between submitted and excluded', OLD.status));
    END IF;
    PERFORM dialect_assert_unchanged(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['accepted_media_asset_id', 'session_id', 'task_presentation_id', 'followup_id',
            'prompt_snapshot', 'turn_index', 'submitted_at'],
      'the source recording link and prompt of a submitted utterance are immutable');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE ON utterances
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_utterances();
--> statement-breakpoint

CREATE FUNCTION dialect_guard_task_presentations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['session_id', 'protocol_task_id', 'sequence_index', 'title_snapshot', 'prompt_snapshot',
          'context_snapshot', 'instructions_snapshot'],
    'the record of what the participant saw is immutable');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE ON task_presentations
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_task_presentations();
--> statement-breakpoint

CREATE FUNCTION dialect_guard_session_consents() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mode study_mode;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM dialect_raise_immutable(TG_TABLE_NAME, 'a stored consent record cannot be updated');
  END IF;
  SELECT s.mode INTO v_mode FROM sessions s WHERE s.id = OLD.session_id;
  PERFORM dialect_guard_delete(TG_TABLE_NAME, v_mode);
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON session_consents
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_session_consents();
--> statement-breakpoint

CREATE FUNCTION dialect_guard_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dialect_assert_unchanged(
    TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
    ARRAY['protocol_version_id', 'mode', 'study_id', 'participant_code'],
    'the protocol version, mode, study and participant code of a session are immutable');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_sessions();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- processing_batches
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_processing_batches() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      PERFORM dialect_guard_delete(TG_TABLE_NAME, OLD.data_mode);
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NEW.status = 'draft' THEN
      PERFORM dialect_raise_immutable(TG_TABLE_NAME, 'a started batch cannot go back to draft');
    END IF;
    PERFORM dialect_assert_unchanged(
      TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['configuration_snapshot_json', 'data_mode', 'study_id'],
      'the configuration of a started batch is frozen, create another batch for changed settings');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON processing_batches
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_processing_batches();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- admin_audit_log: append-only, no exception for the reset
-- ---------------------------------------------------------------------------

CREATE FUNCTION dialect_guard_admin_audit_log() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dialect_raise_immutable(TG_TABLE_NAME, 'the audit log is append-only');
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER dialect_10_guard BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION dialect_guard_admin_audit_log();
