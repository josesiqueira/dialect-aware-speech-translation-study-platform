"use client";

/**
 * The demo page (spec 81). One page, four states: loading, the recording
 * notice (no session yet), recording, and the result of a recording.
 *
 * The pipeline is asked for stage by stage (transcription, translation,
 * synthesis), so each result is shown as soon as it exists and a failed stage
 * leaves the earlier results on screen (spec 144).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { demoSchemas } from "@dialect/domain";
import { ModeBanner, ParticipantCard, ParticipantHeading, ParticipantShell } from "@/components/participant";
import { RecordingTask, type RecordingCandidate, type SubmitContext } from "@/components/participant/recorder";
import { Button, ConfirmDialog, InlineMessage, LoadingState, RadioGroup } from "@/components/ui";
import { isApiClientError } from "@/lib/client/api";
import type { RecorderFallbackInfo } from "@/lib/client/recorder";
import {
  endDemoSession,
  fetchDemoSession,
  purgeLeftovers,
  runDemoStage,
  startDemoSession,
  uploadDemoRecording,
} from "./demoApi";
import { DemoResultView, StageProgress, type StageStates } from "./DemoResultView";
import { DEMO_STRINGS as S, fill } from "./strings";

type Provider = demoSchemas.PipelineProviderMode;
type Capture = "pcm" | "compressed";

type Run = {
  utteranceId: string;
  source: demoSchemas.PipelineSourceInfo;
  states: StageStates;
  result: demoSchemas.DemoResult | null;
};

const WAITING: StageStates = { asr: "waiting", translation: "waiting", tts: "waiting" };

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : S.genericError;
}

function summarize(stages: demoSchemas.PipelineStage[]): "done" | "failed" | "partial" | "skipped" {
  const ran = stages.filter((stage) => stage.status !== "skipped");
  if (ran.length === 0) return "skipped";
  if (ran.every((stage) => stage.status === "succeeded")) return "done";
  return ran.some((stage) => stage.status === "succeeded") ? "partial" : "failed";
}

export interface DemoClientProps {
  access: demoSchemas.DemoAccess;
  isAdmin: boolean;
  initialProvider: Provider;
}

export function DemoClient({ access, isAdmin, initialProvider }: DemoClientProps) {
  const [phase, setPhase] = useState<"loading" | "load_failed" | "notice" | "ready">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture>("pcm");
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [recorderKey, setRecorderKey] = useState(1);
  const [run, setRun] = useState<Run | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [clearing, setClearing] = useState(false);
  const [leftoverDialog, setLeftoverDialog] = useState(false);
  const [leftoverBusy, setLeftoverBusy] = useState(false);
  const [leftoverError, setLeftoverError] = useState<string | null>(null);
  const [leftoverDone, setLeftoverDone] = useState<string | null>(null);

  const fallbackRef = useRef<RecorderFallbackInfo | null>(null);
  const providerRef = useRef(provider);
  const sessionOpenRef = useRef(false);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  const load = useCallback(
    () =>
      fetchDemoSession().then(
        (response) => {
          sessionOpenRef.current = response.session !== null;
          setPhase(response.session ? "ready" : "notice");
        },
        () => setPhase("load_failed"),
      ),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const retryLoad = () => {
    setPhase("loading");
    void load();
  };

  // A demo session never stays open without its page: leaving the page ends it.
  // The server then keeps or deletes its data, as the study setting says.
  useEffect(() => {
    const onPageHide = () => {
      if (!sessionOpenRef.current) return;
      sessionOpenRef.current = false;
      navigator.sendBeacon("/api/demo/session/end");
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const backToNotice = useCallback((message: string | null) => {
    sessionOpenRef.current = false;
    setRun(null);
    setRunError(null);
    setNotice(message);
    setPhase("notice");
  }, []);

  const agree = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await startDemoSession();
      sessionOpenRef.current = true;
      setNotice(null);
      setRecorderKey((key) => key + 1);
      setPhase("ready");
    } catch (error) {
      setStartError(messageOf(error));
    } finally {
      setStarting(false);
    }
  };

  const runStages = useCallback(
    async (utteranceId: string, source: demoSchemas.PipelineSourceInfo) => {
      const update = (states: StageStates, result: demoSchemas.DemoResult | null) =>
        setRun({ utteranceId, source, states, result });
      const mode = providerRef.current;
      try {
        update({ ...WAITING, asr: "running" }, null);
        setAnnouncement(S.announce.asrRunning);
        const first = await runDemoStage(utteranceId, "asr", mode);
        if (first.asr.status !== "succeeded") {
          update({ asr: "failed", translation: "skipped", tts: "skipped" }, first);
          setAnnouncement(S.announce.asrFailed);
          return;
        }
        update({ asr: "done", translation: "running", tts: "waiting" }, first);
        setAnnouncement(S.announce.asrDone);

        const second = await runDemoStage(utteranceId, "translation", mode);
        // The transcript and its timing are the ones of the stage that produced them.
        const afterTranslation = { ...second, asr: first.asr };
        const translation = summarize(second.conditions.map((condition) => condition.translation));
        if (translation === "failed" || translation === "skipped") {
          update({ asr: "done", translation: "failed", tts: "skipped" }, afterTranslation);
          setAnnouncement(S.announce.translationFailed);
          return;
        }
        update({ asr: "done", translation, tts: "running" }, afterTranslation);
        setAnnouncement(S.announce.translationDone);

        const third = await runDemoStage(utteranceId, "tts", mode);
        const merged: demoSchemas.DemoResult = {
          ...third,
          asr: first.asr,
          conditions: third.conditions.map((condition) => ({
            ...condition,
            translation:
              second.conditions.find((earlier) => earlier.conditionKey === condition.conditionKey)?.translation ??
              condition.translation,
          })),
        };
        const tts = summarize(merged.conditions.map((condition) => condition.synthesis));
        update({ asr: "done", translation, tts }, merged);
        setAnnouncement(tts === "done" || tts === "partial" ? S.announce.ttsDone : S.announce.ttsFailed);
      } catch (error) {
        if (isApiClientError(error) && (error.code === "SESSION_EXPIRED" || error.code === "UNAUTHORIZED")) {
          backToNotice(S.sessionEnded);
          return;
        }
        setRunError(messageOf(error));
        setRun((current) =>
          current
            ? {
                ...current,
                states: {
                  asr: current.states.asr === "running" ? "failed" : current.states.asr,
                  translation: current.states.translation === "running" ? "failed" : current.states.translation,
                  tts: current.states.tts === "running" ? "failed" : current.states.tts,
                },
              }
            : current,
        );
      }
    },
    [backToNotice],
  );

  const handleSubmit = useCallback(
    async (candidate: RecordingCandidate, context: SubmitContext) => {
      setRunError(null);
      try {
        const { recording } = await uploadDemoRecording(candidate, fallbackRef.current, context.onProgress);
        setRun({ utteranceId: recording.utteranceId, source: recording.source, states: WAITING, result: null });
        void runStages(recording.utteranceId, recording.source);
      } catch (error) {
        if (isApiClientError(error) && (error.code === "SESSION_EXPIRED" || error.code === "UNAUTHORIZED")) {
          backToNotice(S.sessionEnded);
          return;
        }
        // The message of the server says what is wrong with the recording
        // (too long, too large). The recorder keeps the candidate and offers Retry.
        setRunError(messageOf(error));
        throw error;
      }
    },
    [backToNotice, runStages],
  );

  const shownUtteranceId = run?.utteranceId ?? null;
  useEffect(() => {
    if (shownUtteranceId && resultRef.current) resultRef.current.scrollIntoView({ block: "nearest" });
  }, [shownUtteranceId]);

  const recordAnother = () => {
    setRun(null);
    setRunError(null);
    setAnnouncement("");
    setRecorderKey((key) => key + 1);
  };

  const clear = async () => {
    setClearing(true);
    try {
      await endDemoSession();
    } catch {
      // The session is ended on the server when the page is left, at the latest.
    } finally {
      setClearing(false);
      setAnnouncement("");
      backToNotice(null);
    }
  };

  const removeLeftovers = async () => {
    setLeftoverBusy(true);
    setLeftoverError(null);
    try {
      const response = await purgeLeftovers();
      setLeftoverDone(fill(S.leftoversDone, { count: response.sessions }));
      setLeftoverDialog(false);
    } catch (error) {
      setLeftoverError(messageOf(error));
    } finally {
      setLeftoverBusy(false);
    }
  };

  const busy = run !== null && Object.values(run.states).some((state) => state === "running" || state === "waiting");
  const showMock = provider === "mock" || run?.result?.isMock === true;

  return (
    <ParticipantShell width="3xl" banner={<ModeBanner mode="DEMO">{S.bannerText}</ModeBanner>}>
      <ParticipantHeading title={S.heading} description={S.headingDescription} />

      <p role="status" aria-live="polite" className="sr-only" data-testid="demo-announcement">
        {announcement}
      </p>

      <div className="space-y-6">
        {showMock && (
          <InlineMessage variant="warning" title={S.mockTitle} announce="none">
            <span data-testid="demo-mock-label">{S.mockBody}</span>
          </InlineMessage>
        )}

        {phase === "loading" && <LoadingState label={S.loading} />}

        {phase === "load_failed" && (
          <ParticipantCard className="space-y-4">
            <InlineMessage variant="error">{S.loadFailed}</InlineMessage>
            <Button variant="secondary" onClick={retryLoad}>
              {S.retry}
            </Button>
          </ParticipantCard>
        )}

        {phase === "notice" && (
          <ParticipantCard as="section" aria-labelledby="demo-notice-title" className="space-y-4" data-testid="demo-notice">
            {notice && <InlineMessage variant="info">{notice}</InlineMessage>}
            <h2 id="demo-notice-title" className="text-lg font-semibold text-slate-900">
              {S.noticeTitle}
            </h2>
            <ul className="list-disc space-y-2 pl-5 text-slate-700">
              {S.noticeParagraphs.map((paragraph) => (
                <li key={paragraph}>{paragraph}</li>
              ))}
              <li>{access.demoPersist ? S.noticeKept : S.noticeNotKept}</li>
            </ul>
            {startError && <InlineMessage variant="error">{startError}</InlineMessage>}
            <Button size="lg" onClick={() => void agree()} loading={starting} loadingLabel={S.noticeAgreeBusy}>
              {S.noticeAgree}
            </Button>
          </ParticipantCard>
        )}

        {phase === "ready" && (
          <>
            <h2 className="text-lg font-semibold text-slate-900">{S.originalHeading}</h2>
            <RecordingTask
              key={recorderKey}
              prompt={<p className="text-lg text-slate-900">{S.recordPrompt}</p>}
              hint={S.recordHint}
              maxDurationMs={access.maxRecordingSeconds * 1000}
              minDurationMs={1000}
              prefer={capture}
              onSubmit={handleSubmit}
              onFallback={(fallback) => {
                fallbackRef.current = fallback;
              }}
              labels={{ submit: S.recordSubmitLabel, submitted: S.recordingSaved }}
            />

            {!run && (
              <details className="rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="demo-options">
                <summary className="cursor-pointer rounded-xl px-6 py-4 text-sm font-medium text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                  {S.optionsSummary}
                </summary>
                <div className="space-y-6 border-t border-slate-100 px-6 py-4">
                  <RadioGroup
                    label={S.captureLabel}
                    help={S.captureHelp}
                    value={capture}
                    onChange={(value) => setCapture(value === "compressed" ? "compressed" : "pcm")}
                    options={[
                      { value: "pcm", label: S.captureLossless, description: S.captureLosslessDescription },
                      { value: "compressed", label: S.captureCompressed, description: S.captureCompressedDescription },
                    ]}
                  />
                  {access.mockAvailable && (
                    <RadioGroup
                      label={S.pipelineLabel}
                      help={S.pipelineHelp}
                      value={provider}
                      onChange={(value) => setProvider(value === "mock" ? "mock" : "active")}
                      options={[
                        { value: "active", label: S.pipelineActive, description: S.pipelineActiveDescription },
                        { value: "mock", label: S.pipelineMock, description: S.pipelineMockDescription },
                      ]}
                    />
                  )}
                  {isAdmin && !access.demoPersist && (
                    <div className="space-y-2">
                      <Button variant="secondary" size="sm" onClick={() => setLeftoverDialog(true)}>
                        {S.leftoversButton}
                      </Button>
                      {leftoverDone && <InlineMessage variant="success">{leftoverDone}</InlineMessage>}
                    </div>
                  )}
                </div>
              </details>
            )}

            {runError && <InlineMessage variant="error">{runError}</InlineMessage>}

            {run && (
              <div ref={resultRef} className="space-y-6">
                <StageProgress states={run.states} />
                <DemoResultView result={run.result} source={run.source} states={run.states} isAdmin={isAdmin} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              {run && (
                <Button variant="primary" size="lg" onClick={recordAnother} disabled={busy}>
                  {S.recordAnother}
                </Button>
              )}
              <Button
                variant="secondary"
                size="lg"
                onClick={() => void clear()}
                loading={clearing}
                loadingLabel={S.clearBusy}
                disabled={busy}
              >
                {S.clear}
              </Button>
            </div>
            <p className="text-sm text-slate-500">{access.demoPersist ? S.noticeKept : S.noticeNotKept}</p>
          </>
        )}
      </div>

      <ConfirmDialog
        open={leftoverDialog}
        title={S.leftoversTitle}
        confirmLabel={S.leftoversConfirm}
        tone="danger"
        busy={leftoverBusy}
        error={leftoverError}
        onConfirm={() => void removeLeftovers()}
        onCancel={() => setLeftoverDialog(false)}
      >
        {S.leftoversBody}
      </ConfirmDialog>
    </ParticipantShell>
  );
}
