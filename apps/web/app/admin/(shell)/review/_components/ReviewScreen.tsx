"use client";

import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { TRANSCRIPT_TYPE_LABELS, transcriptSchemas, type TranscriptType } from "@dialect/domain";
import {
  AudioPlayer,
  Badge,
  Button,
  CopyableId,
  ErrorState,
  InlineMessage,
  LoadingState,
  SaveButton,
  overlineLabel,
  type SaveStatus,
} from "@/components/ui";
import { isApiClientError } from "@/lib/client/api";
import { formatDateTime, formatDurationMs } from "@/lib/format";
import {
  CODING_PAIRS,
  DifferenceCoding,
  type CodingDraft,
  type CodingPairKey,
} from "./DifferenceCoding";
import { FlagsAndNotes } from "./FlagsAndNotes";
import { describeAudioFormat, shortUtteranceId, TASK_TYPE_LABELS, TRANSCRIPT_NAMES } from "./labels";
import { errorMessage, mediaUrl, reviewApi } from "./reviewApi";
import { resolveShortcut, REWIND_SECONDS } from "./shortcuts";
import { TranscriptEditor, type TranscriptDraft } from "./TranscriptEditor";

type Detail = transcriptSchemas.UtteranceForReview;
type HumanType = transcriptSchemas.HumanTranscriptType;

const HUMAN_TYPES = transcriptSchemas.HUMAN_TRANSCRIPT_TYPES;
const CONFLICT_MESSAGE =
  "Another revision of this transcript was saved in the meantime. It is now in the revision history below. Compare it with your text, then save again.";

/** The part of a queue row that changes while an utterance is being reviewed. */
export type ReviewRowPatch = Pick<transcriptSchemas.ReviewQueueRow, "transcripts" | "flagged" | "openFlagCount">;

export interface ReviewScreenProps {
  utteranceId: string;
  /** Empty when the researcher has not typed one: the server then stores the admin label. */
  annotatorLabel: string;
  shortcutsEnabled: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  /** `saved: true` means the caller already saved, so no unsaved-changes question is needed. */
  onNavigate: (direction: "next" | "previous", options?: { saved?: boolean }) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRowChange: (utteranceId: string, patch: ReviewRowPatch) => void;
}

/** Loads one utterance and shows the review screen for it. */
export function ReviewScreen(props: ReviewScreenProps) {
  const { utteranceId } = props;
  const [reloadCount, setReloadCount] = useState(0);
  const requestKey = `${utteranceId}:${reloadCount}`;
  const [loaded, setLoaded] = useState<{ key: string; data?: Detail; error?: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    reviewApi
      .utterance(utteranceId, controller.signal)
      .then((data) => setLoaded({ key: requestKey, data }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ key: requestKey, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [utteranceId, requestKey]);

  const current = loaded?.key === requestKey ? loaded : null;
  if (!current) {
    return (
      <div aria-busy="true">
        <LoadingState size="sm" label="Loading utterance..." />
      </div>
    );
  }
  if (!current.data) {
    return (
      <ErrorState
        title="The utterance could not be loaded"
        message={current.error}
        onRetry={() => setReloadCount((count) => count + 1)}
      />
    );
  }
  return <ReviewEditor key={requestKey} data={current.data} {...props} />;
}

function initialDrafts(detail: Detail): Record<HumanType, TranscriptDraft> {
  const draft = (type: HumanType): TranscriptDraft => ({
    text: detail.transcripts[type]?.currentRevision?.text ?? "",
    derivedFromRevisionId: null,
    changeReason: "",
  });
  return { asr_corrected: draft("asr_corrected"), human_dialect: draft("human_dialect"), normalized: draft("normalized") };
}

function rowPatch(detail: Detail): ReviewRowPatch {
  const openFlagCount = detail.flags.filter((flag) => flag.resolvedAt === null).length;
  const state = (type: TranscriptType) => {
    const transcript = detail.transcripts[type];
    return transcript
      ? { transcriptId: transcript.id, status: transcript.status, hasRevision: transcript.currentRevision !== null }
      : null;
  };
  return {
    transcripts: {
      asr: state("asr"),
      asr_corrected: state("asr_corrected"),
      human_dialect: state("human_dialect"),
      normalized: state("normalized"),
    },
    flagged: detail.utterance.flagged || openFlagCount > 0,
    openFlagCount,
  };
}

function sameCoding(a: CodingDraft, b: CodingDraft): boolean {
  return a.notes.trim() === b.notes.trim() && [...a.categories].sort().join("|") === [...b.categories].sort().join("|");
}

function ReviewEditor({
  data,
  annotatorLabel,
  shortcutsEnabled,
  hasPrevious,
  hasNext,
  onNavigate,
  onDirtyChange,
  onRowChange,
}: ReviewScreenProps & { data: Detail }) {
  const [detail, setDetail] = useState(data);
  const [drafts, setDrafts] = useState(() => initialDrafts(data));
  const [errors, setErrors] = useState<Partial<Record<HumanType | "coding" | "general", string>>>({});
  const [reasonMissing, setReasonMissing] = useState<HumanType | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<{ status: SaveStatus; message?: string }>({ status: "idle" });
  const [pairKey, setPairKey] = useState<CodingPairKey>(CODING_PAIRS[0].key);
  const [codingDraft, setCodingDraft] = useState<CodingDraft | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const reasonRefA = useRef<HTMLInputElement>(null);
  const reasonRefB = useRef<HTMLInputElement>(null);
  const reasonRefC = useRef<HTMLInputElement>(null);
  const reasonRefs: Record<HumanType, RefObject<HTMLInputElement | null>> = {
    asr_corrected: reasonRefA,
    human_dialect: reasonRefB,
    normalized: reasonRefC,
  };

  const label = annotatorLabel.trim() || undefined;
  // The label the server stores when none is typed.
  const effectiveLabel = label ?? "admin";
  const timeZone = detail.settings.adminTimezone;
  const { utterance, session, task, media } = detail;

  const savedText = (type: HumanType) => detail.transcripts[type]?.currentRevision?.text ?? "";
  const isDirty = (type: HumanType) => {
    const draft = drafts[type];
    if (!detail.transcripts[type]?.currentRevision && draft.text.trim() === "") return false;
    return draft.text !== savedText(type);
  };

  const pair = CODING_PAIRS.find((candidate) => candidate.key === pairKey) ?? CODING_PAIRS[0];
  const sourceRevision = detail.transcripts[pair.source]?.currentRevision ?? null;
  const targetRevision = detail.transcripts[pair.target]?.currentRevision ?? null;
  const savedCoding = detail.differenceAnnotations.latest.find(
    (annotation) =>
      annotation.scope === "utterance" &&
      annotation.annotatorLabel === effectiveLabel &&
      annotation.sourceTranscriptRevisionId === sourceRevision?.id &&
      annotation.targetTranscriptRevisionId === targetRevision?.id,
  );
  const codingInitial: CodingDraft = { categories: savedCoding?.categories ?? [], notes: savedCoding?.notes ?? "" };
  const codingValue = codingDraft ?? codingInitial;
  const codingDirty = codingDraft !== null && !sameCoding(codingDraft, codingInitial);
  const pairHasUnsavedText = [pair.source, pair.target].some((type) => type !== "asr" && isDirty(type));

  const anyDirty = HUMAN_TYPES.some(isDirty) || codingDirty;

  useEffect(() => {
    onDirtyChange(anyDirty);
  }, [anyDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  function applyDetail(next: Detail) {
    setDetail(next);
    onRowChange(next.utterance.id, rowPatch(next));
  }

  function updateDraft(type: HumanType, draft: TranscriptDraft) {
    setDrafts((previous) => ({ ...previous, [type]: draft }));
    setSaveState({ status: "idle" });
    if (errors[type]) setErrors((previous) => ({ ...previous, [type]: undefined }));
    if (reasonMissing === type && draft.changeReason.trim()) setReasonMissing(null);
  }

  // After a conflict the newer server state is loaded, and the text in the editors is kept.
  async function reloadKeepingDrafts(fallback: Detail): Promise<Detail> {
    try {
      return await reviewApi.utterance(fallback.utterance.id);
    } catch {
      return fallback;
    }
  }

  // Saves every transcript with unsaved text, then the difference coding when it
  // changed. Returns the new state, or null when something was not saved.
  async function saveAll(options: { needsReviewFor?: HumanType } = {}): Promise<Detail | null> {
    setErrors({});
    setReasonMissing(null);
    for (const type of HUMAN_TYPES) {
      if (!isDirty(type)) continue;
      if (drafts[type].text.trim() === "") {
        setErrors({ [type]: "The text is empty. A saved transcript cannot be replaced by an empty one." });
        return null;
      }
      if (detail.transcripts[type]?.status === "verified" && drafts[type].changeReason.trim() === "") {
        setReasonMissing(type);
        reasonRefs[type].current?.focus();
        return null;
      }
    }

    let working = detail;
    const nextDrafts = { ...drafts };
    for (const type of HUMAN_TYPES) {
      if (!isDirty(type)) continue;
      const draft = drafts[type];
      try {
        const result = await reviewApi.saveRevision(working.utterance.id, type, {
          text: draft.text,
          changeReason: draft.changeReason.trim() || undefined,
          derivedFromRevisionId: draft.derivedFromRevisionId,
          annotatorLabel: label,
          needsReview: options.needsReviewFor === type ? true : undefined,
          expectedCurrentRevisionId: working.transcripts[type]?.currentRevision?.id ?? null,
        });
        working = { ...working, transcripts: { ...working.transcripts, [type]: result.transcript } };
        nextDrafts[type] = { text: result.revision.text, derivedFromRevisionId: null, changeReason: "" };
      } catch (error) {
        const conflict = isApiClientError(error) && error.code === "CONFLICT";
        if (conflict) working = await reloadKeepingDrafts(working);
        applyDetail(working);
        setDrafts(nextDrafts);
        setErrors({ [type]: conflict ? CONFLICT_MESSAGE : errorMessage(error) });
        return null;
      }
    }

    let codingSaved = false;
    if (codingDirty && codingDraft) {
      const source = working.transcripts[pair.source]?.currentRevision;
      const target = working.transcripts[pair.target]?.currentRevision;
      try {
        if (!source || !target) throw new Error("Both transcripts need saved text before the coding can be saved.");
        const { annotation } = await reviewApi.saveAnnotation(working.utterance.id, {
          sourceTranscriptRevisionId: source.id,
          targetTranscriptRevisionId: target.id,
          categories: codingDraft.categories,
          notes: codingDraft.notes,
          annotatorLabel: label,
          scope: "utterance",
        });
        const replaced = (entry: transcriptSchemas.DifferenceAnnotationView) =>
          entry.scope === "utterance" &&
          entry.annotatorLabel === annotation.annotatorLabel &&
          entry.sourceTranscriptRevisionId === annotation.sourceTranscriptRevisionId &&
          entry.targetTranscriptRevisionId === annotation.targetTranscriptRevisionId;
        working = {
          ...working,
          differenceAnnotations: {
            latest: [annotation, ...working.differenceAnnotations.latest.filter((entry) => !replaced(entry))],
            history: [annotation, ...working.differenceAnnotations.history],
          },
        };
        codingSaved = true;
      } catch (error) {
        applyDetail(working);
        setDrafts(nextDrafts);
        setErrors({ coding: errorMessage(error) });
        return null;
      }
    }

    applyDetail(working);
    setDrafts(nextDrafts);
    if (codingSaved) setCodingDraft(null);
    return working;
  }

  async function handleSave(andNext: boolean) {
    if (busy) return;
    const hadChanges = anyDirty;
    setBusy(andNext ? "save-next" : "save");
    const result = await saveAll();
    setBusy(null);
    if (!result) {
      setSaveState({ status: "error", message: "Not saved" });
      return;
    }
    setSaveState({ status: "saved", message: hadChanges ? "Saved" : "No changes to save" });
    if (andNext) onNavigate("next", { saved: true });
  }

  async function handleVerify(type: HumanType) {
    if (busy) return;
    setBusy(`verify:${type}`);
    setSaveState({ status: "idle" });
    const saved = await saveAll();
    const transcript = saved?.transcripts[type];
    if (saved && transcript?.currentRevision) {
      try {
        const result = await reviewApi.verify(transcript.id, {
          revisionId: transcript.currentRevision.id,
          verifiedByLabel: label,
        });
        applyDetail({ ...saved, transcripts: { ...saved.transcripts, [type]: result.transcript } });
      } catch (error) {
        const conflict = isApiClientError(error) && error.code === "CONFLICT";
        if (conflict) applyDetail(await reloadKeepingDrafts(saved));
        setErrors({ [type]: conflict ? CONFLICT_MESSAGE : errorMessage(error) });
      }
    }
    setBusy(null);
  }

  async function handleToggleReview(type: HumanType) {
    if (busy) return;
    setBusy(`review:${type}`);
    setSaveState({ status: "idle" });
    if (isDirty(type)) {
      await saveAll({ needsReviewFor: type });
    } else {
      const transcript = detail.transcripts[type];
      if (transcript) {
        try {
          const result = await reviewApi.setStatus(transcript.id, {
            status: transcript.status === "needs_review" ? "draft" : "needs_review",
          });
          applyDetail({ ...detail, transcripts: { ...detail.transcripts, [type]: result.transcript } });
        } catch (error) {
          setErrors({ [type]: errorMessage(error) });
        }
      }
    }
    setBusy(null);
  }

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    const action = resolveShortcut(event);
    if (!action) return;
    event.preventDefault();
    const audio = audioRef.current;
    switch (action) {
      case "save":
        void handleSave(false);
        break;
      case "toggle-play":
        if (!audio) break;
        if (audio.paused) void audio.play().catch(() => undefined);
        else audio.pause();
        break;
      case "rewind":
        if (audio) audio.currentTime = Math.max(0, audio.currentTime - REWIND_SECONDS);
        break;
      case "next":
      case "previous":
        if (!busy) onNavigate(action);
        break;
    }
  });
  useEffect(() => {
    if (!shortcutsEnabled) return;
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [shortcutsEnabled]);

  const asr = detail.transcripts.asr;
  const asrRevision = asr?.currentRevision ?? null;
  const dialectRevision = detail.transcripts.human_dialect?.currentRevision ?? null;
  const disabled = busy !== null;
  const existingTranscripts = (["asr", ...HUMAN_TYPES] as TranscriptType[]).flatMap((type) => {
    const transcript = detail.transcripts[type];
    return transcript ? [{ id: transcript.id, type }] : [];
  });
  const latestForPair = detail.differenceAnnotations.latest.filter(
    (annotation) =>
      annotation.scope === "utterance" &&
      annotation.sourceTranscriptType === pair.source &&
      annotation.targetTranscriptType === pair.target,
  );
  const pendingFor = (type: HumanType): "verify" | "review" | null =>
    busy === `verify:${type}` ? "verify" : busy === `review:${type}` ? "review" : null;

  return (
    <div className="space-y-3">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-sm font-semibold text-slate-900">
              {session.participantCode} / {shortUtteranceId(utterance.id)}
            </h2>
            {session.mode === "test" && <Badge variant="test">TEST</Badge>}
            {session.mode === "demo" && <Badge variant="demo">DEMO</Badge>}
            {rowPatch(detail).flagged && <Badge variant="flagged">Flagged</Badge>}
            {utterance.status === "excluded" && <Badge variant="excluded">Excluded</Badge>}
            {session.excluded && <Badge variant="excluded">Session excluded</Badge>}
            {session.status === "withdrawn" && <Badge variant="incomplete">Session withdrawn</Badge>}
          </div>
          <CopyableId value={utterance.id} label="utterance id" truncate={8} />
        </div>
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-700">Task:</span> {TASK_TYPE_LABELS[task.taskType]}, {task.titleSnapshot}
          {utterance.isFollowup ? `, follow-up ${utterance.turnIndex}` : ""}
          <span className="text-slate-500">
            {" "}
            (protocol v{session.protocolVersionNumber}
            {utterance.submittedAt ? `, submitted ${formatDateTime(utterance.submittedAt, timeZone)}` : ""})
          </span>
        </p>
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <p className={overlineLabel}>Prompt shown to the participant</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{utterance.promptSnapshot}</p>
          {utterance.isFollowup && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-slate-500">Task prompt: {task.promptSnapshot}</p>
          )}
          {task.contextSnapshot && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-slate-500">Context shown: {task.contextSnapshot}</p>
          )}
        </div>
      </header>

      {media && !media.deleted ? (
        <AudioPlayer
          ref={audioRef}
          preload="metadata"
          src={mediaUrl(media.id)}
          type={media.mimeType}
          label="Source recording"
          meta={
            <>
              <span>{formatDurationMs(media.durationMs ?? utterance.durationMs)}</span>
              <span>{describeAudioFormat(media)}</span>
            </>
          }
        />
      ) : (
        <InlineMessage variant="warning" announce="none">
          {media?.deleted
            ? "The source recording of this utterance was deleted. Its metadata is kept."
            : "This utterance has no accepted source recording."}
        </InlineMessage>
      )}

      <section aria-labelledby="transcript-asr-heading" className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="transcript-asr-heading" className="text-sm font-semibold text-slate-900">
            {TRANSCRIPT_TYPE_LABELS.asr} <span className="font-medium text-slate-700">{TRANSCRIPT_NAMES.asr}</span>
          </h3>
          <Badge size="sm">read-only</Badge>
        </div>
        {asrRevision ? (
          <>
            <p lang="fi" className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-900">
              {asrRevision.text}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {asr?.modelRun ? (
                <>
                  Model run <span className="font-mono">{asr.modelRun.id.slice(0, 8)}</span>: {asr.modelRun.provider},{" "}
                  <span className="font-mono">{asr.modelRun.returnedModel ?? asr.modelRun.requestedModel}</span>
                  {asr.modelRun.returnedModel && asr.modelRun.returnedModel !== asr.modelRun.requestedModel
                    ? ` (requested ${asr.modelRun.requestedModel})`
                    : ""}
                  {asr.modelRun.finishedAt ? `, ${formatDateTime(asr.modelRun.finishedAt, timeZone)}` : ""}.
                </>
              ) : (
                "No model run is linked to this revision."
              )}{" "}
              Raw model output, revision {asrRevision.revisionNumber} of {asr?.revisionCount ?? 1}.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-500">
            No ASR transcript yet. ASR runs are started on the Processing Runs page.
          </p>
        )}
      </section>

      <TranscriptEditor
        type="asr_corrected"
        transcript={detail.transcripts.asr_corrected}
        draft={drafts.asr_corrected}
        onDraftChange={(draft) => updateDraft("asr_corrected", draft)}
        dirty={isDirty("asr_corrected")}
        copySource={{
          label: "A",
          revision: asrRevision,
          unavailableReason: asrRevision ? null : "There is no ASR transcript to copy.",
        }}
        timeZone={timeZone}
        disabled={disabled}
        pending={pendingFor("asr_corrected")}
        error={errors.asr_corrected ?? null}
        reasonMissing={reasonMissing === "asr_corrected"}
        reasonRef={reasonRefA}
        onVerify={() => void handleVerify("asr_corrected")}
        onToggleReview={() => void handleToggleReview("asr_corrected")}
      />
      <TranscriptEditor
        type="human_dialect"
        transcript={detail.transcripts.human_dialect}
        draft={drafts.human_dialect}
        onDraftChange={(draft) => updateDraft("human_dialect", draft)}
        dirty={isDirty("human_dialect")}
        timeZone={timeZone}
        disabled={disabled}
        pending={pendingFor("human_dialect")}
        error={errors.human_dialect ?? null}
        reasonMissing={reasonMissing === "human_dialect"}
        reasonRef={reasonRefB}
        onVerify={() => void handleVerify("human_dialect")}
        onToggleReview={() => void handleToggleReview("human_dialect")}
      />
      <TranscriptEditor
        type="normalized"
        transcript={detail.transcripts.normalized}
        draft={drafts.normalized}
        onDraftChange={(draft) => updateDraft("normalized", draft)}
        dirty={isDirty("normalized")}
        copySource={{
          label: "B",
          revision: dialectRevision,
          unavailableReason: !dialectRevision
            ? "Save B first."
            : isDirty("human_dialect")
              ? "B has unsaved changes. Save B first."
              : null,
        }}
        timeZone={timeZone}
        disabled={disabled}
        pending={pendingFor("normalized")}
        error={errors.normalized ?? null}
        reasonMissing={reasonMissing === "normalized"}
        reasonRef={reasonRefC}
        notice={
          transcriptSchemas.normalizedDerivationWarning(dialectRevision, detail.transcripts.normalized?.currentRevision)
            ?.message ?? null
        }
        onVerify={() => void handleVerify("normalized")}
        onToggleReview={() => void handleToggleReview("normalized")}
      />

      <DifferenceCoding
        pairKey={pairKey}
        onPairChange={(next) => {
          setPairKey(next);
          setCodingDraft(null);
        }}
        source={sourceRevision}
        target={targetRevision}
        pairHasUnsavedText={pairHasUnsavedText}
        value={codingValue}
        onChange={(value) => {
          setCodingDraft(value);
          setSaveState({ status: "idle" });
        }}
        dirty={codingDirty}
        latestForPair={latestForPair}
        historyCount={detail.differenceAnnotations.history.length}
        annotatorLabel={effectiveLabel}
        schemeVersion={detail.settings.annotationSchemeVersion}
        timeZone={timeZone}
        disabled={disabled}
        error={errors.coding ?? null}
      />

      <FlagsAndNotes
        utteranceId={utterance.id}
        flags={detail.flags}
        notes={detail.notes}
        transcripts={existingTranscripts}
        annotatorLabel={annotatorLabel.trim()}
        timeZone={timeZone}
        onFlagsChange={(flags) => applyDetail({ ...detail, flags })}
        onNotesChange={(notes) => applyDetail({ ...detail, notes })}
      />

      <div className="sticky -bottom-4 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={disabled || !hasPrevious} onClick={() => onNavigate("previous")}>
            Previous
          </Button>
          <Button size="sm" variant="secondary" disabled={disabled || !hasNext} onClick={() => onNavigate("next")}>
            Next
          </Button>
          {!label && <span className="text-xs text-slate-500">No annotator label set: records are stored as admin.</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SaveButton
            size="sm"
            label="Save draft"
            isLoading={busy === "save"}
            disabled={disabled}
            status={saveState.status}
            statusMessage={saveState.message}
            onClick={() => void handleSave(false)}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || !hasNext}
            loading={busy === "save-next"}
            loadingLabel="Saving..."
            onClick={() => void handleSave(true)}
          >
            Save &amp; next
          </Button>
        </div>
      </div>
    </div>
  );
}
