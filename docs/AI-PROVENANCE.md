# AI provenance, idempotency and processing batches

This document describes how the offline computational experiment is run and recorded: the pipeline steps, the `model_runs` record, the idempotency design, the job graph of a processing batch, and the lineage read model. Section numbers such as "spec 27" refer to `docs/IMPLEMENTATION-SPEC.md`. The tables are described in `docs/DATA-MODEL.md`, the provider adapters in `packages/ai/README.md`.

Code: `packages/research/src/processing/` (`steps.ts`, `batches.ts`, `handlers.ts`, `derive.ts`, `lineage.ts`, `config.ts`). Request and job payload schemas: `packages/domain/src/validators/processing.ts`.

## The three steps

Each step performs one model call and stores everything about it. The job handlers call these functions, and Demo Mode and the admin pipeline test call the same functions directly.

| Step | Source (`source_entity_type`) | Output |
|---|---|---|
| `runAsrStep` | `utterance` | a new revision of the utterance's `asr` transcript, `created_by_type = model`, `source_model_run_id` set |
| `runTranslationStep` | `transcript_revision` | one `translations` row with the raw model output |
| `runSynthesisStep` | `translation` | one stored audio file, one `media_assets` row of kind `tts_audio`, one `syntheses` row |

Rules that hold for every step:

1. **The provider receives the minimum input (spec 65).** ASR: the audio bytes, the language hint and the context prompt. Translation: the instruction of the prompt version and the transcript text. TTS: the translated text, the voice and the speaking instruction. Participant code, region, questionnaire answers and session metadata are never part of a request. The adapter input types have no field for them, and `steps.test.ts` inspects the exact object each adapter receives.
2. **Output is stored exactly as returned (spec 146 to 148).** Nothing is trimmed, re-punctuated or cleaned. An ASR result with segments or word timestamps keeps them in `transcript_revisions.segments_json` (see "ASR segments" below). An empty, refused or cut-off translation is treated as a failed run and is never stored as a translation: the failed run keeps the text and the provider's answer (see "Failed runs").
3. **No silent defaults (spec 143).** A translation configuration without a prompt version, or a TTS configuration without a voice, fails with `CONFIGURATION_MISSING`. The steps read a `ModelConfigSnapshot`, never "whatever is active now".
4. **No downstream failure touches upstream data (spec 144).** A failed ASR leaves the recording as it is. A failed translation leaves the transcripts. A failed TTS leaves the translation.
5. **A batch only processes data of its own mode.** A step refuses a batch whose `data_mode` differs from the mode of the source session.
6. **The mock provider never processes research data.** The mock provider returns invented text and a test tone. A configuration whose provider is `mock` is refused with `CONFIGURATION_MISSING` when the source session is a research session: by every step before a run is created, by `previewBatch` and `createBatch` for a research batch, and by the automatic ASR job (the job fails at once and is not retried, the recording stays untouched). TEST and DEMO data may use it. Tests that process research data register the same deterministic adapters under another provider name (`packages/research/src/processing/test-helpers.ts`).

### Configuration parameters

`model_configs.parameters_json` may hold `language` and `response_format` (ASR), `voice`, `response_format` and `instructions` (TTS). The steps move `language`, `voice`, the TTS `response_format` and `instructions` out of the parameter record and pass them as typed adapter inputs. Everything else is passed as `parameters` and is checked by the adapter against its allow-list.

Two request values are resolved by the step, so that no run depends on a default inside an adapter. The resolved value is sent explicitly and recorded in `model_runs.parameters_json`:

| Value | When the configuration does not name it | Constant in `steps.ts` |
|---|---|---|
| ASR `response_format` | `json` | `ASR_RESPONSE_FORMAT_WHEN_NOT_CONFIGURED` |
| TTS `response_format` (output format) | `wav` (spec 22) | `TTS_OUTPUT_FORMAT_WHEN_NOT_CONFIGURED` |

The ASR response format decides which fields the provider returns: `json` gives the text only, `verbose_json` adds segments, language and duration on the models that support it. Set it in the model configuration when segments are wanted.

- ASR context prompt: the text of the linked prompt version. An empty text means that no prompt is sent.
- Translation instruction: the text of the linked prompt version through `buildTranslationRequest` (placeholders `{{source_language}}` and `{{target_language}}`).
- TTS instruction: the text of the linked prompt version through `buildSynthesisRequest`. Only a configuration without a prompt version uses its `instructions` parameter. A configuration with both a linked prompt version and an `instructions` parameter is refused with `CONFIGURATION_MISSING`: when it is saved (AI configuration service), when a batch is planned, and by the step before any model call. One of the two texts would otherwise be dropped without notice.

### ASR segments

`segments_json` holds `{ segments, words }` exactly as the adapter returned them, and only the lists the provider returned. The step changes nothing. The OpenAI adapter builds each entry with fixed fields, so a field that the provider left out appears with a default: a missing `start` or `end` is stored as `0`, a missing segment `text` or word `word` as `""`. A `0` or an empty text in `segments_json` can therefore mean "not reported". The other provider fields of a segment are kept unchanged under `providerFields`. (Adapter follow-up: leave absent fields out instead of filling them.)

### ASR transcript status

The ASR transcript (A) is a model output. The ASR step never sets a review status: a new `asr` transcript row keeps the column default `not_started`, and an existing row keeps its status. Verification is a human act and applies to the human transcript types.

Every ASR run adds a revision and makes it the current one. Earlier ASR revisions stay, each with its own `source_model_run_id`.

## The `model_runs` record (spec 27)

One row per attempt, including failed ones.

| When | Columns written |
|---|---|
| Before the provider call (status `running`) | `stage`, `provider`, `requested_model`, `model_config_id`, `prompt_version_id`, `processing_batch_id`, `condition_key`, `source_entity_type`, `source_entity_id`, `parameters_json`, `input_manifest_json`, `attempt_number`, `started_at`, `app_version`, `git_commit_sha`, `idempotency_key` |
| On success (status `succeeded`) | `returned_model`, `provider_request_id`, `parameters_json` (replaced by what the adapter reports as sent), `usage_json`, `latency_ms`, `response_metadata_json`, `estimated_cost`, `finished_at` |
| On failure (status `failed`) | `error_code`, `error_message`, `provider_request_id` when known, `response_metadata_json` (what the provider answered, see "Failed runs"), `parameters_json` (replaced by what the adapter reports as sent, when the error carries it), `returned_model` when known, `latency_ms`, `finished_at` |

A finished row is immutable (database trigger). It is finished exactly once.

`input_manifest_json` identifies the input by ids and hashes, not by copying it: media asset id and SHA-256, transcript revision id and type, SHA-256 of the text, translation id, languages, voice, repetition index, and `effectiveInstruction`, the final instruction after placeholder replacement. The transcript text itself is not copied into the run.

`error_message` never contains key material (it is cleaned with `sanitizeErrorMessage`) and never contains database error text, because a database error can quote transcript text. An unexpected error is stored with a fixed message and its class name.

### Failed runs (spec 146)

A failed run keeps what the error carries, so the researcher can see why there is no output:

```text
response_metadata_json = {
  ...rawMetadata,        // when the provider answered: endpoint, hashes of the request texts,
                         // selected headers, response fields (id, status, model, incomplete_details)
  "failure": {
    "provider", "stage", "retryable",
    "providerStatus",    // HTTP status
    "providerErrorCode", // for example refusal, incomplete_max_output_tokens, empty_output
    "providerRequestId", "responseId",
    "refusal",           // the refusal text of the model
    "partialText",       // output of a refused or cut-off response, exactly as returned
    "rawText"            // output of an empty response, exactly as returned
  }
}
```

- `parameters_json` of a failed run is the request as the step planned it (model, language, prompt, voice, resolved formats and the configured parameters). When the error carries `parametersSent` (the step's own "empty output" errors do), that replaces it. An adapter error does not carry it yet (adapter follow-up).
- Keys that could hold a credential (`authorization`, `api_key`, `secret`, `password`, `token` names, `cookie`) are dropped, and key material inside text is replaced by `[redacted]`. The three output fields `refusal`, `partialText` and `rawText` are stored unchanged.
- An error without details (for example a configuration error from the provider registry) leaves `response_metadata_json` with the `failure` fields that exist, or null.
- Where it is shown: `getUtteranceLineage` returns `failedRuns[].responseMetadata` and `parameters`. Session Detail, "Processing history", shows for each failed run the error, the provider status and error code, the request and response ids, a refusal, the output text that was not stored as a translation, and the parameters (`ModelRunSummary.failure`, read by `toModelRunFailure` in `packages/research/src/corpus/lineage.ts`).

`estimated_cost` is set only when a price table is passed to the step. No price table is configured by default, so the column stays null. Where a value exists the interface labels it as an estimate (spec 102).

A configuration error that is found before any call (no prompt, no voice, two TTS instructions, a mock configuration for research data, empty source text) throws without creating a run: no model call was attempted. An error from the provider registry (for example no API key) or from the adapter happens inside the attempt and leaves a failed run.

## Idempotency (spec 30)

### Keys

The caller passes the base key of the logical work. The builders are in `steps.ts`:

```text
asr:<utterance id>:<model config id>:<batch id or "no-batch">
translation:<revision id>:<condition key>:<model config id>:<batch id>:<repetition index>
tts:<translation id>:<condition key>:<model config id>:<batch id>:<repetition index>
```

The model configuration id pins the prompt version and the parameters, because a configuration that is not a draft cannot change. The condition key is URL-encoded, so it can never introduce a separator.

`model_runs.idempotency_key` (unique) is `<base key>#<attempt number>`. The attempt number is one more than the highest attempt number of the earlier runs with the same base key.

### What a step does

1. Look for the output by its identity (`translations_identity_uq`, `syntheses_identity_uq`) and for a `succeeded` run with the same base key. If found, return the stored output with `created: false`. Nothing is called and nothing is written.
2. Close every earlier run with the same base key that is still `running` as `failed` with `error_code = INTERRUPTED`. Such a run belongs to a process that stopped between the provider call and the commit.
3. Insert the `running` row of the new attempt. Two deliveries that start at the same moment collide on the unique key: one of them stops with `CONFLICT`, the queue tries it again later, and step 1 then returns the stored output.
4. Call the provider. For TTS, write the audio file to storage under a key that contains new ids.
5. In one transaction: finish the run (`UPDATE ... WHERE status = 'running'`) and insert the output row. If the run is no longer `running` (a newer attempt closed it), the transaction stops and nothing is stored.
6. On any error: the transaction is rolled back, a stored TTS file is deleted again, the run is marked `failed`, and the error is thrown again unchanged.

### Why this cannot produce two outputs

| Situation | Result |
|---|---|
| The job is delivered twice after it succeeded | Step 1 returns the stored output. No run, no output. |
| The provider fails with a retryable error | Run 1 is `failed`. The queue retries with backoff. Run 2 (`attempt_number = 2`) succeeds. One output, two visible runs. |
| The process stops after the provider answered and before the commit | The output and the run completion are in the same transaction, so neither exists. The next attempt closes run 1 as `INTERRUPTED` and makes run 2. One output. |
| A slow first attempt answers after a second attempt was started | Its completion finds the run already closed and stores nothing. Only the newer attempt can store an output. |
| Anything else | The unique indexes on `translations` and `syntheses` refuse a second row for the same source, condition, batch and repetition. |

A retry is always visible: every attempt is its own row with its own `attempt_number`, status and error.

Intentional repeated generations (spec 103) use a different `repetition_index`, which is part of the key and of the output identity.

## Processing batches (spec 28, 53, 54)

### Creating a batch

`createBatch` resolves the selection and copies the configuration into `configuration_snapshot_json`:

- the selection filters and the resolved utterance ids;
- one `ModelConfigSnapshot` per configuration, including the prompt text;
- source and target language from the study settings. A translation batch and every research batch (also one that only runs ASR) need both: when one is missing the batch is refused with `CONFIGURATION_MISSING` and the message points at the Settings page. Only a TEST or DEMO batch without translation may store them empty;
- the estimated job counts.

Defaults (spec 53, 150): research mode, completed sessions only, flagged and excluded data left out, verified transcripts only. Withdrawn sessions and utterances without an accepted recording are never selected. Default configurations are the active `translation_default` and `translation_preserve`, the active `tts_baseline`, and the active `asr_default` when ASR is part of the batch. A configuration that is missing, not active, without a prompt (translation), without a voice (TTS), with two speaking instructions (TTS), or with the mock provider in a research batch gives `CONFIGURATION_MISSING` and no batch is created.

A batch has one data mode. A research batch contains research sessions only. Naming a session or an utterance of another mode is rejected.

The batch is stored as `draft`. From the moment it leaves `draft` the snapshot cannot change (service check and database trigger). Activating a new prompt or configuration afterwards changes nothing for an existing batch: the handlers read the snapshot.

### Preview warnings

`previewBatch` returns `warnings`, shown in the review step of the Create Batch wizard. A warning never blocks the batch. The codes and counts are also written to the `batch.create` audit row.

| Code | Meaning |
|---|---|
| `normalized_from_older_dialect_revision` | The current normalized transcript (C) records the dialect revision (B) it was copied from (`derived_from_revision_id`, set by the copy button of the review screen), and that revision is no longer the current B revision. |
| `normalized_older_than_dialect_revision` | The current C revision records no B revision, and the current B revision was created after it. |

Both are checked only for utterances whose C transcript the batch would translate. They mean that C may no longer be the normalization of the B text that the batch translates, which would mix a transcription change into the B versus C comparison.

Decisions the specification leaves open:

| Decision | Choice | Reason |
|---|---|---|
| Which revision is translated | The current revision of each selected transcript type at the time the batch starts. | The revision id is stored on the translation, so later edits never change what was processed. |
| `verifiedTranscriptsOnly` | A human transcript (A*, B, C) counts only when its current revision has `verified_at`. The ASR transcript (A) is always eligible. | A is a model output with no human verification. A transcript that was edited after verification is not translated until it is verified again, which is the conservative reading of spec 79 and 150. |
| Empty transcript text | The revision is skipped. | There is nothing to translate. |
| Condition of a configuration | `condition_key`, or the configuration key when it has none. Each condition appears once per batch. | The condition is part of the output identity. |
| Date filter | Session start time. A date without a time is a whole day in UTC. | The date range of spec 53 is a session filter. |
| A batch without work | `startBatch` refuses it and it stays a draft. | A batch with zero jobs would look completed without having done anything. |

### Job graph

```text
startBatch (one transaction: status queued, started_at, jobs)
  |
  +-- asr job per utterance                          (only when runAsr)
  |     on success: translation jobs for the ASR revision this job produced
  |
  +-- translation job per (current revision of a selected human type) x (translation config)
  |   translation job per (current ASR revision) x (translation config)   (only when runAsr is off)
  |     on success: tts job per TTS config of the batch
  |
  +-- tts job per (translation) x (TTS config)
```

TTS jobs are enqueued by the translation handler when its translation exists, and the translations of the ASR transcript by the ASR handler. The queue has no notion of a dependent job, and a job that is created when its input exists needs none. Every job has a deterministic idempotency key (`batch:<batch id>:<stage>:<source id>...`), so enqueueing it again returns the existing job.

The same TTS configurations are applied to every translation of the batch. The voice, the model and the instruction therefore never differ between translation conditions (spec 22).

The translation handler checks that the revision belongs to an utterance of the batch and, when the job names an utterance, to that utterance. The check runs before any model call.

### Status

`refreshBatchStatus` derives the status from the job counts: `queued` while no job was claimed, `running` while jobs are queued or running, then `completed` or `completed_with_errors`. It is called by each handler when its job starts and ends, and by the list and detail reads.

A handler runs before the queue records the result of its job, so it tells `refreshBatchStatus` which status the job is about to get. When the last two jobs of a batch end at the same moment on two workers, neither sees the other as finished and the batch stays `running` until the next read of the list or the detail, which corrects it.

- **Retry failed** (`retryFailedJobs`): only `failed` jobs go back to the queue, under the same frozen configuration. Succeeded jobs are not run again. A failed ASR job that succeeds on retry then enqueues its translations.
- **Cancel** (`cancelBatch`): queued jobs become `cancelled`, running jobs finish, no follow-up job is added. The batch and its outputs stay visible. A cancelled batch cannot be started or retried.

Audit rows: `batch.create`, `batch.start`, `batch.cancel`, `batch.retry_failed`.

### Automatic ASR and WAV derivation

- An `asr` job without `processingBatchId` (automatic ASR after an upload, spec 79) uses the configuration named in its payload, or the `asr_default` configuration that is active when the job runs. With none active the job fails with `CONFIGURATION_MISSING` and is not retried. A mock configuration is refused the same way for a research session. It starts no translation, unless `AUTO_TRANSLATE_AFTER_ASR=true`: then, when the ASR text is not empty, the job creates and starts a processing batch for that one utterance (name `Auto <participant code> <utterance id> rev <revision id>`, ASR transcript only, the active translation and TTS configurations, the data mode of the session). The batch has the same snapshot and provenance as one started on the Processing page. A failure to start it is logged and never fails the ASR job.
- A `derive_wav` job stores a `source_audio_derived` asset with `derived_from_media_asset_id` and the derivation provenance (tool, version, command, time) in `metadata_json.derivation`. The raw upload is not touched and stays the accepted asset. The derived asset keeps the capture quality class of its source, so it is not mistaken for a lossless capture. A second delivery creates nothing.

### Job payloads

```text
asr          { utteranceId, mediaAssetId?, modelConfigId?, processingBatchId?, trigger? }
translation  { sourceTranscriptRevisionId, utteranceId?, modelConfigId, processingBatchId, repetitionIndex }
tts          { translationId, modelConfigId, processingBatchId, repetitionIndex }
derive_wav   { mediaAssetId }
```

Payloads hold identifiers only, never text. A payload that does not match its schema fails the job at once.

## Synthesized audio metadata

The technical metadata of a TTS file is read from the returned bytes. For a WAV file the header gives the sample rate, the channels and the sample size, and the duration is computed from the bytes that are present, because a streamed WAV can declare a data size that is not the real one. For other formats `ffprobe` is used when it is installed. A field that cannot be determined stays null. Size and SHA-256 come from the storage layer.

## Lineage read model (spec 158, 169)

`getUtteranceLineage(ctx, utteranceId)` returns, in one structure: the utterance and its exact prompt, the session, the task presentation snapshots, the accepted source asset with hash and capture data, every transcript type with all revisions (and for an ASR revision its model run, configuration and prompt version), the translations grouped by batch with condition, source revision, model run, prompt version and configuration, each synthesis with its asset, voice and model run, and the failed runs, each with its parameters and the stored provider response.

| Question of spec 158 | Field |
|---|---|
| Which participant and session | `session.participantCode`, `session.id` |
| Which source utterance | `utterance.id` |
| Which exact source audio file and hash | `sourceAsset.storageKey`, `sourceAsset.sha256` |
| Which task and exact prompt | `task.*Snapshot`, `utterance.promptSnapshot` |
| Which transcript condition and revision | `translation.source.transcriptType`, `.transcriptRevisionId`, `.revisionNumber` |
| Which translation condition | `translation.conditionKey` |
| Which translation prompt version | `translation.provenance.promptVersion` (key, version number, text) |
| Which model and configuration | `translation.provenance.modelRun`, `.modelConfig` |
| Which processing batch | `batches[].batch` |
| Which exact translated text | `translation.translatedText`, `synthesis.sourceText` |
| Which TTS model, configuration and voice | `synthesis.provenance`, `synthesis.voiceKey` |
| When it was generated | `provenance.modelRun.startedAt`, `.finishedAt`, `createdAt` |
| Which app version produced the run | `provenance.modelRun.appVersion`, `.gitCommitSha` |

## Methodological warnings (spec Appendix D)

- A model alias is not a permanently reproducible identifier. The run stores the requested model, the returned model when the provider reports one, the request id and the time.
- Model output is not deterministic. A retry after a failure is a new call, and its output is the only one stored for that work.
- A new prompt or model experiment is a new batch. A batch never changes the outputs of another batch.
- Do not attribute to TTS a loss that happened before synthesis: the synthesis row stores the exact text it received.
