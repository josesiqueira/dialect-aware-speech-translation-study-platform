# Protocol versioning

How the participant-facing study definition is versioned, published and kept immutable. Section numbers such as "spec 76" refer to `docs/IMPLEMENTATION-SPEC.md`. The database rules are described in full in `docs/DATA-MODEL.md`.

Code: services in `packages/research/src/protocols/`, request schemas in `packages/domain/src/validators/protocols.ts`, API under `/api/admin/protocols` and `/api/admin/consents`, admin page `/admin/study-flow` (with `/admin/study-flow/consent`), preview `/admin/preview/<protocolVersionId>`.

## Why versions

A session must stay interpretable even if the study is changed later (spec 77). Each session therefore points at one exact protocol version, and a published version never changes (spec 76, 110). A change to the study is always a new version:

```text
Published v1  ->  Clone  ->  Draft v2  ->  Edit  ->  Preview  ->  Publish v2
```

Sessions that started under v1 stay on v1. New sessions get v2.

## What a protocol version contains

| Part | Stored in |
|---|---|
| Name and description (researchers only) | `protocol_versions.name`, `description` |
| Welcome, participant information, study instructions, debrief texts | `protocol_versions.*_content` |
| Selected consent version | `protocol_versions.consent_version_id` |
| Selected background and post-recording questionnaire versions (each optional) | `background_questionnaire_version_id`, `post_questionnaire_version_id` |
| Task blocks, in order, each with an order mode (`fixed` or `shuffle_within_block`) | `protocol_versions.order_config_json` |
| Tasks | `protocol_tasks` |
| Predefined follow-ups of a task | `protocol_task_followups` |
| The texts above in other languages (Finnish next to the English base text) | `translations_json` of each of these rows, and of the consent and questionnaire versions |

Statuses: `draft`, `published`, `retired`.

## Rules

1. **Only a draft can be edited.** The services refuse a change to a published or retired version with `IMMUTABLE_RECORD` and the advice to clone it. This covers the version itself, its tasks and its follow-ups.
2. **One draft per study at a time.** Creating or cloning while a draft exists is refused with `CONFLICT`, and the message names the existing draft. Reason: the draft is "the next version". With a single draft the workflow stays simple, and the version number shown while editing is the number the version will have when published. The same rule applies to consent drafts.
3. **Version numbers** are the highest existing number of the study plus one. If a draft is deleted, its number is used again by the next draft. Numbers of published versions are never reused.
4. **Two editors cannot overwrite each other silently.** Every change to a draft (texts, selections, blocks, tasks, follow-ups) moves `protocol_versions.updated_at` forward. The editor sends the `updated_at` it loaded as `expectedUpdatedAt`. When the stored value differs, the save is refused with `CONFLICT` and the page offers to reload the draft. `expectedUpdatedAt` is required by the API for the protocol itself and is sent by the page for every task and follow-up change.
5. **A draft may only select published versions.** A consent version or questionnaire version that is still a draft cannot be selected. The background slot accepts questionnaires with the key `background`, the post-recording slot those with the key `post_recording`.
6. **Task keys are stable.** `task_key` is a slug, unique within the protocol, set when the task is created and never changed afterwards. Cloning a protocol keeps the keys, so the same task can be followed across versions (the difference view matches tasks by key). Cloning a single task inside a draft gives the copy a new key, because it is a different task. Follow-up keys work the same way.
7. **Task order.** Blocks are presented in the order of the order configuration. Inside a block, tasks follow `order_index`. `order_index` is kept dense (0, 1, 2, ...) over the whole protocol in presentation order. Move up and Move down swap neighbors inside a block and step into the neighboring block at its edge. A task's `order_mode` always equals the order mode of its block. A task can be kept at its position inside a shuffled block with `config_json.randomizationEligible = false`. A block that still has tasks cannot be removed.
8. **Follow-ups are predefined texts.** There is no option to generate a follow-up with a model (spec 7.2, 82, 167).
9. **Deleting.** Only a draft can be deleted. Its tasks and follow-ups are deleted with it. A draft that a published or retired version records as its clone source cannot be deleted, because clearing that link would change an immutable row. The services cannot produce this state (cloning needs a free draft slot), but the service checks for it and explains it.
10. **Every change is audited** in `admin_audit_log`, in the same transaction: `protocol.create`, `protocol.clone`, `protocol.update_draft` (one row per save, with the changed fields before and after), `protocol.publish` (with the difference summary), `protocol.retire`, `protocol.delete_draft`, `consent.create`, `consent.clone`, `consent.update_draft`, `consent.publish`, `consent.delete_draft`.

## What "current" means

`studies.current_protocol_version_id` is the protocol that **new** sessions receive. Publishing a draft sets it. Nothing else changes it.

- The previously current version stays `published`, because its sessions still refer to it. It can be retired once it is no longer current.
- A retired version is still readable, and its sessions stay linked to it. It can never become current again.
- A session never changes its protocol: `sessions.protocol_version_id` is frozen by a database trigger.

## Why sessions are pinned

Each session stores its protocol version, and each task presentation stores the exact texts shown (spec 8, 77). If a published protocol could change, a recording could no longer be tied to the prompt that produced it, and sessions before and after the change could not be told apart. Pinning makes a methodological change visible as a new version with a date, instead of a silent edit during collection (Appendix D, warning 12).

## How to change a published protocol

1. Open **Study Flow**. The status card shows the published version and the draft, if any.
2. Choose **Clone published version to new draft**. Everything is copied: texts, blocks, tasks, follow-ups and the selected consent and questionnaire versions.
3. Edit the draft card by card. Each card has Edit, Cancel and Save. Tasks are added, edited, cloned, disabled, moved and deleted in the Tasks card.
4. To change the consent, open the consent editor, clone the published consent version, edit and publish it, then select it in the draft protocol. Questionnaires work the same way on the Questionnaires page.
5. Choose **Preview participant study**. The preview shows the participant flow of that version under the banner "PREVIEW - NOT RESEARCH DATA". It uses the participant step components and the interface languages of the study, so it looks exactly like the study, with the language buttons. The researcher's controls (previous, next, jump to a step) are in a separate bar under the banner. Information text and consent form are two steps, as in the study. Tasks are shown in protocol order, with a note when a block is shuffled per session. The microphone check and the recording control are shown in their starting state: the preview never opens the microphone. It creates no session and stores nothing.
6. Choose **Publish draft**. The review shows the publish check and the difference against the currently published version. After confirmation the version is immutable and applies to new sessions.

## Publish checklist

`validateProtocolForPublish` returns errors and warnings. An error blocks publishing. A warning is a methodological note that the researcher decides about.

Errors:

| Code | Rule |
|---|---|
| `name_missing` | The protocol has a name. |
| `content_missing` | Welcome text, participant information text, study instructions and debrief text are not empty. |
| `consent_missing`, `consent_not_published` | A consent version of this study is selected and it is published. |
| `questionnaire_missing`, `questionnaire_not_published`, `questionnaire_wrong_key` | A selected questionnaire version exists in this study, is published and has the key of its slot. |
| `no_enabled_task` | At least one task is enabled. |
| `task_title_missing`, `task_prompt_missing` | Every enabled task has a participant-facing title and a prompt. |
| `task_duration_inconsistent` | For every enabled task: maximum above zero, minimum not above maximum, suggested between minimum and maximum. |
| `followup_prompt_missing` | Every enabled follow-up of an enabled task has a text. |
| `task_block_missing` | The block of every task is listed in the order configuration. |
| `block_key_duplicate` | Block keys are unique. |
| `example_text_present` | No text still contains an example marker of the development seed. One error per field, and the message names the text. |

Example markers are the sentence "Example text, to be replaced by the research team" (shown to participants in seeded texts) and `[PLACEHOLDER` (used only in fields a participant never sees). They are defined once in `packages/domain/src/validators/protocols.ts` and used by the seed. The check covers the protocol name, description and its four texts, the participant-facing study title, the selected consent version (title, information text, contact text, items), every enabled task (internal name, title, prompt, context, instructions, researcher notes, enabled follow-ups, topic suggestions) and the selected questionnaires (name, description, items with their help texts and option labels).

The same search protects data collection: `protocols.currentProtocolHasExampleText(ctx, studyId)` is true while the current protocol still contains a marker, and research sessions are refused while it is. TEST and DEMO sessions are not affected. The Dashboard and the Settings page show the state. The seeded protocol v1 is published with example text, so a new deployment cannot collect research data until the researchers publish their own version. The check finds markers only: a seeded task prompt carries no marker, so replacing the example prompts stays a decision of the researchers.

Warnings:

| Code | Rule | Spec |
|---|---|---|
| `free_speech_without_privacy_reminder` | A free speech task has the privacy reminder switched off. | 7.3 |
| `questionnaire_not_selected` | No background or no post-recording questionnaire is selected. | 11, 12 |
| `shuffle_block_single_task` | A block with random order has exactly one enabled task. | 8 |
| `wording_mentions_dialect` | A text shown before the last speech task contains "dialect", "murre", "murte", "murtee", "murteel" or "murteit". | 6.4 |
| `wording_states_hypothesis` | It contains "we believe", "we expect", "we think that", "hypothes", "uskomme", "oletamme" or "hypotees". | 6.1 |
| `wording_asks_for_marked_speech` | It contains "as strongly as", "strongly as possible", "exaggerate", "mahdollisimman vahva" or "liioittel". | 6.4 |

The wording checks are plain text searches that ignore letter case (`PRIMING_CHECKS` in `validation.ts`). The Finnish stems cover the inflected forms of "murre" (murteen, murteella, murteita). They cannot judge wording. They point at passages to read again before data collection. A warning names the text it was found in and never blocks publishing.

Texts that are checked, because a participant reads them before the last speech task:

- the participant-facing study title (Settings page, where the same warning is shown under the field);
- the welcome text, the participant information text and the study instructions;
- the selected consent version: title, information text, contact text and every item;
- every enabled task: title, prompt, context text, instructions, enabled follow-ups and topic suggestions.

Texts that are not checked: the debrief text and the questionnaires. They are shown after the speech tasks, and the questionnaires ask about dialect on purpose (spec 11, 12). Disabled tasks and disabled follow-ups are not checked either, because participants never see them.

Publishing (`publishProtocol`) runs in one transaction (spec 127): lock the study and the draft, run the check, set `published` and `published_at`, set the study's current protocol, write the audit row with the difference summary. If the check fails, nothing changes.

## Difference between versions

`diffProtocolVersions(from, to)` returns structured data (spec 141): word-level text differences for each content field and each task prompt, tasks added and removed, tasks reordered or moved to another block, tasks enabled or disabled, changed task settings, follow-ups added, removed, changed or reordered, consent changed, questionnaires changed, block order or order mode changed. Tasks are matched by `task_key`, follow-ups by `followup_key`. The Study Flow page shows it in the publish review and under "Changes" in the version history.

## Consent versions

A consent version holds a title, the information text, a privacy notice URL, contact text and the consent items (spec 6.2). It is a draft while `published_at` is empty and immutable afterwards.

- Each item has an id, a text, a required flag and an optional scope label. Ids are stable: a clone keeps them, and the editor locks the id of a saved item. Never reuse an id for a statement with a different meaning: remove the item and add a new one.
- Publishing needs a title, an information text, at least one required item, unique item ids and a text for every item.
- Publishing a consent version does not change any protocol. It takes effect when a draft protocol selects it and that protocol is published.
- A session records the consent version and the text of every item it was shown (`session_consents`).

## The same principle elsewhere

| Entity | Life cycle | Where |
|---|---|---|
| Questionnaire versions | draft, published, retired. Items are editable only in a draft. | `packages/research/src/questionnaires/`, Questionnaires page |
| AI prompt versions, model configs | draft, active, retired. At most one active version per key. A processing batch stores a snapshot of the configuration it used. | `packages/research/src/ai-config/`, AI Pipeline page |
| Transcripts | Every edit is a new revision. | `packages/research/src/transcripts/` |

## Database rules that enforce it

The services check first and give the clear message. The database is the safety net (migration `0002_immutability_triggers.sql`, see `docs/DATA-MODEL.md`):

- `protocol_versions`: a draft may change and may become published. A published version may only become retired (only `status`, `retired_at`, `updated_at` change). A retired version cannot change. Only a draft can be deleted. Publishing requires a published consent version and questionnaires that are not drafts, otherwise `INVALID_STATE`.
- `protocol_tasks`, `protocol_task_followups`: insert, update and delete are blocked unless the protocol version is a draft (`IMMUTABLE_RECORD`). The trigger locks the parent row, so nothing can be added while a version is being published.
- `consent_versions`: once `published_at` is set, no change and no delete.
- CHECK `protocol_versions_published_at_ck`: a published or retired version has `published_at`.
- CHECK `protocol_tasks_durations_ck`: durations are not negative, maximum above zero, minimum not above maximum.
- Unique: `(study_id, version_number)` for protocol and consent versions, `(protocol_version_id, task_key)`, `(protocol_task_id, followup_key)`.
- `sessions.protocol_version_id` cannot change, and a protocol version used by a session cannot be deleted (foreign key).
- `admin_audit_log` is append-only.
