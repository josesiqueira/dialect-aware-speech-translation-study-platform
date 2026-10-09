"use client";

import { useId, useState } from "react";
import { FLAG_REASON_CODES, corpusSchemas, type FlagReasonCode, type OutputStatus } from "@dialect/domain";
import { Button, InlineStatus, TextArea, cn, filterControl, labelBase } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { useAction } from "./helpers";

export interface OutputNotesProps {
  kind: "translations" | "syntheses";
  /** Id of the translation or synthesis. */
  id: string;
  /** Current status of the output. */
  status: OutputStatus;
  /** Flags and notes of the whole session. The ones of this output are picked here. */
  flags: corpusSchemas.FlagView[];
  notes: corpusSchemas.NoteView[];
  timeZone: string;
  /** Reloads the session detail, which brings the new note or flag back. */
  onChanged: () => Promise<void>;
}

const reasonText = (code: string | null) => (code ? code.replaceAll("_", " ") : "no reason given");

/**
 * Flag and notes of one processing output (spec 45 "flag output", spec 88).
 * A flag asks for attention: it marks a generated output as reviewed and records
 * the reason. It does not exclude the output and never changes its text or audio.
 * Notes are internal and are only added, never edited.
 */
export function OutputNotes({ kind, id, status, flags, notes, timeZone, onChanged }: OutputNotesProps) {
  const entityType = corpusSchemas.outputEntityTypeFromKind(kind);
  const what = kind === "translations" ? "translation" : "TTS output";
  const ownFlags = flags.filter((flag) => flag.entityType === entityType && flag.entityId === id);
  const openFlags = ownFlags.filter((flag) => flag.resolvedAt === null);
  const ownNotes = notes.filter((note) => note.entityType === entityType && note.entityId === id);

  const [reasonCode, setReasonCode] = useState<FlagReasonCode | "">("");
  const [flagNote, setFlagNote] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const flagAction = useAction();
  const noteAction = useAction();
  const noteId = useId();
  const flagNoteId = useId();

  async function addFlag() {
    if (!reasonCode) return;
    const ok = await flagAction.run(async () => {
      await apiFetch(`/api/admin/sessions/outputs/${kind}/${id}/status`, {
        method: "PATCH",
        // A generated output becomes "reviewed" (a researcher looked at it). A reviewed or excluded
        // output keeps its status. The reason and the note are stored as a flag row.
        body: {
          status: status === "generated" ? "reviewed" : status,
          reasonCode,
          ...(flagNote.trim() ? { notes: flagNote.trim() } : {}),
        },
      });
      await onChanged();
    });
    if (ok) {
      setReasonCode("");
      setFlagNote("");
    }
  }

  async function addNote() {
    if (!noteBody.trim()) return;
    const ok = await noteAction.run(async () => {
      await apiFetch(`/api/admin/sessions/outputs/${kind}/${id}/notes`, { method: "POST", body: { body: noteBody.trim() } });
      await onChanged();
    });
    if (ok) setNoteBody("");
  }

  return (
    <div className="mt-2 space-y-2 border-t border-slate-200 pt-2" data-testid={`output-notes-${id}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Flags and notes</p>

      {openFlags.length > 0 && (
        <ul className="space-y-0.5 text-xs text-slate-700" aria-label={`Open flags of this ${what}`}>
          {openFlags.map((flag) => (
            <li key={flag.id}>
              <span className="font-medium">Flagged: {reasonText(flag.reasonCode)}</span>
              {flag.notes ? `. ${flag.notes}` : ""}{" "}
              <span className="text-slate-500">
                ({flag.createdByLabel ?? "unknown"}, <span className="tabular-nums">{formatDateTime(flag.createdAt, timeZone)}</span>)
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Flag this ${what}: reason`}
          value={reasonCode}
          onChange={(event) => setReasonCode(event.target.value as FlagReasonCode | "")}
          className={cn(filterControl, "px-2 py-1 text-xs")}
        >
          <option value="">Flag with reason...</option>
          {FLAG_REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {reasonText(code)}
            </option>
          ))}
        </select>
        <label htmlFor={flagNoteId} className="sr-only">
          Flag note (optional)
        </label>
        <input
          id={flagNoteId}
          type="text"
          value={flagNote}
          maxLength={corpusSchemas.MAX_NOTE_LENGTH}
          onChange={(event) => setFlagNote(event.target.value)}
          placeholder="Flag note (optional)"
          className={cn(filterControl, "min-w-0 flex-1 px-2 py-1 text-xs")}
        />
        <Button
          size="sm"
          variant="secondary"
          className="px-2 py-1 text-xs"
          onClick={addFlag}
          loading={flagAction.busy}
          loadingLabel="Saving..."
          disabled={!reasonCode}
        >
          Flag
        </Button>
        {flagAction.error && <InlineStatus variant="error" className="text-xs">{flagAction.error}</InlineStatus>}
      </div>
      <p className="text-[11px] text-slate-500">
        A flag marks a generated {what} as reviewed and keeps the reason. It does not exclude the {what}. Setting the
        status back to generated closes its flags.
      </p>

      {ownNotes.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-700" aria-label={`Notes on this ${what}`}>
          {ownNotes.map((note) => (
            <li key={note.id}>
              <span className="whitespace-pre-wrap">{note.body}</span>{" "}
              <span className="text-slate-500">
                ({note.createdByLabel ?? "unknown"}, <span className="tabular-nums">{formatDateTime(note.createdAt, timeZone)}</span>)
              </span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <label htmlFor={noteId} className={`${labelBase} mb-1 text-xs text-slate-500`}>
          Add a note on this {what}
        </label>
        <TextArea
          id={noteId}
          rows={2}
          value={noteBody}
          maxLength={corpusSchemas.MAX_NOTE_LENGTH}
          onChange={(event) => setNoteBody(event.target.value)}
          className="text-xs"
        />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="px-2 py-1 text-xs"
            onClick={addNote}
            loading={noteAction.busy}
            loadingLabel="Saving..."
            disabled={!noteBody.trim()}
          >
            Add note
          </Button>
          {noteAction.error && <InlineStatus variant="error" className="text-xs">{noteAction.error}</InlineStatus>}
          <span className="text-[11px] text-slate-500">Internal. Participants never see notes.</span>
        </div>
      </div>
    </div>
  );
}
