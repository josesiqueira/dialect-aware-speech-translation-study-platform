"use client";

import { useState, type ReactNode } from "react";
import type { corpusSchemas } from "@dialect/domain";
import { Badge, Button, DataTable, FormField, KeyValueList, SectionHeading, TextArea, type BadgeVariant } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { FailedRunDetail } from "./FailedRunDetail";
import { useAction } from "./helpers";

/** One numbered subsection of the detail panel. */
export function DetailSection({
  id,
  title,
  aside,
  bare = false,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  /** No surface of its own: for a section whose content is a list of cards. */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={bare ? "pt-1" : "rounded-lg border border-slate-200 bg-white p-4"}>
      <SectionHeading id={id} as="h3" title={title} aside={aside} className={bare ? "mb-2 px-1" : "mb-3"} />
      {children}
    </section>
  );
}

export function ConsentSection({ consent, timeZone }: { consent: corpusSchemas.SessionDetail["consent"]; timeZone: string }) {
  if (!consent) return <p className="text-sm text-slate-500">No consent is stored for this session.</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-700">
        <span className="font-medium">Consent version v{consent.versionNumber}</span> ({consent.title}).{" "}
        <span className="tabular-nums">Accepted: {formatDateTime(consent.acceptedAt, timeZone, { seconds: true, zone: true })}</span>
      </p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {consent.items.map((item) => (
          <li key={item.itemId} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm text-slate-800">{item.textSnapshot}</p>
              <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                {item.scope ?? item.itemId}
                {item.required ? ", required" : ", optional"}
              </p>
            </div>
            <Badge size="sm" variant={item.accepted ? "verified" : "incomplete"}>
              {item.accepted ? "Accepted" : "Not accepted"}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function jsonItems(prefix: string, value: Record<string, unknown> | null) {
  return Object.entries(value ?? {}).map(([key, entry]) => ({
    label: `${prefix}${key}`,
    mono: true,
    value: typeof entry === "object" && entry !== null ? JSON.stringify(entry) : String(entry),
  }));
}

export function CaptureSection({ detail }: { detail: corpusSchemas.SessionDetail }) {
  const items = [
    { label: "App version", mono: true, value: `${detail.session.appVersion}${detail.session.gitCommitSha ? ` (${detail.session.gitCommitSha.slice(0, 12)})` : ""}` },
    { label: "Interface language", mono: true, value: detail.session.locale ?? "not recorded" },
    ...jsonItems("", detail.capture.browserInfo),
    ...jsonItems("", detail.capture.audioEnvironment),
  ];
  return (
    <>
      <KeyValueList columns={1} items={items} className="space-y-1 text-xs" />
      {!detail.capture.browserInfo && !detail.capture.audioEnvironment && (
        <p className="mt-2 text-sm text-slate-500">No browser or audio environment data was recorded.</p>
      )}
    </>
  );
}

const PRESENTATION_BADGES: Record<string, BadgeVariant> = {
  completed: "completed",
  started: "neutral",
  pending: "incomplete",
  skipped: "warning",
};

export function TaskSequenceSection({ tasks, timeZone }: { tasks: corpusSchemas.TaskSequenceEntry[]; timeZone: string }) {
  return (
    <DataTable
      caption="Tasks in the order they were shown"
      rows={tasks}
      getRowKey={(task) => task.presentationId}
      emptyTitle="The participant has not reached the tasks."
      columns={[
        { key: "index", header: "#", align: "right", className: "w-8", cell: (task) => task.sequenceIndex + 1 },
        {
          key: "task",
          header: "Task and exact text shown",
          rowHeader: true,
          cell: (task) => (
            <div className="font-normal">
              <p className="text-sm font-medium text-slate-900">
                {task.titleSnapshot} <span className="font-mono text-xs font-normal text-slate-500">{task.taskKey}</span>
              </p>
              <details className="mt-0.5">
                <summary className="cursor-pointer text-xs text-slate-600 underline underline-offset-2">Prompt, context and instructions</summary>
                <div className="mt-1 space-y-1 text-sm whitespace-pre-wrap text-slate-800">
                  <p>{task.promptSnapshot}</p>
                  {task.contextSnapshot && <p className="text-slate-600">Context: {task.contextSnapshot}</p>}
                  {task.instructionsSnapshot && <p className="text-slate-600">Instructions: {task.instructionsSnapshot}</p>}
                  {task.randomization && (
                    <p className="font-mono text-[11px] text-slate-500">Order: {JSON.stringify(task.randomization)}</p>
                  )}
                </div>
              </details>
            </div>
          ),
        },
        { key: "type", header: "Type", className: "text-xs", cell: (task) => task.taskType.replaceAll("_", " ") },
        {
          key: "status",
          header: "Status",
          cell: (task) => (
            <Badge size="sm" variant={PRESENTATION_BADGES[task.status] ?? "neutral"}>
              {task.status}
            </Badge>
          ),
        },
        {
          key: "started",
          header: "Started",
          className: "whitespace-nowrap text-xs tabular-nums",
          cell: (task) => (task.startedAt ? formatDateTime(task.startedAt, timeZone) : ""),
        },
        { key: "utterances", header: "Utterances", align: "right", cell: (task) => task.utteranceIds.length },
      ]}
    />
  );
}

export function NotesSection({
  detail,
  onChanged,
}: {
  detail: corpusSchemas.SessionDetail;
  onChanged: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const action = useAction();
  const timeZone = detail.adminTimezone;
  const ordinalOf = new Map(detail.utterances.map((utterance) => [utterance.id, utterance.ordinal]));
  const where = (entityType: string, entityId: string) =>
    entityType === "utterance" && ordinalOf.has(entityId)
      ? `utterance U-${String(ordinalOf.get(entityId)).padStart(2, "0")}`
      : entityType === "session"
        ? "session"
        : `${entityType} ${entityId.slice(0, 8)}`;

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">Flags</h4>
        {detail.flags.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">No flags.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {detail.flags.map((flag) => (
              <li key={flag.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-sm">
                <Badge size="sm" variant={flag.resolvedAt ? "neutral" : "flagged"}>
                  {flag.resolvedAt ? "Resolved" : "Open"}
                </Badge>
                <span className="font-mono text-xs text-slate-700">{flag.reasonCode ?? "no reason code"}</span>
                <span className="text-xs text-slate-500">on {where(flag.entityType, flag.entityId)}</span>
                <span className="text-xs tabular-nums text-slate-500">
                  {formatDateTime(flag.createdAt, timeZone)}
                  {flag.createdByLabel ? ` by ${flag.createdByLabel}` : ""}
                </span>
                {flag.notes && <p className="w-full text-sm whitespace-pre-wrap text-slate-700">{flag.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">Researcher notes</h4>
        {detail.notes.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">No notes.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {detail.notes.map((note) => (
              <li key={note.id} className="py-2">
                <p className="text-xs tabular-nums text-slate-500">
                  {formatDateTime(note.createdAt, timeZone)}
                  {note.createdByLabel ? ` by ${note.createdByLabel}` : ""}, on {where(note.entityType, note.entityId)}
                </p>
                <p className="text-sm whitespace-pre-wrap text-slate-800">{note.body}</p>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() === "") return;
            void action
              .run(async () => {
                await apiFetch(`/api/admin/sessions/${detail.session.id}/notes`, { method: "POST", body: { body } });
                await onChanged();
              })
              .then((ok) => {
                if (ok) setBody("");
              });
          }}
        >
          <FormField label="Add a note to this session" help="Notes are internal. Participants never see them." error={action.error}>
            <TextArea rows={2} value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} />
          </FormField>
          <Button type="submit" size="sm" variant="secondary" loading={action.busy} loadingLabel="Adding..." disabled={body.trim() === ""}>
            Add note
          </Button>
        </form>
      </div>
    </div>
  );
}

const RUN_BADGES: Record<string, BadgeVariant> = { succeeded: "completed", failed: "error", running: "neutral" };
const JOB_BADGES: Record<string, BadgeVariant> = {
  succeeded: "completed",
  failed: "error",
  running: "neutral",
  queued: "neutral",
  cancelled: "incomplete",
};

export function ProcessingHistorySection({ detail }: { detail: corpusSchemas.SessionDetail }) {
  const timeZone = detail.adminTimezone;
  const ordinalOf = new Map(detail.utterances.map((utterance) => [utterance.id, utterance.ordinal]));
  return (
    <div className="space-y-3">
      <DataTable
        caption="Model runs for the utterances of this session"
        rows={detail.processing.modelRuns}
        getRowKey={(run) => run.id}
        emptyTitle="No model run has processed this session."
        maxHeightClassName="max-h-80"
        columns={[
          {
            key: "time",
            header: "Started",
            className: "whitespace-nowrap text-xs tabular-nums",
            cell: (run) => formatDateTime(run.startedAt, timeZone, { seconds: true }),
          },
          { key: "stage", header: "Stage", rowHeader: true, className: "whitespace-nowrap font-mono text-xs", cell: (run) => `${run.stage}${run.conditionKey ? ` ${run.conditionKey}` : ""}` },
          {
            key: "utterance",
            header: "Utt.",
            className: "whitespace-nowrap font-mono text-xs",
            cell: (run) => (run.utteranceId && ordinalOf.has(run.utteranceId) ? `U-${String(ordinalOf.get(run.utteranceId)).padStart(2, "0")}` : ""),
          },
          { key: "model", header: "Model", className: "whitespace-nowrap font-mono text-xs", cell: (run) => run.requestedModel },
          { key: "batch", header: "Batch", className: "whitespace-nowrap font-mono text-xs", cell: (run) => run.batchName ?? "none" },
          {
            key: "status",
            header: "Status",
            cell: (run) => (
              <div>
                <Badge size="sm" variant={RUN_BADGES[run.status] ?? "neutral"}>
                  {run.status}
                </Badge>
                <FailedRunDetail run={run} />
              </div>
            ),
          },
          { key: "latency", header: "ms", align: "right", className: "text-xs", cell: (run) => run.latencyMs ?? "" },
        ]}
      />
      {detail.processing.jobs.length > 0 && (
        <DataTable
          caption="Queue jobs for this session"
          rows={detail.processing.jobs}
          getRowKey={(job) => job.id}
          maxHeightClassName="max-h-60"
          columns={[
            {
              key: "time",
              header: "Created",
              className: "whitespace-nowrap text-xs tabular-nums",
              cell: (job) => formatDateTime(job.createdAt, timeZone, { seconds: true }),
            },
            { key: "type", header: "Job", rowHeader: true, className: "font-mono text-xs", cell: (job) => job.type },
            {
              key: "status",
              header: "Status",
              cell: (job) => (
                <div>
                  <Badge size="sm" variant={JOB_BADGES[job.status] ?? "neutral"}>
                    {job.status}
                  </Badge>
                  {job.lastError && <p className="mt-0.5 max-w-xs text-xs text-rose-700">{job.lastError}</p>}
                </div>
              ),
            },
            { key: "attempts", header: "Attempts", align: "right", className: "text-xs", cell: (job) => `${job.attempts}/${job.maxAttempts}` },
          ]}
        />
      )}
    </div>
  );
}
