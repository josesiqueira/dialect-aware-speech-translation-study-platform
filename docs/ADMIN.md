# Admin guide: Dashboard, Sessions, Session Detail and Settings

This guide is for researchers who use the admin at `/admin`. It explains what each number means, how flags, exclusion and deletion differ, what the quality chips mean and how to read the provenance of an output. Section numbers such as "spec 42" refer to `docs/IMPLEMENTATION-SPEC.md`.

All times in the admin are shown in the admin time zone, which is set on the Settings page. The database stores UTC.

Three data modes exist, and every session belongs to exactly one:

| Mode | Meaning | Where it counts |
|---|---|---|
| Research | A real participant in the real study. | All numbers on the Dashboard, and research exports. |
| TEST | A trial run by the research team. Striped amber badge. | Counted apart. Never in a research export by default. |
| DEMO | A demonstration, for example at a seminar. Blue dashed badge. | Counted apart. Never in a research export by default. |

## Dashboard (`/admin`)

The Dashboard shows operational study health: is collection running, is review keeping up, is processing working. It deliberately shows no comparison of translation conditions, no effect sizes and no participant background data (spec 42, 119, 154). Looking at outcomes while collection is running invites stopping early or changing the protocol, so outcome analysis happens on exported data.

Use Refresh to reload. With "Auto-refresh" the page reloads every 10 seconds.

While the current protocol (or the consent version or a questionnaire it selects, or the participant-facing title) still contains example text from the development seed, the Dashboard shows the warning "The current protocol still contains example text; research sessions are disabled until it is replaced", and the Protocol row of the Status card carries the badge "Example text". The Settings page lists the texts concerned. TEST and DEMO sessions are not affected.

### The cards

Every card counts research sessions only. The line under the cards gives the DEMO and TEST counts.

| Card | Meaning |
|---|---|
| Participants started | Research sessions that were created. One session is one participant. |
| Sessions today | Research sessions that started today in the admin time zone. |
| Consented | Sessions in which the participant accepted the consent form. |
| Completed | Sessions that reached the final page. The line below gives abandoned sessions (no activity until the inactivity timeout) and withdrawn sessions (the participant chose "End participation"). |
| Completion rate | Completed divided by started. "In progress" is started minus completed, abandoned and withdrawn. |
| Utterances | Utterances with an accepted recording. Utterances that were later excluded from analysis are still counted here, because the recording was submitted. |
| Source audio | Sum of the durations of those recordings. |
| Awaiting review | Submitted utterances, in sessions that are not excluded, that lack a verified B transcript or a verified C transcript. |
| Processing errors | Failed jobs in the queue, plus failed model runs that have no later successful retry of the same work. This card covers all data modes, because it describes the health of the pipeline. A retry that succeeds takes the failed run out of this count. |
| Flagged | Flagged sessions and flagged utterances. An utterance counts when its flag is set or when it has an open flag from the Review page. |

### Status

| Row | Meaning |
|---|---|
| Study | Whether a new participant can start now. That needs the status Active, "Allow new sessions" on and maintenance mode off. |
| Protocol | The published protocol version that new sessions receive. Sessions that already started keep their own version. |
| ASR, Translation, TTS config | The active model configurations: key, version, provider, model and prompt version. These are used for new processing. A batch keeps the configuration it was created with. |
| Worker | Healthy when a worker sent a heartbeat within the last minute. Without a worker, uploads still work and processing waits. |
| Storage | Whether the media storage can be read and written. |
| Database | Whether the database answers. |

### Recent activity and sessions per day

Recent activity lists the latest completed sessions, processing errors, transcript verifications and processing batches. TEST and DEMO entries carry their badge.

The chart shows research sessions per day for the last 14 days. Demo and test sessions of a day are named in text beside the bar and are not part of it.

## Sessions (`/admin/sessions`)

Filters are on top, the list is on the left, the detail of the selected session is on the right. The address of the page contains the filters and the selected session, so it can be copied and sent to a colleague.

Each row shows: participant code, mode, status, start time, protocol version, tasks completed of total, number of utterances (submitted and not excluded), total audio duration, review status (how many utterances have a verified B and a verified C) and badges for Flagged, Excluded and Processing error.

Filters: search by participant code or session id, mode, completed or incomplete, review complete or incomplete, flagged, processing errors, excluded, protocol version, and a date range in the admin time zone. The list shows 50 sessions per page, newest first. Click a column name in the header to sort.

"Review complete" means that every submitted utterance of the session has a verified B and a verified C.

## Session Detail

The header shows the participant code, mode, status, protocol version and the main timestamps. Below it are the completeness checks and the actions.

### Actions

| Action | What it does |
|---|---|
| Flag this session for review | Marks the session for attention, with optional notes. It changes no data and excludes nothing. |
| Download session package | Asks the export service for a package of this session. The file is downloaded from Data & Export. |
| Exclude session from analysis | Leaves the session out of analysis exports by default. Asks for a reason. Nothing is deleted. |
| View audit history | Lists every recorded researcher action on this session and its utterances, recordings, transcripts and outputs. |

### Completeness checks (spec 109)

These assist a quick check. The underlying data is shown in the sections below. Hover a check to read its detail.

| Check | Complete when |
|---|---|
| Source audio | Every task of the protocol has a stored recording for its main prompt, and no utterance is without its recording. |
| Background questionnaire | It was submitted and every required item has an answer. "Not applicable" when the protocol has none. |
| Post questionnaire | The same, for the questionnaire after recording. |
| Required transcripts | Every submitted utterance has a verified B and a verified C. |
| Processing | At least one batch has produced outputs for the session, every translation and TTS output that the batch configuration calls for exists for the transcripts that exist, there is no failed run without a successful retry, and no job is waiting or failed. |

### The eight sections

1. **Consent summary.** The consent version, when it was accepted, and each item with the exact text the participant saw and whether it was accepted.
2. **Technical capture metadata.** App version, browser and the audio settings of the recording device.
3. **Task sequence.** The tasks in the order this participant saw them, each with the exact title, prompt, context and instructions that were shown (stored copies, not the current protocol text).
4. **Utterances.** One block per utterance, described below.
5. **Background questionnaire** and 6. **Post-recording questionnaire.** The answers as given.

   **Output review (end of session)**, after section 6: the English check score when a researcher turned the test on (LexTALE, words out of 40 and nonwords out of 20; off by default), the status of the review (completed, skipped and where, or unavailable when no recording was ready), every review page in order with what was shown, which translation condition was Version 1 and Version 2 (the participant never saw this), the answers ("Is this what you said?" yes, partly or no; meaning and representation for each version, "can't say" where the participant chose it) and the post-review questionnaire. Pages of the first review version (`output-review-v1`: practice, check and audio screens) carry a badge and show their stored answers as they are. See `docs/RESEARCH-DESIGN.md`, section 3.
7. **Flags and notes.** All flags (open and resolved) and internal notes on the session, its utterances and its outputs. Notes are never shown to participants.
8. **Processing history.** Every model run and queue job for this session, including failures with their error.

### Utterance block

Each block shows, in this order:

- the utterance number (U-01, U-02, ...), the task and its type;
- the exact prompt the participant answered, and the attempt count (how many times the participant recorded before submitting; only the accepted recording is kept);
- the source audio player and "Download WAV". The audio is fetched only when you press play;
- the capture line, for example `48 kHz, mono, PCM 16-bit | lossless_pcm | audio_worklet_pcm`, the SHA-256 hash of the file and the asset id;
- "Capture details", closed by default: what the browser recorder declared about this recording (input device name, input channel count, declared bit depth, peak before conversion, clipped sample count, what stopped the recording, and the reason when compressed capture was used). Requested capture settings that the browser did not confirm (for example echo cancellation that stayed on) are counted next to the title and listed first in the warning style, because a setting that differs from the request can change the recorded signal, which matters for acoustic analysis. These are declared facts from `media_assets.metadata_json`; the format in the capture line comes from the server's own analysis of the file. The device name is technical metadata and appears only here;
- the quality chips;
- the four transcripts, then the translations per processing batch.

The four transcripts:

| Row | What it is |
|---|---|
| A | The ASR output. It is model output and cannot be edited. The line below it names the model, configuration version, run and time. |
| A* | A human correction of recognition errors in A. |
| B | The human dialect transcript, written from the audio. |
| C | The normalized Finnish text, written from B. |

Each row shows the review status, the revision number and, when verified, who verified it and when. "Edit in Review" opens the utterance on the Review & Transcription page. Editing a transcript there creates a new revision. Earlier revisions are kept.

### Quality chips (spec 84)

The chips inform. Nothing is excluded automatically because of a chip.

| Chip | Meaning |
|---|---|
| Missing audio | No recording was accepted, or the recording was deleted. |
| Too short | The recording is shorter than the minimum duration of its task, or shorter than 1 second when the task has no minimum. |
| Possible clipping | More than 0.1 percent of the samples are at full scale. The level was probably too high. |
| Low signal | The overall level is below -40 dB relative to full scale. |
| Mostly silent | More than 80 percent of the recording is below -50 dB. |
| Compressed capture | The browser could not record lossless PCM, so a compressed format was stored. A derived WAV may exist for processing. |
| ASR failed | An ASR run failed and there is no ASR transcript. |
| No B transcript, No C transcript | The transcript has not been written. |
| B not verified, C not verified | The transcript exists and is not verified. |

### Translations and TTS

For each processing batch there is one table. The rows are the source transcripts A, A*, B and C. The columns are the translation conditions of the batch. The table places outputs side by side for inspection. It does not score or compare them.

Each cell shows the translated text, the model and prompt version, and the revision of the transcript it was made from. If the transcript was edited after the batch ran, the cell says "not the current revision": the translation still belongs to the revision it was made from.

Per cell you can play the TTS audio, download the audio, download the text and open "Provenance, status, flags and notes". There you can flag the translation or a TTS output with a reason and an optional note, and add internal notes to it (the number of open flags and notes is shown next to the heading).

### How to read the provenance

Every question of spec 158 can be answered from this view:

| Question | Where to look |
|---|---|
| Which participant and session? | Header: participant code and session id. |
| Which source utterance? | Utterance block header: U-number and utterance id. |
| Which exact source audio file and hash? | Source audio: asset id and SHA-256. |
| Which task and exact prompt? | Utterance block: task label and "Exact prompt shown". |
| Which transcript condition? | The row of the table: A, A*, B or C. |
| Which transcript revision? | Cell line "from rev N", and Provenance: "Source transcript". |
| Which translation condition? | The column of the table, and Provenance: "Condition". |
| Which translation prompt version? | Provenance, Translation: "Prompt version". |
| Which model and configuration? | Provenance, Translation: "Model", "Config version", "Parameters". |
| Which processing batch? | The heading of the table, and Provenance: "Batch". |
| Which exact translated text? | The text of the cell. "Download text" saves it. |
| Which TTS model, configuration and voice? | Provenance, TTS: "Voice", "Model", "Config version", "Prompt version". |
| When was it generated? | Provenance: "Generated" (with time zone), for the translation and for the TTS. |
| Which app version produced the run? | Provenance: "App version" (with the commit when known) and "Run id". |

The TTS part also shows the audio asset id, its SHA-256, its format and whether the spoken text is identical to the translation.

"Model" names the model that was requested. If the provider reported another model name, it is shown as "returned".

### Status of an output

A translation or a TTS output has a status: Generated, Reviewed or Excluded. The status is the only thing about an output that can change. The text, the audio and the provenance are fixed. Set the status under "Provenance, status, flags and notes", with an optional reason. Flagging a generated output there sets it to Reviewed and records the reason; it never excludes the output. An excluded output stays visible and is left out of analysis exports by default.

## Flag, exclusion and deletion (spec 70, 71)

These are three different things.

| | Flag | Exclusion | Deletion |
|---|---|---|---|
| Purpose | Ask for attention. | Keep the data, leave it out of analysis. | Remove a recording because the approved study policy requires it. |
| Applies to | Session, utterance, output. | Session, utterance, output. | One audio file. |
| Changes the data? | No. | No. Only a status and a reason. | Yes. The audio file is removed from storage. |
| Can be undone? | Yes, clear the flag. | Yes, include again. | No. |
| In exports | Included. | Left out by default. Can be included on request. | The file is gone. Its record remains. |
| Needs | Nothing. Notes are optional. | A reason. | A reason and the typed phrase `DELETE RECORDING`. |

Details:

- A flag never excludes anything. Flags with a reason code can also be added on the Review page. Clearing the flag of an utterance in Session Detail resolves all its open flags.
- Excluding an utterance sets its status to "excluded" with the reason. Excluding a session marks the whole session. In both cases every recording, transcript, answer and output stays in the database and in storage.
- "Delete recording" is the audited media deletion workflow. The audio file is removed. The record of the file stays (hash, size, format, the reason and who deleted it), the utterance is marked as excluded, and derived copies of the recording are deleted with it. An utterance whose recording was deleted cannot be included again.
- The platform does not decide when a recording must be deleted. Use this action only as the approved study policy and the privacy notice require, for example after a participant's request (spec 86, 111).
- Every one of these actions is written to the audit log with the time and the actor.

There is no function that deletes a research session, and no function that resets research data.

## Settings (`/admin/settings`)

Settings holds operational and technical configuration. The scientific content of the study (protocol, consent, questionnaires, prompts, model configurations) is edited on its own pages, where it is versioned.

Each editable card has its own Save button. Leaving the page with unsaved changes asks for confirmation. Every saved change is written to the audit log with the values before and after.

### Study name and participant title

| Field | Effect |
|---|---|
| Internal study name | `studies.name`. Shown in the admin and in exports only. It may describe the research focus. |
| Participant-facing title | Stored in the study settings as `participantTitle`. It is the heading of the welcome page and the browser tab title of the participant pages. It must be truthful and must not name the research focus or an expected result, because participants read it before they speak (spec 6.1, 6.4). When it is empty, participants see the neutral standard title "Research study", never the internal name. |

The title is checked with the same wording checks as the study texts (`docs/PROTOCOL-VERSIONING.md`, "Publish checklist"). A finding is shown under the field as a wording note. It does not block saving. The title is a study setting, not part of a protocol version: a change applies to all participants from then on and is recorded in the audit log with the value before and after, so decide it before data collection starts.

The browser tab of the admin pages always reads "Research Dashboard".

### Languages

| Field | Effect |
|---|---|
| Source language, target language | Short language tags such as `fi`, `en` or `en-GB`. Stored with every translation batch and given to the translation model. A translation batch cannot be created while one of them is not set. |
| Interface languages offered to participants | The languages of the buttons and labels a participant can choose. Only languages the interface has dictionaries for (`apps/web/lib/i18n`) can be selected. |
| Default interface language | Shown first. It must be one of the offered languages. |

### Study operational state

A new deployment created by the seed starts with "Allow new sessions" off, because the seeded study texts are examples. While the current protocol contains example text, this page shows the list of texts to replace at the top.

| Field | Effect |
|---|---|
| Study status | Active, Paused or Closed. Only an active study accepts new participants. |
| Allow new sessions | When off, the welcome page says "This study is not currently accepting new participants." Sessions in progress can finish. |
| Maintenance mode | Closes the participant pages for everyone, including sessions in progress. |
| Maintenance message | The text shown during maintenance. |

### Limits

Maximum upload size, maximum utterance duration, the session inactivity timeout after which a session without activity counts as abandoned, and the largest number of Demo Mode pipeline runs per day (`demoDailyRunLimit`, 200 when not set).

### Collection and display options

Study laptop mode (the completion page offers "Start next participant"), automatic ASR after each research upload, whether Demo Mode recordings are kept, whether Demo Mode is open without sign-in, the admin time zone, and the versions of the transcription convention and the annotation scheme that are stored with new revisions and annotations.

### Output review

Whether the output review runs at all, whether the English vocabulary test (LexTALE) comes first (off by default; the background questionnaire asks for a self-rating of English reading instead), and how many of the participant's own recordings are shown (default 5, chosen by the project owner on 2026-10-09 to keep the session short; `reports/Source speaker output evaluation.md` suggests 8 to 12 as an assumption to test in the pilot). The review runs only for participants who accepted the consent item of scope `output_review`; the protocol selects the post-review questionnaire in Study Flow. Changes are audited like every setting.

### Database, Media storage, AI provider, Application

These cards are read-only.

- **Database.** Connected or not, and the migration status. "Up to date" means that every migration of the running code version is applied. "Migrations pending" means the database is behind the code: run the migrations before collecting data.
- **Media storage.** The driver, the path or bucket (never credentials), whether it can be read and written, and whether ffmpeg is installed. Without ffmpeg, compressed recordings cannot be validated or converted to WAV.
- **AI provider.** Whether an API key is configured. The key itself is never shown. "Test connection" lists the provider's models, which checks the network path and the key and generates no model output. It runs only when the button is pressed. Recording works without a key.
- **Application.** App version, git commit, environment, the worker processes with their last heartbeat, and the job queue.

### Danger zone: Delete TEST and DEMO data

This deletes the sessions of the chosen modes with their recordings, transcripts, questionnaire answers and outputs, and the processing batches of those modes. Protocols, prompts, model configurations and the audit log stay.

- It cannot select research data. The database also refuses to delete a research row through this path.
- It asks for the typed phrase `DELETE TEST AND DEMO DATA`.
- In production it is disabled unless the operator sets `ALLOW_TEST_DATA_RESET=true`.
- The action is written to the audit log with the number of deleted rows.

## API paths

For reference, the pages use these routes. All require the admin session.

| Route | Purpose |
|---|---|
| `GET /api/admin/dashboard` | Dashboard data. |
| `GET /api/admin/sessions` | Session list with filters, search, sort and pagination. |
| `GET /api/admin/sessions/:id` | Session Detail. |
| `PATCH /api/admin/sessions/:id/flag` | Set or clear the session flag. |
| `POST /api/admin/sessions/:id/exclude`, `.../include` | Exclude or include the session. |
| `POST /api/admin/sessions/:id/notes` | Add a note to the session. |
| `GET /api/admin/sessions/:id/audit` | Audit history of the session. |
| `PATCH /api/admin/sessions/:id/utterances/:utteranceId/flag` | Set or clear the utterance flag. |
| `POST /api/admin/sessions/:id/utterances/:utteranceId/exclude`, `.../include`, `.../notes` | Exclude, include or annotate an utterance. |
| `PATCH /api/admin/sessions/outputs/:kind/:outputId/status` | Status of a translation (`kind` = `translations`) or TTS output (`syntheses`). |
| `POST /api/admin/sessions/outputs/:kind/:outputId/notes` | Add a note to an output. |
| `GET /api/admin/media/:id` | Stream audio for the player (supports HTTP Range). |
| `GET /api/admin/media/:id/download` | Download with a name such as `P-7K4M9Q_U-03_source.wav`. |
| `DELETE /api/admin/media/:id` | The media deletion workflow. |
| `GET`, `PUT /api/admin/settings` | Read and change settings. |
| `POST /api/admin/settings/provider-test` | Provider connectivity test. |
| `POST /api/admin/settings/reset-test-data` | Delete TEST and DEMO data. |
| `GET /api/admin/audit` | The audit log, with filters. |

Audio is reachable only through the media routes above, with the admin session. There is no public address for any recording.
