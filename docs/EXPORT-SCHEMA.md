# Export schema

How research data leaves the platform: the files, how they link, the filters and their defaults, the privacy tiers, and how a recipient checks a package. Specification sections 56, 57, 58, 89, 115, 123, 131.

The code is in `packages/research/src/exports/`. The field-by-field reference is the generated data dictionary (`data_dictionary.md` inside every dataset package, also `GET /api/admin/export/dictionary` and the Data & Export page). It is generated from the same lists that write the files: the column registry of the tables (`tables.ts`, `provenance.ts`) and the field lists of the configuration documents (`DOCUMENT_RECORDS` in `provenance.ts`). A test builds real packages and compares every CSV header and every JSON key with the dictionary (`exports.test.ts`, "data dictionary").

## Export kinds

| Kind | How | Content |
|---|---|---|
| Single table | `GET /api/admin/export?table=<name>&format=csv\|json\|jsonl` streams the file in the response | One table, with the filters |
| `dataset_package` | Export job, ZIP | Everything below |
| `source_audio_zip` | Export job, ZIP | `source_audio/`, `utterances.csv`, `README.md`, `MANIFEST.json` |
| `tts_audio_zip` | Export job, ZIP | `generated_audio/`, `syntheses.csv`, `README.md`, `MANIFEST.json` |
| `session_package` | Built at once for one session (`buildSessionPackage`): `POST /api/admin/export/jobs` with `exportType: "session_package"` and one id in `filters.sessionIds` answers with the completed job, without the worker | A dataset package for that session, with audio, in any mode and state |

An export job is created with `POST /api/admin/export/jobs`, built by the worker, and downloaded with `GET /api/admin/export/jobs/:id/download`. The archive is stored under `studies/<slug>/exports/<export job id>/<file name>` as a `media_assets` row of kind `export_archive`, linked from `export_jobs.media_asset_id`. A failed export is not retried automatically: it shows its error and the researcher creates a new one.

## Package layout

Files are at the root of the ZIP.

```text
README.md                     what the package is, the filters, how files link, notes for interpretation
MANIFEST.json                 filters, versions, and path, size, SHA-256 of every other file
data_dictionary.md            every field of every file
sessions.csv
task_presentations.csv
utterances.csv
transcripts.csv               one row per revision
translations.csv
syntheses.csv
questionnaire_responses.csv   long format, one row per answer
english_checks.csv            the LexTALE English check, one row per session (only when a researcher turned it on)
output_reviews.csv            the output review part per session: status, selection log
output_review_items.csv       one row per review page: what was shown, condition of each version, answers
annotations.csv               difference and feature annotations
consents.csv                  one row per session and consent item
media_assets.csv              metadata and hashes only
flags.csv
researcher_notes.csv          only with researcher notes, internal_full tier
model_runs.jsonl              one JSON object per line
audit_log.json                internal_full tier only; before and after states only with researcher notes
processing_batches.json       with the frozen configuration snapshots (id lists limited to the export)
protocol_versions/<n>.json    complete protocol: tasks, follow-ups, consent, questionnaires
prompts/<key>-v<n>.json       explicit field list, see the data dictionary
model_configs/<key>-v<n>.json explicit field list, see the data dictionary
source_audio/                 P-7K4M9Q_U-03_source.wav
generated_audio/              P-7K4M9Q_U-03_B_preservation_baseline_pilot-v1_1a2b3c4d.wav
```

`MANIFEST.json` is written last because it holds the hash of every other file. It cannot contain its own hash.

### Audio file names

Names use the pseudonymous participant code and the order number of the utterance within its session (`utterances.utterance_number`). Storage keys and names of people never appear.

- Source: `<participant code>_U-<nn>_source.<ext>` for the accepted recording. A WAV derived from a compressed recording: `<participant code>_U-<nn>_derived-<first 8 characters of the asset id>.wav`.
- Generated: `<participant code>_U-<nn>_<transcript label>_<translation condition>_<synthesis condition>_<batch name>_<first 8 characters of the synthesis id>.<ext>`. Transcript labels: `A` raw ASR, `Astar` corrected ASR (the `*` of A* is not safe in file names), `B` human dialect transcript, `C` normalized transcript.

The same path is written in `utterances.source_audio_file`, `syntheses.audio_file`, `media_assets.package_file` and `MANIFEST.json`. In a package built without audio these columns still hold the path the file has in a package with audio.

## How the files link

| From | Key | To |
|---|---|---|
| every file | `session_id`, `participant_code` | `sessions.csv` |
| `sessions.csv` | `protocol_version_number` | `protocol_versions/<n>.json` |
| `task_presentations.csv` | `protocol_task_id`, `task_key` | task in `protocol_versions/<n>.json` |
| `utterances.csv` | `task_presentation_id` | `task_presentations.csv` (exact prompt shown) |
| `utterances.csv` | `source_media_asset_id`, `source_sha256`, `source_audio_file` | `media_assets.csv`, `source_audio/` |
| `transcripts.csv` | `utterance_id` | `utterances.csv` |
| `transcripts.csv` | `source_model_run_id` | `model_runs.jsonl` |
| `translations.csv` | `source_transcript_revision_id` | `transcripts.csv` (`transcript_revision_id`) |
| `translations.csv`, `syntheses.csv` | `model_run_id` | `model_runs.jsonl` |
| `translations.csv`, `syntheses.csv`, `model_runs.jsonl` | `processing_batch_id` | `processing_batches.json` |
| `translations.csv`, `syntheses.csv` | `model_config_key` + `model_config_version` | `model_configs/<key>-v<n>.json` |
| `translations.csv`, `syntheses.csv` | `prompt_key` + `prompt_version_number` | `prompts/<key>-v<n>.json` |
| `syntheses.csv` | `translation_id` | `translations.csv` |
| `syntheses.csv` | `media_asset_id`, `media_sha256`, `audio_file` | `media_assets.csv`, `generated_audio/` |
| `questionnaire_responses.csv` | `questionnaire_version_id`, `item_key` | questionnaire in `protocol_versions/<n>.json` |
| `consents.csv` | `consent_version_id`, `item_id` | consent version in `protocol_versions/<n>.json` |
| `annotations.csv` | `utterance_id`, revision ids, `target_type` + `target_id` | the annotated records |
| `flags.csv`, `researcher_notes.csv` | `entity_type` + `entity_id`, `session_id`, `utterance_id` | the flagged or noted record |

This answers every question of specification section 158 for a generated audio file from the exported files alone: `syntheses.csv` (voice, TTS model and configuration, batch, time, application version, file hash), then `translations.csv` (condition, prompt version, model, exact text), `transcripts.csv` (transcript type and revision), `utterances.csv` (source recording and hash, exact prompt), `task_presentations.csv` and `sessions.csv`. A test rebuilds this chain from an unpacked package (`exports.test.ts`).

## Filters and defaults

All exports use one selection function (`resolveSelection` in `selection.ts`).

| Filter | Default | Effect |
|---|---|---|
| `modes`, `includeTest`, `includeDemo` | research only | Session mode. Demo and test sessions, and outputs of demo and test processing batches, appear only when asked for. `includeTest` and `includeDemo` add to `modes`. |
| `completedOnly` | true | Only sessions with status `completed`. False adds sessions in progress and abandoned sessions. |
| `includeWithdrawn` | false | Adds withdrawn sessions (independent of `completedOnly`). |
| `includeExcluded` | false | Adds excluded sessions, excluded utterances and outputs with status `excluded`. |
| `includeFlagged` | true | A flag is not an exclusion. False removes flagged sessions and utterances. |
| `dateFrom`, `dateTo` | none | Session start time. A date (`YYYY-MM-DD`) is a UTC day and `dateTo` includes that whole day. A full ISO 8601 timestamp is used as given. |
| `protocolVersionIds` | all | Protocol version of the session. |
| `taskTypes` | all | Utterances (and what derives from them) of those task types. |
| `verifiedTranscriptsOnly` | false | Keeps transcript revisions with `verified_at` set and raw ASR output (type `asr`, condition A), and the translations, syntheses and model runs that come from them. Raw ASR output is model output that no person verifies, so `verified_at` is never set on it: it always passes, as it does when a processing batch selects its sources. Corrected ASR (A*), B and C need a verified revision. Speech recognition runs are always kept. Utterances and source audio are not removed. |
| `processingBatchIds` | all | Limits model outputs (model-written transcript revisions, translations, syntheses, model runs) to these batches. Human transcripts are not affected. The rows an exported output was made from are always exported too, see "Ancestor rows". |
| `participantRegion`, `regionItemKey` | none | Keeps sessions whose answer to one background questionnaire item equals the text (case and surrounding spaces ignored). The item key defaults to `region_grew_up` (`DEFAULT_REGION_ITEM_KEY`); pass `regionItemKey` for another item. |
| `includeResearcherNotes` | false | Adds every text written by a researcher (internal_full only): flag notes, verification notes, annotation notes, `exclusion_reason` (sessions, utterances), `change_reason` (transcripts), `before_json` and `after_json` of the audit log, `researcher_notes` of tasks, `notes` of prompts and model configurations, and `researcher_notes.csv`. Without it the audit log still lists who did what, when and to which record. |
| `sessionIds` | all | Limits the export to these sessions. The other filters still apply, except in a session package. |

Fixed rules:

- Only utterances with status `submitted` are exported (plus `excluded` with `includeExcluded`). An utterance that was never submitted has no accepted recording.
- A translation is exported when its source utterance is selected and its batch has an allowed data mode. A synthesis also needs its translation to meet that rule.
- In `processing_batches.json` the lists `utteranceIds`, `selection.utteranceIds` and `selection.sessionIds` inside `configuration_snapshot_json` are limited to the utterances and sessions of the export, so the file never names an excluded or withdrawn record that the export leaves out. `utterance_ids_omitted` counts the utterance ids taken out. `MANIFEST.json` says so in `notes`.
- The audit log contains actions on the study configuration, on exported batches and on selected sessions and utterances. Logins, other exports and actions on records outside the selection are left out.
- A recording deleted by the audited deletion workflow keeps its `media_assets.csv` row with `deleted_at` and has no file.

### Ancestor rows

Every exported output comes with the rows it was made from, so that its lineage can be followed inside the package (specification section 158) whatever the processing batch filter is:

- the translation of an exported synthesis, and the model run of that translation;
- the source transcript revision of an exported translation (with its logical transcript, which is on the same row of `transcripts.csv`), and the model run that wrote the revision;
- the processing batches, model configurations and prompt versions of those model runs.

Ancestor rows carry their own `processing_batch_id`, which can differ from the batches named in the filter. An ancestor is never taken from a batch whose data mode the export leaves out, and an output with status `excluded` is not an ancestor unless `includeExcluded` is set. A test rebuilds the lineage from a batch filtered package (`exports.test.ts`, "condition A and the lineage of a batch filtered export").

## Privacy tiers

| Tier | Content |
|---|---|
| `internal_full` | Everything. The only tier with audio and with the audit log. Researcher notes on request. |
| `analysis_pseudonymous` | Removes user agent strings, applied track settings (device ids), storage driver and key, every text written by a researcher (see `includeResearcherNotes`) and the audit log. Keeps participant codes and all research variables. No audio. |
| `collaboration_restricted` | As pseudonymous. Also leaves out every utterance or session that has a flag with reason `contains_third_party_identifier` (resolved or not, on the item or on something derived from it), and answers to `free_text` and `short_text` questionnaire items unless `includeFreeTextAnswers` is set. |
| `public_release` | Not implemented. The service rejects it: the release policy (manual review, redaction, consent filtering) is not defined. |

The removals are markers on the columns in the table registry (`internalOnly`, `researcherNote` in `tables.ts`), listed per field in the data dictionary. Session token hashes, token expiry times, admin session data and idempotency keys have no column and are in no tier.

Audio outside `internal_full` is refused. The specification says only that the internal tier can contain media, so the conservative reading is used until a sharing policy for voice recordings exists.

## Formats

- CSV: UTF-8 without byte order mark, header row, comma separated, RFC 4180 quoting, CRLF record ends, fixed column order.
- Missing value: empty cell in CSV, `null` in JSON. The dictionary says what it means per field. No other placeholder is used.
- Timestamps: ISO 8601 in UTC (`2026-10-03T12:00:00.000Z`).
- Booleans: `true`, `false`. JSON values inside a CSV cell are JSON text.
- Text is exported exactly as stored. Nothing is trimmed or normalized.
- Rows are ordered by internal id. Sort by the documented keys for a reading order.

### Spreadsheet formula risk

A cell that starts with `=`, `+`, `-` or `@` can be run as a formula by spreadsheet software. The usual defence (adding a quote character) would change transcripts, translations and answers, which must stay exact (specification 147). The export therefore does not alter text. Read the CSV files with a script (`pandas.read_csv(path, dtype=str, keep_default_na=False)`, `readr::read_csv`). Do not open them directly in spreadsheet software; if you must, import with every column set to text.

## MANIFEST.json

```json
{
  "manifest_version": 1,
  "schema_version": 2,
  "study": "dialect-translation-study",
  "study_name": "...",
  "export_type": "dataset_package",
  "export_job_id": "...",
  "generated_at": "2026-10-03T12:00:00.000Z",
  "app_version": "...",
  "git_commit": "...",
  "privacy_tier": "internal_full",
  "filters": { "mode": ["research"], "include_test": false, "include_demo": false, "completed_only": true },
  "options": { "include_source_audio": true, "include_generated_audio": true },
  "counts": { "sessions": 3, "utterances": 4, "source_audio_files": 4, "generated_audio_files": 1 },
  "protocol_versions": [{ "id": "...", "version_number": 1, "name": "...", "status": "published" }],
  "processing_batches": [{ "id": "...", "name": "...", "data_mode": "research", "status": "completed" }],
  "model_configurations": [{ "id": "...", "key": "tts_baseline", "version_number": 1, "provider": "...", "model_id": "..." }],
  "prompt_versions": [{ "id": "...", "key": "translation_preserve", "version_number": 3 }],
  "notes": ["..."],
  "files": [
    { "path": "sessions.csv", "size_bytes": 1234, "sha256": "...", "kind": "data", "rows": 3 },
    { "path": "source_audio/P-7K4M9Q_U-03_source.wav", "size_bytes": 384044, "sha256": "...", "kind": "source_audio",
      "media_asset_id": "...", "database_sha256": "...", "utterance_id": "..." }
  ]
}
```

`manifest_version` is the version of the layout of `MANIFEST.json` itself. `schema_version` is the version of the export schema: the files of a package, their fields and the meaning of the filters (`EXPORT_SCHEMA_VERSION` in `dictionary.ts`). It is also printed at the top of `data_dictionary.md`. Raise it when a field is added, removed or renamed, or when a filter changes what it selects, and add a row below. `notes` holds plain sentences about how the package was built (the id lists of batch snapshots, ancestor rows, whether researcher text is included).

### Schema versions

| Version | Change |
|---|---|
| 1 | First schema. Packages built before `schema_version` existed have no such key and are version 1. |
| 2 | `verifiedTranscriptsOnly` keeps raw ASR output. Ancestor rows are exported with a batch filter. Configuration documents have explicit field lists. `exclusion_reason`, `change_reason`, the audit log states, and `notes` of prompts and model configurations need `includeResearcherNotes`. `processing_batches.json` gains `utterance_ids_omitted` and limits the snapshot id lists to the export. |
| 3 | Study texts in more than one language. The configuration records of a protocol version (protocol version, consent version, task, follow-up, questionnaire, questionnaire item) gain `translations_json`. `task_presentations.csv` gains `snapshot_locale`. |
| 4 | The output review (`docs/RESEARCH-DESIGN.md`, section 3): new files `english_checks.csv`, `output_reviews.csv` and `output_review_items.csv`. The protocol version record gains `postReviewQuestionnaireVersionId` and `post_review_questionnaire`. In `output_review_items.csv` the practice and check screens are exported in `internal_full` only: they are prepared examples, not ratings of the participant's own speech. |
| 5 | The simplified review (scale version `output-review-v2`): `output_review_items.csv` has `transcript_said` (yes, partly, no), `version1_meaning`, `version1_representation`, `version2_meaning` and `version2_representation` (1 to 5), `cant_judge`, and a new `ratings` column with every stored answer. The columns `prepared_example_key`, `version1_synthesis_id`, `version2_synthesis_id`, `changed_slot`, `transcript_reads`, `marked_word_positions`, the naturalness and formality columns, `choice` and `audio_acceptability` are removed; the answers of rows of scale version `output-review-v1` are kept in `ratings`. |

## Integrity

While the export copies an audio file it recomputes the SHA-256 and compares it with `media_assets.sha256`. A mismatch, or a file missing from storage, stops the export with an error that names the media asset. Nothing is stored for a stopped export.

A recipient verifies a package after unpacking it, in the package folder:

```sh
jq -r '.files[] | "\(.sha256)  \(.path)"' MANIFEST.json | sha256sum -c -
```

Every line must end in `OK`. The archive itself has a SHA-256 too: it is `media_assets.sha256` of the export archive, shown by `GET /api/admin/export/jobs/:id` and sent in the `X-Checksum-Sha256` header of the download.

The whole package is read from one read-only database snapshot, so the files agree with each other even when data is collected during the export.

## Audit

- `export.create`: every export job (who, when, filters, export type, privacy tier, export job id) and every direct table download.
- `export.download`: every download of an archive (export job id, media asset id, file name, hash).
