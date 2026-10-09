# Deployment

How to run the platform outside a developer's terminal: the container images, the local Compose deployment, the production topology, every environment variable, migrations, health checks, logging, TLS and reverse proxy requirements, backups with a restore test, the release checklist and a short runbook. Specification sections 5.1, 26, 36, 67, 90.4, 95, 96, 112, 113, 114 and Phase 7 of section 161.

Everything marked "verified" was run on 2026-10-03 against the images built from this repository (Docker 29.8, Docker Compose 5.5, PostgreSQL 17.11). Everything that depends on the hosting provider is marked "check with the provider". No provider-specific value in this document is invented.

Related documents: `docs/AUDIO-CAPTURE.md` (storage drivers, validating the study laptop), `docs/DATA-MODEL.md` (migrations, deletion rules), `docs/PRIVACY-IMPLEMENTATION-NOTES.md` (cookies, logs, what is sent to the AI provider), `docs/ADMIN.md` (Dashboard and Settings status rows), `docs/PARTICIPANT-API.md` (large uploads).

## 1. The two images

| Image | Dockerfile | Size | Contains | Default command |
|---|---|---|---|---|
| web | `docker/web.Dockerfile` | about 770 MB | Next.js standalone server, static assets, `public/` (the recorder worklet), the migration files, ffmpeg | `node apps/web/server.js` |
| worker | `docker/worker.Dockerfile` | about 780 MB | TypeScript source of the worker and of the workspace packages, production dependencies, the migration files, ffmpeg | `node --import tsx src/main.ts` |

About 450 MB of each image is ffmpeg with its libraries from the Debian packages. The application part is about 90 MB (web) and about 120 MB (worker).

Common properties (verified by inspecting the built images):

- Base image `node:22-bookworm-slim` (official Node 22 image, Debian 12). pnpm is installed through corepack in the version pinned in the root `package.json` (`packageManager`). Dependencies are installed from the lockfile with `pnpm install --frozen-lockfile`.
- Multi-stage builds: build tools and development dependencies stay in the build stage.
- The process runs as user id 1000 (`node`), not as root. All application files are owned by `node` with group 0, and `/data` is group-writable, so the images also run under an arbitrary user id in group 0 (verified with `docker run --user 1234567:0`: readiness answered `ready`, migrations ran).
- No secret, no `.env` file and no participant data is in any layer. `.dockerignore` keeps `node_modules`, `.next`, `data/`, `exports/`, every `.env*` file except `.env.example`, `.git`, test output, `docs/` and `scripts/` out of the build context. Verified: `find / -name ".env*"` in the web container finds nothing.
- ffmpeg and ffprobe come from the Debian 12 packages: version `5.1.9-0+deb12u1` in both images (verified with `ffmpeg -version` and on the Settings page, card "Media storage"). The web app uses them to validate compressed fallback recordings, the worker to derive WAV files.
- All configuration comes from environment variables (section 4).

### Web image: Next.js standalone output

The web image follows the Next.js 16 self-hosting guide (`apps/web/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md`): `output: "standalone"` with `outputFileTracingRoot` set to the repository root, because the workspace packages live outside `apps/web`. The Dockerfile sets `NEXT_OUTPUT=standalone`, and `apps/web/next.config.ts` turns standalone output on only when that variable is set, so a normal `pnpm build` followed by `next start` keeps working in development.

As the guide says, the standalone folder does not contain `public` or `.next/static`. The Dockerfile copies both next to the server. It also copies two things that file tracing cannot see, because they are read from a path computed at run time:

- `packages/db/migrations/` with `meta/_journal.json`: the Settings page compares the journal with the migrations applied in the database;
- `pnpm-workspace.yaml`: the marker file by which the code finds the repository root.

`next.config.ts` is evaluated at build time and stored in the standalone server. The security headers (including `Strict-Transport-Security`) are therefore fixed in the image, and the root `.env` file is never read at run time.

Build-time note: no secret is needed to build. `apps/web/instrumentation.ts` skips the environment check during `next build`.

### Worker image: TypeScript run with tsx

The worker and the workspace packages are TypeScript source with extensionless imports and no build step (see `docs/IMPLEMENTATION-PLAN.md`). The image runs them with `tsx`, which is a production dependency of `apps/worker`. The alternative, one bundled JavaScript file made with esbuild, was not chosen:

- `packages/db/src/migrate.ts` finds the migration folder relative to its own file, and the storage configuration finds the repository root by walking up from the working directory. A bundle changes both paths. Keeping the workspace layout means every path resolves exactly as in development and in the tests.
- The same image can run the migration and seed commands without a second build.
- The cost is a transpile step at start (the worker started in under one second in the test) and about 10 MB for tsx and esbuild.

The worker image installs only the production dependencies of the worker and of the packages it uses (`pnpm install --frozen-lockfile --prod --filter "@dialect/worker..."`). Test files are removed.

Commands in the worker image (working directory `/app/apps/worker`):

| Purpose | Command |
|---|---|
| Worker (default) | `node --import tsx src/main.ts` |
| Apply migrations | `node --import tsx ../../packages/db/src/migrate.ts` |
| Development seed (placeholder study content) | `node --import tsx ../../packages/db/src/seed/index.ts` |

## 2. Local Compose deployment

`docker-compose.yml` defines PostgreSQL. `docker-compose.app.yml` adds three services: `migrate` (one run, then exits), `web` and `worker`.

```bash
cp docker/app.env.example .env.docker     # then set ADMIN_PASSWORD and ADMIN_SESSION_SECRET
docker compose -f docker-compose.yml -f docker-compose.app.yml up --build
```

What happens (verified):

1. `postgres` starts and becomes healthy.
2. `migrate` applies the committed SQL migrations and exits with code 0. Output: `Migrations applied`.
3. `web` and `worker` start only after `migrate` finished successfully (`depends_on` with `service_completed_successfully`). `web` is reported healthy when `GET /api/health/ready` answers 200.
4. The web app listens on `http://127.0.0.1:3000`.

Settings of the Compose file, read from the shell or from the root `.env` file (Compose uses that file only to fill in these placeholders; it is not given to the containers):

| Variable | Default | Meaning |
|---|---|---|
| `APP_ENV_FILE` | `.env.docker` | Env file given to the three containers. Not committed (`.gitignore` covers `.env.*`). |
| `WEB_PORT` | `3000` | Host port of the web app. |
| `WEB_BIND` | `127.0.0.1` | Host address the port is bound to. Keep it on the loopback address and put a TLS reverse proxy in front for anything that is not a local test. |
| `MEDIA_VOLUME_NAME` | `dialect_study_media` | Name of the Docker volume mounted at `/data/media` in `web` and `worker`. |

The Compose file sets `NODE_ENV=production` and `LOCAL_STORAGE_ROOT=/data/media` itself. The storage path must be absolute in a container: a relative path is refused, because the image has no reason to guess a base directory (`packages/storage/src/config.ts`).

A new database has no study. For a trial with the placeholder content of the development seed:

```bash
docker compose -f docker-compose.yml -f docker-compose.app.yml run --rm --no-deps migrate \
  node --import tsx ../../packages/db/src/seed/index.ts
```

The seed texts are examples. Every seeded text a participant can see starts with the sentence "[Example text, to be replaced by the research team.]". A real study needs the researchers' texts (section 11).

Things to know:

- `NODE_ENV=production` makes both cookies `Secure`, and a browser sends such a cookie only over HTTPS. Chromium treats `http://localhost` as a secure origin, so the admin is expected to work in Chrome on the same machine (not part of the checks in section 9, which went through HTTPS). From another machine, or with `curl`, use HTTPS (section 7).
- The mock AI provider is off in the containers. Without `OPENAI_API_KEY`, recording works and processing jobs fail with `CONFIGURATION_MISSING` until a key is set (verified).
- Stop with `docker compose -f docker-compose.yml -f docker-compose.app.yml down`. The database volume and the media volume stay. Add `-v` only to delete all data.
- No MinIO service is included. Spec 96 lists it as optional. The S3 driver has its own integration test (`docs/AUDIO-CAPTURE.md`, "Tests").

## 3. Production topology

```text
                 HTTPS
 browser  ------------------>  reverse proxy / route   (TLS, body size limit, forwarded headers)
                                      |
                                      v  http :3000
                               +-------------+          +-------------+
                               | web         |          | worker      |
                               | (container) |          | (container) |
                               +------+------+          +------+------+
                                      |                        |
                    +-----------------+------------------------+-----------------+
                    |                                                            |
                    v                                                            v
          PostgreSQL (external, managed            media store: private S3-compatible bucket,
          or a separate service)                   or one persistent volume mounted in both
                                                                                 |
                                                                                 v
                                                     OpenAI API (worker and web, server side only)
```

- **Two containers** from the two images (spec 112). The web app serves participants and researchers. The worker runs ASR, translation, TTS, WAV derivation and export jobs from the `jobs` table.
- **PostgreSQL is external** to both containers: a managed database service or a separately operated server. PostgreSQL 17 is what the project is tested with.
- **Media store.** Audio never goes into PostgreSQL and never under `public/` (spec 34, 35).
- **A migration step** runs once per release, before the new web and worker containers start (section 5).

### Media store: object storage or one volume

Both the web app and the worker read and write audio: the web app stores uploads and streams audio to the admin, the worker reads recordings and writes derived WAV files, synthesized audio and export archives.

| Option | Use when | Notes |
|---|---|---|
| `STORAGE_DRIVER=s3` (S3-compatible, private bucket) | More than one web or worker replica, or web and worker on different nodes | Preferred for a deployment that must scale (spec 112). No shared filesystem needed. The bucket must block public access. No ACL is ever sent. |
| `STORAGE_DRIVER=local` on a persistent volume | One node, or a volume that supports several writers | The same volume must be mounted at `LOCAL_STORAGE_ROOT` in the web and the worker container. |

**Warning about ReadWriteOnce volumes.** A volume with access mode ReadWriteOnce can be mounted by the pods of one node only. With the local driver this means:

- web and worker must run on the same node, or in one pod, or the worker cannot see the uploads;
- a rolling update that starts a new pod on another node while the old pod still holds the volume will hang or fail, so the deployment strategy must be `Recreate`, and the replica count of each must stay at 1;
- scaling the web app to several replicas across nodes is not possible.

If any of these is not acceptable, use S3-compatible storage. Do not work around the limit by giving each replica its own volume: recordings stored by one replica would be invisible to the others.

The local driver itself is safe with two writers on one volume (it publishes a finished file with a hard link and never overwrites, `docs/AUDIO-CAPTURE.md`, "Drivers").

### Replicas

- **Web:** any number with S3 storage. Rate limit state and sessions are in PostgreSQL and in sealed cookies, so no replica keeps state in memory that another needs.
- **Worker:** any number. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so two workers never run the same job. Each replica needs its own `WORKER_ID`: leave the variable unset and the host name (the pod name) is used.

## 4. Environment variables

Generated from the Zod schemas in `apps/web/lib/server/env.ts` and `apps/worker/src/env.ts`, plus the variables read directly elsewhere in the code. "W" means read by the web app, "K" by the worker. An empty value counts as not set.

### Application

| Variable | Used by | Required | Default | Meaning |
|---|---|---|---|---|
| `NODE_ENV` | W, K | no | `development` | `development`, `test` or `production`. Production turns on `Secure` cookies and turns the mock AI provider off. The images set `production`. |
| `APP_URL` | W | no | `http://localhost:3000` | The public address of the app, as people type it. Used for the same-origin check of admin requests, and when it starts with `https://` the Content Security Policy gets `upgrade-insecure-requests`. |
| `APP_VERSION` | W, K | **yes in production** | `dev` outside production | Shown by the health endpoints and the Settings page, stored with every session, model run and export. With `NODE_ENV=production` it must be set to the released version: a missing value and the value `dev` are refused at startup, so provenance never says `dev` silently. |
| `GIT_COMMIT_SHA` | W, K | no | none | Stored with model runs and exports for provenance. Set it at deploy time. |
| `LOG_LEVEL` | W, K | no | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `PORT` | W | no | `3000` | Port of the Next.js standalone server (read by Next.js, not by the schema). |
| `HOSTNAME` | W | no | `0.0.0.0` in the image | Address the standalone server binds to (read by Next.js). |

### Database

| Variable | Used by | Required | Default | Meaning |
|---|---|---|---|---|
| `DATABASE_URL` | W, K, migrate, seed | **yes** | none | `postgresql://user:password@host:port/database`. Treat it as a secret: it contains the password. |

### Admin authentication and sessions

| Variable | Used by | Required | Default | Meaning |
|---|---|---|---|---|
| `ADMIN_PASSWORD` | W | **yes** | none | The one researcher password (spec 39). At least 12 characters when `NODE_ENV=production`. Generate it randomly, for example `openssl rand -base64 18`: the login cannot be locked from outside, and in exchange the application does not cap password guesses (section 7, "Admin login"). Changing it ends every admin session. |
| `ADMIN_SESSION_SECRET` | W | **yes** | none | At least 32 characters. Seals the admin cookie and keys the hash of client addresses in the rate limit table. Generate with `openssl rand -base64 48`. Changing it signs every admin out. |
| `ADMIN_SESSION_TTL_HOURS` | W | no | `8` | Lifetime of an admin session. |
| `PARTICIPANT_SESSION_TTL_HOURS` | W | no | `24` | Lifetime of a participant session token. |
| `TRUST_PROXY` | W | no | `false` | `true` only when exactly one trusted reverse proxy is in front. The client address for rate limiting is then the last entry of `x-forwarded-for` (section 7). With `false` on an address that is not localhost every client shares one rate limit bucket, and one client can use up the limit for new participant sessions for everyone: the server prints a configuration warning at startup and counts it in `GET /api/health/ready`. |

### AI provider

| Variable | Used by | Required | Default | Meaning |
|---|---|---|---|---|
| `OPENAI_API_KEY` | W, K | no | none | Server side only, never sent to the browser (spec 26). Without it recording still works; ASR, translation and TTS jobs fail with `CONFIGURATION_MISSING` and can be retried after the key is set. The web app needs it for Demo Mode, the admin pipeline test and "Test connection". |
| `AI_ALLOW_MOCK_PROVIDER` | W, K | no | `true` outside production, `false` in production | Allows the deterministic mock provider. Never `true` for a real study: mock output is not model output. |
| `AUTO_TRANSLATE_AFTER_ASR` | W | no | empty (off) | `true`: after the automatic ASR of an upload, the worker translates and synthesizes that recording in its own processing batch (`docs/AI-PROVENANCE.md`). Off: batches are started on the Processing page. |

Model identifiers, prompts, the TTS voice and parameters are not environment variables. They are versioned records edited on the AI Pipeline page (spec 143).

### Storage

| Variable | Used by | Required | Default | Meaning |
|---|---|---|---|---|
| `STORAGE_DRIVER` | W, K | no | `local` | `local` or `s3`. |
| `LOCAL_STORAGE_ROOT` | W, K | for `local` | web: `./data/media`; worker: none | Directory of the local driver. In a container it must be an absolute path on a mounted volume (the Compose file sets `/data/media`). A relative path is resolved against the repository root in development and refused where no `pnpm-workspace.yaml` is found. |
| `S3_ENDPOINT` | W, K | no | none | Custom endpoint of an S3-compatible store. |
| `S3_REGION` | W, K | for `s3` | none | Region. |
| `S3_BUCKET` | W, K | for `s3` | none | Bucket name. The bucket must be private. |
| `S3_ACCESS_KEY_ID` | W, K | for `s3` | none | Access key. Secret. |
| `S3_SECRET_ACCESS_KEY` | W, K | for `s3` | none | Secret key. Secret. |
| `S3_FORCE_PATH_STYLE` | W, K | no | `false` | `true` for stores that need path-style addresses. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | W, K | no | found in `PATH` | Location of the audio tools (read by `packages/storage`). Not needed in the images. |

### Upload and audio limits

| Variable | Used by | Required | Default | Meaning |
|---|---|---|---|---|
| `MAX_AUDIO_UPLOAD_MB` | W | no | `100` | Maximum upload size in MiB. A fallback: the value on the admin Settings page (study setting "Maximum upload size") wins when it is set. The seed sets 100. |
| `MAX_UTTERANCE_SECONDS` | W | no | `300` | Maximum utterance duration. Also a fallback behind the study setting; each task has its own maximum in the protocol. |

### Worker

| Variable | Used by | Required | Default | Meaning |
|---|---|---|---|---|
| `WORKER_ID` | K | no | `worker-<host name>` | Name in the heartbeat table. Must differ between replicas. At most 200 characters. |
| `WORKER_POLL_INTERVAL_MS` | K | no | `2000` | Pause between looks at the queue when it is empty. |
| `WORKER_CONCURRENCY` | K | no | `1` | Jobs run at the same time in one worker, 1 to 16. |
| `WORKER_LOCK_TIMEOUT_MS` | K | no | `600000` | A running job whose worker has been silent this long is released for a retry. |
| `WORKER_HEARTBEAT_INTERVAL_MS` | K | no | `10000` | Heartbeat interval. At most half of `WORKER_LOCK_TIMEOUT_MS`. |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | K | no | `30000` | Wait for running jobs after SIGTERM. Give the container a longer termination grace period (the Compose file uses 40 s). |

### Guards and tests

| Variable | Used by | Required | Default | Meaning |
|---|---|---|---|---|
| `ALLOW_TEST_DATA_RESET` | W | no | `false` | In production, "Delete TEST and DEMO data" on the Settings page is disabled unless this is `true`. It can never select research data. |
| `TEST_DATABASE_ADMIN_URL` | tests | no | `postgresql://postgres:postgres@localhost:5546/postgres` | Server on which the tests create their temporary databases. |
| `E2E_BASE_URL` | Playwright | no | `http://localhost:3100` | Address of the running app for the browser tests. |
| `TEST_S3_ENDPOINT`, `TEST_S3_BUCKET`, `TEST_S3_ACCESS_KEY_ID`, `TEST_S3_SECRET_ACCESS_KEY`, `TEST_S3_REGION` | tests | no | none | Turn on the S3 integration test of `packages/storage`. |
| `NEXT_OUTPUT` | build | no | none | `standalone` makes `next build` write the standalone server. Set by `docker/web.Dockerfile`. |

Secrets are `DATABASE_URL`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `OPENAI_API_KEY`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Give them to the containers through the platform's secret mechanism, never through an image, a committed file or a build argument. Where an env file is used on a server (`.env`, `.env.docker`), make it readable by the service user only: `chmod 600 .env .env.docker`.

### What happens with an invalid configuration

- **Worker:** prints the names of the invalid variables (never values) and exits with code 1 (verified).
- **Web:** prints the names of the invalid variables (never values), then the line `The server stops because its configuration is invalid.`, and exits with code 1 (`apps/web/instrumentation.ts`, `apps/web/lib/server/startup.ts`; unit tests in `apps/web/lib/server/startup.test.ts`). Background: Next.js calls `register` once before the server handles requests, but an error thrown there does not stop the standalone server (observed with Next.js 16.3.8: the process stayed up and answered every request with status 500). The check therefore ends the process itself. It runs in production only, in the Node.js runtime, and not during `next build`. In development the message is printed, the server keeps running, and `GET /api/health/ready` answers 503 with the names of the invalid variables. **Verified on 2026-10-04 on the production web image:** started without `ADMIN_SESSION_SECRET`, the container printed `Invalid environment configuration:`, `- ADMIN_SESSION_SECRET: is required`, `The server stops because its configuration is invalid.` and exited with code 1.

## 5. Migrations in production

Rules (spec 90.4, `docs/DATA-MODEL.md`, "How to add a migration safely"):

- Only the committed SQL files in `packages/db/migrations/` are applied, in order, and recorded in `drizzle.__drizzle_migrations`. Never run `drizzle-kit push` against a database that holds study data.
- Migrations are **not** run when the web app or the worker starts. They are an explicit step, so that several web replicas never race and so that a person decides when the schema of a research database changes.

Procedure for a release:

1. Back up the database (section 8).
2. Run the migration command once with the new worker image and the production `DATABASE_URL`:
   ```bash
   docker run --rm -e DATABASE_URL=... <worker image> node --import tsx ../../packages/db/src/migrate.ts
   ```
   On Kubernetes or OpenShift this is a Job (or a pre-deployment hook) that uses the worker image with that command and the same secret as the other containers. In the Compose file it is the `migrate` service.
3. Wait for `Migrations applied` and exit code 0. A second run changes nothing.
4. Start the new web and worker containers.
5. Open Settings in the admin: the Database card must say "Up to date". "Migrations pending" means the database is behind the code; a note about unknown applied migrations means the database is newer than the code.

Never run the development seed against a production database that already has the researchers' study content. It only inserts missing records and never changes existing ones, but its texts are placeholders.

## 6. Health checks and observing the worker

| Check | Path or method | Answers | Use for |
|---|---|---|---|
| Liveness | `GET /api/health` | 200 `{"status":"ok","version":"..."}` while the process serves requests | Container health check, liveness probe |
| Readiness | `GET /api/health/ready` | 200 `{"status":"ready",...}` when the configuration is valid, the database answers and the storage can be written; otherwise 503 `{"status":"not_ready",...}`. The body holds a pass or fail per check (`{"ok":true}` or `{"ok":false}`, nothing else) and `warnings`, the number of configuration warnings. It never names an environment variable: the names of invalid variables and the warning texts are in the server log | Readiness probe, Compose health check, monitoring |
| Worker | the process itself | exits with a non-zero code when it cannot run | Restart policy |

Neither endpoint calls the OpenAI API, and neither returns host names, paths or keys (spec 113).

Verified with a web container whose `DATABASE_URL` points at a port where nothing listens:

```text
GET /api/health        -> 200 {"status":"ok","version":"0.1.0-smoke"}
GET /api/health/ready  -> 503 {"status":"not_ready","version":"0.1.0-smoke","checks":{"configuration":{"ok":true},
                               "database":{"ok":false,"detail":"database not reachable"},"storage":{"ok":true}}}
log line: {"level":40,"service":"web","check":"database","reason":"database query failed","code":"ECONNREFUSED","msg":"readiness check failed"}
```

**Worker heartbeat.** The worker has no network port. Every `WORKER_HEARTBEAT_INTERVAL_MS` it writes a row to `worker_heartbeats`. Where to look:

- Admin Dashboard, Status, row "Worker": healthy when a heartbeat arrived within the last minute.
- Admin Settings, card "Application": every worker with its id, state and last heartbeat, and the job queue (queued, running, failed).
- SQL: `select worker_id, last_seen_at from worker_heartbeats;`

Without a worker, uploads still work and processing waits (spec 110.8).

**Shutdown.** On SIGTERM the worker stops taking jobs, waits up to `WORKER_SHUTDOWN_TIMEOUT_MS` for running ones and exits (verified: log lines "shutdown requested, waiting for running jobs" and "worker stopped"). A job that was cut off is released after `WORKER_LOCK_TIMEOUT_MS` and retried; idempotency keys prevent duplicate outputs (`docs/AI-PROVENANCE.md`).

## 7. TLS and the reverse proxy

HTTPS is required in production (spec 67), and for a second reason: browsers give a page the microphone only on HTTPS or `localhost`.

The containers speak plain HTTP on port 3000. TLS ends at a reverse proxy, a load balancer or a platform route in front of the web container. Requirements for that proxy:

| Requirement | Why | nginx | OpenShift route |
|---|---|---|---|
| Terminate TLS, redirect HTTP to HTTPS | Cookies are `Secure`; the microphone needs a secure context; the app sends HSTS | `listen 443 ssl;` and a redirect server on port 80 | `tls.termination: edge` with `insecureEdgeTerminationPolicy: Redirect` |
| Body size limit at least `MAX_AUDIO_UPLOAD_MB` plus a margin | A smaller limit rejects large recordings before the app sees them | `client_max_body_size 110m;` for the default 100 MB (the nginx default is 1 MB, which breaks every upload) | The HAProxy router has no body size setting in its route annotations. Check with the provider whether any limit applies. |
| Do not buffer the upload to disk first, generous timeouts | A 100 MB upload on a slow connection takes minutes | `proxy_request_buffering off;` `proxy_read_timeout 300s;` | Annotation `haproxy.router.openshift.io/timeout` (for example `5m`). |
| Pass the `Host` header unchanged | The same-origin check compares the request origin with `APP_URL` and the request host | `proxy_set_header Host $http_host;` | Default behavior of a route. |
| Set `x-forwarded-for` so that its **last** entry is the client address the proxy saw | With `TRUST_PROXY=true` the rate limit uses the last entry | `proxy_set_header X-Forwarded-For $remote_addr;` (or `$proxy_add_x_forwarded_for`, which appends) | Check with the provider how the router sets forwarded headers. |
| Nothing else can reach port 3000 | A client that reaches the app directly can send any `x-forwarded-for` value | Bind the container port to the loopback address or a private network | Do not expose the Service outside the cluster except through the route. |

### Admin login

The login is built so that it cannot be blocked from outside: a correct password always signs in, whatever happened before. Failed attempts are throttled (30 per minute are answered and audited, further ones get 429, and with `TRUST_PROXY=true` 5 per 15 minutes per client address). The throttle does not cap how many passwords can be tested, because a 429 also tells the sender that the guess was wrong. Details and the numbers are in `docs/PRIVACY-IMPLEMENTATION-NOTES.md`, section 1.2.

Two measures follow for the operator:

1. Use a random admin password (`openssl rand -base64 18`).
2. Limit the login route at the reverse proxy, where the real client address is known. For nginx:

```nginx
limit_req_zone $binary_remote_addr zone=admin_login:10m rate=10r/m;
location = /api/admin/login {
    limit_req zone=admin_login burst=5 nodelay;
    limit_req_status 429;
    proxy_pass http://web;      # with the same proxy headers as the main location
}
```

Signing out ends every admin session on the server (one shared password, no accounts), and so does a change of `ADMIN_PASSWORD`. Over https in production the admin cookie is named `__Host-dts_admin`.

`TRUST_PROXY`:

- `false` (default): the app does not look at the client address at all. Every client shares one rate limit bucket (5 failed admin logins per 15 minutes in total, 120 new sessions per hour in total). Safe, and enough for one study laptop.
- `true`: only with exactly one trusted proxy in front that sets the header as above. With two proxies in a chain (for example a load balancer and nginx) the last entry is the address of the first proxy, and all clients share a bucket again. The address is never stored: only a keyed hash, for at most one day (`docs/PRIVACY-IMPLEMENTATION-NOTES.md`, section 1.2).

`APP_URL` must be the HTTPS address people use. An admin request whose `Origin` is neither `APP_URL` nor the request host is refused.

### nginx example (verified)

This configuration was used for the checks in section 9, in an `nginx:stable-alpine` container (nginx 1.30.5) with a self-signed certificate in front of the web container:

```nginx
server {
    listen 443 ssl;
    server_name study.example.org;
    ssl_certificate     /etc/nginx/tls/cert.pem;
    ssl_certificate_key /etc/nginx/tls/key.pem;

    # At least MAX_AUDIO_UPLOAD_MB plus room for the multipart form fields.
    client_max_body_size 110m;

    location / {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        # Overwrite, do not append: the app trusts the last entry.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
    }
}
```

### Testing behind TLS

Cookies marked `Secure` are not sent over plain HTTP, so a test of the admin over `http://` from another machine, or with `curl`, fails with 401 after a successful login. That is the intended behavior, not a fault (verified: the cookie from an HTTPS login gives 200 over HTTPS and 401 over plain HTTP). To test a production build:

- on the same machine, use Chrome on `http://localhost` (expected to work, see section 2); or
- put the nginx configuration above in front with a self-signed certificate, set `APP_URL` to the HTTPS address and use `curl -k` or accept the certificate in the browser.

The browser check of the Content Security Policy is `scripts/check-production-csp.mjs`:

```bash
CHECK_BASE_URL=https://study.example.org CHECK_ADMIN_PASSWORD=... node scripts/check-production-csp.mjs
```

It needs the development dependencies of the web app (Playwright with Chromium). It opens the welcome page, signs in, opens every admin page, starts a TEST session and runs the microphone check with a built-in test microphone.

## 8. Backups

Two stores hold the research data, and a backup needs **both, taken together**:

- **PostgreSQL** holds every record, every transcript and translation text, all provenance and the SHA-256 of every audio file.
- **The media store** holds the audio bytes: source recordings, derived WAV files, synthesized audio and export archives.

A database backup without the audio is incomplete: the recordings are the primary research data and cannot be recreated. An audio backup without the database is also incomplete: the files have names built from ids, and without the database nobody can tell which participant session, task, transcript or model run a file belongs to (spec 114).

### PostgreSQL

Either of:

- the hosting provider's managed backups with point-in-time recovery (check with the provider: retention time, where the backups are stored, how a restore is requested), or
- `pg_dump` in the custom format, which `pg_restore` can restore selectively and in parallel:
  ```bash
  pg_dump "$DATABASE_URL" --format=custom --no-owner --file dialect_study_$(date -u +%Y%m%dT%H%M%SZ).dump
  ```

`pg_dump` gives a consistent snapshot while the application runs. Use a `pg_dump` version that is the same as or newer than the server.

### Media store

- **S3-compatible:** turn on bucket versioning or the provider's replication if available (check with the provider), or copy the bucket to a second private location on a schedule. Files are written once and never overwritten, so an incremental copy is enough.
- **Local volume:** copy the directory `LOCAL_STORAGE_ROOT` without its `.tmp` subdirectory (unfinished uploads), for example with `rsync -a --exclude .tmp` or `tar`.

### Taking the two together

The media store only grows, and a file is written before its database row is committed. Therefore:

1. dump the database first;
2. copy the media store second.

Every file the dump refers to then exists in the copy. Files that arrived in between are extra and harmless. The one exception is the audited "Delete recording" workflow and the TEST and DEMO data reset, which remove files: do not run them during a backup.

Backups contain voice recordings and questionnaire answers. Store them encrypted, in a location approved for the study's data, with the same access rules as the live system, and include them in the retention and deletion decisions of the data management plan (`docs/PRIVACY-IMPLEMENTATION-NOTES.md`).

### Restore test procedure

A backup that was never restored is a hope, not a backup. Run this after the first backup and after every change of the backup method:

1. Create an empty database: `createdb dialect_study_restore`.
2. Restore: `pg_restore --dbname=dialect_study_restore --no-owner --exit-on-error <file>.dump`.
3. Compare row counts of the main tables between the source and the restored database (`studies`, `protocol_versions`, `sessions`, `session_consents`, `utterances`, `media_assets`, `jobs`, `admin_audit_log`, `drizzle.__drizzle_migrations`), and the number of triggers (`select count(*) from pg_trigger where not tgisinternal;`), because the immutability rules live in triggers.
4. Copy the media backup to a directory and verify every file against the restored database:
   ```bash
   psql -d dialect_study_restore -At -F '|' -c \
     "select sha256, size_bytes, storage_key from media_assets where deleted_at is null order by storage_key" \
     | scripts/verify-media-backup.sh /path/to/media-copy
   ```
   The script prints `media rows: N, verified: N, missing: 0, mismatch: 0` and exits with 0 only when every file exists with the recorded size and SHA-256.
5. Optional: start a web container against the restored database and the media copy, sign in and play one recording.
6. Drop the test database and delete the media copy.

### Restore test of 2026-10-03 (recorded result)

Performed on the development machine with the containers of section 2, a throwaway database `dialect_study_smoke` and a temporary media volume.

| Step | Result |
|---|---|
| Data before the dump | Seeded study, 3 sessions, 2 submitted utterances, 3 media files (one 98.9 MiB WAV, one WebM fallback recording, one WAV derived from it by the worker), 3 jobs, 4 audit rows |
| `pg_dump --format=custom --no-owner` (pg_dump 17.11) | 156 615 bytes |
| `pg_restore --no-owner --exit-on-error` into `dialect_study_restore` | exit code 0 |
| Row counts, source and restored | identical: `admin_audit_log` 4, `drizzle.__drizzle_migrations` 3, `jobs` 3, `media_assets` 3, `protocol_versions` 2, `session_consents` 3, `sessions` 3, `studies` 1, `utterances` 2 |
| Triggers, source and restored | 26 and 26 |
| Media volume copied with `tar` (without `.tmp`) | 3 files |
| `scripts/verify-media-backup.sh` against `media_assets` of the restored database | `media rows: 3, verified: 3, missing: 0, mismatch: 0`, exit code 0 |
| Negative control: one byte changed in one copied file | `MISMATCH` for that file, `verified: 2, mismatch: 1`, exit code 1 |
| Clean-up | restore database dropped, copies deleted |

This shows that the procedure works for this schema. It does not replace a restore test on the production backup system.

## 9. Production configuration checks (2026-10-03)

Run against the production images (`NODE_ENV=production`) behind the nginx configuration of section 7, `APP_URL=https://localhost:3443`, `TRUST_PROXY=true`, no `OPENAI_API_KEY`.

| Check | Evidence | Result |
|---|---|---|
| Admin cookie flags | `set-cookie: dts_admin=...; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=strict` (checked on 2026-10-03, before the cookie got the `__Host-` prefix: over https in production the name is now `__Host-dts_admin` with the same attributes) | pass |
| Participant cookie flags | `set-cookie: dts_participant=...; Path=/; Expires=...; Secure; HttpOnly; SameSite=lax` | pass |
| `Secure` cookie not usable over plain HTTP | admin API with the cookie: 200 over HTTPS, 401 over `http://` | pass |
| Security headers on every response | `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: microphone=(self), camera=(), geolocation=()`; API responses `Content-Security-Policy: default-src 'none'; media-src 'self'; frame-ancestors 'none'`; no `X-Powered-By` | pass |
| Page Content Security Policy | `default-src 'self'; script-src 'self' 'nonce-...' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests` on all 11 pages, a new nonce per request, no `unsafe-eval` | pass |
| Pages load under that policy in Chromium | welcome, admin login, all nine admin pages, participant flow up to the microphone check: all 200, no blocked script, style, image, font, connection or worklet | pass, with one finding below |
| Recorder worklet under the policy | microphone check finished with capture method `audio_worklet_pcm`; `/worklets/pcm-capture.worklet.js` 200 `application/javascript` | pass |
| Mock AI provider off | worker start log: `"providers":["openai"],"openaiConfigured":false`; Settings shows only `openai`; ASR jobs fail with `CONFIGURATION_MISSING` | pass |
| `/dev/*` pages | `/dev/ui-kit`, `/dev/recorder`, `/dev/admin-shell`: 404 | pass |
| No `.env` content, no source maps served | `/.env`, `/.env.docker`, `/package.json`, `/pnpm-workspace.yaml`: 404; a chunk URL with `.map` appended: 404; no `.map` file under `.next/static`; no `.env*` file in the image | pass |
| Readiness fails without database | section 6 | pass |
| Upload size limit | through nginx with `client_max_body_size 110m`: 98.88 MiB WAV accepted (200, SHA-256 returned, 2.8 s); 101.07 MiB refused by the app (413 `PAYLOAD_TOO_LARGE`, `maxBytes: 104857600`); 114.26 MiB refused by nginx (413) | pass |
| Web and worker share the media volume | a WebM recording stored by the web container was converted by a `derive_wav` job in the worker container; `sha256sum` in the worker container equals `media_assets.sha256` for all 3 files | pass |
| No secrets in logs | `grep` for the admin password value, the session secret value, the database URL with its password and the cookie names in the logs of `web`, `worker` and `migrate`: 0 hits each | pass |
| Worker heartbeat | Dashboard and Settings show the worker as healthy with its id and last heartbeat | pass |

**Finding (fixed, production check repeated): one Content Security Policy report per page, caused by a library probe.** In the build that was checked, Chromium reported `directive=script-src blocked=eval` once on each page, from the shared JavaScript chunk that contains Zod 4. Zod tests whether the page may compile code by calling `new Function("")` inside `try` and `catch`. The policy blocks the call (it has no `unsafe-eval`), Zod then uses its ordinary parser, and everything works. Nothing is loaded or executed. The policy was **not** weakened. The fix is `config({ jitless: true })` from Zod in `apps/web/instrumentation-client.ts`, the Next.js file that runs in the browser before any other application code, so the setting is in place before the first schema is created and Zod skips the probe (unit test: `apps/web/instrumentation-client.test.ts`). Server code is unchanged. **Repeated on 2026-10-04 on a new production build** (the web image of the isolated end-to-end stack, `docker-compose.e2e.yml`, on `http://localhost:3210`): `scripts/check-production-csp.mjs` without `CHECK_TOLERATE_BLOCKED_EVAL` ended with `PASSED: no Content Security Policy violation, console error or page error.` on 11 pages with a policy header, the microphone check included. The option stays in the script only as a diagnostic aid.

Not covered by these checks: the login rate limit under production settings (it has unit tests in `apps/web/lib/server/rate-limit.test.ts`), and anything that needs a real OpenAI key.

## 10. CSC Rahti and OpenShift notes

Spec 112 names CSC Rahti (OpenShift) as a possible host. The application is not tied to it. This section separates what was checked from what must be asked.

**Checked against the CSC documentation (docs.csc.fi, read on 2026-10-03):**

- Rahti runs a container as a random user that belongs to the root group, never as root. Images must support an arbitrary user id in group 0, and only root may listen on ports below 1024 ("Creating images"). Both images meet this: files are owned by group 0, `/data` is group-writable, the web app listens on 3000. Tested locally with `--user 1234567:0`.
- A Route exposes one port of one Service over HTTP or HTTPS. The documented example uses `termination: edge` with `insecureEdgeTerminationPolicy: Redirect`. Hosts under `*.2.rahtiapp.fi` and `*.rahtiapp.fi` get a DNS record and a valid TLS certificate automatically ("Kubernetes concepts").
- Secrets and ConfigMaps are given to containers as environment variables or mounted files. The documentation states that Secrets are stored base64-encoded, which is an encoding, not encryption.
- The documented persistent volume example uses the storage class `standard-csi` with access mode `ReadWriteOnce`. The warning in section 3 applies.
- CSC offers an object storage service (Allas) that can be used from Rahti.

**From the OpenShift documentation (route configuration), not checked against the Rahti version:**

- Route annotations `haproxy.router.openshift.io/timeout` (server-side timeout) and `haproxy.router.openshift.io/ip_whitelist` (allowed source addresses, which could restrict `/admin` only if the admin had its own route).

**Must be checked with CSC before a deployment (nothing here is assumed):**

- whether Allas is approved for this study's voice recordings, its S3 endpoint, region value, whether it needs path-style addressing (`S3_FORCE_PATH_STYLE`), and whether it accepts conditional writes (`If-None-Match`, see `docs/AUDIO-CAPTURE.md`, "Drivers");
- whether a managed PostgreSQL service is available for the project, its version, backups and restore procedure;
- the request body size limit of the router, if any, and the default route timeout;
- how the router sets `x-forwarded-for` (appends or replaces), which decides whether `TRUST_PROXY=true` gives one bucket per client;
- backup or snapshot options for persistent volumes;
- project quotas (memory, storage) and billing units;
- where the images are stored (the Rahti image registry or another registry) and how they are built there.

**Deployment outline for OpenShift (resources to create, to be written and tested on the target):**

1. One Secret with the secret variables of section 4, one ConfigMap with the others.
2. A Job (or pre-deployment hook) that runs the migration command with the worker image.
3. Deployment `web` (web image, port 3000, readiness probe `GET /api/health/ready`, liveness probe `GET /api/health`, environment `HOSTNAME=0.0.0.0` set explicitly, because the platform sets `HOSTNAME` to the pod name) with a Service and an edge-terminated Route.
4. Deployment `worker` (worker image, no port, termination grace period above `WORKER_SHUTDOWN_TIMEOUT_MS`).
5. With `STORAGE_DRIVER=local`: one PersistentVolumeClaim mounted at `/data/media` in both, strategy `Recreate`, one replica each, and pod affinity so that both run on the same node. With `STORAGE_DRIVER=s3`: no volume.

The sibling project's runbook (`Manipulative-ai2/RAHTI-RUNBOOK.md`) shows the same platform with one persistent volume and the `Recreate` strategy, including the case of a pod that cannot start because the previous pod still holds the ReadWriteOnce volume.

## 11. Release checklist (Phase 7)

Before real participants:

**Study content**
- [ ] Every example text of the seed is replaced: study title, information sheet, consent items, privacy notice URL, contact details, instructions, task prompts, questionnaires, debrief (Study Flow, Questionnaires). Search the published protocol preview for "Example text" and for square brackets.
- [ ] The protocol, the consent version and both questionnaires are published, and the published protocol is the current one (`docs/PROTOCOL-VERSIONING.md`, "Publish checklist").
- [ ] The Finnish participant texts are final and approved through the ethics and data protection process.

**Storage and database**
- [ ] Production storage is chosen (private S3-compatible bucket, or one volume with the limits of section 3) and approved for voice recordings.
- [ ] The bucket is private. Readiness reports storage `ok`.
- [ ] Migrations applied; Settings shows "Up to date".

**HTTPS, headers, rate limits**
- [ ] The site is reachable only over HTTPS; HTTP redirects.
- [ ] `APP_URL` is the HTTPS address. `NODE_ENV=production`.
- [ ] Cookies carry `Secure`, `HttpOnly` and `SameSite` (section 9 shows how to look).
- [ ] Security headers and the page Content Security Policy are present; `scripts/check-production-csp.mjs` passes.
- [ ] Proxy body size limit is at least the maximum upload size; a recording near the limit uploads.
- [ ] `TRUST_PROXY` matches the real proxy chain: `GET /api/health/ready` answers `"warnings":0` and the startup log has no `CONFIGURATION WARNING`. With `TRUST_PROXY=true`, six wrong admin passwords from one address are followed by a refusal (429), and the correct password still signs in.
- [ ] `ADMIN_PASSWORD` is random (for example `openssl rand -base64 18`) and stored in a password manager; `ADMIN_SESSION_SECRET` is random.
- [ ] `APP_VERSION` is set to the released version (the server refuses to start in production without it).
- [ ] The env files on the server are readable by the service user only (`chmod 600`).
- [ ] The reverse proxy limits `POST /api/admin/login` per client address (section 7, "Admin login").
- [ ] `/dev/ui-kit` answers 404.

**Backups**
- [ ] Database backup and media backup are scheduled, both, and stored in an approved location.
- [ ] The restore test of section 8 was run on the production backup system and its result is recorded.

**Privacy review**
- [ ] The data protection review read `docs/PRIVACY-IMPLEMENTATION-NOTES.md` and its open items are decided: lawful basis, retention period, withdrawal and deletion policy, future reuse, agreement with the AI provider.
- [ ] The privacy notice names the external AI provider and what is sent to it.

**Audio capture and the study laptop**
- [ ] Capture validated on the study laptop with the study microphone (`docs/AUDIO-CAPTURE.md`, "Validating capture on the study laptop"). That checklist uses `/dev/recorder`, which exists only in a development build.
- [ ] Browser lock-down as appropriate: current Chrome or Chromium, a dedicated browser profile without extensions, microphone permission granted to the site only, system sound enhancements off, automatic updates and sleep postponed during sessions, "Study laptop mode" on in Settings so the completion page offers "Start next participant".

**AI configuration and pipeline test**
- [ ] `OPENAI_API_KEY` is set in the secret; Settings, "Test connection" succeeds.
- [ ] The model configurations on the AI Pipeline page name models that the account can use, and their parameters are accepted (the seed identifiers were not verified against the live API, see `docs/IMPLEMENTATION-STATUS.md`).
- [ ] `AI_ALLOW_MOCK_PROVIDER` is unset or `false`.
- [ ] One TEST session was recorded end to end on the production system, processed in a `test` batch (ASR, both translations, TTS), inspected in Session Detail and exported. Then confirm that the default research export does not contain it.
- [ ] The worker is shown as healthy on the Dashboard.

## 12. Runbook

Look first at: the Dashboard status rows, Settings (Database, Media storage, AI provider, Application), `GET /api/health/ready`, and the container logs (search by the `x-request-id` of a failed response, or by `jobId`).

### AI provider outage or key problem

Signs: "Processing errors" rises on the Dashboard; jobs fail with a provider error or `CONFIGURATION_MISSING`.

- Data collection is not affected. Participants can record and finish (spec 110.8, 144).
- Temporary provider errors are retried automatically with a growing delay, up to the job's maximum attempts.
- After the outage, or after fixing the key (Settings, "Test connection"), retry the failed jobs of a batch on the Processing Runs page. A retry never creates a duplicate output (`docs/AI-PROVENANCE.md`, "Idempotency").
- An empty, refused or cut-off translation is recorded as a failed run and is not retried automatically (`docs/IMPLEMENTATION-STATUS.md`, "Deviations").
- Do not switch to the mock provider on a research system.

### Worker down

Signs: Dashboard row "Worker" is not healthy; queued jobs grow; no log lines from the worker.

- Collection continues. Jobs wait in the queue.
- Read the worker log. A configuration error is printed at start with the variable names.
- Restart the worker container. Jobs that were running when it died are released after `WORKER_LOCK_TIMEOUT_MS` (10 minutes by default) and run again.
- Check that the worker and the web app use the same `DATABASE_URL` and the same media store.

### Storage full or not writable

Signs: uploads fail with "The recording could not be saved. Please try again."; readiness reports storage `not_ready`; Settings shows the storage as not connected.

- The participant page keeps the recording in the browser and offers a retry, so keep the page open. A failed upload leaves no half-written file and no accepted media row.
- Free or add space (larger volume, bucket quota). Export archives are the largest files that can be removed safely after download; source recordings must never be removed to make room.
- If collection cannot continue, set "Allow new sessions" off or turn on maintenance mode in Settings.
- Afterwards check readiness and upload one TEST recording.

### Failed export

Signs: an export job on the Data & Export page shows "failed" with its error.

- A failed export is not retried automatically. Fix the cause (worker down, storage full, a missing media file) and create a new export.
- A missing file error names the media asset. Check whether the recording was removed by the audited deletion workflow (its row has `deleted_at`) or is missing from storage (restore it from the media backup and verify it with `scripts/verify-media-backup.sh`).
- Every export is written to the audit log with its filters (`docs/EXPORT-SCHEMA.md`, "Audit").

### Abandoned sessions

Signs: sessions "in progress" that never finish.

- A session without activity for longer than the study's inactivity timeout (Settings, Limits) is marked `abandoned`, and a recording that was uploaded but never submitted is deleted. Submitted recordings stay.
- Abandoned and withdrawn sessions are left out of exports by default and can be included explicitly (`docs/EXPORT-SCHEMA.md`, "Filters and defaults").
- On a study laptop, "Start next participant" always starts a clean session; the previous participant's state is not shown (spec 137, 138).
- Whether the data of a participant who stopped is kept is a study policy decision, not a technical one (`docs/PRIVACY-IMPLEMENTATION-NOTES.md`).

### Database unreachable

Signs: readiness 503 with `"database":{"ok":false}`; every page fails.

- The web container stays up and reports not ready, so the platform stops sending traffic to it.
- Fix the database or the network. No restart of the web app is needed afterwards: the connection pool reconnects.
- A recording that a participant was uploading at that moment stays in the browser and can be retried.

### Rotating secrets

- `ADMIN_PASSWORD`: change the secret, restart the web container. Every existing admin session ends at once: the session cookie is bound to the password it was issued under.
- `ADMIN_SESSION_SECRET`: signs every admin out and resets the rate limit hashes. Participant sessions are not affected.
- `OPENAI_API_KEY`: change the secret, restart web and worker.

## 13. Database roles

The database enforces the scientific invariants with triggers (`docs/DATA-MODEL.md`, "Immutability rules and triggers"). A superuser and the owner of the tables can switch triggers off, so in a deployment the web app and the worker must connect as neither. Two roles are used:

| Role | Default name | Used by | Connection variable | Can do |
|---|---|---|---|---|
| Migration owner | `dialect_owner` | the migration command only | `MIGRATION_DATABASE_URL` | Owns the schemas `public` and `drizzle` and every table, type and function in them. Creates and alters them. Not a superuser, cannot create roles or databases. |
| Application | `dialect_app` | web, worker, seed | `DATABASE_URL` | `SELECT, INSERT, UPDATE, DELETE` on the tables of `public`, `USAGE` on its sequences and enum types, `EXECUTE` on its functions, `SELECT` on `drizzle.__drizzle_migrations` (the Settings page shows the migration state), and temporary tables (the test data reset uses one). Nothing else. |

What the application role cannot do, by construction: `TRUNCATE` (no privilege), `ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER`, `DROP TABLE`, `ALTER TABLE` and replacing a guard function (not the owner), creating objects in `public` (no `CREATE` on the schema), `SET session_replication_role` (not a superuser), `SET ROLE` to the owner (not a member of any role). `packages/db/src/roles.test.ts` creates both roles on the test server with the script below, connects as the application role, and checks all of this next to the ordinary work of the services (inserting a session with consent, utterance and transcript, updating the session status, the guarded reset of test data).

The superuser of the server (`postgres`) is needed for two things only: running the role script, and backup and restore (section 8). It is never given to a container of the application.

### The script

`docker/postgres/create-roles.sql` does the whole setup in one `DO` block. It is idempotent: a second run repairs ownership and privileges and changes nothing else. It works in both orders:

- on an empty database, before the first migration (the owner role then creates everything itself);
- on a database that was migrated earlier by another role, for example by `postgres` (ownership of every existing table, sequence, type and function in `public` and `drizzle` is transferred to the owner role).

Steps of the script:

1. Create the two roles when they are missing and set their attributes: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. Set the passwords when they are given. Stop with an error when the application role is a member of another role.
2. Database: the owner role gets `CONNECT, TEMPORARY, CREATE`, the application role `CONNECT, TEMPORARY`.
3. Schemas: `public` and `drizzle` are owned by the owner role. `CREATE` on them is revoked from `PUBLIC`. The application role gets `USAGE`.
4. Ownership of the existing objects goes to the owner role.
5. The application role gets its privileges on the existing objects. Everything else it may hold on them is revoked first.
6. Default privileges: `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public` grants the same privileges on every table, sequence, type and function the owner role creates later. A new migration therefore needs no grant statements and no second run of the script.

The script takes its parameters from session settings, and `docker/postgres/create-roles.sh` is the wrapper that sets them and runs the file with `psql`:

| Variable of the wrapper | Required | Default | Meaning |
|---|---|---|---|
| `DB_ADMIN_URL` | yes | none | Connection to the application database as a superuser. |
| `DB_OWNER_ROLE` | no | `dialect_owner` | Name of the migration owner role. |
| `DB_APP_ROLE` | no | `dialect_app` | Name of the application role. |
| `DB_OWNER_PASSWORD` | no | empty | Password to set for the owner role. Empty leaves the password as it is. |
| `DB_APP_PASSWORD` | no | empty | Password to set for the application role. Empty leaves the password as it is. |

```bash
DB_ADMIN_URL=postgresql://postgres:...@db-host:5432/dialect_study \
DB_OWNER_PASSWORD="$(openssl rand -base64 30)" \
DB_APP_PASSWORD="$(openssl rand -base64 30)" \
sh docker/postgres/create-roles.sh
```

Keep the two passwords: they go into the two connection strings. There is no default password anywhere. A role created without a password cannot log in with one until a password is set (run the wrapper again with the password, or use `\password <role>` in `psql`). The passwords travel inside SQL statements, so run the script over a trusted connection and with statement logging off. A password with characters such as `/`, `+`, `@` or `:` must be percent-encoded when it is written into a connection string.

Without the wrapper, in a `psql` session of a superuser on the application database:

```sql
SELECT set_config('dialect_setup.owner_password', '...', false);
SELECT set_config('dialect_setup.app_password', '...', false);
\i docker/postgres/create-roles.sql
```

(`dialect_setup.owner_role` and `dialect_setup.app_role` change the role names.)

Run the script once per database. Run it again after a restore made with `pg_dump --no-owner` as a superuser (section 8): the restored objects then belong to the role that restored them, and the script moves them to the owner role and grants the privileges again.

### Connection strings

| Variable | Read by | Value |
|---|---|---|
| `DATABASE_URL` | web, worker, seed, and the migration command as a fallback | `postgresql://dialect_app:<password>@<host>:5432/dialect_study` |
| `MIGRATION_DATABASE_URL` | the migration command only (`packages/db/src/migrate.ts`, `pnpm db:migrate`, the `migrate` service) | `postgresql://dialect_owner:<password>@<host>:5432/dialect_study` |

The migration command uses `MIGRATION_DATABASE_URL` when it is set and not empty, and `DATABASE_URL` otherwise. The fallback keeps development working with a single connection string. In a deployment `MIGRATION_DATABASE_URL` must be set: with only the application role the migration fails with "permission denied", which is the intended result. Give `MIGRATION_DATABASE_URL` only to the migration job, not to the web and worker containers. Both variables are secrets.

Order for a new deployment: run the role script, run the migration command with `MIGRATION_DATABASE_URL`, then (optionally, for a development or demonstration database) the seed with `DATABASE_URL`, then start web and worker with `DATABASE_URL`. Order for an existing deployment that still connects as `postgres`: back up, run the role script, change `DATABASE_URL` to the application role and add `MIGRATION_DATABASE_URL` for the migration job, restart web and worker.

### How the Compose stack wires it

- `docker-compose.yml` (development PostgreSQL) is unchanged: the local server keeps the `postgres` superuser with the development password, and `pnpm db:migrate`, `pnpm dev` and the tests keep working with the single `DATABASE_URL` of `.env.example`. In development the triggers protect against bugs. The role separation is for deployments.
- `docker/app.env.example` no longer contains a connection string with the superuser or any password. `DATABASE_URL` and `MIGRATION_DATABASE_URL` are empty and must be filled in with the two roles.
- `docker-compose.app.yml` has a `db-roles` service under the profile `roles`. `up` does not start it. It runs the wrapper in a `postgres:17` container against the `postgres` service:
  ```bash
  DB_OWNER_PASSWORD=... DB_APP_PASSWORD=... \
  docker compose -f docker-compose.yml -f docker-compose.app.yml run --rm db-roles
  ```
  `DB_ADMIN_URL` defaults to the superuser of the local Compose PostgreSQL service. The passwords come from the shell and are not written to `.env.docker`.
- The `migrate` service reads `.env.docker` and therefore connects with `MIGRATION_DATABASE_URL`.
- The `web` and `worker` services read the same file, and the Compose file sets `MIGRATION_DATABASE_URL` to an empty value for both, so the owner password is not present in their environment.

First start of the Compose deployment with roles:

```bash
cp docker/app.env.example .env.docker          # then fill in the secrets and both connection strings
docker compose -f docker-compose.yml up -d --wait postgres
DB_OWNER_PASSWORD=... DB_APP_PASSWORD=... \
docker compose -f docker-compose.yml -f docker-compose.app.yml run --rm db-roles
docker compose -f docker-compose.yml -f docker-compose.app.yml up --build
```

### Verification (2026-10-03)

| Check | How | Result |
|---|---|---|
| Role script on an existing database and on an empty one, twice | `packages/db/src/roles.test.ts` | pass |
| Application role does the service work and the guarded reset | same test | pass |
| Application role cannot disable triggers, truncate, set `session_replication_role`, drop or alter tables, replace a guard function | same test, SQLSTATE `42501` each | pass |
| Owner role applies the migrations, and a table it creates later is usable by the application role | same test | pass |
| Wrapper with `psql` in a `postgres:17` container against a scratch database on the development server, run twice, with a password that contains a quote and a space, then `migrate.ts` with `MIGRATION_DATABASE_URL` | by hand | pass: `Database roles are set up`, `Migrations applied`, every object owned by the owner role, the application role got `permission denied` or `must be owner` for `TRUNCATE`, `DISABLE TRIGGER`, `SET session_replication_role` and `DROP TABLE` |
| `docker compose ... --profile roles config` | by hand | valid |

Not verified: a full `up` of `docker-compose.app.yml` with the two roles (image build and start of web and worker as the application role).

### Limits

- The role separation protects against a bug or an injection in the application. It does not protect against a person who has the superuser password or the owner password.
- The application role keeps `DELETE` on the tables, because the services delete drafts, candidate recordings and demo and test data. What a DELETE may remove is decided by the triggers.
- The application role keeps `TEMPORARY` on the database. The guard functions use a fixed `search_path` and schema-qualified names, so a temporary table cannot stand in for a real one.
- `CONNECT` on the database is not revoked from `PUBLIC`. Other login roles of the same server can connect, but have no privileges on the tables. On a shared server revoke it by hand.
