# UI Lineage

This document records where the interface of the Dialect Translation Study Platform comes from, what was kept, what was changed and why. It is required by `docs/IMPLEMENTATION-SPEC.md` section 0.2 and is part of the Definition of Done. The component by component mapping is in `docs/UI-PARITY-MATRIX.md`.

```text
Reference repository:
https://github.com/josesiqueira/manipulative-ai

Reference commit inspected:
6938720847d8f98b7bda7d54f7a82261fa00c6c3
(origin/main on 2026-10-03; local checkout at
/home/jose/Dev/Manipulative AI/Manipulative-ai2)

Specification baseline commit:
6213e8994bc2ccd336643fb9bf4fbe15c98d6c0f

Date inspected:
2026-10-03
```

## Comparison with the baseline commit

Command: `git diff --stat 6213e89 6938720 -- societal-discussion/apps/web`

Result: **no output. Nothing under `societal-discussion/apps/web` changed between the baseline and the inspected commit.** The one commit in between (`6938720`, "Add Metso 2026 demo design spec, implementation plans ...") adds 7 documentation files (3666 lines) outside the web application. There were therefore no upstream UI improvements to adopt, and the descriptions in the specification (sections 0A to 0K) still match the reference code.

## Reference paths

All paths are under `societal-discussion/apps/web/`. Every file was read in full.

```text
design-system/AESTHETIC.md
design-system/COMPONENTS.md
design-system/ACCESSIBILITY.md
design-system/tokens.css
design-system/tailwind-tokens.js
tailwind.config.ts

src/app/globals.css
src/app/layout.tsx
src/app/page.tsx
src/app/chat/page.tsx
src/app/survey/page.tsx
src/app/survey-entry/page.tsx
src/app/thank-you/page.tsx

src/app/admin/layout.tsx
src/app/admin/page.tsx
src/app/admin/error.tsx
src/app/admin/components/AdminNav.tsx
src/app/admin/components/AdminAuth.tsx
src/app/admin/components/MetricCard.tsx
src/app/admin/components/Badge.tsx
src/app/admin/components/PartyBadge.tsx
src/app/admin/components/FilterBar.tsx
src/app/admin/components/ConversationList.tsx
src/app/admin/components/ConversationDetail.tsx
src/app/admin/components/RecentActivity.tsx
src/app/admin/components/RefreshButton.tsx
src/app/admin/components/SaveButton.tsx
src/app/admin/components/ExportPanel.tsx
src/app/admin/prompts/page.tsx
src/app/admin/settings/page.tsx
src/app/admin/conversations/page.tsx
src/app/admin/data/page.tsx
src/lib/useUnsavedChanges.ts
```

Class usage was also checked in `src/app/admin/try-bot/page.tsx` and the three chart components (`HorizontalBarChart.tsx`, `AdminBarChart.tsx`, `DailyChart.tsx`).

Screenshots of the reference, taken at this commit with no backend running: `docs/ui-reference/`. Screenshots of this application: `docs/ui-current/` (recaptured in full on 2026-10-03 from a database that holds only TEST and DEMO sessions). Neither set contains participant data.

## What the inspection found

The reference code and its own design documents disagree in a few places. Where they disagree, this project followed the rule written next to each item.

| Topic | Reference design documents | Reference code | This project |
|---|---|---|---|
| Font | system stack, "no Inter" | `layout.tsx` loads Inter from Google Fonts | system stack (spec 0A.3) |
| Sidebar width | 240px token | `w-56` (224px) | 224px, as one token `--sidebar-width` |
| Card radius | `rounded-lg` maximum | `rounded-lg` (MetricCard, AdminAuth, detail panels) and `rounded-xl` (Dashboard, Prompts, Data sections) | admin `rounded-lg`, participant `rounded-xl` |
| Error color | `--color-danger` is rose-600 | `red-*` and `rose-*` mixed | rose only |
| Focus ring | `ring-blue-600` | blue-600, blue-500 and slate-400 mixed; some controls have none | blue-600 everywhere |
| Loading | gray placeholder rectangle | pulsing "Loading..." text | pulsing "Loading..." text (what researchers actually see today) |
| Icons | "Lucide" | inline SVG, no package | inline SVG, no package |

## Adaptation summary

### Retained directly

- The neutral slate palette and its roles: slate-50 page, white surfaces, slate-100 sidebar, slate-200 borders and selected navigation, slate-300 input borders, slate-900 headings and primary actions, slate-700 body, slate-500 muted.
- The system font stacks, the type scale, `tabular-nums` and monospace for numbers and identifiers.
- The radius, shadow and transition scales, including the three subtle shadow values.
- The admin shell: fixed left sidebar (`w-56`, slate-100, right border, `z-10`), branding block with a small uppercase tracked name over "Research Dashboard", `px-3 py-2 rounded-md text-sm font-medium` navigation items with a neutral slate-200 active state and 16px outline icons, Sign Out at the bottom, main area `ml-56 p-8 min-w-0` on slate-50.
- The page heading pattern: `text-xl font-semibold` title, `text-sm text-slate-500` description, optional controls on the right.
- The login card: centered, `max-w-sm`, white, `rounded-lg`, `p-8`, password field, full-width dark slate "Sign In", inline alert "Incorrect password".
- `MetricCard` (uppercase muted label, monospace tabular value, optional subtitle and tooltip) and the compact dashboard variant.
- `Badge` pill geometry and sizes, the striped amber TEST treatment, the flag glyph on "flagged".
- `FilterBar`: wrapping row of native select, search and date inputs with a text-only clear action.
- The list row of the list and detail browser: `px-3 py-2`, `divide-slate-100`, `hover:bg-slate-50`, selected `bg-blue-50 border-l-2 border-blue-500`, sticky small uppercase header.
- The editor card: white bordered card, header row with metadata and Edit, Cancel, Save, monospace textarea, inline success and error message.
- `SaveButton` (dark slate, spinner, "Saving...") and the inline "Saved" text next to it; `RefreshButton` ("Last updated", Refresh, auto-refresh checkbox).
- The unsaved changes warning on `beforeunload`.
- The participant pages: `min-h-screen`, slate-50 to white background, `max-w-3xl` landing and `max-w-2xl` survey columns, `px-4 py-8`, compact language buttons at the top right, bold centered heading, white `rounded-xl` cards with `shadow-sm`, the blue-50 guidance box, the full-width dark slate start button, equal-width Likert and choice buttons with a slate-900 selected state, centered `max-w-md` completion card.
- The accessibility baseline: WCAG 2.1 AA, semantic landmarks, visible focus, reduced motion.

### Renamed

| Reference | This project |
|---|---|
| "SYNTHETICA" branding | "DIALECT TRANSLATION" |
| `ConversationList`, `ConversationDetail` | `SessionList`, `SessionDetail` (`app/admin/(shell)/sessions/_components/`), built on `ListRowButton`, `DataTable`, `KeyValueList` |
| `useUnsavedChanges` | `useUnsavedChangesGuard` |
| `Field`, `inputClass`, `labelClass` (local helpers in Settings and ExportPanel) | `FormField`, `TextInput`, `TextArea`, `Select` |
| `Section` (local helper in the Data page) | `Card` with `CardHeader` and `CardBody` |
| `CompactMetric` (local helper in the Dashboard) | `MetricCard density="compact"` |
| Badge variant `party` | removed; `neutral` covers it |
| Navigation: Conversations, Prompts, Try Bot | Sessions, Review & Transcription, Study Flow, AI Pipeline, Processing Runs, Questionnaires (Data & Export and Settings keep their names) |

### Changed because this is speech research

- **Recording control** (`RecordingControlFrame`): new. It extends the participant family (white prompt card, dark slate primary action, `rounded-xl` buttons) with a microphone icon, a "Recording 00:14" line with a small rose dot, a rose Stop button, native audio playback, "Record again" and "Submit and continue". There is no voice orb and no waveform.
- **Audio playback** (`AudioPlayer`): new thin wrapper around the native `<audio controls>` element with `preload="none"`.
- **Progress line** ("Task 2 of 7" with a thin neutral bar): new; the reference chat had no fixed sequence.
- **End participation**: a discreet text action in the participant shell.
- **Semantic color**: the four political block colors are gone. Blue, emerald, amber and rose now mean focus and information, verified and success, warning and TEST, error and flagged and destructive and recording.
- **Badges**: new variants `verified`, `needs-review`, `warning`, `demo`, `error`, `excluded`, `incomplete`, `completed`.
- **Mode banners**: `ModeBanner` (TEST, DEMO) and `PreviewBanner` in the participant flow.
- **Chat bubbles, heatmap and coverage cells, party badges**: not carried over. There is no chat and no live AI output in Research Mode.
- **Identifiers and durations**: `CopyableId`, `KeyValueList`, `formatDurationMs`, `formatDateTime` with an explicit time zone.

### Changed for scientific validity, security or accessibility

Scientific validity:

- TEST and DEMO are labelled everywhere a session appears, and DEMO has its own treatment so the two cannot be confused with each other or with research data.
- `translate="no"` on the document (kept from the reference) so that browser translation cannot alter study texts.
- `ConfirmDialog` with an optional typed phrase replaces `window.confirm` for destructive actions (spec 116). The reference offered one-click "Delete all data" behind a browser confirm.

Security:

- **Authentication**: the reference kept the admin password in `sessionStorage`, sent it in a header on every request and treated a network error as a successful login. Here the login page posts the password once to `/api/admin/login`, the server sets an HTTP-only session cookie, `proxy.ts` guards `/admin` on the server, and a failed or unreachable login is always an error. Sign Out posts to `/api/admin/logout` and performs a full page load. The visual treatment of the login card is unchanged.
- The login page accepts a `next` destination only if it is a same-origin path under `/admin`.
- The login page is outside the shell route group, so no admin markup is sent before authentication.

Accessibility:

- One focus ring (`blue-600`, 2px) on every interactive element. The reference had controls with no visible focus style and used a `slate-400` ring on participant inputs, which is below 3:1.
- Muted text is `slate-500` at minimum and `slate-600` on the sidebar; the reference used `slate-400` for some metadata and loading text (2.6:1).
- `FormField` ties label, help and error to the control. The reference Settings labels were not associated with their inputs.
- `LikertScale` and the choice buttons are native radio groups (fieldset, legend, arrow keys). In the reference they were unrelated buttons with no selected state exposed to assistive technology.
- `MetricCard` tooltips open on keyboard focus as well as hover.
- Skip link in the admin shell; `aria-current="page"` kept on navigation.
- The navigation active rule compares whole path segments.
- `DataTable` has a caption and header scopes.
- All motion is gated by `prefers-reduced-motion` globally and with `motion-safe:`.
- Recording state changes are announced once through a polite live region; the timer is not announced.
- Error color is one family (rose) and every error also has text.

### Intentional visual deviations

| Deviation | Reason |
|---|---|
| Tailwind CSS 4 with CSS-first tokens (`design-system/tailwind-tokens.css`, an `@theme` block) instead of a Tailwind 3 JavaScript config (`tailwind-tokens.js`) | The project stack is Tailwind 4. The token values are the same. The pointer cursor on buttons, which Tailwind 4 removed, is restored in `globals.css`. |
| Next.js 16 App Router (`proxy.ts`, route group `app/admin/(shell)`, `retry` in the error boundary) instead of Next.js 14 | Project stack. No visual effect. |
| System font stack instead of the Inter web font the reference actually loads | Spec 0A.3 and the reference's own AESTHETIC.md require system fonts. Glyph shapes differ slightly from the reference screenshots; sizes, weights and spacing are the same. |
| Admin cards are `rounded-lg`; the reference Dashboard, Prompts and Data sections use `rounded-xl` | Spec 0A.4 prefers `rounded-lg` for admin and the reference MetricCard, login card and detail panels already use it. One radius per shell is easier to keep consistent. |
| Rose instead of red for errors, flags and the delete button | One danger family, the reference token value. |
| Blue focus ring on participant inputs instead of `slate-400` | Contrast of the focus indicator (WCAG 1.4.11). |
| `slate-500` and `slate-600` where the reference used `slate-400` and `slate-500` for small text | Text contrast (WCAG 1.4.3). |
| Login card shows the project name above "Research Dashboard" | The page sits outside the shell, so it needs to say which study it belongs to. |
| Login password field has a visible "Password" label and no placeholder; after a failed sign-in the field is marked invalid, points at the message and gets focus back. The reference field has only a `slate-400` placeholder | A placeholder is not a label and is 2.63:1 on white (WCAG 3.3.2, 1.4.3, 3.3.1). |
| Secondary and small buttons are `rounded-md`; the reference Prompts header buttons are `rounded-lg` | The reference SaveButton and ExportPanel buttons are `rounded-md`; one radius for admin controls. |
| Export: one CSV and one JSON button (white, bordered) per table, and a dark slate "Create research dataset package" button, instead of format radios with one `blue-600` Download button | Spec 0B.3 and 0C.10: primary actions are dark slate; blue is for focus and information. Fifteen tables and background archive jobs do not fit one radio group. Confirmed in `admin-data-export-full.png`. |
| Settings sections are white cards with the Save button in the card header; the reference Settings page has plain sections separated by `hr` with Save under the fields | Same card as the editors, so one pattern for every editable block. The `max-w-3xl` column and label above input are kept. Confirmed in `admin-settings-1440x900.png`. |
| Dashboard: a Status card (study, protocol, active configurations, worker, storage, database) in place of the reference party bar chart, and a line under the metrics that counts DEMO and TEST sessions separately | No party data in this study; operational health is what a researcher needs first (spec 42). TEST and DEMO must never be counted as research data. Confirmed in `admin-dashboard-full.png`. |
| Single-choice questionnaire items are stacked full-width rows with a visible radio circle; the reference yes, no, unsure group is one row of equal-width buttons | Option lists come from the database and can have eight options with long labels. Likert items keep the equal-width row. Confirmed in `participant-questionnaire-full-1440.png`. |
| Session list rows have two lines (55 px); the reference conversation rows have three lines | The second line carries protocol, tasks, utterances, duration and review progress. Same `px-3 py-2`, hover and selected treatment. |
| Rendered slate values come from the Tailwind 4 palette (for example `slate-500` renders `#62748e`, `slate-600` `#45556c`), not the Tailwind 3 values of the reference (`#64748b`, `#475569`) that `tokens.css` lists | Tailwind 4 ships the palette in OKLCH. The difference is not visible side by side, but contrast must be computed from the rendered values (see the review below). |
| DEMO badge and banner (blue tint, dashed border) | New mode with no reference equivalent; must differ from TEST. |
| Confirmation is a styled modal dialog, not the browser's `confirm()` | Typed confirmation and accessible focus handling (spec 116). `window.confirm` is still used by `useUnsavedChangesGuard` for in-app links, matching the browser's own leave-page dialog. |
| In-app link clicks are also guarded when an editor has unsaved changes | Spec 129. The reference warned only on tab close. |
| No `Tabs` component | The reference has none; sections are stacked cards. |

## Side-by-side review of 2026-10-03 (first pass, by the implementing team)

Reference pages captured (no backend, so data areas show their loading or empty states): landing, survey, survey entry, thank-you, admin login, and inside the admin shell: dashboard, conversations, prompts, data and export, settings. This pass covered the welcome page, the login card, the admin shell on a placeholder page and the UI kit. Its findings (same column, heading, card and button on the welcome page; same sidebar geometry; 8 px card radius in admin against 12 px in the reference sections) still hold.

## Independent side-by-side and accessibility review of 2026-10-03

```text
Reference commit:   6938720847d8f98b7bda7d54f7a82261fa00c6c3
Reviewed on:        2026-10-03
Reviewed build:     the development server on http://localhost:3100 (this project has
                    no git history yet, so there is no commit to record for it)
Data in the captures: TEST and DEMO sessions only
```

Method: every page was opened in Chromium through Playwright at 1440x900 (participant pages also at 390x844, 320x640 and at 200 percent zoom), captured into `docs/ui-current/`, and compared by eye with the reference screenshot in `docs/ui-reference/`. The reference admin screenshots show loading or failed states because the reference ran without its backend, so the admin pairs were also compared with the reference source (class strings, spacing, type sizes, structure). The admin preview, parts of Session Detail and the AI Pipeline page were being changed during the review; their captures may be out of date.

Pairs reviewed (spec 0F step 6):

| Pair | Reference | Current |
|---|---|---|
| Landing and welcome | `ref-landing-1440x900.png`, `ref-landing-mobile-390x844.png` | `participant-welcome-1440x900.png`, `participant-welcome-fi-1440x900.png`, `participant-welcome-390x844.png`, `participant-study-closed-1440x900.png` |
| Survey and questionnaire | `ref-survey-1440.png` | `participant-questionnaire-full-1440.png`, `participant-questionnaire-likert-full-1440.png`, `participant-questionnaire-errors-full-1440.png`, `participant-questionnaire-likert-320x640.png` |
| Thank-you and completed | `ref-thank-you-1440x900.png`, `ref-survey-entry-1440x900.png` | `participant-completed-1440x900.png`, `participant-withdrawn-1440x900.png`, `participant-debrief-full-1440.png` |
| Admin dashboard | `ref-admin-dashboard-1440x900.png`, source `admin/page.tsx` | `admin-dashboard-1440x900.png`, `admin-dashboard-full.png` |
| Conversations and sessions | `ref-admin-conversations-1440x900.png`, source `ConversationList.tsx`, `ConversationDetail.tsx` | `admin-sessions-list-1440x900.png`, `admin-session-detail-1440x900.png`, `admin-session-utterance-matrix-1440x900.png`, `admin-session-provenance-open-1440x900.png`, `admin-review-utterance-1440x900.png` |
| Prompts and Study Flow, AI Pipeline | `ref-admin-prompts-1440x900.png`, source `prompts/page.tsx` | `admin-ai-pipeline-read-1440x900.png`, `admin-ai-pipeline-edit-1440x900.png`, `admin-ai-pipeline-compare-1440x900.png`, `admin-study-flow-published-1440x900.png`, `admin-study-flow-draft-1440x900.png`, `admin-study-flow-task-editor-1440x900.png`, `admin-study-flow-publish-review-1440x900.png` |
| Data and export | `ref-admin-data-1440.png` | `admin-data-export-1440x900.png`, `admin-data-export-full.png` |
| Settings | `ref-admin-settings-1440x900.png`, source `settings/page.tsx` | `admin-settings-1440x900.png`, `admin-settings-full.png`, `admin-settings-danger-zone-1440x900.png`, `admin-settings-danger-dialog-1440x900.png` |
| Shell and navigation | every reference admin capture, source `AdminNav.tsx` | `admin-nav-focus-1440x900.png`, `admin-skip-link-focus-1440x900.png` |
| Login | `ref-admin-login-1440x900.png` | `admin-login-1440x900.png`, `admin-login-error-1440x900.png` |
| Loading, empty, error | source (`animate-pulse` "Loading...", centered `text-sm` sentence, `admin/error.tsx`) | `admin-sessions-loading-1440x900.png`, `admin-sessions-empty-1440x900.png`, `admin-review-empty-1440x900.png`, `admin-sessions-error-1440x900.png` |
| No reference equivalent | | recording (`participant-task-idle-1440x900.png`, `participant-task-recording-1440x900.png`, `participant-task-candidate-1440x900.png`, `participant-task-upload-failed-1440x900.png`, `participant-mic-check-1440x900.png`), processing (`admin-processing-1440x900.png`, `admin-processing-batch-detail-1440x900.png`, `admin-processing-wizard-step1-1440x900.png`), questionnaires (`admin-questionnaires-1440x900.png`, `admin-questionnaire-preview-1440x900.png`), consent (`admin-consent-version-1440x900.png`), demo (`demo-1440x900.png`), preview (`admin-preview-1440x900.png`) |

Verdict: both shells and every reviewed page belong to the reference family. The participant welcome, questionnaire and completion pages line up with the reference captures apart from the typeface. The admin pages keep the sidebar, heading pattern, card, header row, badge, filter and list row treatment of the reference.

Drift and defects found (not intentional, to be fixed):

- Sessions with a selected session: the document is 11203 px tall although the detail panel scrolls inside 690 px, which leaves about 10000 px of empty white page under the shell. Review with a selected utterance: 1394 px against 970 px of content. Cause confirmed in the browser: screen-reader-only elements (absolutely positioned) inside the `overflow-y-auto` panels, which have no positioned ancestor. Setting `position: relative` on the panels brings the document back to 922 px and 970 px.
- Processing Runs: batch rows are 81 px tall because the name column wraps identifiers into three lines, and the table is wider than its card at 1440 px.
- Session detail, Provenance: the key and value list sits in a column of about 250 px, so identifiers such as `mock_translation_default v1` wrap in the middle.
- Dashboard: an 8 px horizontal scroll at 1440 px, caused by the hidden tooltip of the last metric card in a row.
- Dashboard recent activity: "1 utterances".
- `design-system/tailwind-tokens.css` says the Tailwind scales equal the hex values in `tokens.css`; the rendered values differ (see the deviation table).

Accessibility, verified in the browser:

- The whole participant study was completed with the keyboard alone (Tab, Enter, Space, arrow keys), including the microphone check, six recordings, both questionnaires and the debrief.
- Each participant step has one `h1`, focus moves to it when the step changes, and `lang` follows the interface language on `html` and on the flow container.
- While recording, the only live region text is "Recording started." (polite, written once); the timer has `aria-live="off"` and changed three times in 3.5 s without touching the live region.
- With `prefers-reduced-motion: reduce` no element has a running animation; without it only the recording dot pulses.
- No horizontal scrolling on any participant step at 320 px wide or at 200 percent zoom (640x450 CSS px).
- `ConfirmDialog` is a native modal dialog: focus moves into it, Tab stays inside it, Escape closes it, focus returns to the button that opened it.
- Measured contrast: `slate-500` text 4.76:1 on white, 4.55:1 on `slate-50`, 4.38:1 on the selected `blue-50` row (below 4.5:1); `slate-400` placeholder 2.63:1 on white; white on `rose-600` 4.53:1; `rose-700` on `rose-50` 5.49:1; `emerald-700` on `emerald-50` 5.09:1; amber badge text above 7:1.

Accessibility defects found:

- Keyboard focus falls back to the document body when Allow microphone, Record test, Start recording and Stop are pressed, because the focused button is removed (WCAG 2.4.3).
- `slate-500` metadata on selected list rows (`blue-50`) is 4.38:1 (WCAG 1.4.3).
- The admin login field has only a placeholder as visible label, at 2.63:1 (WCAG 3.3.2, 1.4.3); the "Incorrect password" alert is not referenced by the field, and focus is lost after a failed sign-in.
- Scrolling blocks without focusable content cannot be scrolled with the keyboard: the read-only prompt `pre` on AI Pipeline and two tables in Session Detail (WCAG 2.1.1).
- The page title is the same on every participant step and stays English in the Finnish interface (WCAG 2.4.2).
- Task texts of the placeholder protocol are English inside a container marked `lang="fi"` when the interface is Finnish (WCAG 3.1.2).

## Maintenance checklist

```text
Before a significant UI refactor:
1. inspect latest manipulative-ai design-system files;
2. compare against recorded reference commit;
3. list meaningful upstream changes;
4. decide which changes should be adopted;
5. update UI-PARITY-MATRIX;
6. update tokens/components consistently;
7. repeat side-by-side screenshots.
```

Rules of the contract between the two applications (spec 0G): there is no runtime dependency on the reference repository, nothing is synchronized automatically, and similar evolution happens through this deliberate review. When the review is done, update the commit, the date and the comparison section at the top of this document.
