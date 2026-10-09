"use client";

import { useState } from "react";
import {
  protocolSchemas,
  STUDY_TEXT_LOCALE_NAMES,
  STUDY_TEXT_TRANSLATION_LOCALES,
  translationOf,
  type FollowupTranslations,
  type TaskTranslations,
} from "@dialect/domain";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  FormField,
  InlineMessage,
  SaveButton,
  Select,
  TextArea,
  TextInput,
} from "@/components/ui";
import {
  addFollowup,
  addTask,
  cloneTask,
  deleteFollowup,
  deleteTask,
  errorMessage,
  moveFollowup,
  moveTask,
  setTaskEnabled,
  updateFollowup,
  updateTask,
} from "./api";
import { useReportDirty } from "./EditorCard";
import type { Mutate } from "./ProtocolEditor";
import { ORDER_MODE_LABELS, TASK_TYPE_LABELS, type Followup, type OrderBlock, type ProtocolDetail, type Task } from "./types";

// ---------------------------------------------------------------------------
// Task form
// ---------------------------------------------------------------------------

type TaskFormValues = {
  internalName: string;
  title: string;
  taskType: Task["taskType"];
  blockKey: string;
  participantPrompt: string;
  contextText: string;
  instructionsText: string;
  minDuration: string;
  suggestedDuration: string;
  maxDuration: string;
  privacyReminder: boolean;
  enabled: boolean;
  researcherNotes: string;
  topicSuggestions: string;
  followupMode: protocolSchemas.FollowupMode;
  randomizationEligible: boolean;
  /** Per translation locale: the participant-facing texts in that language. */
  translations: Record<string, TaskTextValues>;
};

type TaskTextValues = {
  title: string;
  participantPrompt: string;
  contextText: string;
  instructionsText: string;
  topicSuggestions: string;
};

const TRANSLATED_TASK_FIELDS = [
  { key: "title", label: "title", rows: 1 },
  { key: "participantPrompt", label: "prompt", rows: 4 },
  { key: "contextText", label: "context", rows: 3 },
  { key: "instructionsText", label: "instructions", rows: 3 },
] as const;

function taskTextsOf(task: Task | null, locale: string): TaskTextValues {
  const stored = task?.translationsJson as TaskTranslations | undefined;
  const topics = stored?.[locale]?.topicSuggestions ?? [];
  return {
    title: translationOf(stored, locale, "title"),
    participantPrompt: translationOf(stored, locale, "participantPrompt"),
    contextText: translationOf(stored, locale, "contextText"),
    instructionsText: translationOf(stored, locale, "instructionsText"),
    topicSuggestions: topics.join("\n"),
  };
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formOf(task: Task | null, firstBlock: string): TaskFormValues {
  const seconds = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));
  return {
    internalName: task?.internalName ?? "",
    title: task?.title ?? "",
    taskType: task?.taskType ?? "controlled",
    blockKey: task?.blockKey ?? firstBlock,
    participantPrompt: task?.participantPrompt ?? "",
    contextText: task?.contextText ?? "",
    instructionsText: task?.instructionsText ?? "",
    minDuration: seconds(task?.minDurationSeconds),
    suggestedDuration: seconds(task?.suggestedDurationSeconds),
    maxDuration: seconds(task?.maxDurationSeconds),
    privacyReminder: task?.privacyReminder ?? false,
    enabled: task?.enabled ?? true,
    researcherNotes: task?.researcherNotes ?? "",
    topicSuggestions: (task?.configJson?.topicSuggestions ?? []).join("\n"),
    followupMode: task?.configJson?.followupMode ?? "always",
    randomizationEligible: task?.configJson?.randomizationEligible ?? true,
    translations: Object.fromEntries(
      STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => [locale, taskTextsOf(task, locale)]),
    ),
  };
}

// Whole seconds, or empty for "not set". Returns undefined for anything else.
function parseSeconds(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value <= protocolSchemas.MAX_DURATION_SECONDS ? value : undefined;
}

function toChanges(form: TaskFormValues): protocolSchemas.TaskChanges | string {
  const min = parseSeconds(form.minDuration);
  const suggested = parseSeconds(form.suggestedDuration);
  const max = parseSeconds(form.maxDuration);
  if (min === undefined || suggested === undefined || max === undefined) {
    return `Durations are whole seconds between 0 and ${protocolSchemas.MAX_DURATION_SECONDS}, or empty.`;
  }
  if (max === 0) return "The maximum duration must be above zero, or empty.";
  if (min !== null && max !== null && min > max) return "The minimum duration cannot be longer than the maximum duration.";
  return {
    internalName: form.internalName.trim() || null,
    title: form.title.trim(),
    taskType: form.taskType,
    blockKey: form.blockKey,
    participantPrompt: form.participantPrompt,
    contextText: form.contextText.trim() ? form.contextText : null,
    instructionsText: form.instructionsText.trim() ? form.instructionsText : null,
    minDurationSeconds: min,
    suggestedDurationSeconds: suggested,
    maxDurationSeconds: max,
    privacyReminder: form.privacyReminder,
    enabled: form.enabled,
    researcherNotes: form.researcherNotes.trim() ? form.researcherNotes : null,
    topicSuggestions: lines(form.topicSuggestions),
    followupMode: form.followupMode,
    randomizationEligible: form.randomizationEligible,
    // Empty texts are dropped by the server; the participant then sees the English text.
    translations: Object.fromEntries(
      Object.entries(form.translations).map(([locale, texts]) => [
        locale,
        {
          title: texts.title.trim(),
          participantPrompt: texts.participantPrompt,
          contextText: texts.contextText,
          instructionsText: texts.instructionsText,
          topicSuggestions: lines(texts.topicSuggestions),
        },
      ]),
    ),
  };
}

function TaskForm({
  task,
  blocks,
  onSave,
  onCancel,
}: {
  /** Null when adding a task. */
  task: Task | null;
  blocks: OrderBlock[];
  onSave: (changes: protocolSchemas.TaskChanges) => Promise<void>;
  onCancel: () => void;
}) {
  const [initial] = useState(() => formOf(task, blocks[0]?.key ?? ""));
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const isDirty = JSON.stringify(form) !== JSON.stringify(initial);
  useReportDirty(`task-form-${task?.id ?? "new"}`, isDirty);

  const block = blocks.find((candidate) => candidate.key === form.blockKey);
  const blockOptions = blocks.map((candidate) => ({ value: candidate.key, label: candidate.title || candidate.key }));
  if (!block && form.blockKey) blockOptions.push({ value: form.blockKey, label: `${form.blockKey} (not a listed block)` });

  async function save() {
    const changes = toChanges(form);
    if (typeof changes === "string") {
      setError(changes);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(changes);
    } catch (caught) {
      setError(errorMessage(caught));
      setSaving(false);
    }
  }

  return (
    <form
      className="mt-3 space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4"
      aria-label={task ? `Edit task ${task.taskKey}` : "New task"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Internal name" help="For researchers. Participants never see it.">
          <TextInput
            value={form.internalName}
            disabled={saving}
            maxLength={protocolSchemas.MAX_NAME_LENGTH}
            onChange={(event) => set("internalName", event.target.value)}
          />
        </FormField>
        <FormField label="Participant-facing title" help="Heading of the task page.">
          <TextInput
            value={form.title}
            disabled={saving}
            maxLength={protocolSchemas.MAX_NAME_LENGTH}
            onChange={(event) => set("title", event.target.value)}
          />
        </FormField>
        <FormField label="Type">
          <Select
            value={form.taskType}
            disabled={saving}
            onChange={(event) => {
              const taskType = event.target.value as Task["taskType"];
              // Free speech invites personal stories: switch the reminder on with the type.
              setForm((current) => ({
                ...current,
                taskType,
                privacyReminder: taskType === "free_speech" ? true : current.privacyReminder,
              }));
            }}
            options={protocolTaskTypeOptions}
          />
        </FormField>
        <FormField
          label="Block"
          help={
            block
              ? `Order mode: ${ORDER_MODE_LABELS[block.orderMode]}. The order mode is set per block under Task blocks.`
              : "Choose a block."
          }
        >
          <Select
            value={form.blockKey}
            disabled={saving}
            onChange={(event) => set("blockKey", event.target.value)}
            options={blockOptions}
          />
        </FormField>
      </div>

      <FormField
        label="Prompt"
        help={
          form.taskType === "controlled"
            ? "Describe a communicative situation. Participants formulate the Finnish themselves: do not provide a Finnish sentence to read aloud (spec 7.1)."
            : form.taskType === "semi_structured"
              ? "An open question. Follow-ups are predefined texts that you add to the task (spec 7.2)."
              : "An open invitation to speak. Free speech is exploratory (spec 7.3)."
        }
      >
        <TextArea
          rows={4}
          value={form.participantPrompt}
          disabled={saving}
          maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
          onChange={(event) => set("participantPrompt", event.target.value)}
        />
      </FormField>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Context" help="Optional. Shown with the prompt.">
          <TextArea
            rows={3}
            value={form.contextText}
            disabled={saving}
            maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
            onChange={(event) => set("contextText", event.target.value)}
          />
        </FormField>
        <FormField label="Instructions" help="Optional. For example how long to speak.">
          <TextArea
            rows={3}
            value={form.instructionsText}
            disabled={saving}
            maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
            onChange={(event) => set("instructionsText", event.target.value)}
          />
        </FormField>
      </div>

      {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => {
        const texts = form.translations[locale] ?? taskTextsOf(null, locale);
        const setText = (key: keyof TaskTextValues, value: string) =>
          setForm((current) => ({
            ...current,
            translations: { ...current.translations, [locale]: { ...texts, [key]: value } },
          }));
        const name = STUDY_TEXT_LOCALE_NAMES[locale] ?? locale;
        return (
          <fieldset key={locale} className="space-y-4 rounded-md border border-slate-200 bg-white p-4">
            <legend className="px-1 text-sm font-medium text-slate-900">
              {name} texts ({locale})
            </legend>
            <p className="text-sm text-slate-500">
              Shown to participants who choose this language. An empty field shows the English text.
            </p>
            {TRANSLATED_TASK_FIELDS.map((field) => (
              <FormField key={field.key} label={`${name} ${field.label}`}>
                {field.rows === 1 ? (
                  <TextInput
                    lang={locale}
                    value={texts[field.key]}
                    disabled={saving}
                    maxLength={protocolSchemas.MAX_NAME_LENGTH}
                    onChange={(event) => setText(field.key, event.target.value)}
                  />
                ) : (
                  <TextArea
                    lang={locale}
                    rows={field.rows}
                    value={texts[field.key]}
                    disabled={saving}
                    maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
                    onChange={(event) => setText(field.key, event.target.value)}
                  />
                )}
              </FormField>
            ))}
            <FormField label={`${name} topic suggestions`} help="Optional, one per line.">
              <TextArea
                lang={locale}
                rows={3}
                value={texts.topicSuggestions}
                disabled={saving}
                onChange={(event) => setText("topicSuggestions", event.target.value)}
              />
            </FormField>
          </fieldset>
        );
      })}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FormField label="Minimum duration (seconds)" help="Empty for no minimum.">
          <TextInput
            mono
            inputMode="numeric"
            value={form.minDuration}
            disabled={saving}
            onChange={(event) => set("minDuration", event.target.value)}
          />
        </FormField>
        <FormField label="Suggested duration (seconds)" help="Guidance, not enforced.">
          <TextInput
            mono
            inputMode="numeric"
            value={form.suggestedDuration}
            disabled={saving}
            onChange={(event) => set("suggestedDuration", event.target.value)}
          />
        </FormField>
        <FormField label="Maximum duration (seconds)" help="Recording stops at this length.">
          <TextInput
            mono
            inputMode="numeric"
            value={form.maxDuration}
            disabled={saving}
            onChange={(event) => set("maxDuration", event.target.value)}
          />
        </FormField>
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Checkbox
          label="Enabled"
          description="A disabled task stays in the draft but is not shown to participants."
          checked={form.enabled}
          disabled={saving}
          onChange={(event) => set("enabled", event.target.checked)}
        />
        <Checkbox
          label="Privacy reminder"
          description="Asks participants to avoid full names and other identifying details."
          checked={form.privacyReminder}
          disabled={saving}
          onChange={(event) => set("privacyReminder", event.target.checked)}
        />
        {block?.orderMode === "shuffle_within_block" && (
          <Checkbox
            label="Include in the random order"
            description="Switch off to keep this task at its position inside the shuffled block."
            checked={form.randomizationEligible}
            disabled={saving}
            onChange={(event) => set("randomizationEligible", event.target.checked)}
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Follow-up mode" help="How the predefined follow-ups of this task are offered.">
          <Select
            value={form.followupMode}
            disabled={saving}
            onChange={(event) => set("followupMode", event.target.value as protocolSchemas.FollowupMode)}
            options={[
              { value: "always", label: "Always shown" },
              { value: "optional", label: "Optional for the participant" },
            ]}
          />
        </FormField>
        <FormField label="Topic suggestions" help="Optional, one per line. Shown as ideas for free speech.">
          <TextArea
            rows={3}
            value={form.topicSuggestions}
            disabled={saving}
            onChange={(event) => set("topicSuggestions", event.target.value)}
          />
        </FormField>
      </div>
      <FormField label="Researcher notes" help="Internal. Not shown to participants and not exported as study content.">
        <TextArea
          rows={2}
          value={form.researcherNotes}
          disabled={saving}
          maxLength={protocolSchemas.MAX_NOTES_LENGTH}
          onChange={(event) => set("researcherNotes", event.target.value)}
        />
      </FormField>

      {error && <InlineMessage variant="error">{error}</InlineMessage>}
      <div className="flex items-center gap-2">
        <SaveButton type="submit" size="sm" isLoading={saving} label={task ? "Save task" : "Add task"} />
        <Button size="sm" variant="secondary" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const protocolTaskTypeOptions = (Object.keys(TASK_TYPE_LABELS) as Array<Task["taskType"]>).map((value) => ({
  value,
  label: TASK_TYPE_LABELS[value],
}));

// ---------------------------------------------------------------------------
// Follow-ups (predefined texts only)
// ---------------------------------------------------------------------------

type FollowupFormValues = {
  promptText: string;
  isRequired: boolean;
  enabled: boolean;
  /** The follow-up text per translation locale. */
  translations: FollowupTranslations;
};

function FollowupForm({
  formKey,
  followup,
  onSave,
  onCancel,
}: {
  formKey: string;
  followup: Followup | null;
  onSave: (values: FollowupFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [initial] = useState<FollowupFormValues>(() => ({
    promptText: followup?.promptText ?? "",
    isRequired: followup?.isRequired ?? true,
    enabled: followup?.enabled ?? true,
    translations: Object.fromEntries(
      STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => [
        locale,
        { promptText: translationOf(followup?.translationsJson, locale, "promptText") },
      ]),
    ),
  }));
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReportDirty(formKey, JSON.stringify(form) !== JSON.stringify(initial));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (caught) {
      setError(errorMessage(caught));
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FormField
        label={followup ? "Follow-up text" : "New follow-up text"}
        help="A predefined question, written by you and shown to every participant in the same words."
      >
        <TextArea
          rows={2}
          value={form.promptText}
          disabled={saving}
          maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
          onChange={(event) => setForm({ ...form, promptText: event.target.value })}
        />
      </FormField>
      {STUDY_TEXT_TRANSLATION_LOCALES.map((locale) => (
        <FormField
          key={locale}
          label={`${STUDY_TEXT_LOCALE_NAMES[locale] ?? locale} follow-up text (${locale})`}
          help="Shown to participants who choose this language. Empty: they see the English text."
        >
          <TextArea
            lang={locale}
            rows={2}
            value={form.translations[locale]?.promptText ?? ""}
            disabled={saving}
            maxLength={protocolSchemas.MAX_PROMPT_LENGTH}
            onChange={(event) =>
              setForm({ ...form, translations: { ...form.translations, [locale]: { promptText: event.target.value } } })
            }
          />
        </FormField>
      ))}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Checkbox
          label="Required"
          checked={form.isRequired}
          disabled={saving}
          onChange={(event) => setForm({ ...form, isRequired: event.target.checked })}
        />
        <Checkbox
          label="Enabled"
          checked={form.enabled}
          disabled={saving}
          onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
        />
      </div>
      {error && <InlineMessage variant="error">{error}</InlineMessage>}
      <div className="flex items-center gap-2">
        <SaveButton type="submit" size="sm" isLoading={saving} label={followup ? "Save follow-up" : "Add follow-up"} />
        <Button size="sm" variant="secondary" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The ordered list
// ---------------------------------------------------------------------------

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim();
}

function durationSummary(task: Task): string | null {
  const parts = [
    task.minDurationSeconds !== null ? `min ${task.minDurationSeconds} s` : null,
    task.suggestedDurationSeconds !== null ? `suggested ${task.suggestedDurationSeconds} s` : null,
    task.maxDurationSeconds !== null ? `max ${task.maxDurationSeconds} s` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

type Pending =
  | { kind: "delete-task"; task: Task; position: number }
  | { kind: "delete-followup"; task: Task; followup: Followup };

/**
 * The visual ordered list of tasks (spec 48): number, type, enabled state and
 * the first line of the prompt, grouped by block. Reordering uses Move up and
 * Move down buttons, so it works with a keyboard.
 */
export function TaskList({
  detail,
  editable,
  mutate,
}: {
  detail: ProtocolDetail;
  editable: boolean;
  mutate: Mutate;
}) {
  const id = detail.protocol.id;
  const blocks = detail.protocol.orderConfigJson.blocks;
  const tasks = detail.tasks;

  // "new" while the add form is open, a task id while that task is edited.
  const [editing, setEditing] = useState<string | null>(null);
  // "<taskId>:new" or "<taskId>:<followupId>" while a follow-up form is open.
  const [followupForm, setFollowupForm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  async function act(run: (stamp: string) => Promise<ProtocolDetail>) {
    setBusy(true);
    setError(null);
    try {
      await mutate(run);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    setBusy(true);
    setPendingError(null);
    try {
      if (pending.kind === "delete-task") {
        await mutate((stamp) => deleteTask(id, pending.task.id, stamp));
      } else {
        await mutate((stamp) => deleteFollowup(id, pending.task.id, pending.followup.id, stamp));
      }
      setPending(null);
    } catch (caught) {
      setPendingError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const listedKeys = blocks.map((block) => block.key);
  const groups: Array<{ key: string; title: string; mode: string | null; tasks: Task[] }> = blocks.map((block) => ({
    key: block.key,
    title: block.title || block.key,
    mode: ORDER_MODE_LABELS[block.orderMode],
    tasks: tasks.filter((task) => task.blockKey === block.key),
  }));
  for (const key of [...new Set(tasks.map((task) => task.blockKey))].filter((key) => !listedKeys.includes(key))) {
    groups.push({
      key,
      title: `${key} (not listed under Task blocks)`,
      mode: null,
      tasks: tasks.filter((task) => task.blockKey === key),
    });
  }
  const positionOf = (task: Task) => tasks.findIndex((candidate) => candidate.id === task.id) + 1;
  const lastBlockKey = listedKeys[listedKeys.length - 1];
  const canMoveUp = (task: Task) => positionOf(task) > 1 || listedKeys.indexOf(task.blockKey) > 0;
  const canMoveDown = (task: Task) =>
    positionOf(task) < tasks.length || (listedKeys.includes(task.blockKey) && task.blockKey !== lastBlockKey);

  return (
    <Card padding="none" as="section" id="card-tasks" aria-label="Tasks">
      <CardHeader
        title="Tasks"
        description="Speech tasks in the order they are presented. Changes to tasks are saved one at a time."
        meta={
          <span className="text-xs text-slate-500 tabular-nums">
            {tasks.filter((task) => task.enabled).length} enabled of {tasks.length}
          </span>
        }
        actions={
          editable ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || editing !== null || blocks.length === 0}
              onClick={() => setEditing("new")}
            >
              Add task
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        {error && <InlineMessage variant="error">{error}</InlineMessage>}
        {editable && blocks.length === 0 && (
          <InlineMessage variant="info" announce="none">
            Add a block under Task blocks before adding tasks.
          </InlineMessage>
        )}
        {editing === "new" && (
          <TaskForm
            task={null}
            blocks={blocks}
            onCancel={() => setEditing(null)}
            onSave={async (changes) => {
              await mutate((stamp) =>
                addTask(id, stamp, { ...changes, taskType: changes.taskType ?? "controlled", blockKey: changes.blockKey ?? "" }),
              );
              setEditing(null);
            }}
          />
        )}
        {tasks.length === 0 && editing !== "new" && (
          <EmptyState title="This protocol has no tasks yet." description="A protocol needs at least one enabled task before it can be published." />
        )}

        {groups
          .filter((group) => group.tasks.length > 0 || editable)
          .map((group) => (
            <section key={group.key} aria-label={`Block ${group.title}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 border-b border-slate-200 pb-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{group.title}</h3>
                {group.mode && <span className="text-xs text-slate-500">{group.mode}</span>}
              </div>
              {group.tasks.length === 0 ? (
                <p className="py-3 text-sm text-slate-500">No tasks in this block.</p>
              ) : (
                <ol className="divide-y divide-slate-100">
                  {group.tasks.map((task) => {
                    const position = positionOf(task);
                    const name = task.title || task.internalName || task.taskKey;
                    const duration = durationSummary(task);
                    return (
                      <li key={task.id} className="py-3">
                        <div className="flex items-start gap-3">
                          <span className="w-6 shrink-0 pt-0.5 text-right text-sm font-medium text-slate-500 tabular-nums">
                            {position}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="neutral">{TASK_TYPE_LABELS[task.taskType]}</Badge>
                              <Badge variant={task.enabled ? "status" : "incomplete"}>
                                {task.enabled ? "Enabled" : "Disabled"}
                              </Badge>
                              <span className="text-sm font-medium text-slate-900">{name}</span>
                              <span className="font-mono text-xs text-slate-500">{task.taskKey}</span>
                            </div>
                            <p className="mt-1 truncate text-sm text-slate-700">
                              {task.participantPrompt.trim() ? `"${firstLine(task.participantPrompt)}"` : "No prompt yet."}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {[
                                duration,
                                task.privacyReminder ? "privacy reminder" : null,
                                task.followups.length > 0
                                  ? `${task.followups.length} follow-up${task.followups.length === 1 ? "" : "s"} (${
                                      (task.configJson?.followupMode ?? "always") === "optional" ? "optional" : "always shown"
                                    })`
                                  : null,
                                task.configJson?.randomizationEligible === false ? "fixed position" : null,
                              ]
                                .filter(Boolean)
                                .join(" · ") || "No duration limits."}
                            </p>
                          </div>
                          {editable && (
                            <div className="flex shrink-0 gap-1">
                              <Button
                                size="sm"
                                variant="secondary"
                                className="px-2"
                                disabled={busy || !canMoveUp(task)}
                                aria-label={`Move task ${position} up`}
                                title="Move up"
                                onClick={() => act((stamp) => moveTask(id, task.id, stamp, "up"))}
                              >
                                <span aria-hidden="true">↑</span>
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="px-2"
                                disabled={busy || !canMoveDown(task)}
                                aria-label={`Move task ${position} down`}
                                title="Move down"
                                onClick={() => act((stamp) => moveTask(id, task.id, stamp, "down"))}
                              >
                                <span aria-hidden="true">↓</span>
                              </Button>
                            </div>
                          )}
                        </div>

                        {editable && editing !== task.id && (
                          <div className="mt-2 ml-9 flex flex-wrap gap-1">
                            <Button size="sm" variant="ghost" disabled={busy} aria-label={`Edit task ${position}`} onClick={() => setEditing(task.id)}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              aria-label={`Clone task ${position}`}
                              onClick={() => act((stamp) => cloneTask(id, task.id, stamp))}
                            >
                              Clone
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              aria-label={`${task.enabled ? "Disable" : "Enable"} task ${position}`}
                              onClick={() => act((stamp) => setTaskEnabled(id, task.id, stamp, !task.enabled))}
                            >
                              {task.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || followupForm !== null}
                              aria-label={`Add follow-up to task ${position}`}
                              onClick={() => setFollowupForm(`${task.id}:new`)}
                            >
                              Add follow-up
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                              disabled={busy}
                              aria-label={`Delete task ${position}`}
                              onClick={() => {
                                setPendingError(null);
                                setPending({ kind: "delete-task", task, position });
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        )}

                        {editing === task.id && (
                          <div className="ml-9">
                            <TaskForm
                              task={task}
                              blocks={blocks}
                              onCancel={() => setEditing(null)}
                              onSave={async (changes) => {
                                await mutate((stamp) => updateTask(id, task.id, stamp, changes));
                                setEditing(null);
                              }}
                            />
                          </div>
                        )}

                        {(task.followups.length > 0 || followupForm === `${task.id}:new`) && (
                          <div className="mt-3 ml-9 space-y-2 border-l-2 border-slate-200 pl-4">
                            <p className="text-xs font-medium text-slate-500">
                              Follow-ups: predefined texts, shown in this order
                            </p>
                            <ol className="space-y-2">
                              {task.followups.map((followup, index) => {
                                const formKey = `${task.id}:${followup.id}`;
                                if (followupForm === formKey) {
                                  return (
                                    <li key={followup.id}>
                                      <FollowupForm
                                        formKey={`followup-form-${formKey}`}
                                        followup={followup}
                                        onCancel={() => setFollowupForm(null)}
                                        onSave={async (values) => {
                                          await mutate((stamp) => updateFollowup(id, task.id, followup.id, stamp, values));
                                          setFollowupForm(null);
                                        }}
                                      />
                                    </li>
                                  );
                                }
                                return (
                                  <li key={followup.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
                                    <span className="text-slate-500 tabular-nums">
                                      {position}.{index + 1}
                                    </span>
                                    <span className="min-w-0 flex-1 text-slate-700">
                                      {followup.promptText.trim() ? `"${followup.promptText}"` : "No text yet."}
                                    </span>
                                    <Badge variant="neutral" size="sm">
                                      {followup.isRequired ? "Required" : "Optional"}
                                    </Badge>
                                    {!followup.enabled && (
                                      <Badge variant="incomplete" size="sm">
                                        Disabled
                                      </Badge>
                                    )}
                                    {editable && (
                                      <span className="flex gap-1">
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="px-2 py-0.5"
                                          disabled={busy || index === 0}
                                          aria-label={`Move follow-up ${position}.${index + 1} up`}
                                          onClick={() => act((stamp) => moveFollowup(id, task.id, followup.id, stamp, "up"))}
                                        >
                                          <span aria-hidden="true">↑</span>
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="px-2 py-0.5"
                                          disabled={busy || index === task.followups.length - 1}
                                          aria-label={`Move follow-up ${position}.${index + 1} down`}
                                          onClick={() => act((stamp) => moveFollowup(id, task.id, followup.id, stamp, "down"))}
                                        >
                                          <span aria-hidden="true">↓</span>
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="px-2 py-0.5"
                                          disabled={busy || followupForm !== null}
                                          aria-label={`Edit follow-up ${position}.${index + 1}`}
                                          onClick={() => setFollowupForm(formKey)}
                                        >
                                          Edit
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="px-2 py-0.5 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                                          disabled={busy}
                                          aria-label={`Delete follow-up ${position}.${index + 1}`}
                                          onClick={() => {
                                            setPendingError(null);
                                            setPending({ kind: "delete-followup", task, followup });
                                          }}
                                        >
                                          Delete
                                        </Button>
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ol>
                            {followupForm === `${task.id}:new` && (
                              <FollowupForm
                                formKey={`followup-form-${task.id}-new`}
                                followup={null}
                                onCancel={() => setFollowupForm(null)}
                                onSave={async (values) => {
                                  await mutate((stamp) => addFollowup(id, task.id, stamp, values));
                                  setFollowupForm(null);
                                }}
                              />
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          ))}
      </CardBody>

      <ConfirmDialog
        open={pending !== null}
        tone="danger"
        title={
          pending?.kind === "delete-task"
            ? `Delete task ${pending.position}?`
            : pending?.kind === "delete-followup"
              ? "Delete this follow-up?"
              : ""
        }
        confirmLabel={pending?.kind === "delete-followup" ? "Delete follow-up" : "Delete task"}
        busy={busy}
        busyLabel="Deleting..."
        error={pendingError}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      >
        {pending?.kind === "delete-task" && (
          <>
            <p>
              &quot;{pending.task.title || pending.task.taskKey}&quot;
              {pending.task.followups.length > 0
                ? ` and its ${pending.task.followups.length} follow-up${pending.task.followups.length === 1 ? "" : "s"} are`
                : " is"}{" "}
              removed from this draft. This cannot be undone.
            </p>
            <p>Published versions are not affected. To keep the task without showing it, disable it instead.</p>
          </>
        )}
        {pending?.kind === "delete-followup" && (
          <p>
            &quot;{pending.followup.promptText}&quot; is removed from this draft. This cannot be undone. Published
            versions are not affected.
          </p>
        )}
      </ConfirmDialog>
    </Card>
  );
}
