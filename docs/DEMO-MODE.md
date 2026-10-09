# Demo Mode, the pipeline test and the sample TEST sessions

This document describes Demo Mode (`/demo`), the admin pipeline test on the AI Pipeline page, the mock provider option, and the sample TEST sessions of the development seed. Section numbers such as "spec 80" refer to `docs/IMPLEMENTATION-SPEC.md`. The pipeline steps and the `model_runs` record are described in `docs/AI-PROVENANCE.md`, the tables in `docs/DATA-MODEL.md`.

Code:

- services: `packages/research/src/demo/` (the `demo` namespace of `@dialect/research`) and `packages/research/src/seed-samples/`;
- request schemas and response types: `packages/domain/src/validators/demo.ts` (`demoSchemas`);
- routes: `apps/web/app/api/demo/**` and `apps/web/app/api/admin/ai/test/route.ts`;
- pages: `apps/web/app/demo/**` and `apps/web/app/admin/(shell)/ai-pipeline/_components/PipelineTest*.tsx`;
- script: `scripts/seed-test-sessions.ts`.

## What Demo Mode is, and what it is not

Demo Mode is a tool for seminars, development and operator checks (spec 3.2, 81). A speaker records a short piece of Finnish. The page then shows the ASR transcript, two translations side by side ("Default translation" and "Preserve variation"), and plays the synthesized audio of each. A "Show pipeline" section names the model, the prompt version and the time of every stage.

It is not the research interface, and it is not the research architecture (spec 162):

- It is a separate code path. It does not use the participant task flow, the participant API (`/api/study/*`) or the participant cookie.
- In Research Mode a participant never sees AI output. Demo Mode shows it on purpose, which is why its data can never be research data.
- It runs the pipeline in the request. Research processing runs in batches through the job queue and the worker.
- The page makes no claim about dialect loss and does not say which translation is better. It shows two outputs of two instructions. Standardization in a translation is not automatically "dialect loss", and one demo recording is not evidence of anything (spec Appendix D, warnings 1, 5 and 7).

What Demo Mode shares with the research path is the part that matters for trust in the records: the same audio validation, the same storage layer, and the same step functions (`runAsrStep`, `runTranslationStep`, `runSynthesisStep`), so every intermediate record has the same provenance as in a research batch (spec 163).

## Who can open it

| Study setting `demoPublic` | Who can open `/demo` and call `/api/demo/*` |
|---|---|
| `false` (the seed default) | A signed-in researcher only. Anyone else is redirected to `/admin/login?next=/demo`, and the API answers 401. After signing in the researcher arrives at `/demo`: the login accepts `/demo` (with a query string) as the only destination outside `/admin`. |
| `true` | Anyone. A visitor is rate limited per client address (30 new demo sessions and 240 recording requests per hour) and by the cost limits below. |

The DEMO banner is shown at the top of the page at all times.

Before the microphone is used, the visitor must accept a recording notice. It says that the voice is recorded, that the recording is sent to an external AI service for the demonstration, that the data is demo data and not research data, and whether this server keeps demo recordings. Nothing is created and the microphone is not requested before the visitor presses "I agree, use the microphone".

Where the acceptance is stored: a demo session has no row in `session_consents`, because that table holds the versioned research consent. The acceptance time, the notice version and the exact notice text are stored in `sessions.browser_info_json.demoAcknowledgement`. The notice text is the constant `DEMO_RECORDING_NOTICE` in `packages/domain/src/validators/demo.ts`.

## What is stored, and how it is marked

Everything a demo creates is marked demo in two places:

- the session has `mode = 'demo'`;
- the processing batch has `data_mode = 'demo'`. A step refuses a batch whose data mode differs from the mode of the session.

Research exports leave out demo and test sessions and batches by default. The admin Sessions page shows the session with the DEMO badge.

### Data model mapping of a demo recording

The database schema is the one of the research platform. A demo recording uses it like this:

| Row | Content |
|---|---|
| `sessions` | One row per demo session, `mode = 'demo'`, created through the session service. Status `created`, then `recording` after the first recording, then `completed` when the session ends and its data is kept. |
| `task_presentations` | One row per demo session. `protocol_task_id` is a required foreign key, so the row points at a carrier task of the session's protocol: the free speech task when the protocol has one, otherwise the first enabled task. The snapshot texts say "Demo recording" and that this is not a study task. The carrier task was not shown to the speaker. |
| `utterances` | One row per recording, `turn_index` 0, 1, 2, ... in that presentation, status `submitted`. |
| `media_assets` | One row per recording: `source_audio` for lossless WAV, `source_audio_raw` for the compressed capture (spec 31.2). Validated from the bytes, SHA-256 stored, file in private storage. |
| `processing_batches` | One batch per demo session, named `demo-<participant code>`, `data_mode = 'demo'`, with a frozen configuration snapshot whose selection names the session. It has no jobs. When a configuration is activated between two recordings of one session, the next recording gets a new batch (`demo-<participant code>-2`), because a batch never changes its configuration. |
| `transcripts`, `transcript_revisions`, `model_runs`, `translations`, `syntheses`, `media_assets` (`tts_audio`) | Written by the step functions, exactly as in a research batch. |

The insert order of a recording follows the constraints: the utterance without its recording, then the media row, then the link, which makes the utterance `submitted` and therefore immutable.

`getUtteranceLineage` shows a demo recording like any other utterance.

### Limits

A demo recording has the limits of a recording of the study: the study settings `maxUtteranceSeconds` (seed: 300 seconds) and `maxUploadMb` (seed: 100 MB). `getDemoAccess` returns both to the page, and `storeSessionRecording` enforces them on the server from the bytes of the file. A pipeline test clip is short on purpose, at most 30 seconds and 9 MB (`PIPELINE_TEST_MAX_RECORDING_SECONDS`, `PIPELINE_TEST_MAX_UPLOAD_BYTES` in `packages/domain/src/validators/demo.ts`), and never above the study settings. An upload above the limit is refused by its announced size with a plain message, before anything is read.

Next.js cuts the body of a request that `apps/web/proxy.ts` matches at 10 MB (see `docs/PARTICIPANT-API.md`, "Large uploads"). The two upload routes are therefore left out of the proxy matcher, each by its exact path, and neither depends on the proxy for protection:

| Route | What protects it without the proxy |
|---|---|
| `POST /api/demo/recordings` | The proxy never did anything for `/api/demo`. The handler checks the demo access setting (`requireDemoCaller`: a signed-in researcher, or anyone only when `demoPublic` is true), the demo cookie (`requireDemoSession`), the request origin (`sameOrigin`) and the rate limit of a visitor. |
| `/api/admin/ai/test` | The proxy gate is only the first of two layers. `apiRoute({ auth: "admin" })` verifies the admin session cookie and, for `POST`, the request origin, before the body is read. A request without a session gets 401 from the handler. |

Every other route under `/api/demo` and `/api/admin` is still matched by the proxy. The tests are in `apps/web/proxy.test.ts` (the matcher) and `apps/web/app/api/demo/demo.routes.test.ts` (access, limits, an upload above 10 MB).

## The pipeline of a demo recording

`runDemoPipeline(ctx, { sessionId, utteranceId, configs?, stage?, isAdmin? })` runs, in the request:

1. ASR with the active `asr_default` configuration;
2. one translation of the ASR transcript revision per condition: the active `translation_default` and `translation_preserve` configurations;
3. one synthesis per translation with the active `tts_baseline` configuration. The voice, model and instruction are the same for both conditions (spec 22).

Rules:

- **No silent defaults (spec 143).** A stage without an active configuration fails with `CONFIGURATION_MISSING` and a message that names the missing key. There is no fallback model or prompt.
- **Independent stages (spec 144).** A failed stage is part of the result. It never removes what an earlier stage produced: the transcript is shown when a translation fails, and one condition is shown when the other fails.
- **Safe messages.** A stage error has a plain message. The cleaned provider message is added only for a signed-in researcher. When the provider of a configuration has no credentials, the message is "The OpenAI API key is not configured on the server", followed by where an administrator sets it.
- **Stage by stage.** The demo page asks for `asr`, `translation` and `tts` in three requests, so each result appears as soon as it exists. The steps are idempotent: a later request finds the stored output and never repeats a model call that succeeded.

### Cost limits of a public demo

Every stage of the pipeline is a paid call to the external provider, and a public demo is open to anyone. Three limits apply (code: `apps/web/app/api/demo/_lib/demo.ts` and `packages/research/src/demo/budget.ts`):

| Limit | Value | Applies to | Answer when reached |
|---|---|---|---|
| Requests per client address | 240 per hour (`DEMO_RECORDING_LIMIT`). **Every** upload and every pipeline request counts, whatever its stage, also a repeated request of a stage that failed. One recording is 4 requests on the demo page, so this is about 60 recordings per hour. | Visitors. A signed-in researcher is not limited. | `429 RATE_LIMITED` with `Retry-After` |
| Attempts per step of one recording | 3 (`MAX_STEP_ATTEMPTS`): the transcription of a recording, each translation and each synthesis. The demo service counts the model runs that exist for the step. | Everyone | The stage result is `failed` with the reason `attempt_limit` and the message that a new recording is needed. No provider call is made. |
| Daily budget of the study | `demoDailyRunLimit` pipeline runs in 24 hours over all visitors. Study setting in `studies.settings_json`, default 200, accepted range 1 to 100000, editable on the Settings page. One run is one recording whose transcription was started. | Visitors, and only runs with a provider that is not the mock provider. A signed-in researcher is not counted and not refused. | `429 RATE_LIMITED`, `details.reason = "demo_daily_budget"`, message "The demonstration has reached its limit of N runs in 24 hours. Please try again later." |

The daily count is kept in `rate_limit_hits` (bucket `demo-daily-runs:<study id>`), not derived from the model runs, because the rows of a demo session are deleted when the study does not keep demo data. With the three limits the provider calls of a public demo in 24 hours are at most `demoDailyRunLimit` times 15 (3 attempts for each of 1 transcription, 2 translations and 2 syntheses).

## The persist setting and purge

The study setting `demoPersist` (spec 80) decides what happens to the data of a demo session when the session ends. The session ends when the visitor chooses "Clear and start again", when the page is left (the page sends a beacon), or when a new demo session is started in the same browser.

| `demoPersist` | When the session ends |
|---|---|
| `true` (the default) | The session becomes `completed` and its token stops working. All rows and files stay, and the session is visible in the admin Sessions page with the DEMO badge. To remove kept demo data, use the TEST and DEMO data reset on the Settings page. |
| `false` | `purgeDemoSession` deletes the session: its rows, its batches, and after the commit its stored audio (source and synthesized). |

"Record another" keeps the session and adds a recording.

`purgeDemoSession(ctx, sessionId)`:

- only accepts a session whose mode is `demo`. A research or test session is refused with `FORBIDDEN`;
- runs in one transaction that turns on `dialect.allow_test_data_reset` (`allowTestDataReset` of `packages/db/src/test-data-reset.ts`). Without it the immutability triggers refuse every delete, and with it they still refuse a research row;
- deletes in the order given in `docs/DATA-MODEL.md`, limited to that one session and to the demo batches whose frozen selection names it;
- writes an audit row (`test_data.reset`, entity `session`, with the participant code and the row counts, never transcript text);
- removes the storage objects after the commit.

Leftovers: if the browser closes before the beacon is sent, a demo session stays behind. While `demoPersist` is false, a researcher can remove ended sessions and sessions without activity for 30 minutes with "Remove leftover demo data" under Options on the demo page (`POST /api/demo/purge-leftovers`, confirmed in a dialog).

Known limit: a purge that runs while a pipeline request of the same session is still working makes that request fail. Nothing is left half-written, because the foreign keys refuse the late inserts and a stored audio file of a failed step is removed again.

## Demo audio for the visitor

`GET /api/demo/media/:id` streams a file only when it belongs to the demo session of the caller's demo cookie: a source recording of that session, or the synthesized audio of one of its translations. Every other id, including every research asset and the audio of another demo session, gives 404. The session is never read from the request.

The demo cookie is `dts_demo` (HttpOnly, SameSite Lax). It is separate from the participant cookie, so a demo on a study laptop never replaces a research session, and a research session token is never accepted by a demo route.

## The pipeline test (spec 52)

On the AI Pipeline page, "Run pipeline test" stores one short clip and runs storage, ASR, default translation, preservation translation and TTS. It shows five rows, each PASS or FAIL, with the latency, the model used, and on failure the safe error message:

```text
ASR                   PASS / FAIL
Default translation   PASS / FAIL
Preserve translation  PASS / FAIL
TTS                   PASS / FAIL
Storage               PASS / FAIL
```

- The clip is recorded in the browser (compressed or lossless), or generated on the server with "Use a generated test tone" for a machine without a microphone. A real ASR model hears no speech in a tone, so its transcript is empty or meaningless and the translation rows can fail for that reason alone. The page says so.
- Everything the test creates has the mode `test`: a test session, a batch `pipeline-test-<participant code>` with `data_mode = 'test'`, and their outputs. Test data is never part of a research export unless a researcher explicitly includes it.
- Each run writes an audit row `pipeline_test.run` with the result (without transcript text). The page shows the last result with its time, read from the audit log.
- The TTS row covers the synthesis of every translation that exists. The Storage row covers the write and read-back of the test clip.

## The mock provider and how its output is labelled

The mock provider never calls a model. It returns generated placeholder text and a test tone. It is available only when the server allows it (`AI_ALLOW_MOCK_PROVIDER`, by default on outside production and off in production).

| Where | How to use it | Who |
|---|---|---|
| Demo page | Open `/demo?provider=mock`, or choose "Mock provider" under Options. | A signed-in researcher only. A visitor's request with `provider: "mock"` is refused with 403. |
| Pipeline test | Choose "Mock provider" under Configurations. | Researchers (the page is admin only). |
| Development seed | Always. | The seed script. |

Labels: the demo page shows "MOCK PROVIDER, not real model output" above the recorder and the results. The pipeline test result has the badge "Mock provider, not real model output". In the data, every mock run has `provider = 'mock'` and `returned_model = 'mock'`, and the text starts with `[mock-transkriptio ...]` or `[mock translation ...]`.

### The stored mock configurations

The mock option needs model configurations with the provider `mock`, without touching the active ones, and every model run must point at a real row (`model_runs.model_config_id`). The choice: four configurations under reserved keys (`mock_asr`, `mock_translation_default`, `mock_translation_preserve`, `mock_tts`), inserted with the status `retired` on first use and reused afterwards.

| Alternative | Why not |
|---|---|
| Draft configurations | A draft can be edited and deleted, which is wrong for a row that model runs point at, and the pipeline steps refuse drafts. |
| Snapshots that exist only in memory | `model_config_id` would point at nothing, so the provenance of a mock run would be incomplete. |
| Active configurations under other keys | An active configuration can be selected for a research batch. A retired one cannot, and it can never become active again. |

Consequence: the four keys appear on the AI Pipeline page in their own closed group, "Mock provider configurations (development and plumbing tests only)", below "Optional experimental conditions", with one retired version each. They are named "Mock ... (MOCK PROVIDER, not real model output)". The group is shown only when the rows exist.

## Sample TEST sessions (spec 91)

`pnpm db:seed` runs the database seed and then `scripts/seed-test-sessions.ts`, which calls `seedSampleTestSessions(ctx, { count: 3 })`.

- Each session is created by the real services: session creation as an admin with mode `test`, consent, microphone check, instructions, every task with a generated sine tone as the recording, both questionnaires with answers chosen by item type, completion.
- Sessions 1 and 2 get human transcripts B and C with placeholder text such as `[sample B transcript 1]`. In session 1 they are verified, in session 2 they are drafts. Both sessions get a `test` batch named `sample-<participant code>` that runs ASR for every recording and, for the first three recordings, both translation conditions and their syntheses on the A, B and C texts, with the mock configurations.
- Session 3 stays as collected, without transcripts.
- Idempotent: a sample session carries a marker in `sessions.browser_info_json.sampleSeed`, and a second run creates nothing.
- The automatic ASR jobs that the submissions queue (study setting `autoQueueAsr`) are cancelled, because the recordings are tones and are transcribed with the mock provider instead.
- It never creates research rows, never calls a real model and contains no real participant data. The script refuses to run with `NODE_ENV=production`.

## API

| Method and path | Access | Purpose |
|---|---|---|
| `GET /api/demo/session` | demo | The open demo session of the cookie (or null) and what the page may offer. |
| `POST /api/demo/session` | demo | Start a demo session. Body `{ acknowledged: true }`. Sets the demo cookie. |
| `DELETE /api/demo/session`, `POST /api/demo/session/end` | demo | End the session: keep or delete its data, as `demoPersist` says. |
| `POST /api/demo/recordings` | demo | Store one recording (multipart: `audio`, `metadata`). One upload at a time per demo session: a second concurrent upload gets `409 CONFLICT`. The device data in `metadata` are reduced as in the participant API (class of the input device, no device identifiers). |
| `POST /api/demo/recordings/:id/run` | demo | Run the pipeline. Body `{ stage?, provider? }`. Returns `{ result: DemoResult }`, or `429` when a cost limit is reached. |
| `GET /api/demo/media/:id` | demo | Stream audio of the caller's own demo session. |
| `GET`, `POST /api/demo/purge-leftovers` | admin | Count and remove leftover demo sessions. |
| `GET /api/admin/ai/test` | admin | The last pipeline test result. |
| `POST /api/admin/ai/test` | admin | Run the pipeline test. JSON `{ source: "generated_tone", provider? }` or multipart with `audio`. |

"demo" access means: a signed-in researcher, or anyone when `demoPublic` is true. State-changing requests must come from the app's own origin.

## Seminar checklist

1. `OPENAI_API_KEY` is set in the server environment. The AI Pipeline page shows "OpenAI API key configured".
2. The four configurations `asr_default`, `translation_default`, `translation_preserve` and `tts_baseline` are active on the AI Pipeline page, each with the intended model and prompt version.
3. Run the pipeline test with the active configurations and a spoken clip. All five rows must show PASS. This is the test that matters: the mock option only checks storage, database and page.
4. Check the microphone of the seminar laptop in Chrome: open `/demo`, accept the notice, record one sentence and listen to it before sending.
5. Decide whether demo recordings are kept (`demoPersist`) and whether the page is open without sign-in (`demoPublic`), on the Settings page. Tell the audience what the notice says.
6. Sign in as a researcher before the seminar if the demo is not public. After signing in, open `/demo` again: the login page returns to the admin area, not to `/demo`.
7. Keep recordings short. One or two sentences give the clearest comparison and the shortest wait.
8. Afterwards, inspect the session in the admin Sessions page (mode DEMO), or remove demo data with the reset on the Settings page.
