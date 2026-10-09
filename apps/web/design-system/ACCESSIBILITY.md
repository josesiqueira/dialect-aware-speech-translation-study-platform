# Accessibility Requirements

Project: Dialect Translation Study Platform
Date: 2026-10-03
Ancestor: `societal-discussion/apps/web/design-system/ACCESSIBILITY.md` in `josesiqueira/manipulative-ai`.

The standard is WCAG 2.1 level AA, for the participant study and for the research dashboard. This is the floor. Participant pages must also work on a phone (responsive from 360px wide) and by keyboard alone.

## Color contrast

Text needs 4.5:1; large text (24px, or 18.66px bold) and interface component boundaries and focus indicators need 3:1.

The ratios are measured in the browser from the rendered Tailwind 4 colors (review of 2026-10-03), not computed from the Tailwind 3 hex values in `tokens.css`. The two differ: `slate-500` renders `#62748e`, `slate-600` `#45556c`, `rose-600` `#ec003f`.

| Element | Foreground | Background | Ratio |
|---|---|---|---|
| Heading and label | slate-900 | white | 17.83:1 |
| Body text | slate-700 | white | 10.36:1 |
| Muted text and metadata | slate-500 | white | 4.76:1 |
| Muted text on the page | slate-500 | slate-50 | 4.55:1 |
| Muted text on the sidebar (not allowed) | slate-500 | slate-100 | 4.35:1 |
| Muted text on a selected row or tinted panel (not allowed) | slate-500 | blue-50 | 4.38:1 |
| Metadata on a selected row or tinted panel | slate-600 | blue-50 | 6.97:1 |
| Navigation item, sidebar subtitle | slate-600 | slate-100 | 6.92:1 |
| Placeholder | slate-500 | white | 4.76:1 |
| Decorative icon, list marker (not text) | slate-400 | white | 2.63:1 |
| Primary button | white | slate-900 | 17.83:1 |
| Danger button | white | rose-600 | 4.53:1 |
| Badge emerald | emerald-700 | emerald-50 | 5.09:1 |
| Badge amber | amber-800 | amber-50 | 6.84:1 |
| Badge TEST | amber-900 | amber-100 and amber-200 stripes | 8.13:1 and 7.28:1 |
| Badge rose, error message | rose-700 | rose-50 | 5.49:1 |
| Badge DEMO | blue-800 | blue-50 | 8.11:1 |
| Info message | blue-900 | blue-50 | 9.53:1 |
| Focus ring | blue-600 | white | 5.25:1 |

Rules that follow from the table:

- **Metadata text on tinted or selected backgrounds uses `slate-600`.** `slate-500` passes only on white and on `slate-50`. On the selected row (`blue-50`) it is 4.38:1 and on the `slate-100` sidebar 4.35:1, both below the minimum. `ListRowButton` and the selected row of `DataTable` (`tableClasses.trSelected`) switch `text-slate-500` inside them to `slate-600`; a hand-written selected or tinted block must do the same. (The reference used `slate-500` for the sidebar subtitle and Sign Out.)
- `slate-400` is for decorative icons and list markers only. It is never used for text that carries information, and not for placeholders (it is 2.63:1 on white): placeholders are `slate-500`. The reference used `slate-400` for placeholders, some metadata and loading text.
- White on `rose-600` is 4.53:1, just above the minimum. Do not put white text on a lighter rose, and do not lower the opacity of a danger button that is enabled.
- Status is never communicated by color alone: badges always contain text, messages carry a screen-reader prefix ("Error:", "Warning:"), required fields say "(required)", the recording state is written out.

## Keyboard

- Everything interactive is reachable and operable with the keyboard, in DOM order: skip link, sidebar, main content.
- Admin pages start with a "Skip to main content" link that becomes visible on focus.
- Focus never falls back to the page when a control is replaced. In the recording controls the pressed button is removed (Start becomes Stop, Stop becomes the player); focus moves to the control that replaces it: Stop while recording, the native player once stopped, the retry button after a failed upload (`useFocusAfterStateChange`). Focus is not moved on the first render, and not when the participant has moved to another part of the page.
- A scrolling block with no focusable content (a read-only prompt, a long table) is focusable itself: `tabIndex={0} role="region" aria-label="..."` (`scrollRegionProps`) with `focusRing`. `DataTable` does this when `maxHeightClassName` is set.
- A scrolling container that has visually hidden children (`sr-only`, for example a table caption) is `relative`. `sr-only` is absolutely positioned; without a positioned scrolling ancestor it is placed against the page and makes the document taller than its content.
- Participant targets are at least 44px tall, text actions included ("End participation", the language buttons).
- Focus is always visible. Standard: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1` (`focusRing`). Text inputs use `focus:ring-2 focus:ring-blue-600 focus:border-blue-600`. Never remove an outline without this substitute.
- `LikertScale` and `RadioGroup` are native radio groups: one tab stop, arrow keys move and select.
- `ConfirmDialog` is a native modal `<dialog>`: focus moves into it and is kept inside, Escape cancels, focus returns to the opener. Initial focus is the typed-phrase input or Cancel, never the destructive button.
- No drag-only interaction. Reordering in editors must also offer "Move up" and "Move down" buttons.
- A selectable list row is a `<button>` (`ListRowButton`), not a clickable `<div>`.

## Semantic HTML

| Element | Use |
|---|---|
| `<nav aria-label="Admin">` | sidebar navigation |
| `<main id="main-content">` | one per page (both shells provide it) |
| `<header>` | page heading area |
| `<h1>` | exactly one per page (`PageHeading`, `ParticipantHeading`) |
| `<section>`, `<article>` | named sections, metric cards |
| `<table>` with `<caption>`, `<th scope="col">`, `<th scope="row">` | tabular data (`DataTable`) |
| `<dl>` | metadata (`KeyValueList`) |
| `<fieldset>` and `<legend>` | radio groups and Likert scales |
| `<button>` | every action |
| `<a>` | every navigation |
| `<dialog>` | confirmation |
| `<audio controls>` | all playback |

## ARIA

ARIA is used only where HTML is not enough.

| Component | Attributes |
|---|---|
| `FormField` and its control | `aria-describedby` (help and error), `aria-invalid`, `required` |
| `InlineMessage` | `role="alert"` for error, `role="status"` for the others, `announce="none"` for static guidance |
| `LoadingState` | `role="status"`; the loading region gets `aria-busy="true"` |
| `Button loading` | `aria-busy="true"` and `disabled` |
| `AdminNav` link | `aria-current="page"` on the active section |
| `ProgressBar` | `role="progressbar"`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-label` |
| `FilterSelect`, `FilterSearch` | `aria-label` (the row has no room for visible labels); `FilterDateInput` has a visible label |
| `LanguageSwitcher` | `role="group"`, `aria-pressed`, `lang` on each button |
| `CopyableId` | `aria-label="Copy session id"`, polite "Copied" status |
| icons | `aria-hidden="true"`, always next to text |

## Recording (new for this study)

- The start and stop state is perceivable without sight: `RecordingControlFrame` has one polite live region (`role="status"`) whose text changes once per state change ("Recording started.", "Recording stopped. You can listen to it, record again, or submit.", and so on).
- The elapsed time is **not** in a live region. It is a `role="timer"` element with `aria-live="off"`, so it is not read out every second, and it can still be read on demand.
- Microphone permission problems and recorder errors are explained in plain language in an `InlineMessage variant="error"`, with a "Try again" action. A failed upload says that the recording is kept and offers a retry without re-recording.
- Playback uses the native audio element, which is keyboard accessible. It is not replaced by a custom player.
- The recording indicator is the word "Recording" plus a rose dot; the dot is decorative (`aria-hidden`).
- No time pressure is added by the interface. A countdown appears only if the task protocol requires one.
- Nothing about the participant's speech (transcript, dialect label, confidence) is shown during collection.

## Motion

- `globals.css` reduces every animation and transition to nothing under `prefers-reduced-motion: reduce`.
- Use `motion-safe:animate-pulse` and `motion-safe:animate-spin`, never the plain forms.
- All transitions are 250ms or shorter, on color and opacity. Nothing plays by itself except the recording dot and a spinner inside a pending action.

## Forms

- Every control has a visible label (`FormField`, `Checkbox`, `RadioGroup`, `LikertScale`), or an `aria-label` in the compact filter row. A placeholder is never the only label (the admin login field has a visible "Password" label).
- Errors are specific ("Enter a valid email address.", not "Invalid input") and are attached to their field.
- Participant controls are large: `Button size="lg"` (48px tall), Likert buttons 44px tall, `Checkbox density="participant"`.

## Language

- The root layout sets `lang="en"` and `translate="no"` (automatic page translation would alter study texts). The participant flow sets the `lang` attribute of its content to the chosen interface language.
- Study texts (welcome, information, consent, task texts, debrief) are written by the researchers in one language and are shown as written, also when the interface is in another language. Their language is never guessed. `FlowShell` takes `contentLang`, and `StudyText`, task titles, prompts and the other protocol headings write it as their `lang`. The participant API does not provide the content language yet, so today no `lang` is written on study texts (open item, WCAG 3.1.2).
- The browser tab title names the step in the interface language, followed by the participant-facing study title ("Consent | Study title"), and changes with every step (`pageTitle` in `lib/i18n`). It never names the research focus.

## Checklist (before a UI phase ships)

- [ ] All text passes 4.5:1 (check new color pairs against the table).
- [ ] Tab through every page: nothing is skipped, focus is always visible, order is logical.
- [ ] Every table has a caption and header scopes.
- [ ] Every loading region sets `aria-busy`; every list has an empty state.
- [ ] Every form error is tied to its field.
- [ ] No status is shown by color alone; TEST and DEMO are written out.
- [ ] Recording: state changes are announced once, the timer is silent, errors are plain language.
- [ ] `prefers-reduced-motion` tested.
- [ ] Participant pages checked at 390px wide.
- [ ] Screen reader smoke test (NVDA or VoiceOver) of the participant flow and one admin page.
