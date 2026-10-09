"use client";

/**
 * StudyFlow: the one participant study page (spec 107).
 *
 * The server decides the step. This component loads the state of the session
 * with GET /api/study/session, renders the step named by `state.step`, sends
 * every action to the API and renders the state that comes back. There is no
 * client-side routing between steps and no step in the URL, so a page reload
 * at any point shows what the server says (spec 61).
 *
 * The step components in components/participant/flow are presentational. All
 * API calls of the flow are in this file.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { QuestionnaireKey, sessionSchemas } from "@dialect/domain";
import { LoadingState } from "@/components/ui/States";
import {
  CompletedStep,
  ConsentStep,
  DebriefStep,
  EndParticipationDialog,
  FlowShell,
  InformationStep,
  InstructionsStep,
  MessageScreen,
  MicCheckStep,
  QuestionnaireStep,
  STEP_HEADING_ID,
  TaskStep,
  WithdrawnStep,
  type ConsentResponses,
  type QuestionnaireServerIssue,
} from "@/components/participant/flow";
import { EnglishCheckStep, OutputReviewStep } from "@/components/participant/review";
import type { MicCheckResult } from "@/components/participant/recorder/MicCheck";
import type { RecordingCandidate } from "@/components/participant/recorder/recorderMachine";
import type { SubmitContext } from "@/components/participant/recorder/useRecorder";
import type { RecorderFallbackInfo } from "@/lib/client/recorder";
import {
  errorMessage,
  format,
  getDictionary,
  matchInterfaceLocale,
  type Dictionary,
  type InterfaceLocale,
} from "@/lib/i18n";
import { clearClientState, leaveToWelcome, rememberLocale, showPageTitle } from "../_lib/clientState";
import { createTurnTracker, turnKeyOf } from "../_lib/turnTracker";
import {
  browserInfo,
  captureMetadataOf,
  errorCodeOf,
  maintenanceMessageOf,
  participantApi,
  questionnaireIssuesOf,
  recordingFileName,
  reviewAudioUrl,
} from "../_lib/participantApi";

/** How often the page asks again while the recordings for the review are prepared. */
const REVIEW_POLL_MS = 4000;

type ParticipantState = sessionSchemas.ParticipantState;

type View =
  | { kind: "loading" }
  /** The first load failed (network, server). Retry loads again. */
  | { kind: "load_failed"; code: string }
  /** The session ended on the server (expired, abandoned). */
  | { kind: "expired" }
  | { kind: "active"; state: ParticipantState };

/** A failed action. `serverMessage` is set only for the researchers' own maintenance text. */
type Failure = { code: string; serverMessage: string | null };

/**
 * The declared language of the study texts, when the study settings carry one
 * (`contentLanguage`, a BCP 47 tag). The participant API has no such field
 * today, so this returns undefined and no `lang` is written on study texts.
 * The language is never guessed from the text.
 */
function contentLanguageOf(settings: unknown): string | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const value = (settings as { contentLanguage?: unknown }).contentLanguage;
  return typeof value === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value) ? value : undefined;
}

/** The step name for the browser tab title (WCAG 2.4.2). Interface words only, never study content. */
function stepNameOf(t: Dictionary, state: ParticipantState, consentScreen: "information" | "form"): string {
  switch (state.step) {
    case "consent":
      return consentScreen === "information" ? t.pageTitle.information : t.pageTitle.consent;
    case "mic_check":
      return t.pageTitle.micCheck;
    case "instructions":
      return t.pageTitle.instructions;
    case "tasks":
      return state.progress
        ? format(t.pageTitle.task, { current: state.progress.taskNumber, total: state.progress.totalTasks })
        : t.task.typeLabel;
    case "background":
    case "post_recording":
    case "post_review":
      return t.pageTitle.questionnaire;
    case "english_check":
      return t.pageTitle.englishCheck;
    case "output_review":
      return t.pageTitle.review;
    case "debrief":
      return t.pageTitle.debrief;
    case "completed":
      return t.pageTitle.completed;
    case "withdrawn":
      return t.pageTitle.withdrawn;
  }
}

export interface StudyFlowProps {
  /** Languages the study offers and the interface has. */
  locales: InterfaceLocale[];
  /** The language to start with: the participant's stored choice, else the study default. */
  initialLocale: InterfaceLocale;
  /** True when `initialLocale` is the participant's own stored choice. */
  localeChosen: boolean;
}

export function StudyFlow({ locales, initialLocale, localeChosen }: StudyFlowProps) {
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [locale, setLocale] = useState<InterfaceLocale>(initialLocale);
  const [consentScreen, setConsentScreen] = useState<"information" | "form">("information");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [issues, setIssues] = useState<QuestionnaireServerIssue[]>([]);
  const [declined, setDeclined] = useState(false);
  const [endDialogOpen, setEndDialogOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endFailure, setEndFailure] = useState<string | null>(null);

  // Bookkeeping of the turn that is shown: utterance id, uploaded candidate, running upload.
  const [turns] = useState(createTurnTracker);
  const localeChosenRef = useRef(localeChosen);

  const t = getDictionary(locale);

  // -------------------------------------------------------------------------
  // State from the server
  // -------------------------------------------------------------------------

  /** Everything of the session leaves the browser (spec 137, 138). */
  const dropClientState = useCallback(() => {
    turns.reset();
    clearClientState();
  }, [turns]);

  const applyState = useCallback(
    (state: ParticipantState) => {
      if (state.step === "completed" || state.step === "withdrawn") dropClientState();
      setView({ kind: "active", state });
    },
    [dropClientState],
  );

  /** Takes the answer of GET /api/study/session. `initial`: without a session the participant goes back to the welcome page. */
  const receiveSession = useCallback(
    (state: ParticipantState | null, initial: boolean) => {
      if (!state) {
        dropClientState();
        if (initial) router.replace("/");
        else setView({ kind: "expired" });
        return;
      }
      // The language stored with the session applies when the participant has
      // made no choice in this browser (for example after the cookie was removed).
      if (!localeChosenRef.current) {
        const sessionLocale = matchInterfaceLocale(state.locale);
        if (sessionLocale && locales.includes(sessionLocale)) setLocale(sessionLocale);
      }
      applyState(state);
    },
    [applyState, dropClientState, locales, router],
  );

  const load = useCallback(
    (initial: boolean): Promise<void> =>
      participantApi.getSession().then(
        (response) => receiveSession(response.state, initial),
        (error: unknown) => setView({ kind: "load_failed", code: errorCodeOf(error) }),
      ),
    [receiveSession],
  );

  // The first load. A reload of the page arrives here too, and shows the step the server names (spec 61).
  useEffect(() => {
    let cancelled = false;
    participantApi.getSession().then(
      (response) => {
        if (!cancelled) receiveSession(response.state, true);
      },
      (error: unknown) => {
        if (!cancelled) setView({ kind: "load_failed", code: errorCodeOf(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [receiveSession]);

  /** A failed action: expired sessions end the flow, a wrong step reloads the state, the rest is shown in place. */
  const handleFailure = useCallback(
    async (error: unknown) => {
      const code = errorCodeOf(error);
      if (code === "SESSION_EXPIRED") {
        dropClientState();
        setView({ kind: "expired" });
        return;
      }
      if (code === "INVALID_STATE") {
        await load(false);
        return;
      }
      setFailure({ code, serverMessage: maintenanceMessageOf(error) });
    },
    [dropClientState, load],
  );

  /** Runs one action that answers with the new state. */
  const run = useCallback(
    async (action: () => Promise<sessionSchemas.StateResponse>) => {
      setBusy(true);
      setFailure(null);
      try {
        const { state } = await action();
        applyState(state);
      } catch (error) {
        await handleFailure(error);
      } finally {
        setBusy(false);
      }
    },
    [applyState, handleFailure],
  );

  // -------------------------------------------------------------------------
  // What is shown
  // -------------------------------------------------------------------------

  const state = view.kind === "active" ? view.state : null;
  const task = state?.step === "tasks" ? state.task : null;
  const turnKey = task ? turnKeyOf(task) : null;

  // One key per screen. When it changes, focus moves to the heading of the new
  // screen, so a screen reader announces it and the keyboard starts at the top.
  const screenKey =
    view.kind !== "active"
      ? view.kind
      : ending
        ? "ending"
        : view.state.step === "consent"
          ? `consent:${consentScreen}`
          : view.state.step === "tasks"
            ? `tasks:${turnKey}`
            : view.state.step === "output_review" && view.state.review.status === "ready"
              ? `output_review:${view.state.review.item.id}`
              : view.state.step;
  useEffect(() => {
    if (screenKey === "loading" || screenKey === "ending") return;
    window.scrollTo(0, 0);
    document.getElementById(STEP_HEADING_ID)?.focus({ preventScroll: true });
  }, [screenKey]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // The browser tab title names the screen, in the interface language, followed by the
  // participant-facing study title of the session. Before the first answer of the server
  // the title that the server rendered (the study title alone) stays.
  const stepName =
    view.kind === "loading"
      ? null
      : view.kind === "load_failed"
        ? t.pageTitle.error
        : view.kind === "expired"
          ? t.pageTitle.sessionExpired
          : stepNameOf(t, view.state, consentScreen);
  const studyTitle = state?.studyName ?? null;
  useEffect(() => {
    if (stepName === null) return;
    showPageTitle(stepName, studyTitle);
  }, [stepName, studyTitle]);

  const changeLocale = (next: InterfaceLocale) => {
    localeChosenRef.current = true;
    setLocale(next);
    // After the session ended nothing is stored again: the choice lasts for the final screen only.
    const ended = view.kind === "expired" || state?.step === "completed" || state?.step === "withdrawn";
    if (!ended) rememberLocale(next);
    // The study texts follow the language too: the session stores it and the
    // server answers with the texts in that language. If the request fails, only
    // the interface language changed; the next state brings the texts.
    if (!ended && state && state.locale !== next) {
      participantApi.setLocale({ locale: next }).then(
        ({ state: updated }) => applyState(updated),
        () => undefined,
      );
    }
  };

  // -------------------------------------------------------------------------
  // Tasks: prepare, upload, submit, skip
  // -------------------------------------------------------------------------

  // "The task is now shown": start it and create the utterance of the turn.
  useEffect(() => {
    if (!task) return;
    turns.ensure(task).catch((error: unknown) => void handleFailure(error));
    // The effect runs once per turn. `task` changes identity with every state, the key does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnKey]);

  const submitRecording = useCallback(
    async (candidate: RecordingCandidate, context: SubmitContext) => {
      if (!task) throw new Error("No task is shown.");
      try {
        const utteranceId = await turns.ensure(task);

        // When the upload of this recording already arrived, only the submit is repeated.
        let mediaAssetId = turns.uploadedAttempt(task, candidate.attempt);
        if (!mediaAssetId) {
          const form = new FormData();
          form.set("audio", candidate.blob, recordingFileName(candidate.mimeType));
          form.set("metadata", JSON.stringify(captureMetadataOf(candidate, turns.fallback())));
          const uploaded = await participantApi.uploadAudio(utteranceId, form, {
            onProgress: (fraction) => context.onProgress(fraction),
            signal: turns.newAbortSignal(),
          });
          mediaAssetId = uploaded.mediaAssetId;
          turns.setUploaded(task, candidate.attempt, mediaAssetId);
        }

        const { state: next } = await participantApi.submitUtterance(utteranceId, {
          mediaAssetId,
          attemptCount: context.attemptCount,
        });
        // The server stored the recording. Only now does the participant advance (spec 62).
        turns.clearUploaded();
        setFailure(null);
        applyState(next);
      } catch (error) {
        const code = errorCodeOf(error);
        // The server no longer has this upload as the candidate: the retry uploads again.
        if (code === "MEDIA_NOT_FOUND") turns.clearUploaded();
        if (code === "SESSION_EXPIRED" || code === "INVALID_STATE") void handleFailure(error);
        // Rejecting keeps the recording in the recorder and shows Retry.
        throw error;
      }
    },
    [applyState, handleFailure, task, turns],
  );

  /** The participant recorded again or discarded: an upload of the earlier recording is removed (spec 10). */
  const handleCandidateChange = useCallback(
    (candidate: RecordingCandidate | null) => turns.candidateChanged(candidate ? candidate.attempt : null),
    [turns],
  );

  const handleFallback = useCallback((fallback: RecorderFallbackInfo) => turns.setFallback(fallback), [turns]);

  const skipTurn = () => {
    if (!task) return;
    void run(async () => participantApi.skipTurn(await turns.ensure(task)));
  };

  // -------------------------------------------------------------------------
  // Other actions
  // -------------------------------------------------------------------------

  const agree = (responses: ConsentResponses) => void run(() => participantApi.consent({ responses }));

  const confirmMicCheck = (result: MicCheckResult) =>
    void run(() =>
      participantApi.micCheck({
        audioEnvironment: {
          ...result.audioEnvironment,
          deviceLabel: result.audioEnvironment.deviceLabel?.slice(0, 200),
          ...(result.constraintMismatches.length > 0
            ? { constraintMismatches: result.constraintMismatches.slice(0, 20) }
            : {}),
          ...(result.fallback
            ? { fallbackReason: result.fallback.reason, fallbackDetail: result.fallback.detail.slice(0, 500) }
            : {}),
        },
        browserInfo: browserInfo(),
      }),
    );

  const submitQuestionnaire = async (key: QuestionnaireKey, answers: Record<string, unknown>) => {
    setIssues([]);
    setFailure(null);
    try {
      const { state: next } = await participantApi.submitQuestionnaire(key, { answers });
      applyState(next);
    } catch (error) {
      const found = questionnaireIssuesOf(error);
      if (found.length > 0) setIssues(found);
      else await handleFailure(error);
      // Rejecting keeps the answers in the form and shows its "could not be sent" message.
      throw error;
    }
  };

  // -------------------------------------------------------------------------
  // The output review part (after every speaking task)
  // -------------------------------------------------------------------------

  // While the recordings are prepared, ask the server to start the review now
  // and every few seconds. The server decides when it is ready or the waiting is over.
  const reviewPreparing = state?.step === "output_review" && state.review.status === "preparing";
  useEffect(() => {
    if (!reviewPreparing) return;
    let cancelled = false;
    const tick = () => {
      participantApi.startReview().then(
        ({ state: next }) => {
          if (!cancelled) applyState(next);
        },
        (error: unknown) => {
          if (!cancelled) void handleFailure(error);
        },
      );
    };
    tick();
    const timer = window.setInterval(tick, REVIEW_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reviewPreparing, applyState, handleFailure]);

  const submitEnglishCheck = async (answers: boolean[]) => {
    setBusy(true);
    setFailure(null);
    try {
      const { state: next } = await participantApi.englishCheck({ answers });
      applyState(next);
    } catch (error) {
      await handleFailure(error);
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const answerReviewItem = async (itemId: string, answer: sessionSchemas.OutputReviewAnswerBody) => {
    setBusy(true);
    setFailure(null);
    try {
      const { state: next } = await participantApi.answerReviewItem(itemId, answer);
      applyState(next);
    } catch (error) {
      await handleFailure(error);
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const skipReview = () => void run(() => participantApi.skipReview());

  /** Ends participation (spec 86). `fromConsent`: nothing was collected yet. */
  const withdraw = async (fromConsent: boolean) => {
    // The step is unmounted at once: a running recording stops, its data is
    // dropped and the microphone is released. A running upload is cancelled.
    setEnding(true);
    setEndFailure(null);
    turns.abort();
    try {
      const { state: next } = await participantApi.withdraw();
      setDeclined(fromConsent);
      setEndDialogOpen(false);
      setFailure(null);
      applyState(next);
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "SESSION_EXPIRED") {
        setEndDialogOpen(false);
        dropClientState();
        setView({ kind: "expired" });
      } else {
        setEndFailure(code);
        setEndDialogOpen(true);
      }
    } finally {
      setEnding(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const failureText = failure ? (failure.serverMessage ?? errorMessage(t, failure.code)) : null;
  const shell = {
    t,
    locale,
    locales,
    onLocaleChange: changeLocale,
    contentLang: contentLanguageOf(state?.settings),
  };

  if (view.kind === "loading") {
    return (
      <FlowShell {...shell}>
        <div aria-busy="true">
          <LoadingState label={t.common.loading} />
        </div>
      </FlowShell>
    );
  }

  if (view.kind === "load_failed") {
    return (
      <FlowShell {...shell} width="md" centered>
        <MessageScreen
          title={t.errorScreens.genericTitle}
          message={errorMessage(t, view.code)}
          actionLabel={t.common.tryAgain}
          onAction={() => {
            setView({ kind: "loading" });
            void load(true);
          }}
          secondaryLabel={t.common.backToStart}
          onSecondary={leaveToWelcome}
        />
      </FlowShell>
    );
  }

  if (view.kind === "expired") {
    return (
      <FlowShell {...shell} width="md" centered>
        <MessageScreen
          title={t.errorScreens.sessionExpiredTitle}
          message={t.errors.SESSION_EXPIRED}
          actionLabel={t.common.backToStart}
          onAction={leaveToWelcome}
        />
      </FlowShell>
    );
  }

  const current = view.state;
  const ended = current.step === "completed" || current.step === "withdrawn";
  const narrow = current.step === "completed" || (current.step === "withdrawn" && declined);

  let content;
  if (ending) {
    content = (
      <div aria-busy="true">
        <LoadingState label={t.endParticipation.busy} />
      </div>
    );
  } else {
    switch (current.step) {
      case "consent":
        content =
          consentScreen === "information" ? (
            <InformationStep t={t} content={current.information.content} onContinue={() => setConsentScreen("form")} />
          ) : (
            <ConsentStep
              t={t}
              consent={current.consent}
              onAgree={agree}
              onDecline={() => void withdraw(true)}
              onBack={() => setConsentScreen("information")}
              busy={busy}
              error={failureText}
            />
          );
        break;
      case "mic_check":
        content = <MicCheckStep t={t} onContinue={confirmMicCheck} busy={busy} error={failureText} />;
        break;
      case "instructions":
        content = (
          <InstructionsStep
            t={t}
            content={current.instructions.content}
            onStart={() => void run(() => participantApi.acknowledgeInstructions())}
            busy={busy}
            error={failureText}
          />
        );
        break;
      case "tasks":
        content = (
          <TaskStep
            key={turnKeyOf(current.task)}
            t={t}
            task={current.task}
            onSubmitRecording={submitRecording}
            onSkip={skipTurn}
            skipBusy={busy}
            notice={current.task.turn.candidate ? t.task.discardedAfterReload : null}
            error={failureText}
            onCandidateChange={handleCandidateChange}
            onFallback={handleFallback}
          />
        );
        break;
      case "english_check":
        content = (
          <EnglishCheckStep
            t={t}
            englishCheck={current.englishCheck}
            onSubmit={submitEnglishCheck}
            onSkip={skipReview}
            busy={busy}
            error={failureText}
          />
        );
        break;
      case "output_review":
        content = (
          <OutputReviewStep
            t={t}
            review={current.review}
            audioUrl={reviewAudioUrl}
            onAnswer={answerReviewItem}
            onSkip={skipReview}
            busy={busy}
            error={failureText}
          />
        );
        break;
      case "background":
      case "post_recording":
      case "post_review":
        content = (
          <QuestionnaireStep
            key={current.questionnaire.key}
            t={t}
            questionnaire={current.questionnaire}
            onSubmit={(answers) => submitQuestionnaire(current.questionnaire.key, answers)}
            serverIssues={issues}
            error={failureText}
          />
        );
        break;
      case "debrief":
        content = (
          <DebriefStep
            t={t}
            debrief={current.debrief}
            participantCode={current.participantCode}
            onFinish={() => void run(() => participantApi.complete())}
            busy={busy}
            error={failureText}
          />
        );
        break;
      case "completed":
        content = (
          <CompletedStep t={t} studyLaptopMode={current.settings.studyLaptopMode} onStartNext={leaveToWelcome} />
        );
        break;
      case "withdrawn":
        content = (
          <WithdrawnStep
            t={t}
            declined={declined}
            debrief={current.debrief}
            participantCode={current.participantCode}
            onBackToStart={leaveToWelcome}
          />
        );
        break;
    }
  }

  return (
    <FlowShell
      {...shell}
      // The final card stands alone, as on the reference thank-you page: nothing is left to read in another language.
      locales={narrow ? [locale] : locales}
      mode={current.mode}
      progress={current.step === "tasks" && !ending ? current.progress : null}
      onEndParticipation={
        ended || ending
          ? undefined
          : () => {
              setEndFailure(null);
              setEndDialogOpen(true);
            }
      }
      width={narrow ? "md" : "2xl"}
      centered={ended}
    >
      {content}
      <EndParticipationDialog
        t={t}
        open={endDialogOpen}
        busy={ending}
        error={endFailure ? t.endParticipation.failed : null}
        onConfirm={() => void withdraw(current.step === "consent")}
        onCancel={() => setEndDialogOpen(false)}
      />
    </FlowShell>
  );
}
