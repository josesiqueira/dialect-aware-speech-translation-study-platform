"use client";

/**
 * Click-through of the participant study for one protocol version (spec 130).
 *
 * The preview renders the same presentational step components as the study
 * page (components/participant/flow) with the same interface dictionaries
 * (lib/i18n), so the researcher sees what a participant sees, including the
 * language buttons. The content comes from the protocol version that was
 * loaded by the server page, in the language chosen with the language buttons
 * (the base text where a text has no translation).
 *
 * The whole preview is local state in the browser. It calls no API, creates no
 * session and stores nothing: answers, consent boxes and the language choice
 * are gone when the step changes or the page is closed. The microphone is
 * never opened: the mic check and the recording control are shown in their
 * starting state, and pressing their buttons only shows a note.
 */

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CONSENT_SCOPE_OUTPUT_REVIEW, LEXTALE_EN_ITEMS, LEXTALE_EN_VERSION, localizeKeyed, localizeList, localizeText } from "@dialect/domain";
import { PreviewBanner } from "@/components/participant";
import { EnglishCheckStep, OutputReviewStep } from "@/components/participant/review";
import {
  CompletedStep,
  ConsentStep,
  DebriefStep,
  FlowShell,
  InformationStep,
  InstructionsStep,
  MicCheckStep,
  QuestionnaireStep,
  TaskStep,
  WelcomeStep,
  type FlowShellProps,
  type TaskStepTask,
} from "@/components/participant/flow";
import type { RecorderDependencies } from "@/components/participant/recorder/useRecorder";
import { Button, Select } from "@/components/ui";
import { getDictionary, type Dictionary, type InterfaceLocale } from "@/lib/i18n";
import type { ProtocolDetail, Task } from "@/app/admin/(shell)/study-flow/_components/types";

export type PreviewProtocol = ProtocolDetail;

/** The study settings the participant screens depend on. Loaded by the server page. */
export interface PreviewStudy {
  /** Study name: the heading of the welcome page. */
  name: string;
  /** The study name per locale, when the study has translations of it. */
  nameByLocale?: Record<string, string>;
  /** The study's languages that the interface has. */
  locales: InterfaceLocale[];
  defaultLocale: InterfaceLocale;
  /** Study limit for one recording. A task's own limit is never above it. */
  maxUtteranceSeconds: number;
  studyLaptopMode: boolean;
  /** The English vocabulary test before the review. Off unless a researcher turns it on. */
  englishCheckEnabled?: boolean;
}

export interface PreviewFlowProps {
  protocol: PreviewProtocol;
  study: PreviewStudy;
}

/** Shown in place of a real participant code. It has the format of a code and cannot be one (no letter I, O or U in real codes). */
export const PREVIEW_PARTICIPANT_CODE = "P-PREVIEW";

// The sample page of the output review in the preview. In the study the text and
// the two versions come from the participant's own recording.
const PREVIEW_REVIEW_ITEM = {
  id: "00000000-0000-4000-8000-000000000000",
  sourceText: "Mie lähin eilen kauppaan, mut siellä ei ollu yhtään leipää jäljellä. Meitin pittää männä huomenna uuestaan.",
  versions: [
    { slot: 1 as const, text: "I went to the store yesterday, but there wasn't any bread left. We'll have to go again tomorrow." },
    { slot: 2 as const, text: "I went to the store yesterday, but they didn't have any bread left. We've gotta go back tomorrow." },
  ],
  audio: { source: false },
};

/** Everything a step needs from the preview. */
interface StepContext {
  t: Dictionary;
  onNext: () => void;
  onBack: () => void;
  onRestart: () => void;
  /** Inert stand-ins for the browser recorder functions. */
  recorder: Partial<RecorderDependencies>;
  /** Changes when a recorder button was pressed, so the step returns to its starting state. */
  recorderResets: number;
}

interface Step {
  key: string;
  /** Name in the researcher's step list. Not participant text. */
  label: string;
  width: NonNullable<FlowShellProps["width"]>;
  centered?: boolean;
  /** Task position for the progress line, as the study page shows it. */
  progress?: { taskNumber: number; totalTasks: number };
  /** The step has a microphone or recording control. */
  usesMicrophone?: boolean;
  render: (context: StepContext) => ReactNode;
}

type Questionnaire = NonNullable<PreviewProtocol["backgroundQuestionnaire"]>;

/** The questionnaire as the participant API delivers it (packages/research sessions/state.ts). */
function questionnaireContent(questionnaire: Questionnaire, locale: string) {
  return {
    name: localizeText(questionnaire.name, questionnaire.translationsJson, locale, "name"),
    description: localizeText(questionnaire.description, questionnaire.translationsJson, locale, "description"),
    items: questionnaire.items.map((item) => {
      const t = item.translationsJson;
      const config = { ...(item.configJson ?? {}) };
      if (config.options) {
        config.options = config.options.map((option) => ({
          ...option,
          label: localizeKeyed(option.label, t, locale, "options", option.value),
        }));
      }
      for (const field of ["scaleMinLabel", "scaleMaxLabel", "placeholder"] as const) {
        const value = config[field];
        if (typeof value === "string") config[field] = localizeText(value, t, locale, field);
      }
      return {
        itemKey: item.itemKey,
        type: item.type,
        prompt: localizeText(item.prompt, t, locale, "prompt"),
        helpText: localizeText(item.helpText, t, locale, "helpText"),
        required: item.required,
        config,
      };
    }),
  };
}

/** One turn of a task as the participant API delivers it. Turn 0 is the main prompt, then the enabled follow-ups. */
function taskTurns(task: Task, maxUtteranceSeconds: number, locale: string): TaskStepTask[] {
  const followups = task.followups.filter((followup) => followup.enabled);
  const allOptional = task.configJson?.followupMode === "optional";
  const t = task.translationsJson;
  const prompt = localizeText(task.participantPrompt, t, locale, "participantPrompt");
  const base = {
    title: localizeText(task.title, t, locale, "title"),
    prompt,
    context: localizeText(task.contextText, t, locale, "contextText"),
    instructions: localizeText(task.instructionsText, t, locale, "instructionsText"),
    minDurationSeconds: task.minDurationSeconds,
    suggestedDurationSeconds: task.suggestedDurationSeconds,
    maxDurationSeconds: task.maxDurationSeconds
      ? Math.min(task.maxDurationSeconds, maxUtteranceSeconds)
      : maxUtteranceSeconds,
    privacyReminder: task.privacyReminder,
    topicSuggestions: localizeList(task.configJson?.topicSuggestions ?? [], t, locale, "topicSuggestions"),
  };
  const totalTurns = followups.length + 1;
  return [
    {
      ...base,
      turn: { turnIndex: 0, totalTurns, promptText: prompt, isFollowup: false, isOptional: false },
    },
    ...followups.map((followup, index) => ({
      ...base,
      turn: {
        turnIndex: index + 1,
        totalTurns,
        promptText: localizeText(followup.promptText, followup.translationsJson, locale, "promptText"),
        isFollowup: true,
        isOptional: allOptional || !followup.isRequired,
      },
    })),
  ];
}

function buildSteps(protocol: PreviewProtocol, study: PreviewStudy, locale: string): Step[] {
  const { protocol: version, tasks, consentVersion, backgroundQuestionnaire, postQuestionnaire, postReviewQuestionnaire } =
    protocol;
  const text = (field: "welcomeContent" | "informationContent" | "instructionContent" | "debriefContent") =>
    localizeText(version[field], version.translationsJson, locale, field);
  const consentText = <T extends string | null>(base: T, field: "title" | "informationText" | "contactText") =>
    localizeText(base, consentVersion?.translationsJson, locale, field);
  const steps: Step[] = [
    {
      key: "welcome",
      label: "Welcome",
      width: "3xl",
      render: ({ t, onNext }) => (
        <WelcomeStep
          t={t}
          studyName={study.nameByLocale?.[locale] ?? study.name}
          welcomeContent={text("welcomeContent")}
          onBegin={onNext}
        />
      ),
    },
    // As in the study: first the information text of the protocol, then the consent form
    // with the text and the items of the consent version.
    {
      key: "information",
      label: "Participant information",
      width: "2xl",
      render: ({ t, onNext }) => <InformationStep t={t} content={text("informationContent")} onContinue={onNext} />,
    },
  ];

  if (consentVersion) {
    steps.push({
      key: "consent",
      label: "Consent",
      width: "2xl",
      render: ({ t, onNext, onBack, onRestart }) => (
        <ConsentStep
          t={t}
          consent={{
            title: consentText(consentVersion.title, "title"),
            informationText: consentText(consentVersion.informationText, "informationText"),
            items: consentVersion.itemsJson.map((item) => ({
              id: item.id,
              text: localizeKeyed(item.text, consentVersion.translationsJson, locale, "items", item.id),
              required: item.required,
            })),
            privacyNoticeUrl: consentVersion.privacyNoticeUrl,
            contactText: consentText(consentVersion.contactText, "contactText"),
          }}
          onAgree={onNext}
          onDecline={onRestart}
          onBack={onBack}
        />
      ),
    });
  }

  steps.push(
    {
      key: "mic",
      label: "Microphone check",
      width: "2xl",
      usesMicrophone: true,
      render: ({ t, onNext, recorder, recorderResets }) => (
        <MicCheckStep key={recorderResets} t={t} onContinue={onNext} dependencies={recorder} />
      ),
    },
    {
      key: "instructions",
      label: "Instructions",
      width: "2xl",
      render: ({ t, onNext }) => <InstructionsStep t={t} content={text("instructionContent")} onStart={onNext} />,
    },
  );

  // Only enabled tasks and enabled follow-ups are shown to participants.
  const enabledTasks = tasks.filter((task) => task.enabled);
  for (const [index, task] of enabledTasks.entries()) {
    const progress = { taskNumber: index + 1, totalTasks: enabledTasks.length };
    for (const turn of taskTurns(task, study.maxUtteranceSeconds, locale)) {
      const { turnIndex } = turn.turn;
      steps.push({
        key: `task-${task.id}-${turnIndex}`,
        label:
          turnIndex === 0
            ? `Task ${index + 1}: ${task.title || task.taskKey}`
            : `Task ${index + 1}, follow-up ${turnIndex}`,
        width: "2xl",
        progress,
        usesMicrophone: true,
        render: ({ t, onNext, recorder, recorderResets }) => (
          <TaskStep
            key={recorderResets}
            t={t}
            task={turn}
            // Never called: the stand-in recorder produces no recording.
            onSubmitRecording={async () => undefined}
            onSkip={onNext}
            dependencies={recorder}
          />
        ),
      });
    }
  }

  for (const [key, label, questionnaire] of [
    ["background", "Background questionnaire", backgroundQuestionnaire],
    ["post", "Post-recording questionnaire", postQuestionnaire],
  ] as const) {
    if (!questionnaire) continue;
    const content = questionnaireContent(questionnaire, locale);
    steps.push({
      key,
      label,
      width: "2xl",
      // The answers stay in the form and are dropped when the step changes.
      render: ({ t, onNext }) => <QuestionnaireStep t={t} questionnaire={content} onSubmit={async () => onNext()} />,
    });
  }

  // The output review part. It exists only when the consent has an item of scope
  // output_review. The real review shows the participant's own recordings; the
  // preview shows one page with a sample text so the questions can be read.
  const offersReview = (consentVersion?.itemsJson ?? []).some((item) => item.scope === CONSENT_SCOPE_OUTPUT_REVIEW);
  if (offersReview && study.englishCheckEnabled) steps.push({
    key: "english_check",
    label: "English check (output review part)",
    width: "2xl",
    render: ({ t, onNext }) => (
      <EnglishCheckStep
        t={t}
        englishCheck={{ version: LEXTALE_EN_VERSION, items: LEXTALE_EN_ITEMS.map((item, index) => ({ index, text: item.item })) }}
        onSubmit={async () => onNext()}
        onSkip={onNext}
      />
    ),
  });
  if (offersReview) steps.push({
    key: "output_review",
    label: "Output review (sample page)",
    width: "2xl",
    render: ({ t, onNext }) => (
      <OutputReviewStep
        t={t}
        review={{ status: "ready", itemNumber: 1, totalItems: 1, item: PREVIEW_REVIEW_ITEM }}
        audioUrl={() => ""}
        onAnswer={async () => onNext()}
        onSkip={onNext}
      />
    ),
  });
  if (offersReview && postReviewQuestionnaire) {
    const content = questionnaireContent(postReviewQuestionnaire, locale);
    steps.push({
      key: "post_review",
      label: "Post-review questionnaire",
      width: "2xl",
      render: ({ t, onNext }) => <QuestionnaireStep t={t} questionnaire={content} onSubmit={async () => onNext()} />,
    });
  }

  steps.push(
    {
      key: "debrief",
      label: "Debrief",
      width: "2xl",
      render: ({ t, onNext }) => (
        <DebriefStep
          t={t}
          debrief={{
            content: text("debriefContent"),
            contactText: consentVersion ? consentText(consentVersion.contactText, "contactText") : null,
          }}
          participantCode={PREVIEW_PARTICIPANT_CODE}
          onFinish={onNext}
        />
      ),
    },
    {
      key: "completed",
      label: "Final screen",
      width: "md",
      centered: true,
      render: ({ t, onRestart }) => (
        <CompletedStep t={t} studyLaptopMode={study.studyLaptopMode} onStartNext={onRestart} />
      ),
    },
  );
  return steps;
}

export function PreviewFlow({ protocol, study }: PreviewFlowProps) {
  const [index, setIndex] = useState(0);
  // The language choice lives in this component only: no cookie is written.
  const [locale, setLocale] = useState<InterfaceLocale>(study.defaultLocale);
  const steps = useMemo(() => buildSteps(protocol, study, locale), [protocol, study, locale]);
  const [microphoneNote, setMicrophoneNote] = useState(false);
  const [recorderResets, setRecorderResets] = useState(0);

  const step = steps[Math.min(index, steps.length - 1)] as Step;
  const version = protocol.protocol;
  const shuffledBlocks = version.orderConfigJson.blocks.filter((block) => block.orderMode === "shuffle_within_block");
  const t = getDictionary(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  function go(next: number) {
    setIndex(Math.max(0, Math.min(steps.length - 1, next)));
    setMicrophoneNote(false);
    window.scrollTo({ top: 0 });
  }

  // Stand-ins for the browser recorder functions. Pressing "Allow microphone"
  // or "Start recording" reaches requestMicrophone: the preview shows a note
  // and puts the step back into its starting state. getUserMedia is not called.
  const recorder = useMemo<Partial<RecorderDependencies>>(
    () => ({
      requestMicrophone: () => {
        setMicrophoneNote(true);
        setRecorderResets((count) => count + 1);
        // Never settles. The step is remounted, so nothing waits for it.
        return new Promise(() => undefined);
      },
      createRecorder: () => Promise.reject(new Error("The preview does not record.")),
      releaseMicrophone: () => undefined,
    }),
    [],
  );

  const context: StepContext = {
    t,
    onNext: () => go(index + 1),
    onBack: () => go(index - 1),
    onRestart: () => go(0),
    recorder,
    recorderResets,
  };

  return (
    <FlowShell
      t={t}
      locale={locale}
      locales={study.locales}
      onLocaleChange={setLocale}
      width={step.width}
      centered={step.centered}
      progress={step.progress ?? null}
      banner={
        <>
          <PreviewBanner>
            Protocol v{version.versionNumber} ({version.status})
          </PreviewBanner>
          {/* Researcher controls, always in English. They are part of the preview, not of the participant study. */}
          <nav
            lang="en"
            aria-label="Preview controls"
            data-testid="preview-controls"
            className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-slate-200 bg-slate-100 px-4 py-2 text-sm text-slate-700"
          >
            <Link
              href="/admin/study-flow"
              className="rounded-sm font-medium text-slate-900 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none"
            >
              Back to Study Flow
            </Link>
            <Button size="sm" variant="secondary" disabled={index === 0} onClick={() => go(index - 1)}>
              Previous step
            </Button>
            <label className="flex items-center gap-2">
              <span className="tabular-nums">
                Step {index + 1} of {steps.length}
              </span>
              <Select
                aria-label="Go to step"
                className="w-auto py-1.5"
                value={String(index)}
                onChange={(event) => go(Number(event.target.value))}
              >
                {steps.map((candidate, position) => (
                  <option key={candidate.key} value={position}>
                    {position + 1}. {candidate.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button size="sm" variant="secondary" disabled={index === steps.length - 1} onClick={() => go(index + 1)}>
              Next step
            </Button>
            {shuffledBlocks.length > 0 && (
              <span className="w-full text-center text-xs text-slate-500">
                Tasks are shown in protocol order. In a session the tasks of{" "}
                {shuffledBlocks.map((block) => block.title || block.key).join(", ")} are presented in random order.
              </span>
            )}
            {step.usesMicrophone && (
              <span className="w-full text-center text-xs text-slate-500">
                The preview does not use the microphone and records nothing. The control below is shown in its
                starting state.
              </span>
            )}
            <span role="status" className="w-full text-center text-xs font-medium text-slate-900">
              {microphoneNote ? "Preview: the microphone was not opened and nothing was recorded." : ""}
            </span>
          </nav>
        </>
      }
    >
      {/* The key resets the local state of a step (consent boxes, answers) when the step changes. */}
      <div key={step.key}>{step.render(context)}</div>
    </FlowShell>
  );
}
