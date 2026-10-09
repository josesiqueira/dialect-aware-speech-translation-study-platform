# Design Aesthetic

Project: Dialect Translation Study Platform (participant study and research dashboard)
Date: 2026-10-03
Ancestor: `josesiqueira/manipulative-ai`, `societal-discussion/apps/web/design-system/AESTHETIC.md`, commit `6938720847d8f98b7bda7d54f7a82261fa00c6c3`. See `docs/UI-LINEAGE.md`.

## Direction

A restrained, data-forward academic tool: a well-typeset research appendix brought into the browser. White space, slate neutrals, a tight typographic hierarchy. Structure comes from spacing and subtle borders, not from shadows or gradients. A researcher who has used the reference study and its dashboard should recognize this one at once.

There are two densities of the same language:

- **Admin**: dense but breathable. `text-sm` body, compact rows, fixed light-slate sidebar, `slate-50` page, white bordered cards.
- **Participant**: larger and calmer. `text-base` body, one centered narrow column, white `rounded-xl` cards on a subtle `slate-50` to white background, one clear dark-slate action per step.

## Rationale

Researchers read data here and participants follow a study protocol. Neither is being marketed to. Visual novelty competes with comprehension, and for participants it can change how they behave in the study. The system font stack says "tool", costs no font download, and renders crisply on university-managed machines.

## Semantic color

The neutral slate scale carries the whole interface. Strong color must mean something. The reference used four chromatic families for political blocks; those meanings are not carried over. The same four families now mean:

| Family | Meaning | Typical use |
|---|---|---|
| slate | ordinary interface, default metadata, primary action (`slate-900`) | everything by default |
| blue | keyboard focus, information, the selected row in a list and detail browser, an active filter | focus ring `blue-600`, info message |
| emerald | verified, completed, success | status badges, "Saved" |
| amber | warning, needs review, TEST | striped TEST badge and banner |
| rose | error, flagged, destructive action, microphone actively recording | error message, Delete, Stop, recording dot |

Rules:

- No other color family is used. No brand color, no decorative color.
- Color never carries meaning alone. Every badge has text; error and warning messages carry a screen-reader prefix; the recording state is also written as "Recording".
- TEST uses diagonal amber stripes (the reference Badge "test" treatment) so that test data is hard to mistake for research data. DEMO uses a blue tint with a dashed border, visibly different from TEST.
- The reference mixes `red-*` and `rose-*` for errors. This system uses `rose` only, the value of the reference `--color-danger` token.
- Task types are neutral badges. If researchers later decide to color-code task types, the mapping is defined once in `tokens.css` and documented here.

## Key choices

- **Theme**: light only. `color-scheme: light`. There is no dark mode.
- **Typography**: system sans for all interface text, system monospace for identifiers, numbers in metric cards, AI prompts and code-like settings. No web fonts. `tabular-nums` for counts, durations, metrics and timestamps.
- **Hierarchy**: participant heading `text-2xl` or `text-3xl` bold; admin page heading `text-xl` semibold; section heading `text-base` or `text-lg` semibold; admin body `text-sm`; metadata `text-xs` muted.
- **Radius**: admin cards `rounded-lg`, controls `rounded-md`, badges `rounded-full`. Participant cards and participant buttons `rounded-xl`, which is the largest surface radius.
- **Shadow**: none, `shadow-xs` or `shadow-sm` on surfaces. `shadow-md` only on a tooltip or the confirmation dialog.
- **Layout**: admin has a fixed 224px sidebar (`w-sidebar`) and a main area with `p-8`; list and detail browsers split roughly 40/60. Participant pages are one column, `max-w-2xl` or `max-w-3xl`, `px-4`, `py-6` to `py-8`.
- **Motion**: 100 to 250ms, `transition-colors` and `transition-opacity` only. All motion stops under `prefers-reduced-motion`. The one animated element is the small pulsing dot while the microphone records, because it communicates a critical state.
- **Feedback**: inline, next to the control (`InlineMessage`, `InlineStatus`, `SaveButton`). No routine success toasts.

## Anti-patterns (do not use)

- No gradients in admin. The participant page background (`slate-50` to white) is the single gradient, inherited from the reference participant pages.
- No `rounded-2xl` or larger on surfaces. No shadow above `shadow-sm` on surfaces. No glow, no glass panels.
- No color outside the semantic table above. No colored icons on metrics.
- No hero sections, marketing copy or illustration.
- No shimmer loaders. Loading is quiet text.
- No web fonts and no second font family.
- No dark mode, no dark or branded sidebar, no top-only navigation, no icon-only rail.
- No 3D charts, pie charts, speedometers or KPI gradients.
- No gamification of study progress: no points, levels or celebration.
- No animated voice orb and no decorative waveform in the recording control.
- No custom replacement for a native form control or the native audio player when the native one does the job.
- No UI framework and no icon package.
