# Dialect Translation Study Platform

A research platform for studying what AI speech translation does to linguistic variation. Participants speak Finnish in a short guided session. Researchers then transcribe, process and export the recordings with full provenance.

The authoritative specification is `docs/IMPLEMENTATION-SPEC.md`. "Spec 97" and similar references in this repository point to its sections. The current state of the implementation, the deviations from the specification and the open research decisions are in `docs/IMPLEMENTATION-STATUS.md`.

Commands in this file were run on 2026-10-03 unless a line says "not verified".

## 1. Scientific purpose

The study asks whether and where AI speech translation transforms, normalizes, preserves or distorts linguistic variation (spec 1). The pipeline under study has three stages:

```text
Finnish speech -> ASR -> Finnish text -> translation -> English text -> TTS -> English synthetic speech
```

The platform lets researchers see which transformation happens at which stage. It does not assume that dialect always disappears, or that output with more visible dialect markers is better.

Research questions (spec 1.2): RQ1, at which stages are dialectal, pragmatic and stylistic distinctions retained, reformulated, normalized or distorted; RQ2, whether preservation-aware translation retains more communicatively relevant variation than default translation without losing fidelity or naturalness; RQ3, how speech generation choices affect prosody, stance and speaker characteristics when the wording is held constant; RQ4, how speakers, bilingual evaluators and listeners perceive the result. This version supports data collection for RQ1 and RQ2 fully and prepares the data model for RQ3 and RQ4.

The design, and the reasons behind it, are in `docs/RESEARCH-DESIGN.md`.

## 2. Research Mode versus Demo Mode

| | Research Mode | Demo Mode |
|---|---|---|
| Purpose | Collect speech that is usable as research data | Seminars, operator trials, teaching |
| Route | `/` then `/study` | `/demo` |
| What the speaker sees | Only the task and their own recording before submitting | The ASR transcript, the default and the preservation-aware translation, and synthesized audio |
| AI processing | In the background or later, never shown to the participant | At once, shown on the page |
| Data mode | `research` (or `test` for a trial run by a signed-in researcher) | `demo` |
| In research exports | Yes | Never by default |

In Research Mode the participant never sees a transcript, a translation, a model name or synthetic audio (spec 3.1). Otherwise the AI output would influence how the participant speaks next. The two modes are separate code paths, and demo and test data are kept apart from research data in every count, batch and export (spec 78). Details: `docs/DEMO-MODE.md`.

## 3. Architecture

```text
   participant browser                         researcher browser
   /  /study  /demo                            /admin  (password, sealed HttpOnly cookie)
          |                                            |
          +----------------------+---------------------+
                                 v
                    apps/web  (Next.js 16, App Router)
                    pages + route handlers under /api
                                 |
                                 v
                    packages/research  (all business rules)
                      |              |               |
                      v              v               v
               packages/db     packages/storage   packages/ai
               PostgreSQL      audio files         OpenAI adapters,
               (records,       (local directory    mock provider
               provenance,     or S3-compatible)
               job queue)            ^               ^
                      ^              |               |
                      +--------------+---------------+
                                 |
                    apps/worker  (Node process)
                    takes jobs from the PostgreSQL queue:
                    ASR, translation, TTS, WAV derivation, exports
```

One pnpm workspace. Packages are TypeScript source without a build step.

| Path | Package | Content |
|---|---|---|
| `apps/web` | `@dialect/web` | Participant flow, Demo Mode, the `/admin` interface, API route handlers |
| `apps/worker` | `@dialect/worker` | Background worker: polls the `jobs` table, writes a heartbeat |
| `packages/domain` | `@dialect/domain` | Enums, error codes, Zod validators shared by browser and server |
| `packages/db` | `@dialect/db` | Drizzle schema, SQL migrations, immutability triggers, seed, test database helper |
| `packages/storage` | `@dialect/storage` | Storage adapter (local, S3-compatible, in memory), hashing, WAV parsing, ffprobe validation, WAV derivation |
| `packages/ai` | `@dialect/ai` | Provider-neutral interfaces for ASR, translation and TTS, OpenAI adapters, mock provider |
| `packages/research` | `@dialect/research` | Service functions: sessions, protocols, questionnaires, corpus, transcripts, AI configuration, processing, exports, job queue |
| `docker/` | | Dockerfiles for the web app and the worker |
| `scripts/` | | Sample TEST sessions, style check, deployment checks |
| `docs/` | | Specification, plan, status and the documents listed at the end of this file |

Rules that shape the code: route handlers only parse input and call a service; audio is never stored in PostgreSQL and never under `public/`; published protocols, stored recordings and model outputs are immutable, enforced by services and by database triggers (`docs/DATA-MODEL.md`).

## 4. Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 22 | `engines` in `package.json` requires 22 or newer |
| pnpm | 11.5.2 | Pinned in `package.json` (`packageManager`). `corepack enable` provides it. |
| Docker with Compose | Docker 29, Compose 5 | For the local PostgreSQL 17 and for the container images |
| ffmpeg and ffprobe | 5 or newer in `PATH` | Needed to validate compressed fallback recordings and to derive WAV files. WAV uploads work without it. |
| Chromium | through Playwright | Only for the browser tests |

## 5. Environment setup

```bash
pnpm install
cp .env.example .env
```

Then edit `.env`:

- `ADMIN_PASSWORD`: any value in development (at least 12 characters in production).
- `ADMIN_SESSION_SECRET`: at least 32 characters, for example from `openssl rand -base64 48`.
- `DATABASE_URL`: the default points at the Compose PostgreSQL on host port 5546.
- `OPENAI_API_KEY`: optional, see section 8.

The one `.env` file at the repository root is read by the web app, the worker and the database scripts. `.env` is ignored by Git. Never commit real values. Every variable is described in `docs/DEPLOYMENT.md`, "Environment variables".

## 6. Database migration

```bash
pnpm db:up        # starts PostgreSQL 17 in Docker (host port 5546) and waits until it is healthy
pnpm db:migrate   # applies the committed SQL migrations from packages/db/migrations
pnpm db:seed      # development study with placeholder texts, then three sample TEST sessions
```

- `pnpm db:seed` can be run again: it only adds what is missing. The seed study contains example texts (each participant-visible one starts with "[Example text, to be replaced by the research team.]") and the example tasks of spec 92. The sample sessions have the mode `test` and use the mock AI provider.
- Schema changes go through generated SQL migrations: `pnpm db:generate` (not verified in this work package; the procedure is in `docs/DATA-MODEL.md`, "How to add a migration safely").
- Never use `drizzle-kit push` against a database with study data (spec 90.4).

## 7. Media storage

Audio is stored through a storage adapter, never in the database.

- Development: `STORAGE_DRIVER=local` and `LOCAL_STORAGE_ROOT=./data/media`. The relative path is resolved against the repository root, so the web app and the worker use the same directory. `data/` is ignored by Git.
- Production: a private S3-compatible bucket (`STORAGE_DRIVER=s3` with the `S3_*` variables) or one persistent volume with an absolute `LOCAL_STORAGE_ROOT`.
- There is no public address for any recording. Researchers hear and download audio only through authenticated admin routes.

Layout of the stored files, drivers and validation: `docs/AUDIO-CAPTURE.md`.

## 8. OpenAI configuration

- Set `OPENAI_API_KEY` in `.env`. The key is used on the server only and never reaches the browser (spec 26).
- Without a key the participant flow works completely. Jobs that need the provider fail with `CONFIGURATION_MISSING` and can be retried later.
- Models, prompts, the TTS voice and their parameters are not in the environment. They are versioned records on the admin page **AI Pipeline**. The seed creates one ASR configuration, two translation configurations (default and preservation-aware) and one TTS baseline with the model identifiers of spec 25. These identifiers could not be checked against the live API in development; check them with "Test connection" on the Settings page and a pipeline test before use.
- **Mock provider for development.** A deterministic provider named `mock` produces marked placeholder output without any network call (`packages/ai/README.md`). It is allowed outside production by default and off in production. `AI_ALLOW_MOCK_PROVIDER` overrides the default. Mock output is never research data.

## 9. Running web and worker

```bash
pnpm dev          # web app (Next.js dev server on port 3000) and worker together; not verified, see below
pnpm dev:web      # only the web app; not verified
pnpm dev:worker   # only the worker; not verified
```

"Not verified" here means: these three were not started in this work package, because a shared development server was already running (on port 3100, started with a different port) and must not be disturbed. The worker itself was verified in its container (section 15), where it runs the same entry file.

Addresses with the default port: participant flow `http://localhost:3000/`, Demo Mode `http://localhost:3000/demo`, admin `http://localhost:3000/admin`, liveness `http://localhost:3000/api/health`, readiness `http://localhost:3000/api/health/ready`.

The worker has no port. Its heartbeat is shown on the admin Dashboard (row "Worker") and on the Settings page.

## 10. Admin login

Open `/admin`. The page asks for the password in `ADMIN_PASSWORD`. There are no user accounts: one password protects the researcher interface (spec 39). The session is a sealed, HttpOnly cookie that lasts `ADMIN_SESSION_TTL_HOURS` (8 by default). Five failed attempts in 15 minutes are followed by a refusal.

From a command line, state-changing admin requests need an `Origin` header equal to the app address:

```bash
curl -c cookies.txt -X POST http://localhost:3000/api/admin/login \
  -H "Origin: http://localhost:3000" -H "Content-Type: application/json" \
  -d '{"password":"<ADMIN_PASSWORD>"}'
```

(Verified against the production container through HTTPS, with the address of that test.)

What each admin page shows: `docs/ADMIN.md`.

## 11. Creating and publishing a protocol

A protocol version is the complete participant flow: texts, task blocks, tasks, follow-ups, the consent version and the questionnaire versions. A published version never changes; a session keeps the version it started with.

1. **Study Flow**: choose "Clone published version to new draft" (or edit the existing draft).
2. Edit the draft card by card: welcome, information, instructions, tasks, debrief.
3. Consent is edited in the consent editor and questionnaires on the **Questionnaires** page. Publish them first, then select them in the draft.
4. "Preview participant study" shows the flow without creating a session.
5. "Publish draft" runs the publish check, shows the difference against the current version and, after confirmation, makes the version immutable and current for new sessions.

Rules, the publish checklist and the wording warnings: `docs/PROTOCOL-VERSIONING.md`. Before real data collection every example text of the seed must be replaced.

## 12. The processing pipeline

```text
collect source recordings
   -> ASR transcript A (automatic, immutable model output)
   -> human transcripts on the Review page: B (dialect-preserving), C (minimally normalized), optionally A* (ASR with recognition errors corrected)
   -> verification
   -> processing batch: translation of each selected transcript type under each condition (default, preservation-aware)
   -> TTS of each translation with one fixed baseline voice
```

- ASR can run automatically after each upload (study setting) or in a batch.
- A **processing batch** (page **Processing Runs**) freezes its selection and its configuration, including prompt texts, when it starts. By default it takes research data, completed sessions and verified transcripts only. A new prompt or model always means a new batch; earlier outputs are never overwritten.
- Every model call is a `model_runs` row with the requested and returned model, parameters, timing and request id. Jobs are idempotent: a retry never produces a second output.
- The worker must be running. If the provider is down, collection continues and jobs can be retried.

Details: `docs/AI-PROVENANCE.md`.

## 13. Exports

Page **Data & Export**:

- single tables as CSV, JSON or JSON Lines;
- a **dataset package** (ZIP) with all tables, the protocol, prompt and model configuration versions, a data dictionary, a README and a `MANIFEST.json` with the SHA-256 of every file;
- source audio and synthesized audio archives.

Defaults: research sessions only, completed only, excluded and withdrawn records left out. TEST and DEMO data appear only when asked for. Privacy tiers: `internal_full` (the only tier with audio), `analysis_pseudonymous`, `collaboration_restricted`; `public_release` is deliberately not implemented. Every export is written to the audit log.

Details: `docs/EXPORT-SCHEMA.md`.

## 14. Testing

```bash
pnpm db:up        # the tests need the Compose PostgreSQL
pnpm test         # unit and integration tests of every package (Vitest)
pnpm lint
pnpm typecheck
pnpm check:style  # fails on an em dash, or an en dash used as a sentence break
pnpm test:e2e     # Playwright browser tests; not verified in this work package
```

- **Unit tests** sit next to the code as `*.test.ts`.
- **Integration tests** call the real services against a real PostgreSQL: `packages/research/src/integration/full-pipeline.integration.test.ts` (the whole path of spec 90.2) and `invariants.integration.test.ts` (the twelve scientific invariants of spec 110). Route handler tests are in `apps/web/app/api/**`.
- **How the test database works:** each test file calls `createTestDatabase()` from `@dialect/db/testing` and gets its own migrated database on the Compose PostgreSQL, created from a template and dropped afterwards. The development database `dialect_study` is never used by tests. `TEST_DATABASE_ADMIN_URL` points the tests at another server.
- **End to end tests** (`apps/web/e2e`) run in Chromium against an app that is already running, by default `http://localhost:3100`; set `E2E_BASE_URL` for another address. The browser gets a built-in test microphone, so no audio hardware is needed. They create TEST sessions in the database of that app.
- Tests that need ffmpeg are skipped with a message when it is not installed. No test calls the OpenAI API.

Results on 2026-10-03, while other work packages were still changing the code: `pnpm test` passed (1201 tests in 88 files across the seven packages; an earlier run stopped on a 10 second clean-up timeout in one test file while the machine was busy with image builds); `pnpm lint` and `pnpm typecheck` passed; `pnpm check:style` reported two lines in `apps/web/AGENTS.md`, a file that `next dev` generates.

### Testing end to end

Two commands run the Playwright suite in `apps/web/e2e`. Both use Chromium with a built-in test microphone.

| Command | Runs against | Specs |
|---|---|---|
| `pnpm test:e2e` | an app that is already running, by default the development server on `http://localhost:3100` (`E2E_BASE_URL`), with its database | participant, recorder, demo |
| `pnpm test:e2e:isolated` | its own throwaway environment, built from the current source | participant, demo and the admin specs (`admin-*.spec.ts`) |

The admin specs change global state: they publish a protocol, activate prompt and model configuration versions, and delete TEST and DEMO data. They therefore run only in the isolated environment, never against the development database.

**What `pnpm test:e2e:isolated` does** (`scripts/e2e/run-isolated.mjs`, `docker-compose.e2e.yml`, Compose project name `dialect-e2e`):

1. builds the web and worker images from the current source (`docker/web.Dockerfile`, `docker/worker.Dockerfile`);
2. starts its own PostgreSQL 17 container with the data directory in memory, on host port 5547. It is a different server from the development one (port 5546, volume `dialect_study_pg`), so the database `dialect_study` cannot be reached by anything in this stack;
3. applies the migrations and the database seed with the worker image, then adds three sample TEST sessions from the host with `scripts/seed-test-sessions.ts` (generated tones, mock provider) into `data/e2e-media`;
4. starts the production web image on `http://localhost:3210` and a worker, with `AI_ALLOW_MOCK_PROVIDER=true`, no `OPENAI_API_KEY`, `ALLOW_TEST_DATA_RESET=true` and its own admin password and session secret (fixed values in the Compose file, valid for this environment only);
5. runs Playwright with `E2E_BASE_URL=http://localhost:3210` and `E2E_ISOLATED=1`;
6. always removes the containers, the network, the database and `data/e2e-media`, also after a failure or Ctrl+C.

Requirements: Docker with Compose, the workspace dependencies (`pnpm install`), the Playwright Chromium browser (`pnpm --filter @dialect/web exec playwright install chromium`) and free ports 3210 and 5547 (`E2E_WEB_PORT`, `E2E_PG_PORT` choose others). Arguments are passed to Playwright: `pnpm test:e2e:isolated admin-03` runs one spec file. `E2E_SKIP_BUILD=1` reuses the last images, `E2E_KEEP_STACK=1` leaves the stack running for debugging (`node scripts/e2e/run-isolated.mjs --down` removes it).

Things to know:

- The web image runs with `NODE_ENV=production`, so the admin cookie is `Secure` (the `__Host-` name prefix is added when `APP_URL` is an https address, which it is not here). Chromium treats `http://localhost` as a secure origin: the login works over plain HTTP there, and no TLS proxy is needed for this environment.
- `/dev/recorder` answers 404 in a production build, so `recorder.spec.ts` is skipped in the isolated run with that reason. It runs with `pnpm test:e2e` against a development server.
- The admin sign-in happens once, through the real login page (`e2e/auth.setup.ts`, a Playwright setup project), and the admin specs reuse the saved storage state (`apps/web/e2e/.isolated/auth/admin.json`, ignored by Git, removed at the end of the run). Traces of failed tests are kept in `apps/web/e2e/.isolated/test-results/` until the next run, apart from `apps/web/test-results/`, which any other Playwright run in the checkout empties.
- The admin specs run with one worker in file name order (`admin-01` to `admin-12`) and share one database. Each file leaves it usable for the next. `admin-11-settings.spec.ts` deletes the TEST and DEMO data, so it comes after every spec that needs data. `admin-12-sign-out.spec.ts` is the very last: signing out ends every admin session issued before it, the saved one included. The participant and demo specs have no dependency on the admin specs, so a failure in one group does not skip the other.
- The batch wizard offers active model configurations only. `admin-08-processing.spec.ts` therefore activates mock-provider versions of the translation and TTS configurations through the admin API. That is legitimate in this environment only: mock output is not model output.
- No test is marked `test.fail()` at present: the four defects the suite found (E2E-1 to E2E-4, see `docs/IMPLEMENTATION-STATUS.md`) are fixed. When a new application defect is found and cannot be fixed at once, mark its test with `test.fail()` and a comment `DEFECT E2E-<n>`: the test is then reported as passed while the defect exists and as failed once it is fixed, which is the signal to remove the mark.
- The participant and demo specs write screenshots to `docs/ui-current/`, in both commands.

## 15. Deployment notes

Two container images (web and worker), an external PostgreSQL, and a private media store. To try the containers locally:

```bash
cp docker/app.env.example .env.docker     # then set ADMIN_PASSWORD and ADMIN_SESSION_SECRET
docker compose -f docker-compose.yml -f docker-compose.app.yml up --build
```

This runs the migrations once, then starts the web app on `http://127.0.0.1:3000` and the worker. (Verified with a different host port, database name and volume name, because port 3000 and the development database were in use: `WEB_PORT`, `APP_ENV_FILE` and `MEDIA_VOLUME_NAME` change them.)

Everything else is in `docs/DEPLOYMENT.md`: production topology, the warning about several writers on one volume, every environment variable, migrations in production, health checks, TLS and reverse proxy requirements, backups with a restore test, the release checklist and the runbook.

## 16. Privacy warning

**Never use real participant data in local development casually.**

- Voice recordings are personal data. A voice can identify a person, and free speech can name other people.
- Do not copy the production database or production audio to a laptop for debugging. Use the seed, the sample TEST sessions and the mock provider.
- Do not send real recordings to an AI provider from a development machine: the development key and account may not be covered by the agreements of the study.
- `data/`, `exports/` and `.env` are ignored by Git. Keep it that way. Never commit audio, exports or secrets.
- Trial runs belong in `test` mode (open `/?mode=test` while signed in as admin) or in Demo Mode, never in `research` mode.
- If real data must be examined, do it on the approved system, through the admin, under the study's data management plan.

What the system stores, what it sends to the AI provider, and what is deliberately left to the researchers and the data protection officer: `docs/PRIVACY-IMPLEMENTATION-NOTES.md`.

## Documentation index

| Document | Content |
|---|---|
| `docs/IMPLEMENTATION-SPEC.md` | The authoritative specification |
| `docs/IMPLEMENTATION-PLAN.md` | Architecture, work packages, shared contracts, writing rules |
| `docs/IMPLEMENTATION-STATUS.md` | Completed work, deviations from the specification, unresolved research decisions |
| `docs/RESEARCH-DESIGN.md` | The scientific design as implemented |
| `docs/DATA-MODEL.md` | Tables, relationships, constraints, immutability triggers, deletion rules, seed, migrations |
| `docs/PROTOCOL-VERSIONING.md` | Protocol and consent versions, publishing, the publish checklist |
| `docs/PARTICIPANT-API.md` | The participant endpoints, session states, upload and retry rules |
| `docs/PARTICIPANT-UI.md` | The participant pages |
| `docs/AUDIO-CAPTURE.md` | Browser capture, validation on the study laptop, server-side validation, storage drivers |
| `docs/AI-PROVENANCE.md` | Model runs, idempotency, processing batches, lineage |
| `docs/DEMO-MODE.md` | Demo Mode, the admin pipeline test, the sample TEST sessions |
| `docs/EXPORT-SCHEMA.md` | Export kinds, files, filters, privacy tiers, manifest |
| `docs/ADMIN.md` | Guide to the Dashboard, Sessions, Session Detail and Settings |
| `docs/PRIVACY-IMPLEMENTATION-NOTES.md` | Implementation note for the data protection review |
| `docs/DEPLOYMENT.md` | Images, Compose, production topology, environment variables, backups, release checklist, runbook |
| `docs/UI-LINEAGE.md` | How the interface relates to the reference application |
| `docs/UI-PARITY-MATRIX.md` | Component by component comparison with the reference application |
| `packages/ai/README.md` | The AI package: interfaces, adapters, mock provider |

`docs/ui-current/` and `docs/ui-reference/` hold screenshots for the visual review.

## Methodological warnings

From Appendix D of the specification. They apply to everyone who changes this code or works with its data.

1. Do not call standardization "dialect loss" automatically.
2. Do not treat a regional self-label as the only linguistic truth.
3. Do not equate voice similarity with dialect preservation.
4. Do not equate informality with regional dialect.
5. Do not reward a model simply for adding conspicuous dialect markers.
6. Do not map a Finnish regional dialect to a named English regional dialect by default.
7. Do not use free-speech outputs as the only causal evidence of homogenization.
8. Do not show AI feedback during main speech elicitation.
9. Do not dynamically change participant prompts using an LLM in Research Mode v1.
10. Do not treat a standard-language ASR reference as neutral when evaluating dialectal transcription.
11. Do not blame TTS for prosodic information that was already lost before synthesis.
12. Do not change active protocol or model prompts silently during collection.
13. Do not treat model aliases as permanently reproducible identifiers without logging dates and returned metadata.
14. Do not mix TEST or DEMO data with research data.
15. Do not store audio in public web directories.
16. Do not send participant metadata to AI providers unless scientifically necessary.
17. Do not build inference dashboards that encourage peeking at treatment effects during data collection.
18. Do not delete inconvenient outputs; flag or exclude them with provenance.
19. Do not overwrite human-reviewed scientific records.
20. Do not let implementation convenience destroy the ability to identify where a transformation occurred.
