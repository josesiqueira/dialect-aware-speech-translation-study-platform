// Difference between two protocol versions (spec 141), as structured data that
// the Study Flow page renders before publishing. Tasks are matched by task_key,
// follow-ups by followup_key, which both stay the same when a version is cloned.
import { diffWordsWithSpace } from "diff";
import type { OrderMode, PublicationStatus } from "@dialect/domain";
import type { DbOrTx } from "@dialect/db";
import type { ServiceContext } from "../context";
import { loadProtocolDetail, type ProtocolDetail, type TaskWithFollowups } from "./shared";

// One piece of a word-level text comparison. Unmarked pieces are unchanged.
export type TextDiffPart = { value: string; added?: true; removed?: true };

export type TextChange = {
  field: string;
  label: string;
  before: string;
  after: string;
  parts: TextDiffPart[];
};

// A changed setting that is not prose (type, durations, flags).
export type ValueChange = {
  field: string;
  label: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
};

export type VersionRef = { id: string; versionNumber: number; name: string; status: PublicationStatus };
export type SelectionRef = { id: string; versionNumber: number; name: string } | null;
export type TaskRef = {
  taskKey: string;
  title: string;
  taskType: string;
  blockKey: string;
  enabled: boolean;
  participantPrompt: string;
  // 1-based position in the presentation order of its version.
  position: number;
};
export type FollowupRef = { followupKey: string; promptText: string; enabled: boolean; isRequired: boolean };

export type TaskDiff = {
  taskKey: string;
  title: string;
  // Set when the task was switched on or off.
  enabledChange: { before: boolean; after: boolean } | null;
  // Old and new prompt text (spec 141), when the prompt changed.
  promptChange: TextChange | null;
  // Title, context and instructions.
  textChanges: TextChange[];
  // Type, durations, privacy reminder, block, follow-up mode and similar.
  valueChanges: ValueChange[];
  followups: {
    added: FollowupRef[];
    removed: FollowupRef[];
    changed: Array<{ followupKey: string; text: TextChange | null; values: ValueChange[] }>;
    reordered: boolean;
  };
};

export type ProtocolDiff = {
  // Null when there is no earlier version to compare with (first publication).
  from: VersionRef | null;
  to: VersionRef;
  hasChanges: boolean;
  // Name, description, welcome, information, instructions, debrief.
  contentChanges: TextChange[];
  consentChange: { before: SelectionRef; after: SelectionRef } | null;
  questionnaireChanges: Array<{
    slot: "background" | "post_recording" | "post_review";
    label: string;
    before: SelectionRef;
    after: SelectionRef;
  }>;
  ordering: {
    changed: boolean;
    blocksChanged: boolean;
    taskOrderChanged: boolean;
    blocksBefore: Array<{ key: string; title: string | null; orderMode: OrderMode }>;
    blocksAfter: Array<{ key: string; title: string | null; orderMode: OrderMode }>;
    // Task keys in presentation order.
    taskOrderBefore: string[];
    taskOrderAfter: string[];
  };
  tasksAdded: TaskRef[];
  tasksRemoved: TaskRef[];
  // Tasks present in both versions whose position among the shared tasks, or
  // whose block, changed.
  tasksReordered: Array<{
    taskKey: string;
    title: string;
    positionBefore: number;
    positionAfter: number;
    blockBefore: string;
    blockAfter: string;
  }>;
  // Tasks present in both versions with any change in content or settings.
  tasksChanged: TaskDiff[];
  summary: {
    contentFieldsChanged: string[];
    tasksAdded: number;
    tasksRemoved: number;
    tasksChanged: number;
    tasksReordered: number;
    tasksEnabledOrDisabled: number;
    followupsChanged: number;
    consentChanged: boolean;
    questionnairesChanged: boolean;
    orderingChanged: boolean;
  };
};

export function diffText(before: string, after: string): TextDiffPart[] {
  return diffWordsWithSpace(before, after).map((part) => ({
    value: part.value,
    ...(part.added ? { added: true as const } : {}),
    ...(part.removed ? { removed: true as const } : {}),
  }));
}

function textChange(field: string, label: string, before: string | null, after: string | null): TextChange | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a === b) return null;
  return { field, label, before: a, after: b, parts: diffText(a, b) };
}

function valueChange(
  field: string,
  label: string,
  before: string | number | boolean | null | undefined,
  after: string | number | boolean | null | undefined,
): ValueChange | null {
  const a = before ?? null;
  const b = after ?? null;
  return a === b ? null : { field, label, before: a, after: b };
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

function versionRef(detail: ProtocolDetail): VersionRef {
  const { id, versionNumber, name, status } = detail.protocol;
  return { id, versionNumber, name, status };
}

function taskRef(task: TaskWithFollowups, position: number): TaskRef {
  return {
    taskKey: task.taskKey,
    title: task.title,
    taskType: task.taskType,
    blockKey: task.blockKey,
    enabled: task.enabled,
    participantPrompt: task.participantPrompt,
    position,
  };
}

function followupRef(followup: TaskWithFollowups["followups"][number]): FollowupRef {
  return {
    followupKey: followup.followupKey,
    promptText: followup.promptText,
    enabled: followup.enabled,
    isRequired: followup.isRequired,
  };
}

function diffTask(before: TaskWithFollowups, after: TaskWithFollowups): TaskDiff | null {
  const promptChange = textChange("participantPrompt", "Prompt", before.participantPrompt, after.participantPrompt);
  const textChanges = [
    textChange("title", "Participant-facing title", before.title, after.title),
    textChange("contextText", "Context", before.contextText, after.contextText),
    textChange("instructionsText", "Instructions", before.instructionsText, after.instructionsText),
  ].filter(present);
  const valueChanges = [
    valueChange("taskType", "Type", before.taskType, after.taskType),
    valueChange("blockKey", "Block", before.blockKey, after.blockKey),
    valueChange("orderMode", "Order mode", before.orderMode, after.orderMode),
    valueChange("minDurationSeconds", "Minimum duration (s)", before.minDurationSeconds, after.minDurationSeconds),
    valueChange(
      "suggestedDurationSeconds",
      "Suggested duration (s)",
      before.suggestedDurationSeconds,
      after.suggestedDurationSeconds,
    ),
    valueChange("maxDurationSeconds", "Maximum duration (s)", before.maxDurationSeconds, after.maxDurationSeconds),
    valueChange("privacyReminder", "Privacy reminder", before.privacyReminder, after.privacyReminder),
    valueChange(
      "followupMode",
      "Follow-up mode",
      before.configJson?.followupMode ?? "always",
      after.configJson?.followupMode ?? "always",
    ),
    valueChange(
      "randomizationEligible",
      "Included in random order",
      before.configJson?.randomizationEligible ?? true,
      after.configJson?.randomizationEligible ?? true,
    ),
    valueChange(
      "topicSuggestions",
      "Topic suggestions",
      (before.configJson?.topicSuggestions ?? []).join("; "),
      (after.configJson?.topicSuggestions ?? []).join("; "),
    ),
  ].filter(present);
  const enabledChange =
    before.enabled === after.enabled ? null : { before: before.enabled, after: after.enabled };

  const beforeKeys = before.followups.map((followup) => followup.followupKey);
  const afterKeys = after.followups.map((followup) => followup.followupKey);
  const added = after.followups.filter((followup) => !beforeKeys.includes(followup.followupKey)).map(followupRef);
  const removed = before.followups.filter((followup) => !afterKeys.includes(followup.followupKey)).map(followupRef);
  const changed: TaskDiff["followups"]["changed"] = [];
  for (const next of after.followups) {
    const previous = before.followups.find((followup) => followup.followupKey === next.followupKey);
    if (!previous) continue;
    const text = textChange("promptText", "Follow-up text", previous.promptText, next.promptText);
    const values = [
      valueChange("enabled", "Enabled", previous.enabled, next.enabled),
      valueChange("isRequired", "Required", previous.isRequired, next.isRequired),
    ].filter(present);
    if (text || values.length > 0) changed.push({ followupKey: next.followupKey, text, values });
  }
  const sharedBefore = beforeKeys.filter((key) => afterKeys.includes(key));
  const sharedAfter = afterKeys.filter((key) => beforeKeys.includes(key));
  const reordered = sharedBefore.join("\n") !== sharedAfter.join("\n");

  const followupsChanged = added.length > 0 || removed.length > 0 || changed.length > 0 || reordered;
  if (!promptChange && textChanges.length === 0 && valueChanges.length === 0 && !enabledChange && !followupsChanged) {
    return null;
  }
  return {
    taskKey: after.taskKey,
    title: after.title || before.title,
    enabledChange,
    promptChange,
    textChanges,
    valueChanges,
    followups: { added, removed, changed, reordered },
  };
}

function consentRef(detail: ProtocolDetail | null): SelectionRef {
  const consent = detail?.consentVersion;
  return consent ? { id: consent.id, versionNumber: consent.versionNumber, name: consent.title } : null;
}

function questionnaireRef(version: ProtocolDetail["backgroundQuestionnaire"] | undefined): SelectionRef {
  return version ? { id: version.id, versionNumber: version.versionNumber, name: version.name } : null;
}

function blocksOf(detail: ProtocolDetail | null) {
  return (detail?.protocol.orderConfigJson?.blocks ?? []).map((block) => ({
    key: block.key,
    title: block.title ?? null,
    orderMode: block.orderMode,
  }));
}

// Pure comparison of two loaded versions. `from` is null for a first publication.
export function compareProtocols(from: ProtocolDetail | null, to: ProtocolDetail): ProtocolDiff {
  const a = from?.protocol;
  const b = to.protocol;
  const contentChanges = [
    textChange("name", "Name", a?.name ?? "", b.name),
    textChange("description", "Description", a?.description ?? "", b.description),
    textChange("welcomeContent", "Welcome text", a?.welcomeContent ?? "", b.welcomeContent),
    textChange("informationContent", "Participant information text", a?.informationContent ?? "", b.informationContent),
    textChange("instructionContent", "Study instructions", a?.instructionContent ?? "", b.instructionContent),
    textChange("debriefContent", "Debrief text", a?.debriefContent ?? "", b.debriefContent),
  ].filter(present);

  const consentBefore = consentRef(from);
  const consentAfter = consentRef(to);
  const consentChange =
    (consentBefore?.id ?? null) === (consentAfter?.id ?? null) ? null : { before: consentBefore, after: consentAfter };

  const questionnaireChanges: ProtocolDiff["questionnaireChanges"] = [];
  const slots = [
    {
      slot: "background" as const,
      label: "Background questionnaire",
      before: questionnaireRef(from?.backgroundQuestionnaire),
      after: questionnaireRef(to.backgroundQuestionnaire),
    },
    {
      slot: "post_recording" as const,
      label: "Post-recording questionnaire",
      before: questionnaireRef(from?.postQuestionnaire),
      after: questionnaireRef(to.postQuestionnaire),
    },
    {
      slot: "post_review" as const,
      label: "Post-review questionnaire",
      before: questionnaireRef(from?.postReviewQuestionnaire),
      after: questionnaireRef(to.postReviewQuestionnaire),
    },
  ];
  for (const slot of slots) {
    if ((slot.before?.id ?? null) !== (slot.after?.id ?? null)) questionnaireChanges.push(slot);
  }

  const beforeTasks = from?.tasks ?? [];
  const afterTasks = to.tasks;
  const beforeKeys = beforeTasks.map((task) => task.taskKey);
  const afterKeys = afterTasks.map((task) => task.taskKey);
  const tasksAdded = afterTasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => !beforeKeys.includes(task.taskKey))
    .map(({ task, index }) => taskRef(task, index + 1));
  const tasksRemoved = beforeTasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => !afterKeys.includes(task.taskKey))
    .map(({ task, index }) => taskRef(task, index + 1));

  const tasksChanged: TaskDiff[] = [];
  const tasksReordered: ProtocolDiff["tasksReordered"] = [];
  const sharedBefore = beforeKeys.filter((key) => afterKeys.includes(key));
  const sharedAfter = afterKeys.filter((key) => beforeKeys.includes(key));
  for (const next of afterTasks) {
    const previous = beforeTasks.find((task) => task.taskKey === next.taskKey);
    if (!previous) continue;
    const change = diffTask(previous, next);
    if (change) tasksChanged.push(change);
    // Position among the tasks both versions have, so that adding or removing
    // another task does not count as a move.
    const relativeBefore = sharedBefore.indexOf(next.taskKey);
    const relativeAfter = sharedAfter.indexOf(next.taskKey);
    if (relativeBefore !== relativeAfter || previous.blockKey !== next.blockKey) {
      tasksReordered.push({
        taskKey: next.taskKey,
        title: next.title,
        positionBefore: beforeKeys.indexOf(next.taskKey) + 1,
        positionAfter: afterKeys.indexOf(next.taskKey) + 1,
        blockBefore: previous.blockKey,
        blockAfter: next.blockKey,
      });
    }
  }

  const blocksBefore = blocksOf(from);
  const blocksAfter = blocksOf(to);
  const blocksChanged = from !== null && JSON.stringify(blocksBefore) !== JSON.stringify(blocksAfter);
  const taskOrderChanged = tasksReordered.length > 0;
  const ordering = {
    changed: blocksChanged || taskOrderChanged,
    blocksChanged,
    taskOrderChanged,
    blocksBefore,
    blocksAfter,
    taskOrderBefore: beforeKeys,
    taskOrderAfter: afterKeys,
  };

  const followupsChanged = tasksChanged.filter(
    (task) =>
      task.followups.added.length > 0 ||
      task.followups.removed.length > 0 ||
      task.followups.changed.length > 0 ||
      task.followups.reordered,
  ).length;
  const summary = {
    contentFieldsChanged: contentChanges.map((change) => change.field),
    tasksAdded: tasksAdded.length,
    tasksRemoved: tasksRemoved.length,
    tasksChanged: tasksChanged.length,
    tasksReordered: tasksReordered.length,
    tasksEnabledOrDisabled: tasksChanged.filter((task) => task.enabledChange !== null).length,
    followupsChanged,
    consentChanged: consentChange !== null,
    questionnairesChanged: questionnaireChanges.length > 0,
    orderingChanged: ordering.changed,
  };

  return {
    from: from ? versionRef(from) : null,
    to: versionRef(to),
    hasChanges:
      contentChanges.length > 0 ||
      consentChange !== null ||
      questionnaireChanges.length > 0 ||
      tasksAdded.length > 0 ||
      tasksRemoved.length > 0 ||
      tasksChanged.length > 0 ||
      ordering.changed,
    contentChanges,
    consentChange,
    questionnaireChanges,
    ordering,
    tasksAdded,
    tasksRemoved,
    tasksReordered,
    tasksChanged,
    summary,
  };
}

export async function loadProtocolDiff(db: DbOrTx, fromId: string | null, toId: string): Promise<ProtocolDiff> {
  const to = await loadProtocolDetail(db, toId);
  const from = fromId ? await loadProtocolDetail(db, fromId) : null;
  return compareProtocols(from, to);
}

// What changed from version `fromId` to version `toId`. Pass null as `fromId`
// when there is no earlier version: everything is then reported as new.
export async function diffProtocolVersions(
  ctx: ServiceContext,
  fromId: string | null,
  toId: string,
): Promise<ProtocolDiff> {
  return loadProtocolDiff(ctx.db, fromId, toId);
}
