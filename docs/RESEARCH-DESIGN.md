# Research design as implemented

For a researcher who joins the project: what the platform is built to study, which design decisions are fixed in the software and why, what stays configurable, and where each rule is enforced. It restates the specification (`docs/IMPLEMENTATION-SPEC.md`, sections 1 to 3, 7, 8, 15 to 24, 79, 110, 150, 165 to 167) and points to the code. It makes no claim about findings: the platform collects and processes data, the analysis happens elsewhere.

## 1. What is studied

The study investigates whether and where AI speech translation transforms, normalizes, preserves or distorts linguistic variation (spec 1.1). The pipeline is:

```text
Finnish speech -> ASR -> Finnish text -> Finnish-to-English translation -> English text -> TTS -> English synthetic speech
```

The platform must make it possible to say at which stage a transformation happened. It does not assume in advance that dialect always disappears, or that output that looks more "dialectal" is better.

### Research questions and what the platform supports now

| | Question (spec 1.2) | Support in this version |
|---|---|---|
| RQ1 | At which stages are selected dialectal, pragmatic and stylistic distinctions retained, functionally reformulated, normalized or distorted? | Full data collection and processing: source audio, the transcript representations A, A*, B and C, translations of each, synthesis of each translation, difference coding between transcripts, complete lineage. |
| RQ2 | Does preservation-aware translation retain more communicatively relevant variation than default translation, without reducing semantic fidelity or naturalness? | Full data collection and processing: two translation conditions run as separate model runs on the same transcripts, with versioned prompts. The judgment of fidelity and naturalness is a later evaluation step and is not built. |
| RQ3 | When the translated wording is held constant, how do speech generation choices affect prosody, stance, emotion and speaker characteristics? | Foundation only. The schema allows several syntheses of one translation, each with its own configuration. The controlled TTS subexperiment (spec 23) is not built. |
| RQ4 | How do source speakers, bilingual evaluators and target-language listeners perceive the result? | Foundation only. Outputs are stored with stable ids and exported with their lineage, so a later evaluation study can refer to them. No listener or evaluator interface exists (spec 74, 75). |

## 2. Conceptual distinctions that shape the data model

These three distinctions (spec 2) are the reason for several design choices. They are also the first things to keep in mind when reading the data.

**Voice preservation is not dialect preservation.** A system can reproduce a speaker's vocal timbre while standardizing words, grammar, pragmatics and interactional style. Speaker or voice similarity, linguistic variation, prosodic realization and social interpretation are therefore separate things to store and evaluate. No field anywhere says simply that "identity was preserved".

**Dialect preservation is not literal form copying.** Finnish morphology and regional forms cannot be copied into English. A translation can be formally different but functionally appropriate, lexically standard but pragmatically equivalent, superficially "dialectal" but socially misleading, relocated into an unrelated English dialect, or accurate in meaning but socially flattened. The annotation categories reflect this: retained, functionally reformulated, compensated elsewhere, neutralized, distorted, exaggerated or invented, not transferable, uncertain (`packages/domain/src/enums.ts`).

**Output normalization is not proof of societal dialect levelling.** The platform studies transformations in AI-mediated outputs. It does not establish that Finnish dialects are disappearing from society. Participant texts, admin wording and any later writing should not claim that the experiment measures population-level levelling.

## 3. Two modes

**Research Mode** collects speech that is usable as data. The participant speaks, the recording is stored, the participant moves on. ASR may run in the background, translation and TTS run later. During collection the participant never sees an ASR transcript, a translation, a dialect classification, a model response, a condition name, synthetic audio or a model name (spec 3.1). The reason is methodological: AI output shown during the session would influence the speech that follows, and the elicitation would differ between participants in a way that depends on the model.

The participant may listen to the recording they just made and record again before submitting. Only the accepted recording and the number of attempts are stored; rejected attempts are deleted (spec 3.1, 10).

**The output review at the end of a Research Mode session.** After the last speaking task and the background and post-recording questionnaires, a participant who accepted the consent statement of scope `output_review` (a required item in the seed: every participant is told about the review, and the right to leave it out is the "Skip this part" button) and external AI processing sees the AI output of their own recordings and rates it. This is a recorded deviation from spec 3.1 (`docs/IMPLEMENTATION-STATUS.md`, "Deviations"), approved by the project owner and grounded in `reports/Source speaker output evaluation.md`. The reason behind spec 3.1, that AI output shown during speaking changes the speech that follows, still holds: the output appears only after the last recording. The part is:

1. **Review** (scale version `output-review-v2`, designed with the project owner on 2026-10-09). Up to `outputReviewMaxItems` of the participant's recordings (default 5, chosen by the project owner on 2026-10-09: each page asks four ratings, so five pages keep the session short; the research report suggests 8 to 12 per participant as an assumption to test in the pilot), chosen by a seeded spread across tasks from the recordings whose automatic ASR text, both translations (`default`, `preservation`) and both syntheses exist. One page per recording: the participant hears their own recording, reads the speech recognition text and answers "Is this what you said?" (yes, partly, no). Below it Version 1 and Version 2 are shown side by side (stacked on a phone), with left and right random per page and stored. Under each version there are exactly two questions, each a 5-point scale with every point labelled plus "I can't say":
   - meaning: "How well does the English say what you meant?" (1 not at all, 2 a little, 3 partly, 4 mostly, 5 completely);
   - representation, the primary outcome: "How much of the way you said it (your tone, how casual you were, your own expressions) comes through in the English?" (1 none of it, 2 a little, 3 some, 4 most, 5 all of it).
   
   The design follows the evidence in the research report: two outputs of the same source are compared side by side because comparative judgements are more reliable than rating each alone (Song et al. 2025); meaning and representation are separate questions because readers who cannot check the meaning judge fluency instead (Martindale and Carpuat 2018); scales are unipolar and fully labelled, without a "neutral" midpoint and without words that name the hypothesis; and the page has only these questions because answers get faster and less careful as a questionnaire grows (Galesic and Bosnjak 2009). The English level that moderates the ratings comes from the background item `english_reading` ("How well do you understand written English?", five labelled points). No page names a condition, a model or a prompt. The page waits up to 120 seconds for the automatic processing (`AUTO_TRANSLATE_AFTER_ASR`) and then goes on with what is ready; with nothing ready the review is stored as `unavailable` and skipped. The page never starts a model call.
2. **Post-review questionnaire** (key `post_review`), ending with "What do you think this study was about?" for coding hypothesis awareness.

The part can be skipped at any point; answers given so far stay. The debrief explains that recognition errors with everyday and regional speech are a limitation of the systems, not of the speaker. Session Detail shows the researcher which condition each version was. The answers are in `output_reviews.csv` and `output_review_items.csv` of the export (`docs/EXPORT-SCHEMA.md`).

The English vocabulary test LexTALE (Lemhöfer and Broersma 2012, www.lextale.com), which the first version of the review placed before the review, is off by default since 2026-10-09 (project owner's decision, `docs/IMPLEMENTATION-STATUS.md`, "Deviations"). The code and the table `english_checks` stay; a researcher can turn it on with the setting `englishCheckEnabled`. The first version of the review (`output-review-v1`) also had a practice example, a prepared check example with a changed meaning, an audio screen, naturalness and formality ratings, marked words and a forced choice; rows stored with that version keep their answers unchanged.

**Demo Mode** is for seminars, operator trials and teaching. The speaker records Finnish and sees the ASR transcript, both translations and can play synthetic audio. All its data carry the mode `demo` and never enter a research export by default (spec 3.2, 78, 80). Details: `docs/DEMO-MODE.md`.

A third data mode, `test`, marks trial runs of the real participant flow by the research team. A session's mode is stored with the session and never derived from a URL. Processing batches have exactly one data mode, so research outputs and trial outputs cannot be mixed.

## 4. Speech elicitation: three task families

The platform supports three families of speaking tasks (spec 7), each for a different purpose.

| Family | What the participant gets | Why |
|---|---|---|
| Controlled communicative task | The same communicative situation for everyone, for example responding to an invitation. The participant formulates the Finnish utterance. | Comparability across speakers while the speech stays spontaneous. It is **not** a read-aloud task: nobody is given a Finnish sentence to say. |
| Semi-structured task | An open prompt, for example about the place where the participant grew up, with optional follow-up questions. | A balance between comparability and naturalistic speech. One task can produce several utterances (the main answer and one per follow-up). |
| Free speech | An invitation to speak about anything, with a suggested duration, optional topic suggestions and a reminder not to name other people. | Ecological richness. Free speech is **exploratory**: it is not the controlled comparison of the study and must not be used as the only causal evidence. |

**Follow-ups are predefined.** In Research Mode a follow-up question is a text written by the researchers in the protocol. No language model generates or selects follow-ups from the participant's previous answer (spec 7.2, 82). Otherwise the elicitation context would itself depend on a model and would differ systematically between participants.

**Order of the session** (spec 6, 167): welcome, information and consent, microphone check, instructions, speaking tasks, background questionnaire, post-recording questionnaire, debrief. The sociolinguistic self-description is collected **after** the speaking tasks, so that questions about region and dialect do not prime the speech.

The exact prompt text shown for each utterance is stored with the utterance (`utterances.prompt_snapshot`), and every session is pinned to the protocol version it started with (`docs/PROTOCOL-VERSIONING.md`).

## 5. Ordering and randomization

A protocol groups tasks into blocks. Each block has an order mode (spec 8):

- `fixed`: tasks in the configured order;
- `shuffle_within_block`: a random order of the tasks in the block.

A typical design is a shuffled block of controlled tasks followed by fixed semi-structured and free speech blocks.

The random order is reproducible: it comes from a deterministic generator seeded from the session, and the resulting sequence is **stored** when the participant acknowledges the instructions (`task_presentations`, one row per task with its position). The order a participant saw is always read from these rows and never reconstructed from the protocol configuration (`packages/research/src/sessions/ordering.ts`, tests in `ordering.test.ts`; `docs/PARTICIPANT-API.md`, "Task order").

Balanced-order designs (for example Latin squares) are named by the specification as a later extension and are not built.

## 6. Transcript representations: A, A*, B, C

Each accepted source utterance can have four Finnish text representations (spec 16). They are stored independently, each with its own revision history.

| | What it is | Who produces it | Role |
|---|---|---|---|
| **A** | Automatic ASR transcript | The configured ASR model | The raw output, stored exactly as returned. Immutable as a model output. |
| **A\*** | ASR transcript with recognition errors corrected | A human, who corrects misrecognitions and deliberately leaves the ASR's normalization in place | Optional, for a diagnostic subset. A to A* approximately isolates recognition errors; A* to B helps to study normalization. |
| **B** | Human dialect-preserving transcript | A researcher who listens to the audio and keeps relevant non-standard forms according to the study's transcription conventions | The reference for what was said, in the form it was said. Not generated by a language model in the research dataset. |
| **C** | Minimally normalized transcript | A researcher, derived from B | A control representation: selected regional or non-standard forms are normalized, propositional content and discourse events are kept, and the utterance is not rewritten into a new composition. A preservation-aware translation should not invent regional or social characteristics that C does not contain. |

Rules in the software:

- A human correction never changes a stored text. It creates a new revision; every earlier revision stays, and exactly one revision is current (spec 18).
- B and C can be marked verified. A verified transcript that is edited afterwards gets a new, unverified revision.
- The ASR transcript cannot be edited at all. A new ASR run adds a revision.
- Differences between representations can be coded on the Review page (spec 19). The version of the transcription convention and of the annotation scheme in force is stored with each revision and annotation.
- Evaluating a dialectal transcription against a standard-language ASR reference is not neutral. That is a warning for the analysis, not something the platform decides.

## 7. Translation conditions and the translation matrix

Two translation conditions exist in the seed, both as editable, versioned prompts (spec 20):

- **default**: a deliberately ordinary instruction to translate the Finnish utterance into natural spoken English and preserve its meaning;
- **preservation-aware**: an instruction to preserve propositional meaning and communicatively relevant differences in register, informality, stance, politeness, discourse organization, idiomatic force, humour and emphasis when the source supports them, with natural English equivalents; not to assign a named English regional dialect, not to add stereotypical dialect markers, and not to invent information, emotion or social meaning.

The core processing matrix (spec 21) is a within-utterance design:

```text
                     default        preservation-aware
A   (ASR)               x                  x
B   (human)             x                  x
C   (normalized)        x                  x
A*  (optional)          x                  x
```

- Each cell is a separate model run with its own provenance record.
- The same utterance therefore yields several translations. They differ only in the input representation and the condition, so differences between them can be attributed to one of the two.
- A new prompt or model is a new processing batch. Earlier outputs are never overwritten (spec 21, 54).
- An empty, refused or cut-off translation is recorded as a failed run and is not retried automatically, because retrying until a usable output appears would select outputs in a hidden way (`docs/IMPLEMENTATION-STATUS.md`, "Deviations").

Mapping a Finnish regional dialect to a named English regional dialect is not a goal and is discouraged by the preservation-aware prompt.

## 8. TTS baseline: one fixed voice

Synthesis is downstream of the translated text. The baseline uses **one voice, one synthesis model and one set of synthesis instructions for all translation conditions**, with WAV output where available (spec 22).

Reason: if the translation condition changes and the voice changes too, linguistic and acoustic effects are confounded. Holding the synthesis constant means that differences between synthesized outputs come from the translated text.

Consequences in the software:

- A batch uses one TTS configuration (the active `tts_baseline`) for every translation it synthesizes, and stores the exact text that was synthesized.
- Voice cloning is not built.
- The main study cannot attribute a loss of prosody to TTS alone, because the transcript step has already removed acoustic information. A separate controlled subexperiment, the same English text synthesized in a neutral and an expressive way, is foreseen by the schema (several syntheses per translation) and is not built (spec 23).
- A black-box speech-to-speech condition (spec 24) is also not built. If added, it must be stored as its own condition and never used to infer where internal losses happened.

## 9. Scientific invariants and where they are enforced

The twelve invariants of spec 110. Each is enforced in the service layer, most of them also by database constraints or triggers, and each has tests. One test file walks all twelve against a real database: `packages/research/src/integration/invariants.integration.test.ts` (its sections are numbered like this table).

| # | Invariant | Enforced by | Further tests |
|---|---|---|---|
| 1 | A published protocol never mutates. | Protocol services refuse changes to a published version; triggers on protocol, task, follow-up, consent and questionnaire tables (`packages/db/migrations/0002_immutability_triggers.sql`); sessions are pinned to their version. | `packages/db/src/invariants.test.ts`, `packages/research/src/protocols/publish.test.ts`, `versions.test.ts` |
| 2 | A stored source recording never mutates. | Storage drivers never overwrite an existing key; triggers on `media_assets` and on the accepted link of an utterance; SHA-256 stored at upload. | `packages/storage/src/drivers/*.test.ts`, `packages/research/src/sessions/sessions.upload.test.ts` |
| 3 | A model output never mutates. | No service edits ASR text, translation text, synthesis text or a finished model run; triggers refuse updates and deletes. Only the review status of an output can change. | `packages/db/src/invariants.test.ts`, `packages/research/src/processing/steps.test.ts` |
| 4 | Human corrections create revisions. | The transcript service inserts a new revision and moves the "current" marker; a unique index allows one current revision. | `packages/research/src/transcripts/revisions.test.ts` |
| 5 | Every derived output traces to a source and a configuration. | Required foreign keys from translations and syntheses to the source revision, the model run, the batch and the model configuration; the batch snapshot holds the prompt text. | `packages/research/src/processing/batches.test.ts`, `handlers.test.ts` |
| 6 | TEST and DEMO data never enter a research export by default. | One selection function for every export, with research-only defaults; batches have one data mode. | `packages/research/src/exports/exports.test.ts`, `apps/web/app/api/admin/export/route.test.ts` |
| 7 | A new model or prompt experiment creates a new processing batch. | The configuration snapshot of a batch is frozen when it leaves draft (service and trigger); idempotency keys include the batch. | `packages/research/src/processing/batches.test.ts` |
| 8 | Participant speech collection does not depend on AI availability. | Submission enqueues jobs in a savepoint; a queue or provider failure never fails the submission; the app starts without an API key. | `packages/research/src/sessions/sessions.enqueue-failure.test.ts` |
| 9 | Research Mode never exposes AI output to the participant during speech collection. The output review after the last task is the one exception (section 3). | The participant state builder does not read transcript, translation or synthesis tables, except `sessions/output-review.ts` for the step `output_review`; participant modules cannot import admin code or the AI package. | `apps/web/app/study/research-mode.test.ts`, `packages/research/src/sessions/sessions.flow.test.ts`, `packages/research/src/sessions/sessions.review.test.ts`, `apps/web/e2e/participant.spec.ts` |
| 10 | Audio is never publicly addressable. | Media are served only by id through admin routes with the admin session; no storage key or URL in any participant payload; the storage root is outside `public/`. | `apps/web/app/api/admin/media/media.test.ts`, `packages/research/src/corpus/media.test.ts` |
| 11 | No permanent provider key reaches browser code. | The environment module imports `server-only`; no `NEXT_PUBLIC_` variable; the AI package never reads the environment. | `packages/ai/src/source-rules.test.ts`; `docs/DEPLOYMENT.md`, section 9 |
| 12 | The admin can inspect exactly what happened to any utterance. | The lineage read model and Session Detail show failed runs, retries and final outputs with their configuration. | `packages/research/src/corpus/sessions.test.ts`, `docs/AI-PROVENANCE.md`, "Lineage read model" |

The data model behind these rules is described in `docs/DATA-MODEL.md`.

## 10. Recommended research workflow

The workflow of spec 150, and where each step happens in the admin:

```text
collect source corpus              participant flow; Dashboard and Sessions to follow progress
   -> ASR available                automatic after upload (study setting) or an ASR batch on Processing Runs
   -> human B and C transcription  Review & Transcription
   -> verification                 Review & Transcription (mark verified)
   -> lock the evaluation subset   decide which sessions, utterances and transcript types enter the batch
   -> translation batch            Processing Runs: new batch, default and preservation-aware, then TTS
   -> export                       Data & Export: dataset package with manifest
```

- A new batch selects **verified transcripts only** by default, research data only, completed sessions only, and leaves flagged and excluded data out (`docs/AI-PROVENANCE.md`, "Creating a batch"). A is a model output and is always eligible.
- Do the quality work before the translation batch: listen, flag, exclude with a reason. Exclusion keeps the data and its provenance; inconvenient outputs are never deleted (`docs/ADMIN.md`, "Flag, exclusion and deletion").
- The Dashboard shows operational health only. It shows no comparison of translation conditions and no effect sizes, on purpose: looking at outcomes during collection invites stopping early or changing the protocol (spec 42, 154). Analysis happens on exported data.
- Do not change the active protocol, prompts or model configurations silently during collection. Every change is a new version, and the audit log records who activated what and when.
- Model names are aliases that a provider can repoint. Every model run stores the requested model, the model the provider reported, the time and the request id, so that a later reader knows what actually ran (spec 27).

## 11. What remains configurable

Nothing scientific is fixed in code (spec 143, 166). The researchers set, in the admin:

| Decision | Where |
|---|---|
| Participant-facing study title (separate from the internal study name) | Settings (audited, not versioned) |
| Welcome, information sheet, instructions, debrief, contact details | Study Flow (versioned) |
| Consent text and consent items, privacy notice URL | Study Flow, consent editor (versioned) |
| Number of tasks, task prompts, follow-ups, blocks and order mode | Study Flow (versioned) |
| Duration limits per task | Study Flow; general limits in Settings |
| Background and post-recording questionnaires | Questionnaires (versioned) |
| Models, their parameters, the TTS voice | AI Pipeline, model configurations (versioned) |
| Prompts for ASR context, translation conditions and TTS instructions | AI Pipeline, prompt versions (versioned) |
| Processing conditions and which transcript types are processed | Processing Runs, per batch |
| Source and target language | Settings |
| Participant-facing languages | Settings, limited to the interface dictionaries (`apps/web/lib/i18n`); study texts are stored once per protocol version |
| Automatic ASR after upload, study laptop mode, Demo Mode access, admin time zone | Settings |
| Retention policy and future reuse scopes | Not decided in software. Consent items can record a reuse choice; the retention rule itself belongs to the data management plan (`docs/PRIVACY-IMPLEMENTATION-NOTES.md`). |

The seed data exist only to start development. Its participant texts are examples in English, marked "[Example text, to be replaced by the research team.]", and must be replaced before data collection. The software enforces this in three places: the seed creates the study with "Allow new sessions" off; a protocol version that still contains example text cannot be published (`example_text_present`); and research sessions are refused while the current protocol contains example text (`protocols.currentProtocolHasExampleText`). TEST and DEMO sessions stay possible. The seeded follow-up of the semi-structured task is the neutral example of spec 7.2, not the example of spec 92 that asks how people speak (`docs/IMPLEMENTATION-STATUS.md`, Deviations).

## 12. What is fixed by design

Unless the researchers explicitly redesign the study, these are not open (spec 167):

- Research Mode hides AI output during speech collection.
- Controlled tasks elicit spontaneous responses. They are not read-aloud scripts.
- Semi-structured follow-ups are predefined in this version.
- Free speech is exploratory.
- Sociolinguistic self-description is collected after the speech tasks.
- Source audio is immutable.
- A, B and C are represented independently.
- Human B and C transcripts are not silently generated by a language model.
- Translation conditions are separate model runs.
- TTS uses the same baseline configuration across the core translation conditions.
- Published protocols, prompts and configurations are versioned and immutable.
- TEST and DEMO data are excluded by default.
- Audio is stored outside PostgreSQL.
- PostgreSQL stores structure and provenance.
- Every derived output traces to its exact parent.

## 13. What is deliberately not built

Non-goals of this version (spec 165). Their absence is a decision, not a gap:

- general user accounts, a participant login, social profiles;
- a multi-tenant service, billing;
- a chat history interface for participants;
- live AI-generated follow-up questions in Research Mode;
- voice cloning;
- a real-time dialect classifier, an automatic "authenticity score", any automatic decision that a participant belongs to a dialect;
- a full annotation platform in the manner of ELAN;
- a statistical analysis dashboard;
- a public dataset portal and public audio hosting.

Planned as later research extensions and prepared only in the data model (spec 161, Phase 8): the TTS factorial subexperiment, a listener study, source-speaker evaluation, advanced annotation and an inter-rater workflow, a dialect lexicon intervention, fine-tuned models, a black-box speech-to-speech comparison, automatic acoustic metrics, and a manager for speaker-independent data splits.

## 14. Methodological warnings

The twenty warnings of Appendix D are reproduced in the repository `README.md` and should be read before working with the data. The ones that most often matter when interpreting results: standardization is not automatically "dialect loss"; a regional self-label is not the only linguistic truth; informality is not regional dialect; a model must not be rewarded for adding conspicuous dialect markers; TTS must not be blamed for prosody that was lost before synthesis; and free speech must not be the only causal evidence.
