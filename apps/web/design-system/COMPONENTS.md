# Component Conventions

Project: Dialect Translation Study Platform
Date: 2026-10-03
Ancestor: `societal-discussion/apps/web/design-system/COMPONENTS.md` in `josesiqueira/manipulative-ai`.

## The rule for tokens and classes

1. **Components are styled with Tailwind utilities from the standard slate scale and the four semantic families (blue, emerald, amber, rose)**, the way the reference components are. The mapping from scale step to meaning is fixed in `tokens.css` and summarized below. Use the step the table gives; do not pick a neighboring shade.
2. **No raw hex, rgb or arbitrary color value in a component.** The only custom utilities are the ones defined in `tailwind-tokens.css`: `font-sans`, `font-mono`, `shadow-xs`, `shadow-sm`, `shadow-md`, `w-sidebar` / `ml-sidebar`, `bg-test-stripes`.
3. **Shared class strings live in `components/ui/styles.ts`** (`focusRing`, `inputBase`, `inputSizes`, `labelBase`, `overlineLabel`, `filterControl`, `tableClasses`). A page that needs a hand-written control imports these instead of retyping them.
4. **Pages are built from the primitives in `components/ui`, `components/admin` and `components/participant`.** A page file should contain layout utilities (grid, flex, gap, space) and little else. If a pattern is needed twice, add it to the primitives.
5. `cn()` from `components/ui` joins classes; a caller's `className` overrides a default.

| Meaning | Class |
|---|---|
| Page background (admin) | `bg-slate-50` |
| Page background (participant) | `bg-linear-to-b from-slate-50 to-white` (set by `ParticipantShell`) |
| Surface | `bg-white border border-slate-200 shadow-sm` |
| Sidebar | `bg-slate-100 border-r border-slate-200` |
| Hover | `hover:bg-slate-50` on rows, `hover:bg-slate-100` on navigation |
| Selected navigation item | `bg-slate-200 text-slate-900` |
| Selected list row | `bg-blue-50 border-l-2 border-blue-500` |
| Divider inside a card | `border-slate-100`; `divide-y divide-slate-100` |
| Input and secondary button border | `border-slate-300` |
| Heading and label text | `text-slate-900`, labels `text-slate-700` |
| Body text | `text-slate-700` (admin), `text-slate-700` or `text-slate-600` (participant) |
| Muted text and metadata | `text-slate-500` on white and `slate-50`; `text-slate-600` on a selected row, a tinted panel and the sidebar |
| Placeholder | `placeholder:text-slate-500` (slate-400 is 2.63:1 on white: decorative icons and list markers only) |
| Primary action | `bg-slate-900 text-white hover:bg-slate-800` |
| Focus | `ring-2 ring-blue-600` (`focusRing`) |
| Success | `emerald-50` / `emerald-200` / `emerald-700` |
| Warning | `amber-50` / `amber-300` / `amber-800` or `amber-900` |
| Error, destructive, recording | `rose-50` / `rose-200` / `rose-700`; solid `rose-600` |

Differences from Tailwind 3 that matter when copying a class from the reference: Tailwind 4 renamed `shadow-sm` to `shadow-xs` and `shadow` to `shadow-sm` (this project overrides `shadow-xs`, `shadow-sm` and `shadow-md` with the reference values, so write the reference names as they are), renamed `rounded` to `rounded-sm`, uses `bg-linear-to-b` for `bg-gradient-to-b`, has no default border color (always write `border-slate-200` or another explicit color), and has no forms plugin (checkbox and radio color is set with `accent-slate-900`).

## General rules

- Components are PascalCase, one small file each. Shared primitives are exported from `components/ui/index.ts`.
- Every interactive element has default, hover, focus-visible and disabled states. Actions are real `<button>` elements; navigation is a real link.
- `Button` defaults to `type="button"`. Write `type="submit"` for the submitting button of a form.
- Loading: `LoadingState` (quiet text, `motion-safe:animate-pulse`) and `aria-busy="true"` on the region. Inside an action: `Button loading` with a label such as "Saving...".
- Empty: every list and table renders an `EmptyState` with a plain sentence. It never collapses to nothing.
- Error: `ErrorState` in place for a region that failed to load; `InlineMessage variant="error"` next to a form or action; a field error through `FormField error`.
- Success: inline (`InlineStatus`, `SaveButton status="saved"`, `InlineMessage variant="success"`). No routine toasts.
- Dates and durations: `formatDateTime(date, timeZone)`, `formatDate`, `formatDurationMs`, `formatRelativeTime`, `formatCount`, `formatCountOf(count, "utterance")` ("1 utterance", "2 utterances") from `lib/format.ts`, on elements with `tabular-nums`.
- Monospace (`font-mono`) for identifiers, metric values, AI and system prompts and code-like settings. Sans for participant-facing prose.
- Draft editors call `useUnsavedChangesGuard(isDirty)`.
- Destructive actions go through `ConfirmDialog`; highly destructive ones add `confirmPhrase`.
- TEST and DEMO are always labelled with `Badge variant="test"` / `"demo"` in admin and `ModeBanner` in the participant flow.

## Catalog: `@/components/ui`

| Component | Purpose | Lineage |
|---|---|---|
| `Button`, `LinkButton`, `buttonClasses` | Variants `primary` (dark slate), `secondary`, `danger`, `ghost`. Sizes `sm` (header rows), `md` (admin default), `lg` (participant, `rounded-xl`). `loading`, `loadingLabel`, `fullWidth`. | reference SaveButton, Prompts header buttons, landing start button |
| `Card`, `CardHeader`, `CardBody` | White bordered surface. `variant="admin"` `rounded-lg`, `variant="participant"` `rounded-xl`. `padding` none, sm, md, lg. Header row with title, meta, actions. | reference Section (Data page), Prompts card |
| `PageHeading` | `h1 text-xl font-semibold` plus one muted description, optional `actions`. | every reference admin page |
| `SectionHeading` | `h2` or `h3`, `size` base or lg, optional `description` and `aside`. | Dashboard card headings, Settings sections |
| `Badge`, `BADGE_VARIANTS` | Pill. Variants: neutral, status, completed, verified, needs-review, warning, test, demo, flagged, error, excluded, incomplete. Sizes sm, md. Text is mandatory. | reference Badge |
| `MetricCard` | Uppercase muted label, monospace tabular value, optional subtitle, tooltip (`tooltipAlign="end"` for a card in the last grid column), accent, `density` default or compact. | reference MetricCard and Dashboard CompactMetric |
| `FormField`, `useFieldControl` | Label, help, error. Passes id, `aria-describedby`, `aria-invalid`, `required` to the control inside through context. | reference Settings label and input pairs |
| `TextInput`, `TextArea`, `Select` | Native controls. `inputSize` md (admin) or lg (participant). `TextArea mono` for AI prompts. `Select options`, `placeholder`. | reference Settings inputs, Prompts textarea, Survey inputs |
| `Checkbox` | Native checkbox with label, description, error. `density` admin or participant. | reference Settings and Export checkboxes |
| `RadioGroup` | Fieldset of native radios. `layout="list"` or `"buttons"` (equal-width, selected slate-900). | reference Export format radios, Survey yes/no/unsure |
| `LikertScale` | Equal-width `min` to `max` buttons over native radios, anchors `lowLabel` and `highLabel`. | reference Survey LikertScale |
| `InlineMessage`, `InlineStatus` | Message in place: success, error, info, warning. Error is `role="alert"`, the others `role="status"`. | reference Prompts message, AdminAuth alert, "Saved" text |
| `LoadingState`, `EmptyState`, `ErrorState` | Quiet states. | reference "Loading...", "No conversations.", admin/error.tsx |
| `Spinner` | Compact spinner inside an action. | reference SaveButton spinner |
| `ConfirmDialog` | Native `<dialog>` modal. `tone="danger"`, `confirmPhrase`, `busy`, `error`. | replaces `window.confirm` in the reference |
| `Pagination` | Count, Previous, "Page N of M", Next. | reference Conversations pagination |
| `DataTable`, `tableClasses` | Compact table, sticky small uppercase header, caption, row header column, right-aligned numeric columns, selected row, empty state. With `maxHeightClassName` the wrapper is a focusable scrolling region (`scrollRegion`). | reference ConversationList header row density |
| `ListRowButton` | One compact selectable row of a list and detail browser. | reference ConversationList row |
| `KeyValueList` | Metadata `<dl>`, 1 or 2 columns, `mono` values. | reference ConversationDetail header grid |
| `CopyableId` | Monospace id, optional truncation, copy button, polite "Copied". | reference truncated id in detail header |
| `AudioPlayer` | Label, native `<audio controls>`, optional meta and download link. `preload` defaults to `"none"`; `ref` gives the audio element. | new (speech study) |
| `ProgressBar` | Thin neutral bar with `role="progressbar"`. | reference SurveyRating bar, neutral |
| `FilterBar`, `FilterSelect`, `FilterDateInput`, `FilterSearch`, `ClearFiltersButton` | Compact native filter row. Active filters get a blue tint. | reference FilterBar |
| `SaveButton` | Dark slate Save, "Saving...", inline `status` saved or error. | reference SaveButton plus Settings status text |
| `RefreshButton` | "Last updated", Refresh, optional auto-refresh checkbox, inline error. | reference RefreshButton |
| `useUnsavedChangesGuard`, `confirmDiscardChanges` | Warn before leaving with unsaved edits (browser and in-app links). | reference useUnsavedChanges |
| `VisuallyHidden` | Screen-reader-only text. | new |
| icons (`IconGrid`, `IconUsers`, `IconEdit`, `IconList`, `IconCpu`, `IconActivity`, `IconClipboard`, `IconDownload`, `IconSettings`, `IconSignOut`, `IconMic`, `IconStop`, `IconCopy`, `IconCheck`, `IconRefresh`) | One family: inline SVG outlines, 24 grid, stroke 1.75, `h-4 w-4` by default. | reference AdminNav inline icons |
| `cn`, `focusRing`, `inputBase`, `inputSizes`, `labelBase`, `overlineLabel`, `filterControl`, `scrollRegionProps` | Class helper, shared class strings, and the attributes of a keyboard-focusable scrolling region. | new |

There is no `Tabs` component: the reference does not use tabs. Sections on one page are stacked cards, as on the reference Data and Settings pages.

## Catalog: `@/components/admin`

| Component | Purpose |
|---|---|
| `AdminShell` | Skip link, fixed sidebar, `<main id="main-content">` offset by the sidebar, `bg-slate-50`, `p-8`, `min-w-0`. Used by `app/admin/(shell)/layout.tsx`. |
| `AdminNav` | Sidebar: branding block, nine routes, neutral states, Sign Out (POST `/api/admin/logout`, then `/admin/login`). |
| `ADMIN_NAV_ITEMS`, `isNavItemActive` | Route list and the active rule (exact for `/admin`, whole-segment prefix for the others). |
| `AdminPlaceholder` | Temporary page content until a page is built. |

## Catalog: `@/components/participant`

| Component | Purpose |
|---|---|
| `ParticipantShell` | `min-h-screen`, slate-50 to white background, centered column (`width` md, 2xl, 3xl), `px-4`, `py-6 sm:py-8`. Slots: `banner`, `languageSwitcher`, `endAction`, `progress`. `centered` for transition and completion pages. |
| `LanguageSwitcher` | Compact language buttons with `aria-pressed`. The pill keeps its size inside a 44px tall button. |
| `EndParticipationButton` | Discreet text action for withdrawing, 44px tall pressable area. |
| `ParticipantCard` | White, `rounded-xl`, slate border, `shadow-sm`, `p-6` or `p-8`. |
| `ParticipantHeading` | The step `h1`: `text-2xl` or `text-3xl` bold, optional eyebrow and description. |
| `StepActions` | Primary and secondary button row; stacks on a phone with the primary first. |
| `ModeBanner` | Sticky full-width TEST (striped amber) or DEMO (blue, dashed) banner. |
| `PreviewBanner` | Sticky "PREVIEW - NOT RESEARCH DATA". |
| `RecordingControlFrame` | Presentational recording control: prompt card, microphone, Start, "Recording 00:14" with a rose dot, Stop, native playback, "Record again", "Submit and continue". States: idle, requesting_permission, recording, stopped, uploading, upload_failed, error. All text through `labels`. Keyboard focus follows the replaced controls (`useFocusAfterStateChange`). |

## Page composition patterns

**Admin page**

```tsx
<div className="space-y-6">
  <PageHeading title="Sessions" description="Browse and review participant sessions." />
  <FilterBar label="Session filters">...</FilterBar>
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_3fr]">
    <Card padding="none" className="relative max-h-[70vh] overflow-y-auto">list rows, Pagination</Card>
    <Card padding="sm" className="relative max-h-[70vh] overflow-y-auto">detail</Card>
  </div>
</div>
```

The scrolling cards are `relative`: they contain visually hidden elements (`sr-only` captions and labels), which are absolutely positioned and would otherwise be laid out against the page and stretch the document.

**Editor card (Study Flow, AI Pipeline, Questionnaires, Settings)**

```tsx
<Card padding="none">
  <CardHeader title="Translation prompt" meta={<Badge variant="status">Active</Badge>}
    actions={<><Button size="sm" variant="secondary">Cancel</Button><SaveButton size="sm" ... /></>} />
  <CardBody>
    <FormField label="System prompt"><TextArea mono rows={16} /></FormField>
  </CardBody>
</Card>
```

**Metric grid**: `grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4` with `MetricCard density="compact"`.

**Participant step**

```tsx
<ParticipantShell width="2xl" progress={{ current: 2, total: 7, label: "Task 2 of 7" }}
  languageSwitcher={...} endAction={<EndParticipationButton onClick={...} />}>
  <ParticipantHeading eyebrow="Controlled speaking task" title="Read the text aloud" />
  <RecordingControlFrame state={...} prompt={...} ... />
</ParticipantShell>
```

The developer page `/dev/ui-kit` shows every primitive in every state.
