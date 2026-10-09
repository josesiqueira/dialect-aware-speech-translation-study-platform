# Privacy implementation notes

This document records how the code implements the privacy and security requirements of the specification (sections 26, 39, 61, 67, 68, 138, 160). Each work package appends its own section. Keep entries factual: what is stored, where, for how long, and which code enforces it.

**This is an implementation note, not legal advice.** It describes what the software does, so that the researchers and the data protection officer can assess it. It does not decide the lawful basis, the retention period or any other legal question. In particular, do not assume that consent alone is the lawful basis for every processing purpose, or that recording a consent choice in the software settles the requirements of data protection law (spec 6.2). Those decisions belong to the controller and are listed as open items in section 12.

How to read it: sections 1 and "Participant API" describe the web platform and the participant flow in detail. Sections 3 to 12 give the overview a data protection review needs: the personal data and where they are, what goes to the external AI provider, logs, retention, exclusion and deletion, exports, access control, and the open items.

## 1. Platform (web server plumbing)

Code: `apps/web/lib/server/**`, `apps/web/proxy.ts`, `apps/web/next.config.ts`, `apps/web/lib/client/api.ts`.

### 1.1 Cookies

The application sets two cookies. Both are strictly necessary for the function the person asked for (keeping a study session, keeping an admin signed in). No analytics, advertising or third-party cookie is set.

| Cookie | Set by | Content | Flags | Lifetime |
|---|---|---|---|---|
| `dts_participant` | `lib/server/participant-cookie.ts` | An opaque random token (32 random bytes, base64url). It contains no participant data and no session id. | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production | Until the expiry time given by the session service (default `PARTICIPANT_SESSION_TTL_HOURS`, 24 hours). Cleared on completion or withdrawal (spec 138). |
| `dts_admin` (over https in production: `__Host-dts_admin`) | `lib/server/admin-auth.ts` | An encrypted and signed value (iron-session seal) holding only `{ role: "admin", issuedAt, expiresAt, actorLabel: "admin" }` and a 16 character keyed hash of the admin password it was issued under. | `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, `Secure` in production | `ADMIN_SESSION_TTL_HOURS` (default 8 hours). Deleted and ended on the server on sign out. |

Rules:

- The database stores only the SHA-256 hash of the participant token (`sessions.token_hash`), never the token. A copy of the database does not allow anyone to take over a session.
- Admin session expiry is enforced on the server from the sealed `expiresAt` value on every request, not only by the cookie `Max-Age`.
- **Cookie name prefix.** In production over https the admin cookie is named `__Host-dts_admin`. A browser accepts a cookie with the `__Host-` prefix only when it has `Secure`, `Path=/` and no `Domain` attribute and comes from a secure origin, so another subdomain or a plain http response cannot set or replace it. Over plain http (development, and a production build tested on `http://localhost`) the name is `dts_admin`, because a browser refuses the prefix there. The name is decided from `NODE_ENV` and `APP_URL` (`adminCookieName` in `lib/server/admin-session.ts`), and `proxy.ts` and the route handlers use the same function.
- **Sign out ends the session on the server.** The sign out writes the audit row `admin.logout` with the time `sessionsValidAfter`. Every admin cookie issued before that time is rejected (`getAdminSession`), also a copy of the cookie that someone kept. There is one shared admin password and no user accounts, so a sign out ends every admin session on every device. This is intended: the researchers sign in again. The time is kept in the audit log because that table is append-only in the database (no update, no delete, not even by the test data reset), so a sign out cannot be undone, and no schema change and no key in the study settings is needed. The web process caches the time for 5 seconds, so with several web replicas another replica can accept a signed-out cookie for at most 5 seconds. Only a request with a valid session ends the sessions: an anonymous request to the sign out route changes nothing.
- **A password change ends every session.** The sealed cookie carries a keyed hash of `ADMIN_PASSWORD` (HMAC-SHA-256, cut to 16 hexadecimal characters). A cookie whose hash does not match the current password is rejected, in `proxy.ts` and next to the data. Changing `ADMIN_SESSION_SECRET` also ends every session at once.
- **Separate keys.** `ADMIN_SESSION_SECRET` is never used directly. The key that seals the cookie, the key of the password hash in the cookie and the key that hashes client addresses for rate limits are derived from it with HKDF-SHA-256 and a purpose label each (`lib/server/keys.ts`).
- Browser JavaScript cannot read either cookie (`HttpOnly`). No study state is placed in URLs (spec 61) or in `localStorage` by the platform code.

### 1.2 Rate limit data

Table: `rate_limit_hits` (`bucket_key`, `created_at`). Code: `lib/server/rate-limit.ts`.

- A bucket key never contains a raw IP address. The client address is replaced by an HMAC-SHA-256 and shortened to 32 hexadecimal characters (`clientAddressKey`). The HMAC key is derived from `ADMIN_SESSION_SECRET` for this purpose only (HKDF, label `dts/client-address-hash/v1`), so it is not the key that seals the admin cookie. Without the secret the address cannot be recomputed from the stored value by testing candidate addresses.
- The client address is read from `x-forwarded-for` only when `TRUST_PROXY=true`. Otherwise the application does not process the client address at all and every client shares one bucket.
- Rows are deleted when they are older than one day (`purgeOldHits`, run on each failed admin login and each new participant session). The longest window in use is 24 hours (the daily budget of Demo Mode).
- Failed admin logins are throttled, see "Admin login throttle" below. A successful login reads and writes no row.
- **`TRUST_PROXY=false` on a public address.** Every client then shares one bucket, so one client can use up the limit of 120 new participant sessions per hour for everyone. The server prints a warning at startup and counts it in `GET /api/health/ready` (`warnings`), with the text in the server log. The fix is one trusted reverse proxy and `TRUST_PROXY=true` (`docs/DEPLOYMENT.md`).

#### Admin login throttle

Code: `loginAdmin` in `lib/server/admin-auth.ts`.

1. The password is checked first, in constant time. **A correct password always signs in.** No counter can refuse it. The earlier limit (5 failures per address, with every client sharing one address when `TRUST_PROXY=false`) let anyone lock the researchers out with six requests every 15 minutes. That is no longer possible.
2. A wrong password is counted. At most 30 failed attempts per minute (1800 per hour) are answered with `401` and written to the audit log. Further failed attempts get `429` and are neither stored nor audited, so a flood of guesses cannot fill the audit log or the rate limit table. They produce a log line.
3. With `TRUST_PROXY=true` the failures of one client address are also limited to 5 per 15 minutes. A correct password is accepted from a limited address too. Without a real client address there is no per-address limit.

What this means for password guessing, stated plainly: **the throttle does not cap the number of guesses.** Because a correct password is never refused, a `429` tells the sender that the guess was wrong, exactly like a `401`. The number of passwords an attacker can test per hour is therefore limited only by how many requests the web server and the reverse proxy answer. As an order of magnitude, 100 requests per second are 360 000 guesses per hour. A bound on guesses and a login that cannot be blocked exclude each other when the server cannot tell clients apart, and the availability of the admin was chosen. The controls against guessing are:

- **The password itself.** Production requires at least 12 characters. Length alone is not enough: the password must be random, for example `openssl rand -base64 18` (24 characters, 144 bits). A random password of 12 characters from letters and digits has about 71 bits: at 360 000 guesses per hour, testing even one millionth of the possibilities takes hundreds of millions of years. A password from a list of common passwords or a dictionary phrase can fall within minutes at the same rate.
- **A request limit at the reverse proxy** for `POST /api/admin/login` per client address (for example 10 per minute), where the real address is known. Recommended in `docs/DEPLOYMENT.md`.
- **Detection.** Failed logins are in the audit log (up to 1800 per hour) and the log line `admin.login_rate_limited` shows that the rate was exceeded.
- The table is never part of a research export.

### 1.3 Audit log entries for authentication

`admin.login`, `admin.login_failed` and `admin.logout` rows are written to `admin_audit_log`. A failed login row contains the reason `wrong_password` only: no password content, no client address. Requests refused by the rate limit write no audit row (the table is append-only and must not be filled by an attacker); they produce a log line.

### 1.4 Logging rules

Code: `lib/server/logger.ts`, `lib/server/api.ts`.

- Each API request produces one log line with: request id, HTTP method, route path (without the query string), status, duration, and for failures the error code. For status 500 and above the error name, a stack trace and the chain of causes are added.
- Never logged: request bodies, response bodies, query strings, cookies, transcripts, audio content, questionnaire answers, consent answers, passwords, the client address.
- Database errors are logged with a fixed message plus the SQLSTATE code and the constraint, table and column names. The original message is not logged, because PostgreSQL and the query library include row values and query parameters in it, and those can be transcript text or answers.
- Redaction, first layer: the keys `authorization`, `cookie`, `set-cookie`, `password`, `apiKey`, `api_key`, `secret`, `token`, `OPENAI_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `S3_SECRET_ACCESS_KEY`, `S3_ACCESS_KEY_ID` and `DATABASE_URL` are replaced by `[REDACTED]` at the top level and up to three objects deep.
- Redaction, second layer: every serialized log line is searched for the configured secret values themselves (OpenAI key, admin password, session secret, S3 access key id, S3 secret key, database password) and each occurrence is replaced. This covers a provider that repeats the key inside an error message.
- Code that logs must pass ids and counts, not content. Use `ctx.logger`; do not use `console.log` in server code.

### 1.5 Error responses

`apiRoute` returns `{ error: { code, message, details? } }`. Unknown errors become `INTERNAL_ERROR` with a generic message: no stack trace, no provider message, no SQL. The request id in the `x-request-id` response header links a response to its log line.

### 1.6 Secrets

- All secrets are read on the server from environment variables validated in `lib/server/env.ts`. The module imports `server-only`, so the build fails if a client component imports it. No variable uses the `NEXT_PUBLIC_` prefix, so none is placed in the browser bundle (spec 26, 160.1).
- Validation errors name the invalid variables and never print values. They go to the server log and to the startup output. The public readiness endpoint does not name variables (section 1.9).
- The `.env` file holds every secret. On a server it should be readable by the service user only: `chmod 600 .env` (and the same for `.env.docker`).
- The admin password is compared in constant time (both sides hashed with SHA-256, then `timingSafeEqual`).

### 1.7 Response headers

- `Cache-Control: no-store, private` on every `/api/admin/**` response and `no-store` on every `/api/study/**` response (spec 67), set both by `apiRoute` and by `next.config.ts`.
- `Referrer-Policy: strict-origin-when-cross-origin`: other sites receive at most the origin, never a path.
- `Permissions-Policy: microphone=(self), camera=(), geolocation=()`: only the app itself may ask for the microphone; camera and location are disabled.
- Content Security Policy with `connect-src 'self'`: the browser can send data only to this application, so recordings cannot be sent to another host by page scripts.
- `X-Frame-Options: DENY` and `frame-ancestors 'none'`: the pages cannot be embedded in another site.
- `Strict-Transport-Security` in production.

### 1.8 Request forgery protection

Admin cookies are `SameSite=Strict`. In addition, every state-changing admin request, and login and logout, must come from the application's own origin (`Sec-Fetch-Site: same-origin`, or an `Origin` header equal to `APP_URL` or the request host). A request with neither header is refused.

### 1.9 Health endpoints

`/api/health` and `/api/health/ready` are public. They return the application version, a pass or fail result per check (`{ "ok": true }` or `{ "ok": false }`, nothing else) and the number of configuration warnings. They never return the names of environment variables, host names, paths, bucket names, connection strings or keys, and they never call a paid provider API. The names of invalid variables, the warning texts and the error details are written to the server log (at most once a minute per problem), where the operator reads them.

## Participant API (sessions, consent, uploads)

Code: `packages/research/src/sessions/**`, `apps/web/app/api/study/**`. Full description: `docs/PARTICIPANT-API.md`.

### What is stored about a participant

| Data | Where | Notes |
|---|---|---|
| Pseudonymous participant code (`P-` and 6 random characters) | `sessions.participant_code` | Random, never sequential, so it says nothing about the number of participants (spec 14). It is not part of any storage key or media row. |
| SHA-256 of the session token | `sessions.token_hash`, expiry in `token_expires_at` | The token itself exists only in the HttpOnly cookie. |
| Browser information (user agent, platform, language) | `sessions.browser_info_json` | Sent by the page, optional. Removed again when the session ends before consent. |
| Microphone check settings (class of the input device, requested constraints, actual track settings, AudioContext sample rate) | `sessions.audio_environment_json` | Technical settings only (spec 6.3). No device identifier and no device label, see "Device identifiers and the device label". |
| Consent choices with the text of every item shown | `session_consents` | One row per session, written once, never updated. |
| Accepted recordings | storage object and `media_assets` row | Only after the participant submits. |
| Capture metadata of a recording (requested constraints, actual track settings, class of the input device, user agent, declared values, technical probe fields) | `media_assets.metadata_json` | No personal metadata beyond the user agent (spec 32). No device identifier, no device label, no file tags. |
| Questionnaire answers | `questionnaire_responses`, `questionnaire_answers` | Only items of the pinned questionnaire version. |

### What is not stored

- **The client IP address** is never written to `sessions` or any other research table (spec 6.2). The rate limit of session creation stores only a keyed hash of the address, and only when `TRUST_PROXY=true` (section 1.2).
- **Microphone check audio.** `POST /api/study/mic-check` takes a strict JSON body with technical settings. An unknown field is refused, and no endpoint accepts test audio (spec 6.3, 160.4). A route test sends an audio field and checks that it is refused and that storage stays empty.
- **Rejected recordings.** Re-recording before Submit happens in the browser. An uploaded recording that is replaced, discarded, or left behind by withdrawal or abandonment is deleted (row and stored object). Only the accepted recording and the attempt count remain (spec 3.1, 10).
- Names, email addresses, identity codes: no endpoint asks for them (spec 153).
- **Device identifiers and the device label.** See the next section.
- **File tags of an upload.** A compressed recording can carry tags chosen by whoever made the file (title, artist, comment, encoder). The stored probe data are an allow-list of technical fields of the ffprobe output (format name, duration, size, bit rate, and per stream the codec, sample format, sample rate, channels and bit depth). Tags and the path of the temporary file are never stored (`technicalProbeFields` in `packages/storage/src/audio/validate.ts`).

### Device identifiers and the device label

The browser reports `deviceId` and `groupId` in the settings of the microphone track. They identify one device of one person's computer across visits to the site. The device label can contain a person's name (for example "Anna's AirPods").

- **Identifiers.** `deviceId` and `groupId` are removed in the browser before anything is sent (`describeMicrophone` in `apps/web/lib/client/recorder/microphone.ts`), from the track settings, the requested constraints and the capabilities. The server removes them again: in the request schemas (`audioEnvironmentSchema`, `captureMetadataSchema`) and in the session and demo services, so a caller that skips the schema cannot store them either.
- **Label.** The raw label is never stored. The browser derives a coarse class from it and drops the label: `built_in`, `usb`, `bluetooth`, `headset` or `unknown`. The class keeps what is useful for acoustic analysis (a Bluetooth headset records differently from a built-in microphone). The rule is a short keyword list (`classifyInputDevice` in `packages/domain/src/validators/sessions.ts`), applied to the lower-cased label, first match wins:

  | Class | Keywords |
  |---|---|
  | `bluetooth` | bluetooth, wireless, hands-free, airpods, buds |
  | `headset` | headset, headphone, earphone, earbud, kuuloke |
  | `usb` | usb, audio interface, or a USB vendor and product id such as `(046d:0825)` |
  | `built_in` | built-in, internal, integrated, microphone array, macbook, iphone, ipad, sisäinen |
  | `unknown` | anything else, and no label |

  The class is sent and stored in the existing field `deviceLabel` (`sessions.audio_environment_json.deviceLabel`, `media_assets.metadata_json.declared.deviceLabel`). The server applies the same rule to whatever arrives in that field, so a raw label from an older page is reduced to its class and dropped.
- Rows stored before this change can still hold a raw label or identifiers. Whether they must be cleaned is a decision for the researchers (section 12).

### What the participant can receive

`ParticipantState` contains the participant's own code, the texts of the current step and operational settings. It never contains transcripts, translations, synthesized audio, model or provider names, conditions or dialect classification (spec 3.1, 83, 110.9). The state builder (`state.ts`) does not read those tables. The test "no AI output reaches the participant" walks whole sessions while ASR output, human transcripts, translations and model configurations exist in the database and checks every response for their text and for field names of that kind. No endpoint serves audio to a participant: recordings are never publicly addressable.

### Session isolation

- The session is taken only from the cookie. Request bodies are validated with strict schemas, so a session id in a body is refused, and query parameters are ignored.
- Every presentation id and utterance id is checked against the cookie's session. An id of another session answers `404`, the same as an unknown id, so ids cannot be probed.
- State-changing requests must be same-origin (`Sec-Fetch-Site` or `Origin` check).
- The cookie is cleared on completion and on withdrawal in every deployment, not only in study laptop mode, and a dead cookie (expired, unknown, abandoned session) is cleared on the next state request. After completion the next person at the same browser gets a new session with a new code (spec 137, 138).
- Session creation is limited to 120 per hour per client address (spec 67). With `TRUST_PROXY=false` every client shares that limit (section 1.2).
- **Request size.** JSON bodies are read through a counted stream: at most 64 KB on the participant, demo and login routes (256 KB for questionnaire answers) and 1 MB on admin routes, otherwise `413`. On every route that needs a session the session is resolved before the body is read, so a request without a session costs no body read.
- **Uploads.** The recording is read once into one buffer and the file part is a view of that buffer, so it is in memory once. One upload runs at a time per session (a second one gets `409`). See `docs/PARTICIPANT-API.md`, "Large uploads".

### Withdrawal and abandonment

`POST /api/study/session/withdraw` marks the session, removes a recording that was uploaded but not submitted, and returns the debrief and contact text from the protocol. It does not delete submitted data and makes no promise about deletion: that is decided by the approved protocol and handled by the researchers (spec 13, 86). `markAbandonedSessions` does the same clean-up for sessions without activity for longer than the study's inactivity timeout (spec 108).

**Declining before consent.** The page tells a person who declines that nothing was stored. To make that true, a session that ends before consent (declined, or timed out) is marked `abandoned` and the technical data of its row are removed: `browser_info_json` (user agent, platform, language), `audio_environment_json`, `locale` and the token hash. The row itself stays, because a database guard forbids deleting a research session and the counts must stay correct. What remains is the random participant code, the protocol version, the status and the timestamps: nothing about the person or their browser.

**Sessions that never recorded consent** time out after the study setting `preConsentTimeoutMinutes` (default 30) instead of the normal inactivity timeout (default 120 minutes). A person who reads the information page for longer than that without any request starts again from the welcome page. The Dashboard does not count research sessions that were abandoned before consent, so sessions opened by a script do not inflate the participant numbers.

**A recording whose storage delete failed.** When the row of a rejected or replaced recording is removed but the storage delete fails, the storage key is written to the job queue (job type `delete_storage_object`) and the worker removes the object later, with up to 8 attempts. The job never deletes an object that a media row points at.

### Logs

The session services log: a failed job enqueue after a submission (job type and idempotency key, which contains an utterance or media id), a failed clean-up of a discarded recording (the storage key, built from ids), and an automatic transcription that was not queued (session id, utterance id and a fixed reason such as `external_ai_processing_not_accepted`). No consent choice text, questionnaire answer, participant code or token is logged.

## 3. Personal data in the system and where they are

The system is built for pseudonymous collection. It asks for no name, no email address, no identity code and no home address, and no endpoint accepts them (spec 153). The data below are still personal data: a voice can identify a person, and the combination of region, age range and speech content can do so too.

| Data | Why it is personal data | Database | Media store |
|---|---|---|---|
| Voice recordings (accepted source audio) | A voice identifies a person; the content can name the speaker or other people | `media_assets` (metadata, SHA-256), `utterances` | The audio file, under `studies/<study>/sessions/<session id>/utterances/<utterance id>/source/` |
| Derived WAV copies of compressed recordings | Same voice | `media_assets` (`source_audio_derived`, linked to the original) | The derived file |
| Transcripts A, A*, B, C | The words the participant said | `transcripts`, `transcript_revisions` | no |
| Translations | Derived from the participant's words | `translations` | no |
| Synthesized English audio | Derived from the participant's words, in a synthetic voice, not the participant's voice (no voice cloning) | `syntheses`, `media_assets` | The audio file, under `generated/syntheses/` |
| Model run records | Provenance of each model call (model, parameters, timing, request id, response metadata), linked to the utterance it processed | `model_runs` | no |
| Questionnaire answers | Age range, regions, languages, self-description of speech, free text | `questionnaire_responses`, `questionnaire_answers` | no |
| Consent record | Which consent version and items were shown, each choice, the time | `session_consents` | no |
| Technical capture metadata | User agent, platform, browser language, microphone label, track settings (can include device ids), sample rates | `sessions.browser_info_json`, `sessions.audio_environment_json`, `media_assets.metadata_json` | no |
| Pseudonymous participant code | Links everything of one session; given to the participant at the end | `sessions.participant_code` | Not part of any storage key |
| Session timestamps | When a person took part | `sessions`, `task_presentations`, `utterances` | no |
| Researcher notes, flags, exclusion reasons | Written about a participant's data | `research_notes`, `research_flags`, columns on sessions and utterances | no |
| Audit log | Researcher actions; entries refer to session and utterance ids | `admin_audit_log` | no |
| Export archives | Copies of all of the above, as selected | `export_jobs`, `media_assets` (`export_archive`) | The ZIP file, under `studies/<study>/exports/` |
| Demo Mode recordings and outputs | Voice of the person who tried the demo | Same tables, `mode = 'demo'` | Same layout; kept or deleted at the end of the demo according to a study setting (`docs/DEMO-MODE.md`) |

Not stored as research data:

- **No name, email address, identity code or address.** Nothing asks for them. A participant can still say a name aloud; see section 8.
- **No IP address** in any research table (spec 6.2). The only use of the client address is the rate limit, as a keyed hash kept for at most one day, and only when `TRUST_PROXY=true` (section 1.2).
- **No microphone check audio.** The test recording never leaves the browser (spec 160.4).
- **No rejected recording attempts.** Only the accepted recording and the number of attempts.
- **No link between a participant code and a person.** The software holds no such list. If the researchers keep one (for example for withdrawal requests or incentives), it is outside this system and under their responsibility (spec 153).

Storage keys contain the study slug and random ids, never a participant code, a name or a region (spec 36).

## 4. What is sent to the external AI provider

The provider is called only from the server (the worker, and the web server for Demo Mode and the admin pipeline test). The browser never talks to the provider and never holds its key (spec 26). Each stage sends the minimum input (spec 65). The adapter input types have no field for anything else, and `packages/research/src/processing/steps.test.ts` inspects the exact object each adapter receives.

| Stage | Sent | Not sent |
|---|---|---|
| ASR | The audio bytes of one utterance, under the fixed file name `utterance.<extension>`; the language hint; the researchers' context prompt; the model name and parameters of the model configuration | Participant code, session id, utterance id, storage key, questionnaire answers, region, age, consent choices, browser metadata |
| Translation | The transcript text of one utterance (A, A*, B or C); the translation instruction of the prompt version; the model name and parameters | The audio; everything listed above; other utterances of the same participant |
| TTS | The translated English text; the voice; the speaking instruction; the model name and parameters | The participant's audio (there is no voice cloning); everything listed above |
| "Test connection" on the Settings page | A request for the provider's model list | No participant data at all |

Points for the review:

- **Voice and speech content do leave the system** at the ASR stage, and the words at the translation and TTS stages. The pseudonymization concerns the metadata around them, not the content. A participant who says their own name, or another person's, sends that to the provider.
- **Requests carry no user identifier and no request metadata.** These provider parameters are not on the allow-list of the adapters and are refused if a configuration names them (`packages/ai/README.md`).
- **Provider-side retention.** The translation adapter sends `store: false` with every request, which asks the provider not to keep the response for later retrieval. This is the one default the adapter adds on its own, for privacy (spec 65). A model configuration can set `store` explicitly, and only an explicit `store: true` turns retention on. The value that was sent is part of the stored parameters of every model run, so the provenance shows it. The ASR and TTS endpoints have no such parameter. Whether the provider keeps requests for abuse monitoring, for how long, and whether they are used for training depends on the account's data controls and the agreement with the provider. This is an open item (section 12).
- **Refusal text.** When the model refuses a translation, the stored error message is a fixed sentence. The text of the refusal, which is model output about the participant's speech, is kept only in the details of the failed run, not in the message that lists and logs show.
- **When processing happens, and the consent it needs.** With the study setting "automatic ASR after upload" on, the recording of a research or test session is sent to ASR soon after submission **only when the stored consent of that session has an accepted item with the scope `external_ai_processing`** (the scope label of the consent item, constant `CONSENT_SCOPE_EXTERNAL_AI_PROCESSING` in `packages/domain`). When the participant did not accept that item, or the consent version has no item with that scope at all, nothing is sent automatically: the recording is stored and the reason is logged. A researcher can still run ASR for such recordings in a processing batch after confirming the consent basis. Translation and TTS run only when a researcher starts a processing batch. With the setting off, nothing is sent until a researcher starts a batch. The software does not check the consent scope when a researcher starts a batch: that check is the researcher's (open item 14).
- **Processing without the provider.** Without an API key, collection works and nothing is sent. The mock provider makes no network call and is off in production.
- **Consent wording.** The seed consent contains an item on processing with external AI services. Its final wording, and whether the provider must be named, is for the researchers and the data protection officer.

## 5. Cookies (summary)

Three cookies, all strictly necessary, all `HttpOnly`, all `Secure` in production. Details in section 1.1 and `docs/DEMO-MODE.md`.

| Cookie | Purpose | SameSite | Lifetime |
|---|---|---|---|
| `dts_participant` | Keeps a study session across page loads. Random token; the database stores only its hash. | Lax | `PARTICIPANT_SESSION_TTL_HOURS` (24 h), cleared at completion or withdrawal |
| `dts_admin` (`__Host-dts_admin` over https in production) | Keeps a researcher signed in. Sealed value without personal data. | Strict | `ADMIN_SESSION_TTL_HOURS` (8 h), ended on the server at sign out and by a password change |
| `dts_demo` | Keeps a Demo Mode session. Separate from the participant cookie. | Lax | Until the expiry of the demo session token, cleared when the demo ends |

No analytics, no advertising, no third-party cookie, no tracking script. The pages load nothing from another host (Content Security Policy `default-src 'self'`).

The flags were checked on the production build on 2026-10-03 (`docs/DEPLOYMENT.md`, section 9).

## 6. Logs (summary)

Rules in section 1.4. What a log line of the web app and the worker contains: time, level, request id, HTTP method, route pattern (ids replaced by placeholders, no query string), status, duration, job id, job type, model run id, error code and a safe message.

Never logged: request and response bodies, transcripts, translations, audio, questionnaire answers, consent choices, participant codes, cookies, passwords, API keys, the client address.

Logs do contain random ids of jobs and, in a few failure messages, storage keys built from session and utterance ids. These are pseudonymous identifiers, so logs should be kept with the same care as the database and for a limited time. Log retention is set in the hosting platform, not in this code (open item).

Checked on the production containers on 2026-10-03: the logs of the web app, the worker and the migration contained no occurrence of the admin password, the session secret, the database password or a cookie value (`docs/DEPLOYMENT.md`, section 9).

## 7. Retention: what the code does and what it does not decide

The software deletes nothing on a schedule (spec 111). There is no automatic deletion of research data after a period, and no retention timer.

What the code does remove on its own:

| What | When |
|---|---|
| A recording that was uploaded but replaced, discarded or never submitted | At once, or when the session is withdrawn or marked abandoned |
| Rate limit rows | After one day |
| Demo Mode data | At the end of a demo session, when the study setting says demo recordings are not kept |

The hooks that exist for a retention policy (spec 111):

| Hook | What it does |
|---|---|
| Soft exclusion of a session, an utterance or an output | Keeps the data, leaves it out of batches and default exports, records the reason and the actor |
| Withdrawal marking | The participant's "End participation" sets the session to `withdrawn` with a time; the session is left out of default exports |
| Audited media deletion ("Delete recording") | Removes one audio file and its derived copies from the media store; the metadata row stays with the hash, the reason and the actor |
| Export restriction | Privacy tiers and filters; the third-party identifier flag removes items from the `collaboration_restricted` tier |
| TEST and DEMO data reset | Deletes trial data, never research data |
| Retention review | No dedicated screen. The Sessions list can be filtered by date, status and mode, which is the basis for a manual review |

**Deliberately not decided in code**, because they are legal and study policy decisions (spec 86, 111):

- the lawful basis of each processing purpose;
- the retention period of recordings, transcripts, questionnaire answers and the audit log;
- what a participant is promised about withdrawal, and whether withdrawal means exclusion from analysis or erasure;
- whether and under which conditions the data may be reused in later research or shared;
- how long the provider may keep what it receives.

The participant texts in the seed make no promise about any of these. The withdrawal page shows the debrief and contact text of the protocol and nothing else.

## 8. Exclusion, withdrawal and deletion

Three different things (table in `docs/ADMIN.md`, "Flag, exclusion and deletion"):

- **Exclusion** keeps everything and marks it as left out of analysis. It can be undone. It is the normal answer to a quality problem, and it is **not** an answer to an erasure request, because the data remain.
- **Withdrawal** is the participant ending the session. Submitted recordings remain stored and marked. What happens to them next is the study's policy.
- **Deletion of a recording** removes the audio file for good. The metadata row remains, with the SHA-256 and size of the removed file, the reason and the time, and the utterance stays excluded.

What an erasure request would need today, and what is missing:

- "Delete recording" removes the audio of one utterance, with its derived WAV copy. It has to be done per utterance.
- Transcripts, translations, synthesized audio, questionnaire answers and the consent record of that session **stay**. The database triggers that protect research records also refuse to delete them, on purpose (`docs/DATA-MODEL.md`, "Deletion rules").
- There is no function that erases a whole research session. If the approved policy requires full erasure, a reviewed and audited procedure has to be added. This is an open item (section 12, item 5), not something to do with ad hoc SQL. The specification forbids inventing deletion semantics before the policy is defined, so nothing was built.
- Copies outside the live system are not reached by any function: database and media backups, exported dataset packages that were downloaded, and whatever the AI provider retained.
- Because participation is pseudonymous, the researchers need a way to find a participant's session. The participant code shown at the end of the session is the only handle the software offers.

**Third-party identifiers.** Free speech can contain the name of another person. The participant page reminds people not to use full names (a protocol option, with a publish warning when it is off for a free speech task). A reviewer can set the flag reason `contains_third_party_identifier` on an utterance or session. The flag does not change or remove anything by itself; its effects are that the item can be found, can be excluded, and is left out of the `collaboration_restricted` export tier. The software does not redact or cut source audio automatically (spec 66). A redacted transcript can be written as a new revision; the earlier revision remains in the history.

## 9. Export privacy tiers

Exports are the way data leave the system, so they are a disclosure step. Tiers (spec 89, details in `docs/EXPORT-SCHEMA.md`, "Privacy tiers"):

| Tier | Content |
|---|---|
| `internal_full` | Everything selected, including audio and the audit log. For the research team only. |
| `analysis_pseudonymous` | No audio. Without user agent strings, microphone labels, device settings, storage keys, researcher notes, flag notes and the audit log. Keeps participant codes and all research variables. |
| `collaboration_restricted` | As above, and without any item flagged as containing a third-party identifier, and without free text questionnaire answers unless asked for. |
| `public_release` | Not implemented. The service refuses it until a release policy (manual review, redaction, consent filtering) exists. |

Notes for the review:

- "Pseudonymous" is not "anonymous". Transcripts and questionnaire answers remain, and they can identify a person through their content.
- Defaults leave out TEST and DEMO data, excluded records and withdrawn sessions.
- No tier filters by the optional consent item on future reuse automatically. If reuse depends on that item, the export must be filtered accordingly by the researcher (the consent choices are in `consents.csv`). Open item.
- Every export is written to the audit log with its filters and tier, and every package has a manifest with the hash of each file.
- An export archive is stored in the media store until it is removed. Downloaded copies are outside the system's control.

## 10. Access control

- **One researcher password** protects the admin and every admin API route (spec 39). There are no personal accounts, so the audit log records the actor as "admin", not a named person. Who knows the password, and how it is changed when someone leaves, is an organizational measure.
- The admin session is checked in two places for every request: in `proxy.ts` and next to the data (`apiRoute({ auth: "admin" })`, `requireAdminPage()`).
- Failed logins are throttled and written to the audit log without the password. A correct password is never refused, so the login cannot be blocked from outside (section 1.2, "Admin login throttle"). The protection against guessing is a random password of at least 12 characters and a request limit at the reverse proxy.
- Signing out ends every admin session on the server, and so does changing the admin password (section 1.1).
- An export archive is never served by the media routes. It is downloaded only through the export download route, which writes the audit row before it opens the file.
- State-changing requests must come from the application's own origin.
- **Audio** is reachable only through admin routes by id. There is no public URL and no storage key in any response to a participant. Downloading a media file and deleting one are written to the audit log; playing audio in the admin player is not, because every seek would add a row (spec 132).
- **Participants** can reach only their own session through their cookie, and receive no transcripts, translations or audio from the server.
- **Database and media store** are reached with the credentials in the server environment. Anyone with those credentials, or with access to the hosting project, can read everything: access to the hosting platform must be limited to the research team and the operators. Encryption at rest is a property of the hosting service, not of this code (open item).
- **Transport**: HTTPS is required in production and enforced by `Secure` cookies and HSTS (`docs/DEPLOYMENT.md`, section 7).

## 11. Security measures in short

Private media storage; server-side secrets only; input validation with strict schemas; uploads limited in size and validated from their bytes; database access through parameterized queries; rate limits on login and session creation; secure cookies; a Content Security Policy with per-request nonces and `connect-src 'self'`; no secrets in logs; `.env`, `data/` and `exports/` excluded from Git and from the container images (spec 67, 160). Evidence from the production build: `docs/DEPLOYMENT.md`, section 9.

## 12. Open items for the researchers and the data protection officer

Decisions the software cannot make:

1. **Lawful basis** for each purpose: collection, processing by an external AI provider, storage for the research period, later reuse, any publication. Consent recorded in the system may or may not be that basis.
2. **Controller, contact details and privacy notice.** The seed contains placeholders. The final information sheet, consent items, privacy notice URL and contact text must be entered in Study Flow before collection.
3. **Agreement with the AI provider**: data processing terms, the region where data are processed, how long the provider keeps requests, whether the provider's storage of responses must be switched off in the model configurations, and exclusion from model training. Whether a transfer outside the EU or EEA takes place and on which basis.
4. **Retention period** for recordings, transcripts, questionnaire answers, the audit log, logs and backups, and who performs the retention review.
5. **Withdrawal and erasure policy**: what participants are told, how a request is received and matched to a participant code, and whether a full-session erasure procedure must be built (section 8).
6. **Future reuse and sharing**: which consent item governs it, and how exports are filtered by it (section 9).
7. **Third-party personal data** in free speech: the rule for flagged utterances (exclude, redact the transcript, restrict export, delete the recording).
8. **Hosting**: approval of the hosting service and the media store for voice recordings, encryption at rest, backup location and retention, access to the hosting project.
9. **Access to the admin**: who holds the password, and whether one shared password is acceptable for the audit requirements of the study.
10. **Demo Mode**: whether demo recordings are kept, whether the demo is open without sign-in, and what the demo notice says. Demo speakers are also data subjects.
11. **Participant code list**: whether the researchers keep any list that links codes to people, and where.
12. **A data protection impact assessment**: whether one is needed for systematic processing of voice recordings with an external provider is a question for the data protection officer.
13. **Rate limiting behind a proxy**: with `TRUST_PROXY=true` a keyed hash of the client address is stored for up to a day. This is the only processing of the address and should be mentioned in the privacy notice if enabled.
14. **Consent basis of batch processing.** Automatic transcription after an upload requires an accepted consent item with the scope `external_ai_processing`. A processing batch started by a researcher does not check that scope. Decide whether batches must also be restricted to sessions that accepted the item, and whether the item is required or optional in the final consent form.
15. **Whole-session erasure.** Only the deletion of single recordings exists. A procedure that erases a whole research session (recordings, transcripts, translations, synthesized audio, questionnaire answers, consent record) does not exist, and the database guards refuse such deletes on purpose. It has to be specified by the policy first (what is erased, what proof remains, who may do it, how backups and downloaded exports are handled) and then built as a reviewed and audited function.
16. **CSV files opened in a spreadsheet (formula injection).** The export writes every value byte for byte as it is stored. A transcript or a free text answer that starts with `=`, `+`, `-` or `@` is therefore read as a formula by a spreadsheet program. Changing the bytes would break the rule that an export reproduces the stored data exactly, so the export is left as it is and the risk is handled by how the files are opened (import as text, or read them with analysis software). A possible later feature, suggested by the security review, is an optional second export format that is safe to open in a spreadsheet (values that start with those characters prefixed with an apostrophe), clearly marked as not byte-exact. Decide whether it is wanted.
17. **Database credentials.** The development setup uses the default `postgres` superuser and password of the local container. A deployment must use the two least-privilege roles and its own passwords (`docs/DEPLOYMENT.md`, "Database roles"). This is handled in the database work package and listed here so the check is not forgotten before collection starts.
18. **Device data stored before the change.** Sessions and recordings stored before device identifiers and raw device labels were removed can still contain them. Decide whether those fields must be cleaned in existing rows.
19. **Admin password quality.** The login cannot be locked from outside, and in exchange the application does not cap password guesses. The password must be generated randomly and a request limit should be set at the reverse proxy (section 1.2).
