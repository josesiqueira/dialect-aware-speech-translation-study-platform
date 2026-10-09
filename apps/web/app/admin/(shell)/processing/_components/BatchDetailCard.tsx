"use client";

import { useState } from "react";
import { TRANSCRIPT_TYPE_LABELS } from "@dialect/domain";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CopyableId,
  DataTable,
  InlineMessage,
  KeyValueList,
  MetricCard,
  SectionHeading,
  type DataTableColumn,
} from "@/components/ui";
import { formatCount, formatCountOf, formatDateTime } from "@/lib/format";
import { cancelBatch, errorMessage, retryFailedJobs, startBatch } from "./api";
import { ConfigSnapshotList } from "./ConfigSnapshotView";
import { BATCH_STATUS, TASK_TYPE_NAMES } from "./labels";
import type { BatchDetail, BatchJob } from "./types";

type Action = "start" | "retry" | "cancel";

const ACTION_COPY: Record<Action, { title: string; confirm: string; busy: string }> = {
  start: { title: "Start this batch?", confirm: "Start batch", busy: "Starting..." },
  retry: { title: "Retry the failed jobs?", confirm: "Retry failed", busy: "Queueing..." },
  cancel: { title: "Cancel this batch?", confirm: "Cancel batch", busy: "Cancelling..." },
};

function sourceOf(job: BatchJob): string {
  const payload = job.payload as Record<string, unknown>;
  const pick = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : null);
  const utterance = pick("utteranceId");
  const revision = pick("sourceTranscriptRevisionId");
  const translation = pick("translationId");
  if (translation) return `translation ${translation.slice(0, 8)}`;
  if (revision) return `revision ${revision.slice(0, 8)}`;
  if (utterance) return `utterance ${utterance.slice(0, 8)}`;
  return "";
}

/** One batch: status, counts, actions, failed jobs and the frozen configuration. */
export function BatchDetailCard({
  batch,
  timeZone,
  onChanged,
}: {
  batch: BatchDetail;
  timeZone: string;
  onChanged: (batch: BatchDetail) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const status = BATCH_STATUS[batch.status];
  const counts = batch.jobCounts;
  const canStart = batch.status === "draft";
  const canCancel = batch.status === "draft" || batch.status === "queued" || batch.status === "running";
  const canRetry = counts.failed > 0 && batch.status !== "cancelled" && batch.status !== "draft";
  const selection = batch.configuration.selection;
  const time = (value: string | null) => (value ? formatDateTime(value, timeZone, { zone: true }) : "not yet");

  async function runAction() {
    if (!action) return;
    setBusy(true);
    setActionError(null);
    try {
      if (action === "start") {
        onChanged(await startBatch(batch.id));
        setNotice("The batch was started. Its configuration can no longer change.");
      } else if (action === "retry") {
        const result = await retryFailedJobs(batch.id);
        onChanged(result.batch);
        setNotice(`Queued again: ${formatCountOf(result.retried, "failed job")}. Succeeded jobs are not run again.`);
      } else {
        onChanged(await cancelBatch(batch.id));
        setNotice("The batch was cancelled. Running jobs finish, queued jobs do not start.");
      }
      setAction(null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const failedColumns: DataTableColumn<BatchJob>[] = [
    { key: "type", header: "Job", rowHeader: true, className: "font-mono text-xs", cell: (job) => job.type },
    { key: "source", header: "Source", className: "font-mono text-xs whitespace-nowrap", cell: sourceOf },
    { key: "attempts", header: "Attempts", align: "right", cell: (job) => `${job.attempts} of ${job.maxAttempts}` },
    {
      key: "error",
      header: "Error",
      cell: (job) => <span className="break-words text-rose-700">{job.lastError ?? "No error text was stored."}</span>,
    },
    {
      key: "updated",
      header: "Failed at",
      className: "whitespace-nowrap tabular-nums",
      cell: (job) => formatDateTime(job.finishedAt ?? job.updatedAt, timeZone),
    },
  ];

  return (
    <Card padding="none" as="section" aria-label={`Batch ${batch.name}`}>
      <CardHeader
        title={batch.name}
        description={batch.description ?? undefined}
        meta={
          <span className="inline-flex items-center gap-2">
            <Badge variant={status.variant}>{status.label}</Badge>
            {batch.dataMode !== "research" && <Badge variant={batch.dataMode}>{batch.dataMode}</Badge>}
          </span>
        }
        actions={
          <>
            {canStart && (
              <Button size="sm" onClick={() => setAction("start")}>
                Start batch
              </Button>
            )}
            {canRetry && (
              <Button size="sm" onClick={() => setAction("retry")}>
                Retry failed
              </Button>
            )}
            {canCancel && (
              <Button size="sm" variant="secondary" onClick={() => setAction("cancel")}>
                Cancel batch
              </Button>
            )}
          </>
        }
      />
      <CardBody className="space-y-6">
        {notice && <InlineMessage variant="success">{notice}</InlineMessage>}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <MetricCard density="compact" label="Jobs" value={formatCount(counts.total)} />
          <MetricCard density="compact" label="Queued" value={formatCount(counts.queued)} />
          <MetricCard density="compact" label="Running" value={formatCount(counts.running)} />
          <MetricCard density="compact" label="Succeeded" value={formatCount(counts.succeeded)} />
          <MetricCard
            density="compact"
            label="Failed"
            value={formatCount(counts.failed)}
            accent={counts.failed > 0 ? "danger" : "default"}
          />
          <MetricCard density="compact" label="Cancelled" value={formatCount(counts.cancelled)} />
        </div>

        <KeyValueList
          items={[
            { label: "Batch id", value: <CopyableId value={batch.id} label="batch id" /> },
            { label: "Created", value: `${time(batch.createdAt)}${batch.createdByLabel ? ` by ${batch.createdByLabel}` : ""}` },
            { label: "Started", value: time(batch.startedAt) },
            {
              label: batch.status === "cancelled" ? "Cancelled" : "Completed",
              value: time(batch.status === "cancelled" ? batch.cancelledAt : batch.completedAt),
            },
            { label: "Utterances", value: formatCount(batch.utteranceCount) },
            {
              label: "Outputs stored",
              value: `${formatCountOf(batch.outputCounts.asrRevisions, "ASR transcript")}, ${formatCountOf(
                batch.outputCounts.translations,
                "translation",
              )}, ${formatCountOf(batch.outputCounts.syntheses, "TTS file")}`,
            },
            {
              label: "Model runs",
              value: `${formatCount(batch.modelRunCounts.succeeded)} succeeded, ${formatCount(batch.modelRunCounts.failed)} failed`,
            },
            ...(batch.estimatedCost
              ? [{ label: "Estimated API cost (estimate)", value: batch.estimatedCost.amount.toFixed(4), mono: true }]
              : []),
          ]}
        />

        <section className="space-y-2">
          <SectionHeading
            as="h3"
            title="Failed jobs"
            description={
              counts.failed > batch.failedJobs.length
                ? `Showing the newest ${batch.failedJobs.length} of ${formatCount(counts.failed)}.`
                : undefined
            }
          />
          <DataTable
            caption="Failed jobs of this batch"
            columns={failedColumns}
            rows={batch.failedJobs}
            getRowKey={(job) => job.id}
            emptyTitle="No failed jobs."
            maxHeightClassName="max-h-72"
          />
        </section>

        <section className="space-y-3">
          <SectionHeading
            as="h3"
            title="Frozen configuration"
            description={
              batch.status === "draft"
                ? "Copied when the batch was created. It is used unchanged when the batch starts."
                : "Copied when the batch was created. It cannot change. Create a new batch for changed settings."
            }
          />
          <KeyValueList
            items={[
              { label: "Data mode", value: selection.mode.join(", ") },
              { label: "Completed sessions only", value: selection.completedSessionsOnly ? "yes" : "no" },
              { label: "Verified transcripts only", value: selection.verifiedTranscriptsOnly ? "yes" : "no" },
              { label: "Exclude flagged", value: selection.excludeFlagged ? "yes" : "no" },
              { label: "Exclude excluded", value: selection.excludeExcluded ? "yes" : "no" },
              {
                label: "Task types",
                value: selection.taskTypes?.length ? selection.taskTypes.map((type) => TASK_TYPE_NAMES[type]).join(", ") : "all",
              },
              {
                label: "Protocol versions",
                value: selection.protocolVersionIds?.length ? `${selection.protocolVersionIds.length} selected` : "all",
              },
              {
                label: "Session date range",
                value: selection.dateFrom || selection.dateTo ? `${selection.dateFrom ?? "any"} to ${selection.dateTo ?? "any"}` : "all",
              },
              {
                label: "Transcript types translated",
                value:
                  batch.configuration.transcriptTypes.length > 0
                    ? batch.configuration.transcriptTypes.map((type) => TRANSCRIPT_TYPE_LABELS[type]).join(", ")
                    : "none",
              },
              {
                label: "Languages",
                value: `${batch.configuration.sourceLanguage || "not set"} to ${batch.configuration.targetLanguage || "not set"}`,
                mono: true,
              },
            ]}
          />
          <ConfigSnapshotList
            asr={batch.configuration.asr}
            translations={batch.configuration.translations}
            tts={batch.configuration.tts}
          />
        </section>
      </CardBody>

      <ConfirmDialog
        open={action !== null}
        title={action ? ACTION_COPY[action].title : ""}
        confirmLabel={action ? ACTION_COPY[action].confirm : "Confirm"}
        cancelLabel="Keep as is"
        tone={action === "cancel" ? "danger" : "default"}
        busy={busy}
        busyLabel={action ? ACTION_COPY[action].busy : undefined}
        error={actionError}
        onConfirm={runAction}
        onCancel={() => {
          setAction(null);
          setActionError(null);
        }}
      >
        {action === "start" && (
          <p>
            The jobs of this batch are queued and the selected audio and transcript text are sent to the configured AI
            provider. After the start the configuration cannot change.
          </p>
        )}
        {action === "retry" && (
          <p>
            Queued again under the same frozen configuration: {formatCountOf(counts.failed, "failed job")}. Jobs that
            succeeded are not run again.
          </p>
        )}
        {action === "cancel" && (
          <p>
            Queued jobs are cancelled and running jobs finish. Outputs that were already stored are kept, and the batch
            stays visible. A cancelled batch cannot be started or retried.
          </p>
        )}
      </ConfirmDialog>
    </Card>
  );
}
