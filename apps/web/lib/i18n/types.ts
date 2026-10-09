// The shape of one interface language of the participant flow (spec 100).
//
// Every word the participant pages add around the study content is a key here.
// Study content itself (welcome text, information, consent, instructions, task
// prompts, questionnaires, debrief) comes from the protocol through the API and
// is shown as the researchers wrote it. It is never part of a dictionary.
//
// Both languages are typed as `Dictionary`, so TypeScript fails when a key is
// missing in one of them. Placeholders in braces, for example {current}, are
// replaced with `format` from "./index".
import type { PARTICIPANT_ERROR_CODES } from "@dialect/domain";
import type { MicCheckLabels, RecorderErrorLabels, RecordingTaskLabels } from "@/components/participant/recorder/labels";
import type { QuestionnaireFormLabels } from "@/components/questionnaire/labels";

export type ParticipantErrorCode = (typeof PARTICIPANT_ERROR_CODES)[number];

/**
 * Every failure the participant pages can show. The five participant error
 * codes of @dialect/domain (spec 69), the other codes the participant API
 * answers with, a failed network request, and one key for everything else.
 */
export type ErrorMessageKey =
  | ParticipantErrorCode
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "INVALID_AUDIO"
  | "PAYLOAD_TOO_LARGE"
  | "VALIDATION_ERROR"
  | "UNEXPECTED";

export interface Dictionary {
  /** Name of this language in this language, for the language buttons. */
  languageName: string;
  common: {
    continue: string;
    back: string;
    tryAgain: string;
    loading: string;
    /** Accessible name of the language buttons. */
    languageGroupLabel: string;
    /** Added to a link that opens a new browser tab. */
    opensInNewTab: string;
    backToStart: string;
    contactHeading: string;
  };
  modeBanner: {
    test: string;
    demo: string;
  };
  welcome: {
    begin: string;
    /** Button text when this browser has a running session. */
    continueSession: string;
    starting: string;
    resumeNote: string;
    /** Shown when the study takes no new participants and the researchers set no message of their own. */
    studyClosed: string;
    /** /?mode=test: the session that starts is a test session. */
    testEntryNote: string;
    /** /?mode=test, but a session that is not a test session is running in this browser. */
    testEntryBlocked: string;
    /** /?mode=test without a signed-in researcher. */
    testEntryNotAllowed: string;
  };
  information: {
    heading: string;
    continue: string;
  };
  consent: {
    itemsHeading: string;
    /** After the text of a consent item that must be accepted. */
    itemRequired: string;
    /** After the text of a consent item that may be left unchecked. */
    itemOptional: string;
    requiredNote: string;
    agree: string;
    decline: string;
    saving: string;
    privacyNotice: string;
    backToInformation: string;
  };
  micCheck: {
    heading: string;
    saving: string;
    labels: Omit<MicCheckLabels, "errors">;
  };
  instructions: {
    heading: string;
    start: string;
    starting: string;
  };
  task: {
    /** {current} and {total} are task numbers. */
    progress: string;
    /** Quiet line above the task title. Neutral on purpose: it never names the task category. */
    typeLabel: string;
    followupLabel: string;
    /** Label of the main prompt when a follow-up question is shown. */
    earlierPrompt: string;
    contextHeading: string;
    instructionsHeading: string;
    promptHeading: string;
    /** {duration} is one of the duration texts below. */
    suggestedDuration: string;
    durationSeconds: string;
    durationOneMinute: string;
    durationMinutes: string;
    durationMinutesSeconds: string;
    /** The reminder of spec 7.3, shown when the task asks for it. */
    privacyReminder: string;
    topicSuggestionsHeading: string;
    optionalNote: string;
    skip: string;
    skipping: string;
    /** After a page reload a recording that was uploaded but not submitted is gone. */
    discardedAfterReload: string;
    preparing: string;
    prepareFailed: string;
    recording: Omit<RecordingTaskLabels, "errors">;
  };
  /** One text per message key the recorder exports (RECORDER_MESSAGE_KEYS). */
  recorderErrors: RecorderErrorLabels;
  upload: {
    /** The server refused the file itself: recording again is the only fix. */
    invalidAudio: string;
    tooLarge: string;
  };
  questionnaire: {
    submit: string;
    form: QuestionnaireFormLabels;
  };
  /**
   * The English vocabulary test (LexTALE, www.lextale.com) before the review.
   * `instructions` follows the published instructions of the test.
   */
  englishCheck: {
    heading: string;
    /** What the last part of the session is. */
    partIntro: string;
    instructions: string[];
    start: string;
    yes: string;
    no: string;
    /** {current} and {total}. */
    progress: string;
    sending: string;
    skip: string;
  };
  /** The review of the participant's own recordings. Neutral wording: "Version 1" and "Version 2" only. */
  review: {
    heading: string;
    preparingTitle: string;
    preparingBody: string;
    /** {current} and {total}. */
    progress: string;
    ownRecording: string;
    recognizedHeading: string;
    /** "Is this what you said?" with the answers yes, partly and no. */
    said: string;
    saidYes: string;
    saidPartly: string;
    saidNo: string;
    versionsHeading: string;
    /** {slot} */
    version: string;
    /** The meaning question and its five labelled points, 1 to 5. */
    meaning: string;
    meaningScale: [string, string, string, string, string];
    /** The representation question (the primary outcome) and its five labelled points. */
    representation: string;
    representationScale: [string, string, string, string, string];
    cantSay: string;
    answerAll: string;
    next: string;
    sending: string;
    skip: string;
  };
  debrief: {
    heading: string;
    codeLabel: string;
    codeExplanation: string;
    finish: string;
    finishing: string;
  };
  completed: {
    heading: string;
    body: string;
    /** Study laptop mode. */
    laptopNote: string;
    startNext: string;
  };
  withdrawn: {
    heading: string;
    body: string;
    /** The participant chose not to take part on the consent screen. */
    declinedHeading: string;
    declinedBody: string;
  };
  endParticipation: {
    action: string;
    title: string;
    body: string;
    bodySubmitted: string;
    confirm: string;
    cancel: string;
    busy: string;
    failed: string;
  };
  /**
   * Step names for the browser tab title (WCAG 2.4.2), one per screen. The
   * title is "step name | participant-facing study title" (pageTitle in
   * "./index"). These never name the research focus.
   */
  pageTitle: {
    welcome: string;
    information: string;
    consent: string;
    micCheck: string;
    instructions: string;
    /** {current} and {total} are task numbers. */
    task: string;
    questionnaire: string;
    englishCheck: string;
    review: string;
    debrief: string;
    completed: string;
    withdrawn: string;
    loading: string;
    sessionExpired: string;
    error: string;
  };
  errorScreens: {
    sessionExpiredTitle: string;
    studyClosedTitle: string;
    genericTitle: string;
  };
  errors: Record<ErrorMessageKey, string>;
}
