import type { ReactNode } from "react";
import type { corpusSchemas } from "@dialect/domain";
import { Badge, Card, SectionHeading } from "@/components/ui";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

type Status = corpusSchemas.Dashboard["status"];

function Row({ label, badge, children }: { label: string; badge: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr_auto] items-start gap-3 py-2">
      <dt className="text-sm font-medium text-slate-700">{label}</dt>
      <dd className="min-w-0 text-sm text-slate-600">{children}</dd>
      <dd className="flex justify-end">{badge}</dd>
    </div>
  );
}

function Health({ ok, okLabel = "Healthy", failLabel = "Not healthy" }: { ok: boolean; okLabel?: string; failLabel?: string }) {
  return <Badge variant={ok ? "status" : "error"}>{ok ? okLabel : failLabel}</Badge>;
}

function Configs({ configs, empty }: { configs: corpusSchemas.ActiveConfigSummary[]; empty: string }) {
  if (configs.length === 0) return <span className="text-slate-500">{empty}</span>;
  return (
    <ul className="space-y-0.5">
      {configs.map((config) => (
        <li key={config.id} className="font-mono text-xs text-slate-700">
          {config.key} v{config.versionNumber}
          <span className="text-slate-500">
            {" "}
            {config.provider} / {config.modelId}
            {config.promptKey ? `, prompt ${config.promptKey} v${config.promptVersionNumber}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ConfigBadge({ configs }: { configs: corpusSchemas.ActiveConfigSummary[] }) {
  return configs.length > 0 ? <Badge variant="status">Active</Badge> : <Badge variant="warning">None active</Badge>;
}

/** Study state, protocol, AI configurations and the health of worker, storage and database (spec 42). */
export function StatusCard({ dashboard, now }: { dashboard: corpusSchemas.Dashboard; now: number }) {
  const { study, adminTimezone } = dashboard;
  const status: Status = dashboard.status;
  const studyText =
    study.status !== "active"
      ? `The study is ${study.status}. New participants cannot start.`
      : study.maintenanceMode
        ? "Maintenance mode is on. The participant pages are closed."
        : study.allowNewSessions
          ? "New sessions are allowed."
          : "New sessions are not allowed. Sessions in progress can finish.";

  return (
    <Card as="section" aria-labelledby="status-heading">
      <SectionHeading id="status-heading" title="Status" aside={`Times in ${adminTimezone}`} />
      <dl className="divide-y divide-slate-100">
        <Row
          label="Study"
          badge={
            <Badge variant={study.acceptingNewSessions ? "status" : "warning"} className="uppercase">
              {study.status === "active" ? (study.acceptingNewSessions ? "Active" : "Not accepting") : study.status}
            </Badge>
          }
        >
          {studyText}
        </Row>
        <Row
          label="Protocol"
          badge={
            !status.protocol ? (
              <Badge variant="warning">None</Badge>
            ) : status.exampleText.present ? (
              <Badge variant="warning">Example text</Badge>
            ) : (
              <Badge variant="status">Published</Badge>
            )
          }
        >
          {status.protocol ? (
            <>
              <span className="font-mono text-xs text-slate-700">v{status.protocol.versionNumber}</span> {status.protocol.name}
              {status.protocol.publishedAt && (
                <span className="block text-xs tabular-nums text-slate-500">
                  Published {formatDateTime(status.protocol.publishedAt, adminTimezone)}
                </span>
              )}
              {status.exampleText.present && (
                <span className="block text-xs text-amber-800">{status.exampleText.message}</span>
              )}
            </>
          ) : (
            <span className="text-slate-500">No published protocol is set for new sessions.</span>
          )}
        </Row>
        <Row label="ASR config" badge={<ConfigBadge configs={status.configs.asr} />}>
          <Configs configs={status.configs.asr} empty="No active ASR configuration." />
        </Row>
        <Row label="Translation configs" badge={<ConfigBadge configs={status.configs.translation} />}>
          <Configs configs={status.configs.translation} empty="No active translation configuration." />
        </Row>
        <Row label="TTS config" badge={<ConfigBadge configs={status.configs.tts} />}>
          <Configs configs={status.configs.tts} empty="No active TTS configuration." />
        </Row>
        <Row label="Worker" badge={<Health ok={status.worker.healthy} />}>
          <span className="tabular-nums">
            {status.worker.lastSeenAt
              ? `Last heartbeat ${formatRelativeTime(status.worker.lastSeenAt, now)}.`
              : "No worker has reported yet."}{" "}
            Queue: {status.queue.queued} waiting, {status.queue.running} running, {status.queue.failed} failed.
          </span>
        </Row>
        <Row label="Storage" badge={<Health ok={status.storage.ok} />}>
          Driver <span className="font-mono text-xs text-slate-700">{status.storage.driver}</span>,{" "}
          {status.storage.ok ? "readable and writable." : "not accessible."}
        </Row>
        <Row label="Database" badge={<Health ok={status.database.ok} />}>
          {status.database.ok ? "Connected." : "Not reachable."}
        </Row>
      </dl>
    </Card>
  );
}
