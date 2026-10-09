import { Badge, DataTable, focusRing, cn, type DataTableColumn } from "@/components/ui";
import { formatCount, formatDateTime } from "@/lib/format";
import { BATCH_STATUS, configLabel } from "./labels";
import type { BatchSummary } from "./types";

/** The frozen configuration labels of one batch as plain text: "ASR asr_default v1; Translation ...; TTS ...". */
function configGroups(batch: BatchSummary): Array<{ stage: string; labels: string[] }> {
  return [
    { stage: "ASR", labels: batch.config.asr ? [configLabel(batch.config.asr)] : [] },
    { stage: "Translation", labels: batch.config.translations.map(configLabel) },
    { stage: "TTS", labels: batch.config.tts.map(configLabel) },
  ];
}

/**
 * One compact cell for the ASR, translation and TTS configurations (the three
 * configuration columns of spec 53). It stays on one line so that rows keep
 * the compact height; a long list is cut with an ellipsis, the whole text is
 * in the title, and the batch detail card shows every configuration in full.
 */
function ConfigsCell({ batch }: { batch: BatchSummary }) {
  const groups = configGroups(batch);
  const title = groups.map((group) => `${group.stage}: ${group.labels.length > 0 ? group.labels.join(", ") : "none"}`).join("; ");
  return (
    <div className="max-w-64 truncate text-xs" title={title}>
      {groups.map((group, index) => (
        <span key={group.stage}>
          {index > 0 && "; "}
          <span className="text-slate-600">{group.stage} </span>
          {group.labels.length > 0 ? (
            group.labels.map((label, labelIndex) => (
              <span key={label}>
                {labelIndex > 0 && ", "}
                <span className="font-mono">{label}</span>
              </span>
            ))
          ) : (
            <span className="text-slate-600">none</span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Compact list of processing batches with the columns of spec 53. The three
 * configuration columns of the spec are shown as one "Configs" column, so the
 * table fits its card at 1440 px and rows stay one line high.
 */
export function BatchTable({
  batches,
  selectedId,
  timeZone,
  onSelect,
}: {
  batches: BatchSummary[];
  selectedId: string | null;
  timeZone: string;
  onSelect: (id: string) => void;
}) {
  const columns: DataTableColumn<BatchSummary>[] = [
    {
      key: "name",
      header: "Name",
      rowHeader: true,
      className: "whitespace-nowrap font-mono text-xs",
      cell: (batch) => (
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSelect(batch.id)}
            aria-pressed={batch.id === selectedId}
            title={batch.name}
            className={cn("max-w-64 truncate rounded-sm text-left font-medium text-slate-900 hover:underline", focusRing)}
          >
            {batch.name}
          </button>
          {batch.dataMode !== "research" && (
            <Badge variant={batch.dataMode} size="sm">
              {batch.dataMode}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      className: "whitespace-nowrap tabular-nums",
      cell: (batch) => formatDateTime(batch.createdAt, timeZone),
    },
    {
      key: "status",
      header: "Status",
      className: "whitespace-nowrap",
      cell: (batch) => <Badge variant={BATCH_STATUS[batch.status].variant}>{BATCH_STATUS[batch.status].label}</Badge>,
    },
    { key: "utterances", header: "Utterances", align: "right", cell: (batch) => formatCount(batch.utteranceCount) },
    { key: "jobs", header: "Jobs", align: "right", cell: (batch) => formatCount(batch.jobCounts.total) },
    { key: "succeeded", header: "Succeeded", align: "right", cell: (batch) => formatCount(batch.jobCounts.succeeded) },
    {
      key: "failed",
      header: "Failed",
      align: "right",
      cell: (batch) => (
        <span className={batch.jobCounts.failed > 0 ? "font-semibold text-rose-700" : undefined}>
          {formatCount(batch.jobCounts.failed)}
        </span>
      ),
    },
    {
      key: "configs",
      header: "Configs",
      cell: (batch) => <ConfigsCell batch={batch} />,
    },
  ];

  return (
    <DataTable
      caption="Processing batches"
      columns={columns}
      rows={batches}
      getRowKey={(batch) => batch.id}
      selectedKey={selectedId}
      emptyTitle="No processing batches yet."
      emptyDescription="Create a batch to run ASR, translation and TTS on a selection of utterances."
      maxHeightClassName="max-h-[50vh]"
      scrollRegion={false}
    />
  );
}
