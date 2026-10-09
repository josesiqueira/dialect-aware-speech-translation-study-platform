# Dialect Translation Study Platform: Implementation Plan

**Goal:** build the research platform described in `docs/IMPLEMENTATION-SPEC.md` (the authoritative specification, 173 sections plus appendices).

**Spec:** `docs/IMPLEMENTATION-SPEC.md`. Section numbers below (for example "spec 37.9") refer to it. Every worker reads the sections named in its brief before writing code.

**Architecture:** one pnpm monorepo. A Next.js App Router web app serves the participant flow and the `/admin` researcher interface. A separate Node worker process runs background jobs from a PostgreSQL queue. All business rules live in service functions in `packages/research`, which the web route handlers and the worker both call. Audio bytes live behind a storage adapter (local filesystem or S3-compatible), never in PostgreSQL.

**Tech stack (versions installed on 2026-10-03):** Node 22, pnpm 11, TypeScript 5 (strict), Next.js 16.3 (App Router), React 19, Tailwind CSS 4, PostgreSQL 17, Drizzle ORM 0.45 with node-postgres, drizzle-kit generated SQL migrations, Zod 4, OpenAI SDK 7, Vitest 5, Playwright, ESLint 9.

## Global constraints

These apply to every task and every file.

1. **Scientific invariants (spec 110).** A published protocol never mutates. A stored source recording never mutates. A model output never mutates. Human corrections create revisions. Every derived output traces to a source and a configuration. TEST and DEMO data never enter a research export by default. A new model or prompt experiment creates a new processing batch. Participant speech collection does not depend on AI availability. Research Mode never shows AI output to the participant. Audio is never publicly addressable. No permanent provider key reaches browser code. The admin can inspect exactly what happened to any utterance.
2. **Fixed methodological decisions (spec 167)** and **non-goals (spec 165)** are binding. No participant accounts, no model-generated follow-ups, no voice cloning, no dialect classifier, no statistical analysis dashboard.
3. **Nothing scientific is hard-coded (spec 143, 166).** Study texts, tasks, questionnaires, models, prompts, voice and limits come from the database. Seed data only bootstraps development.
4. **No silent deviation (spec 172).** If a requirement is technically problematic, implement the scientifically conservative option and record it in `docs/IMPLEMENTATION-STATUS.md` under "Deviations".
5. **Writing rules for all text, code comments and docs:** never use the em dash character or the en dash as a sentence break. Use commas, colons, parentheses or separate sentences. Use plain, established software words: "mock data" not "fixture", "execution log" not "ledger". Do not coin terms.
6. **Grounded, not reinvented:** follow the official documentation of each tool (Next.js docs shipped in `apps/web/node_modules/next/dist/docs/`, Drizzle, OpenAI SDK types in `node_modules/openai`, WCAG 2.1 AA, Web Audio API). Check what the installed version actually provides before writing code against it. Next.js 16 differs from older versions: read the relevant guide first.
7. **UI lineage (spec 0.1 to 0K)** is a hard requirement. Reference implementation: `/home/jose/Dev/Manipulative AI/Manipulative-ai2/societal-discussion/apps/web/` at commit `6938720847d8f98b7bda7d54f7a82261fa00c6c3` (equal to `origin/main` on 2026-10-03; spec baseline was `6213e89`). Use the shared primitives in `apps/web/components/`. Do not introduce a UI framework, dark mode, web fonts, gradients in admin, or decorative color.

## Repository layout and ownership

```text
apps/web/                     Next.js app (participant flow, admin, API route handlers)
  app/                        routes
  components/ui/              shared primitives (Button, Card, Badge, FormField, ...)
  components/admin/           admin shell and admin-only components
  components/participant/     participant shell and participant-only components
  design-system/              AESTHETIC.md, COMPONENTS.md, ACCESSIBILITY.md, tokens.css, tailwind-tokens.css
  lib/server/                 server-only helpers (env, context, auth, api wrapper)
  lib/client/                 browser helpers (apiFetch, recorder)
  lib/i18n/                   participant UI dictionaries (fi, en)
apps/worker/                  background worker (polls the jobs table)
packages/domain/              enums, error codes, Zod validators shared by client and server
packages/db/                  Drizzle schema, SQL migrations, seed, test database helper
packages/storage/             StorageAdapter, local and S3 drivers, audio probing utilities
packages/ai/                  Transcriber, Translator, SpeechSynthesizer interfaces and adapters
packages/research/            service functions: all business rules and invariants
docs/                         specification, plan, status, design and operations documents
```

Package names: `@dialect/domain`, `@dialect/db`, `@dialect/storage`, `@dialect/ai`, `@dialect/research`, `@dialect/web`, `@dialect/worker`. Packages are consumed as TypeScript source (no build step); imports are extensionless.

## Shared contracts

- **Enums and error codes:** `packages/domain/src/enums.ts`, `packages/domain/src/errors.ts` (`AppError`, `ErrorCode`, `ApiErrorBody`). Services throw `AppError`.
- **Database schema:** `packages/db/src/schema/*.ts` and `packages/db/src/json-types.ts`. The schema is the contract between all work packages. Only the database work package changes it in wave 1. After wave 1 the schema is frozen: a worker that believes a schema change is needed reports it instead of editing.
- **Service context:** `packages/research/src/context.ts`. Every service function has the signature `fn(ctx: ServiceContext, input) => Promise<result>`.
- **Audit log:** `recordAudit(tx, entry)` from `packages/research/src/audit.ts`, called inside the same transaction as the change.
- **Storage:** `StorageAdapter` in `packages/storage/src/StorageAdapter.ts`.
- **Tests with a database:** `createTestDatabase()` from `@dialect/db/testing` gives each test file its own migrated database. Requires `pnpm db:up` (PostgreSQL on host port 5546).
- **API responses:** success is `200` with a JSON body; failure is `{ "error": { "code", "message", "details?" } }` with the HTTP status from `AppError.httpStatus`.

## Routes

Participant (public): `/` welcome, `/study` the whole sequential flow as one server-driven page (no study state in the URL, spec 61), `/demo` Demo Mode.

Admin: `/admin/login`, then inside the shell `/admin` (Dashboard), `/admin/sessions`, `/admin/review`, `/admin/study-flow`, `/admin/ai-pipeline`, `/admin/processing`, `/admin/questionnaires`, `/admin/data`, `/admin/settings`.

API: as listed in spec 60, plus `/api/health` and `/api/health/ready` (spec 113).

## Waves

Work is done by parallel agents. Each agent owns a disjoint set of paths.

### Wave 0 (lead, done)
Monorepo, tooling, Docker Compose PostgreSQL, domain enums and errors, full Drizzle schema with initial migration, test database helper, service context, audit helper, storage interface.

### Wave 1: foundations (parallel)
| Work package | Owns | Delivers |
|---|---|---|
| W1-DB | `packages/db/**`, `docs/DATA-MODEL.md` | immutability triggers migration, migration tests, development seed, invariant tests |
| W1-STORAGE | `packages/storage/**`, `docs/AUDIO-CAPTURE.md` (server part) | local and S3 drivers, hashing, WAV parsing, ffprobe validation, WAV derivation |
| W1-AI | `packages/ai/**` | provider interfaces, OpenAI adapters, deterministic mock provider, prompt builder |
| W1-UI | `apps/web/design-system/**`, `apps/web/components/**`, `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/app/admin/**` shell and login page, `docs/UI-LINEAGE.md`, `docs/UI-PARITY-MATRIX.md` | tokens, primitives, both shells |
| W1-PLATFORM | `apps/web/lib/server/**`, `apps/web/lib/client/api.ts`, `apps/web/proxy.ts`, `apps/web/app/api/health/**`, `apps/web/app/api/admin/login`, `logout` | env validation, service context, admin auth, API wrapper, rate limit, health |
| W1-QUEUE | `packages/research/src/jobs/**`, `apps/worker/**` | job queue (enqueue, claim, complete, fail, retry), worker loop, heartbeat |

### Wave 2: vertical slices (parallel)
Each slice delivers service functions with tests in `packages/research/src/<area>/`, Zod validators in `packages/domain/src/validators/<area>.ts`, route handlers, and its admin page.

| Slice | Scope (spec sections) |
|---|---|
| W2-PARTICIPANT-API | session lifecycle, consent, task sequence, upload, questionnaires, withdraw (6 to 14, 60 to 63, 86, 107, 108) |
| W2-RECORDER | browser recorder: AudioWorklet PCM WAV, MediaRecorder fallback, mic check (9, 10, 31, 32, 0B.4) |
| W2-STUDY-FLOW | protocol and consent versioning, editor, publish, diff, preview (47 to 49, 76, 130, 141) |
| W2-QUESTIONNAIRES | questionnaire versioning, editor, shared renderer (11, 12, 55) |
| W2-CORPUS | dashboard, sessions list and detail, media streaming, flags, exclusion, notes, settings (42 to 45, 59, 70, 71, 84, 135) |
| W2-REVIEW | transcript revisions, verification, difference coding, review queue (16 to 19, 46) |
| W2-AI-CONFIG | prompt and model config versioning, AI Pipeline page (50, 51, 142, 143) |
| W2-PROCESSING | batches, job handlers for ASR, translation, TTS, model runs, idempotency, Processing Runs page (20 to 30, 53, 54, 144 to 148) |
| W2-EXPORT | CSV and JSON exports, dataset package, audio archives, manifest, data dictionary, Data and Export page (56 to 58, 89, 115, 131) |

### Wave 3 (parallel)
Participant pages and localization (uses W2-PARTICIPANT-API, W2-RECORDER, W2-QUESTIONNAIRES). Demo Mode and pipeline test (uses W2-PROCESSING). Sample TEST sessions in the seed.

### Wave 4 (parallel)
Playwright end-to-end tests, full integration test (spec 90.2), Dockerfiles, security headers, README and `docs/*`, side-by-side visual review against the reference application with screenshots.

### Wave 5
Independent code reviews (scientific invariants, security and privacy, UI lineage, spec coverage against sections 156 to 160 and 173), fixes, final verification.

## Review focus

Conditions most likely to cause harm that the tests must cover:

1. An upload that fails halfway: the participant must be able to retry without re-recording, and no half-written media row may be linked as accepted.
2. A page refresh or a second tab during the study: the session resumes at the right step and consent is never shown as accepted unless stored.
3. A job retried or delivered twice: no duplicate translation or synthesis rows.
4. An admin editing a protocol, prompt or transcript that is already published, active or verified: a new version or revision is created, the old record is unchanged.
5. An export run with default filters on a database that contains demo and test sessions: none of their rows or audio files appear.

## Wave 2 contracts (read before writing a slice)

### Where code goes
- Services: `packages/research/src/<area>/` with an `index.ts` that re-exports the public functions. `packages/research/src/index.ts` already exposes each area as a namespace (`sessions`, `protocols`, `questionnaires`, `corpus`, `transcripts`, `aiConfig`, `processing`, `exports`). Do not edit that index file.
- Zod schemas and shared request and response types: `packages/domain/src/validators/<area>.ts`, exposed as `sessionSchemas`, `protocolSchemas`, `questionnaireSchemas`, `corpusSchemas`, `transcriptSchemas`, `aiConfigSchemas`, `processingSchemas`, `exportSchemas`. Do not edit `packages/domain/src/index.ts`.
- Route handlers: `apps/web/app/api/...` following spec 60, always wrapped in `apiRoute` from `apps/web/lib/server/api.ts`.
- Admin pages: replace the placeholder `apps/web/app/admin/(shell)/<route>/page.tsx`. Page-specific components go in `apps/web/app/admin/(shell)/<route>/_components/`. Shared primitives come from `apps/web/components/ui` and `apps/web/components/admin`; if a primitive is missing, build the component inside your own `_components` folder following `apps/web/design-system/COMPONENTS.md` and mention it in your report. Do not edit shared components.
- Service tests: Vitest with `createTestServiceContext()` from `@dialect/research/testing` and the builders in `@dialect/db/testing-builders`. Route handler tests: `apps/web/vitest.server.config.ts` with `setupServerTestHarness()` from `apps/web/lib/server/test/database.ts`.

### Rules
- The database schema is frozen. If you believe a change is needed, work without it and report it.
- Services own the rules. Route handlers only parse input, call a service and return its result.
- Database trigger errors: use `isImmutableRecordError`, `isInvalidStateError`, `isUniqueViolation` from `@dialect/db`. Check the state in the service first and throw a clear `AppError`; the triggers are the safety net.
- Every researcher action listed in spec 37.26 writes an audit row with `recordAudit` inside the same transaction.
- Admin pages show timestamps in the admin timezone from the study settings, with `formatDateTime` from `apps/web/lib/format.ts`. Lists are paginated on the server, 50 rows by default (spec 134).
- Draft editors use `useUnsavedChangesGuard` (spec 129). Destructive actions use `ConfirmDialog` (spec 116).
- One shared Next.js dev server runs at `http://localhost:3100` (started by the lead, hot reload). Do not start another dev server and do not run `next build`. Sign in for manual checks with `POST /api/admin/login` (send the header `Origin: http://localhost:3100`) using `ADMIN_PASSWORD` from the root `.env`. For browser checks write a small Playwright script; do not use a shared browser tool.
- `pnpm --filter @dialect/web typecheck` and `lint` cover the whole app while other engineers are mid-change: judge only the errors in files you own, and list any others in your report.

### Cross-slice agreements
- **Automatic ASR after upload (spec 79):** when the study setting `autoQueueAsr` is true, the participant upload service enqueues `{ type: "asr", payload: { utteranceId, mediaAssetId, trigger: "auto_on_upload" }, idempotencyKey: "asr:auto:<utteranceId>" }` with `enqueueJob` inside the submit transaction. A failure to enqueue must not fail the submission. The processing slice owns the `asr` handler: when the payload has no `modelConfigId` it uses the active `asr_default` model config at run time and fails with `CONFIGURATION_MISSING` (not retryable) when none is active.
- **Compressed fallback recordings (spec 31.2, 64):** the uploaded file is stored unchanged as `source_audio_raw` and is the utterance's accepted asset. The participant service enqueues `{ type: "derive_wav", payload: { mediaAssetId }, idempotencyKey: "derive_wav:<mediaAssetId>" }`; the processing slice owns that handler, which stores a `source_audio_derived` asset with `derived_from_media_asset_id` and the derivation provenance. A lossless upload is stored as `source_audio`.
- **Model config parameters:** `model_configs.parameters_json` may contain the keys `language` (ASR), `voice`, `response_format` and `instructions` (TTS). The AI adapters take these as typed input fields, so the processing handlers move them out of `parameters` before calling the adapter. Everything else is passed as `parameters`.
- **Synchronous pipeline steps:** the processing slice exports step functions that run one ASR, one translation or one synthesis and write the `model_runs` row and the output row. The job handlers, Demo Mode and the admin pipeline test all call these same functions.
- **Batches never mix data modes:** a `research` batch contains only research sessions; demo and test data are processed in batches whose `data_mode` is `demo` or `test`.
- **Questionnaire rendering:** the questionnaires slice provides `apps/web/components/questionnaire/QuestionnaireForm.tsx`, used by the participant flow, the admin preview and the session detail view.
- **Session detail** (corpus slice) shows transcripts, translations and syntheses read-only and links to `/admin/review?utterance=<id>` for editing (review slice).
- **Worker job handlers:** the processing and exports areas export `jobHandlers` from their `index.ts`; `apps/worker/src/handlers.ts` already registers both.
