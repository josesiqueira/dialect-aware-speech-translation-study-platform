"use client";

import { useEffect, useId, useRef, useState } from "react";
import { InlineStatus, TextArea, labelBase } from "@/components/ui";
import { errorMessage } from "../../_components/useApiResource";

const NOTES_SAVE_DELAY_MS = 600;

export interface FlagPanelProps {
  /** "session" or "utterance", used in the label. */
  subject: string;
  flagged: boolean;
  notes: string | null;
  /** Saves the flag. The parent sends the request and reloads its data. */
  onSave: (flagged: boolean, notes: string) => Promise<void>;
  compact?: boolean;
}

/**
 * Flag for review with optional notes (the reference flag panel): the checkbox
 * saves at once, the notes save after a pause in typing, the result shows inline.
 * A flag asks for attention. It does not exclude anything.
 */
export function FlagPanel({ subject, flagged: initialFlagged, notes: initialNotes, onSave, compact = false }: FlagPanelProps) {
  const [flagged, setFlagged] = useState(initialFlagged);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" | "error"; message?: string }>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesId = useId();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function save(nextFlagged: boolean, nextNotes: string) {
    setStatus({ kind: "saving" });
    try {
      await onSave(nextFlagged, nextNotes);
      setStatus({ kind: "saved" });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  }

  function toggle(checked: boolean) {
    setFlagged(checked);
    if (timer.current) clearTimeout(timer.current);
    void save(checked, checked ? notes : "");
  }

  function changeNotes(value: string) {
    setNotes(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(flagged, value), NOTES_SAVE_DELAY_MS);
  }

  return (
    <div className={compact ? "" : "rounded-lg border border-slate-200 bg-white p-3"}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={flagged}
            onChange={(event) => toggle(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1"
          />
          Flag this {subject} for review
        </label>
        {status.kind === "saving" && <InlineStatus variant="pending" className="text-xs">Saving...</InlineStatus>}
        {status.kind === "saved" && <InlineStatus variant="success" className="text-xs">Saved</InlineStatus>}
        {status.kind === "error" && (
          <InlineStatus variant="error" className="text-xs">
            {status.message ?? "The flag could not be saved"}
          </InlineStatus>
        )}
        <span className="text-xs text-slate-500">A flag does not exclude the {subject} from analysis.</span>
      </div>
      {flagged && (
        <div className="mt-2">
          <label htmlFor={notesId} className={`${labelBase} mb-1 text-xs text-slate-500`}>
            Notes (optional)
          </label>
          <TextArea
            id={notesId}
            rows={2}
            value={notes}
            onChange={(event) => changeNotes(event.target.value)}
            placeholder={`What should be checked in this ${subject}?`}
          />
        </div>
      )}
    </div>
  );
}
