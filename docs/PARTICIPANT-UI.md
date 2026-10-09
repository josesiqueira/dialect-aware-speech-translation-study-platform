# Participant interface

The pages a participant sees: the welcome page `/` and the study page `/study`. The server side is described in `docs/PARTICIPANT-API.md`, the recorder in `docs/AUDIO-CAPTURE.md`. Section numbers such as "spec 61" refer to `docs/IMPLEMENTATION-SPEC.md`.

## 1. Where the code is

| Path (under `apps/web/`) | Content |
|---|---|
| `app/page.tsx` | Welcome page. Server component: loads the public study information, the stored language and whether this browser has a running session. |
| `app/study/page.tsx` | Study page. Server component: sends a browser without a session cookie back to `/`, then renders `StudyFlow`. |
| `app/study/_components/WelcomeEntry.tsx` | Client part of the welcome page: language buttons and "Begin". |
| `app/study/_components/StudyFlow.tsx` | Client part of the study page. All API calls of the flow are here. |
| `app/study/_lib/participantApi.ts` | One function per endpoint of the participant API, and the upload metadata. |
| `app/study/_lib/turnTracker.ts` | Per task turn: utterance id, uploaded candidate, running upload. |
| `app/study/_lib/clientState.ts` | The language cookie and the cleanup at the end of a session. |
| `components/participant/flow/` | The step components. Presentational: content and interface text come in as props, no API calls. |
| `lib/i18n/` | Interface text in English and Finnish. |
| `e2e/participant.spec.ts` | End-to-end tests with Chromium's test microphone. |

## 2. How the study page works

1. `StudyFlow` calls `GET /api/study/session` and renders the step named by `state.step` (spec 107). The server decides the step. The browser never chooses it.
2. Every action posts to the API and renders the state in the answer.
3. Nothing about the study is in the URL: no step, no session id, no mode (spec 61). `/?mode=test` on the welcome page only selects the mode asked for when the session is created. The server refuses it without an admin session, and the mode shown afterwards comes from the stored session.
4. A page reload at any point loads the state again and shows the same step. The consent step always restarts at the information text with every box unchecked, because consent is stored only by the server.
5. Failures: `SESSION_EXPIRED` shows a calm "The session has ended" card with a way back to the welcome page. `INVALID_STATE` loads the state again and renders it. Everything else is shown in place in plain language from the dictionary, with the same button as the retry. Server messages are not shown, with one exception: the maintenance message that the researchers wrote themselves.
6. Focus moves to the `h1` of the new screen whenever the screen changes, so a screen reader announces it.

### One task turn

```text
task shown        POST /tasks/:presentationId/start, POST /utterances        (turnTracker.ensure, once per turn)
Submit            POST /utterances/:id/audio with progress, POST /utterances/:id/submit with attemptCount
                  the participant advances only after the submit response (spec 62)
upload fails      the recorder keeps the recording and shows "Try uploading again": the same file is sent again
submit fails      the retry repeats only the submit, because the upload of this attempt already arrived
record again      after an upload: DELETE /utterances/:id/audio removes the uploaded candidate (spec 10)
page reload       an uploaded candidate that was never submitted is removed, and the participant is asked to record again
```

`TaskStep` has the React key `<presentationId>:<turnIndex>`, so the attempt count and the candidate recording never carry over to another turn.

The upload sends the recorder's facts as the `metadata` part: capture method, requested constraints, actual track settings, AudioContext sample rate, declared duration, sample rate, channels and bit depth, device label, constraint mismatches, the fallback reason, input channel count, clipped sample count, peak and what stopped the recording. The server stores them under `media_assets.metadata_json.declared`.

## 3. Step components

All are exported from `@/components/participant/flow`. `t` is a `Dictionary` from `@/lib/i18n`. The admin preview (`apps/web/app/admin/preview/[protocolId]`) renders these same components with the content of one protocol version and the same dictionaries, inside `FlowShell` with the `PreviewBanner` in the `banner` slot. It calls no API, creates no session, stores nothing (not even the language cookie) and never opens the microphone: it passes inert stand-ins through the `dependencies` prop of `MicCheckStep` and `TaskStep`, so those two steps stay in their starting state.

| Component | Props | Notes |
|---|---|---|
| `FlowShell` | `t`, `locale`, `locales`, `onLocaleChange`, `mode?`, `progress?`, `onEndParticipation?`, `width?`, `centered?`, `banner?`, `children` | Sets `lang`, shows the mode banner for `test` and `demo` only, the language buttons when there is more than one language, the "End participation" action when `onEndParticipation` is passed, and "Task N of M" with the bar when `progress` is passed. `banner` replaces the mode banner (for the preview banner). |
| `WelcomeStep` | `t`, `studyName`, `welcomeContent`, `closedMessage?`, `resumable?`, `notice?`, `error?`, `busy?`, `onBegin` | With `closedMessage` the message replaces the button (spec 87), unless `resumable`. |
| `InformationStep` | `t`, `content`, `onContinue` | First screen of the consent step. |
| `ConsentStep` | `t`, `consent` (`title`, `informationText`, `items`, `privacyNoticeUrl`, `contactText`), `onAgree(responses)`, `onDecline`, `onBack?`, `busy?`, `error?` | No box is checked in advance. The button is enabled only when every required item is checked. |
| `MicCheckStep` | `t`, `onContinue(result)`, `busy?`, `error?`, `dependencies?` | `result` holds technical settings only. The test audio stays inside `MicCheck`. |
| `InstructionsStep` | `t`, `content`, `onStart`, `busy?`, `error?` | |
| `TaskStep` | `t`, `task` (`TaskStepTask`), `onSubmitRecording(candidate, context)`, `onSkip?`, `skipBusy?`, `notice?`, `error?`, `onCandidateChange?`, `onRecorderStateChange?`, `onFallback?`, `dependencies?` | `TaskStepTask` has no task category on purpose. "Skip this question" appears only for an optional turn. A rejection of `onSubmitRecording` with `code` `INVALID_AUDIO` or `PAYLOAD_TOO_LARGE` shows "record again" text instead of "try again". |
| `QuestionnaireStep` | `t`, `questionnaire` (`name`, `description`, `items`), `onSubmit(values)`, `serverIssues?`, `error?` | Wraps `QuestionnaireForm`. `serverIssues` are listed with the question they belong to. |
| `DebriefStep` | `t`, `debrief`, `participantCode`, `onFinish`, `busy?`, `error?` | |
| `ParticipantCode`, `ContactBlock` | `t`, `code` / `contactText`, `className?` | Parts of the debrief, also used on the withdrawal screen. |
| `CompletedStep` | `t`, `studyLaptopMode`, `onStartNext?` | Centered `max-w-md` card. |
| `WithdrawnStep` | `t`, `declined?`, `debrief?`, `participantCode?`, `onBackToStart` | `declined`: the participant chose not to take part on the consent screen. No code and no debrief are shown then. |
| `MessageScreen` | `title`, `message`, `actionLabel?`, `onAction?`, `secondaryLabel?`, `onSecondary?` | Session ended, loading failed. |
| `EndParticipationDialog` | `t`, `open`, `busy?`, `error?`, `onConfirm`, `onCancel` | Built on `ConfirmDialog`. |
| `StudyText` | `text`, `headingLevel?`, `size?`, `lang?`, `className?` | The safe renderer of study texts, see below. |

Rules that the components keep (spec 3.1, 83, 167):

- No transcript, translation, model output, model name or classification is ever shown. The API state has no such field, and the test `app/study/research-mode.test.ts` fails if a participant module imports admin code or `@dialect/ai`, or names such a field.
- The task label is the neutral "Speaking task" (or "Follow-up question"). The task category is never shown.
- The interface text never tells the participant how to speak. That belongs to the protocol's instruction text.
- No points, badges or celebration. Progress is "Task N of M" and a thin neutral bar.

### Output review

`components/participant/review` holds the two screens of the part after the questionnaires (`docs/RESEARCH-DESIGN.md`, section 3). The study page renders them only at the steps `english_check` and `output_review`; `app/study/research-mode.test.ts` checks that no other participant module renders them.

- `EnglishCheckStep` (only when a researcher turned on `englishCheckEnabled`; off by default since 2026-10-09): the published LexTALE instructions in the interface language, then one English letter string at a time with "Yes" and "No", in the published order, without a time limit. The answers go to the server together after the last item. "Skip this part" on the first screen.
- `OutputReviewStep`: while the recordings are processed, a calm "Preparing your recordings" screen (the study page calls `POST /api/study/output-review/start` every 4 seconds). Then one page per recording ("Recording 2 of 6"): the player of the participant's recording, the speech recognition text and "Is this what you said?" with Yes, Partly and No; then Version 1 and Version 2 side by side (stacked on a phone), each with two questions as radio groups with every point of the 5-point scale labelled plus "I can't say": how well the English says what they meant, and how much of the way they said it comes through. "Next" is refused until every question is answered. "Skip this part" ends the part.
- Wording is neutral: only "Version 1" and "Version 2", never a condition, a model or a prompt, and no word about dialect or standard language (the dictionary test of `lib/i18n` checks this).

## 4. Formatting of study texts

Welcome, information, consent, instruction, debrief and contact texts are written by the researchers and shown as they are. They are plain text. `StudyText` understands this line-based syntax and nothing else:

| In the text | Shown as |
|---|---|
| a blank line | a new paragraph |
| a line break inside a paragraph | a line break |
| a line starting with `# ` | a heading |
| a line starting with `## ` | a smaller heading |
| consecutive lines starting with `- ` | a bulleted list |

There is no bold, no italics, no links and no HTML. HTML in a text is shown as the characters that were typed: the renderer creates React text nodes only and never uses `dangerouslySetInnerHTML`. The one link of the consent screen is the privacy notice URL of the consent version. It is rendered only when it is an `http` or `https` address and opens in a new tab with `rel="noopener noreferrer"`.

Task prompts, consent item texts and questionnaire texts are shown as plain text without this syntax (line breaks in a task prompt are kept).

The Study Flow editor should describe exactly this table next to its text fields.

## 5. Localization

- `lib/i18n/types.ts` defines `Dictionary`: every interface string of the participant flow. `en.ts` and `fi.ts` each export one object of that type, so TypeScript fails when a key is missing in one language. `lib/i18n/i18n.test.ts` also checks equal keys, equal placeholders, that every recorder message key and every participant error code has a text, and that no interface text mentions dialect or a way of speaking.
- `getDictionary(locale)` returns the dictionary. `format(template, values)` fills `{name}` placeholders.
- Study content is written by the researchers, never hard-coded, and can have a version per language. The base text columns hold the English text, and `translations_json` of the same row holds the Finnish text (`packages/domain/src/localization.ts`). The server picks the text by the locale of the session; a text without a translation is shown in the base text. The editors in Study Flow, Consent and Questionnaires have a Finnish field next to each participant-facing text.
- The welcome page has no session yet: `GET /api/study/info` returns the title and the welcome text per locale (`studyNameByLocale`, `welcomeContentByLocale`), and the page shows the one of the chosen language.
- During the study a language button changes the interface at once and sends `POST /api/study/session/locale`; the state that comes back carries the study texts in the new language. A task already on screen keeps its stored snapshot while the session is in the language of the snapshot, and otherwise shows the published task text in the new language. Each recording stores the prompt that was shown (`utterances.prompt_snapshot`).
- The API does not state the language of each study text (a text can fall back to the base text), so the pages set `lang` for the interface language only. `StudyText` has a `lang` prop for the day the API provides one.
- Which languages are offered: `participantLocales` and `defaultLocale` of the study settings, through `GET /api/study/info`. The language buttons appear when more than one of them exists in the interface.
- The choice is sent as `locale` when the session is created and kept in the cookie `dts_locale` (a language code, readable by scripts, session lifetime). It is removed when the session ends.

### Adding a language

1. Create `lib/i18n/<code>.ts` exporting an object of type `Dictionary`. TypeScript lists every missing key.
2. Add the questionnaire form labels for the language in `components/questionnaire/labels.ts`.
3. Add the object to `DICTIONARIES` in `lib/i18n/index.ts`.
4. Add the code to `participantLocales` in the study settings.
5. Run `pnpm test` in `apps/web`: the dictionary tests cover the new language.

## 6. What is stored in the browser, and the cleanup

| Item | Where | Removed |
|---|---|---|
| Session token | HttpOnly cookie `dts_participant`, set and cleared by the server | by the server on completion and withdrawal |
| Language choice | cookie `dts_locale` | at the end of the session |
| Recordings, blob URLs, the microphone stream | memory of the recorder components | on record again, after the submit response, and when the step unmounts |
| Anything else | nothing: `localStorage` and `sessionStorage` are not used | `sessionStorage` is cleared at the end anyway |

When the state becomes `completed` or `withdrawn`, or the session is found expired, `StudyFlow` cancels a running upload, drops its turn bookkeeping and calls `clearClientState()`. The task step is unmounted, which stops a running recording, revokes the blob URL and releases the microphone. The final screen is rendered from memory. "Start next participant" and "Back to the first page" leave with a full page load, so no React state of the finished session survives (spec 137, 138).

## 7. Ending participation

"End participation" is shown from the consent step until the debrief. The dialog says in plain language what happens. On confirm the step is unmounted at once (a running recording stops and is dropped, a running upload is cancelled), `POST /api/study/session/withdraw` is called, and the withdrawal screen shows the debrief text, the participant code and the contact text returned by the API. The interface promises nothing about submitted data: it points to the study information.

"I do not want to participate" on the consent screen calls the same endpoint before any consent is stored. The screen then says that nothing was stored and shows only the contact text.

## 8. Study laptop workflow

With `studyLaptopMode: true` in the study settings:

1. The operator opens `/`. The participant chooses a language if there is a choice and presses "Begin".
2. The participant completes the study. The final screen asks them to tell the researcher that they have finished, and shows "Start next participant".
3. "Start next participant" loads `/` again. The session cookie is already cleared by the server, the language cookie by the page. The next person sees the welcome page in the study's default language, with nothing of the previous participant.

A refresh during the study resumes the same step. If the laptop is left in the middle of a session, the session becomes abandoned after the inactivity timeout, and the welcome page offers "Continue the study" only while the session is still running.

Researcher test run: sign in at `/admin/login`, then open `/?mode=test`. The session is a TEST session and the page shows the TEST banner on every step.

## 9. Tests

- `pnpm test` in `apps/web`: `components/participant/flow/flow.test.tsx`, `lib/i18n/i18n.test.ts`, `app/study/_lib/participantApi.test.ts`, `app/study/research-mode.test.ts`.
- `pnpm exec playwright test e2e/participant.spec.ts` in `apps/web`, against the running app. It signs in as admin and runs TEST sessions only. It also writes `docs/ui-current/participant-*.png`.
