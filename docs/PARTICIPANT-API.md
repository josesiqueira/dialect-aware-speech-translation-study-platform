# Participant API

The server side of the participant study flow: the `/api/study/*` endpoints, the state they return, and the rules behind them. The participant pages and the browser recorder are built against this document.

- Services: `packages/research/src/sessions/` (`sessions.*` from `@dialect/research`).
- Request schemas and response types: `packages/domain/src/validators/sessions.ts` (`sessionSchemas.*` from `@dialect/domain`). The file has no server-only imports, so browser code can import it.
- Route handlers: `apps/web/app/api/study/`.
- Section numbers such as "spec 62" refer to `docs/IMPLEMENTATION-SPEC.md`.

## 1. Principles

1. **The server decides the step** (spec 107). Every response that changes something returns the new `ParticipantState`. The browser renders `state.step` and nothing else. A request for a later step is refused with `409 INVALID_STATE`, so consent cannot be skipped by editing requests.
2. **The session is the cookie** (spec 60, 61). The HttpOnly cookie `dts_participant` holds an opaque token. No endpoint accepts a session id in the query string or the body (unknown body fields are refused with `400`). Every presentation id and utterance id in a request is checked against the cookie's session. An id of another session answers `404`, exactly like an id that does not exist.
3. **No AI output** (spec 3.1, 83, 110.9). `ParticipantState` has no field for transcripts, translations, synthesized audio, model names, conditions or dialect classification, and the code that builds it does not read those tables. A test walks whole sessions with such data in the database and checks every response.
4. **Collection does not depend on AI or on the job queue** (spec 29, 110.8). A submission succeeds even when a job cannot be queued.
5. **Nothing is advanced before it is stored** (spec 62). The browser moves on only after the submit response.

## 2. Conventions

- Success is `200` with a JSON body. Failure is `{ "error": { "code", "message", "details?" } }` with the HTTP status of the code. `message` is safe to show to the participant.
- All responses carry `Cache-Control: no-store` and an `x-request-id` header.
- State-changing requests (`POST`, `DELETE`) must come from the app's own pages: the handler checks `Sec-Fetch-Site` or `Origin` (`assertSameOrigin` in `apps/web/lib/server/api.ts`). A browser `fetch` from a page of the app passes without extra work. A command line client must send `Origin: <APP_URL>`.
- JSON bodies are sent with `Content-Type: application/json`. The schemas are strict: an unknown field is a `400 VALIDATION_ERROR`.
- **Body size.** A JSON body is read through a counted stream and may be at most 64 KB (`DEFAULT_JSON_BODY_LIMIT_BYTES` in `apps/web/lib/server/api.ts`). The questionnaire route allows 256 KB, because free text answers can be long. A larger body is refused with `413 PAYLOAD_TOO_LARGE`: by its `Content-Length` before anything is read, otherwise as soon as the count passes the limit. The requests of the participant flow are a few hundred bytes.
- **Session before body.** Every route that needs a session resolves the session from the cookie before it reads the body. A request without a valid session is answered `401` and its body is not read.
- Use `apiFetch` and `apiUpload` from `apps/web/lib/client/api.ts`. They throw `ApiClientError` with the `code` below.

### Error codes used by this API

| Code | Status | Meaning for the page |
|---|---|---|
| `VALIDATION_ERROR` | 400 | The request is malformed, a required consent item was refused (`details.reason = "required_consent_not_accepted"`, `details.itemIds`), or questionnaire answers are invalid (`details.issues = [{ path: itemKey, message, code }]`). |
| `SESSION_EXPIRED` | 401 | No cookie, unknown or expired token, or the session was abandoned. Return to the welcome page. |
| `STUDY_CLOSED` | 403 | New sessions are not accepted, or maintenance mode is on (`details.reason`, see `StudyClosedReason`). Show `message`. |
| `FORBIDDEN` | 403 | Cross-origin request, or mode `test` or `demo` without the right to use it. |
| `NOT_FOUND` | 404 | The presentation or utterance does not exist in this session, or the protocol has no such questionnaire. |
| `MEDIA_NOT_FOUND` | 404 | Submit named a recording that is not the uploaded candidate of this utterance. Upload again. |
| `INVALID_STATE` | 409 | The request does not fit the current step. Fetch `GET /api/study/session` and render that state. |
| `CONFLICT` | 409 | Another upload of the same session is still running (`details.reason = "upload_in_progress"`). Wait for it and try again. |
| `IMMUTABLE_RECORD` | 409 | The recording was already submitted and cannot be replaced or removed. |
| `PAYLOAD_TOO_LARGE` | 413 | The upload is larger than `settings.maxUploadMb`, or a JSON body is larger than its limit. |
| `INVALID_AUDIO` | 422 | The file is not acceptable audio. `details.reason` is one of `empty`, `zero_duration`, `too_short`, `too_long`, `no_audio_track`, `has_video_track`, `unsupported_container`, `unsupported_codec`, `unsupported_channel_count`, `unsupported_sample_rate`, `unsupported_bit_depth`, `unparsable`, or a WAV parse reason. Recording again is the only fix. |
| `RATE_LIMITED` | 429 | Too many new sessions from this client address. The `Retry-After` header and `details.retryAfterSeconds` say when to try again. |
| `UPLOAD_FAILED` | 500 | The server could not store the recording (`details.stage` is `storage` or `database`). Nothing was kept. Keep the recording in the browser and offer Retry. |
| `INTERNAL_ERROR` | 500 | Unexpected failure. Offer Retry. |

## 3. Steps and session status

`sessions.status` has fewer values than the flow has steps. The mapping below is implemented in `deriveStep` (`packages/research/src/sessions/state.ts`).

| `state.step` | `sessions.status` | What the page shows | Request that leaves the step |
|---|---|---|---|
| `consent` | `created` | The information text (`state.information.content`), then the consent form (`state.consent`). The information screen of spec 107 is the first screen of this step. Moving from the information screen to the form needs no request. After a reload the page starts at the information screen again, and consent is never shown as given. | `POST /api/study/consent` |
| `mic_check` | `consented` | Microphone permission and the local test recording. | `POST /api/study/mic-check` |
| `instructions` | `mic_check` | `state.instructions.content` | `POST /api/study/instructions` |
| `tasks` | `recording` | `state.task` and `state.progress` | the submit or skip of the last turn |
| `background` | `background_questionnaire` | `state.questionnaire` | `POST /api/study/questionnaires/background` |
| `post_recording` | `post_questionnaire`, and no response to the post-recording questionnaire is stored yet | `state.questionnaire` | `POST /api/study/questionnaires/post_recording` |
| `english_check` | only when a researcher turned on `englishCheckEnabled` (off by default): `post_questionnaire`, the post-recording questionnaire is answered, the review part applies (see "Output review") and no English check or review is stored yet | `state.englishCheck`: the LexTALE items in the published order | `POST /api/study/english-check` or `POST /api/study/output-review/skip` |
| `output_review` | as above, the English check is done or switched off (the default), and the review is not stored or still in progress | `state.review`: `preparing` while the recordings are processed, then one page per recording | `POST /api/study/output-review/start`, `.../items/:id/answer` (the last one), `POST /api/study/output-review/skip` |
| `post_review` | the review is completed and the protocol has a post-review questionnaire that is not answered | `state.questionnaire` | `POST /api/study/questionnaires/post_review` |
| `debrief` | `post_questionnaire`, and the post-recording questionnaire is answered or the protocol has none, and the review part is over or does not apply | `state.debrief`, the participant code | `POST /api/study/session/complete` |
| `completed` | `completed` | The final screen. With `settings.studyLaptopMode`: "Start next participant". | none |
| `withdrawn` | `withdrawn`, or `abandoned` when participation ended before consent | `state.debrief` | none |

Notes:

- The status name `mic_check` means "the microphone check is confirmed", so the step it maps to is `instructions`. In the same way `consented` maps to the step `mic_check`.
- A protocol without a background questionnaire goes from the tasks straight to `post_questionnaire`. A protocol without a post-recording questionnaire shows the debrief as soon as the status is `post_questionnaire`. A protocol without both goes from the last task to the debrief.
- `abandoned` (set by the inactivity timeout, spec 108) is not a step: the cookie of an abandoned session answers `SESSION_EXPIRED`.
- `completed`, `withdrawn` and `abandoned` sessions accept no writes.
- Maintenance mode (`studies.settings_json.maintenanceMode`) stops running sessions too: every write except withdrawal answers `403 STUDY_CLOSED` with the maintenance message until it is switched off. Reading the state still works. Setting `allowNewSessions` to false or pausing the study does not affect running sessions (spec 87).

## 4. Types

The authoritative definitions are in `packages/domain/src/validators/sessions.ts`.

```ts
type ParticipantStep =
  | "consent" | "mic_check" | "instructions" | "tasks"
  | "background" | "post_recording" | "debrief" | "completed" | "withdrawn";

type ParticipantStateBase = {
  participantCode: string;            // for example "P-7K4M9Q"
  mode: "research" | "demo" | "test";
  locale: string | null;
  studyName: string;
  progress: { taskNumber: number; totalTasks: number } | null;  // set only at the step "tasks"
  settings: { maxUtteranceSeconds: number; maxUploadMb: number; studyLaptopMode: boolean };
};

type ParticipantState = ParticipantStateBase & (
  | { step: "consent"; information: { content: string }; consent: ConsentContent }
  | { step: "mic_check" }
  | { step: "instructions"; instructions: { content: string } }
  | { step: "tasks"; task: CurrentTask }
  | { step: "background"; questionnaire: QuestionnaireContent }
  | { step: "post_recording"; questionnaire: QuestionnaireContent }
  | { step: "debrief"; debrief: DebriefContent }
  | { step: "completed" }
  | { step: "withdrawn"; debrief: DebriefContent }
);

type ConsentContent = {
  consentVersionId: string; versionNumber: number; title: string; informationText: string;
  items: Array<{ id: string; text: string; required: boolean }>;
  privacyNoticeUrl: string | null; contactText: string | null;
};

type CurrentTask = {
  presentationId: string;
  status: "pending" | "started";
  title: string; prompt: string; context: string | null; instructions: string | null;
  taskType: "controlled" | "semi_structured" | "free_speech";
  minDurationSeconds: number | null;
  suggestedDurationSeconds: number | null;
  maxDurationSeconds: number;          // the task's limit, never above the study limit
  privacyReminder: boolean;
  topicSuggestions: string[];
  turn: {
    turnIndex: number;                 // 0 is the main prompt, 1..n are follow-ups
    totalTurns: number;
    promptText: string;                // the text to show for this turn
    isFollowup: boolean;
    isOptional: boolean;               // true: the participant may skip this turn
    utteranceId: string | null;        // set once POST /api/study/utterances created the row
    candidate: { mediaAssetId: string; durationMs: number | null } | null;  // uploaded, not submitted
  };
};

type QuestionnaireContent = {
  key: "background" | "post_recording";
  questionnaireVersionId: string; versionNumber: number; name: string; description: string | null;
  items: Array<{ itemKey: string; type: QuestionnaireItemType; prompt: string;
                 helpText: string | null; required: boolean; config: QuestionnaireItemConfig }>;
};

type DebriefContent = { content: string; contactText: string | null };
```

The texts of a task come from the snapshots stored in `task_presentations`, not from the current protocol (spec 8, 77). `QuestionnaireContent.items` fits the `items` prop of `QuestionnaireForm`.

## 5. Endpoints

`StateResponse` is `{ state: ParticipantState }`.

| Method and path | Purpose |
|---|---|
| `GET /api/study/info` | Study name, whether new sessions are accepted, welcome text, locales. No session. |
| `POST /api/study/sessions` | Start a session and set the cookie, or return the running session of the cookie. |
| `GET /api/study/session` | The state of the cookie's session, or `{ state: null }`. |
| `POST /api/study/consent` | Store the consent choices. |
| `POST /api/study/mic-check` | Confirm the microphone check (technical settings only). |
| `POST /api/study/instructions` | Acknowledge the instructions. Creates the task sequence. |
| `GET /api/study/next-task` | The current task (also part of every state). |
| `POST /api/study/tasks/:presentationId/start` | The task is now shown. |
| `POST /api/study/utterances` | Create (or get) the utterance of the current turn. |
| `POST /api/study/utterances/:id/audio` | Upload a recording as the candidate of the utterance. |
| `DELETE /api/study/utterances/:id/audio` | Remove the uploaded candidate. |
| `POST /api/study/utterances/:id/submit` | Accept the candidate and advance. |
| `POST /api/study/utterances/:id/skip` | Skip an optional follow-up turn. |
| `POST /api/study/questionnaires/:key` | Submit the `background` or `post_recording` questionnaire. |
| `POST /api/study/session/complete` | Finish the study from the debrief. Clears the cookie. |
| `POST /api/study/session/withdraw` | End participation. Clears the cookie. |
| `POST /api/study/session/locale` | The participant switched the language. The study texts that follow are in it. |

### GET /api/study/info

No session, no cookie. Response `StudyInfoResponse`:

```json
{
  "studyName": "Research study",
  "acceptingNewSessions": true,
  "closedReason": null,
  "closedMessage": null,
  "welcomeContent": "Welcome to this research study. ...",
  "studyNameByLocale": { "fi": "Tutkimus", "en": "Research study" },
  "welcomeContentByLocale": { "fi": "Tervetuloa tähän tutkimukseen. ...", "en": "Welcome to this research study. ..." },
  "locales": ["fi", "en"],
  "defaultLocale": "fi",
  "studyLaptopMode": false
}
```

`studyName` is the participant-facing title (study setting `participantTitle`, otherwise the neutral "Research study"). It is never the internal study name, which can name the research focus (spec 6.4).

When `acceptingNewSessions` is false, `closedReason` is one of `study_paused`, `study_closed`, `new_sessions_disabled` (also when the setting `allowNewSessions` was never set: not set means closed), `maintenance`, `no_protocol`, `example_text_present` (the current protocol still contains example text of the development seed: no research session is created until it is replaced, while test and demo sessions stay possible), and `closedMessage` is "This study is not currently accepting new participants." (spec 87) or, in maintenance mode, the message set by the researchers.

### POST /api/study/sessions

Body `CreateSessionBody`, all fields optional: `{ "mode": "research", "locale": "fi", "browserInfo": { "userAgent": "...", "language": "fi" }, "restart": false }`. Send at least `{}`.

Response `{ "state": ParticipantState, "resumed": boolean }` and, for a new session, the `Set-Cookie` header.

- **Resume.** When the request carries the cookie of a session that has not ended, that session's state is returned with `resumed: true`. Nothing is created and the rate limit is not touched. The body's `mode` and `locale` are ignored.
- **Restart.** `restart: true` skips the resume, drops the old cookie and creates a new session. This is the study laptop "Start next participant" path. An unfinished old session is left alone and becomes `abandoned` after the inactivity timeout.
- **Pinned protocol.** The new session is pinned to the study's current published protocol (spec 76). A protocol published later does not change it.
- **Modes** (spec 78). The mode is stored in `sessions.mode` and never derived from a URL. `research` is the default. `test` needs a signed-in admin (the admin session cookie in the same browser). `demo` needs a signed-in admin, or the study setting `demoPublic: true`. Otherwise `403 FORBIDDEN`: the server never falls back to `research`, so a test run cannot end up as research data. A signed-in admin can start a `test` or `demo` session while the study is paused or takes no new participants, but not in maintenance mode and not without a published protocol.
- **Locale.** A locale that is not in `participantLocales` is replaced by the study's default locale.
- **Not stored:** the client address (spec 6.2).
- **Rate limit** (spec 67): 120 new sessions per 60 minutes per client address (`SESSION_CREATE_LIMIT` in `apps/web/app/api/study/_lib/participant.ts`). The number is generous on purpose: one shared study laptop runs many participants a day. Only real creations count. When `TRUST_PROXY` is false all clients share one bucket, so one client could use up the limit for everyone. On a public address the server warns about that configuration at startup and in `GET /api/health/ready` (`docs/DEPLOYMENT.md`).
- **A session that never records consent** is closed after `preConsentTimeoutMinutes` (study setting, default 30) and its browser data are removed (see `POST /api/study/session/withdraw`).
- Errors: `403 STUDY_CLOSED`, `403 FORBIDDEN`, `429 RATE_LIMITED`, `400 VALIDATION_ERROR`.

### GET /api/study/session

Response `{ "state": ParticipantState | null }`. `null` means: no cookie, an unknown or expired token, or an abandoned session. A cookie that leads nowhere is cleared. Asking twice without a change in between gives the same answer, so a reload restores the page (spec 61). Extra query parameters are ignored.

### POST /api/study/consent

Body: `{ "responses": [{ "itemId": "participation", "accepted": true }, ...] }`. Every item of `state.consent.items` must be answered exactly once.

- All required items accepted: one `session_consents` row is stored with the consent version id and, per item, the text shown and the choice. The response is the state with step `mic_check`.
- A required item not accepted: `400 VALIDATION_ERROR` with `details.reason = "required_consent_not_accepted"` and `details.itemIds`. Nothing is stored and the step stays `consent`. Offer the participant to accept or to end participation (`POST /api/study/session/withdraw`).
- Other `400` reasons: `consent_items_unanswered`, `unknown_consent_item`, `duplicate_consent_item`.
- Calling it again after consent was stored returns the current state and stores nothing (first choices are kept).

### POST /api/study/mic-check

Body `MicCheckBody`, all optional:

```json
{
  "audioEnvironment": {
    "deviceLabel": "built_in",
    "requestedConstraints": { "channelCount": 1, "echoCancellation": false, "noiseSuppression": false, "autoGainControl": false },
    "actualTrackSettings": { "channelCount": 1, "sampleRate": 48000 },
    "audioContextSampleRate": 48000,
    "captureMethod": "audio_worklet_pcm"
  },
  "browserInfo": { "userAgent": "...", "platform": "...", "language": "fi" }
}
```

`audioEnvironment` also accepts `constraintMismatches`, `fallbackReason` and `fallbackDetail` (the same shapes as in the upload metadata), which the microphone check reports when the browser did not confirm a requested capture setting or the lossless recorder could not be used. Only these technical settings are stored (spec 6.3). `deviceLabel` holds the **class** of the input device (`built_in`, `usb`, `bluetooth`, `headset` or `unknown`), which the recorder derives from the device label. The label itself, `deviceId` and `groupId` are never sent, and the server removes them if they arrive (`docs/AUDIO-CAPTURE.md`, "Device identifiers and the device label"). **The test recording never leaves the browser.** This endpoint is JSON only, refuses unknown fields, and no endpoint accepts microphone check audio. Response: `StateResponse` with step `instructions`.

### POST /api/study/instructions

No body. Creates the complete task sequence of the session in one transaction (section 7) and returns the state with step `tasks`. Calling it again returns the current state and creates nothing.

### GET /api/study/next-task

Response `{ "step": ParticipantStep, "progress": {...} | null, "task": CurrentTask | null }`. `task` is null when the session is not at the step `tasks`. The page does not need this endpoint: the same data are in every state.

### POST /api/study/tasks/:presentationId/start

No body. Call it when the task is shown to the participant. Sets `started_at` and status `started`. Only the current task (the first one of the stored sequence that is not completed) can start: any other id of the session answers `409`. Starting twice keeps the first start time. Response: `StateResponse`.

### POST /api/study/utterances

Body: `{ "presentationId": "<uuid>", "turnIndex": 0 }`. Creates the utterance row of the current turn with the exact prompt text of that turn (`prompt_snapshot`) and, for a follow-up, its `followup_id`. Calling it again for the same turn returns the same row. The task must be started, and `turnIndex` must be `state.task.turn.turnIndex`, otherwise `409 INVALID_STATE` (`details.currentTurnIndex`). Response: `{ "utteranceId": "<uuid>", "state": ParticipantState }`.

### POST /api/study/utterances/:id/audio

`multipart/form-data` with two parts:

| Part | Content |
|---|---|
| `audio` | The file. WAV with 16, 24 or 32 bit PCM or 32 bit float samples (the research recorder), or WebM with Opus, Ogg with Opus, or MP4 with AAC (the compressed fallback). 1 or 2 channels, sample rate 8000 to 96000 Hz. The part's content type is stored as declared metadata only. |
| `metadata` | Optional JSON text, `CaptureMetadata`: `{ "captureMethod": "audio_worklet_pcm" | "media_recorder", "requestedConstraints": {...}, "actualTrackSettings": {...}, "audioContextSampleRate": 48000, "userAgent": "...", "declaredDurationMs": 14230, "declaredSampleRateHz": 48000, "declaredChannels": 1 }`. Optional recorder facts, all bounded: `declaredBitDepth`, `deviceLabel` (the class of the input device, never the raw label), `constraintMismatches` (at most 20 entries of `{ constraint, kind, requested?, actual? }`), `fallbackReason` (`audio_worklet_unavailable` or `audio_worklet_failed`), `fallbackDetail`, `inputChannelCount`, `clippedSampleCount`, `peak`, `stoppedBy` (`user` or `max_duration`). Unknown fields are refused. |

```ts
const form = new FormData();
form.set("audio", wavBlob, "recording.wav");
form.set("metadata", JSON.stringify(captureMetadata));
const upload = await apiUpload<sessionSchemas.UploadAudioResponse>(`/api/study/utterances/${utteranceId}/audio`, form, { onProgress, signal });
```

What the server does (spec 62, 63):

1. Checks the session, that the utterance belongs to it, is the current turn and is not submitted.
2. Allows one upload at a time per session. A second upload of the same session that arrives while one is running is refused with `409 CONFLICT` (`details.reason = "upload_in_progress"`) before its body is read.
3. Refuses a body larger than `settings.maxUploadMb` (plus 64 KB for the multipart framing): first from `Content-Length`, then by counting the bytes while reading.
4. Validates the bytes with `validateUploadedAudio`: container, codec, an audio track, no video track, 1 or 2 channels, a sample rate of 8000 to 96000 Hz, for WAV a sample size of 16, 24 or 32 bits, non-zero duration, duration at most the task's `maxDurationSeconds` plus 2 seconds of tolerance (`DURATION_GRACE_SECONDS`, because a recorder that stops exactly at the limit can produce a slightly longer file). The task's minimum duration is guidance for the page and is not enforced by the server (spec 84: nothing is excluded automatically).
5. Computes the SHA-256, writes the object to storage under `studies/{slug}/sessions/{session}/utterances/{utterance}/source/{asset}.{ext}`, then inserts the `media_assets` row.

The row has `kind = source_audio` and `capture_quality_class = lossless_pcm` for WAV, and `kind = source_audio_raw` and `capture_quality_class = compressed_fallback` for a compressed file. Container, codec, sample rate, channels, bit depth and duration come from the server's analysis. What the browser declared is kept in `metadata_json.declared` (`mimeType`, `mimeTypeMatches`, `durationMs`, `sampleRateHz`, `channels`, and, when the recorder sent them, `bitDepth`, `deviceLabel`, `constraintMismatches`, `fallbackReason`, `fallbackDetail`, `inputChannelCount`, `clippedSampleCount`, `peak`, `stoppedBy`) next to `requestedConstraints`, `actualTrackSettings`, `audioContextSampleRate`, `browserUserAgent` (from the metadata, else the `User-Agent` header) and `probe`. `probe` holds technical fields only: for a compressed file an allow-list of the ffprobe output (format name, duration, size, bit rate, and per stream the codec, sample format, sample rate, channels, bit depth), never the tags of the file. `capture_method` is the value the browser reports (when missing: `audio_worklet_pcm` for WAV, `media_recorder` otherwise).

Response `UploadAudioResponse`:

```json
{ "mediaAssetId": "<uuid>", "sha256": "<64 hex>", "durationMs": 14230, "sizeBytes": 1366124, "captureQualityClass": "lossless_pcm" }
```

The upload is a **candidate**. It is not linked to the utterance as accepted and no job is queued for it. Errors: `413`, `422`, `409 IMMUTABLE_RECORD` (already submitted), `409 INVALID_STATE`, `409 CONFLICT` (another upload of this session is running), `404`, `500 UPLOAD_FAILED`, `400` (not multipart, no `audio` part, bad `metadata`).

### DELETE /api/study/utterances/:id/audio

Removes the uploaded candidate (row and stored object). Use it when the participant records again after an upload. Without a candidate it changes nothing. `409 IMMUTABLE_RECORD` once the utterance is submitted. Response: `StateResponse`.

### POST /api/study/utterances/:id/submit

Body: `{ "mediaAssetId": "<uuid from the upload>", "attemptCount": 2 }`. `attemptCount` is the number of recordings the participant made for this turn, including the accepted one (spec 10). The browser counts it. Missing or below 1 is stored as 1.

In one transaction: the utterance gets `accepted_media_asset_id`, `status = submitted`, `submitted_at`, `duration_ms` (from the server's analysis), `attempt_count` and, for WAV, `quality_json` (peak, clipping, silence, level: informational only). Then the turn advances: next turn, next task, or the step after the tasks. Jobs are queued inside the same transaction, each in its own savepoint, so a queue failure is logged and never fails the submission:

- `derive_wav` with `{ mediaAssetId }` and idempotency key `derive_wav:<mediaAssetId>` for a compressed fallback recording;
- `asr` with `{ utteranceId, mediaAssetId, modelConfigId, trigger: "auto_on_upload" }` and idempotency key `asr:auto:<utteranceId>` when all of the following hold:
  - the study setting `autoQueueAsr` is true and the session mode is `research` or `test` (Demo Mode runs its own pipeline);
  - **consent:** the stored consent of the session has an accepted item whose `scope` is `external_ai_processing` (`CONSENT_SCOPE_EXTERNAL_AI_PROCESSING` in `packages/domain`). The scope is read from the consent version the participant answered. When the item was not accepted, or the consent version has no item with that scope, the recording is stored and no job is queued. A researcher can still run ASR in a processing batch after confirming the consent basis;
  - **configuration:** an `asr_default` model configuration is active at this moment. Its id is written into the job as `modelConfigId`, so the job runs with the configuration that was active at upload time even when another one is activated while the job waits. Without an active configuration nothing is queued and a warning is logged.

  A job that was not queued is logged with the session id, the utterance id and a fixed reason (`external_ai_processing_not_accepted`, `no_external_ai_consent_item`, `no_consent_record`, `no_active_asr_config`).

Response: `StateResponse` with the next thing to render. **Release the recording in the browser only after this response.**

- Submitting again with the same `mediaAssetId` returns the current state and changes nothing (safe for a double click or a retry after a lost response).
- Submitting with another `mediaAssetId` after acceptance: `409 IMMUTABLE_RECORD`.
- `404 MEDIA_NOT_FOUND`: the id is not the current candidate of this utterance (for example it was replaced by a newer upload).

### POST /api/study/utterances/:id/skip

No body. Skips the current turn when `state.task.turn.isOptional` is true (a follow-up with `is_required = false`, or any follow-up of a task whose `config_json.followupMode` is `optional`). The main prompt can never be skipped (`409`). The utterance row of the skipped turn and an uploaded candidate are removed. The id is the utterance id of the turn, so call `POST /api/study/utterances` first. Response: `StateResponse`.

How a skip is recorded: the skipped turn has no utterance row. When another turn follows, its row is created at once, so the gap in the turn indexes of the presentation shows the skip. When the skipped turn was the last one, the presentation is completed.

### POST /api/study/questionnaires/:key

`:key` is `background` or `post_recording`. Body: `{ "answers": { "<itemKey>": <value>, ... } }`.

| Item type | Value |
|---|---|
| `likert` | whole number within `config.scaleMin`..`config.scaleMax` (default 1..5) |
| `integer` | whole number within `config.min`..`config.max` when set |
| `single_choice` | one option value (string) |
| `multi_choice` | array of option values |
| `short_text`, `free_text` | string, at most `config.maxLength` characters (default 500 and 5000) |
| `boolean` | `true` or `false` |

Leave an unanswered optional item out (`null`, `""` and `[]` also count as not answered). The rules are those of `questionnaireSchemas.validateQuestionnaireAnswers` in `@dialect/domain`, the same function `QuestionnaireForm` runs in the browser, applied to the items of the questionnaire version pinned by the session's protocol.

- `background` is accepted only at the step `background`, which exists only after all speech tasks (spec 11). `post_recording` only at the step `post_recording`. Otherwise `409 INVALID_STATE`.
- Invalid answers: `400 VALIDATION_ERROR` with `details.issues = [{ "path": "<itemKey>", "message": "...", "code": "required" | "invalid_type" | "not_integer" | "out_of_range" | "unknown_option" | "too_long" | "unknown_item" }]`. Nothing is stored.
- Valid: one `questionnaire_responses` row and one `questionnaire_answers` row per answered item, in one transaction.
- A repeated submission after the response was stored returns the current state and stores nothing.
- `404 NOT_FOUND` when the protocol has no questionnaire of that kind (the step is then never shown).

### POST /api/study/session/complete

No body. Only from the step `debrief` (`409` otherwise). Sets `completed` and `completed_at`. Response: `StateResponse` with step `completed`.

**The cookie is always cleared**, with and without study laptop mode. Decision (spec 137, 138): after completion no previous participant state may be visible, and a completed session has nothing left to resume, so there is no reason to keep the cookie in any deployment. The page keeps the returned state in memory to render the final screen. After a reload the browser is at the welcome page. The page must also drop its own client state: recordings, object URLs, media streams, and anything in `sessionStorage`.

### POST /api/study/session/locale

Body `{ "locale": "en" }`. The participant pressed a language button during the study. Stores the locale on the session and returns `StateResponse` with the study texts in that language (consent, instructions, follow-ups, questionnaires, debrief, and the task texts as described in `docs/PARTICIPANT-UI.md`, section 5). Texts already stored with the session (the consent record, task snapshots, utterance prompts) keep the language they were shown in. A locale that is not in `participantLocales`: `400 VALIDATION_ERROR` with `details.reason = "unknown_locale"`. A terminal session: as every other write.

Every study text of a state is in the locale of the session (`state.locale`), with the base text where a text has no translation.

### Output review

The part after the questionnaires (`docs/RESEARCH-DESIGN.md`, section 3). It applies when the study setting `outputReviewEnabled` is on (default), the session is a research or test session, and the participant accepted a consent item of scope `output_review` and one of scope `external_ai_processing`. Otherwise the session goes from the post-recording questionnaire to the debrief. Service: `packages/research/src/sessions/output-review.ts`.

**POST /api/study/english-check.** Only when a researcher turned on `englishCheckEnabled` (off by default since 2026-10-09). Body `{ "answers": [true, false, ...] }`, one yes or no per item of `state.englishCheck.items`, in that order. Whether an item is a word is never sent to the browser; the server scores the answers (LexTALE "% correct av", dummies not scored). Another number of answers: `400 VALIDATION_ERROR`. A repeated submit changes nothing. Response: `StateResponse`.

**POST /api/study/output-review/start.** Chooses the recordings and stores the plan, or leaves `state.review.status = "preparing"`. The page calls it on arrival and every few seconds while preparing. Rule: the submitted, non-excluded recordings are ordered by a seeded spread across tasks; a recording is ready when its current ASR revision has text and both a `default` and a `preservation` translation of exactly that revision exist, each with a stored synthesis. The plan is made when as many recordings are ready as `outputReviewMaxItems` (or all are), or when 120 seconds have passed since the step began; then the ready ones are used. With none the review is stored as `unavailable` and the next state is the debrief. It never starts a model call. Response: `StateResponse`.

`state.review` when ready: `{ status: "ready", itemNumber, totalItems, item }`, where `item` is `{ id, sourceText, versions: [{ slot: 1, text }, { slot: 2, text }], audio: { source } }`: one of the participant's own recordings, its speech recognition text and the two English versions. No field names a condition, a model or a prompt.

**POST /api/study/output-review/items/:id/answer.** Body `OutputReviewAnswerBody` (scale version `output-review-v2`): `{ source: { said: "yes" | "partly" | "no" }, versions: { "1": ratings, "2": ratings } }`, where ratings are `{ meaning, representation }`, each 1 to 5 or `"cant_judge"` ("I can't say"). Every part is required. Pages are answered in order: another item gives `409 INVALID_STATE`; a missing part `400 VALIDATION_ERROR`. An answered page is never changed; a repeated answer changes nothing. After the last page the review is `completed`.

**POST /api/study/output-review/skip.** "Skip this part", at the English check or during the review. Ends the part; the post-review questionnaire is left out; answers given so far stay; `skipped_at_step` records where. Response: `StateResponse` (the debrief).

**GET /api/study/output-review/items/:id/audio/:which** (`source`). Streams the participant's own recording of a review page with HTTP Range support. Only for the session of the cookie and only while the review runs; everything else is `404`.

### POST /api/study/session/withdraw

No body. "End participation" (spec 86). Available at every step.

- From consent onwards: the session becomes `withdrawn` with `withdrawn_at`.
- Before consent: nothing was collected. The session becomes `abandoned` with `abandoned_at`, and the technical data of its row are removed (`browser_info_json`, `audio_environment_json`, `locale`, the token hash), so the statement "nothing was stored" on the page is true. The row itself stays with its code, status and timestamps (a database guard forbids deleting a research session).
- An uploaded candidate that was not submitted is removed (row and object). The browser must stop a running recording and must not upload it.
- **Submitted data are kept.** The endpoint deletes nothing else and promises nothing: the returned `state.debrief.content` and `contactText` come from the protocol and the consent version, and what happens to the data follows the approved protocol through the researchers (spec 13, 86).
- Response: `StateResponse` with step `withdrawn`. The cookie is always cleared. Calling it on a completed session answers `409`.

## 6. Upload, retry and re-record

The sequence for one turn:

```text
POST /api/study/tasks/:presentationId/start      once per task, when it is shown
POST /api/study/utterances                       -> utteranceId          (status recording)
   ... the participant records, listens, records again: all in the browser ...
   participant presses "Submit and continue"
POST /api/study/utterances/:id/audio             -> mediaAssetId         (status uploading)
POST /api/study/utterances/:id/submit            -> next state           (status submitted)
   release the recording, render the next state
```

Rules:

1. **Upload only on Submit.** Re-recording before that happens in browser memory, nothing reaches the server. Count the attempts in the browser and send the count with the submit.
2. **The upload fails** (network error, `500 UPLOAD_FAILED`, timeout): keep the recording, show Retry, and send the same file to the same utterance again. A failed upload leaves no row and no object. If the first upload did arrive but its response was lost, the retry replaces it: there is never more than one candidate per utterance.
3. **The submit fails or its response is lost:** send the same submit again. It is idempotent.
4. **The upload is refused** with `422` or `413`: the file itself is not acceptable. Tell the participant and let them record again.
5. **Re-record after an upload** (the participant goes back after a failed submit): call `DELETE .../audio`, or simply upload the new recording, which replaces the candidate. The earlier file is deleted from storage (spec 10).
6. **After a page reload** during a task the state shows the same turn. If `turn.candidate` is not null, a recording was uploaded but never submitted, and the browser no longer has it. The participant cannot listen to it (no endpoint serves audio to participants), so the page should call `DELETE .../audio` and ask for a new recording. `turn.utteranceId` is kept, so no new utterance is needed.
7. **After the submit response** the recording is study data. It can never be replaced, removed or re-submitted by the participant (`409 IMMUTABLE_RECORD`, and a database trigger behind it).
8. Two tabs or a double click: requests of one session run one after the other (row lock on the session). The second one sees the result of the first.

Failure handling on the server: validation runs before anything is written. The storage write comes before the database row, so a failed storage write leaves no row. If the database step fails, or the session ended in the meantime, the stored object is deleted again. When a candidate is replaced or discarded, its row is deleted in the transaction and its object after the commit. If that last delete fails, a file without a database row remains (logged as a warning). No part of the system treats such a file as study data.

## 7. Task order

`POST /api/study/instructions` stores the whole sequence in `task_presentations`: one row per enabled task of the pinned protocol with `sequence_index`, snapshots of title, prompt, context and instructions, and `randomization_metadata_json`. From then on only the stored sequence is used. The order is never rebuilt from the protocol (spec 8).

- Blocks come in the order of `protocol_versions.order_config_json.blocks`. A block that is not listed there is placed after the listed ones, by the smallest `order_index` of its tasks, with the order mode of its first task.
- Block mode `fixed`: tasks in `order_index` order.
- Block mode `shuffle_within_block`: Fisher-Yates shuffle driven by the mulberry32 generator, whose state is the first 32 bits of `SHA-256("<order seed>:<block key>")`. The algorithm name stored in the metadata is `fisher_yates_mulberry32_sha256_v1`. A task with `config_json.randomizationEligible = false` keeps its own position inside the block, and the other tasks are shuffled around it.
- The order seed is `sessions.order_seed`, 32 hexadecimal characters derived from the session id when the session is created. The same seed always gives the same order (`buildTaskSequence` in `ordering.ts` is a pure function with tests).
- Metadata per presentation: `{ seed, algorithm, blockKey, orderMode, indexInBlock, protocolOrderIndex }`.

Turns of one presentation: turn 0 is the main prompt, turns 1..n are the enabled follow-ups of the task in `order_index` order (spec 7.2). Follow-ups are predefined: nothing is generated (spec 82). A presentation is completed when every turn is submitted or skipped. `progress.taskNumber` counts presentations, not turns.

## 8. Other services

Not reachable through the participant API:

- `sessions.markAbandonedSessions(ctx)`: marks sessions that are not finished and whose `last_activity_at` is older than `sessionInactivityTimeoutMinutes` (study setting, default 120) as `abandoned` with `abandoned_at`, removes their candidates and returns the number of sessions marked (spec 108). Submitted data stay. A session that never recorded consent (status `created`, not a demo session) is marked after `preConsentTimeoutMinutes` (study setting, default 30) and its browser data are removed as after a declined consent. To be called by the worker on a timer. `last_activity_at` is updated by every request that carries the cookie.
- `sessions.jobHandlers`: the handler of the job type `delete_storage_object`. When the storage delete of a discarded recording fails, the key is queued and the worker removes the object later (8 attempts with backoff). The handler never deletes an object that a media row points at. It must be registered in the worker next to the processing and export handlers.
- `sessions.getSessionByToken(ctx, token)`, `sessions.getParticipantState(ctx, session)`, `sessions.createSession(ctx, input)` for server components and for Demo Mode. `createSession` takes `callerIsAdmin` and returns the token once: the caller sets the cookie with `setParticipantCookie(token, tokenExpiresAt)`.

Settings read from `studies.settings_json`, with the fallback in brackets: `maxUploadMb` (`MAX_AUDIO_UPLOAD_MB`, then 100), `maxUtteranceSeconds` (`MAX_UTTERANCE_SECONDS`, then 300), `sessionInactivityTimeoutMinutes` (120), `preConsentTimeoutMinutes` (30), `allowNewSessions` (false: not set means closed), `maintenanceMode` (false), `maintenanceMessage`, `studyLaptopMode` (false), `autoQueueAsr` (false), `demoPublic` (false), `participantLocales`, `defaultLocale` (one of the offered locales, when none is configured the first offered one, and with no locale configured at all the interface falls back to English), `participantTitle` ("Research study"). The token lifetime is `PARTICIPANT_SESSION_TTL_HOURS` (24).

The API serves one study: the one created first. The services accept a `studySlug` for tests and for a later multi-study setup.

## 9. Large uploads in Next.js 16

Checked against Next.js 16.3.8 as installed (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md` and `dist/server/body-streams.js`):

- A route handler has no body size limit of its own. `serverActions.bodySizeLimit` applies to Server Actions only.
- When `proxy.ts` matches a request, Next.js copies the request body into memory so that both the proxy and the handler can read it, and **cuts the copy at 10 MB by default** (`experimental.proxyClientMaxBodySize`). The request does not fail: the handler just receives a truncated body. A recording of two minutes at 48 kHz, 16 bit, mono is already 11 MB.
- The copy is made only for requests the proxy matcher matches.

Therefore `/api/study/` is excluded from the matcher in `apps/web/proxy.ts` (the proxy did nothing for these paths: its only API task is the admin gate). The two other upload routes, `/api/demo/recordings` and `/api/admin/ai/test`, are excluded by their exact paths for the same reason (`docs/DEMO-MODE.md`, "Limits"). No `next.config.ts` change is needed. **How the upload is read (one copy in memory).** The platform way, `request.formData()`, was measured against its implementation: it reads the whole body into memory, copies every file part into a `Blob`, and the handler then needs a `Buffer`, which `file.arrayBuffer()` copies again. A recording was held two to three times. The handler therefore does not use it:

1. `readLimitedBody` (`apps/web/lib/server/api.ts`) checks `Content-Length` and reads the body through a byte counter into one buffer, allocated once from the announced length.
2. `parseMultipart` (`apps/web/lib/server/multipart.ts`) finds the parts inside that buffer. The file part is a view of the buffer, not a copy.
3. Validation, hashing and the storage write work on that view.

The parser is small and strict (one boundary, `Content-Disposition` with `name` and `filename`, at most 16 parts) and refuses anything else with `400`. No streaming multipart library was added: the validation and the hash need the complete file before anything is stored, so the bytes have to be in memory once in any case.

**One upload at a time per session.** The guard is in the web process (`apps/web/lib/server/upload-guard.ts`), not a PostgreSQL advisory lock. What it protects is the memory of the process that buffers the upload, so the process is the right scope. An advisory lock would have to be held for the whole upload and would pin one pooled database connection per slow upload. With several web replicas a session can run one upload per replica. The data stay consistent in every case, because the service locks the session row and replaces the earlier candidate in one transaction.

At the default limit of 100 MB this is acceptable for a study with one participant at a time per laptop. A five minute lossless recording is about 29 MB.

If a reverse proxy sits in front of the app, its body size limit must be at least `MAX_AUDIO_UPLOAD_MB` (for nginx: `client_max_body_size`).

Raw body streaming (the file as the whole request body, metadata in a header) was considered and not chosen: the multipart form keeps file and metadata in one request without size limits on headers, works with `apiUpload` and its progress events, and the storage and validation code needs the complete file anyway to verify it before anything is stored.

## 10. Worked example

A participant on the seeded protocol (two controlled tasks in a shuffled block, a semi-structured task with one required follow-up, a second semi-structured task, free speech). Bodies are shortened.

```text
GET  /api/study/info
  -> { acceptingNewSessions: true, welcomeContent: "...", locales: ["fi","en"], ... }

POST /api/study/sessions            { "locale": "fi", "browserInfo": { "userAgent": "..." } }
  -> Set-Cookie: dts_participant=<token>; HttpOnly; SameSite=Lax; Path=/; Expires=...
  -> { resumed: false, state: { step: "consent", participantCode: "P-7K4M9Q", mode: "research",
       information: { content: "..." },
       consent: { consentVersionId, versionNumber: 1, title, informationText, privacyNoticeUrl, contactText,
                  items: [{ id: "participation", text: "...", required: true }, ...] },
       progress: null, settings: { maxUtteranceSeconds: 300, maxUploadMb: 100, studyLaptopMode: false } } }

   (the participant reloads the page)
GET  /api/study/session             -> { state: { step: "consent", ... } }      the same state

POST /api/study/consent             { "responses": [{ "itemId": "participation", "accepted": true },
                                                    { "itemId": "voice_recording", "accepted": true },
                                                    { "itemId": "external_ai_processing", "accepted": true },
                                                    { "itemId": "future_research_reuse", "accepted": false }] }
  -> { state: { step: "mic_check", ... } }

   (microphone permission, 5 second test recording, playback: all local)
POST /api/study/mic-check           { "audioEnvironment": { "actualTrackSettings": { "sampleRate": 48000 }, ... } }
  -> { state: { step: "instructions", instructions: { content: "..." } } }

POST /api/study/instructions
  -> { state: { step: "tasks", progress: { taskNumber: 1, totalTasks: 5 },
       task: { presentationId: "p1", status: "pending", title: "Something unexpected", prompt: "...",
               taskType: "controlled", suggestedDurationSeconds: 30, maxDurationSeconds: 120,
               privacyReminder: false, topicSuggestions: [],
               turn: { turnIndex: 0, totalTurns: 1, promptText: "...", isFollowup: false, isOptional: false,
                       utteranceId: null, candidate: null } } } }

POST /api/study/tasks/p1/start      -> { state: { ... task: { status: "started", ... } } }
POST /api/study/utterances          { "presentationId": "p1", "turnIndex": 0 }
  -> { utteranceId: "u1", state: { ... turn: { utteranceId: "u1", ... } } }

   (records, listens, records again, presses Submit: attempt 2 is the accepted one)
POST /api/study/utterances/u1/audio     multipart: audio=<wav>, metadata={"captureMethod":"audio_worklet_pcm",...}
  -> 500 { error: { code: "UPLOAD_FAILED", message: "The recording could not be saved. Please try again." } }
   (the page keeps the recording and shows Retry)
POST /api/study/utterances/u1/audio     the same file again
  -> { mediaAssetId: "m1", sha256: "9f2c...", durationMs: 14230, sizeBytes: 1366124, captureQualityClass: "lossless_pcm" }
POST /api/study/utterances/u1/submit    { "mediaAssetId": "m1", "attemptCount": 2 }
  -> { state: { step: "tasks", progress: { taskNumber: 2, totalTasks: 5 }, task: { presentationId: "p2", ... } } }

   ... task 2 in the same way ...

   task 3, semi-structured with a follow-up:
POST /api/study/tasks/p3/start
POST /api/study/utterances          { "presentationId": "p3", "turnIndex": 0 }     -> utteranceId "u3"
POST /api/study/utterances/u3/audio, POST /api/study/utterances/u3/submit
  -> { state: { step: "tasks", progress: { taskNumber: 3, totalTasks: 5 },
       task: { presentationId: "p3", status: "started",
               turn: { turnIndex: 1, totalTurns: 2, promptText: "Tell us about a typical situation you remember from there.",
                       isFollowup: true, isOptional: false, utteranceId: null, candidate: null } } } }
POST /api/study/utterances          { "presentationId": "p3", "turnIndex": 1 }     -> utteranceId "u4"
POST /api/study/utterances/u4/audio, POST /api/study/utterances/u4/submit
  -> { state: { ... progress: { taskNumber: 4, totalTasks: 5 }, task: { presentationId: "p4", ... } } }

   ... tasks 4 and 5 ...   the submit of the last turn returns:
  -> { state: { step: "background", progress: null,
       questionnaire: { key: "background", questionnaireVersionId, versionNumber: 1, name, description,
                        items: [{ itemKey: "age_range", type: "single_choice", prompt, helpText, required: true,
                                  config: { options: [...] } }, ...] } } }

POST /api/study/questionnaires/background       { "answers": { "age_range": "25_34", "region_grew_up": "Kuopio", ... } }
  -> { state: { step: "post_recording", questionnaire: { key: "post_recording", ... } } }
POST /api/study/questionnaires/post_recording   { "answers": { "naturalness": 4, "changed_speech": 2, ... } }
  -> { state: { step: "debrief", participantCode: "P-7K4M9Q", debrief: { content: "...", contactText: "..." } } }

POST /api/study/session/complete
  -> Set-Cookie: dts_participant=; Max-Age=0
  -> { state: { step: "completed", participantCode: "P-7K4M9Q", settings: { studyLaptopMode: true, ... } } }

   (study laptop: the operator presses "Start next participant")
POST /api/study/sessions            { "restart": true }
  -> a new session with a new code and a new cookie
```

Ending early at any step:

```text
POST /api/study/session/withdraw
  -> Set-Cookie: dts_participant=; Max-Age=0
  -> { state: { step: "withdrawn", participantCode: "P-7K4M9Q", debrief: { content: "...", contactText: "..." } } }
```

## 11. Tests

- Services: `packages/research/src/sessions/*.test.ts` (`ordering.test.ts`, `sessions.flow.test.ts`, `sessions.upload.test.ts`, `sessions.enqueue-failure.test.ts`). Run with `pnpm --filter @dialect/research test`.
- Routes: `apps/web/app/api/study/study.routes.test.ts`. Run from `apps/web` with `pnpm exec vitest run --config vitest.server.config.ts`.
- The compressed upload tests create a WebM file with ffmpeg at test time and are skipped when ffmpeg is not installed.

## 12. Participant interface

The pages built on this API, the step components, the text formatting of study content, localization, the client-side cleanup and the study laptop workflow are described in `docs/PARTICIPANT-UI.md`.
