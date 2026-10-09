# Implementation Specification: Stage-Resolved Dialect-Aware Speech Translation Study Platform

**Working title:** Dialect-Aware Speech Translation Study Platform  
**Primary empirical context:** Finnish regional variation (*murteet*) translated into English  
**Primary users:** Research participants and a small researcher/admin team  
**Primary implementation audience:** Claude Code / software engineer implementing the study platform  
**Document purpose:** This is the authoritative implementation specification for the first production-capable version of the research website. It intentionally combines the scientific design, product requirements, data model, UI flow, processing architecture, provenance requirements, privacy constraints, and implementation acceptance criteria in one place.

**UI lineage requirement:** The visual and interaction design must deliberately evolve from the `josesiqueira/manipulative-ai` research application family. This requirement is specified, documented, and visually verified below; it is not merely an aesthetic suggestion.

---

# 0. Instructions to Claude Code

Build this as a **research instrument**, not as a generic voice chatbot and not as a consumer translation product.

The scientific value of the system depends on the ability to trace every research datum from:

1. the exact participant-facing task;
2. to the exact accepted source recording;
3. to the exact ASR output;
4. to the exact human dialect-preserving transcript;
5. to the exact normalized Finnish transcript;
6. to each translation condition;
7. to each synthesized speech output;
8. to the exact model, prompt, parameters, software version, and timestamp that produced it;
9. to subsequent human annotations and ratings.

A visually attractive interface is useful, but **scientific provenance, data integrity, versioning, privacy, and reproducibility take precedence over convenience**.

Do not simplify away provenance fields because they seem redundant.

Do not store the audio itself as a PostgreSQL blob. Store media files in a media/object storage layer and store their metadata, hashes, and storage keys in PostgreSQL.

Do not add participant accounts, public user profiles, social features, or general-purpose user management.

Do not make the public research experience behave like a ChatGPT-style live conversation in **Research Mode**. During research speech collection, participants record speech without being shown the AI transcription or translation and without hearing synthetic translated speech. The reason is methodological: AI feedback could change subsequent speech.

A separate **Demo Mode** may perform immediate speech -> ASR -> translation -> TTS for seminars and testing.

All potentially changeable study content must be versioned. Published protocol versions are immutable.

## 0.1 Mandatory UI/UX lineage: `josesiqueira/manipulative-ai`

**This is a hard implementation requirement, not optional inspiration.**

The participant-facing website and researcher/admin interface must belong visibly and behaviorally to the same research-software family as:

`https://github.com/josesiqueira/manipulative-ai`

Use the implementation under:

```text
societal-discussion/apps/web/
```

as the canonical design ancestor.

At the time this specification was revised, the inspected repository state was represented by commit/reference:

```text
6213e8994bc2ccd336643fb9bf4fbe15c98d6c0f
```

Claude Code must **not rely only on the descriptions in this document**. Before implementing the UI, inspect the current `main` branch of `josesiqueira/manipulative-ai`, record the exact commit SHA inspected, and compare it with the baseline above. If the reference repository has evolved, adopt compatible improvements unless they conflict with the scientific requirements of this study.

The objective is controlled product-family continuity: someone who has used the `manipulative-ai` study and its admin should immediately recognize the same design language, interaction hierarchy, density, and researcher workflow here.

This requirement applies to:

- page composition;
- spacing and typography;
- color restraint;
- button hierarchy;
- cards and panels;
- forms and questionnaires;
- list/table density;
- badges and status treatment;
- loading, empty, success, and error states;
- sidebar navigation;
- admin dashboard composition;
- edit/save/cancel workflows;
- participant-facing study cards;
- accessibility behavior;
- transitions and motion;
- reusable component conventions.

It does **not** mean copying political-specific concepts, data semantics, or labels.

### Reference files that MUST be inspected

Before creating new UI components, inspect at minimum:

```text
societal-discussion/apps/web/design-system/AESTHETIC.md
societal-discussion/apps/web/design-system/COMPONENTS.md
societal-discussion/apps/web/design-system/ACCESSIBILITY.md
societal-discussion/apps/web/design-system/tokens.css
societal-discussion/apps/web/design-system/tailwind-tokens.js

societal-discussion/apps/web/src/app/globals.css
societal-discussion/apps/web/src/app/layout.tsx
societal-discussion/apps/web/src/app/page.tsx
societal-discussion/apps/web/src/app/chat/page.tsx
societal-discussion/apps/web/src/app/survey/page.tsx
societal-discussion/apps/web/src/app/survey-entry/page.tsx
societal-discussion/apps/web/src/app/thank-you/page.tsx

societal-discussion/apps/web/src/app/admin/layout.tsx
societal-discussion/apps/web/src/app/admin/page.tsx
societal-discussion/apps/web/src/app/admin/components/AdminNav.tsx
societal-discussion/apps/web/src/app/admin/components/AdminAuth.tsx
societal-discussion/apps/web/src/app/admin/components/MetricCard.tsx
societal-discussion/apps/web/src/app/admin/components/Badge.tsx
societal-discussion/apps/web/src/app/admin/components/FilterBar.tsx
societal-discussion/apps/web/src/app/admin/components/ConversationList.tsx
societal-discussion/apps/web/src/app/admin/components/ConversationDetail.tsx
societal-discussion/apps/web/src/app/admin/components/RecentActivity.tsx
societal-discussion/apps/web/src/app/admin/components/RefreshButton.tsx
societal-discussion/apps/web/src/app/admin/components/SaveButton.tsx
societal-discussion/apps/web/src/app/admin/components/ExportPanel.tsx
societal-discussion/apps/web/src/app/admin/prompts/page.tsx
societal-discussion/apps/web/src/app/admin/settings/page.tsx
societal-discussion/apps/web/src/app/admin/conversations/page.tsx
```

Do not start from a generic dashboard template and then loosely approximate this experience. Do not replace the established family with Material UI, Ant Design, Bootstrap Admin, or a heavily pre-styled SaaS/shadcn dashboard theme. Tailwind plus semantic React components should remain the primary presentation approach unless there is a compelling technical reason otherwise.

---

## 0.2 Required UI lineage documentation in the new repository

Create:

```text
docs/UI-LINEAGE.md
```

It must record:

```text
Reference repository:
https://github.com/josesiqueira/manipulative-ai

Reference commit inspected:
<exact SHA>

Reference paths:
<relevant design-system and UI files>

Date inspected:
<ISO date>

Adaptation summary:
- retained directly;
- renamed;
- changed because this is speech research;
- changed for scientific validity/security/accessibility;
- intentional visual deviations.
```

Also create a local design-system area:

```text
apps/web/design-system/
├── AESTHETIC.md
├── COMPONENTS.md
├── ACCESSIBILITY.md
├── tokens.css
└── tailwind-tokens.*
```

These files should begin from the same conceptual system as `manipulative-ai` and document the speech-study adaptations. The design system must not remain implicit in hundreds of unrelated Tailwind class strings.

Create additionally:

```text
docs/UI-PARITY-MATRIX.md
```

with columns such as:

```text
Reference route/component
Reference behavior/style
New route/component
Retained
Adapted
Reason for adaptation
Status
```

At minimum map:

- landing/welcome;
- survey/questionnaire;
- thank-you/debrief;
- admin shell;
- admin authentication;
- dashboard;
- conversation/session browser;
- filter bar;
- detail panel;
- badges;
- prompt/config editor;
- settings;
- export;
- save actions;
- loading state;
- empty state;
- error state.

This matrix is part of Definition of Done.

---

# 0A. Shared visual language

## 0A.1 Overall character

The reference admin defines a restrained, data-forward academic tool: essentially a well-typeset research appendix brought into the browser. Preserve that philosophy.

Core qualities:

- light theme;
- white/surface backgrounds;
- slate neutral UI chrome;
- system fonts;
- tight, legible typographic hierarchy;
- subtle borders;
- very restrained shadows;
- limited corner radii;
- dense but breathable researcher screens;
- larger, calmer participant screens;
- color primarily for semantic state or meaningful data encoding;
- no decorative illustration;
- no glossy SaaS aesthetic;
- no glassmorphism;
- no neon or decorative gradients in admin;
- no excessive motion;
- no oversized marketing hero.

The new application should feel immediately familiar to a researcher switching between the two studies.

## 0A.2 Shared base tokens

Use the same neutral palette as the starting point:

```text
Page background:        slate-50   / #F8FAFC
Surface/card:           white      / #FFFFFF
Sidebar background:     slate-100  / #F1F5F9
Hover background:       slate-100
Selected background:    slate-200
Border:                 slate-200
Strong border/input:    slate-300

Primary text:           slate-900
Body text:              slate-700
Muted text:             slate-500
Faint/placeholder:      slate-400

Primary dark action:    slate-900
Primary dark hover:     slate-800

Info/focus:             blue family
Success/verified:       emerald family
Warning/test:           amber family
Danger/flag/error:      rose/red family
```

Use semantic design tokens rather than scattering raw hex values.

The old political block colors are not copied as political semantics. Their design principle remains: **strong color must mean something**.

For this study, strong color may encode:

- focus/information;
- verified/completed;
- needs-review/warning;
- TEST/DEMO;
- flagged/error/destructive;
- active recording state;
- optional task categories if researchers explicitly decide that category color materially helps navigation.

Do not add decorative color merely to make pages look lively.

## 0A.3 Typography

Retain the system-font strategy:

```text
UI:
ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
"Segoe UI", Helvetica, Arial, sans-serif

Data/IDs/numbers:
ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas,
"Liberation Mono", monospace
```

Do not introduce a web font simply to differentiate the new application.

Expected hierarchy:

```text
Participant major heading:   text-2xl/text-3xl, bold or semibold
Admin page heading:          text-xl/text-2xl, semibold
Section heading:             text-base/text-lg, semibold
Admin body:                  text-sm
Participant body:            text-base where appropriate
Metadata:                    text-xs/text-sm muted slate
Metric values:               mono/tabular figures where appropriate
```

Use `tabular-nums` for counts, durations, metrics, and timestamps where alignment benefits readability.

## 0A.4 Radius and shadow restraint

Admin:

```text
Card/panel: rounded-lg preferred
Controls: rounded-md/rounded-lg
Badge: rounded-full
Shadow: none, shadow-xs, or shadow-sm
```

Some current reference participant/admin surfaces use `rounded-xl`; this is acceptable where it preserves the existing family. Do not exceed that as a normal surface treatment.

Avoid routine use of:

```text
rounded-2xl
rounded-3xl
shadow-lg
shadow-xl
glow effects
glass panels
```

## 0A.5 Motion

Keep interactions quiet:

```text
100-250ms transitions
transition-colors
transition-opacity
```

Respect `prefers-reduced-motion`.

Do not introduce confetti, spring animations, animated gradients, decorative skeleton shimmer, or a consumer voice-assistant animation. A minimal pulsing/solid recording-state indicator is acceptable because it communicates critical state.

---

# 0B. Participant-facing parity

The participant-facing study must evolve from the **public participant experience** of `manipulative-ai`, not from the denser admin interface.

The inspected reference participant pages use:

- a subtle slate-50 to white page background;
- centered narrow content (`max-w-2xl`/`max-w-3xl` depending screen);
- white cards;
- slate borders;
- `shadow-sm`;
- clear centered headings;
- dark-slate primary actions;
- white/slate secondary actions;
- spacious vertical rhythm;
- simple bilingual/language controls where applicable;
- survey sections as white bordered cards;
- equal-width Likert option buttons;
- centered `max-w-md` completion/transition cards.

Retain that relationship.

## 0B.1 Participant shell

Recommended:

```text
min-h-screen
subtle slate-50 -> white background
max-w-2xl or max-w-3xl
mx-auto
px-4
py-6/py-8
```

Participant pages should feel calm and sequential. Do not show dense admin-style tables.

## 0B.2 Participant card pattern

Use the reference family:

```text
bg-white
rounded-xl
border border-slate-200
shadow-sm
p-6 / p-8
```

for meaningful sections such as:

- study information;
- consent;
- microphone check;
- task prompt;
- questionnaire section;
- debrief;
- completion.

Do not wrap every paragraph in its own card.

## 0B.3 Buttons

Primary action:

```text
bg-slate-900
text-white
font-semibold or font-medium
hover:bg-slate-800
disabled:opacity-50
disabled:cursor-not-allowed
rounded-lg/rounded-xl
```

Secondary action:

```text
bg-white
border border-slate-300
text-slate-600/700
hover:bg-slate-50 or slate-100
```

Examples:

- Begin;
- Continue;
- Submit recording;
- Re-record;
- Back;
- Finish study.

Danger styling is reserved for truly destructive/termination actions.

## 0B.4 Recording control

Recording is new functionality, but its UI must look like a native extension of the existing participant site.

Do **not** build a glowing voice orb.

Preferred visual structure:

```text
Task 2 of 7
Controlled speaking task

[white prompt card]

        microphone icon

       Start recording

    Recording 00:14  ●

           Stop

     [audio playback]

[Record again]    [Submit and continue]
```

Rules:

- central, obvious recording control;
- dark-slate primary action family;
- rose/red only for active recording/stop/destructive semantics;
- duration in tabular numerals;
- simple accessible audio playback;
- no decorative waveform required in v1;
- if a level meter exists, keep it restrained and neutral;
- never display dialect classification/model confidence during collection.

## 0B.5 Progress

This study has a known sequence, so add restrained orientation:

```text
Task 2 of 7
```

and optionally a thin neutral progress bar.

Do not gamify:

- no points;
- no achievement badges;
- no levels;
- no celebratory animation.

## 0B.6 Forms, consent, and questionnaires

Evolve directly from the reference Survey page:

- white section cards;
- visible labels;
- slate borders;
- dark-slate selected state;
- neutral unselected state;
- equal-width 1-5 Likert buttons where appropriate;
- text inputs/areas with slate focus rings;
- concise helper text;
- no custom form widgets unless necessary.

Long consent text should use a readable narrow measure and strong heading hierarchy.

## 0B.7 Welcome, transition, and final screens

Follow the same centered low-distraction pattern as the reference landing, survey-entry, and thank-you pages.

Do not build a university marketing homepage.

---

# 0C. Admin parity

The admin must feel especially close to `manipulative-ai`, because the same researchers may use both tools.

## 0C.1 Application shell

Retain the reference layout:

```text
+----------------------+-------------------------------------------+
| fixed sidebar        | scrollable main content                   |
|                      |                                           |
| branding             | page heading                              |
| nav                  | description                               |
|                      | cards / filters / split views / forms     |
|                      |                                           |
| sign out             |                                           |
+----------------------+-------------------------------------------+
```

Reference behavior:

```text
sidebar:
fixed top-0 left-0
h-screen
approximately 224-240px
bg-slate-100
border-r border-slate-200
flex-col

main:
offset by sidebar width
bg-slate-50
p-8
min-w-0
```

The implementation may standardize at 240px or retain the existing `w-56` (~224px), but it must be internally consistent.

Do not replace this with:

- top-only navigation;
- dark/black sidebar;
- colorful branded sidebar;
- floating pill navigation;
- icon-only rail by default.

## 0C.2 Branding block

Same pattern:

```text
[PROJECT NAME]
Research Dashboard
```

Small uppercase/semibold project name plus muted subtitle.

Potential placeholder:

```text
DIALECT TRANSLATION
Research Dashboard
```

No oversized logo treatment.

## 0C.3 Navigation states

Keep neutral sidebar states:

```text
Default: text-slate-600
Icon: text-slate-400
Hover: bg-slate-100 text-slate-900
Active: bg-slate-200 text-slate-900
Focus: visible 2px info/blue ring
```

Active state is neutral, not a colored marketing accent.

Use one icon family consistently.

New navigation:

```text
Dashboard
Sessions
Review & Transcription
Study Flow
AI Pipeline
Processing Runs
Questionnaires
Data & Export
Settings

Sign Out
```

## 0C.4 Page headings

Every admin page begins with the same compact pattern:

```text
Page title
One concise muted description
```

No page-specific hero banners.

## 0C.5 Dashboard

Adapt the existing Dashboard instead of inventing an unrelated analytics product.

Retain:

- operational headline count(s);
- compact metric cards;
- recent activity;
- refresh control;
- optional auto-refresh;
- restrained charts;
- white bordered metric surfaces;
- small uppercase muted labels;
- tabular counts.

Do not use:

- giant decorative icons;
- KPI gradients;
- speedometers;
- 3D charts;
- decorative pie charts.

## 0C.6 Direct component mapping

Claude Code must deliberately map familiar patterns:

| `manipulative-ai` | New study |
|---|---|
| `AdminNav` | `AdminNav` with study routes |
| `AdminAuth` | secure-cookie auth with same visual treatment |
| `MetricCard` | `MetricCard` |
| `Badge` | `Badge` |
| `FilterBar` | `SessionFilterBar` / review filters |
| `ConversationList` | `SessionList` |
| `ConversationDetail` | `SessionDetail` / utterance detail |
| `RecentActivity` | `RecentActivity` |
| `RefreshButton` | `RefreshButton` |
| `SaveButton` | `SaveButton` |
| `ExportPanel` | `ExportPanel` |
| Prompts editor | AI Pipeline / Study Flow editors |
| Settings sections | Settings |
| Try Bot | Demo Mode / Pipeline Test |

If a component is renamed, preserve the familiar interaction and visual grammar where the domain permits.

## 0C.7 Sessions browser

The reference Conversations page uses filters + list/detail browsing. Preserve this interaction.

Desktop target:

```text
+--------------------------------------+--------------------------------------+
| Session list                         | Session detail                       |
| filters/sort                         | metadata                             |
| participant/date/status              | utterances                           |
| badges                               | transcripts/translations/audio       |
+--------------------------------------+--------------------------------------+
```

Prefer approximately 40/60 list/detail where the richer speech detail benefits from extra width. The inspected implementation sometimes uses equal columns; maintain the split-browser concept even if the exact proportion varies.

Rows should remain compact:

```text
text-xs/text-sm metadata
py-2-ish density
subtle dividers
slate-50 hover
clear selected state
sticky small headers when useful
```

Do not turn every session into a giant card.

## 0C.8 Badges

Preserve the compact pill style.

Required study variants include:

```text
neutral
status/completed
verified
needs-review
warning
test
demo
flagged
error
excluded
```

`TEST` must remain intentionally hard to mistake for research data, following the reference striped/strong test treatment. `DEMO` should also be distinct.

Never rely on color alone; badge text is mandatory.

## 0C.9 Study Flow / AI prompt / Questionnaire editors

Evolve directly from the reference Prompts and Settings pages:

```text
white bordered card
header row
status/version metadata
Edit
Cancel
Save
textarea/form controls
inline success/error state
```

Use system monospace for system/AI prompts and code-like settings.

Use normal sans-serif for participant-facing prose.

Unsaved-change warnings are required.

## 0C.10 Save and async behavior

Retain the reference rhythm:

- dark-slate primary Save;
- disabled while pending;
- compact spinner only inside the action if needed;
- `Saving...` label;
- inline success/error status;
- avoid routine success-toast spam.

Global toasts are acceptable mainly for exports or important asynchronous events.

## 0C.11 Filters

Keep filters compact and native-looking:

- native/select controls;
- date inputs;
- search field;
- clear-filter action;
- wrapping layout.

Do not introduce a large filter drawer in v1 unless scale justifies it.

## 0C.12 Data & Export

Adapt the existing ExportPanel experience:

- grouped export families;
- concise explanations/tooltips;
- explicit filters;
- format buttons/options;
- progress/downloading state;
- TEST/DEMO excluded by default.

Audio and full dataset packages extend this pattern rather than redesign it.

---

# 0D. Study-specific semantic color adaptation

Do not carry political labels into this study.

Recommended semantics:

```text
slate: ordinary interface/default metadata
blue: focus/information
emerald: verified/completed/success
amber: warning/needs review/TEST
rose/red: error/flagged/destructive
rose/red recording indicator: microphone actively recording
```

If task types are color-coded later, define that mapping centrally and use it consistently. A safe initial choice is neutral task-type badges.

---

# 0E. Accessibility parity

Carry forward the reference WCAG 2.1 AA minimum.

At minimum:

- semantic landmarks;
- visible form labels;
- keyboard operability;
- visible `focus-visible` rings;
- accessible tables;
- `aria-live` only where appropriate;
- `aria-busy` for async regions;
- reduced-motion support;
- adequate contrast;
- real `<button>` elements for actions;
- real navigation links;
- no color-only status communication;
- field-specific error associations.

Recording adds new requirements:

- start/stop state must be perceivable by screen readers;
- do not announce elapsed duration every second in an intrusive live region;
- microphone permission/errors must have plain-language feedback;
- audio playback controls must remain keyboard-accessible.

Do not replace accessible native media controls merely for style unless the custom control achieves equivalent accessibility.

---

# 0F. Process that ENSURES UI parity

## Step 1 - Inspect upstream before coding

Read the reference files from current `main` and record the exact commit in `docs/UI-LINEAGE.md`.

## Step 2 - Build the parity matrix

Create `docs/UI-PARITY-MATRIX.md` before feature-page styling is considered complete.

## Step 3 - Port/adapt tokens first

Establish design tokens/Tailwind mappings before styling feature pages.

Avoid arbitrary raw colors/sizes when a shared token exists.

## Step 4 - Build shared primitives first

At minimum:

```text
Button
Card
PageHeading
SectionHeading
Badge
MetricCard
FormField
TextInput
TextArea
Select
InlineMessage
LoadingState
EmptyState
AdminNav
filter primitives
```

Do not over-engineer a large design-system framework; the goal is consistent lineage.

## Step 5 - Validate the two shells first

Implement and visually review:

```text
ParticipantShell
AdminShell
```

before styling every feature page.

If these shells drift, the whole application will drift.

## Step 6 - Side-by-side visual QA

At the end of each UI-heavy phase, compare corresponding pages from both projects.

When feasible, run `manipulative-ai` locally and capture matched-viewport screenshots.

Recommended reference captures:

```text
landing
survey
thank-you
admin dashboard
conversations
prompts
data/export
settings
```

Recommended target captures:

```text
welcome
questionnaire
thank-you/debrief
admin dashboard
sessions
Study Flow / AI Pipeline
Data & Export
Settings
```

Store non-sensitive development screenshots in:

```text
docs/ui-reference/
docs/ui-current/
```

Never include participant/research data in UI regression screenshots.

## Step 7 - Document intentional deviations

Every meaningful deviation goes in `docs/UI-LINEAGE.md`.

Valid reasons include:

- recording controls have no old equivalent;
- richer speech/session detail;
- secure cookie auth replacing the old sessionStorage password pattern;
- scientific protocol versioning;
- processing-run management;
- accessibility improvement;
- removal of live AI feedback in Research Mode.

"A generated template looked nicer" is not a valid reason.

---

# 0G. Evolution contract between both research applications

The goal is not brittle pixel-perfect coupling. It is controlled visual lineage.

1. This project's design system starts from the current `manipulative-ai` family.
2. The exact source commit is recorded.
3. Component mappings are explicit.
4. New speech-specific components extend existing patterns.
5. Before a major future redesign, inspect the latest `manipulative-ai` design system and decide whether compatible changes should be adopted here.
6. Update `UI-PARITY-MATRIX.md` during those reviews.
7. Do **not** create a runtime dependency on the other repository.
8. Do **not** auto-sync CSS/components from upstream in production.
9. Similar evolution happens through deliberate design review, not hidden coupling.

Recommended maintenance checklist in `UI-LINEAGE.md`:

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

---

# 0H. UI anti-drift rules

Claude Code must **not**:

- redesign this into a glossy SaaS dashboard;
- use a materially different visual identity because a generator suggests it;
- introduce dark mode by default;
- add decorative gradients to admin;
- add colorful icons to every metric;
- use oversized rounded-2xl/3xl surfaces throughout;
- use floating glass panels;
- create a dark or highly branded sidebar;
- replace the fixed desktop admin shell with an unrelated navigation model;
- introduce multiple font families;
- add illustration-heavy onboarding;
- gamify study progress;
- create an animated voice orb;
- use arbitrary decorative colors outside semantic/data mappings;
- turn Sessions into oversized card feeds when a compact list/detail view is appropriate;
- replace accessible native form controls merely for appearance;
- install a UI framework whose defaults visibly break the established family.

If a generated component conflicts with this contract, reject the generated styling and adapt it to the family.

---

# 0I. Concrete component lineage examples

### Conversation list -> Session list

```text
KEEP:
compact rows
muted timestamps
status badges
hover state
selected state
sorting
filter integration

CHANGE:
party -> mode/protocol/review badges
messages -> utterance count
starter topic -> task/protocol summary
```

### Conversation detail -> Session detail

```text
KEEP:
right-side detail surface
metadata header
clear subsections
download actions
flag-for-review
researcher notes

ADD:
source audio
A/A*/B/C transcripts
translation matrix
TTS outputs
model provenance
questionnaire responses
```

### Prompts -> Study Flow / AI Pipeline

```text
KEEP:
white bordered cards
edit state
monospace for system prompts
Save/Cancel hierarchy
inline metadata
unsaved-change protection

ADD:
draft/published/active states
version comparison
protocol publishing
model provenance
```

### Try Bot -> Demo Mode / Pipeline Test

```text
KEEP:
researcher-only experimentation
strong separation from real research data

CHANGE:
text chat -> microphone / ASR / translation / TTS pipeline
```

---

# 0J. UI acceptance criteria

The UI is not complete merely because features work.

```text
[ ] docs/UI-LINEAGE.md exists and records the exact reference commit.
[ ] docs/UI-PARITY-MATRIX.md exists.
[ ] Current manipulative-ai design files were inspected.
[ ] Shared design tokens are centralized.
[ ] System-font strategy matches the reference family.
[ ] Admin uses a fixed light-slate sidebar.
[ ] Admin content uses the slate-50/white academic-tool treatment.
[ ] Active admin navigation is neutral.
[ ] Admin cards use subtle borders/shadows.
[ ] Dashboard metrics visually resemble the reference family.
[ ] Sessions uses the familiar compact list/detail browsing philosophy.
[ ] Filters resemble the reference FilterBar.
[ ] Badges resemble the reference Badge family.
[ ] AI/Study Flow editors resemble the reference Prompts editor.
[ ] Settings resembles the reference Settings structure.
[ ] Export resembles the reference ExportPanel interaction.
[ ] TEST and DEMO are visually unmistakable.
[ ] Participant pages use the same centered light-background/card family.
[ ] Participant primary actions use dark slate, not an unrelated brand palette.
[ ] Questionnaire controls belong to the same visual family.
[ ] Recording controls extend the family rather than introducing a voice-assistant aesthetic.
[ ] No default dark mode exists.
[ ] No decorative admin gradients exist.
[ ] Generic SaaS-template drift has been avoided.
[ ] WCAG 2.1 AA expectations are addressed.
[ ] Reduced-motion behavior is implemented.
[ ] Key reference/target pages were reviewed side-by-side.
[ ] Intentional deviations are documented.
```

---

# 0K. Reference-specific traits confirmed during inspection

### Participant side

The inspected implementation uses:

- centered `max-w-3xl` landing content;
- subtle `slate-50 -> white` participant background;
- compact language buttons;
- bordered white informational surfaces;
- full-width dark-slate primary start button;
- `max-w-2xl` survey content;
- white rounded survey cards with slate borders/shadows;
- equal-width Likert button groups;
- selected survey choices in slate-900/white;
- centered `max-w-md` transition/thank-you cards;
- sticky white/slate chat header and restrained controls.

The new study inherits the visual lineage but replaces the old live chat interaction with scientifically appropriate recording tasks.

### Admin side

The inspected implementation uses:

- fixed left sidebar;
- slate-100 sidebar;
- slate-50 main page;
- compact icons;
- small branding block;
- neutral active navigation;
- generous main-content padding;
- concise page headings;
- white bordered dashboard metrics;
- small uppercase metric labels;
- tabular numeric values;
- filters + list/detail browsing;
- compact rows;
- visible TEST/Flagged badges;
- white bordered prompt/settings sections;
- monospace system-prompt text;
- dark-slate save actions;
- grouped data/export controls;
- visually quiet loading, empty, and error states.

These define the family resemblance and should drive implementation choices.

---

Do **not** copy political-specific concepts, labels, or data semantics from `manipulative-ai`.

Do retain its product philosophy, component grammar, visual restraint, and researcher workflow wherever the speech-study requirements permit.

---

# 1. Scientific purpose

## 1.1 Core problem

The study investigates whether and where AI speech translation transforms, normalizes, preserves, or distorts linguistic variation.

The central pipeline is:

```text
Finnish speech
    ->
ASR / transcription
    ->
Finnish textual representation
    ->
Finnish-to-English translation
    ->
English translated text
    ->
speech generation / TTS
    ->
English synthetic speech
```

The platform must enable the researchers to investigate which transformations happen at which stage.

The system must not assume in advance that dialect always disappears or that more obviously "dialectal" output is automatically better.

---

## 1.2 Research questions supported by the platform

The implementation must support these working research questions:

### RQ1 - Stage-specific transformation

**At which stages of Finnish-to-English AI speech translation are selected dialectal, pragmatic, and stylistic distinctions retained, functionally reformulated, normalized, or distorted?**

### RQ2 - Translation intervention

**Does preservation-aware translation improve retention of communicatively relevant variation compared with default translation, without reducing semantic fidelity or naturalness?**

### RQ3 - Acoustic realization

**When translated wording is held constant, how do speech-generation choices affect the preservation and perception of prosody, stance, emotion, and speaker characteristics?**

### RQ4 - Social representation

**How do source speakers, bilingual evaluators, and target-language listeners perceive the representational adequacy and social meaning of AI-translated speech?**

The first implementation must fully support RQ1 and RQ2 data collection and must lay a clean foundation for RQ3/RQ4 later.

---

# 2. Critical conceptual distinctions

These distinctions must influence both the data model and the UI.

## 2.1 Voice preservation is not dialect preservation

A system can reproduce a speaker's vocal timbre while standardizing their words, grammar, pragmatics, accent, and interactional style.

Therefore store and evaluate separately:

- speaker/voice similarity;
- linguistic variation;
- prosodic realization;
- social interpretation.

Never use a field called simply `identity_preserved = true/false`.

---

## 2.2 Dialect preservation is not literal form copying

Finnish morphology and Finnish regional forms generally cannot be copied literally into English.

A translated output can therefore be:

- formally different but functionally appropriate;
- lexically standard but pragmatically equivalent;
- superficially "dialectal" but socially misleading;
- geographically relocated into an unrelated English dialect;
- semantically accurate but socially flattened.

The data model must support annotation categories such as:

- retained;
- functionally reformulated;
- compensated elsewhere;
- neutralized;
- distorted;
- exaggerated or invented;
- not transferable;
- uncertain.

---

## 2.3 Output normalization is not proof of societal dialect levelling

This platform studies transformations in AI-mediated outputs.

It does **not** by itself establish that Finnish dialects are disappearing from society.

The participant information, admin wording, analytics, and eventual paper language should therefore avoid claiming that the experiment directly measures population-level dialect levelling.

---

# 3. Two application modes

The system must have two clearly separated modes.

---

## 3.1 Research Mode

Purpose: collect scientifically usable speech data without AI output influencing subsequent speech.

Flow:

```text
participant speaks
    ->
source audio is safely stored
    ->
participant moves to next study task
```

ASR can run in the background immediately, but the participant does **not** see it.

Translation can run later.

TTS can run later.

During speech collection, do not show:

- ASR transcript;
- translation;
- dialect classification;
- model response;
- preservation condition;
- synthetic translated voice;
- model name.

The participant may listen to **their own just-recorded source audio before submission** and may re-record it.

Rejected re-record attempts should be deleted rather than retained unless the study protocol is deliberately changed later to investigate self-repair behavior.

Store only the accepted recording plus an `attempt_count`.

---

## 3.2 Demo Mode

Purpose: seminar demonstrations, development, operator testing, and pedagogical exploration.

Flow:

```text
participant/demo speaker records Finnish
    ->
ASR is displayed
    ->
default translation is displayed
    ->
preservation-aware translation is displayed
    ->
synthetic audio can be played
```

Demo data must be marked:

```text
data_mode = "demo"
```

or:

```text
is_test = true
```

and must be excluded from research exports by default.

Demo Mode may be admin-protected or accessible through a special configured route.

Do not silently mix Demo Mode data into the research corpus.

---

# 4. High-level product architecture

One codebase / one web product with two major surfaces:

```text
                        ONE APPLICATION

             +------------------------------+
             | PARTICIPANT / PUBLIC SIDE    |
             |                              |
             | Welcome                      |
             | Study information            |
             | Consent                      |
             | Microphone check             |
             | Instructions                 |
             | Controlled tasks             |
             | Semi-structured tasks        |
             | Free speech                  |
             | Background questionnaire     |
             | Post-recording questionnaire |
             | Debrief                      |
             | Done                         |
             +---------------+--------------+
                             |
                             v
                 PostgreSQL + Media Storage
                             |
                             v
             +------------------------------+
             | /admin                       |
             |                              |
             | Dashboard                    |
             | Sessions                     |
             | Review & Transcription       |
             | Study Flow                   |
             | AI Pipeline                  |
             | Processing Runs              |
             | Questionnaires               |
             | Data & Export                |
             | Settings                     |
             +------------------------------+
```

---

# 5. Recommended technology stack

Use TypeScript end-to-end.

## 5.1 Core stack

- current stable Next.js with App Router;
- TypeScript with strict mode enabled;
- PostgreSQL;
- Drizzle ORM;
- Drizzle migrations;
- Tailwind CSS;
- server-side OpenAI SDK usage;
- Node worker process for background jobs;
- object/file storage abstraction;
- Docker for reproducible local/deployment environments.

Prefer `node-postgres` with Drizzle unless the deployment environment gives a reason to use another supported PostgreSQL driver.

---

## 5.2 Suggested monorepo structure

```text
/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── lib/
│   │   └── ...
│   │
│   └── worker/
│       ├── src/
│       └── ...
│
├── packages/
│   ├── db/
│   │   ├── schema/
│   │   ├── migrations/
│   │   └── index.ts
│   │
│   ├── domain/
│   │   ├── types/
│   │   ├── validators/
│   │   └── constants/
│   │
│   ├── ai/
│   │   ├── providers/
│   │   ├── transcriber/
│   │   ├── translator/
│   │   └── synthesizer/
│   │
│   ├── storage/
│   │   ├── StorageAdapter.ts
│   │   ├── local/
│   │   └── s3/
│   │
│   └── research/
│       ├── protocol/
│       ├── export/
│       └── provenance/
│
├── drizzle/
├── docker/
├── docs/
├── scripts/
├── .env.example
├── package.json
└── README.md
```

A simpler single-package implementation is acceptable for the first commit, but retain clean boundaries between:

- database;
- AI provider;
- storage;
- participant study flow;
- admin UI.

---

# 6. Public participant flow

The participant-facing side must be extremely simple.

Do not expose research machinery unnecessarily.

The participant should be able to complete the study without understanding ASR, LLMs, prompt engineering, or the A/B/C conditions.

---

## 6.1 Page/state 1 - Welcome

Purpose:

- establish that this is a research study;
- identify institution/research group;
- show approximate duration;
- indicate that voice will be recorded;
- provide a start button.

Example structure:

```text
[Study title]

We are studying how AI speech-translation technologies process
different ways of speaking Finnish.

The study takes approximately XX minutes.

You will be asked to record several short spoken responses in Finnish.

[Begin]
```

Do not state a directional hypothesis such as:

> "We believe AI destroys Finnish dialects."

The participant should receive truthful information without unnecessary priming.

---

## 6.2 Page/state 2 - Study information and consent

The exact text will later be supplied by the researchers and approved according to the study's ethics/data-protection process.

The software must support:

- a versioned information sheet;
- a versioned consent form;
- required consent items;
- optional consent items if the eventual study requires them;
- a link to a privacy notice;
- researcher/controller contact details;
- a clear exit action.

Possible consent scopes should be configurable rather than hard-coded.

Potential examples:

- participation in the current study;
- recording of voice;
- processing with specified external AI services;
- retention for the defined research period;
- controlled future research reuse;
- public/open release, if ever applicable.

Do **not** assume that all of these will use the same lawful basis or that consent alone solves GDPR requirements.

The platform records:

- consent version;
- each item shown;
- each item accepted/not accepted;
- timestamp;
- study protocol version.

Do not collect IP address as research data unless explicitly required later.

---

## 6.3 Page/state 3 - Microphone permission and microphone check

Only request microphone access after the participant has reached this stage.

Flow:

```text
Allow microphone
    ->
record about 5 seconds
    ->
play the test recording locally
    ->
participant confirms audio quality
```

Buttons:

- `Record test`
- `Stop`
- `Play`
- `Try again`
- `Continue`

**The microphone test audio must not be stored as research data.**

It can remain in browser memory and must be discarded when the participant leaves this step.

The system may store non-content technical settings such as:

- browser;
- operating system;
- selected audio input device label if permission exposes it;
- requested constraints;
- actual media track settings;
- AudioContext sample rate.

---

## 6.4 Page/state 4 - Study instructions

The wording should avoid dialect priming.

Preferred concept:

> Speak naturally, in the way you would normally speak in the situation described. There is no correct way to speak and you do not need to use standard written Finnish.

Avoid:

> Please use your dialect strongly.

Avoid asking participants to identify their dialect before speech collection.

Explain:

- each task;
- recording control;
- ability to replay own source recording;
- ability to re-record before submission;
- ability to stop participation.

---

# 7. Speech elicitation design

The platform must support three task families.

---

## 7.1 Controlled communicative tasks

Goal: high comparability while preserving spontaneous production.

Everyone receives the same communicative situation, but participants formulate the Finnish utterance themselves.

Example:

> Imagine that an English-speaking friend has invited you somewhere this weekend. Respond naturally in Finnish and explain that you are unsure whether you want to go.

This is **not** a read-aloud task.

Do not force everyone to say a provided Finnish sentence.

Admin configuration fields:

- internal name;
- participant title;
- participant prompt;
- optional context;
- task type = `controlled`;
- estimated target duration;
- minimum recording duration;
- maximum recording duration;
- enabled;
- ordering group;
- randomization eligibility;
- optional researcher notes.

---

## 7.2 Semi-structured tasks

Goal: balance comparability and naturalistic speech.

Example:

> Tell us about the place where you grew up and what makes it distinctive.

Optional predefined follow-ups may be shown.

Examples:

- "Is there anything distinctive about how people speak there?"
- "Can you give an example of a local expression or way of saying something?"
- "Tell us about a typical situation you remember from there."

Important:

**Research Mode follow-ups are predefined. Do not ask an LLM to dynamically generate follow-up questions based on the participant's previous answer.**

Otherwise the elicitation context itself becomes model-dependent and differs systematically between participants.

A semi-structured task can create multiple utterances:

```text
task presentation
├── utterance 1 - main prompt
├── utterance 2 - predefined follow-up 1
└── utterance 3 - predefined follow-up 2
```

Follow-ups can be:

- always shown;
- manually enabled in protocol;
- optional participant-facing.

Do not infer follow-up selection using AI in the initial study.

---

## 7.3 Free speech

Goal: ecological richness and exploratory naturalistic data.

Example:

> Speak naturally in Finnish about anything you would like to communicate to an English-speaking person.

Provide guidance such as:

> Aim for about one to two minutes.

But do not require exact duration.

Free speech is **exploratory**, not the main controlled causal comparison.

Admin must be able to configure:

- prompt;
- suggested duration;
- hard maximum duration;
- optional topic suggestions;
- privacy reminder.

Display a reminder:

> Please avoid using real people's full names or other unnecessary identifying personal information.

---

# 8. Task ordering and randomization

Study Flow must support:

- fixed order;
- random order within a block;
- randomized controlled tasks followed by fixed semi-structured and free blocks;
- future balanced-order designs.

For v1, implement:

```text
order_mode:
- fixed
- shuffle_within_block
```

Randomization must be reproducible.

Use a deterministic seed derived from the session ID or store the generated order explicitly.

The database must store **the actual exact task sequence presented to each participant**.

Never reconstruct task order later from the current protocol configuration.

---

# 9. Recording interaction

For every recording prompt, participant UI should resemble:

```text
Task 2 of 7

[Prompt text]

        [Start recording]

        Recording 00:14

        [Stop]

        [Play my recording]

[Record again]            [Submit and continue]
```

Requirements:

- only one recording active at a time;
- visible recording state;
- visible duration;
- maximum duration enforcement;
- playback of own accepted candidate;
- re-record before submission;
- submit only after upload succeeds;
- clear error/retry path if upload fails.

Do not show the ASR transcript.

Do not show translation.

Do not play generated English.

---

# 10. Recording attempts

Each utterance tracks:

```text
attempt_count
```

If participant records attempt 1, re-records, and submits attempt 2:

- delete attempt 1 from client/browser memory;
- if attempt 1 was already uploaded temporarily, delete it from server/media storage;
- store accepted attempt 2;
- set `attempt_count = 2`.

Avoid retaining rejected recordings unnecessarily.

---

# 11. Background sociolinguistic questionnaire

Collect this **after** the main speech tasks to reduce priming.

The questionnaire must be versioned and editable from admin.

Potential fields include:

- age range;
- municipality/region where participant primarily grew up;
- other places lived for extended periods;
- current broad region;
- first language(s);
- languages used regularly;
- how participant describes their own Finnish;
- whether they identify with a regional variety/dialect;
- optional free-text self-description.

Do not make self-described dialect the only ground-truth dialect label.

The recorded linguistic behavior remains independently analyzable.

Collect only variables with a defined research purpose.

---

# 12. Post-recording questionnaire

Because Research Mode does not show translations during collection, the initial questionnaire should evaluate the **elicitation experience**, not translation quality.

Possible items:

- How naturally did you feel you were speaking?
- Did you deliberately change how you normally speak?
- Did you try to speak more standard Finnish than usual?
- Did you consciously emphasize regional/dialectal features?
- How comfortable were you speaking to the computer?
- Did any task feel unnatural?
- Optional free comment.

Use configurable Likert scales.

Do not hard-code the final questionnaire wording into components. Store it in protocol/questionnaire configuration.

---

# 13. Debrief

Show:

- a fuller explanation of the study;
- contact details;
- participant/session code;
- relevant withdrawal/discontinuation information according to the approved protocol.

Do not promise a right or deletion workflow that has not been legally/ethically defined.

---

# 14. Session identity

Participants do not create accounts.

Generate a pseudonymous code, for example:

```text
P-7K4M9Q
```

Avoid sequential public-facing IDs if they reveal participant counts unnecessarily.

Internally use UUIDs.

A session should have:

```text
id: UUID
participant_code: human-readable random code
mode: research | demo | test
status:
    created
    consented
    recording
    questionnaire
    completed
    withdrawn
    abandoned
protocol_version_id
started_at
completed_at
withdrawn_at
```

For the first deployment, assume one study session per participant interaction.

Design the schema so repeated sessions could be supported later.

---

# 15. Research processing pipeline

The processing pipeline must be modular.

Define interfaces similar to:

```ts
interface Transcriber {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

interface Translator {
  translate(input: TranslationInput): Promise<TranslationResult>;
}

interface SpeechSynthesizer {
  synthesize(input: SynthesisInput): Promise<SynthesisResult>;
}
```

The study must not be coupled permanently to OpenAI.

Initial implementation can use OpenAI adapters.

Future adapters should be possible for:

- Whisper/local ASR;
- Seamless models;
- another commercial provider;
- university-hosted Finnish ASR;
- another LLM;
- another TTS engine.

---

# 16. A/B/C transcript conditions

Each accepted source utterance must eventually support:

## A - Automatic ASR transcript

Produced by configured ASR system.

Immutable as a model output.

Example:

```text
Minä en oikeastaan tiedä...
```

Store exact raw output.

---

## A* - Optional ASR error-corrected transcript

Recommended for a diagnostic subset.

A human corrects obvious **recognition errors** while intentionally leaving ASR normalization intact.

Purpose:

```text
A -> A*
approximately isolates recognition errors

A* -> B
helps investigate normalization / representational changes
```

This condition should be supported by the schema even if not required for every utterance.

---

## B - Human dialect-preserving transcript

Human researcher listens to source audio and transcribes the spoken Finnish while preserving relevant non-standard forms according to the study transcription conventions.

Example:

```text
Mie en oikeestaan tiiä...
```

This is not automatically generated by an LLM in the main research dataset.

---

## C - Minimally normalized Finnish transcript

Human-created or human-verified normalized version derived from B.

Goal:

- normalize selected regional/non-standard linguistic forms;
- preserve propositional content;
- preserve discourse events unless normalization explicitly targets them;
- do not polish the utterance into a new composition;
- maintain an edit trail.

Example:

```text
Minä en oikeastaan tiedä...
```

C is a negative/control representation.

A preservation-aware translation should **not invent regional/social characteristics that are absent from C**.

---

# 17. Transcript review status

Each required human transcript has:

```text
status:
    not_started
    draft
    needs_review
    verified
```

Track:

- researcher/annotator identifier or label;
- created_at;
- updated_at;
- verified_at;
- verification notes;
- transcription convention version.

For a single-researcher MVP, `annotator_label` can be a simple text identifier rather than full account management.

Do not implement a user-management system merely for this.

---

# 18. Immutable transcript revision history

Human-edited scientific records should have revision history.

Recommended pattern:

```text
transcripts
    id
    utterance_id
    type

transcript_revisions
    id
    transcript_id
    revision_number
    text
    created_at
    created_by_label
    change_reason
    is_current
```

Editing a verified transcript creates a new revision rather than destroying the previous scientific record.

ASR outputs are model-generated immutable revisions.

---

# 19. ASR difference coding

The review interface should eventually allow researchers to classify differences between ASR and B/A*.

Initial categories:

- recognition_error;
- normalization;
- omission;
- addition;
- segmentation;
- punctuation_or_formatting;
- uncertain.

This may initially be applied at utterance level.

Design the schema so span-level annotations can be added later.

Do not force every difference into exactly one category if multiple categories apply.

---

# 20. Translation conditions

For each eligible transcript representation:

```text
A
A* optional
B
C
```

the system can run at least two translation conditions.

---

## 20.1 Default translation

A deliberately ordinary translation instruction.

Working baseline:

```text
Translate the following Finnish utterance into natural spoken English.
Preserve its meaning.
Return only the translation.
```

The final wording is researcher-controlled and versioned.

---

## 20.2 Preservation-aware translation

Working concept:

```text
Translate this Finnish utterance into natural spoken English.

Preserve propositional meaning and communicatively relevant differences
in register, informality, stance, politeness, discourse organization,
idiomatic force, humour, and emphasis when supported by the source.

Use natural English equivalents rather than copying Finnish forms.

Do not arbitrarily assign the speaker a named English regional dialect.
Do not add stereotypical dialect markers.
Do not invent information, emotion, emphasis, or social meaning that is
not supported by the source.

Return only the translation.
```

Again: the final prompt is editable and versioned in admin.

---

# 21. Translation matrix

Core offline processing matrix:

```text
                    DEFAULT        PRESERVATION
A ASR                  X                X
B HUMAN                X                X
C NORMALIZED           X                X

A* optional            X                X
```

This is a within-utterance design.

The same source utterance can produce multiple translations.

Do not overwrite prior translation outputs when a new prompt or model is tested.

Create a new processing run.

---

# 22. TTS conditions

TTS is downstream of translated text.

Initial baseline:

- one fixed voice;
- same voice for all experimental translation conditions;
- same synthesis model;
- same synthesis instructions;
- WAV output if available.

Reason:

If the translation condition changes and the TTS voice also changes, linguistic and acoustic effects become confounded.

Do **not** attempt voice cloning in the first study.

---

# 23. Acoustic/TTS subexperiment

The main study cannot automatically attribute loss of prosody to TTS because text transcription may already have removed acoustic information.

The architecture should therefore support a separate controlled experiment:

```text
EXACT SAME ENGLISH TEXT
        |
        +---- neutral synthesis
        |
        +---- expressive synthesis
```

Translated wording must be identical across these TTS conditions.

This feature can be implemented after the core corpus pipeline.

Schema must not assume one synthesis per translation.

---

# 24. Optional black-box end-to-end condition

Later, support a black-box speech-to-speech condition such as a realtime translation model.

This is useful for comparison because direct audio-to-audio translation may preserve cues that plain transcripts do not.

However:

- do not use it as the primary causal pipeline;
- treat it as a black-box output condition;
- store it separately;
- do not infer where internal losses happened.

---

# 25. Current default OpenAI adapters

Model identifiers must be admin-configurable.

Suggested current defaults at the time this specification was written:

```text
ASR:
gpt-transcribe

Text translation:
gpt-5.6-sol

TTS:
gpt-4o-mini-tts

Optional future black-box:
gpt-realtime-translate
```

Do not scatter these strings throughout components.

Centralize provider/model configuration.

Every model call must record the exact requested and returned model identifiers where available.

If aliases are used, record the alias plus any returned resolved model/version metadata.

---

# 26. OpenAI API key handling

Permanent API credentials remain server-side.

Never expose the permanent OpenAI API key to browser JavaScript.

Use environment configuration such as:

```text
OPENAI_API_KEY=...
```

For future browser realtime functionality, use short-lived/ephemeral client credentials generated by the server rather than exposing the permanent key.

---

# 27. Model run provenance

Every AI operation gets a `model_run` record.

Required fields:

```text
id
stage
provider
requested_model
returned_model
prompt_version_id nullable
processing_batch_id nullable
source_entity_type
source_entity_id
parameters_json
input_manifest_json
provider_request_id nullable
status
started_at
finished_at
latency_ms
usage_json nullable
estimated_cost nullable
response_metadata_json nullable
error_code nullable
error_message nullable
app_version
git_commit_sha nullable
```

Potential stages:

```text
asr
translation
tts
realtime_translation
automatic_metric
other
```

`input_manifest_json` should identify inputs by IDs/hashes rather than unnecessarily duplicating all source data.

Preserve exact observable API responses needed for reproducibility, but do not attempt to store or reconstruct hidden model reasoning.

---

# 28. Processing batches

The same corpus may be reprocessed under new model/prompt conditions.

Implement `processing_batches`.

Example:

```text
Batch:
2026-10-pilot-openai-v1

ASR config:
gpt-transcribe + ASR prompt v1

Translation configs:
default v1
preserve v3

TTS config:
tts baseline v2
```

Fields:

```text
id
name
description
status
created_at
started_at
completed_at
configuration_snapshot_json
created_by_label
```

Statuses:

```text
draft
queued
running
completed
completed_with_errors
cancelled
```

A batch must not mutate outputs from an earlier batch.

---

# 29. Job queue

Research collection must not depend on synchronous AI success.

Source audio collection is the priority.

If OpenAI is temporarily unavailable:

- participant can still submit recording;
- participant continues study;
- processing job becomes queued/failed;
- researcher retries later.

Use a PostgreSQL-backed job system.

A minimal custom queue is acceptable:

```text
jobs
    id
    type
    payload_json
    status
    attempts
    max_attempts
    available_at
    locked_at
    locked_by
    last_error
    created_at
    updated_at
```

Worker should use transaction-safe locking, e.g. `FOR UPDATE SKIP LOCKED`.

Alternative established PostgreSQL-backed worker packages may be used if they remain simple and reliable.

Do not introduce Redis unless there is a real need.

---

# 30. Idempotency

Background tasks must be idempotent.

For example:

If the same:

```text
utterance
+
transcript revision
+
translation condition
+
prompt version
+
model configuration
+
processing batch
```

is submitted twice because of retry, the worker must not silently create uncontrolled duplicate outputs.

Use an idempotency key or unique constraint.

Retries should be explicit and visible.

---

# 31. Audio capture strategy

Audio is scientifically important.

Use a two-tier capture system.

---

## 31.1 Research recorder

Preferred:

- `getUserMedia`;
- AudioWorklet or equivalent PCM capture;
- mono;
- lossless PCM WAV;
- preferably around 48 kHz if the actual environment supports it;
- at least 16-bit PCM output;
- no intentional browser enhancement where constraints are supported.

Request:

```text
channelCount: 1
echoCancellation: false
noiseSuppression: false
autoGainControl: false
```

Then record the **actual** settings returned by the browser/device.

Do not assume requested constraints were honored.

Do not pretend a file is natively 48 kHz if the real input path differed.

---

## 31.2 Demo/fallback recorder

MediaRecorder using supported browser format, typically WebM/Opus, is acceptable for Demo Mode and fallback.

Store the raw upload.

If a canonical WAV is derived server-side, preserve both:

- raw captured file;
- derived WAV;
- transformation provenance.

Fallback recordings should be marked:

```text
capture_quality_class = "compressed_fallback"
```

so they can be excluded from strict acoustic analyses if necessary.

---

# 32. Audio metadata

Each source media asset should store, where known:

```text
mime_type
container
codec
duration_ms
sample_rate_hz
channels
bit_depth
size_bytes
sha256
capture_method
capture_quality_class
requested_constraints_json
actual_track_settings_json
browser_user_agent
created_at
```

Avoid redundant personal metadata in media records.

---

# 33. File hashing

Compute SHA-256 for every persisted media file.

Uses:

- integrity checking;
- duplicate detection;
- provenance;
- export manifest validation.

Do not use filename alone as file identity.

---

# 34. Media storage architecture

Audio must **not** be stored as PostgreSQL `bytea`/blob for this project.

Create:

```ts
interface StorageAdapter {
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<ReadableStream | NodeJS.ReadableStream>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSignedDownloadUrl?(key: string, ttlSeconds: number): Promise<string>;
}
```

Implement at least:

1. `LocalFilesystemStorage`
2. `S3CompatibleStorage`

---

# 35. Local development storage

For development/seminar laptop:

```text
./data/media/
```

or configurable absolute path.

Never place participant audio inside Next.js `/public`.

All media downloads must pass through access-controlled server routes.

---

# 36. Production storage

Use a university-approved/private object store or private persistent storage.

S3-compatible storage is preferred for portability.

Objects must not be public.

Admin playback/download should use authenticated streaming endpoints or short-lived signed URLs.

Do not include participant names in object keys.

Example key:

```text
studies/{study-id}/sessions/{session-uuid}/utterances/{utterance-uuid}/source/{asset-uuid}.wav
```

TTS:

```text
studies/{study-id}/translations/{translation-uuid}/tts/{synthesis-uuid}.wav
```

---

# 37. Core database schema

The names below are recommended. Adjust implementation details only with clear reason.

Use PostgreSQL UUID primary keys internally.

---

## 37.1 `studies`

```text
id uuid pk
slug text unique
name text
status text
created_at timestamptz
updated_at timestamptz
```

Even if there is initially only one study, this provides a clean namespace.

---

## 37.2 `protocol_versions`

Represents the complete participant-facing study protocol.

```text
id uuid pk
study_id uuid fk
version_number integer
status enum(draft,published,retired)
name text
description text nullable
welcome_content text
information_content text
instruction_content text
debrief_content text
consent_version_id uuid
background_questionnaire_version_id uuid nullable
post_questionnaire_version_id uuid nullable
order_config_json jsonb
created_at timestamptz
published_at timestamptz nullable
retired_at timestamptz nullable
created_by_label text nullable
```

Unique:

```text
(study_id, version_number)
```

Published protocol versions are immutable.

To change a published protocol:

```text
Clone as draft -> modify -> publish as next version
```

---

## 37.3 `consent_versions`

```text
id uuid pk
study_id uuid fk
version_number integer
title text
information_text text
privacy_notice_url text nullable
items_json jsonb
created_at timestamptz
published_at timestamptz nullable
```

Each consent item should have stable IDs.

---

## 37.4 `protocol_tasks`

These are immutable within a published protocol.

```text
id uuid pk
protocol_version_id uuid fk
task_key text
task_type enum(controlled,semi_structured,free_speech)
title text
participant_prompt text
context_text text nullable
instructions_text text nullable
block_key text
order_index integer
order_mode enum(fixed,shuffle_within_block)
enabled boolean
min_duration_seconds integer nullable
suggested_duration_seconds integer nullable
max_duration_seconds integer nullable
privacy_reminder boolean
config_json jsonb
created_at timestamptz
```

---

## 37.5 `protocol_task_followups`

```text
id uuid pk
protocol_task_id uuid fk
followup_key text
prompt_text text
order_index integer
is_required boolean
enabled boolean
```

No LLM-generated dynamic follow-ups in Research Mode v1.

---

## 37.6 `sessions`

```text
id uuid pk
study_id uuid fk
participant_code text unique
protocol_version_id uuid fk
mode enum(research,demo,test)
status enum(
  created,
  consented,
  mic_check,
  recording,
  background_questionnaire,
  post_questionnaire,
  completed,
  withdrawn,
  abandoned
)
started_at timestamptz
consented_at timestamptz nullable
completed_at timestamptz nullable
withdrawn_at timestamptz nullable
last_activity_at timestamptz
browser_info_json jsonb nullable
audio_environment_json jsonb nullable
app_version text
git_commit_sha text nullable
flagged boolean default false
flag_notes text nullable
created_at timestamptz
updated_at timestamptz
```

---

## 37.7 `session_consents`

```text
id uuid pk
session_id uuid fk
consent_version_id uuid fk
responses_json jsonb
accepted_at timestamptz
```

Store exact consent choices.

---

## 37.8 `task_presentations`

Stores what the participant actually saw.

```text
id uuid pk
session_id uuid fk
protocol_task_id uuid fk
sequence_index integer
prompt_snapshot text
context_snapshot text nullable
started_at timestamptz nullable
completed_at timestamptz nullable
status enum(pending,started,completed,skipped)
randomization_metadata_json jsonb nullable
```

Even if protocol is immutable, keep snapshots for strong provenance.

---

## 37.9 `utterances`

```text
id uuid pk
session_id uuid fk
task_presentation_id uuid fk
followup_id uuid nullable
turn_index integer
attempt_count integer default 1
accepted_media_asset_id uuid nullable
submitted_at timestamptz nullable
duration_ms integer nullable
status enum(recording,uploading,submitted,invalid,excluded)
exclusion_reason text nullable
flagged boolean default false
flag_notes text nullable
created_at timestamptz
updated_at timestamptz
```

---

## 37.10 `media_assets`

```text
id uuid pk
study_id uuid fk
session_id uuid nullable fk
utterance_id uuid nullable fk
entity_type text
entity_id uuid nullable
kind enum(
  source_audio,
  source_audio_raw,
  source_audio_derived,
  tts_audio,
  realtime_translation_audio,
  export_archive,
  other
)
storage_driver text
storage_key text unique
mime_type text
container text nullable
codec text nullable
sample_rate_hz integer nullable
channels integer nullable
bit_depth integer nullable
duration_ms integer nullable
size_bytes bigint
sha256 text
capture_method text nullable
capture_quality_class text nullable
metadata_json jsonb
created_at timestamptz
deleted_at timestamptz nullable
```

---

## 37.11 `transcripts`

```text
id uuid pk
utterance_id uuid fk
type enum(asr,asr_corrected,human_dialect,normalized)
status enum(not_started,draft,needs_review,verified)
created_at timestamptz
updated_at timestamptz
```

Unique logical transcript per utterance/type.

---

## 37.12 `transcript_revisions`

```text
id uuid pk
transcript_id uuid fk
revision_number integer
text text
source_model_run_id uuid nullable
created_by_type enum(model,researcher,system)
created_by_label text nullable
change_reason text nullable
transcription_convention_version text nullable
is_current boolean
created_at timestamptz
verified_at timestamptz nullable
```

Unique:

```text
(transcript_id, revision_number)
```

Only one current revision per transcript.

---

## 37.13 `ai_prompt_versions`

```text
id uuid pk
study_id uuid fk
key text
stage enum(asr,translation,tts,realtime_translation)
condition_key text nullable
version_number integer
status enum(draft,active,retired)
name text
prompt_text text
notes text nullable
created_at timestamptz
activated_at timestamptz nullable
created_by_label text nullable
```

Examples:

```text
key=translation_default
condition_key=default

key=translation_preserve
condition_key=preservation
```

Do not overwrite active prompt history.

---

## 37.14 `model_configs`

```text
id uuid pk
study_id uuid fk
key text
stage enum(asr,translation,tts,realtime_translation)
version_number integer
status enum(draft,active,retired)
provider text
model_id text
parameters_json jsonb
prompt_version_id uuid nullable
created_at timestamptz
activated_at timestamptz nullable
```

Example:

```text
translation_default_v1
translation_preserve_v1
tts_baseline_v1
```

---

## 37.15 `processing_batches`

As defined earlier.

---

## 37.16 `model_runs`

As defined earlier.

Add an `idempotency_key` unique index.

---

## 37.17 `translations`

```text
id uuid pk
source_transcript_revision_id uuid fk
condition_key text
processing_batch_id uuid fk
model_run_id uuid fk
translated_text text
target_language text default 'en'
status enum(generated,reviewed,excluded)
created_at timestamptz
```

Never assume only one translation per source transcript.

---

## 37.18 `syntheses`

```text
id uuid pk
translation_id uuid nullable fk
source_text text
condition_key text
processing_batch_id uuid fk
model_run_id uuid fk
media_asset_id uuid fk
voice_key text
status enum(generated,reviewed,excluded)
created_at timestamptz
```

`source_text` snapshot ensures the exact text synthesized is always recoverable.

---

## 37.19 `difference_annotations`

Initial flexible schema:

```text
id uuid pk
utterance_id uuid fk
source_transcript_revision_id uuid nullable
target_transcript_revision_id uuid nullable
annotation_scope enum(utterance,span)
source_start integer nullable
source_end integer nullable
target_start integer nullable
target_end integer nullable
categories_json jsonb
notes text nullable
annotator_label text
scheme_version text
created_at timestamptz
```

---

## 37.20 `feature_annotations`

Future-proof table:

```text
id uuid pk
target_type text
target_id uuid
feature_family text
feature_key text
source_span_json jsonb nullable
target_span_json jsonb nullable
label text
function_label text nullable
confidence numeric nullable
notes text nullable
annotator_label text
scheme_version text
created_at timestamptz
```

---

## 37.21 `questionnaire_versions`

```text
id uuid pk
study_id uuid fk
key text
version_number integer
status enum(draft,published,retired)
name text
description text nullable
created_at timestamptz
published_at timestamptz nullable
```

---

## 37.22 `questionnaire_items`

```text
id uuid pk
questionnaire_version_id uuid fk
item_key text
type enum(
  likert,
  single_choice,
  multi_choice,
  free_text,
  integer,
  short_text,
  boolean
)
prompt text
help_text text nullable
required boolean
order_index integer
config_json jsonb
```

---

## 37.23 `questionnaire_responses`

```text
id uuid pk
session_id uuid fk
questionnaire_version_id uuid fk
submitted_at timestamptz
```

---

## 37.24 `questionnaire_answers`

```text
id uuid pk
response_id uuid fk
questionnaire_item_id uuid fk
value_json jsonb
```

---

## 37.25 `research_flags`

Optional generic flag table rather than only booleans:

```text
id uuid pk
entity_type text
entity_id uuid
reason_code text nullable
notes text nullable
created_by_label text nullable
created_at timestamptz
resolved_at timestamptz nullable
```

Potential reasons:

```text
contains_third_party_identifier
poor_audio
asr_problem
interesting_dialect_feature
translation_problem
tts_problem
needs_expert_review
other
```

---

## 37.26 `admin_audit_log`

```text
id uuid pk
action text
entity_type text
entity_id uuid nullable
before_json jsonb nullable
after_json jsonb nullable
actor_label text nullable
created_at timestamptz
```

Important actions:

- publish protocol;
- modify draft;
- verify transcript;
- revise verified transcript;
- activate prompt/model config;
- delete media;
- exclude utterance;
- launch processing batch;
- export data;
- reset test data.

---

## 37.27 `jobs`

As described in the queue section.

---

# 38. Referential and deletion rules

Use explicit foreign-key behavior.

Avoid casual cascade deletion of scientific data.

Examples:

- deleting a draft protocol can cascade to its unpublished tasks;
- a published protocol referenced by sessions cannot be deleted;
- sessions containing research data should not be deleted by ordinary UI;
- media deletion requires explicit workflow and audit trail;
- TEST data reset may be a separate guarded operation.

Any destructive admin action must require confirmation.

For highly destructive operations, require typing a confirmation phrase.

---

# 39. Admin authentication

There are no general application users.

There is one researcher/admin access boundary.

Improve on the older project's sessionStorage password pattern.

Recommended:

- admin login page;
- password secret stored server-side;
- password verified server-side;
- issue signed HttpOnly cookie;
- `Secure` in production;
- `SameSite=Strict` or equivalent appropriate setting;
- short but usable admin session lifetime;
- logout invalidates cookie;
- rate-limit failed attempts.

No participant login.

No participant password.

No public admin API access.

---

# 40. Admin navigation

Final recommended sidebar:

```text
Dashboard
Sessions
Review & Transcription
Study Flow
AI Pipeline
Processing Runs
Questionnaires
Data & Export
Settings

Sign out
```

No Users page.

No Teams page.

No Roles page.

---

# 41. Admin design language

Use `manipulative-ai` as the visual inspiration:

- fixed left sidebar;
- neutral slate/gray navigation;
- white content surfaces;
- restrained university/research-tool aesthetic;
- blue reserved for primary interactive state;
- clear badges;
- compact data tables;
- strong readable typography;
- excellent keyboard/focus accessibility;
- no unnecessary gradients or startup-dashboard decoration.

Desktop-first is acceptable because admin is primarily used by researchers on laptops/desktops.

Participant pages must be responsive.

---

# 42. Dashboard

Dashboard shows **operational study health**, not experimental outcome significance.

Primary cards:

```text
Participants started
Participants completed
Completion rate
Sessions today
Utterances submitted
Total source audio duration
Awaiting transcription review
Processing errors
Flagged sessions/utterances
```

Status area:

```text
Study: ACTIVE / PAUSED
Published participant protocol: vX
Current ASR config: ...
Current translation configs: ...
Current TTS config: ...
Worker: healthy/unhealthy
Storage: healthy/unhealthy
Database: healthy/unhealthy
```

Recent activity:

- recent completed sessions;
- recent processing errors;
- recent transcript verification;
- recent processing batches.

Do **not** default to showing effect sizes such as:

> preservation condition +12.3%

during ongoing collection.

Operational dashboards reduce the risk of researchers informally optional-stopping or changing the protocol based on emerging outcomes.

Outcome analysis belongs in exported analysis workflows.

---

# 43. Sessions list

Columns:

```text
Participant code
Started
Protocol
Mode
Status
Tasks completed
Utterances
Audio duration
Review status
Flags
```

Filters:

- date;
- protocol version;
- research/demo/test;
- completed/incomplete;
- flagged;
- has processing errors;
- review complete/incomplete.

Search by:

- participant code;
- session UUID.

Default sorting:

```text
started_at DESC
```

Demo/test sessions visually obvious.

---

# 44. Session detail

This is the central researcher view.

Header:

```text
P-7K4M9Q
RESEARCH
Completed
Protocol v1.2
Started ...
Completed ...
```

Actions:

```text
Flag session
Download session package
Exclude session from analysis
View audit history
```

Sections:

1. Consent summary
2. Technical capture metadata
3. Task sequence
4. Utterances
5. Background questionnaire
6. Post-recording questionnaire
7. Flags/notes
8. Processing history

---

# 45. Utterance detail inside session

Display:

```text
TASK 2 - CONTROLLED

Exact prompt shown:
"..."

Attempt count: 2

SOURCE AUDIO
[playback]
[download WAV]

Capture:
48kHz | mono | PCM | ...
```

Then:

```text
A - ASR
[immutable text]

A* - ASR corrected
[text or not created]

B - HUMAN DIALECT TRANSCRIPT
[current verified text]

C - NORMALIZED FINNISH
[current verified text]
```

Then translations grouped by batch:

```text
PROCESSING BATCH: pilot-v1

                DEFAULT             PRESERVATION
A               text                text
                play TTS            play TTS

B               text                text
                play TTS            play TTS

C               text                text
                play TTS            play TTS
```

Each cell should allow:

- view full provenance;
- view model/prompt version;
- download text/audio;
- flag output;
- open annotation later.

---

# 46. Review & Transcription page

This must be optimized for repetitive researcher work.

Queue filters:

- unreviewed;
- B missing;
- C missing;
- A* missing;
- needs second review;
- flagged;
- task type;
- protocol;
- region after background metadata exists.

Review screen:

```text
P-... / U-...
Task: controlled

[Audio player]

ASR A
(read-only)

A* ASR corrected
[editable]

B Human dialect-preserving
[editable]

C Normalized Finnish
[editable]

Difference coding
[checkboxes / tags]

Notes
[...]

[Save draft]
[Mark verified]
[Save & next]
```

Useful shortcuts:

- Space: play/pause if focus context permits;
- Ctrl/Cmd+S: save;
- next/previous utterance.

Do not over-engineer waveform annotation in v1.

Standard HTML audio with precise seeking is enough initially.

---

# 47. Study Flow page

This controls participant-facing study structure.

Top:

```text
Published: Protocol v1.3
Draft: Protocol v1.4

[Preview participant study]
[Clone published version to new draft]
[Publish draft]
```

A published protocol is read-only.

Draft editor allows:

- welcome text;
- participant information text;
- consent version selection;
- study instructions;
- task blocks;
- background questionnaire selection;
- post-recording questionnaire selection;
- debrief text.

---

# 48. Study Flow task editor

Visual ordered list:

```text
1  Controlled        Enabled
   "Imagine that ..."

2  Controlled        Enabled
   "Explain ..."

3  Semi-structured   Enabled
   "Tell us about ..."

4  Free speech       Enabled
   "Speak naturally ..."
```

Actions:

- edit;
- clone;
- disable;
- delete draft task;
- reorder via buttons or drag/drop;
- add follow-up;
- preview.

Avoid accidental drag/drop-only accessibility; provide move up/down controls too.

Fields:

```text
Internal name
Participant-facing title
Type
Prompt
Context
Instructions
Suggested duration
Max duration
Block
Order mode
Privacy reminder
Enabled
Researcher notes
```

---

# 49. Publishing a protocol

Publishing should:

1. validate required content;
2. validate consent selection;
3. validate referenced questionnaire versions are published;
4. validate at least one enabled task;
5. create immutable published version;
6. record audit log;
7. set as current protocol for **new sessions only**.

Existing sessions remain pinned to their original protocol.

Display a diff between previous published and new draft before publication.

---

# 50. AI Pipeline admin

Sections:

## ASR

```text
Provider
Model
Language hint
Context/prompt
Parameters
Prompt version
Config version
```

## Translation - Default

```text
Provider
Model
System/developer instruction
Parameters
Prompt version
Config version
```

## Translation - Preservation

same fields.

## TTS - Baseline

```text
Provider
Model
Voice
Instructions
Output format
Parameters
Config version
```

## Optional experimental conditions

Not enabled by default.

---

# 51. AI prompt/config workflow

Like participant protocols:

- draft;
- activate;
- retire.

Active config changes do not mutate old model runs.

Provide:

```text
[Save draft]
[Activate]
[Clone]
[Compare versions]
```

When processing a batch, configuration is snapshotted into the batch.

---

# 52. Test pipeline

Admin must include a practical smoke test.

Button:

```text
Run pipeline test
```

Workflow:

```text
record short admin test audio
    ->
ASR
    ->
default translation
    ->
preserve translation
    ->
TTS
```

Display:

```text
ASR               PASS / FAIL
Default translation PASS / FAIL
Preserve translation PASS / FAIL
TTS                PASS / FAIL
Storage             PASS / FAIL
```

All generated data is mode `test`.

Never include it in research exports unless `include_test=true`.

---

# 53. Processing Runs admin

Purpose: manage offline computational experiment.

List:

```text
Name
Created
Status
Utterances
Jobs
Succeeded
Failed
ASR config
Translation configs
TTS config
```

Create batch wizard:

1. select corpus subset;
2. select transcript types;
3. select ASR if needed;
4. select translation conditions;
5. select TTS conditions;
6. review estimated workload;
7. create batch;
8. run.

Filters can include:

- protocol version;
- completed sessions only;
- verified transcripts only;
- selected task types;
- research mode only;
- date range.

Default:

```text
research mode
completed sessions
exclude flagged/excluded
```

---

# 54. Batch immutability

After a batch starts:

- configuration cannot change;
- create another batch for changed settings.

A cancelled batch remains visible for provenance.

Individual failed jobs can be retried under the same frozen config.

---

# 55. Questionnaires admin

Separate admin page because questionnaires are research instruments, not AI prompts.

List:

```text
background-v1
post-recording-v1
future-source-speaker-evaluation-v1
```

Questionnaire editor supports:

- Likert;
- radio;
- checkboxes;
- free text;
- number;
- short text;
- yes/no.

Fields:

```text
item key
prompt
help text
required
response type
options
scale min/max
scale labels
order
```

Published questionnaire versions immutable.

Preview mode required.

---

# 56. Data & Export page

Data export is a first-class scientific requirement.

Sections:

## Structured data

Buttons:

```text
Participants / session metadata CSV
Sessions CSV
Tasks presented CSV
Utterances CSV
Transcripts CSV
Translations CSV
Syntheses CSV
Questionnaire responses CSV
Annotations CSV
Model runs JSON
Audit/provenance JSON
```

Prefer flat CSVs for analysis and JSON for nested provenance.

---

## Audio

```text
Download source recordings ZIP
Download generated TTS ZIP
Download selected session audio
```

For large exports, create async export jobs rather than holding one HTTP request indefinitely.

---

## Full dataset package

```text
[Create research dataset package]
```

Example:

```text
dataset-2026-10-01/
├── README.md
├── MANIFEST.json
├── data_dictionary.md
├── sessions.csv
├── task_presentations.csv
├── utterances.csv
├── transcripts.csv
├── translations.csv
├── syntheses.csv
├── questionnaire_responses.csv
├── annotations.csv
├── model_runs.jsonl
├── protocol_versions/
│   └── ...
├── prompts/
│   └── ...
├── source_audio/
│   └── ...
└── generated_audio/
    └── ...
```

The export manifest includes:

- generated_at;
- export filters;
- study version;
- file hashes;
- included protocol versions;
- included model configurations;
- application git commit if available.

---

# 57. Export filters

Support:

```text
date range
protocol version
mode
completed only
task type
verified transcripts only
flagged/excluded inclusion
processing batch
participant region
```

`include_test` default must be **false**.

Excluded/withdrawn records should follow the approved study policy, not arbitrary UI logic.

---

# 58. Data dictionary

Generate or maintain a human-readable data dictionary.

For every exported field document:

- field name;
- type;
- description;
- allowed values;
- missing-value semantics;
- source;
- whether potentially identifying.

This is valuable both for collaborators and future dataset release.

---

# 59. Settings page

Keep technical configuration separate from scientific protocol editing.

Sections:

## Study operational state

```text
Study active
Allow new sessions
Maintenance message
```

## Database

```text
Connected / error
Migration status
```

## Media storage

```text
Driver
Bucket/path
Connectivity
Free space or basic status where available
```

## OpenAI/provider connectivity

```text
Configured
Last test
```

Do not display full API key.

## Application

```text
app version
git commit
environment
worker status
```

## Limits

```text
maximum upload size
maximum utterance duration
session inactivity timeout
```

---

# 60. Public API / server endpoints

Exact Next.js route structure can vary, but domain API should roughly support:

---

## Participant

```text
POST   /api/study/sessions
GET    /api/study/session
POST   /api/study/consent
GET    /api/study/next-task
POST   /api/study/tasks/:presentationId/start
POST   /api/study/utterances
POST   /api/study/utterances/:id/audio
POST   /api/study/utterances/:id/submit
POST   /api/study/questionnaires/:key
POST   /api/study/session/complete
POST   /api/study/session/withdraw
```

Use server-side session token/cookie.

Do not expose arbitrary session IDs without authorization checks.

---

## Admin

```text
POST   /api/admin/login
POST   /api/admin/logout

GET    /api/admin/dashboard

GET    /api/admin/sessions
GET    /api/admin/sessions/:id
PATCH  /api/admin/sessions/:id/flag

GET    /api/admin/review/queue
GET    /api/admin/utterances/:id
POST   /api/admin/transcripts/:id/revisions
POST   /api/admin/transcripts/:id/verify

GET    /api/admin/protocols
POST   /api/admin/protocols
POST   /api/admin/protocols/:id/clone
PUT    /api/admin/protocols/:id
POST   /api/admin/protocols/:id/publish

GET    /api/admin/ai/prompts
POST   /api/admin/ai/prompts
PUT    /api/admin/ai/prompts/:id
POST   /api/admin/ai/prompts/:id/activate

GET    /api/admin/ai/configs
POST   /api/admin/ai/configs
POST   /api/admin/ai/test

GET    /api/admin/processing
POST   /api/admin/processing
POST   /api/admin/processing/:id/start
POST   /api/admin/processing/:id/retry-failed
POST   /api/admin/processing/:id/cancel

GET    /api/admin/questionnaires
POST   /api/admin/questionnaires
PUT    /api/admin/questionnaires/:id
POST   /api/admin/questionnaires/:id/publish

GET    /api/admin/export
POST   /api/admin/export/jobs
GET    /api/admin/export/jobs/:id

GET    /api/admin/media/:id
GET    /api/admin/media/:id/download
```

Use validation for every request.

Recommended: Zod schemas shared between client and server.

---

# 61. Participant session resilience

The study should survive accidental refresh.

Store a short-lived opaque session token in a secure cookie.

On reload:

- recover current session;
- recover current study state;
- resume current unsubmitted task safely;
- never re-display consent as accepted if it was not saved.

Do not put sensitive study state into query-string URLs.

---

# 62. Upload reliability

Audio upload sequence:

1. client stops recording;
2. candidate remains locally available;
3. participant chooses Submit;
4. server streams file to storage;
5. server computes SHA-256 and validates media;
6. database media record is committed;
7. utterance links accepted media;
8. API returns success;
9. browser releases candidate blob;
10. participant advances.

Do not advance before the server confirms durable storage.

On upload failure:

- keep candidate recording in browser memory;
- show Retry;
- do not ask participant to re-record unnecessarily.

---

# 63. Validation of uploaded media

Server validates:

- allowed MIME/container;
- maximum size;
- non-zero duration;
- duration <= configured maximum;
- media parsable;
- audio track exists.

Use FFmpeg/ffprobe server-side where helpful.

Do not trust browser-provided duration or MIME alone.

---

# 64. Canonical audio derivation

If input is compressed:

```text
raw source asset
    ->
derived canonical WAV
```

Store both.

Derived asset metadata should include:

```text
derived_from_media_asset_id
tool
tool_version
command/settings
created_at
```

Do not silently replace source recording.

---

# 65. Privacy boundaries

The AI provider should receive the minimum input needed.

ASR:

```text
audio
language/context instructions
```

Translation:

```text
transcript
translation instruction
```

TTS:

```text
translated text
voice/synthesis instruction
```

Do not send unnecessary:

- participant code;
- name;
- region;
- age;
- questionnaire answers;
- email;
- session metadata.

---

# 66. Third-party personal data

Free speech may contain third-party names or identifiers.

Participant UI reminds users to avoid unnecessary identifying information.

Admin supports flag:

```text
contains_third_party_identifier
```

Researcher can:

- exclude;
- redact derivative transcript;
- restrict export;
- follow study-specific data management policy.

Do not implement automatic destructive redaction of source audio without keeping provenance and without an approved policy.

---

# 67. Security requirements

At minimum:

- HTTPS in production;
- server-side secrets only;
- private media storage;
- authenticated admin media access;
- input validation;
- upload limits;
- database parameterization through ORM;
- rate limiting on session creation/login;
- secure cookies;
- no secrets in logs;
- `.env` excluded from Git;
- no participant audio committed to repository;
- no research exports exposed under `/public`.

Admin API responses containing transcripts/audio metadata must set appropriate no-cache/private behavior.

---

# 68. Logging

Application logs should include:

- request ID;
- route;
- status;
- processing job ID;
- model run ID;
- non-sensitive error information.

Do not log full participant transcripts or audio contents by default.

Do not log OpenAI API key.

Do not log consent form answers beyond necessary audit events.

---

# 69. Error model

Define user-safe error categories.

Participant examples:

```text
MICROPHONE_PERMISSION_DENIED
RECORDING_FAILED
UPLOAD_FAILED
SESSION_EXPIRED
STUDY_CLOSED
```

Admin/worker examples:

```text
ASR_PROVIDER_ERROR
TRANSLATION_PROVIDER_ERROR
TTS_PROVIDER_ERROR
MEDIA_NOT_FOUND
INVALID_AUDIO
DATABASE_ERROR
STORAGE_ERROR
```

Persist worker failures in jobs/model_runs.

Participant should not see provider stack traces.

---

# 70. Research exclusion versus deletion

Important distinction:

`excluded = true` means:

> retained according to study policy but excluded from analysis.

`deleted` means data removed according to an approved deletion workflow.

Do not implement analysis exclusion by deleting source data.

Use:

```text
utterance.status = excluded
exclusion_reason
```

or generic exclusion records.

---

# 71. Flagging

Session and utterance flags inspired by `manipulative-ai`.

Examples:

```text
Flag for review
Notes
```

Badges:

```text
FLAGGED
TEST
DEMO
INCOMPLETE
PROCESSING ERROR
NEEDS REVIEW
VERIFIED
EXCLUDED
```

Flags are not exclusions by default.

---

# 72. Annotation framework support

The application does not need to implement the full final annotation framework in v1, but schema and export must support it.

Likely future dimensions:

- dialect marker retention;
- lexical choice;
- morphological distinction;
- syntactic distinction;
- pragmatic function;
- discourse particle;
- register;
- idiom;
- politeness;
- stance;
- humour;
- emotion;
- rhythm;
- intonation;
- pauses;
- speaking rate;
- accent;
- perceived regional identity;
- authenticity;
- naturalness;
- semantic fidelity.

Avoid a single universal `dialect_score`.

---

# 73. Automatic analysis support

Do not make automatic metrics the primary truth source.

However, exported data and future analysis services can support:

- WER;
- CER;
- WER against dialect-preserving reference;
- WER against normalized reference;
- lexical diversity measures;
- COMET-style translation quality metrics;
- acoustic descriptors;
- speaking rate;
- pause statistics;
- pitch features.

Keep these outside the participant flow.

Do not automatically overwrite human annotations with metric results.

---

# 74. Future human evaluation architecture

Not required for initial deployment, but design should permit:

```text
evaluation_studies
evaluation_sessions
evaluation_trials
ratings
```

Evaluator groups may include:

- source speakers;
- Finnish-English bilingual experts;
- English-speaking target listeners;
- relevant Finnish regional/community listeners.

Do not reuse `participants` assumptions that all evaluators are original speakers.

---

# 75. Future evaluation presentation rules

When later implemented:

- randomize output order;
- blind experimental condition labels;
- avoid showing multiple versions of the same utterance consecutively when possible;
- counterbalance;
- track exact stimulus;
- track listener group;
- track playback completion;
- store rating-scale version.

---

# 76. Protocol versioning model

This is non-negotiable.

Do not edit published protocol in place.

Workflow:

```text
Published v1.0
    ->
Clone
    ->
Draft v1.1
    ->
Edit
    ->
Preview
    ->
Publish
```

Existing sessions remain v1.0.

New sessions use v1.1.

The same principle applies to:

- consent;
- questionnaires;
- AI prompts;
- model configurations;
- transcription convention;
- annotation scheme.

---

# 77. Exact snapshot requirements

Every session or derived output should remain interpretable even if admin configuration later changes.

Therefore store:

- protocol version ID;
- exact prompt shown;
- questionnaire version;
- consent version;
- AI prompt version;
- model config version;
- model run metadata;
- media hash;
- application version.

---

# 78. Data modes

Every session/data unit must distinguish:

```text
research
demo
test
```

Recommended rules:

## research

Eligible for research export, subject to completion/exclusion policy.

## demo

Seminar/public demonstration. Excluded by default.

## test

Developer/admin smoke testing. Excluded by default.

Never infer mode based only on URL after data are stored.

Store it explicitly.

---

# 79. Research Mode processing behavior

Recommended:

Immediately after source upload:

```text
queue optional ASR job
```

but do not wait for ASR before letting participant proceed.

After session:

```text
ASR may complete
```

Human B/C later.

Only after verified B/C should the main translation experiment batch normally run.

This prevents low-quality automatic intermediate states from being accidentally treated as final references.

---

# 80. Demo Mode behavior

Demo Mode can synchronously or near-synchronously perform:

```text
source audio
    ->
ASR
    ->
default translation
    ->
preservation translation
    ->
TTS
```

Demo UI may show a two-column comparison.

Save everything with `mode=demo`.

Allow a "do not persist this demo" admin configuration if desired.

---

# 81. Seminar/demo page concept

Possible layout:

```text
Original Finnish

[record]

[play source]

ASR:
...

+----------------------+----------------------+
| Default translation  | Preserve variation   |
| ...                  | ...                  |
| [play]               | [play]               |
+----------------------+----------------------+
```

Optionally reveal:

```text
source -> ASR -> translation -> TTS
```

This is pedagogical, not the main research interface.

---

# 82. No dynamic AI conversation in Research Mode v1

This is explicit.

Do not build:

```text
participant speaks
AI asks spontaneous follow-up
participant responds
AI asks another follow-up
```

for the first research protocol.

It makes participant exposure non-comparable and can alter speech.

Semi-structured research conversation uses predefined follow-ups.

A dynamic conversational arm can become a separate future experiment.

---

# 83. No dialect classification feedback to participant

Do not show:

> "We detected you are Savonian."

This can:

- be wrong;
- prime later speech;
- reinforce stereotypes;
- confuse region and speaker identity.

Dialect classification can be an offline analytical tool later.

---

# 84. Data quality indicators

Admin can show non-outcome quality indicators:

- missing source audio;
- audio too short;
- possible clipping;
- low signal;
- ASR failed;
- missing B/C transcript;
- missing questionnaire;
- processing incomplete.

Do not automatically exclude based on simplistic thresholds.

Flag for researcher review.

---

# 85. Audio clipping/basic checks

Optional lightweight checks:

- peak amplitude;
- duration;
- silence ratio;
- file corruption.

Store calculated values if used.

Do not automatically apply normalization/noise reduction to the master audio.

Derived cleaned audio, if ever used, must be a separate media asset.

---

# 86. Participant withdrawal/stop interaction

At all recording pages, provide a discreet but accessible:

```text
End participation
```

Behavior should be study-policy configurable.

At minimum:

- stop current recording;
- do not upload unfinished candidate;
- mark session withdrawn/abandoned as appropriate;
- show debrief/contact information.

Do not invent post-study legal deletion semantics in code; expose an admin workflow consistent with the final privacy notice.

---

# 87. Study pause

Admin can set:

```text
allow_new_sessions = false
```

Public page then shows:

> This study is not currently accepting new participants.

Existing active sessions should be allowed to finish unless admin intentionally invokes maintenance mode.

---

# 88. Researcher notes

Allow notes at:

- session;
- utterance;
- transcript;
- processing output;
- annotation.

Notes are internal and excluded from normal participant-facing views.

Include them in researcher export only when requested.

---

# 89. Data export privacy tiers

Prepare for at least:

```text
internal_full
analysis_pseudonymous
collaboration_restricted
public_release
```

Do not implement public-release export automatically until policies are defined.

Internal full can contain media.

Analysis pseudonymous removes direct administrative metadata.

Public release may require manual review/redaction/consent filtering.

---

# 90. Testing strategy

Use automated tests for scientific invariants, not just UI.

---

## 90.1 Unit tests

Examples:

- protocol cannot be edited after publication;
- session pins protocol version;
- prompt activation creates no mutation of old run provenance;
- research export excludes demo/test by default;
- accepted utterance has at most one accepted source asset;
- hash calculation stable;
- job idempotency;
- re-record cleanup;
- current transcript revision uniqueness.

---

## 90.2 Integration tests

Examples:

1. create research session;
2. accept consent;
3. receive task;
4. upload source audio;
5. submit utterance;
6. complete study;
7. ASR job runs;
8. admin reviews B/C;
9. processing batch runs;
10. translations/TTS stored;
11. export includes correct relationships.

---

## 90.3 E2E tests

Use Playwright or equivalent.

Participant:

- consent;
- mock microphone;
- task navigation;
- upload retry;
- questionnaire;
- completion.

Admin:

- login;
- inspect session;
- edit draft protocol;
- publish;
- review transcript;
- create processing batch;
- export.

---

## 90.4 Migration tests

Every Drizzle migration must be testable on:

- empty database;
- representative database with existing study data.

Never use destructive `push` behavior against production research DB without explicit review.

Use generated SQL migrations committed to repository.

---

# 91. Seed data

Development seed should create:

- one study;
- one draft and one published protocol;
- one consent version;
- controlled/semi/free example tasks;
- background questionnaire;
- post questionnaire;
- default/preserve AI prompts;
- default model configs;
- sample TEST sessions only.

Never ship real participant data in seed files.

---

# 92. Sample initial study flow seed

This is placeholder content only.

## Controlled 1

```text
Imagine an English-speaking friend has invited you somewhere this weekend.
Respond naturally in Finnish and explain that you are unsure whether you want to go.
```

## Controlled 2

```text
Imagine you need to tell an English-speaking person that something did not happen
the way you expected. Explain what happened naturally in Finnish.
```

## Semi-structured 1

```text
Tell us about the place where you grew up and what makes it distinctive.
```

Follow-up placeholder:

```text
Is there anything distinctive about how people speak there?
```

## Semi-structured 2

```text
Tell us about a situation where you had to disagree with someone politely.
```

## Free

```text
Speak naturally in Finnish about anything you would like to communicate
to an English-speaking person. Aim for about one to two minutes.
Please avoid using real people's full names or unnecessary identifying information.
```

Researchers must replace/finalize these before real data collection.

---

# 93. Initial translation prompt seeds

## Default

```text
Translate the following Finnish utterance into natural spoken English.
Preserve its meaning.
Return only the translation.
```

## Preservation

```text
Translate the following Finnish utterance into natural spoken English.

Preserve propositional meaning and communicatively relevant differences
in register, informality, stance, politeness, discourse organization,
idiomatic force, humour, and emphasis where supported by the source.

Use natural English equivalents rather than copying Finnish forms.

Do not arbitrarily assign the speaker a named English regional dialect.
Do not add stereotypical dialect markers.
Do not invent information, emotion, emphasis, or social meaning that
is not supported by the source.

Return only the translation.
```

These are seeded as version 1 drafts/active configs according to environment.

---

# 94. Initial TTS seed

Use one fixed voice across main experimental translations.

Prompt/instruction concept:

```text
Speak the text naturally in conversational English.
Do not deliberately adopt a named regional dialect.
Do not add, omit, or paraphrase words.
```

Voice/model are configurable.

Store exact synthesis input text.

---

# 95. Environment variables

Create `.env.example`.

Suggested:

```bash
# App
NODE_ENV=development
APP_URL=http://localhost:3000
APP_VERSION=dev
GIT_COMMIT_SHA=

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dialect_study

# Admin auth
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=

# OpenAI
OPENAI_API_KEY=

# Storage
STORAGE_DRIVER=local
LOCAL_STORAGE_ROOT=./data/media

# Optional S3-compatible storage
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false

# Upload / audio
MAX_AUDIO_UPLOAD_MB=100
MAX_UTTERANCE_SECONDS=300

# Worker
WORKER_ID=worker-1
WORKER_POLL_INTERVAL_MS=2000
```

Do not commit real values.

---

# 96. Local developer environment

Provide Docker Compose:

```text
postgres
web
worker
```

Optionally local MinIO later.

For default local development:

- PostgreSQL in Docker;
- media on bind-mounted local directory;
- web/worker local or Docker.

Provide scripts:

```bash
pnpm dev
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm test
pnpm test:e2e
pnpm lint
pnpm typecheck
```

---

# 97. README requirements

Repository README must explain:

1. scientific purpose;
2. Research Mode versus Demo Mode;
3. architecture;
4. prerequisites;
5. environment setup;
6. database migration;
7. media storage;
8. OpenAI configuration;
9. running web + worker;
10. admin login;
11. creating/publishing protocol;
12. processing pipeline;
13. exports;
14. testing;
15. deployment notes;
16. privacy warning: never use real participant data in local dev casually.

---

# 98. Internal documentation

Create:

```text
docs/
├── RESEARCH-DESIGN.md
├── DATA-MODEL.md
├── PROTOCOL-VERSIONING.md
├── AUDIO-CAPTURE.md
├── AI-PROVENANCE.md
├── EXPORT-SCHEMA.md
├── ADMIN.md
├── PRIVACY-IMPLEMENTATION-NOTES.md
└── DEPLOYMENT.md
```

This implementation specification can seed these documents.

---

# 99. UI accessibility

Participant:

- large clear buttons;
- sufficient contrast;
- keyboard operability;
- status not indicated by color only;
- microphone state announced to assistive tech;
- labels for controls;
- error messages tied to fields;
- visible focus;
- no time pressure unless task protocol requires it.

Admin:

- WCAG-oriented table/navigation behavior;
- keyboard accessible dialogs;
- no drag-only reordering;
- semantic headings.

---

# 100. Localization

Initial participant UI may need Finnish and English.

Do not hard-code all strings in components.

Use simple localization dictionaries.

Study-content prompts themselves come from protocol configuration and may be Finnish/English as determined by researchers.

Admin can remain English initially.

---

# 101. Time and timestamps

Use UTC in PostgreSQL (`timestamptz`).

Display local timezone in admin, preferably configurable.

Exports should contain ISO 8601 timestamps.

Do not store ambiguous local timestamps.

---

# 102. Costs

Store provider usage metadata when available.

Optional dashboard operational metric:

```text
estimated API cost this processing batch
```

But do not let cost accounting contaminate scientific data.

Estimated cost must be labelled as estimate.

---

# 103. Model temperature/randomness

Do not assume deterministic LLM outputs.

Store all generation parameters.

If provider does not expose a relevant parameter, do not fabricate it.

For selected utterances, future processing may intentionally generate multiple repetitions to study stochastic variation.

Schema already supports multiple outputs through processing batches/runs.

---

# 104. OpenAI request abstraction

Do not call OpenAI SDK directly from UI components.

Use service layer:

```text
OpenAITranscriber
OpenAITranslator
OpenAISpeechSynthesizer
```

Provider classes return normalized internal result objects.

Example:

```ts
type TranslationResult = {
  text: string;
  requestedModel: string;
  returnedModel?: string;
  providerRequestId?: string;
  usage?: unknown;
  rawMetadata?: unknown;
};
```

This makes provider replacement/testing possible.

---

# 105. Prompt construction

Prompt builder should accept:

```text
prompt_version
source_text
source_language
target_language
```

Do not concatenate hidden participant metadata.

Store final effective instruction or sufficient immutable prompt-version reference plus source text revision ID so the run is reproducible.

---

# 106. Source/derived separation

Never blur:

```text
source recording
```

and:

```text
derived data
```

Source recording is immutable scientific evidence.

Derived:

- converted WAV;
- ASR;
- transcript revision;
- translation;
- synthesis;
- annotations.

Every derived record should identify its parent.

---

# 107. Participant progress model

Suggested public state machine:

```text
created
  ->
information
  ->
consent
  ->
mic_check
  ->
instructions
  ->
tasks
  ->
background
  ->
post_recording
  ->
debrief
  ->
completed
```

The server, not client alone, is authoritative.

Do not allow query manipulation to skip mandatory consent.

---

# 108. Session abandonment

If participant leaves:

- preserve only data that study policy allows;
- mark `abandoned` after configured timeout;
- do not call it completed;
- incomplete research exports are excluded by default but can be explicitly included.

Dashboard distinguishes:

- started;
- consented;
- completed;
- abandoned;
- withdrawn.

---

# 109. Data completeness checks

Session detail can compute:

```text
source_audio_complete
background_complete
post_questionnaire_complete
required_transcripts_complete
processing_complete
```

Use these to assist admin but keep raw source fields available.

---

# 110. Scientific invariants

Treat these as implementation rules.

1. **A published protocol never mutates.**
2. **A stored source recording never mutates.**
3. **A model output never mutates.**
4. **Human corrections create revisions.**
5. **Every derived output traces to a source and configuration.**
6. **TEST/DEMO data never enter research export by default.**
7. **A new model/prompt experiment creates a new processing run/batch.**
8. **Participant speech collection does not depend on AI availability.**
9. **Research Mode does not expose AI translation feedback during speech collection.**
10. **Audio is never publicly addressable.**
11. **No permanent provider key reaches browser code.**
12. **Admin can inspect exactly what happened to any utterance.**

Tests should enforce these where feasible.

---

# 111. Data lifecycle hooks

Implement interfaces/workflows for:

- soft exclusion;
- media deletion;
- session withdrawal marking;
- retention review;
- export restriction.

Do not automatically delete research data after an arbitrary period until final study policy is configured.

A future scheduled retention process can be added.

---

# 112. Production deployment considerations

Potential deployment environment may be CSC Rahti/OpenShift or equivalent.

Do not tightly couple application to one host.

Containers:

```text
web
worker
```

External:

```text
PostgreSQL
private object storage / PVC
```

If local persistent volume is used for audio, ensure deployment strategy does not accidentally create multiple writers against a ReadWriteOnce volume.

S3-compatible storage is preferable for horizontally scalable deployment.

---

# 113. Health endpoints

Provide:

```text
GET /api/health
GET /api/health/ready
```

Health:

- process alive.

Ready:

- DB accessible;
- required configuration present;
- storage accessible.

Do not call paid OpenAI API on every health request.

Admin can have a separate explicit provider connectivity test.

---

# 114. Backups

Document backup strategy.

At minimum:

- PostgreSQL backup;
- media-store backup/versioning according to hosting capability;
- restore test.

A DB backup without audio is incomplete.

An audio backup without DB metadata/provenance is also incomplete.

---

# 115. Export reproducibility manifest

Full dataset export should contain something like:

```json
{
  "study": "dialect-translation-study",
  "generated_at": "...",
  "app_version": "...",
  "git_commit": "...",
  "filters": {
    "mode": ["research"],
    "completed_only": true,
    "include_test": false
  },
  "protocol_versions": ["1.0"],
  "processing_batches": ["..."],
  "files": [
    {
      "path": "source_audio/....wav",
      "sha256": "..."
    }
  ]
}
```

---

# 116. Admin destructive actions

Require clear confirmation for:

- delete TEST data;
- delete media;
- exclude whole session;
- cancel processing batch;
- retire protocol/config.

Do not include a one-click "reset all research data" near routine controls.

If a development-only reset exists, disable it in production unless explicitly configured.

---

# 117. Search and filtering

Admin search must never send transcripts to third-party search services.

Use PostgreSQL.

For initial scale:

- participant code;
- IDs;
- text search on transcripts;
- status filters.

A simple PostgreSQL text search or `ILIKE` is sufficient.

---

# 118. Transcript full-text search

Useful future feature:

> Search for "mie", "sie", discourse particles, etc.

Can be implemented in Sessions/Review.

Do not call this dialect ground truth.

It is researcher search functionality.

---

# 119. Privacy-conscious analytics

Dashboard should aggregate operational data.

Avoid displaying unnecessary detailed participant background on the dashboard.

Detailed sociolinguistic metadata belongs inside session detail and exports.

---

# 120. Researcher annotations and inter-rater support

Future-proof for multiple annotators even though there is no user-management page.

Every annotation can store:

```text
annotator_label
```

Later, if needed, a small configured researcher identity can be introduced.

Do not architect the whole product around RBAC now.

---

# 121. Inter-rater reliability workflow - future

Potential future admin view:

```text
Annotation batch
Annotator A complete
Annotator B complete
Agreement report
Adjudication pending
```

Not required v1.

But preserve independent ratings rather than overwriting one another.

---

# 122. Semantic fidelity and naturalness evaluation - future

Do not make one overall "quality" field.

Potential separate variables:

```text
semantic_fidelity
naturalness
representational_adequacy
formality
stance_preservation
regional_association
voice_similarity
```

These are conceptually different constructs.

---

# 123. File naming

Human-friendly exported names may include pseudonymous codes:

```text
P-7K4M9Q_U-03_source.wav
```

Internal object keys should use UUIDs.

Never use participant names.

---

# 124. IDs

Use:

- UUIDs internally;
- short random pseudonymous display codes for participant/session UI.

Do not use predictable incremental public IDs.

---

# 125. Data serialization

Use:

- JSONB for truly flexible/versioned config and provider metadata;
- normal relational columns for scientifically central fields.

Do **not** put the entire database design into one giant JSONB session record.

Core entities need relational integrity.

---

# 126. Indexes

At minimum index:

```text
sessions(study_id, started_at)
sessions(protocol_version_id)
sessions(mode, status)
utterances(session_id)
utterances(task_presentation_id)
media_assets(utterance_id)
media_assets(sha256)
transcripts(utterance_id, type)
translations(source_transcript_revision_id)
model_runs(stage, status)
jobs(status, available_at)
questionnaire_responses(session_id)
research_flags(entity_type, entity_id)
```

Use partial indexes where useful for queue/status.

---

# 127. Transactions

Critical multi-step mutations use DB transactions.

Examples:

- publish protocol;
- submit accepted recording metadata;
- create transcript revision and switch current revision;
- activate model config;
- create processing batch jobs.

Do not leave half-published scientific state.

---

# 128. Concurrency

Although the admin may be one person, participants could submit concurrently.

Use uniqueness constraints and transaction correctness rather than assuming one request at a time.

Worker locking must handle multiple worker replicas safely.

---

# 129. Admin unsaved changes

Reuse the good idea from `manipulative-ai`.

Draft editors should warn about unsaved changes:

- Study Flow;
- AI prompts/config;
- questionnaires;
- settings.

Published entities are read-only.

---

# 130. Admin preview

Study Flow has:

```text
Preview as participant
```

Preview must clearly show:

```text
PREVIEW - NOT RESEARCH DATA
```

Preview interaction should create no research session unless explicitly using Test Mode.

---

# 131. Data export audit

Every full/sensitive export creates an audit log:

```text
who/label
when
filters
export type
resulting archive ID
```

For a single admin, actor can initially be `admin`.

---

# 132. Media download audit

Optional for v1, recommended for production with sensitive recordings.

At least full archive exports should be audited.

---

# 133. Performance targets

Participant interaction:

- page navigation should feel immediate;
- upload progress visible;
- no synchronous translation delay in Research Mode;
- source recording upload reliable.

Admin:

- session list paginated;
- do not load all audio on list page;
- only fetch media when opened/played.

---

# 134. Pagination

Sessions and review queues should use server-side pagination.

Default 50 rows.

Exports are separate and not tied to visible page size.

---

# 135. Audio streaming

Admin playback endpoint should support HTTP Range requests if practical so seeking works without downloading full files.

Never generate a permanent public URL.

---

# 136. Browser support

Define a supported research browser.

Recommended initial approach:

- Chromium/Chrome current stable on the study laptop.

The study should not pretend all browsers are acoustically equivalent.

Public remote version may support more browsers later.

Record browser/environment metadata.

---

# 137. Study-laptop mode

Because the intended seminar/study may use one laptop, support an operator workflow:

```text
Finish participant
    ->
Return to clean welcome screen
```

No previous participant state should be visible.

Provide:

```text
Start next participant
```

after completion if configured.

Clear client-side blobs/state.

---

# 138. Prevent cross-participant leakage

After session completion:

- clear session cookie/token when appropriate;
- clear local/session storage;
- revoke object URLs;
- reset media device state;
- return to welcome.

Do not show previous person's recordings.

---

# 139. Research mode operator shortcut - optional

For lab use, an admin-only shortcut can:

- inspect device readiness;
- open participant start page;
- return to admin.

Do not expose admin controls to participants.

---

# 140. Consent version display

Admin Session Detail must show:

```text
Consent version v2
Accepted: timestamp
Scopes: ...
```

Researchers should be able to inspect exactly what was agreed.

---

# 141. Protocol diff

When publishing v1.4 after v1.3, show:

```diff
- old prompt
+ new prompt
```

Also list:

- tasks added/removed;
- questionnaire changed;
- consent changed;
- ordering changed.

This makes methodological changes obvious.

---

# 142. Processing config diff

Likewise compare:

```text
translation-preserve v3 -> v4
```

before activation.

---

# 143. No silent defaults

Scientific configuration should be explicit in admin.

If no active translation config exists, batch creation should fail with a clear error.

Do not silently fall back to hidden hard-coded production prompts.

Hard-coded seed defaults may bootstrap development but must be visible/configurable.

---

# 144. Provider outages

If ASR fails:

- job failed;
- source audio preserved;
- retry possible.

If translation fails:

- ASR/transcripts preserved;
- retry translation.

If TTS fails:

- translations preserved;
- retry TTS.

No downstream failure invalidates upstream data.

---

# 145. Partial batch completion

Processing batch can become:

```text
completed_with_errors
```

Admin shows:

```text
1000 jobs
992 succeeded
8 failed
```

Allow:

```text
Retry failed
```

Do not re-run all 992 successful jobs unless creating a new batch intentionally.

---

# 146. Model response validation

Translation output:

- must be non-empty;
- strip accidental surrounding UI boilerplate only if deterministic and documented;
- do not "clean up" linguistic content with another model.

If model returns unexpected explanation despite prompt, store raw response and flag/parse carefully.

Prefer structured response mechanisms only if they do not alter translation content.

---

# 147. Translation text normalization

Do not silently normalize punctuation/casing across conditions.

If analysis requires canonical normalization later, create a derived analysis representation.

Raw model output remains immutable.

---

# 148. ASR raw response

Store:

- primary transcript;
- segment/timestamp data if provider supplies and if useful;
- provider metadata.

Do not throw away timestamps when available merely because v1 UI does not use them.

---

# 149. Timestamps and alignment - future

Schema should permit future:

- word timestamps;
- phoneme/segment alignment;
- TextGrid/EAF export.

A future `time_aligned_segments` table can be added.

Do not force all transcript text into timestamped format now.

---

# 150. Data quality workflow before main processing

Recommended research workflow:

```text
collect source corpus
    ->
ASR available
    ->
human B/C transcription
    ->
verification
    ->
lock selected evaluation subset
    ->
launch translation processing batch
```

Admin Processing wizard can enforce:

```text
verified_transcripts_only = true
```

by default.

---

# 151. Analysis subset selection

Future feature: define named corpus subsets.

Example:

```text
pilot-12-speakers
main-heldout-48-speakers
tts-subset-96-clips
```

Implement later as:

```text
dataset_subsets
dataset_subset_items
```

Useful for reproducible analysis.

Not mandatory for first MVP but recommended before full experiment.

---

# 152. Speaker-independent split support

Future `dataset_split` concept:

```text
development
validation
test
```

Assignment should happen by participant/session, not by individual utterance, to prevent speaker leakage.

Do not randomly split utterances across train/test if the same speaker would appear in both.

---

# 153. Public participant metadata minimization

Do not request:

- full name;
- exact home address;
- personal identity code;
- email;

unless a separately justified recruitment/contact workflow requires them.

If incentives require contact details, store them in a separate system/table disconnected from research responses where possible.

Not part of v1.

---

# 154. Research dashboard versus analysis dashboard

This admin is a **research operations tool**.

Do not build statistical inference/charts of the research hypothesis as a core feature.

Analysis should happen through reproducible scripts/notebooks on exported data.

Possible operational charts:

- sessions per day;
- completion rate;
- recording duration;
- review backlog;
- processing job success.

Avoid hypothesis-result charts during collection.

---

# 155. Future reproducible analysis package

Later, repository can have:

```text
analysis/
├── README.md
├── data_validation/
├── asr_analysis/
├── translation_analysis/
├── acoustic_analysis/
└── statistics/
```

Do not mix analysis scripts into production web code.

---

# 156. Acceptance criteria - participant side MVP

A build is not acceptable until:

1. participant can open welcome page;
2. participant can read information and consent;
3. consent version is stored;
4. participant can complete non-persistent mic test;
5. participant receives tasks from published protocol;
6. controlled, semi-structured, and free tasks all work;
7. participant can record, play, re-record, and submit;
8. accepted audio is persisted and hashed;
9. no ASR/translation/TTS is shown in Research Mode;
10. participant can complete background questionnaire;
11. participant can complete post-recording questionnaire;
12. participant sees debrief;
13. session is marked completed;
14. refreshing does not corrupt session;
15. previous participant data are not visible to next participant.

---

# 157. Acceptance criteria - admin MVP

1. admin password login works securely;
2. dashboard displays operational metrics;
3. sessions list is paginated/filterable;
4. session detail displays prompts, source audio, metadata, and questionnaire responses;
5. admin can download individual source audio;
6. Review queue exists;
7. admin can create/verify B transcript;
8. admin can create/verify C transcript;
9. transcript revision history is retained;
10. Study Flow supports draft/publish versioning;
11. controlled/semi/free task text is editable in draft;
12. published protocol is immutable;
13. AI prompts/configs are versioned;
14. processing batch can be created;
15. ASR/translation/TTS jobs can run and retry;
16. outputs appear in session detail;
17. TEST/DEMO badges are obvious;
18. flag-for-review works;
19. structured data exports work;
20. source/TTS audio ZIP export works;
21. research export excludes TEST/DEMO by default.

---

# 158. Acceptance criteria - scientific provenance

For any English TTS file, the admin/research export must be able to answer:

```text
Which participant/session?
Which source utterance?
Which exact source audio file/hash?
Which task and exact prompt?
Which transcript condition?
Which transcript revision?
Which translation condition?
Which translation prompt version?
Which model/config?
Which processing batch?
Which exact translated text?
Which TTS model/config/voice?
When was it generated?
Which app version produced the run?
```

If any of these are unknowable, provenance is incomplete.

---

# 159. Acceptance criteria - scientific isolation

Core processing must make these comparisons possible:

```text
A vs B
B vs C
Default vs Preservation
Same target text under different TTS conditions
```

Do not collapse stages into one irreversible process.

---

# 160. Acceptance criteria - privacy/security

1. no provider secret in browser bundle;
2. no public audio URL;
3. no source audio in Git;
4. no mic-check audio stored;
5. admin required for media download;
6. research exports exclude test/demo by default;
7. third-party identifying-content flag supported;
8. consent/protocol version stored;
9. secure production cookies;
10. logs avoid full transcript/audio content by default.

---

# 161. Implementation phases

Implement in controlled increments.

---

## Phase 0 - Project foundation

Before feature work, establish both the technical foundation **and the UI lineage**.

- inspect the current `josesiqueira/manipulative-ai` reference repository;
- record its exact commit in `docs/UI-LINEAGE.md`;
- create `docs/UI-PARITY-MATRIX.md`;
- port/adapt the reference design tokens and component conventions;
- establish participant and admin shells that visibly belong to the same product family;
- capture reference screenshots when feasible for side-by-side review;
- Next.js/TypeScript project;
- PostgreSQL;
- Drizzle;
- migrations;
- Docker Compose;
- basic study/admin layouts;
- env validation;
- auth skeleton;
- storage abstraction;
- local storage;
- health endpoints.

Definition of done:

```text
web boots
db migrates
admin login works
local storage test works
UI-LINEAGE.md records the exact upstream reference SHA
UI-PARITY-MATRIX.md exists
participant shell visually matches the manipulative-ai family
admin shell visually matches the manipulative-ai family
shared design tokens/components exist before feature-page styling
```

---

## Phase 1 - Protocol and participant flow

Implement:

- study;
- protocol version;
- consent;
- tasks;
- questionnaire schemas;
- published protocol;
- public flow;
- mic check;
- recording;
- upload;
- session completion.

No AI required yet.

This phase should already permit collection of a high-quality raw speech corpus.

---

## Phase 2 - Admin corpus inspection

Implement:

- dashboard;
- sessions list;
- session detail;
- audio playback/download;
- flags;
- task/prompt snapshots;
- questionnaire display;
- test/demo filtering.

---

## Phase 3 - Review & transcription

Implement:

- ASR transcript display;
- B human transcript;
- C normalized transcript;
- optional A*;
- revision history;
- verification;
- review queue.

---

## Phase 4 - AI processing infrastructure

Implement:

- OpenAI adapters;
- model configs;
- AI prompt versions;
- model_runs;
- job queue;
- worker;
- processing batches;
- ASR;
- translation;
- TTS;
- retries/idempotency.

---

## Phase 5 - Data export

Implement:

- CSV/JSON exports;
- full dataset package;
- audio archive;
- manifest;
- data dictionary;
- export audit.

---

## Phase 6 - Demo Mode

Implement live:

```text
record -> ASR -> two translation conditions -> TTS
```

Mark all demo records.

This can happen earlier if needed for the seminar, but keep code paths clearly separated from Research Mode.

---

## Phase 7 - Production hardening

- production storage;
- HTTPS;
- CSP/security headers;
- rate limits;
- backup docs;
- restore test;
- privacy review;
- audio capture validation on study laptop;
- browser/device lock-down if appropriate;
- deployment.

---

## Phase 8 - Future research extensions

Not required initially:

- TTS factorial subexperiment;
- listener study;
- source-speaker evaluation;
- advanced annotation;
- inter-rater workflow;
- dialect lexicon/RAG intervention;
- fine-tuned models;
- realtime black-box comparison;
- acoustic automatic metrics;
- speaker-independent split manager.

---

# 162. Seminar priority path

If the seminar is earlier than the full study, prioritize:

```text
1. project foundation
2. Demo Mode
3. admin Session Detail
4. source/transcript/translation/TTS saving
5. Study Flow editor
```

Then continue toward Research Mode production quality.

Do not let the seminar demo architecture become the permanent research architecture.

---

# 163. Definition of v0.1 demo

The smallest meaningful working demo:

```text
Record Finnish speech
    ->
store source audio
    ->
OpenAI transcription
    ->
display transcript
    ->
run default translation
    ->
run preservation-aware translation
    ->
display both
    ->
generate fixed-voice TTS for both
    ->
play both
    ->
store every intermediate record with provenance
```

Admin can inspect the session.

---

# 164. Definition of v1.0 research platform

A research-ready v1.0 requires:

- published immutable protocol;
- consent/version recording;
- controlled/semi/free elicitation;
- research audio capture;
- no AI feedback during collection;
- post-recording questionnaires;
- source corpus storage;
- review/transcription workflow;
- processing batches;
- model provenance;
- default/preserve translation;
- TTS;
- admin session explorer;
- exports;
- secure deployment;
- data-management/ethics text supplied by researcher.

---

# 165. Explicit non-goals for v1

Do not build:

- general user accounts;
- participant login system;
- social profiles;
- multi-tenant SaaS;
- billing;
- chat history UI for participants;
- live AI follow-up generation in Research Mode;
- voice cloning;
- real-time dialect classifier;
- automatic "authenticity score";
- automatic decision that a participant belongs to a dialect;
- full annotation platform like ELAN;
- statistical analysis dashboard;
- public dataset portal;
- public audio hosting.

---

# 166. Decisions that must remain researcher-configurable

Never hard-code as permanent assumptions:

- final study title;
- consent text;
- privacy URL;
- number of tasks;
- task prompts;
- task ordering;
- duration limits;
- questionnaires;
- OpenAI models;
- AI prompts;
- TTS voice;
- processing conditions;
- target language;
- participant-facing localization;
- retention policy;
- future reuse scopes.

---

# 167. Decisions currently fixed by methodological design

Unless the researchers explicitly redesign the study, treat these as non-negotiable:

- Research Mode hides AI output during speech collection.
- Controlled tasks elicit spontaneous responses; they are not read-aloud scripts.
- Semi-structured follow-ups are predefined in v1.
- Free speech is exploratory.
- Sociolinguistic self-description is collected after speech tasks.
- Source audio is immutable.
- A/B/C are independently represented.
- Human B/C are not silently generated by LLM.
- Translation conditions are separate model runs.
- TTS uses same baseline configuration across core translation conditions.
- Published protocols/prompts/configs are versioned/immutable.
- TEST/DEMO data excluded by default.
- Audio is stored outside PostgreSQL.
- PostgreSQL/Drizzle stores structure/provenance.
- Every derivative traces to its exact parent.

---

# 168. Suggested domain enums

Centralize enums/types.

```ts
type StudyMode = 'research' | 'demo' | 'test';

type TaskType =
  | 'controlled'
  | 'semi_structured'
  | 'free_speech';

type TranscriptType =
  | 'asr'
  | 'asr_corrected'
  | 'human_dialect'
  | 'normalized';

type TranslationCondition =
  | 'default'
  | 'preservation';

type ProcessingStage =
  | 'asr'
  | 'translation'
  | 'tts'
  | 'realtime_translation';

type ReviewStatus =
  | 'not_started'
  | 'draft'
  | 'needs_review'
  | 'verified';
```

Prefer DB enums or well-constrained text depending migration strategy.

---

# 169. Scientific audit example

A researcher clicks:

```text
P-7K4M9Q / Controlled Task 2 / U-02
```

They should be able to inspect:

```text
Participant prompt:
"Imagine..."

Source:
asset 89...
SHA256 ...
duration ...
capture ...

A:
ASR run 312...
gpt-transcribe
timestamp ...

B:
revision 2
verified by JS
transcription convention 1.0

C:
revision 1
verified ...

Translation:
B -> preservation
batch pilot-v2
prompt preservation-v3
model gpt-5.6-sol
timestamp ...

TTS:
voice ...
model ...
WAV asset ...
SHA256 ...
```

This is the standard the implementation should target.

---

# 170. Scientific reasoning behind the product split

The participant-facing interface is intentionally simple because participant interaction itself can influence language.

The admin is intentionally rich because researchers need:

- provenance;
- review;
- intervention control;
- reproducibility;
- data export.

Therefore:

```text
simple surface
+
instrumented backend
+
rich researcher inspection
```

is not merely a UX choice; it is part of the methodology.

---

# 171. Final implementation philosophy

Build the platform so that a future paper can truthfully state:

> Each accepted utterance was linked to the exact elicitation prompt and protocol version, source recording, ASR output, human dialect-preserving transcription, normalized transcription, translation condition, model and prompt version, speech-synthesis configuration, and subsequent annotations. All derived outputs were generated as immutable, versioned research records and could be traced to the original source recording.

If the implementation achieves that while keeping participant interaction simple, it has succeeded.

---

# 172. First Claude Code execution plan

Claude Code should not attempt the entire system in one uncontrolled patch.

Recommended first actions:

1. inspect existing repository if one already exists;
2. create `docs/IMPLEMENTATION-SPEC.md` from this document;
3. write an implementation plan broken into phases;
4. establish the TypeScript/Next.js/PostgreSQL/Drizzle foundation;
5. create schema migrations for study/protocol/session/task/utterance/media entities first;
6. implement local storage adapter;
7. implement admin authentication;
8. implement participant protocol flow without AI;
9. implement recording/upload;
10. implement admin session inspection;
11. only then add AI processing.

Before each major phase, update a small `docs/IMPLEMENTATION-STATUS.md` describing:

- completed;
- in progress;
- next;
- deviations from this specification;
- unresolved research decisions.

Do not silently deviate from a scientific requirement.

If a requirement appears technically problematic, document the issue and implement the safest scientifically conservative option rather than deleting the requirement.

---

# 173. Final checklist for Claude Code

Before calling the first research-ready build complete, answer **yes** to all:

```text
[ ] Can a participant complete the study without creating an account?
[ ] Is consent versioned?
[ ] Is the exact protocol pinned to the session?
[ ] Are exact prompts shown saved?
[ ] Are controlled/semi/free tasks supported?
[ ] Is dialect self-description collected after speech?
[ ] Is mic-check audio discarded?
[ ] Is accepted source audio lossless where research capture supports it?
[ ] Are actual audio settings saved?
[ ] Are source files outside PostgreSQL?
[ ] Is every media file hashed?
[ ] Are rejected recording attempts deleted?
[ ] Can collection continue during an OpenAI outage?
[ ] Is AI output hidden from Research Mode participants?
[ ] Can admin play/download original audio?
[ ] Can admin create B and C transcripts?
[ ] Are transcript edits revisioned?
[ ] Are ASR outputs immutable?
[ ] Are default/preservation translations separate runs?
[ ] Are prompts/model configs versioned?
[ ] Is each model run fully traceable?
[ ] Can multiple processing batches coexist?
[ ] Is TTS generated from an exact stored translation string?
[ ] Is the baseline TTS config fixed across core conditions?
[ ] Are TEST and DEMO data excluded from research exports by default?
[ ] Can admin flag sessions and utterances?
[ ] Are destructive actions audited?
[ ] Can a complete session dataset be exported?
[ ] Can a full corpus package be exported with manifest and hashes?
[ ] Are permanent provider credentials server-side only?
[ ] Are media objects private?
[ ] Does admin use secure authenticated sessions?
[ ] Are migrations committed and reproducible?
[ ] Are scientific invariants covered by tests?
[ ] Was the current manipulative-ai UI/design system inspected before implementation?
[ ] Does docs/UI-LINEAGE.md record the exact reference repository and commit SHA?
[ ] Does docs/UI-PARITY-MATRIX.md map old and new UI patterns?
[ ] Does the participant-facing site visibly belong to the same product family?
[ ] Does the admin retain the fixed slate-sidebar academic dashboard experience?
[ ] Were reference/target pages reviewed side-by-side at matched viewport sizes?
[ ] Are intentional UI deviations documented rather than accidental?
[ ] Has generic SaaS/dashboard style drift been avoided?
```

Only after this foundation is stable should the project expand to RAG, fine-tuning, realtime speech-to-speech, listener studies, or sophisticated acoustic analysis.

---

# Appendix A - Recommended first database relationship map

```text
Study
 |
 +-- ProtocolVersion
 |    |
 |    +-- ProtocolTask
 |    |    |
 |    |    +-- ProtocolTaskFollowup
 |    |
 |    +-- ConsentVersion
 |    +-- QuestionnaireVersion
 |
 +-- Session
      |
      +-- SessionConsent
      |
      +-- TaskPresentation
      |    |
      |    +-- Utterance
      |         |
      |         +-- MediaAsset (source)
      |         |
      |         +-- Transcript
      |              |
      |              +-- TranscriptRevision
      |                    |
      |                    +-- Translation
      |                         |
      |                         +-- Synthesis
      |                              |
      |                              +-- MediaAsset (TTS)
      |
      +-- QuestionnaireResponse
           |
           +-- QuestionnaireAnswer

ProcessingBatch
 |
 +-- ModelRun
      |
      +-- ASR output / Translation / Synthesis

AIPromptVersion
 |
 +-- ModelConfig
      |
      +-- ModelRun
```

---

# Appendix B - Suggested source media directory in local development

```text
data/
└── media/
    └── studies/
        └── dialect-study/
            └── sessions/
                └── <session-uuid>/
                    └── utterances/
                        └── <utterance-uuid>/
                            └── source/
                                ├── <asset-uuid>.wav
                                └── <asset-uuid>.webm   # only if raw fallback exists
```

Generated audio:

```text
data/
└── media/
    └── studies/
        └── dialect-study/
            └── generated/
                └── syntheses/
                    └── <synthesis-uuid>/
                        └── <asset-uuid>.wav
```

Database remains authoritative for relationships.

Filesystem paths alone are not scientific metadata.

---

# Appendix C - Example complete utterance lineage

```text
Session:
P-7K4M9Q

Protocol:
v1.3

Task:
controlled-invitation-uncertainty

Prompt:
"Imagine an English-speaking friend has invited you somewhere..."

Utterance:
U-7cb...

Source:
source-3b4.wav
SHA256: ...

A:
"Minä en oikeastaan tiedä..."
ASR run: MR-001

A*:
"Minä en oikeastaan tiedä..."
human correction revision: ...

B:
"Mie en oikeestaan tiiä..."
human dialect transcript revision: ...

C:
"Minä en oikeastaan tiedä..."
normalized transcript revision: ...

Translation B/default:
"I don't really know whether I want to go."
model run: MR-204
prompt: translation-default-v1

Translation B/preservation:
"I'm not really sure I feel like going."
model run: MR-205
prompt: translation-preserve-v3

Synthesis B/default:
tts asset ...
model run MR-301

Synthesis B/preservation:
tts asset ...
model run MR-302
```

This lineage should be queryable in the admin and reconstructable from exports.

---

# Appendix D - Methodological warnings to keep visible in development docs

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
12. Do not change active protocol/model prompts silently during collection.
13. Do not treat model aliases as permanently reproducible identifiers without logging dates/returned metadata.
14. Do not mix TEST/DEMO data with research data.
15. Do not store audio in public web directories.
16. Do not send participant metadata to AI providers unless scientifically necessary.
17. Do not build inference dashboards that encourage peeking at treatment effects during data collection.
18. Do not delete inconvenient outputs; flag/exclude them with provenance.
19. Do not overwrite human-reviewed scientific records.
20. Do not let implementation convenience destroy the ability to identify where a transformation occurred.

---

# Appendix E - Product summary in one paragraph

The product is a single research website with a simple public participant flow and a rich password-protected researcher admin. Participants consent, test their microphone, complete controlled, semi-structured, and free Finnish speaking tasks, then complete background and post-recording questionnaires. In Research Mode they do not see ASR or translations while speaking. Every accepted recording becomes an immutable utterance linked to the exact task/protocol version. Researchers later inspect sessions, create/verify dialect-preserving and normalized transcripts, and run versioned ASR/translation/TTS processing batches. PostgreSQL + Drizzle stores structured research data and provenance; private file/object storage holds audio. The admin supports Study Flow editing with immutable published versions, AI prompt/model configuration, processing runs, transcript review, flags, questionnaires, session inspection, and comprehensive exports. The architecture is designed so every final translated audio output can be traced back to the exact original speech, intermediate representation, model configuration, and prompt that produced it.
