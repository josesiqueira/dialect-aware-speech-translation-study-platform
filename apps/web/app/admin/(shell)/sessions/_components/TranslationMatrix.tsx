"use client";

import { useState } from "react";
import { FLAG_REASON_CODES, OUTPUT_STATUSES, type OutputStatus, type corpusSchemas } from "@dialect/domain";
import { Badge, Button, CopyableId, InlineStatus, cn, filterControl, type KeyValueItem } from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { downloadText, fileNamePart, formatBytes, mediaDownloadUrl, mediaUrl, useAction } from "./helpers";
import { OutputNotes } from "./OutputNotes";

const textLink =
  "rounded text-xs text-slate-600 underline underline-offset-2 hover:text-slate-900 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

export type MatrixContext = {
  participantCode: string;
  utteranceOrdinal: number;
  timeZone: string;
  onChanged: () => Promise<void>;
  /** Flags and notes of the session (spec 45, 88). Each cell shows the ones of its outputs. */
  flags?: corpusSchemas.FlagView[];
  notes?: corpusSchemas.NoteView[];
};

/** Loads the audio only after the listener asks for it (spec 133). */
function LazyAudio({ mediaAssetId, label, meta }: { mediaAssetId: string; label: string; meta: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        <span aria-hidden="true">▶</span> Play TTS
        <span className="font-normal text-slate-500">{meta}</span>
      </button>
    );
  }
  return (
    // Captions do not apply: the spoken text is the translation shown above the player.
    <audio controls autoPlay preload="auto" src={mediaUrl(mediaAssetId)} aria-label={label} className="block h-8 w-full max-w-xs" />
  );
}

/**
 * Label and value pairs of a provenance record, with a narrow label column for the matrix cells.
 * An identifier (mono) is placed under its label, so it has the whole width of the cell and
 * stays on one line where it fits, instead of wrapping several times in the narrow value column.
 */
function ProvenanceList({ items }: { items: KeyValueItem[] }) {
  return (
    <dl className="space-y-1 text-xs text-slate-600">
      {items.map((item, index) => (
        <div key={index} className={item.mono ? undefined : "grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2"}>
          <dt className="font-medium text-slate-700">{item.label}</dt>
          <dd className={cn("min-w-0 break-words", item.mono && "font-mono text-[11px] tabular-nums text-slate-700")}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function runItems(run: corpusSchemas.ModelRunSummary, timeZone: string): KeyValueItem[] {
  return [
    {
      label: "Model",
      mono: true,
      value: `${run.provider} / ${run.requestedModel}${run.returnedModel && run.returnedModel !== run.requestedModel ? ` (returned ${run.returnedModel})` : ""}`,
    },
    { label: "Prompt version", mono: true, value: run.prompt ? `${run.prompt.key} v${run.prompt.versionNumber}` : "none" },
    {
      label: "Config version",
      mono: true,
      value: run.modelConfig ? `${run.modelConfig.key} v${run.modelConfig.versionNumber}` : "not recorded",
    },
    {
      label: "Parameters",
      mono: true,
      value: Object.keys(run.parameters).length > 0 ? JSON.stringify(run.parameters) : "none",
    },
    {
      label: "Generated",
      mono: true,
      value: `${formatDateTime(run.finishedAt ?? run.startedAt, timeZone, { seconds: true, zone: true })}${run.latencyMs !== null ? `, ${run.latencyMs} ms` : ""}`,
    },
    { label: "App version", mono: true, value: `${run.appVersion}${run.gitCommitSha ? ` (${run.gitCommitSha.slice(0, 12)})` : ""}` },
    { label: "Run id", value: <CopyableId value={run.id} label="model run id" truncate={8} /> },
    ...(run.providerRequestId ? [{ label: "Provider request", mono: true, value: run.providerRequestId }] : []),
    ...(run.attemptNumber > 1 ? [{ label: "Attempt", mono: true, value: String(run.attemptNumber) }] : []),
  ];
}

const STATUS_LABELS: Record<OutputStatus, string> = { generated: "Generated", reviewed: "Reviewed", excluded: "Excluded" };

/** Status of one output. Only the status can change: text, audio and provenance are immutable. */
function OutputStatusControl({
  kind,
  id,
  status,
  onChanged,
}: {
  kind: "translations" | "syntheses";
  id: string;
  status: OutputStatus;
  onChanged: () => Promise<void>;
}) {
  const [next, setNext] = useState<OutputStatus>(status);
  const [reasonCode, setReasonCode] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const what = kind === "translations" ? "translation" : "TTS output";

  async function apply() {
    setSaved(false);
    const ok = await action.run(async () => {
      await apiFetch(`/api/admin/sessions/outputs/${kind}/${id}/status`, {
        method: "PATCH",
        body: { status: next, ...(reasonCode ? { reasonCode } : {}) },
      });
      await onChanged();
    });
    if (ok) {
      setSaved(true);
      setReasonCode("");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={`Status of this ${what}`}
        value={next}
        onChange={(event) => setNext(event.target.value as OutputStatus)}
        className={cn(filterControl, "px-2 py-1 text-xs")}
      >
        {OUTPUT_STATUSES.map((value) => (
          <option key={value} value={value}>
            {STATUS_LABELS[value]}
          </option>
        ))}
      </select>
      <select
        aria-label="Reason (optional)"
        value={reasonCode}
        onChange={(event) => setReasonCode(event.target.value)}
        className={cn(filterControl, "px-2 py-1 text-xs")}
      >
        <option value="">No reason given</option>
        {FLAG_REASON_CODES.map((code) => (
          <option key={code} value={code}>
            {code.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="secondary"
        className="px-2 py-1 text-xs"
        onClick={apply}
        loading={action.busy}
        loadingLabel="Saving..."
        disabled={next === status && reasonCode === ""}
      >
        Set status
      </Button>
      {saved && !action.busy && <InlineStatus variant="success" className="text-xs">Saved</InlineStatus>}
      {action.error && <InlineStatus variant="error" className="text-xs">{action.error}</InlineStatus>}
    </div>
  );
}

function StatusBadge({ status }: { status: OutputStatus }) {
  if (status === "excluded") {
    return (
      <Badge variant="excluded" size="sm">
        Excluded
      </Badge>
    );
  }
  if (status === "reviewed") {
    return (
      <Badge variant="verified" size="sm">
        Reviewed
      </Badge>
    );
  }
  return null;
}

function TranslationCell({
  translation,
  batch,
  context,
}: {
  translation: corpusSchemas.TranslationCellView;
  batch: corpusSchemas.BatchSummary;
  context: MatrixContext;
}) {
  const run = translation.modelRun;
  const source = translation.sourceRevision;
  const rowLabel = { asr: "A", asr_corrected: "Astar", human_dialect: "B", normalized: "C" }[source.transcriptType];
  const baseName = [
    fileNamePart(context.participantCode),
    `U-${String(context.utteranceOrdinal).padStart(2, "0")}`,
    rowLabel,
    fileNamePart(translation.conditionKey),
    fileNamePart(batch.name),
  ].join("_");
  // Open flags and notes of this translation and its TTS outputs, shown as a count while the disclosure is closed.
  const outputIds = new Set([translation.id, ...translation.syntheses.map((synthesis) => synthesis.id)]);
  const outputMarks =
    (context.flags ?? []).filter((flag) => flag.resolvedAt === null && outputIds.has(flag.entityId)).length +
    (context.notes ?? []).filter((note) => outputIds.has(note.entityId)).length;

  return (
    <div className="space-y-1.5">
      <p className={cn("text-sm whitespace-pre-wrap text-slate-900", translation.status === "excluded" && "text-slate-500")}>
        {translation.text}
      </p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-slate-500">
        <span>{run.requestedModel}</span>
        {run.prompt && (
          <span>
            {run.prompt.key} v{run.prompt.versionNumber}
          </span>
        )}
        <span className={cn(!source.isCurrent && "text-amber-800")}>
          from rev {source.revisionNumber}
          {!source.isCurrent && " (not the current revision)"}
        </span>
        {translation.repetitionIndex > 0 && <span>repetition {translation.repetitionIndex}</span>}
        <StatusBadge status={translation.status} />
      </p>

      {translation.syntheses.map((synthesis) => (
        <div key={synthesis.id} className="flex flex-wrap items-center gap-2">
          {synthesis.media.deletedAt ? (
            <span className="text-xs text-slate-500">TTS audio deleted</span>
          ) : (
            <>
              <LazyAudio
                mediaAssetId={synthesis.media.id}
                label={`TTS of the ${translation.conditionKey} translation, voice ${synthesis.voiceKey}`}
                meta={`${synthesis.voiceKey}, ${formatDurationMs(synthesis.media.durationMs)}`}
              />
              <a href={mediaDownloadUrl(synthesis.media.id)} download className={textLink}>
                Download audio
              </a>
            </>
          )}
          <StatusBadge status={synthesis.status} />
        </div>
      ))}
      {translation.syntheses.length === 0 && <p className="text-xs text-slate-500">No TTS output</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={textLink} onClick={() => downloadText(`${baseName}.txt`, translation.text)}>
          Download text
        </button>
      </div>

      <details className="rounded-md border border-slate-200 bg-slate-50/60">
        <summary className="cursor-pointer px-2 py-1 text-xs font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
          Provenance, status, flags and notes
          {outputMarks > 0 && <span className="ml-1 font-normal text-slate-500">({outputMarks})</span>}
        </summary>
        <div className="space-y-3 border-t border-slate-200 px-2 py-2">
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Translation</p>
            <ProvenanceList
              items={[
                { label: "Translation id", value: <CopyableId value={translation.id} label="translation id" truncate={8} /> },
                { label: "Condition", mono: true, value: `${translation.conditionKey} (target ${translation.targetLanguage})` },
                {
                  label: "Source transcript",
                  mono: true,
                  value: `${rowLabel === "Astar" ? "A*" : rowLabel} revision ${source.revisionNumber} (${source.id.slice(0, 8)})`,
                },
                { label: "Batch", mono: true, value: `${batch.name} (${batch.id.slice(0, 8)})` },
                ...runItems(run, context.timeZone),
              ]}
            />
            <div className="mt-2">
              <OutputStatusControl
                kind="translations"
                id={translation.id}
                status={translation.status}
                onChanged={context.onChanged}
              />
            </div>
            <OutputNotes
              kind="translations"
              id={translation.id}
              status={translation.status}
              flags={context.flags ?? []}
              notes={context.notes ?? []}
              timeZone={context.timeZone}
              onChanged={context.onChanged}
            />
          </div>
          {translation.syntheses.map((synthesis) => (
            <div key={synthesis.id}>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                TTS ({synthesis.conditionKey})
              </p>
              <ProvenanceList
              items={[
                  { label: "Synthesis id", value: <CopyableId value={synthesis.id} label="synthesis id" truncate={8} /> },
                  { label: "Voice", mono: true, value: synthesis.voiceKey },
                  { label: "Audio asset", value: <CopyableId value={synthesis.media.id} label="media asset id" truncate={8} /> },
                  { label: "SHA-256", value: <CopyableId value={synthesis.media.sha256} label="audio hash" truncate={16} /> },
                  {
                    label: "Audio format",
                    mono: true,
                    value: `${synthesis.media.captureSummary}, ${formatDurationMs(synthesis.media.durationMs, { tenths: true })}, ${formatBytes(synthesis.media.sizeBytes)}`,
                  },
                  {
                    label: "Text spoken",
                    value: synthesis.sourceText === translation.text ? "identical to the translation" : synthesis.sourceText,
                  },
                  ...runItems(synthesis.modelRun, context.timeZone),
                ]}
              />
              <div className="mt-2">
                <OutputStatusControl
                  kind="syntheses"
                  id={synthesis.id}
                  status={synthesis.status}
                  onChanged={context.onChanged}
                />
              </div>
              <OutputNotes
                kind="syntheses"
                id={synthesis.id}
                status={synthesis.status}
                flags={context.flags ?? []}
                notes={context.notes ?? []}
                timeZone={context.timeZone}
                onChanged={context.onChanged}
              />
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * Translations of one utterance for one processing batch (spec 45): rows A, A*,
 * B, C and one column per translation condition. Conditions are shown side by
 * side for inspection. Nothing here compares or scores them.
 */
export function TranslationMatrix({ view, context }: { view: corpusSchemas.TranslationBatchView; context: MatrixContext }) {
  const { batch } = view;
  const rows = view.rows;
  return (
    <div className="relative overflow-x-auto rounded-lg border border-slate-200">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Processing batch</span>
        <span className="font-mono text-xs font-medium text-slate-900">{batch.name}</span>
        <Badge size="sm" variant={batch.status === "completed" ? "completed" : batch.status === "completed_with_errors" ? "warning" : "neutral"}>
          {batch.status.replaceAll("_", " ")}
        </Badge>
        <span className="text-xs tabular-nums text-slate-500">
          {formatDateTime(batch.completedAt ?? batch.startedAt ?? batch.createdAt, context.timeZone)}
        </span>
      </div>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Translations of batch {batch.name} by transcript and condition</caption>
        <thead>
          <tr>
            <th scope="col" className="w-12 border-b border-slate-200 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <span className="sr-only">Transcript</span>
            </th>
            {view.conditions.map((condition) => (
              <th
                key={condition}
                scope="col"
                className="border-b border-slate-200 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
              >
                {condition}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.transcriptType}>
              <th scope="row" className="px-3 py-2 align-top font-mono text-sm font-semibold text-slate-900">
                {row.label}
              </th>
              {row.cells.map((cell) => (
                <td key={cell.conditionKey} className="min-w-[15rem] px-3 py-2 align-top">
                  {cell.translations.length === 0 ? (
                    <span className="text-xs text-slate-500">No translation</span>
                  ) : (
                    <div className="space-y-3">
                      {cell.translations.map((translation) => (
                        <TranslationCell key={translation.id} translation={translation} batch={batch} context={context} />
                      ))}
                    </div>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
