"use client";

import { useEffect, useState } from "react";
import {
  Button,
  ConfirmDialog,
  FormField,
  InlineMessage,
  InlineStatus,
  SaveButton,
  TextArea,
  TextInput,
  Badge,
  cn,
  confirmDiscardChanges,
  focusRing,
  scrollRegionProps,
} from "@/components/ui";
import { activateVersion, cloneVersion, createPrompt, deleteDraft, retireVersion, updatePrompt } from "./api";
import type { PageContext, PromptVersion, SectionDefinition } from "./types";
import { ActivateDialog, StatusBadge, useAction, VersionHistory, VersionMeta, type VersionRow } from "./VersionParts";

type PromptForm = { name: string; promptText: string; notes: string };

const PLACEHOLDER_HELP: Record<SectionDefinition["stage"], string> = {
  asr: "Sent to the speech recognition model exactly as written.",
  translation:
    "Sent as the instruction, exactly as written. Supported placeholders: {{source_language}} and {{target_language}}. Any other {{...}} placeholder is rejected.",
  tts: "Sent as the speaking instruction, exactly as written. Supported placeholder: {{target_language}}. Leave empty to send no instruction.",
  realtime_translation: "Stored exactly as written.",
};

function formOf(version: PromptVersion | undefined, fallbackName: string): PromptForm {
  return {
    name: version?.name ?? fallbackName,
    promptText: version?.promptText ?? "",
    notes: version?.notes ?? "",
  };
}

function PromptText({ text, label }: { text: string; label: string }) {
  if (text.trim() === "") {
    return <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">Empty. No text is sent.</p>;
  }
  return (
    <pre
      {...scrollRegionProps(label)}
      className={cn(
        "max-h-48 overflow-y-auto rounded-lg bg-slate-50 p-4 font-mono text-sm whitespace-pre-wrap text-slate-700",
        focusRing,
      )}
    >
      {text}
    </pre>
  );
}

export interface PromptBlockProps {
  blockId: string;
  section: SectionDefinition;
  /** Every version of the section's prompt key, newest first. */
  versions: PromptVersion[];
  page: PageContext;
}

/** The prompt of one section: active version read-only, draft editor, activation, history. */
export function PromptBlock({ blockId, section, versions, page }: PromptBlockProps) {
  const active = versions.find((version) => version.status === "active");
  const draft = versions.find((version) => version.status === "draft");

  const [editing, setEditing] = useState(false);
  const [baseline, setBaseline] = useState<PromptForm>(() => formOf(undefined, section.title));
  const [form, setForm] = useState<PromptForm>(baseline);
  const [saved, setSaved] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState<VersionRow | null>(null);
  const { pending, error, setError, run } = useAction(page.reload);

  const isDirty =
    editing && (form.name !== baseline.name || form.promptText !== baseline.promptText || form.notes !== baseline.notes);
  const { setDirty } = page;
  useEffect(() => {
    setDirty(blockId, isDirty);
    return () => setDirty(blockId, false);
  }, [blockId, isDirty, setDirty]);

  function startEditing() {
    const start = formOf(draft ?? active, section.title);
    setBaseline(start);
    setForm(start);
    setSaved(null);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    if (!confirmDiscardChanges(isDirty)) return;
    setEditing(false);
    setError(null);
  }

  async function save() {
    const notes = form.notes.trim() === "" ? null : form.notes;
    const result: { version?: PromptVersion } = {};
    const ok = await run("save", async () => {
      result.version = draft
        ? await updatePrompt(draft.id, { name: form.name, promptText: form.promptText, notes })
        : await createPrompt({
            key: section.promptKey,
            stage: section.stage,
            conditionKey: section.conditionKey,
            name: form.name,
            promptText: form.promptText,
            notes,
          });
    });
    if (ok && result.version) {
      setSaved(`Draft v${result.version.versionNumber} saved`);
      setEditing(false);
    }
  }

  const busy = pending !== null;

  return (
    <div data-testid={`prompt-block-${section.promptKey}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-semibold text-slate-900">{section.promptLabel}</h3>
            {active ? (
              <>
                <StatusBadge status="active" />
                <VersionMeta version={active} timeZone={page.timeZone} />
              </>
            ) : (
              <Badge variant="warning">No active version</Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Prompt key <span className="font-mono">{section.promptKey}</span>
            {active ? `, prompt version ${active.versionNumber}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button size="sm" variant="secondary" onClick={cancelEditing} disabled={busy}>
                Cancel
              </Button>
              <SaveButton size="sm" label="Save draft" isLoading={pending === "save"} onClick={save} />
            </>
          ) : (
            <>
              {saved && <InlineStatus variant="success">{saved}</InlineStatus>}
              <Button size="sm" variant="secondary" onClick={startEditing} disabled={busy}>
                {draft ? "Edit draft" : "Edit"}
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <InlineMessage variant="error" className="mt-3">
          {error}
        </InlineMessage>
      )}

      {editing ? (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-slate-500">
            {draft
              ? `Editing draft v${draft.versionNumber}. The active version stays in use until the draft is activated.`
              : active
                ? `Saving creates a new draft from active v${active.versionNumber}. The active version is not changed.`
                : "Saving creates the first draft of this prompt."}
          </p>
          <FormField label="Name" required>
            <TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </FormField>
          <FormField label={section.promptLabel} help={PLACEHOLDER_HELP[section.stage]}>
            <TextArea
              mono
              rows={12}
              value={form.promptText}
              onChange={(event) => setForm({ ...form, promptText: event.target.value })}
              placeholder="Enter the text..."
            />
          </FormField>
          <FormField label="Notes" help="For researchers only. Not sent to any model.">
            <TextArea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </FormField>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {active ? (
            <PromptText text={active.promptText} label={`Active text of ${active.key} v${active.versionNumber}`} />
          ) : (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
              No version of this prompt is active. Processing that needs it stops with a clear error. There is no
              built-in text.
            </p>
          )}

          {draft && (
            <div className="rounded-lg border border-dashed border-slate-300 p-3" data-testid="draft-panel">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status="draft" />
                  <VersionMeta version={draft} timeZone={page.timeZone} />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
                    Delete draft
                  </Button>
                  <Button size="sm" onClick={() => setActivating(true)} disabled={busy}>
                    Activate
                  </Button>
                </div>
              </div>
              <div className="mt-3">
                <PromptText text={draft.promptText} label={`Draft text of ${draft.key} v${draft.versionNumber}`} />
              </div>
            </div>
          )}
        </div>
      )}

      {versions.length > 0 && (
        <VersionHistory
          kind="prompts"
          versions={versions}
          timeZone={page.timeZone}
          disabled={busy || editing}
          onClone={(version) => {
            setSaved(null);
            void run("clone", () => cloneVersion("prompts", version.id));
          }}
          onRetire={setConfirmRetire}
        />
      )}

      {activating && draft && (
        <ActivateDialog
          kind="prompts"
          noun="prompt"
          draft={draft}
          active={active ?? null}
          notes={[
            "Active model configurations are not changed either. A configuration keeps the prompt version it pins until you activate a new configuration version.",
          ]}
          onActivate={() => {
            setSaved(null);
            return run("activate", () => activateVersion("prompts", draft.id));
          }}
          onClose={() => setActivating(false)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete && draft !== undefined}
        title={`Delete draft v${draft?.versionNumber ?? ""}?`}
        confirmLabel="Delete draft"
        tone="danger"
        busy={pending === "delete"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (!draft) return;
          setSaved(null);
          await run("delete", () => deleteDraft("prompts", draft.id));
          setConfirmDelete(false);
        }}
      >
        <p>The draft text is removed. Active and retired versions are not affected.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmRetire !== null}
        title={`Retire ${section.promptKey} v${confirmRetire?.versionNumber ?? ""}?`}
        confirmLabel="Retire version"
        tone="danger"
        busy={pending === "retire"}
        onCancel={() => setConfirmRetire(null)}
        onConfirm={async () => {
          if (!confirmRetire) return;
          await run("retire", () => retireVersion("prompts", confirmRetire.id));
          setConfirmRetire(null);
        }}
      >
        <p>
          The key then has no active prompt. Processing that needs it stops with a clear error until another version
          is activated.
        </p>
        <p>The version stays stored unchanged, and existing model runs and batches are not changed.</p>
      </ConfirmDialog>
    </div>
  );
}
