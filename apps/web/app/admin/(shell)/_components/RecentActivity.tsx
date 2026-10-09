import Link from "next/link";
import type { ReactNode } from "react";
import { TRANSCRIPT_TYPE_LABELS, type corpusSchemas } from "@dialect/domain";
import { Badge, type BadgeVariant } from "@/components/ui";
import { formatCountOf, formatRelativeTime } from "@/lib/format";
import { ModeBadge } from "./badges";

const linkClass =
  "truncate font-mono text-xs text-slate-700 hover:text-slate-900 hover:underline " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded";

function Group({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h3>
      {children.length === 0 ? (
        <p className="py-2 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">{children}</ul>
      )}
    </div>
  );
}

function Time({ value, now }: { value: string; now: number }) {
  return (
    <time dateTime={value} className="w-24 shrink-0 text-xs tabular-nums text-slate-500">
      {formatRelativeTime(value, now)}
    </time>
  );
}

const BATCH_VARIANTS: Record<string, BadgeVariant> = {
  completed: "completed",
  completed_with_errors: "warning",
  cancelled: "incomplete",
  running: "neutral",
  queued: "neutral",
  draft: "neutral",
};

/** Tight rows, one per event, grouped by kind (the reference RecentActivity density). */
export function RecentActivity({ recent, now }: { recent: corpusSchemas.Dashboard["recent"]; now: number }) {
  const row = "flex min-w-0 items-center gap-3 py-2 text-sm";
  return (
    <div className="space-y-4">
      <Group title="Completed sessions" empty="No completed sessions yet.">
        {recent.completedSessions.slice(0, 5).map((session) => (
          <li key={session.id} className={row}>
            <Time value={session.completedAt} now={now} />
            <Link href={`/admin/sessions?session=${session.id}`} className={linkClass}>
              {session.participantCode}
            </Link>
            <ModeBadge mode={session.mode} />
            <span className="ml-auto shrink-0 text-xs tabular-nums text-slate-500">
              {formatCountOf(session.utteranceCount, "utterance")}
            </span>
          </li>
        ))}
      </Group>

      <Group title="Processing errors" empty="No processing errors.">
        {recent.processingErrors.slice(0, 5).map((error) => (
          <li key={`${error.kind}-${error.id}`} className={row}>
            <Time value={error.at} now={now} />
            <Badge variant="error" size="sm">
              {error.label}
            </Badge>
            <span className="truncate text-slate-600" title={error.message ?? undefined}>
              {error.errorCode ?? (error.kind === "job" ? "Job failed" : "Run failed")}
              {error.message ? `: ${error.message}` : ""}
            </span>
            {error.batchName && (
              <span className="ml-auto shrink-0 font-mono text-xs text-slate-500">{error.batchName}</span>
            )}
          </li>
        ))}
      </Group>

      <Group title="Transcript verifications" empty="No transcript has been verified yet.">
        {recent.transcriptVerifications.slice(0, 5).map((entry) => (
          <li key={entry.revisionId} className={row}>
            <Time value={entry.verifiedAt} now={now} />
            <Badge variant="verified" size="sm">
              {TRANSCRIPT_TYPE_LABELS[entry.transcriptType]} verified
            </Badge>
            <Link href={`/admin/review?utterance=${entry.utteranceId}`} className={linkClass}>
              {entry.participantCode}
            </Link>
            <ModeBadge mode={entry.mode} />
            {entry.verifiedByLabel && (
              <span className="ml-auto shrink-0 text-xs text-slate-500">by {entry.verifiedByLabel}</span>
            )}
          </li>
        ))}
      </Group>

      <Group title="Processing batches" empty="No processing batch has been created yet.">
        {recent.batches.slice(0, 5).map((batch) => (
          <li key={batch.id} className={row}>
            <Time value={batch.completedAt ?? batch.startedAt ?? batch.createdAt} now={now} />
            <Link href="/admin/processing" className={linkClass}>
              {batch.name}
            </Link>
            <ModeBadge mode={batch.dataMode} />
            <span className="ml-auto shrink-0">
              <Badge variant={BATCH_VARIANTS[batch.status] ?? "neutral"} size="sm">
                {batch.status.replaceAll("_", " ")}
              </Badge>
            </span>
          </li>
        ))}
      </Group>
    </div>
  );
}
