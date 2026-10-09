"use client";

import { useState } from "react";
import type { corpusSchemas } from "@dialect/domain";
import { DataTable, ErrorState, LoadingState, Pagination } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { useApiResource } from "../../_components/useApiResource";

const PAGE_SIZE = 20;

function Change({ entry }: { entry: corpusSchemas.AuditEntryView }) {
  if (entry.before === null && entry.after === null) return <span className="text-slate-500">no details</span>;
  return (
    <details>
      <summary className="cursor-pointer text-xs text-slate-600 underline underline-offset-2">Show</summary>
      <dl className="mt-1 space-y-1 font-mono text-[11px] text-slate-700">
        {entry.before !== null && (
          <div>
            <dt className="font-sans font-medium text-slate-500">Before</dt>
            <dd className="break-all whitespace-pre-wrap">{JSON.stringify(entry.before, null, 1)}</dd>
          </div>
        )}
        {entry.after !== null && (
          <div>
            <dt className="font-sans font-medium text-slate-500">After</dt>
            <dd className="break-all whitespace-pre-wrap">{JSON.stringify(entry.after, null, 1)}</dd>
          </div>
        )}
      </dl>
    </details>
  );
}

/** Audit entries of one session and of the records below it, newest first (spec 44). */
export function AuditHistory({ sessionId }: { sessionId: string }) {
  const [page, setPage] = useState(1);
  const history = useApiResource<corpusSchemas.AuditHistoryResult>(
    `/api/admin/sessions/${sessionId}/audit?page=${page}&pageSize=${PAGE_SIZE}`,
  );
  if (!history.data) {
    return history.error ? (
      <ErrorState message={history.error} onRetry={() => void history.reload()} />
    ) : (
      <LoadingState size="sm" />
    );
  }
  const timeZone = history.data.adminTimezone;
  return (
    <div aria-busy={history.loading}>
      <DataTable
        caption="Audit history of this session"
        rows={history.data.items}
        getRowKey={(entry) => entry.id}
        emptyTitle="No researcher action has been recorded for this session."
        columns={[
          {
            key: "time",
            header: "Time",
            className: "whitespace-nowrap tabular-nums text-xs",
            cell: (entry) => formatDateTime(entry.createdAt, timeZone, { seconds: true }),
          },
          { key: "action", header: "Action", rowHeader: true, className: "font-mono text-xs", cell: (entry) => entry.action },
          {
            key: "entity",
            header: "Record",
            className: "font-mono text-xs",
            cell: (entry) => `${entry.entityType}${entry.entityId ? ` ${entry.entityId.slice(0, 8)}` : ""}`,
          },
          { key: "actor", header: "By", className: "text-xs", cell: (entry) => entry.actorLabel ?? "system" },
          { key: "change", header: "Change", cell: (entry) => <Change entry={entry} /> },
        ]}
      />
      {history.data.total > PAGE_SIZE && (
        <Pagination
          page={history.data.page}
          pageSize={history.data.pageSize}
          total={history.data.total}
          onPageChange={setPage}
          itemLabel="entries"
          disabled={history.loading}
        />
      )}
    </div>
  );
}
