"use client";

import Link from "next/link";
import { useState } from "react";
import { corpusSchemas, type ReviewStatus } from "@dialect/domain";
import {
  AudioPlayer,
  Badge,
  Button,
  ConfirmDialog,
  CopyableId,
  FormField,
  InlineMessage,
  TextArea,
  buttonClasses,
  cn,
  type BadgeVariant,
} from "@/components/ui";
import { apiFetch } from "@/lib/client/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import { FlagPanel } from "./FlagPanel";
import { formatBytes, mediaDownloadUrl, mediaUrl, useAction } from "./helpers";
import { TranslationMatrix } from "./TranslationMatrix";

const TRANSCRIPT_NAMES: Record<string, string> = {
  asr: "ASR",
  asr_corrected: "ASR corrected",
  human_dialect: "Human dialect transcript",
  normalized: "Normalized Finnish",
};

const REVIEW_BADGES: Record<ReviewStatus, { variant: BadgeVariant; label: string }> = {
  not_started: { variant: "incomplete", label: "Not created" },
  draft: { variant: "neutral", label: "Draft" },
  needs_review: { variant: "needs-review", label: "Needs review" },
  verified: { variant: "verified", label: "Verified" },
};

const TASK_TYPE_LABELS: Record<string, string> = {
  controlled: "Controlled",
  semi_structured: "Semi-structured",
  free_speech: "Free speech",
};

// Missing or failed things are warnings, the rest is neutral information.
const WARNING_INDICATORS = new Set<corpusSchemas.QualityIndicator>(["missing_audio", "asr_failed", "possible_clipping"]);

function Overline({ children }: { children: string }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}</p>;
}

function Transcript({ cell, timeZone }: { cell: corpusSchemas.TranscriptCellView; timeZone: string }) {
  const badge = REVIEW_BADGES[cell.status];
  const current = cell.current;
  return (
    <div className="grid grid-cols-[2.5rem_1fr] gap-x-3 py-2">
      <p className="font-mono text-sm font-semibold text-slate-900">{cell.label}</p>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{TRANSCRIPT_NAMES[cell.type]}</span>
          {cell.type === "asr" ? (
            current && (
              <Badge size="sm" variant="neutral">
                Immutable model output
              </Badge>
            )
          ) : (
            <Badge size="sm" variant={badge.variant}>
              {badge.label}
            </Badge>
          )}
          {current && (
            <span className="font-mono text-[11px] tabular-nums text-slate-500">
              rev {current.revisionNumber} of {cell.revisionCount}
              {current.verifiedAt
                ? `, verified ${formatDateTime(current.verifiedAt, timeZone)}${current.verifiedByLabel ? ` by ${current.verifiedByLabel}` : ""}`
                : `, ${formatDateTime(current.createdAt, timeZone)}`}
              {current.transcriptionConventionVersion ? `, convention ${current.transcriptionConventionVersion}` : ""}
            </span>
          )}
        </div>
        {current ? (
          <p className="mt-0.5 text-sm whitespace-pre-wrap text-slate-900">{current.text}</p>
        ) : (
          <p className="mt-0.5 text-sm text-slate-500">{cell.type === "asr" ? "No ASR output yet." : "Not created."}</p>
        )}
        {current?.modelRun && (
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            {current.modelRun.provider} / {current.modelRun.requestedModel}
            {current.modelRun.modelConfig
              ? `, ${current.modelRun.modelConfig.key} v${current.modelRun.modelConfig.versionNumber}`
              : ""}
            , run {current.modelRun.id.slice(0, 8)}, {formatDateTime(current.modelRun.finishedAt ?? current.modelRun.startedAt, timeZone)}
            , app {current.modelRun.appVersion}
          </p>
        )}
      </div>
    </div>
  );
}

const MISMATCH_KIND_TEXT: Record<string, string> = {
  not_honored: "the browser used a different value",
  not_reported: "the browser did not report the value it used",
  context_rate_differs: "the audio context ran at a different sample rate",
};

const FALLBACK_REASON_TEXT: Record<string, string> = {
  audio_worklet_unavailable: "lossless capture is not available in this browser",
  audio_worklet_failed: "lossless capture failed to start",
};

// The coarse class only. The device name the browser reports is not stored for display.
const DEVICE_CLASS_TEXT: Record<string, string> = {
  built_in: "Built-in microphone",
  usb: "USB microphone",
  bluetooth: "Bluetooth microphone",
  headset: "Headset",
  unknown: "Unknown",
};

const STOPPED_BY_TEXT: Record<string, string> = {
  user: "the participant",
  max_duration: "the maximum duration",
};

/**
 * What the browser recorder declared about the recording (spec 31.1, 32, 84),
 * closed by default. Capture settings that the browser did not confirm are
 * named in the summary line and listed first, in the neutral warning style:
 * they matter for acoustic analysis and are not an error of the participant.
 */
export function CaptureDetails({ details }: { details: corpusSchemas.CaptureDetailsView }) {
  const mismatches = details.constraintMismatches;
  const facts: Array<[string, string]> = [];
  if (details.deviceClass) facts.push(["Input device class", DEVICE_CLASS_TEXT[details.deviceClass] ?? details.deviceClass]);
  if (details.inputChannelCount !== null) {
    facts.push([
      "Input channels",
      details.inputChannelCount > 1 ? `${details.inputChannelCount} (channel 1 was kept)` : String(details.inputChannelCount),
    ]);
  }
  if (details.declaredBitDepth !== null) facts.push(["Declared bit depth", `${details.declaredBitDepth}-bit`]);
  if (details.peak !== null) facts.push(["Peak before conversion", details.peak.toFixed(3)]);
  if (details.clippedSampleCount !== null) facts.push(["Clipped samples", details.clippedSampleCount.toLocaleString("en-US")]);
  if (details.stoppedBy) facts.push(["Stopped by", STOPPED_BY_TEXT[details.stoppedBy] ?? details.stoppedBy]);
  if (details.fallbackReason) {
    facts.push([
      "Compressed capture used because",
      `${FALLBACK_REASON_TEXT[details.fallbackReason] ?? details.fallbackReason}${details.fallbackDetail ? ` (${details.fallbackDetail})` : ""}`,
    ]);
  }

  return (
    <details className="text-xs text-slate-600" data-testid="capture-details">
      <summary className="w-fit cursor-pointer rounded font-medium text-slate-700 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
        Capture details
        {mismatches.length > 0 && (
          <Badge size="sm" variant="warning" className="ml-2">
            {mismatches.length === 1 ? "1 setting not confirmed" : `${mismatches.length} settings not confirmed`}
          </Badge>
        )}
      </summary>
      <div className="mt-1.5 space-y-2">
        {mismatches.length > 0 && (
          <InlineMessage
            variant="warning"
            announce="none"
            className="px-3 py-1.5 text-xs"
            title="Requested capture settings the browser did not confirm"
          >
            <ul className="mt-1 space-y-0.5">
              {mismatches.map((mismatch, index) => (
                <li key={`${mismatch.constraint}-${index}`}>
                  <span className="font-mono">{mismatch.constraint}</span>: {MISMATCH_KIND_TEXT[mismatch.kind] ?? mismatch.kind}
                  {mismatch.requested !== null || mismatch.actual !== null ? (
                    <span className="font-mono tabular-nums">
                      {" "}
                      (requested {mismatch.requested ?? "not recorded"}, actual {mismatch.actual ?? "not reported"})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-1">A setting that differs from the request can change the recorded signal. Consider this in acoustic analysis.</p>
          </InlineMessage>
        )}
        {facts.length > 0 && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-medium text-slate-700">{label}</dt>
                <dd className="font-mono tabular-nums break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="text-slate-500">
          Declared by the browser recorder. Sample rate, channels and duration above come from the server&apos;s own
          analysis of the file.
        </p>
      </div>
    </details>
  );
}

function ReasonDialog({
  open,
  title,
  confirmLabel,
  confirmPhrase,
  children,
  action,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  confirmPhrase?: string;
  children: React.ReactNode;
  action: ReturnType<typeof useAction>;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      title={title}
      tone="danger"
      confirmLabel={confirmLabel}
      confirmPhrase={confirmPhrase}
      busy={action.busy}
      error={missing ? "A reason is required." : action.error}
      onCancel={() => {
        action.clearError();
        setMissing(false);
        onClose();
      }}
      onConfirm={() => {
        if (reason.trim() === "") {
          setMissing(true);
          return;
        }
        setMissing(false);
        void onConfirm(reason.trim());
      }}
    >
      {children}
      <FormField label="Reason" required>
        <TextArea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} />
      </FormField>
    </ConfirmDialog>
  );
}

export { ReasonDialog };

export interface UtteranceBlockProps {
  sessionId: string;
  participantCode: string;
  utterance: corpusSchemas.UtteranceDetail;
  task: corpusSchemas.TaskSequenceEntry | undefined;
  timeZone: string;
  onChanged: () => Promise<void>;
  /** Flags and notes of the session, for the output cells (spec 45, 88). */
  flags?: corpusSchemas.FlagView[];
  notes?: corpusSchemas.NoteView[];
}

/** One utterance as in spec 45: prompt, source audio, capture, A, A*, B, C, then the outputs per batch. */
export function UtteranceBlock({ sessionId, participantCode, utterance, task, timeZone, onChanged, flags, notes }: UtteranceBlockProps) {
  const [dialog, setDialog] = useState<"exclude" | "delete" | null>(null);
  const exclude = useAction();
  const include = useAction();
  const remove = useAction();
  const base = `/api/admin/sessions/${sessionId}/utterances/${utterance.id}`;
  const source = utterance.sourceMedia;
  const excluded = utterance.status === "excluded";
  const ordinal = `U-${String(utterance.ordinal).padStart(2, "0")}`;

  return (
    <article
      id={`utterance-${utterance.id}`}
      aria-label={`Utterance ${ordinal}`}
      className={cn("rounded-lg border border-slate-200 bg-white", excluded && "border-slate-300 bg-slate-50")}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-slate-900">{ordinal}</span>
          <Overline>
            {`Task ${(task?.sequenceIndex ?? 0) + 1}, ${TASK_TYPE_LABELS[task?.taskType ?? ""] ?? "task"}${utterance.isFollowup ? `, follow-up ${utterance.turnIndex}` : ""}`}
          </Overline>
          {task && <span className="truncate text-xs text-slate-500">{task.titleSnapshot}</span>}
          {excluded && (
            <Badge variant="excluded" size="sm">
              Excluded
            </Badge>
          )}
          {utterance.status !== "submitted" && !excluded && (
            <Badge variant="incomplete" size="sm">
              {utterance.status}
            </Badge>
          )}
          {utterance.flagged && (
            <Badge variant="flagged" size="sm">
              Flagged
            </Badge>
          )}
        </div>
        <CopyableId value={utterance.id} label="utterance id" truncate={8} />
      </header>

      <div className="space-y-4 px-4 py-3">
        <div>
          <Overline>Exact prompt shown</Overline>
          <blockquote className="mt-1 border-l-2 border-slate-300 pl-3 text-sm whitespace-pre-wrap text-slate-800">
            {utterance.promptSnapshot}
          </blockquote>
          <p className="mt-1.5 text-xs tabular-nums text-slate-500">
            Attempt count: {utterance.attemptCount}
            {utterance.submittedAt ? `. Submitted ${formatDateTime(utterance.submittedAt, timeZone)}.` : ". Not submitted."}
          </p>
        </div>

        <div>
          <Overline>Source audio</Overline>
          {source && !source.deletedAt ? (
            <div className="mt-1 space-y-1.5">
              <AudioPlayer
                src={mediaUrl(source.id)}
                type={source.mimeType}
                label={`Source recording ${ordinal}`}
                hideLabel
                meta={formatDurationMs(utterance.durationMs ?? source.durationMs, { tenths: true })}
                downloadHref={mediaDownloadUrl(source.id)}
                downloadLabel={source.container === "wav" ? "Download WAV" : `Download ${source.container ?? "file"}`}
              />
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
                <span className="font-medium text-slate-700">Capture:</span>
                <span className="font-mono tabular-nums">
                  {[
                    source.captureSummary,
                    source.captureQualityClass ?? "quality class not recorded",
                    source.captureMethod,
                    formatBytes(source.sizeBytes),
                  ]
                    .filter(Boolean)
                    .join(" | ")}
                </span>
              </p>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
                <span className="font-medium text-slate-700">SHA-256:</span>
                <CopyableId value={source.sha256} label="source audio hash" truncate={16} />
                <span className="font-medium text-slate-700">Asset:</span>
                <CopyableId value={source.id} label="media asset id" truncate={8} />
              </p>
              {utterance.captureDetails && <CaptureDetails details={utterance.captureDetails} />}
              {utterance.derivedMedia && !utterance.derivedMedia.deletedAt && (
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
                  <span className="font-medium text-slate-700">Derived WAV:</span>
                  <span className="font-mono tabular-nums">{utterance.derivedMedia.captureSummary}</span>
                  <CopyableId value={utterance.derivedMedia.sha256} label="derived audio hash" truncate={16} />
                  <a
                    href={mediaDownloadUrl(utterance.derivedMedia.id)}
                    download
                    className="rounded underline underline-offset-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                  >
                    Download derived WAV
                  </a>
                </p>
              )}
            </div>
          ) : source ? (
            <InlineMessage variant="warning" announce="none" className="mt-1">
              The recording was deleted on {formatDateTime(source.deletedAt ?? "", timeZone)}
              {source.deletionReason ? `: ${source.deletionReason}` : "."} The record remains as provenance (SHA-256{" "}
              <span className="font-mono text-xs">{source.sha256.slice(0, 16)}</span>, {source.captureSummary}).
            </InlineMessage>
          ) : (
            <p className="mt-1 text-sm text-slate-500">No recording was accepted for this utterance.</p>
          )}
          {utterance.qualityIndicators.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Quality indicators">
              {utterance.qualityIndicators.map((indicator) => (
                <li key={indicator}>
                  <Badge size="sm" variant={WARNING_INDICATORS.has(indicator) ? "warning" : "neutral"}>
                    {corpusSchemas.QUALITY_INDICATOR_LABELS[indicator]}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <Overline>Transcripts</Overline>
            <Link href={`/admin/review?utterance=${utterance.id}`} className={buttonClasses({ variant: "secondary", size: "sm", className: "px-2 py-1 text-xs" })}>
              Edit in Review
            </Link>
          </div>
          <div className="mt-1 divide-y divide-slate-100">
            {utterance.transcripts.map((cell) => (
              <Transcript key={cell.type} cell={cell} timeZone={timeZone} />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Overline>Translations and TTS</Overline>
          {utterance.translationBatches.length === 0 ? (
            <p className="text-sm text-slate-500">No processing batch has produced translations for this utterance.</p>
          ) : (
            utterance.translationBatches.map((view) => (
              <TranslationMatrix
                key={view.batch.id}
                view={view}
                context={{ participantCode, utteranceOrdinal: utterance.ordinal, timeZone, onChanged, flags, notes }}
              />
            ))
          )}
        </div>

        <div className="space-y-2 border-t border-slate-100 pt-3">
          {excluded && (
            <InlineMessage variant="warning" announce="none">
              Excluded from analysis{utterance.exclusionReason ? `: ${utterance.exclusionReason}` : "."} The recording,
              transcripts and outputs are kept.
            </InlineMessage>
          )}
          <FlagPanel
            compact
            subject="utterance"
            flagged={utterance.flagged}
            notes={utterance.flagNotes}
            onSave={async (flagged, notes) => {
              await apiFetch(`${base}/flag`, { method: "PATCH", body: { flagged, notes } });
              await onChanged();
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {excluded ? (
              <Button
                size="sm"
                variant="secondary"
                loading={include.busy}
                loadingLabel="Including..."
                disabled={Boolean(source?.deletedAt)}
                onClick={() =>
                  void include.run(async () => {
                    await apiFetch(`${base}/include`, { method: "POST" });
                    await onChanged();
                  })
                }
              >
                Include in analysis again
              </Button>
            ) : (
              utterance.status === "submitted" && (
                <Button size="sm" variant="secondary" onClick={() => setDialog("exclude")}>
                  Exclude utterance from analysis
                </Button>
              )
            )}
            {source && !source.deletedAt && (
              <Button size="sm" variant="ghost" className="text-rose-700 hover:text-rose-800" onClick={() => setDialog("delete")}>
                Delete recording...
              </Button>
            )}
            {include.error && <span className="text-xs text-rose-700">{include.error}</span>}
          </div>
        </div>
      </div>

      <ReasonDialog
        open={dialog === "exclude"}
        title={`Exclude utterance ${ordinal} from analysis?`}
        confirmLabel="Exclude utterance"
        action={exclude}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          const ok = await exclude.run(async () => {
            await apiFetch(`${base}/exclude`, { method: "POST", body: { reason } });
            await onChanged();
          });
          if (ok) setDialog(null);
        }}
      >
        <p>
          The utterance is left out of analysis exports by default. Nothing is deleted: the recording, transcripts and
          outputs stay, and the utterance can be included again.
        </p>
      </ReasonDialog>

      <ReasonDialog
        open={dialog === "delete"}
        title={`Delete the recording of utterance ${ordinal}?`}
        confirmLabel="Delete recording"
        confirmPhrase={corpusSchemas.MEDIA_DELETE_PHRASE}
        action={remove}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          if (!source) return;
          const ok = await remove.run(async () => {
            await apiFetch(mediaUrl(source.id), {
              method: "DELETE",
              body: { reason, confirmationPhrase: corpusSchemas.MEDIA_DELETE_PHRASE },
            });
            await onChanged();
          });
          if (ok) setDialog(null);
        }}
      >
        <p>
          The audio file is removed from storage and cannot be restored. The record of the file (hash, format, size)
          and this deletion stay in the database, and the utterance is marked as excluded.
        </p>
        <p>Use this only when the approved study policy requires the recording to be deleted.</p>
      </ReasonDialog>
    </article>
  );
}
