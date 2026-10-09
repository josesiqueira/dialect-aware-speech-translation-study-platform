"use client";

import { useEffect, useState } from "react";
import type { transcriptSchemas } from "@dialect/domain";
import { Badge, InlineMessage, LoadingState, cn } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { errorMessage, reviewApi } from "./reviewApi";

export interface RevisionHistoryProps {
  transcriptId: string;
  revisionCount: number;
  /** Changes whenever the transcript changes, so an open history is read again. */
  version: string;
  timeZone: string;
  className?: string;
}

type Loaded = { version: string; revisions?: transcriptSchemas.TranscriptRevisionView[]; error?: string };

/**
 * Expandable list of every revision of one transcript, newest first (spec 18).
 * Earlier revisions are shown exactly as stored. They are read only when the
 * list is opened.
 */
export function RevisionHistory({ transcriptId, revisionCount, version, timeZone, className }: RevisionHistoryProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    reviewApi
      .history(transcriptId, controller.signal)
      .then((result) => setLoaded({ version, revisions: result.revisions }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ version, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [open, transcriptId, version]);

  const current = loaded?.version === version ? loaded : null;

  return (
    <details
      className={cn("text-xs text-slate-600", className)}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="inline-block cursor-pointer rounded text-slate-600 underline underline-offset-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
        Revision history ({revisionCount})
      </summary>
      <div className="mt-2" aria-busy={open && !current}>
        {open && !current && <LoadingState size="inline" label="Loading revisions..." />}
        {current?.error && <InlineMessage variant="error">{current.error}</InlineMessage>}
        {current?.revisions && (
          <ol className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {current.revisions.map((revision) => (
              <li key={revision.id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium text-slate-700">Revision {revision.revisionNumber}</span>
                  {revision.isCurrent && <Badge size="sm">current</Badge>}
                  {revision.verifiedAt && (
                    <Badge size="sm" variant="verified">
                      verified
                    </Badge>
                  )}
                  <span className="tabular-nums text-slate-500">{formatDateTime(revision.createdAt, timeZone)}</span>
                  <span className="text-slate-500">by {revision.createdByLabel ?? revision.createdByType}</span>
                </div>
                <p lang="fi" className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                  {revision.text}
                </p>
                {revision.changeReason && (
                  <p className="mt-1 text-slate-600">
                    <span className="font-medium">Change reason:</span> {revision.changeReason}
                  </p>
                )}
                {revision.derivedFromRevisionId && (
                  <p className="mt-1 text-slate-500">Started from a copy of another transcript revision.</p>
                )}
                {revision.verifiedAt && (
                  <p className="mt-1 text-slate-600">
                    Verified <span className="tabular-nums">{formatDateTime(revision.verifiedAt, timeZone)}</span>
                    {revision.verifiedByLabel ? ` by ${revision.verifiedByLabel}` : ""}
                    {revision.verificationNotes ? `: ${revision.verificationNotes}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
