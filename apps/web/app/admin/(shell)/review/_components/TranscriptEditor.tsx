"use client";

import type { Ref } from "react";
import { TRANSCRIPT_TYPE_LABELS, type transcriptSchemas } from "@dialect/domain";
import { Badge, Button, FormField, InlineMessage, TextArea, TextInput } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { STATUS_BADGE, STATUS_LABELS, TRANSCRIPT_GUIDANCE, TRANSCRIPT_NAMES } from "./labels";
import { RevisionHistory } from "./RevisionHistory";

export type TranscriptDraft = {
  text: string;
  /** Set while the editor holds a copy of another revision that has not been saved yet. */
  derivedFromRevisionId: string | null;
  changeReason: string;
};

export interface TranscriptEditorProps {
  type: transcriptSchemas.HumanTranscriptType;
  transcript: transcriptSchemas.TranscriptView | null;
  draft: TranscriptDraft;
  onDraftChange: (draft: TranscriptDraft) => void;
  dirty: boolean;
  /** The copy action of this editor: A for A*, B for C. B has none. */
  copySource?: {
    label: string;
    revision: transcriptSchemas.TranscriptRevisionView | null;
    /** Why copying is not possible right now. */
    unavailableReason: string | null;
  };
  timeZone: string;
  disabled: boolean;
  /** Which action of this editor is running. */
  pending: "verify" | "review" | null;
  error: string | null;
  reasonMissing: boolean;
  reasonRef?: Ref<HTMLInputElement>;
  /** A note about the saved transcript that blocks nothing, for example that C is based on an older B. */
  notice?: string | null;
  onVerify: () => void;
  onToggleReview: () => void;
}

/** One editable transcript (A*, B or C) with its status, actions and revision history. */
export function TranscriptEditor({
  type,
  transcript,
  draft,
  onDraftChange,
  dirty,
  copySource,
  timeZone,
  disabled,
  pending,
  error,
  reasonMissing,
  reasonRef,
  notice,
  onVerify,
  onToggleReview,
}: TranscriptEditorProps) {
  const letter = TRANSCRIPT_TYPE_LABELS[type];
  const status = transcript?.status ?? "not_started";
  const current = transcript?.currentRevision ?? null;
  const isVerified = status === "verified";
  const hasText = draft.text.trim().length > 0;
  const needsReason = isVerified && dirty;
  const headingId = `transcript-${type}-heading`;
  const copyBlocked = copySource ? (copySource.unavailableReason ?? (dirty ? "The editor has unsaved text." : null)) : null;

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="text-sm font-semibold text-slate-900">
            {letter} <span className="font-medium text-slate-700">{TRANSCRIPT_NAMES[type]}</span>
          </h3>
          <Badge size="sm" variant={STATUS_BADGE[status]}>
            {STATUS_LABELS[status]}
          </Badge>
          {dirty && <span className="text-xs text-amber-800">Unsaved changes</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {copySource && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || copyBlocked !== null}
              title={copyBlocked ?? undefined}
              onClick={() => {
                if (!copySource.revision) return;
                onDraftChange({ ...draft, text: copySource.revision.text, derivedFromRevisionId: copySource.revision.id });
              }}
            >
              Copy {copySource.label} into editor
            </Button>
          )}
          {status !== "verified" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || (!current && !hasText)}
              loading={pending === "review"}
              onClick={onToggleReview}
            >
              {status === "needs_review" && !dirty ? "Back to draft" : "Request second review"}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || (!dirty && (isVerified || !current)) || (dirty && !hasText)}
            loading={pending === "verify"}
            loadingLabel="Verifying..."
            onClick={onVerify}
          >
            Mark {letter} verified
          </Button>
        </div>
      </div>

      {notice && (
        <InlineMessage variant="warning" className="mt-2 px-3 py-1.5 text-xs">
          {notice}
        </InlineMessage>
      )}

      <FormField
        className="mt-2"
        label={`${letter} transcript text`}
        hideLabel
        help={TRANSCRIPT_GUIDANCE[type]}
        error={error}
      >
        <TextArea
          rows={4}
          lang="fi"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={draft.text}
          disabled={disabled}
          onChange={(event) => onDraftChange({ ...draft, text: event.target.value })}
          className="resize-y font-sans text-sm leading-relaxed"
        />
      </FormField>

      {draft.derivedFromRevisionId && dirty && copySource && (
        <p className="mt-1 text-xs text-slate-500">
          Started from a copy of {copySource.label}. The source revision is recorded when you save.
        </p>
      )}

      {needsReason && (
        <FormField
          className="mt-2"
          label="Change reason"
          required
          help="This transcript is verified. Saving creates a new revision and returns the transcript to draft. The verified revision stays in the history."
          error={reasonMissing ? "Give a change reason before saving." : undefined}
        >
          <TextInput
            ref={reasonRef}
            value={draft.changeReason}
            disabled={disabled}
            maxLength={1000}
            onChange={(event) => onDraftChange({ ...draft, changeReason: event.target.value })}
          />
        </FormField>
      )}

      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {transcript && transcript.revisionCount > 0 ? (
          <RevisionHistory
            className="min-w-0 flex-1"
            transcriptId={transcript.id}
            revisionCount={transcript.revisionCount}
            version={`${transcript.revisionCount}:${transcript.status}:${current?.verifiedAt ?? ""}`}
            timeZone={timeZone}
          />
        ) : (
          <span className="text-xs text-slate-500">No revisions yet</span>
        )}
        {current?.verifiedAt && isVerified && (
          <span className="shrink-0 text-xs text-slate-500">
            Verified <span className="tabular-nums">{formatDateTime(current.verifiedAt, timeZone)}</span>
            {current.verifiedByLabel ? ` by ${current.verifiedByLabel}` : ""}
          </span>
        )}
      </div>

    </section>
  );
}
