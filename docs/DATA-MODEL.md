# Data model

The database is PostgreSQL 17. The schema is defined with Drizzle in `packages/db/src/schema/*.ts`, the JSONB column shapes are in `packages/db/src/json-types.ts`, and the committed SQL migrations are in `packages/db/migrations/`. Section numbers such as "spec 37.9" refer to `docs/IMPLEMENTATION-SPEC.md`.

Conventions:

- Every table has a UUID primary key `id` (default `gen_random_uuid()`), except `worker_heartbeats` (key `worker_id`).
- All timestamps are `timestamptz`, stored in UTC.
- Scientifically central fields are ordinary columns. JSONB is used only for flexible configuration and provider metadata (spec 125).
- Audio bytes are never stored in PostgreSQL. `media_assets` holds metadata and a storage key.
- Foreign keys use `ON DELETE RESTRICT`, with three deliberate exceptions listed under "Deletion rules".

## Tables by area

### Study definition (`schema/protocol.ts`)

| Table | Purpose | Spec |
|---|---|---|
| `studies` | One row per study. Holds the current protocol for new sessions and the operational settings. | 37.1 |
| `consent_versions` | Versioned information sheet and consent items. Published when `published_at` is set. | 37.3 |
| `questionnaire_versions` | Versioned questionnaire, identified by `key` (`background`, `post_recording`). | 37.21 |
| `questionnaire_items` | Items of one questionnaire version. | 37.22 |
| `protocol_versions` | The complete participant-facing protocol: texts, consent version, questionnaires, block order. | 37.2 |
| `protocol_tasks` | Speech tasks of one protocol version. | 37.4 |
| `protocol_task_followups` | Predefined follow-up prompts of a task. | 37.5 |

### Collected data (`schema/collection.ts`)

| Table | Purpose | Spec |
|---|---|---|
| `sessions` | One participant session, pinned to a protocol version and a mode. | 37.6 |
| `session_consents` | The exact consent choices of a session. One row per session. | 37.7 |
| `task_presentations` | What the participant saw, in the order shown, with text snapshots. | 37.8 |
| `utterances` | One spoken response (main prompt or follow-up) within a task presentation. | 37.9 |
| `media_assets` | Metadata of every stored file: source audio, derived audio, TTS audio, export archives. | 37.10 |
| `questionnaire_responses` | One submitted questionnaire per session and questionnaire version. | 37.23 |
| `questionnaire_answers` | One answer per response and item. | 37.24 |

### Output review (`schema/review.ts`, migration 0005)

The part after the questionnaires (`docs/RESEARCH-DESIGN.md`, section 3). Not in the specification: a recorded deviation (`docs/IMPLEMENTATION-STATUS.md`).

| Table | Purpose |
|---|---|
| `english_checks` | One English vocabulary test (LexTALE) per session: the item list version, every item with its answer (`responses_json`), words and nonwords correct, the score. Written only when a researcher turned on `englishCheckEnabled` (off by default since 2026-10-09). |
| `output_reviews` | The review part of one session: `status` (`in_progress`, `completed`, `skipped`, `unavailable`), the scale version, the selection log (`selection_json`: candidates in spread order, ready, chosen, not ready with the reason, waiting time), where it was skipped, start and end. |
| `output_review_items` | One review page: position, `kind`, the recording and ASR revision, the translations and syntheses shown as Version 1 (left) and Version 2 (right) with their condition keys, exactly what was shown (`shown_json`), the scale version, and the answer. With scale version `output-review-v2` every page is of kind `utterance` (an own recording) and the answer is `ratings_json` = `{ transcript: { said: "yes" \| "partly" \| "no" }, versions: { "1": { meaning, representation }, "2": { ... } } }` (1 to 5, null for "I can't say"), `cant_judge_json` (the paths answered with "I can't say") and `answered_at`; `choice` and `marked_words_json` stay null. Rows of `output-review-v1` may have the kinds `practice`, `check` and `audio`, a changed slot in `shown_json`, more ratings, a `choice` and marked words. |

`protocol_versions.post_review_questionnaire_version_id` pins the questionnaire after the review (key `post_review`), like the two other questionnaires.

### Transcripts and processing (`schema/processing.ts`)

| Table | Purpose | Spec |
|---|---|---|
| `transcripts` | One logical transcript per utterance and type (A `asr`, A* `asr_corrected`, B `human_dialect`, C `normalized`). | 37.11 |
| `transcript_revisions` | The text. Every edit is a new revision. Exactly one revision per transcript is current. | 37.12, 18 |
| `ai_prompt_versions` | Versioned prompts per key. At most one active version per key. | 37.13 |
| `model_configs` | Versioned provider, model and parameters per key, linked to a prompt version. | 37.14 |
| `processing_batches` | One processing run over a selection of utterances with a frozen configuration. | 37.15, 28, 54 |
| `model_runs` | One row per AI operation, including failed ones. | 37.16, 27 |
| `translations` | Raw translation output of one model run. | 37.17 |
| `syntheses` | TTS output of one model run, with the exact source text and the audio asset. | 37.18 |
| `jobs` | PostgreSQL-backed job queue. | 37.27, 29 |
| `export_jobs` | Requested exports and their result files. | 56 to 58 |

### Researcher records (`schema/research.ts`)

| Table | Purpose | Spec |
|---|---|---|
| `difference_annotations` | Coded differences between two transcript revisions. | 37.19 |
| `feature_annotations` | Flexible table for the later feature annotation framework. | 37.20 |
| `research_flags` | Flags that ask for attention. A flag is not an exclusion. | 37.25, 71 |
| `research_notes` | Internal researcher notes on any entity. | 88 |
| `admin_audit_log` | Append-only record of admin actions. | 37.26 |

### Operations

| Table | Purpose |
|---|---|
| `rate_limit_hits` | Request counting for login and session creation limits (spec 39, 67). |
| `worker_heartbeats` | Last-seen time of each worker process (spec 113). |

## Relationship map

This is the map of spec Appendix A with the actual table names. An arrow reads "has many", unless noted.

```text
studies
 +-- consent_versions
 +-- questionnaire_versions
 |    +-- questionnaire_items
 +-- protocol_versions            (refers to one consent_version and up to two questionnaire_versions)
 |    +-- protocol_tasks
 |         +-- protocol_task_followups
 +-- sessions                     (refers to one protocol_version)
 |    +-- session_consents        (one per session, refers to the consent_version)
 |    +-- task_presentations      (refers to one protocol_task)
 |    |    +-- utterances         (followup_id set for a follow-up turn)
 |    |         +-- media_assets  (source audio, accepted one in utterances.accepted_media_asset_id)
 |    |         +-- transcripts   (one per type)
 |    |         |    +-- transcript_revisions
 |    |         |         +-- translations
 |    |         |              +-- syntheses
 |    |         |                   +-- media_assets (TTS audio, via syntheses.media_asset_id)
 |    |         +-- difference_annotations
 |    +-- questionnaire_responses (refers to the questionnaire_version)
 |         +-- questionnaire_answers (refers to the questionnaire_item)
 +-- ai_prompt_versions
 |    +-- model_configs
 |         +-- model_runs
 +-- processing_batches
 |    +-- model_runs
 |    |    +-- transcript_revisions (ASR output, via source_model_run_id)
 |    |    +-- translations         (one per run)
 |    |    +-- syntheses            (one per run)
 |    +-- jobs
 +-- export_jobs                  (result file in media_assets)

research_flags, research_notes, feature_annotations, admin_audit_log
    refer to any entity by (entity_type, entity_id), without a foreign key.
```

Two foreign keys form a cycle: `utterances.accepted_media_asset_id` refers to `media_assets`, and `media_assets.utterance_id` refers to `utterances`. An upload therefore inserts the utterance first, then the media row, then sets the accepted asset.

## Columns beyond the specification

| Table | Column or table | Reason |
|---|---|---|
| `studies` | `current_protocol_version_id` | The protocol given to new sessions. Existing sessions stay pinned to theirs (spec 76). |
| `studies` | `settings_json` | Operational settings (spec 59, 87), so that nothing is hard-coded (spec 143). |
| `consent_versions` | `contact_text`, `created_by_label` | Researcher contact details are part of the consent page (spec 6.2). |
| `questionnaire_versions` | `retired_at`, `created_by_label` | Same life cycle as protocol versions. |
| `protocol_versions` | `updated_at`, `cloned_from_protocol_version_id` | Draft editing and the clone workflow (spec 76). |
| `protocol_tasks` | `internal_name`, `researcher_notes` | Admin-only labels that the participant never sees. |
| `sessions` | `token_hash`, `token_expires_at` | SHA-256 of the session token in the HttpOnly cookie. The token itself is never stored (spec 14). |
| `sessions` | `locale`, `order_seed` | Interface language used, and the seed for reproducible task order (spec 8). |
| `sessions` | `abandoned_at` | Completes the set of state timestamps. |
| `sessions` | `excluded`, `exclusion_reason` | Excluding a whole session from analysis without deleting it (spec 70, 116). |
| `task_presentations` | `title_snapshot`, `instructions_snapshot` | The full text the participant saw, not only the prompt (spec 77). |
| `task_presentations` | `snapshot_locale` | The language of the four snapshot texts. Immutable like them (migration 0004). |
| `protocol_versions`, `protocol_tasks`, `protocol_task_followups`, `consent_versions`, `questionnaire_versions`, `questionnaire_items` | `translations_json` | The participant-facing texts of the row in other languages, keyed by locale and field (`packages/domain/src/localization.ts`). Part of the version: immutable once the version leaves draft (migration 0004). |
| `utterances` | `prompt_snapshot` | The exact prompt answered, which for a follow-up differs from the task prompt (spec 77). |
| `utterances` | `quality_json` | Lightweight audio checks (spec 85). |
| `media_assets` | `derived_from_media_asset_id` | Links a derived file to its original (spec 64). |
| `transcript_revisions` | `segments_json` | ASR segment and timestamp data when the provider returns it (spec 148). |
| `transcript_revisions` | `derived_from_revision_id` | Records that C was written from a specific revision of B. |
| `transcript_revisions` | `verified_by_label`, `verification_notes` | Review tracking (spec 17). |
| `ai_prompt_versions`, `model_configs` | `retired_at`, `created_by_label`, and on `model_configs` also `condition_key`, `name`, `notes` | Life cycle, and the link between a config and a translation condition. |
| `processing_batches` | `study_id`, `data_mode`, `cancelled_at` | `data_mode` separates research batches from demo and test batches, so TEST and DEMO data never enter a research export by default (spec 78). |
| `model_runs` | `model_config_id`, `condition_key`, `attempt_number`, `idempotency_key` | Traceability to the configuration, and idempotent retries (spec 30). |
| `translations`, `syntheses` | `repetition_index` | Intentional repeated generations inside one batch (spec 103). |
| `jobs` | `processing_batch_id`, `idempotency_key`, `finished_at` | Batch progress, and enqueueing the same work twice returns the existing job (spec 30). |
| `export_jobs`, `research_notes`, `rate_limit_hits`, `worker_heartbeats` | whole tables | Export history (spec 56), notes (spec 88), rate limiting (spec 39), worker health (spec 113). |

## Uniqueness rules

| Rule | Index or constraint |
|---|---|
| One current revision per transcript | `transcript_revisions_one_current_uq` (partial, `WHERE is_current`) |
| Revision numbers are unique per transcript | `transcript_revisions_transcript_number_uq` |
| One transcript per utterance and type | `transcripts_utterance_type_uq` |
| One active prompt per study and key | `ai_prompt_versions_one_active_uq` (partial, `WHERE status = 'active'`) |
| One active model config per study and key | `model_configs_one_active_uq` (partial) |
| One translation per source revision, condition, batch and repetition | `translations_identity_uq` |
| One translation per model run, one synthesis per model run | `translations_model_run_uq`, `syntheses_model_run_uq` |
| Idempotency keys | `jobs_idempotency_key_unique`, `model_runs_idempotency_key_unique` |
| One consent record per session | `session_consents_session_uq` |
| One response per session and questionnaire version | `questionnaire_responses_session_version_uq` |
| Version numbers per study (and key) | `*_study_version_uq`, `*_study_key_version_uq` |
| Order of presentations and turns | `task_presentations_session_sequence_uq`, `utterances_presentation_turn_uq` |

To replace the current revision, set `is_current = false` on the old revision first, then insert the new one, in one transaction. A revision that was switched off cannot be switched on again (trigger).

## CHECK constraints (migration 0001)

| Table | Constraint | Rule |
|---|---|---|
| all versioned tables | `*_version_number_ck` | `version_number >= 1` |
| `protocol_versions`, `questionnaire_versions` | `*_published_at_ck` | a published or retired version has `published_at` |
| `protocol_tasks` | `protocol_tasks_durations_ck` | durations are not negative, `max > 0`, `min <= max` |
| `task_presentations` | `task_presentations_sequence_index_ck` | `sequence_index >= 0` |
| `utterances` | `utterances_attempt_count_ck`, `utterances_turn_index_ck`, `utterances_duration_ms_ck` | `attempt_count >= 1`, `turn_index >= 0`, `duration_ms >= 0` |
| `utterances` | `utterances_submitted_has_media_ck` | status `submitted` requires `accepted_media_asset_id` and `submitted_at` |
| `media_assets` | `media_assets_sha256_ck` | 64 lowercase hexadecimal characters |
| `media_assets` | `media_assets_size_bytes_ck`, `media_assets_duration_ms_ck`, `media_assets_audio_format_ck` | size and duration not negative, sample rate, channels and bit depth positive |
| `transcript_revisions` | `transcript_revisions_revision_number_ck` | `revision_number >= 1` |
| `model_runs` | `model_runs_attempt_number_ck`, `model_runs_latency_ms_ck` | `attempt_number >= 1`, `latency_ms >= 0` |
| `translations`, `syntheses` | `*_repetition_index_ck` | `repetition_index >= 0` |
| `jobs` | `jobs_attempts_ck`, `jobs_max_attempts_ck` | `attempts >= 0`, `max_attempts >= 1` |
| `difference_annotations` | `difference_annotations_spans_ck` | span offsets not negative, end not before start |
| `feature_annotations` | `feature_annotations_confidence_ck` | confidence between 0 and 1 |

## Immutability rules and triggers (migrations 0002, 0003 and 0004)

The scientific invariants (spec 110) are enforced by the database, so they hold even if application code has a bug. Migration `0002_immutability_triggers.sql` created the first set of guards. Migration `0003_hardening_guards.sql` closed the holes an independent review found: it replaced every guard function, added guards and added the TRUNCATE triggers. Migration `0004_bilingual_content.sql` added `translations_json` to the versioned content tables (covered by the existing guards, which list the columns that may change) and `snapshot_locale` to the immutable columns of `task_presentations`. The table below describes the rules as they are after 0004. The tests are in `packages/db/src/invariants.test.ts`, `hardening.test.ts` (one block per review finding), `roles.test.ts` and `migrations.test.ts`.

### How the errors surface

| SQLSTATE | Message format | Meaning | Map to |
|---|---|---|---|
| `IMMUT` | `IMMUTABLE_RECORD: <table>: <reason>` | The change would alter or delete an immutable record. | `AppError("IMMUTABLE_RECORD")` |
| `INVST` | `INVALID_STATE: <table>: <reason>` | The row is not allowed in the current state: a publish or activate step out of order, a reference to a draft version, an output in a batch of another mode, an author type that does not fit the transcript type. | `AppError("INVALID_STATE")` |

When an update tries to change frozen columns, the reason ends with `(attempted to change: column_a, column_b)`.

Drizzle wraps the node-postgres error and keeps it as `cause`. Use the helpers exported by `@dialect/db` (`packages/db/src/errors.ts`): `getPgError(error)`, `isImmutableRecordError(error)`, `isInvalidStateError(error)`, `isUniqueViolation(error, constraint?)`, `isCheckViolation(error, constraint?)`, `triggerErrorReason(error)`. The constants are `IMMUTABLE_RECORD_SQLSTATE` and `INVALID_STATE_SQLSTATE`.

Services should still check state themselves and throw a clear `AppError` first. The triggers are the last line of defence, not the user interface.

### Trigger list

Every guard trigger is named `dialect_10_guard` and is a `BEFORE ... FOR EACH ROW` trigger, unless another name is given. PostgreSQL fires triggers in name order, so the guard sees the row before `dialect_90_set_updated_at` changes it. "Reset only" in the DELETE column means: never for research rows, and for demo and test rows only inside the guarded reset (see "The TEST and DEMO data reset").

| Table | Events | Function | Rule |
|---|---|---|---|
| `protocol_versions` | INSERT, UPDATE, DELETE | `dialect_guard_protocol_versions` | A draft may change freely and may become published. A published version may only become retired, changing only `status`, `retired_at`, `updated_at`. A retired version cannot change. Only a draft can be deleted. Publishing requires a consent version that is already published, and questionnaires (if set, including the post-review questionnaire since migration 0005) that are not drafts, otherwise `INVALID_STATE`. A draft cannot become retired directly. |
| `english_checks` | UPDATE, DELETE | `dialect_guard_english_checks` | No update. DELETE: reset only, never research. |
| `output_reviews` | UPDATE, DELETE | `dialect_guard_output_reviews` | While `in_progress`: only `status`, `finished_at` and `skipped_at_step` may change, the last two once. A finished review (`completed`, `skipped`, `unavailable`) cannot change. DELETE: reset only, never research. |
| `output_review_items` | UPDATE, DELETE | `dialect_guard_output_review_items` | The plan (what is shown, where, which outputs) never changes. Before the answer only `ratings_json`, `choice`, `marked_words_json`, `cant_judge_json` and `answered_at` may change; an answered item cannot change. DELETE: reset only, never research. |
| `protocol_tasks` | INSERT, UPDATE, DELETE | `dialect_guard_protocol_tasks` | Blocked unless the parent protocol version is a draft. Both the old and the new parent are checked on UPDATE. |
| `protocol_task_followups` | INSERT, UPDATE, DELETE | `dialect_guard_protocol_task_followups` | Blocked unless the protocol version of the parent task is a draft. |
| `consent_versions` | UPDATE, DELETE | `dialect_guard_consent_versions` | Once `published_at` is set: no change, no delete. |
| `questionnaire_versions` | INSERT, UPDATE, DELETE | `dialect_guard_questionnaire_versions` | Same as protocol versions. Retiring may change only `status` and `retired_at`. |
| `questionnaire_items` | INSERT, UPDATE, DELETE | `dialect_guard_questionnaire_items` | Blocked unless the parent questionnaire version is a draft. |
| `ai_prompt_versions`, `model_configs` | UPDATE, DELETE | `dialect_guard_ai_config` | Once status is not `draft`: only `status`, `activated_at`, `retired_at` may change, and status cannot return to `draft`. Only a draft can be deleted. |
| `model_configs` | INSERT, UPDATE | `dialect_check_model_config_prompt` (trigger `dialect_20_check_prompt`) | A config that leaves draft must not point at a prompt version that is still a draft, otherwise `INVALID_STATE`. Activate the prompt first. |
| `sessions` | INSERT, UPDATE, DELETE | `dialect_guard_sessions` | INSERT: the protocol version must not be a draft (published or retired), otherwise `INVALID_STATE`. UPDATE: `protocol_version_id`, `mode`, `study_id`, `participant_code`, `started_at` cannot change. `consented_at`, `completed_at`, `withdrawn_at`, `abandoned_at` are set once: a value cannot change or be cleared. DELETE: never for a research session, also not for one without consent or data. A demo or test session: inside the reset, or without the reset setting only while it has no consent record, task presentation, utterance, media row or questionnaire response (the pipeline test removes its empty test session this way). |
| `session_consents` | INSERT, UPDATE, DELETE | `dialect_guard_session_consents` | INSERT: the consent version must be published, otherwise `INVALID_STATE`. No update. DELETE: reset only. |
| `task_presentations` | UPDATE, DELETE | `dialect_guard_task_presentations` | `session_id`, `protocol_task_id`, `sequence_index`, the four snapshot columns, `snapshot_locale` and `randomization_metadata_json` cannot change (the session service writes them only at insert). `status`, `started_at`, `completed_at` may change. DELETE: reset only. |
| `utterances` | UPDATE, DELETE | `dialect_guard_utterances` | `session_id` and `task_presentation_id` never change. Once status is `submitted` or `excluded`: `accepted_media_asset_id`, `followup_id`, `prompt_snapshot`, `turn_index`, `submitted_at`, `attempt_count`, `duration_ms` cannot change, and status may only move between `submitted` and `excluded`. Flags, exclusion reason, quality and other columns may change. DELETE: an open utterance (status `recording` or `uploading`, `submitted_at` and `accepted_media_asset_id` both null) can be deleted in any mode, because skipping an optional follow-up removes its row. Every other utterance: reset only. |
| `media_assets` | UPDATE, DELETE | `dialect_guard_media_assets` | UPDATE: `storage_key`, `sha256`, `size_bytes`, `kind`, `study_id`, `session_id`, `utterance_id`, `mime_type`, `container`, `codec`, `sample_rate_hz`, `channels`, `bit_depth`, `duration_ms`, `capture_method`, `capture_quality_class`, `derived_from_media_asset_id`, `created_at` cannot change. `deleted_at` can be set once and then cannot change. `metadata_json`, `entity_type`, `entity_id`, `storage_driver` may change. DELETE: see "Deleting media rows" below. |
| `questionnaire_responses` | INSERT, UPDATE, DELETE | `dialect_guard_questionnaire_responses` | INSERT: the questionnaire version must not be a draft, otherwise `INVALID_STATE`. No update. DELETE: reset only. |
| `questionnaire_answers` | UPDATE, DELETE | `dialect_guard_questionnaire_answers` | No update. DELETE: reset only. |
| `transcripts` | UPDATE, DELETE | `dialect_guard_transcripts` | `type` and `utterance_id` cannot change. `status` may change. DELETE: reset only. |
| `transcript_revisions` | INSERT, UPDATE, DELETE | `dialect_guard_transcript_revisions` | INSERT: a revision with `created_by_type = 'model'` is accepted only on a transcript of type `asr`, and an `asr` transcript accepts only `model` revisions, otherwise `INVALID_STATE`. UPDATE: only `is_current`, `verified_at`, `verified_by_label`, `verification_notes` may change. The verification columns are set once: after `verified_at` has a value none of the three can change or be cleared, and before that a label or note that has a value cannot change. DELETE: reset only. |
| `transcript_revisions` | UPDATE (AFTER) | `dialect_check_revision_stays_superseded` (trigger `dialect_20_stays_superseded`) | `is_current` may go from true to false (superseding) and never from false to true. It is an AFTER trigger so that the unique index `transcript_revisions_one_current_uq` reports its conflict first when another revision is still current. |
| `model_runs` | INSERT, UPDATE, DELETE | `dialect_guard_model_runs` | INSERT, and UPDATE of a running run: `model_config_id` and `prompt_version_id`, when set, must not point at a draft, otherwise `INVALID_STATE`. Active and retired are accepted (the reserved mock configs of Demo Mode are stored as `retired`). Once status is `succeeded` or `failed` the row cannot change. DELETE: reset only. |
| `translations` | INSERT, UPDATE, DELETE | `dialect_guard_translations` | INSERT: the mode of the session behind the source revision must equal `processing_batches.data_mode` of the batch, otherwise `INVALID_STATE`. UPDATE: only `status`. DELETE: reset only. |
| `syntheses` | INSERT, UPDATE, DELETE | `dialect_guard_syntheses` | INSERT: when `translation_id` is set, the mode of the session behind that translation must equal the `data_mode` of the batch, otherwise `INVALID_STATE`. UPDATE: only `status`. DELETE: reset only. |
| `processing_batches` | UPDATE, DELETE | `dialect_guard_processing_batches` | `data_mode` and `study_id` never change, also for a draft. `started_at` is set once. Once status is not `draft`: `configuration_snapshot_json` and `name` cannot change, and status may only move as listed under "Batch status moves". A cancelled batch cannot change at all. `completed_at` of a research batch changes only together with its status. A draft can be deleted. Any other batch: reset only. |
| `admin_audit_log` | UPDATE, DELETE | `dialect_guard_admin_audit_log` | Append-only. There is no exception, not even for the reset. |
| all tables except `jobs`, `rate_limit_hits`, `worker_heartbeats` | TRUNCATE (statement trigger `dialect_05_no_truncate`) | `dialect_guard_truncate` | TRUNCATE is refused with `IMMUTABLE_RECORD`, also inside the reset. Row triggers do not fire for TRUNCATE, so without this trigger `TRUNCATE translations CASCADE` would bypass every rule above. |
| `studies`, `protocol_versions`, `sessions`, `utterances`, `transcripts`, `jobs` | UPDATE | `dialect_set_updated_at` (trigger `dialect_90_set_updated_at`) | Sets `updated_at = now()` when the row really changed. An update that changes nothing leaves `updated_at` alone. |

#### Batch status moves

These are exactly the moves that `packages/research/src/processing/batches.ts` (start, cancel, retry of failed jobs, status refresh) and the synchronous Demo Mode pipeline make. Any other move raises `IMMUTABLE_RECORD`.

| From | To |
|---|---|
| `draft` | any status (start sets `queued`, cancel sets `cancelled`) |
| `queued` | `running`, `completed`, `completed_with_errors`, `cancelled` |
| `running` | `completed`, `completed_with_errors`, `cancelled` |
| `completed` | `running` (retry of failed jobs), `completed_with_errors` |
| `completed_with_errors` | `running` (retry of failed jobs), `completed` |
| `cancelled` | none, the whole row is frozen |

`completed_at` is deliberately not frozen for a batch that is not cancelled: a retry clears it and the next completion sets it again, and a synchronous demo or test batch is finished again after every run. For a research batch it can only change in the same update that changes the status.

#### Deleting media rows

The DELETE rule of `media_assets` follows what the services do (`packages/research/src/sessions/internal.ts`, `corpus/media.ts`, `exports/package.ts`, `processing/derive.ts`):

1. A candidate recording can be deleted in any mode, without the reset setting. A candidate is a row of kind `source_audio` or `source_audio_raw` whose utterance is still open (status `recording` or `uploading`) and that no utterance has accepted. Re-recording, discarding, withdrawal and abandonment delete these rows (spec 10).
2. An export archive row (`kind = 'export_archive'`) is never deleted, not even inside the reset. No service deletes it. The audited media deletion workflow removes the file and sets `deleted_at`.
3. Every other row (an accepted or submitted source recording, a derived WAV, TTS audio, other kinds) is "reset only". No service deletes these rows. The mode is the mode of the row's session, or of its utterance's session, or (for a row without session, such as TTS audio) of the synthesis that uses it. A row without session and without synthesis has no known mode: the reset setting alone decides. In practice that is a TTS row whose synthesis the reset deleted one statement earlier. Research TTS audio stays protected, because its synthesis cannot be deleted and the foreign key `syntheses.media_asset_id` then blocks the media delete.

### Function hardening (search_path)

Every `dialect_*` function is created with `SET search_path = pg_catalog, public, pg_temp`, and every table, type and helper function inside the bodies is written with its schema (`public.sessions`, `public.dialect_guard_delete(...)`). A temporary table or a function with the name of a real one therefore cannot change what a guard reads. `pg_temp` is listed last on purpose: when it is missing from the path PostgreSQL searches it first for table names. `hardening.test.ts` checks the setting of every function in the catalog and runs the attack with look-alike temporary tables.

Consequences for application code:

- Insert a protocol version or questionnaire version as a draft, add its tasks or items, then publish it. Tasks and items cannot be added to a row that was inserted as published.
- Publish the consent version and the questionnaires before the protocol version that uses them (the same transaction is fine).
- Activate a prompt version before the model config that links to it, and activate a config before a model run uses it.
- A session can only be created on a protocol version that is published (or retired). A consent record needs a published consent version, a questionnaire response a questionnaire version that is not a draft.
- A batch only holds outputs of sessions of its own `data_mode`. A research batch never processes demo or test utterances, and a demo or test batch never processes research utterances. The database refuses the translation or synthesis row.
- ASR output is stored as a `model` revision on the `asr` transcript. Human text (A*, B, C) is stored as a `researcher` or `system` revision on the other transcript types.
- To replace the current revision, set `is_current = false` on the old one, then insert the new one. An old revision is never switched on again: save its text as a new revision.
- Verification is written once per revision. To change it, save a new revision and verify that one.
- The tasks and items triggers lock the parent row `FOR SHARE`, so a publish that runs at the same time waits and the edit is then rejected. Nothing can be added to a version while it is being published.
- Deleting a draft protocol version cascades to its tasks and follow-ups. The triggers accept this because the parent row is already gone.
- A draft protocol version that another published version was cloned from cannot be deleted, because clearing `cloned_from_protocol_version_id` would change the published row. In practice clones are made from published versions, which cannot be deleted anyway.
- A new table with an `updated_at` column needs its own `dialect_90_set_updated_at` trigger in the migration that creates it. A new table that holds study or audit records needs a `dialect_05_no_truncate` trigger, and a new trigger function needs the `SET search_path` clause and schema-qualified names.

Rows that existed before migration 0003 are not checked by it. The migration only replaces functions and triggers, so it applies on any database. A row that an INSERT rule would refuse today (for example a translation of a test session in a research batch) stays readable, and the DELETE rules treat it conservatively: research in either the batch or the session blocks the delete.

### Limits: what the triggers cannot stop

The triggers bind every role that is not allowed to change the schema. They do not bind a superuser or the owner of the tables, by the nature of PostgreSQL:

- A superuser can run `SET session_replication_role = replica`, which switches off all ordinary triggers for the session.
- The owner of a table (and a superuser) can run `ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER`, `CREATE OR REPLACE FUNCTION` on a guard function, `DROP TABLE`, and can grant itself any privilege.
- A superuser can read and write the data files, restore an older backup, or use `pg_dump` and `pg_restore` with `--disable-triggers`.
- The reset setting `dialect.allow_test_data_reset` can be set by any role. This is intended: the setting never unlocks research rows, the audit log, export archive rows or TRUNCATE.
- The triggers do not check rows that were written before they existed.
- The file in the storage layer is outside the database. `media_assets.sha256` and `size_bytes` make a changed or missing file detectable, they do not prevent it.

For that reason the web app and the worker must not connect as a superuser or as the owner of the tables in a deployment. `docker/postgres/create-roles.sql` creates two roles: an owner role that only the migration command uses, and an application role with `SELECT, INSERT, UPDATE, DELETE` on the tables and nothing else (no `TRUNCATE`, no `TRIGGER`, no ownership). `packages/db/src/roles.test.ts` connects as that application role and proves that the ordinary work and the guarded reset succeed while `ALTER TABLE ... DISABLE TRIGGER`, `TRUNCATE`, `SET session_replication_role = replica`, `DROP TABLE`, `DROP TRIGGER` and replacing a guard function fail with "insufficient privilege". The setup is described in `docs/DEPLOYMENT.md`, "Database roles". The local development database keeps using the `postgres` superuser for convenience, so in development the triggers are a safety net against bugs, not against a person with the development password.

### The TEST and DEMO data reset

Spec 38 and 116 allow a guarded reset of TEST and DEMO data. The triggers that block DELETE on `sessions`, `session_consents`, `task_presentations`, `utterances`, `media_assets`, `questionnaire_responses`, `questionnaire_answers`, `transcripts`, `transcript_revisions`, `model_runs`, `translations`, `syntheses` and non-draft `processing_batches` allow it only when both conditions hold:

1. The current transaction has run `SET LOCAL dialect.allow_test_data_reset = 'on'`. `SET LOCAL` ends with the transaction, so the setting cannot leak into another request on the same pooled connection.
2. The row is not research data. The trigger works out the mode as follows, and refuses with `IMMUTABLE_RECORD` when the answer is `research` (with or without the setting):

| Table | How the mode is found |
|---|---|
| `sessions` | its own `mode` |
| `session_consents`, `task_presentations`, `utterances`, `questionnaire_responses` | `sessions.mode` of the session |
| `questionnaire_answers` | response, session |
| `english_checks`, `output_reviews`, `output_review_items` | `sessions.mode` of the session |
| `transcripts` | utterance, session |
| `transcript_revisions` | transcript, utterance, session |
| `media_assets` | the session of the row, else the session of its utterance, else the syntheses that use it (see "Deleting media rows") |
| `translations` | `processing_batches.data_mode` of its batch, and the session of its source revision. Research in either one blocks the delete. |
| `syntheses` | `data_mode` of its batch, and the session behind its translation |
| `model_runs` | `data_mode` of its batch (when set), and the session behind `source_entity_id` (looked up by id in sessions, utterances, media assets, transcripts, revisions and translations). When neither is known, the setting alone decides. |
| `processing_batches` | its own `data_mode` |

The columns these lookups follow cannot be changed afterwards: `sessions.mode`, `processing_batches.data_mode`, `utterances.session_id`, `media_assets.session_id` and `utterance_id`, `transcripts.utterance_id`, `transcript_revisions.transcript_id`, `questionnaire_responses.session_id`, `questionnaire_answers.response_id`, and the source columns of translations and syntheses are all frozen. A research row can therefore not be moved under a test session to make it deletable.

Not removable by the reset, by design: research rows of any table, `admin_audit_log` rows, export archive rows of `media_assets`, and anything through TRUNCATE.

How the reset service must use it:

```ts
import { deleteDemoAndTestData } from "@dialect/db";

const result = await ctx.db.transaction(async (tx) => {
  const result = await deleteDemoAndTestData(tx, { studyId, modes: ["test"] }); // or ["demo"], default both
  await recordAudit(tx, { action: "test_data.reset", entityType: "study", entityId: studyId, afterJson: result.deleted });
  return result;
});
// After the commit: remove result.storageObjects from the storage layer.
```

`deleteDemoAndTestData` (`packages/db/src/test-data-reset.ts`) turns the setting on, deletes the rows of the chosen modes in foreign key order and returns the storage keys of the removed media rows together with the number of deleted rows per table. It only accepts the modes `demo` and `test`. It removes sessions with everything below them, the batches with that `data_mode` and their jobs, and the flags, notes and feature annotations that point at removed entities. It does not remove protocol, consent, questionnaire, prompt or model config versions, jobs without a batch, export jobs and their archives, or audit log rows. It uses DELETE only, never TRUNCATE, and one temporary table for the collected ids (the application role keeps the `TEMPORARY` privilege for this).

A service that needs a different selection can call `allowTestDataReset(tx)` and write its own deletes in this order: output review items, output reviews, English checks, syntheses, translations, difference annotations, transcript revisions, model runs, transcripts, questionnaire answers, questionnaire responses, session consents, then media assets and utterances in one statement (they reference each other), task presentations, sessions, jobs, processing batches. The Demo Mode purge of one session (`packages/research/src/demo/purge.ts`) does this.

The confirmation phrase and the production guard (spec 116) are the responsibility of the reset service, not of the database.

## Deletion rules (spec 38)

- Foreign keys are `ON DELETE RESTRICT`. Nothing scientific is removed by a cascade. The three exceptions: `protocol_tasks` and `protocol_task_followups` cascade from their draft parent, `questionnaire_items` cascade from their draft parent, and `protocol_versions.cloned_from_protocol_version_id` is set to null.
- A draft protocol, questionnaire, consent, prompt or model config version can be deleted, and so can a draft batch. A published, active or retired one cannot (triggers), and a protocol version used by a session cannot (foreign key).
- Sessions, consent records, task presentations, utterances, media rows, questionnaire responses and answers, transcripts, revisions, model runs, translations and syntheses each have their own DELETE trigger. A research row of these tables cannot be deleted by any statement of a role that is bound by the triggers, with or without the reset setting, in one statement or in a statement with several data-modifying parts. Before migration 0003 only six of these tables had a DELETE trigger and the others relied on the foreign keys of the rows below them, which a single statement that deleted an utterance together with its accepted media row could get around.
- Four kinds of rows stay deletable without the reset setting, because a service needs it: draft versions and draft batches, a candidate recording of an open utterance (re-record, discard, withdrawal, abandonment), an open utterance row (skipping an optional follow-up), and an empty demo or test session (the pipeline test removes it when the test recording is unusable). None of them holds collected research data.
- A research session is never deleted, also not when the visitor left at the welcome step without consent. No service deletes it. It stays as an `abandoned` session.
- Exclusion is not deletion (spec 70). To exclude an utterance set `utterances.status = 'excluded'` and `exclusion_reason`. To exclude a session set `sessions.excluded` and `exclusion_reason`. Derived outputs use `status = 'excluded'`.
- Media deletion is an explicit, audited workflow: remove the file from storage, set `media_assets.deleted_at` and record the reason in `metadata_json.deletion`, and write an audit entry (`media.delete`). The row stays as provenance, and its hash and size remain known.
- A media row is deleted outright only as a candidate recording (see "Deleting media rows"). The foreign keys from `utterances.accepted_media_asset_id`, `syntheses.media_asset_id`, `export_jobs.media_asset_id` and `media_assets.derived_from_media_asset_id` protect referenced rows in addition to the trigger.
- TRUNCATE is refused on every table except `jobs`, `rate_limit_hits` and `worker_heartbeats`.
- The audit log is never deleted.
- TEST and DEMO data are removed only through the guarded reset described above.
- `export_jobs`, `difference_annotations`, `feature_annotations`, `research_flags`, `research_notes` and `jobs` have no DELETE trigger. The review findings behind migration 0003 did not cover them, no immutability rule of spec 110 names them, and the reset removes flags, notes and feature annotations of deleted entities with plain DELETE. They are protected against TRUNCATE (except `jobs`, the queue), not against DELETE.

## Development seed

`pnpm db:seed` runs `packages/db/src/seed/index.ts`. It is idempotent: each record is looked up by its natural key and inserted only when missing, and existing rows are never modified. The content is in `packages/db/src/seed/content.ts`.

It creates the study `dialect-translation-study` with explicit settings, consent version 1 (published), the `background` and `post_recording` questionnaires (published), protocol version 1 (published, the study's current protocol) with the five tasks and one follow-up of spec 92, protocol version 2 (a draft cloned from version 1), four active prompt versions (`asr_context`, `translation_default`, `translation_preserve`, `tts_baseline`) and four active model configs (`asr_default`, `translation_default`, `translation_preserve`, `tts_baseline`), each linked to its prompt.

All participant-facing texts in the seed are examples, and the researchers must replace them before data collection. A text a participant can see reads as neutral study text and starts with "[Example text, to be replaced by the research team.]"; questionnaire names and descriptions carry no marker. The marker `[PLACEHOLDER]` is used only in fields a participant never sees (the protocol description). The seed only adds missing records and published rows never change, so a change of the seed texts reaches new databases only. The base texts of the seed are English, and each participant-facing text has a Finnish translation in `translations_json`; the Finnish example texts start with "[Esimerkkiteksti, jonka tutkimusryhmä korvaa.]", which the example-text check recognizes as well. The model identifiers of spec 25 appear only in the seed content file.

The seed creates no sessions. Sample TEST sessions with audio are added by a later work package, because they need the storage layer.

## Test helpers

- `createTestDatabase()` from `@dialect/db/testing` gives a test file its own migrated database. It creates and drops whole databases and never uses TRUNCATE.
- `@dialect/db/testing-builders` inserts valid rows in the order the triggers require: `insertStudy`, `insertConsentVersion`, `insertQuestionnaire`, `insertDraftProtocol`, `publishProtocol`, `insertPublishedProtocol`, `insertSession`, `insertSessionConsent`, `insertTaskPresentation`, `insertMediaAsset`, `insertUtteranceWithMedia`, `insertTranscriptWithRevision`, `insertActiveAiConfigs`, `insertProcessingBatch`, `insertModelRun`, `insertTranslation`, `insertSynthesis`, `insertSessionWithUtterance`. The media builders insert the metadata row only, no file.

## How to add a migration safely

1. Change the schema in `packages/db/src/schema/*.ts`. Add a new enum value in `packages/domain/src/enums.ts` first.
2. From `packages/db` run `pnpm exec drizzle-kit generate --name <short_name>`. For hand-written SQL (triggers, data fixes) run `pnpm exec drizzle-kit generate --custom --name <short_name>` and write the SQL into the new file, with `--> statement-breakpoint` between statements.
3. Read the generated SQL. Check that it is additive, or that any destructive statement (dropping or retyping a column, a new `NOT NULL` without default, a new CHECK or unique index that existing rows could violate) is intended and has a data step before it.
4. Commit the SQL file together with `migrations/meta/_journal.json` and the new snapshot. Never edit a migration that has been applied anywhere. Add a new one instead.
5. Never use `drizzle-kit push` against a database that holds study data (spec 90.4). Only `pnpm db:migrate`, which applies the committed files in order and records them in `drizzle.__drizzle_migrations`.
6. Run `pnpm test` in `packages/db`. `src/migrations.test.ts` applies every migration on an empty database, one at a time, and on a database that was filled with representative study data right after migration 0000. A new migration is included automatically. If the migration adds a table that holds study data, add a row for it to the representative data only when the table exists in migration 0000. Otherwise cover it with its own test. A migration that changes guards gets its own test like the one for 0003: bring a database to the migration before it, write rows under the old rules, apply the migration, and check that no row was lost and that old rows are protected.
7. If the migration adds a table with `updated_at`, or a table that holds immutable records, add the triggers in the same migration (guard, `dialect_05_no_truncate`, `dialect_90_set_updated_at`) and a test in `src/invariants.test.ts`, and document them here. Write every trigger function with `SET search_path = pg_catalog, public, pg_temp` and schema-qualified names. `hardening.test.ts` fails when a `dialect_*` function lacks the setting or a new table lacks the TRUNCATE trigger.
8. Run the whole repository test suite (`pnpm test` in the repository root) after changing a guard: a guard can break a service path.
9. In a deployment the migration runs as the owner role (`MIGRATION_DATABASE_URL`), and new tables get the privileges of the application role through the default privileges (`docs/DEPLOYMENT.md`, "Database roles").
10. Back up a research database before applying a migration to it.
