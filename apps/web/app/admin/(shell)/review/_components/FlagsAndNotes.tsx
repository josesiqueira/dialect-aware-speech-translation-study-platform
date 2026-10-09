"use client";

import { useState } from "react";
import {
  FLAG_REASON_CODES,
  TRANSCRIPT_TYPE_LABELS,
  type FlagReasonCode,
  type TranscriptType,
  type transcriptSchemas,
} from "@dialect/domain";
import { Badge, Button, FormField, InlineMessage, Select, TextArea, TextInput } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { FLAG_REASON_LABELS, flagReasonLabel } from "./labels";
import { errorMessage, reviewApi } from "./reviewApi";

export interface FlagsAndNotesProps {
  utteranceId: string;
  flags: transcriptSchemas.ReviewFlagView[];
  notes: transcriptSchemas.ReviewNoteView[];
  /** Transcripts of the utterance that exist, as targets besides the utterance itself. */
  transcripts: { id: string; type: TranscriptType }[];
  annotatorLabel: string;
  timeZone: string;
  onFlagsChange: (flags: transcriptSchemas.ReviewFlagView[]) => void;
  onNotesChange: (notes: transcriptSchemas.ReviewNoteView[]) => void;
}

const targetName = (transcriptType: TranscriptType | null) =>
  transcriptType ? `${TRANSCRIPT_TYPE_LABELS[transcriptType]} transcript` : "Utterance";

/** Notes and flags of the utterance and its transcripts (spec 66, 71, 88). */
export function FlagsAndNotes({
  utteranceId,
  flags,
  notes,
  transcripts,
  annotatorLabel,
  timeZone,
  onFlagsChange,
  onNotesChange,
}: FlagsAndNotesProps) {
  const [noteBody, setNoteBody] = useState("");
  const [noteTarget, setNoteTarget] = useState("");
  const [flagReason, setFlagReason] = useState<FlagReasonCode | "">("");
  const [flagNotes, setFlagNotes] = useState("");
  const [flagTarget, setFlagTarget] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ area: "note" | "flag"; message: string } | null>(null);

  const label = annotatorLabel || undefined;
  const targetOptions = [
    { value: "", label: "Utterance" },
    ...transcripts.map((transcript) => ({ value: transcript.id, label: targetName(transcript.type) })),
  ];
  // A target that no longer exists (the list changed) falls back to the utterance.
  const validTarget = (value: string) => (transcripts.some((transcript) => transcript.id === value) ? value : undefined);

  async function addNote() {
    if (!noteBody.trim()) return;
    setPending("note");
    setError(null);
    try {
      const { note } = await reviewApi.addNote(utteranceId, {
        body: noteBody,
        transcriptId: validTarget(noteTarget),
        annotatorLabel: label,
      });
      onNotesChange([note, ...notes]);
      setNoteBody("");
    } catch (failure) {
      setError({ area: "note", message: errorMessage(failure) });
    } finally {
      setPending(null);
    }
  }

  async function addFlag() {
    if (!flagReason) return;
    setPending("flag");
    setError(null);
    try {
      const { flag } = await reviewApi.addFlag(utteranceId, {
        reasonCode: flagReason,
        notes: flagNotes,
        transcriptId: validTarget(flagTarget),
        annotatorLabel: label,
      });
      onFlagsChange([flag, ...flags]);
      setFlagReason("");
      setFlagNotes("");
    } catch (failure) {
      setError({ area: "flag", message: errorMessage(failure) });
    } finally {
      setPending(null);
    }
  }

  async function resolveFlag(flagId: string) {
    setPending(`resolve:${flagId}`);
    setError(null);
    try {
      const { flag } = await reviewApi.resolveFlag(flagId, label);
      onFlagsChange(flags.map((entry) => (entry.id === flag.id ? flag : entry)));
    } catch (failure) {
      setError({ area: "flag", message: errorMessage(failure) });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <section aria-labelledby="review-notes-heading" className="rounded-lg border border-slate-200 bg-white p-3">
        <h3 id="review-notes-heading" className="text-sm font-semibold text-slate-900">
          Notes
        </h3>
        <p className="text-xs text-slate-500">Internal researcher notes. Participants never see them.</p>
        {notes.length > 0 && (
          <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
            {notes.map((note) => (
              <li key={note.id} className="px-3 py-2">
                <p className="whitespace-pre-wrap text-sm text-slate-800">{note.body}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {targetName(note.transcriptType)}, {note.createdByLabel ?? "unknown"},{" "}
                  <span className="tabular-nums">{formatDateTime(note.createdAt, timeZone)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
        <FormField className="mt-2" label="New note">
          <TextArea rows={2} value={noteBody} maxLength={5000} onChange={(event) => setNoteBody(event.target.value)} />
        </FormField>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <FormField label="Note is about" className="w-40">
            <Select value={noteTarget} onChange={(event) => setNoteTarget(event.target.value)} options={targetOptions} className="py-1.5" />
          </FormField>
          <Button
            size="sm"
            variant="secondary"
            disabled={!noteBody.trim() || pending !== null}
            loading={pending === "note"}
            loadingLabel="Adding..."
            onClick={addNote}
          >
            Add note
          </Button>
        </div>
        {error?.area === "note" && (
          <InlineMessage variant="error" className="mt-2">
            {error.message}
          </InlineMessage>
        )}
      </section>

      <section aria-labelledby="review-flags-heading" className="rounded-lg border border-slate-200 bg-white p-3">
        <h3 id="review-flags-heading" className="text-sm font-semibold text-slate-900">
          Flags
        </h3>
        <p className="text-xs text-slate-500">A flag asks for attention. It does not exclude the utterance.</p>
        {flags.length > 0 && (
          <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
            {flags.map((flag) => (
              <li key={flag.id} className="flex items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {flag.resolvedAt ? <Badge size="sm">Resolved</Badge> : <Badge size="sm" variant="flagged">Flagged</Badge>}
                    <span className="text-sm text-slate-800">{flagReasonLabel(flag.reasonCode)}</span>
                  </div>
                  {flag.notes && <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{flag.notes}</p>}
                  <p className="mt-0.5 text-xs text-slate-500">
                    {targetName(flag.transcriptType)}, {flag.createdByLabel ?? "unknown"},{" "}
                    <span className="tabular-nums">{formatDateTime(flag.createdAt, timeZone)}</span>
                    {flag.resolvedAt && (
                      <>
                        , resolved <span className="tabular-nums">{formatDateTime(flag.resolvedAt, timeZone)}</span>
                      </>
                    )}
                  </p>
                </div>
                {!flag.resolvedAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending !== null}
                    loading={pending === `resolve:${flag.id}`}
                    onClick={() => resolveFlag(flag.id)}
                  >
                    Resolve
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <FormField label="Reason">
            <Select
              value={flagReason}
              onChange={(event) => setFlagReason(event.target.value as FlagReasonCode | "")}
              placeholder="Select a reason"
              options={FLAG_REASON_CODES.map((code) => ({ value: code, label: FLAG_REASON_LABELS[code] }))}
              className="py-1.5"
            />
          </FormField>
          <FormField label="Flag is about">
            <Select value={flagTarget} onChange={(event) => setFlagTarget(event.target.value)} options={targetOptions} className="py-1.5" />
          </FormField>
        </div>
        <FormField className="mt-2" label="Flag note">
          <TextInput value={flagNotes} maxLength={5000} onChange={(event) => setFlagNotes(event.target.value)} />
        </FormField>
        <div className="mt-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!flagReason || pending !== null}
            loading={pending === "flag"}
            loadingLabel="Adding..."
            onClick={addFlag}
          >
            Add flag
          </Button>
        </div>
        {error?.area === "flag" && (
          <InlineMessage variant="error" className="mt-2">
            {error.message}
          </InlineMessage>
        )}
      </section>
    </div>
  );
}
