"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button, Card, CardBody, CardHeader, InlineMessage, InlineStatus, SaveButton } from "@/components/ui";
import { errorMessage } from "./api";

/** Reports which parts of the page hold unsaved edits. The page owns the registry. */
export const DirtyContext = createContext<(key: string, dirty: boolean) => void>(() => {});

/** Tell the page that this part has (or no longer has) unsaved edits. */
export function useReportDirty(key: string, dirty: boolean): void {
  const report = useContext(DirtyContext);
  useEffect(() => {
    report(key, dirty);
    return () => report(key, false);
  }, [key, dirty, report]);
}

export interface EditorCardProps<T> {
  /** Unique on the page. Used for the unsaved-changes registry and as the anchor id. */
  id: string;
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  /** The stored value. */
  value: T;
  /** False for a published or retired version: no Edit button. */
  editable: boolean;
  onSave: (draft: T) => Promise<void>;
  renderView: (value: T) => ReactNode;
  renderEdit: (draft: T, setDraft: (next: T) => void, disabled: boolean) => ReactNode;
  /** Returns a message when the draft cannot be saved. */
  validate?: (draft: T) => string | null;
}

/**
 * One white bordered editor card in the rhythm of the reference Prompts page:
 * header with Edit, then Cancel and Save while editing, and the result of the
 * save shown inline next to the buttons.
 */
export function EditorCard<T>({
  id,
  title,
  description,
  meta,
  value,
  editable,
  onSave,
  renderView,
  renderEdit,
  validate,
}: EditorCardProps<T>) {
  const [draft, setDraft] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = draft !== null;
  const isDirty = editing && JSON.stringify(draft) !== JSON.stringify(value);
  useReportDirty(id, isDirty);

  async function save() {
    if (draft === null) return;
    const problem = validate?.(draft) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    if (!isDirty) {
      setDraft(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setDraft(null);
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  const actions = !editable ? undefined : editing ? (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={saving}
        onClick={() => {
          setDraft(null);
          setError(null);
        }}
      >
        Cancel
      </Button>
      <SaveButton size="sm" isLoading={saving} onClick={save} status={error ? "error" : "idle"} />
    </>
  ) : (
    <>
      {saved && <InlineStatus variant="success">Saved</InlineStatus>}
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Edit ${title}`}
        onClick={() => {
          setDraft(value);
          setSaved(false);
          setError(null);
        }}
      >
        Edit
      </Button>
    </>
  );

  return (
    <Card padding="none" as="section" id={id} aria-label={title}>
      <CardHeader title={title} description={description} meta={meta} actions={actions} />
      <CardBody className="space-y-4">
        {error && <InlineMessage variant="error">{error}</InlineMessage>}
        {editing ? renderEdit(draft, setDraft, saving) : renderView(value)}
      </CardBody>
    </Card>
  );
}

/**
 * Participant-facing prose shown read-only: normal sans-serif text on the quiet slate panel.
 * The panel scrolls, so it is a focusable region. Its name is "<label>, current text", which
 * keeps it apart from the card around it, a region named by the same label.
 */
export function ProseView({ text, label, empty }: { text: string; label: string; empty: string }) {
  if (text.trim() === "") {
    return <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">{empty}</p>;
  }
  return (
    <div
      role="region"
      aria-label={`${label}, current text`}
      tabIndex={0}
      className="max-h-64 overflow-y-auto rounded-lg bg-slate-50 p-4 text-sm leading-relaxed whitespace-pre-wrap text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none"
    >
      {text}
    </div>
  );
}
