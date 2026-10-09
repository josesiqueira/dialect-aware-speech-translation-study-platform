"use client";

import Link from "next/link";
import { useState } from "react";
import type { corpusSchemas, exportSchemas } from "@dialect/domain";
import { QuestionnaireAnswersView } from "@/components/questionnaire";
import { Badge, Button, CopyableId, InlineMessage, KeyValueList } from "@/components/ui";
import { apiFetch, isApiClientError } from "@/lib/client/api";
import { formatCountOf, formatDateTime } from "@/lib/format";
import { ModeBadge, SessionStatusBadge } from "../../_components/badges";
import { AuditHistory } from "./AuditHistory";
import {
  CaptureSection,
  ConsentSection,
  DetailSection,
  NotesSection,
  ProcessingHistorySection,
  TaskSequenceSection,
} from "./detail-sections";
import { FlagPanel } from "./FlagPanel";
import { OutputReviewDetail } from "./OutputReviewDetail";
import { useAction } from "./helpers";
import { ReasonDialog, UtteranceBlock } from "./UtteranceBlock";

const COMPLETENESS_LABELS: Record<corpusSchemas.CompletenessKey, string> = {
  source_audio_complete: "Source audio",
  background_complete: "Background questionnaire",
  post_questionnaire_complete: "Post questionnaire",
  required_transcripts_complete: "Required transcripts",
  processing_complete: "Processing",
};

export interface SessionDetailProps {
  detail: corpusSchemas.SessionDetail;
  /** Reloads the detail and the list after a change. */
  onChanged: () => Promise<void>;
  /** Error of the last reload, while older data is still shown. */
  refreshError: string | null;
}

/**
 * The central researcher view (spec 44): header and actions, then the eight
 * sections. Read-only for transcripts and outputs, which are edited on the
 * Review page or are immutable.
 */
export function SessionDetail({ detail, onChanged, refreshError }: SessionDetailProps) {
  const { session, protocol, adminTimezone: timeZone } = detail;
  const [showAudit, setShowAudit] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [packageMessage, setPackageMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const exclude = useAction();
  const include = useAction();
  const download = useAction();
  const base = `/api/admin/sessions/${session.id}`;
  const taskOf = new Map(detail.taskSequence.map((task) => [task.presentationId, task]));
  const time = (value: string | null) => (value ? formatDateTime(value, timeZone, { zone: true }) : "not yet");

  // The server builds the session package during the request (it is small) and
  // answers with the finished export job. The browser then downloads the
  // archive from the authenticated, audited download route.
  async function requestPackage() {
    setPackageMessage(null);
    await download.run(async () => {
      try {
        const { job } = await apiFetch<{ job: exportSchemas.ExportJobView }>("/api/admin/export/jobs", {
          method: "POST",
          body: { exportType: "session_package", filters: { sessionIds: [session.id] } },
        });
        if (job.status !== "completed") {
          setPackageMessage({
            ok: false,
            text: job.errorMessage ?? "The session package could not be built. See Data & Export for the export job.",
          });
          return;
        }
        // A file download, not a page change: the response is an attachment.
        const link = document.createElement("a");
        link.href = `/api/admin/export/jobs/${job.id}/download`;
        link.download = job.fileName ?? "";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setPackageMessage({
          ok: true,
          text: `The download of ${job.fileName ?? "the session package"} has started. It is also listed under Data & Export.`,
        });
      } catch (error) {
        setPackageMessage({
          ok: false,
          text: isApiClientError(error) ? error.message : "The session package could not be built.",
        });
      }
    });
  }

  return (
    <div className="space-y-4">
      {refreshError && <InlineMessage variant="error">The view could not be refreshed: {refreshError}</InlineMessage>}

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="font-mono text-base font-semibold text-slate-900">{session.participantCode}</h2>
            <ModeBadge mode={session.mode} size="md" showResearch />
            <SessionStatusBadge status={session.status} size="md" />
            {session.flagged && <Badge variant="flagged">Flagged</Badge>}
            {session.excluded && <Badge variant="excluded">Excluded</Badge>}
            <CopyableId value={session.id} label="session id" truncate={8} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={requestPackage} loading={download.busy} loadingLabel="Building...">
              Download session package
            </Button>
            <Button size="sm" variant="secondary" aria-expanded={showAudit} onClick={() => setShowAudit((value) => !value)}>
              {showAudit ? "Hide audit history" : "View audit history"}
            </Button>
            {session.excluded ? (
              <Button
                size="sm"
                variant="secondary"
                loading={include.busy}
                loadingLabel="Including..."
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
              <Button size="sm" variant="secondary" onClick={() => setExcludeOpen(true)}>
                Exclude session from analysis
              </Button>
            )}
          </div>
        </div>

        <KeyValueList
          items={[
            { label: "Protocol", value: `v${protocol.versionNumber} ${protocol.name}` },
            { label: "Started", mono: true, value: time(session.startedAt) },
            { label: "Completed", mono: true, value: time(session.completedAt) },
            { label: "Consented", mono: true, value: time(session.consentedAt) },
            ...(session.withdrawnAt ? [{ label: "Withdrawn", mono: true, value: time(session.withdrawnAt) }] : []),
            ...(session.abandonedAt ? [{ label: "Abandoned", mono: true, value: time(session.abandonedAt) }] : []),
            { label: "Last activity", mono: true, value: time(session.lastActivityAt) },
            { label: "Utterances", mono: true, value: String(detail.utterances.length) },
          ]}
        />

        {packageMessage && (
          <InlineMessage variant={packageMessage.ok ? "success" : "warning"} className="mt-3">
            {packageMessage.text} {packageMessage.ok && <Link href="/admin/data" className="underline underline-offset-2">Open Data & Export</Link>}
          </InlineMessage>
        )}
        {include.error && <InlineMessage variant="error" className="mt-3">{include.error}</InlineMessage>}
        {session.excluded && (
          <InlineMessage variant="warning" announce="none" className="mt-3">
            This session is excluded from analysis{session.exclusionReason ? `: ${session.exclusionReason}` : "."} All of
            its data is kept.
          </InlineMessage>
        )}

        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-slate-100 pt-3" aria-label="Completeness checks">
          {detail.completeness.map((check) => (
            <li key={check.key} className="flex items-center gap-1.5 text-xs text-slate-600" title={check.detail}>
              <Badge size="sm" variant={!check.applicable ? "neutral" : check.complete ? "verified" : "incomplete"}>
                {!check.applicable ? "Not applicable" : check.complete ? "Complete" : "Incomplete"}
              </Badge>
              <span>
                <span className="font-medium text-slate-700">{COMPLETENESS_LABELS[check.key]}</span>
                <span className="sr-only">: {check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <FlagPanel
        subject="session"
        flagged={session.flagged}
        notes={session.flagNotes}
        onSave={async (flagged, notes) => {
          await apiFetch(`${base}/flag`, { method: "PATCH", body: { flagged, notes } });
          await onChanged();
        }}
      />

      {showAudit && (
        <DetailSection id="audit-heading" title="Audit history">
          <AuditHistory sessionId={session.id} />
        </DetailSection>
      )}

      <DetailSection id="consent-heading" title="1. Consent summary">
        <ConsentSection consent={detail.consent} timeZone={timeZone} />
      </DetailSection>

      <DetailSection id="capture-heading" title="2. Technical capture metadata">
        <CaptureSection detail={detail} />
      </DetailSection>

      <DetailSection id="tasks-heading" title="3. Task sequence" aside={`${formatCountOf(detail.taskSequence.length, "task")}, in the order shown`}>
        <TaskSequenceSection tasks={detail.taskSequence} timeZone={timeZone} />
      </DetailSection>

      <DetailSection bare id="utterances-heading" title="4. Utterances" aside={`${detail.utterances.length} recorded`}>
        {detail.utterances.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">No utterance was recorded in this session.</p>
        ) : (
          <div className="space-y-4">
            {detail.utterances.map((utterance) => (
              <UtteranceBlock
                key={utterance.id}
                sessionId={session.id}
                participantCode={session.participantCode}
                utterance={utterance}
                task={taskOf.get(utterance.taskPresentationId)}
                timeZone={timeZone}
                onChanged={onChanged}
                flags={detail.flags}
                notes={detail.notes}
              />
            ))}
          </div>
        )}
      </DetailSection>

      <DetailSection id="background-heading" title="5. Background questionnaire">
        <QuestionnaireAnswersView
          headingLevel="h4"
          timeZone={timeZone}
          responses={detail.questionnaires.background ? [detail.questionnaires.background] : []}
          emptyText={
            detail.questionnaires.backgroundExpected
              ? "The background questionnaire was not submitted."
              : "The protocol of this session has no background questionnaire."
          }
        />
      </DetailSection>

      <DetailSection id="post-heading" title="6. Post-recording questionnaire">
        <QuestionnaireAnswersView
          headingLevel="h4"
          timeZone={timeZone}
          responses={detail.questionnaires.post ? [detail.questionnaires.post] : []}
          emptyText={
            detail.questionnaires.postExpected
              ? "The post-recording questionnaire was not submitted."
              : "The protocol of this session has no post-recording questionnaire."
          }
        />
      </DetailSection>

      <DetailSection id="review-heading" title="Output review (end of session)">
        <OutputReviewDetail detail={detail} timeZone={timeZone} />
      </DetailSection>

      <DetailSection id="notes-heading" title="7. Flags and notes">
        <NotesSection detail={detail} onChanged={onChanged} />
      </DetailSection>

      <DetailSection
        id="processing-heading"
        title="8. Processing history"
        aside={`${formatCountOf(detail.processing.modelRuns.length, "model run")}, ${formatCountOf(detail.processing.jobs.length, "job")}`}
      >
        <ProcessingHistorySection detail={detail} />
      </DetailSection>

      <ReasonDialog
        open={excludeOpen}
        title={`Exclude session ${session.participantCode} from analysis?`}
        confirmLabel="Exclude session"
        action={exclude}
        onClose={() => setExcludeOpen(false)}
        onConfirm={async (reason) => {
          const ok = await exclude.run(async () => {
            await apiFetch(`${base}/exclude`, { method: "POST", body: { reason } });
            await onChanged();
          });
          if (ok) setExcludeOpen(false);
        }}
      >
        <p>
          The whole session is left out of analysis exports by default. Nothing is deleted: recordings, transcripts,
          questionnaire answers and outputs stay, and the session can be included again.
        </p>
      </ReasonDialog>
    </div>
  );
}
