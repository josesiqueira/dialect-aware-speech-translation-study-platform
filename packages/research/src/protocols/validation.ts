// The publish check of a protocol version (spec 49). It returns a list of
// problems. An error blocks publishing. A warning is a methodological note:
// the researcher reads it and decides.
//
// The wording checks are deliberately a short list of plain text searches.
// They cannot judge wording, they only point at passages a researcher should
// read again before data collection (spec 6.1, 6.4).
import { asc, eq } from "drizzle-orm";
import {
  consentVersions,
  questionnaireItems,
  questionnaireVersions,
  studies,
  type DbOrTx,
} from "@dialect/db";
import { protocolSchemas, translatedTexts } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { participantTitleSetting, participantTitleTranslationsSetting } from "./participant-title";
import {
  loadProtocol,
  loadTasks,
  type ConsentVersionRow,
  type ProtocolVersionRow,
  type TaskWithFollowups,
} from "./shared";

export type ProtocolProblem = protocolSchemas.ProtocolProblem;

// The translated texts of one row as one checked text, or null when it has none.
function translationsText(translations: unknown): string | null {
  const texts = translatedTexts(translations);
  return texts.length > 0 ? texts.join("\n") : null;
}

export type ProtocolValidation = {
  protocolVersionId: string;
  // True when there is no error. Warnings do not block publishing.
  canPublish: boolean;
  errors: ProtocolProblem[];
  warnings: ProtocolProblem[];
};

// Plain wording checks on every text a participant reads before the last
// speech task: the participant-facing study title, the welcome, information and
// instruction texts, the consent form, and the texts of every enabled task.
// Matching ignores letter case. The Finnish stems cover the inflected forms of
// "murre" (murteen, murteella, murteita and so on).
//
// The debrief text and the questionnaires are exempt. They are shown after the
// speech tasks, and the questionnaires ask about dialect on purpose (spec 11, 12).
export const PRIMING_CHECKS: ReadonlyArray<{
  code: string;
  // Any of these substrings triggers the warning.
  terms: readonly string[];
  specRef: string;
  explanation: string;
}> = [
  {
    code: "wording_mentions_dialect",
    terms: ["dialect", "murre", "murtee", "murteel", "murteit", "murte"],
    specRef: "6.4",
    explanation:
      "mentions dialect before the speech tasks. Naming dialect can change how participants speak. Prefer wording such as \"speak the way you normally would\"",
  },
  {
    code: "wording_states_hypothesis",
    terms: ["we believe", "we expect", "we think that", "hypothes", "uskomme", "oletamme", "hypotees"],
    specRef: "6.1",
    explanation:
      "may state what the researchers expect to find. A directional hypothesis primes participants. Describe the study truthfully without the expected result",
  },
  {
    code: "wording_asks_for_marked_speech",
    terms: ["as strongly as", "strongly as possible", "exaggerate", "mahdollisimman vahva", "liioittel"],
    specRef: "6.4",
    explanation:
      "may ask participants to speak in a marked or exaggerated way. The study needs natural speech",
  },
];

export type PrimingFinding = { code: string; specRef: string; term: string; message: string };

// The priming checks on one text. `label` starts the message, for example
// "The welcome text". Used by the publish check and by the Settings page for
// the participant-facing title.
export function primingFindings(label: string, text: string | null | undefined): PrimingFinding[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const findings: PrimingFinding[] = [];
  for (const check of PRIMING_CHECKS) {
    const term = check.terms.find((candidate) => lower.includes(candidate));
    if (!term) continue;
    findings.push({
      code: check.code,
      specRef: check.specRef,
      term,
      message: `${label} ${check.explanation} (found "${term}", spec ${check.specRef}).`,
    });
  }
  return findings;
}

const REQUIRED_CONTENT: ReadonlyArray<{
  field: "welcomeContent" | "informationContent" | "instructionContent" | "debriefContent";
  label: string;
}> = [
  { field: "welcomeContent", label: "Welcome text" },
  { field: "informationContent", label: "Participant information text" },
  { field: "instructionContent", label: "Study instructions" },
  { field: "debriefContent", label: "Debrief text" },
];

function taskName(task: TaskWithFollowups, position: number): string {
  const name = task.internalName?.trim() || task.title.trim() || task.taskKey;
  return `Task ${position} (${name})`;
}

function checkTasks(protocol: ProtocolVersionRow, tasks: TaskWithFollowups[], problems: ProtocolProblem[]): void {
  const error = (problem: Omit<ProtocolProblem, "severity">) => problems.push({ severity: "error", ...problem });
  const warning = (problem: Omit<ProtocolProblem, "severity">) => problems.push({ severity: "warning", ...problem });

  const blocks = protocol.orderConfigJson?.blocks ?? [];
  const blockKeys = blocks.map((block) => block.key);
  const duplicateBlocks = blockKeys.filter((key, index) => blockKeys.indexOf(key) !== index);
  if (duplicateBlocks.length > 0) {
    error({
      code: "block_key_duplicate",
      field: "orderConfig",
      message: `The block key "${duplicateBlocks[0]}" is listed more than once under Task blocks.`,
    });
  }

  if (!tasks.some((task) => task.enabled)) {
    error({
      code: "no_enabled_task",
      field: "tasks",
      message: "The protocol has no enabled task. Add or enable at least one task.",
    });
  }

  for (const [index, task] of tasks.entries()) {
    const name = taskName(task, index + 1);
    const ref = { taskId: task.id, taskKey: task.taskKey };

    if (!blockKeys.includes(task.blockKey)) {
      error({
        ...ref,
        code: "task_block_missing",
        message: `${name} is in the block "${task.blockKey}", which is not listed under Task blocks.`,
      });
    }
    if (!task.enabled) continue;

    if (!task.title.trim()) {
      error({ ...ref, code: "task_title_missing", message: `${name} has no participant-facing title.` });
    }
    if (!task.participantPrompt.trim()) {
      error({ ...ref, code: "task_prompt_missing", message: `${name} has no prompt.` });
    }

    const { minDurationSeconds: min, suggestedDurationSeconds: suggested, maxDurationSeconds: max } = task;
    if (max !== null && max <= 0) {
      error({ ...ref, code: "task_duration_inconsistent", message: `${name}: the maximum duration must be above zero.` });
    }
    if (min !== null && max !== null && min > max) {
      error({
        ...ref,
        code: "task_duration_inconsistent",
        message: `${name}: the minimum duration (${min} s) is longer than the maximum duration (${max} s).`,
      });
    }
    if (suggested !== null && max !== null && suggested > max) {
      error({
        ...ref,
        code: "task_duration_inconsistent",
        message: `${name}: the suggested duration (${suggested} s) is longer than the maximum duration (${max} s).`,
      });
    }
    if (suggested !== null && min !== null && suggested < min) {
      error({
        ...ref,
        code: "task_duration_inconsistent",
        message: `${name}: the suggested duration (${suggested} s) is shorter than the minimum duration (${min} s).`,
      });
    }

    for (const followup of task.followups) {
      if (followup.enabled && !followup.promptText.trim()) {
        error({
          ...ref,
          code: "followup_prompt_missing",
          message: `${name}: the follow-up "${followup.followupKey}" has no text.`,
        });
      }
    }

    if (task.taskType === "free_speech" && !task.privacyReminder) {
      warning({
        ...ref,
        code: "free_speech_without_privacy_reminder",
        specRef: "7.3",
        message: `${name} is a free speech task without the privacy reminder. Free speech can contain names and other identifying details (spec 7.3).`,
      });
    }
  }

  for (const block of blocks) {
    if (block.orderMode !== "shuffle_within_block") continue;
    const enabledInBlock = tasks.filter((task) => task.enabled && task.blockKey === block.key).length;
    if (enabledInBlock === 1) {
      warning({
        code: "shuffle_block_single_task",
        field: "orderConfig",
        specRef: "8",
        message: `The block "${block.title || block.key}" is set to random order but has one enabled task, so nothing is randomized (spec 8).`,
      });
    }
  }
}

// One text of the study definition, with the name the researcher knows it by.
type StudyText = {
  field: string;
  // Starts a sentence: "The welcome text".
  label: string;
  text: string | null | undefined;
  taskId?: string;
  taskKey?: string;
  // True when the participant reads it before the last speech task.
  beforeSpeech: boolean;
};

type QuestionnaireTexts = {
  slot: "background" | "post-recording" | "post-review";
  version: typeof questionnaireVersions.$inferSelect;
  items: Array<typeof questionnaireItems.$inferSelect>;
};

// Every text of a protocol version and of the consent and questionnaire
// versions it selects, plus the participant-facing study title. Disabled tasks
// and disabled follow-ups are left out: participants never see them.
function collectStudyTexts(input: {
  protocol: ProtocolVersionRow;
  tasks: TaskWithFollowups[];
  consent: ConsentVersionRow | null;
  questionnaires: QuestionnaireTexts[];
  participantTitle: string | null;
}): StudyText[] {
  const { protocol, tasks, consent } = input;
  const texts: StudyText[] = [
    {
      field: "participantTitle",
      label: "The participant-facing study title (Settings)",
      text: input.participantTitle,
      beforeSpeech: true,
    },
    { field: "name", label: "The protocol name", text: protocol.name, beforeSpeech: false },
    { field: "description", label: "The protocol description", text: protocol.description, beforeSpeech: false },
    { field: "welcomeContent", label: "The welcome text", text: protocol.welcomeContent, beforeSpeech: true },
    {
      field: "informationContent",
      label: "The participant information text",
      text: protocol.informationContent,
      beforeSpeech: true,
    },
    {
      field: "instructionContent",
      label: "The study instructions",
      text: protocol.instructionContent,
      beforeSpeech: true,
    },
    { field: "debriefContent", label: "The debrief text", text: protocol.debriefContent, beforeSpeech: false },
    {
      field: "translations",
      label: "A translated protocol text",
      text: translationsText(protocol.translationsJson),
      beforeSpeech: true,
    },
  ];

  if (consent) {
    const name = `consent v${consent.versionNumber}`;
    texts.push(
      { field: "consent.title", label: `The title of ${name}`, text: consent.title, beforeSpeech: true },
      {
        field: "consent.informationText",
        label: `The information text of ${name}`,
        text: consent.informationText,
        beforeSpeech: true,
      },
      {
        field: "consent.contactText",
        label: `The contact text of ${name}`,
        text: consent.contactText,
        beforeSpeech: true,
      },
    );
    texts.push({
      field: "consent.translations",
      label: `A translated text of ${name}`,
      text: translationsText(consent.translationsJson),
      beforeSpeech: true,
    });
    for (const item of consent.itemsJson ?? []) {
      texts.push({
        field: `consent.items.${item.id}`,
        label: `The consent item "${item.id}" of ${name}`,
        text: item.text,
        beforeSpeech: true,
      });
    }
  }

  for (const [index, task] of tasks.entries()) {
    if (!task.enabled) continue;
    const name = taskName(task, index + 1);
    const ref = { taskId: task.id, taskKey: task.taskKey };
    texts.push(
      { ...ref, field: "task.internalName", label: `The internal name of ${name}`, text: task.internalName, beforeSpeech: false },
      { ...ref, field: "task.title", label: `The title of ${name}`, text: task.title, beforeSpeech: true },
      { ...ref, field: "task.participantPrompt", label: `The prompt of ${name}`, text: task.participantPrompt, beforeSpeech: true },
      { ...ref, field: "task.contextText", label: `The context text of ${name}`, text: task.contextText, beforeSpeech: true },
      { ...ref, field: "task.instructionsText", label: `The instructions of ${name}`, text: task.instructionsText, beforeSpeech: true },
      { ...ref, field: "task.researcherNotes", label: `The researcher notes of ${name}`, text: task.researcherNotes, beforeSpeech: false },
      { ...ref, field: "task.translations", label: `A translated text of ${name}`, text: translationsText(task.translationsJson), beforeSpeech: true },
    );
    for (const followup of task.followups) {
      if (!followup.enabled) continue;
      texts.push({
        ...ref,
        field: `task.followups.${followup.followupKey}`,
        label: `The follow-up "${followup.followupKey}" of ${name}`,
        text: followup.promptText,
        beforeSpeech: true,
      });
      texts.push({
        ...ref,
        field: `task.followups.${followup.followupKey}.translations`,
        label: `The translated follow-up "${followup.followupKey}" of ${name}`,
        text: translationsText(followup.translationsJson),
        beforeSpeech: true,
      });
    }
    for (const [position, suggestion] of (task.configJson?.topicSuggestions ?? []).entries()) {
      texts.push({
        ...ref,
        field: `task.topicSuggestions.${position}`,
        label: `Topic suggestion ${position + 1} of ${name}`,
        text: suggestion,
        beforeSpeech: true,
      });
    }
  }

  for (const { slot, version, items } of input.questionnaires) {
    const name = `the ${slot} questionnaire v${version.versionNumber}`;
    const prefix = `questionnaire.${version.key}`;
    texts.push(
      { field: `${prefix}.name`, label: `The name of ${name}`, text: version.name, beforeSpeech: false },
      { field: `${prefix}.description`, label: `The description of ${name}`, text: version.description, beforeSpeech: false },
      {
        field: `${prefix}.translations`,
        label: `A translated text of ${name}`,
        text: translationsText(version.translationsJson),
        beforeSpeech: false,
      },
    );
    for (const item of items) {
      texts.push({
        field: `${prefix}.items.${item.itemKey}`,
        label: `The item "${item.itemKey}" of ${name}`,
        // Prompt, help text and the option and scale labels of the item.
        text: [
          item.prompt,
          item.helpText ?? "",
          JSON.stringify(item.configJson ?? {}),
          translationsText(item.translationsJson) ?? "",
        ].join("\n"),
        beforeSpeech: false,
      });
    }
  }
  return texts;
}

// Loads what collectStudyTexts needs for one protocol version.
async function loadStudyTexts(db: DbOrTx, protocol: ProtocolVersionRow, tasks: TaskWithFollowups[]): Promise<StudyText[]> {
  const [study] = await db.select().from(studies).where(eq(studies.id, protocol.studyId));
  let consent: ConsentVersionRow | null = null;
  if (protocol.consentVersionId) {
    const [row] = await db.select().from(consentVersions).where(eq(consentVersions.id, protocol.consentVersionId));
    consent = row ?? null;
  }
  const questionnaires: QuestionnaireTexts[] = [];
  const slots = [
    { slot: "background" as const, id: protocol.backgroundQuestionnaireVersionId },
    { slot: "post-recording" as const, id: protocol.postQuestionnaireVersionId },
    { slot: "post-review" as const, id: protocol.postReviewQuestionnaireVersionId },
  ];
  for (const { slot, id } of slots) {
    if (!id) continue;
    const [version] = await db.select().from(questionnaireVersions).where(eq(questionnaireVersions.id, id));
    if (!version) continue;
    const items = await db
      .select()
      .from(questionnaireItems)
      .where(eq(questionnaireItems.questionnaireVersionId, id))
      .orderBy(asc(questionnaireItems.orderIndex));
    questionnaires.push({ slot, version, items });
  }
  return collectStudyTexts({
    protocol,
    tasks,
    consent,
    questionnaires,
    // The title and its translations.
    participantTitle: study
      ? [participantTitleSetting(study.settingsJson), ...Object.values(participantTitleTranslationsSetting(study.settingsJson))]
          .filter((title): title is string => title !== null)
          .join("\n") || null
      : null,
  });
}

// Wording warnings on every text shown before the last speech task. The
// debrief text and the questionnaires are not checked: they come after the
// speech tasks, and the questionnaires ask about dialect on purpose.
function checkWording(texts: StudyText[], problems: ProtocolProblem[]): void {
  for (const entry of texts) {
    if (!entry.beforeSpeech) continue;
    for (const finding of primingFindings(entry.label, entry.text)) {
      problems.push({
        severity: "warning",
        code: finding.code,
        field: entry.field,
        ...(entry.taskId ? { taskId: entry.taskId, taskKey: entry.taskKey } : {}),
        specRef: finding.specRef,
        message: finding.message,
      });
    }
  }
}

export type ExampleTextField = { field: string; label: string; taskId?: string; taskKey?: string };

function exampleTextFields(texts: StudyText[]): ExampleTextField[] {
  return texts
    .filter((entry) => protocolSchemas.containsExampleText(entry.text))
    .map(({ field, label, taskId, taskKey }) => ({ field, label, ...(taskId ? { taskId, taskKey } : {}) }));
}

// Example text from the development seed must never reach a participant of the
// real study (spec 91, 143). One error per field that still carries a marker.
function checkExampleText(texts: StudyText[], problems: ProtocolProblem[]): void {
  for (const entry of exampleTextFields(texts)) {
    problems.push({
      severity: "error",
      code: "example_text_present",
      field: entry.field,
      ...(entry.taskId ? { taskId: entry.taskId, taskKey: entry.taskKey } : {}),
      message: `${entry.label} still contains example text. Replace it with the approved study text.`,
    });
  }
}

export const EXAMPLE_TEXT_STATUS_MESSAGE =
  "The current protocol still contains example text; research sessions are disabled until it is replaced.";

export type CurrentProtocolExampleText = {
  // True when the protocol that new sessions receive, its consent version, its
  // questionnaires or the participant-facing title still carry an example marker.
  present: boolean;
  protocolVersionId: string | null;
  versionNumber: number | null;
  fields: ExampleTextField[];
};

// The example text left in the study's current protocol. Shown on the
// Dashboard and on the Settings page.
export async function currentProtocolExampleText(
  ctx: ServiceContext,
  studyId: string,
): Promise<CurrentProtocolExampleText> {
  const [study] = await ctx.db.select().from(studies).where(eq(studies.id, studyId));
  if (!study?.currentProtocolVersionId) {
    return { present: false, protocolVersionId: null, versionNumber: null, fields: [] };
  }
  const protocol = await loadProtocol(ctx.db, study.currentProtocolVersionId);
  const tasks = await loadTasks(ctx.db, protocol);
  const fields = exampleTextFields(await loadStudyTexts(ctx.db, protocol, tasks));
  return {
    present: fields.length > 0,
    protocolVersionId: protocol.id,
    versionNumber: protocol.versionNumber,
    fields,
  };
}

// The guard for research sessions: true while the current protocol still
// contains example text. Session creation calls this for mode "research" and
// refuses the session. TEST and DEMO sessions are not affected, so development
// and the seeded sample sessions keep working.
// ALLOW_EXAMPLE_TEXT_SESSIONS=true turns the guard off, for a demo deployment
// that shows the participant flow with the seeded example texts.
export async function currentProtocolHasExampleText(ctx: ServiceContext, studyId: string): Promise<boolean> {
  if ((process.env.ALLOW_EXAMPLE_TEXT_SESSIONS ?? "").trim().toLowerCase() === "true") return false;
  return (await currentProtocolExampleText(ctx, studyId)).present;
}

// Runs every check against the stored state. Pass a transaction to validate
// inside the publish transaction.
export async function validateProtocol(db: DbOrTx, id: string): Promise<ProtocolValidation> {
  const protocol = await loadProtocol(db, id);
  const tasks = await loadTasks(db, protocol);
  const problems: ProtocolProblem[] = [];
  const error = (problem: Omit<ProtocolProblem, "severity">) => problems.push({ severity: "error", ...problem });
  const warning = (problem: Omit<ProtocolProblem, "severity">) => problems.push({ severity: "warning", ...problem });

  if (!protocol.name.trim()) {
    error({ code: "name_missing", field: "name", message: "The protocol has no name." });
  }
  for (const { field, label } of REQUIRED_CONTENT) {
    if (!protocol[field].trim()) {
      error({ code: "content_missing", field, message: `${label} is empty.` });
    }
  }

  if (!protocol.consentVersionId) {
    error({ code: "consent_missing", field: "consentVersionId", message: "No consent version is selected." });
  } else {
    const [consent] = await db
      .select()
      .from(consentVersions)
      .where(eq(consentVersions.id, protocol.consentVersionId));
    if (!consent || consent.studyId !== protocol.studyId) {
      error({
        code: "consent_missing",
        field: "consentVersionId",
        message: "The selected consent version does not exist in this study.",
      });
    } else if (consent.publishedAt === null) {
      error({
        code: "consent_not_published",
        field: "consentVersionId",
        message: `Consent v${consent.versionNumber} is still a draft. Publish the consent version first.`,
      });
    }
  }

  const questionnaireSlots = [
    {
      field: "backgroundQuestionnaireVersionId",
      id: protocol.backgroundQuestionnaireVersionId,
      key: protocolSchemas.BACKGROUND_QUESTIONNAIRE_KEY,
      label: "background questionnaire",
      specRef: "11",
    },
    {
      field: "postQuestionnaireVersionId",
      id: protocol.postQuestionnaireVersionId,
      key: protocolSchemas.POST_QUESTIONNAIRE_KEY,
      label: "post-recording questionnaire",
      specRef: "12",
    },
    {
      field: "postReviewQuestionnaireVersionId",
      id: protocol.postReviewQuestionnaireVersionId,
      key: protocolSchemas.POST_REVIEW_QUESTIONNAIRE_KEY,
      label: "post-review questionnaire",
      // docs/RESEARCH-DESIGN.md, section 3: the questionnaire after the output review.
      specRef: "12",
      // The output review is optional, so its questionnaire is too: no warning when none is selected.
      optional: true,
    },
  ];
  for (const slot of questionnaireSlots) {
    if (!slot.id) {
      if ("optional" in slot && slot.optional) continue;
      warning({
        code: "questionnaire_not_selected",
        field: slot.field,
        specRef: slot.specRef,
        message: `No ${slot.label} is selected. Participants will not see one (spec ${slot.specRef}).`,
      });
      continue;
    }
    const [version] = await db.select().from(questionnaireVersions).where(eq(questionnaireVersions.id, slot.id));
    if (!version || version.studyId !== protocol.studyId) {
      error({
        code: "questionnaire_missing",
        field: slot.field,
        message: `The selected ${slot.label} does not exist in this study.`,
      });
    } else if (version.status !== "published") {
      error({
        code: "questionnaire_not_published",
        field: slot.field,
        message: `The selected ${slot.label} (v${version.versionNumber}) is ${version.status}. Select a published version.`,
      });
    } else if (version.key !== slot.key) {
      error({
        code: "questionnaire_wrong_key",
        field: slot.field,
        message: `The selected ${slot.label} has the key "${version.key}", expected "${slot.key}".`,
      });
    }
  }

  checkTasks(protocol, tasks, problems);
  const texts = await loadStudyTexts(db, protocol, tasks);
  checkExampleText(texts, problems);
  checkWording(texts, problems);

  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");
  return { protocolVersionId: id, canPublish: errors.length === 0, errors, warnings };
}

// The list of problems that publishing this version would meet (spec 49).
export async function validateProtocolForPublish(ctx: ServiceContext, id: string): Promise<ProtocolValidation> {
  return validateProtocol(ctx.db, id);
}
