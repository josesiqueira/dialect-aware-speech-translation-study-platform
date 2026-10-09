"use client";

import type { corpusSchemas } from "@dialect/domain";
import { Badge, EmptyState, ListRowButton, Pagination, cn } from "@/components/ui";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { ModeBadge, SessionStatusBadge } from "../../_components/badges";

type SortKey = corpusSchemas.SessionSortKey;

export interface SessionListProps {
  result: corpusSchemas.SessionListResult;
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onSort: (sort: SortKey, direction: "asc" | "desc") => void;
  onPageChange: (page: number) => void;
}

const SORTS: Array<{ key: SortKey; label: string; firstDirection: "asc" | "desc" }> = [
  { key: "started_at", label: "Started", firstDirection: "desc" },
  { key: "participant_code", label: "Code", firstDirection: "asc" },
  { key: "utterance_count", label: "Utterances", firstDirection: "desc" },
  { key: "audio_duration", label: "Audio", firstDirection: "desc" },
  { key: "status", label: "Status", firstDirection: "asc" },
];

/** Compact selectable rows with a sticky sortable header (the reference ConversationList). */
export function SessionList({ result, selectedId, loading, error, onSelect, onSort, onPageChange }: SessionListProps) {
  const timeZone = result.adminTimezone;
  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <span className="sr-only">Sort by</span>
        {SORTS.map((sort) => {
          const active = result.sort === sort.key;
          const next = active ? (result.direction === "asc" ? "desc" : "asc") : sort.firstDirection;
          return (
            <button
              key={sort.key}
              type="button"
              onClick={() => onSort(sort.key, next)}
              aria-label={`Sort by ${sort.label.toLowerCase()}, ${next === "asc" ? "ascending" : "descending"}`}
              className="flex items-center gap-1 rounded uppercase tracking-wide hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              {sort.label}
              <span aria-hidden="true" className={active ? "text-slate-700" : "text-slate-500"}>
                {active ? (result.direction === "asc" ? "▲" : "▼") : "↕"}
              </span>
            </button>
          );
        })}
        {loading && <span className="ml-auto font-normal normal-case motion-safe:animate-pulse">Loading...</span>}
      </div>

      {error && (
        <p role="alert" className="border-b border-rose-200 bg-rose-50 px-3 py-1.5 text-xs text-rose-700">
          {error}
        </p>
      )}

      {result.items.length === 0 ? (
        <EmptyState title="No sessions match the selected filters." />
      ) : (
        <div className="divide-y divide-slate-100">
          {result.items.map((session) => (
            <ListRowButton key={session.id} selected={selectedId === session.id} onClick={() => onSelect(session.id)}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-mono text-sm font-medium text-slate-900">{session.participantCode}</span>
                  <ModeBadge mode={session.mode} showResearch />
                  <SessionStatusBadge status={session.status} />
                  {(session.flagged || session.flaggedUtterances > 0) && (
                    <Badge variant="flagged" size="sm">
                      Flagged
                    </Badge>
                  )}
                  {session.excluded && (
                    <Badge variant="excluded" size="sm">
                      Excluded
                    </Badge>
                  )}
                  {session.processingErrors > 0 && (
                    <Badge variant="error" size="sm">
                      Processing error
                    </Badge>
                  )}
                </div>
                <time dateTime={session.startedAt} className="whitespace-nowrap text-xs tabular-nums text-slate-500">
                  {formatDateTime(session.startedAt, timeZone)}
                </time>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-slate-500">
                <span>Protocol v{session.protocolVersionNumber}</span>
                <span>
                  Tasks {session.tasksCompleted}/{session.tasksTotal}
                </span>
                <span>
                  {session.utteranceCount} {session.utteranceCount === 1 ? "utterance" : "utterances"}
                </span>
                <span>{formatDurationMs(session.audioDurationMs)}</span>
                <span className={cn(session.review.complete && "text-emerald-700")}>
                  {session.review.complete
                    ? "Review complete"
                    : `Verified B ${session.review.verifiedB}/${session.utteranceCount}, C ${session.review.verifiedC}/${session.utteranceCount}`}
                </span>
                {session.excludedUtterances > 0 && <span>{session.excludedUtterances} excluded</span>}
              </div>
            </ListRowButton>
          ))}
        </div>
      )}

      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        onPageChange={onPageChange}
        itemLabel={result.total === 1 ? "session" : "sessions"}
        disabled={loading}
        className="sticky bottom-0 bg-white"
      />
    </div>
  );
}
