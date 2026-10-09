// Request schemas and response types of the participant API (/api/study/*).
// Shared by the browser and the server (spec 60). This file must stay free of
// server-only imports. The full description is in docs/PARTICIPANT-API.md.
import { z } from "zod";
import {
  CAPTURE_METHODS,
  INPUT_DEVICE_CLASSES,
  QUESTIONNAIRE_KEYS,
  type QuestionnaireKey,
  STUDY_MODES,
  type CaptureQualityClass,
  type InputDeviceClass,
  type QuestionnaireItemType,
  type StudyMode,
  type TaskType,
} from "../enums";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

// The step the browser must render, decided by the server (spec 107).
// The information screen of spec 107 is the first screen of the step "consent":
// the consent state carries the information text and the consent form together.
export const PARTICIPANT_STEPS = [
  "consent",
  "mic_check",
  "instructions",
  "tasks",
  "background",
  "post_recording",
  // The output review part (docs/RESEARCH-DESIGN.md, section 3). It runs only
  // after all speaking tasks and the first questionnaires, and only when the
  // participant accepted the consent item of scope output_review.
  "english_check",
  "output_review",
  "post_review",
  "debrief",
  "completed",
  "withdrawn",
] as const;
export type ParticipantStep = (typeof PARTICIPANT_STEPS)[number];

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const MAX_JSON_CHARACTERS = 4000;

// A small free-form JSON object reported by the browser (constraints, track settings).
const smallJsonObject = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_JSON_CHARACTERS, {
    message: `must be at most ${MAX_JSON_CHARACTERS} characters as JSON`,
  });

// ---------------------------------------------------------------------------
// Device identifiers and the device label (privacy, spec 6.2, 6.3, 65)
// ---------------------------------------------------------------------------

// Keys of MediaTrackSettings, MediaTrackConstraints and MediaTrackCapabilities
// that identify one device or one group of devices of a person's computer.
// They are removed in the browser before anything is sent, and again on the server.
export const DEVICE_IDENTIFIER_KEYS = ["deviceId", "groupId"] as const;

// A copy of the object without the device identifier keys (top level only: the
// browser dictionaries are flat).
export function stripDeviceIdentifiers<T extends Record<string, unknown>>(value: T): T {
  const copy: Record<string, unknown> = { ...value };
  for (const key of DEVICE_IDENTIFIER_KEYS) delete copy[key];
  return copy as T;
}

// Keyword rule that turns a device label into a coarse class. The label is
// lower-cased first and the first rule that matches wins, in this order:
//   bluetooth  "bluetooth", "wireless", "hands-free", "airpods", "buds"
//   headset    "headset", "headphone", "earphone", "earbud", "kuuloke"
//   usb        "usb", "audio interface", or a USB vendor and product id such
//              as "(046d:0825)", which Chrome appends to the label of a USB device
//   built_in   "built-in", "internal", "integrated", "microphone array",
//              "macbook", "iphone", "ipad", "sisäinen"
//   unknown    anything else, and an empty label
// The rule is deliberately short: a label it does not recognize is "unknown",
// never a guess. Only the class leaves the browser.
const DEVICE_CLASS_RULES: ReadonlyArray<readonly [InputDeviceClass, RegExp]> = [
  ["bluetooth", /bluetooth|wireless|hands-?free|airpods|\bbuds\b/],
  ["headset", /headset|headphone|earphone|earbud|kuuloke/],
  ["usb", /\busb\b|audio interface|\([0-9a-f]{4}:[0-9a-f]{4}\)/],
  ["built_in", /built-?in|internal|integrated|microphone array|macbook|iphone|ipad|sis[aä]inen/],
];

export function classifyInputDevice(label: string | null | undefined): InputDeviceClass {
  const text = (label ?? "").trim().toLowerCase();
  if (text === "") return "unknown";
  for (const [deviceClass, pattern] of DEVICE_CLASS_RULES) {
    if (pattern.test(text)) return deviceClass;
  }
  return "unknown";
}

// What the server stores in the field `deviceLabel`: always one of the classes.
// A value that is already a class is kept. Any other text (a raw label from an
// older page) is classified and the text is dropped.
export function toInputDeviceClass(value: string | null | undefined): InputDeviceClass {
  const text = (value ?? "").trim();
  if ((INPUT_DEVICE_CLASSES as readonly string[]).includes(text)) return text as InputDeviceClass;
  return classifyInputDevice(text);
}

// Typed as a string so the field stays compatible with the stored JSON types.
const deviceClassField = z
  .string()
  .max(200)
  .transform((value): string => toInputDeviceClass(value));
const trackSettingsObject = smallJsonObject.transform(stripDeviceIdentifiers);

export const browserInfoSchema = z
  .object({
    userAgent: z.string().max(500).optional(),
    platform: z.string().max(100).optional(),
    language: z.string().max(35).optional(),
    browserName: z.string().max(100).optional(),
    browserVersion: z.string().max(50).optional(),
    os: z.string().max(100).optional(),
  })
  .strict();
export type BrowserInfoInput = z.infer<typeof browserInfoSchema>;

// One capture setting that the browser did not confirm (the recorder's
// ConstraintMismatch). "requested" and "actual" are small JSON values.
export const CONSTRAINT_MISMATCH_KINDS = ["not_honored", "not_reported", "context_rate_differs"] as const;
const constraintMismatchesSchema = z
  .array(
    z
      .object({
        constraint: z.string().min(1).max(100),
        kind: z.enum(CONSTRAINT_MISMATCH_KINDS),
        requested: z.unknown().optional(),
        actual: z.unknown().optional(),
      })
      .strict(),
  )
  .max(20)
  .refine((value) => JSON.stringify(value).length <= MAX_JSON_CHARACTERS, {
    message: `must be at most ${MAX_JSON_CHARACTERS} characters as JSON`,
  });

// Why the lossless recorder was not used (the recorder's RecorderFallbackInfo).
export const RECORDER_FALLBACK_REASONS = ["audio_worklet_unavailable", "audio_worklet_failed"] as const;

// Non-content technical settings of the microphone check (spec 6.3). No audio.
export const audioEnvironmentSchema = z
  .object({
    // The class of the input device (INPUT_DEVICE_CLASSES), never the raw label.
    deviceLabel: deviceClassField.optional(),
    requestedConstraints: trackSettingsObject.optional(),
    actualTrackSettings: trackSettingsObject.optional(),
    audioContextSampleRate: z.number().positive().max(768000).optional(),
    captureMethod: z.enum(CAPTURE_METHODS).optional(),
    // Requested capture settings that the browser did not confirm.
    constraintMismatches: constraintMismatchesSchema.optional(),
    // Set when the compressed recorder was used although lossless capture was preferred.
    fallbackReason: z.enum(RECORDER_FALLBACK_REASONS).optional(),
    fallbackDetail: z.string().max(500).optional(),
  })
  .strict();
export type AudioEnvironmentInput = z.infer<typeof audioEnvironmentSchema>;

export const localeSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "must be a language tag such as fi or en");

// POST /api/study/sessions
export const createSessionBodySchema = z
  .object({
    // "test" and "demo" are honored only for a signed-in admin (demo also when the
    // study setting demoPublic is true). Default: "research".
    mode: z.enum(STUDY_MODES).optional(),
    locale: localeSchema.optional(),
    browserInfo: browserInfoSchema.optional(),
    // Study laptop "Start next participant": ignore and clear an existing cookie.
    restart: z.boolean().optional(),
  })
  .strict();
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;

// POST /api/study/session/locale: the participant switched the language.
export const setLocaleBodySchema = z.object({ locale: localeSchema }).strict();
export type SetLocaleBody = z.infer<typeof setLocaleBodySchema>;

// POST /api/study/consent
export const consentBodySchema = z
  .object({
    responses: z
      .array(z.object({ itemId: z.string().min(1).max(200), accepted: z.boolean() }).strict())
      .max(100),
  })
  .strict();
export type ConsentBody = z.infer<typeof consentBodySchema>;

// POST /api/study/mic-check
export const micCheckBodySchema = z
  .object({
    audioEnvironment: audioEnvironmentSchema.optional(),
    browserInfo: browserInfoSchema.optional(),
  })
  .strict();
export type MicCheckBody = z.infer<typeof micCheckBodySchema>;

// POST /api/study/utterances
export const createUtteranceBodySchema = z
  .object({
    presentationId: z.uuid(),
    turnIndex: z.number().int().min(0).max(1000),
  })
  .strict();
export type CreateUtteranceBody = z.infer<typeof createUtteranceBodySchema>;

// The JSON part "metadata" of POST /api/study/utterances/:id/audio.
// Everything here is what the browser reports. The server stores it as declared
// metadata and takes container, codec, sample rate, channels and duration from
// its own analysis of the bytes (spec 63).
export const captureMetadataSchema = z
  .object({
    captureMethod: z.enum(CAPTURE_METHODS).optional(),
    requestedConstraints: trackSettingsObject.optional(),
    actualTrackSettings: trackSettingsObject.optional(),
    audioContextSampleRate: z.number().positive().max(768000).optional(),
    userAgent: z.string().max(500).optional(),
    declaredDurationMs: z.number().min(0).max(86_400_000).optional(),
    declaredSampleRateHz: z.number().positive().max(768000).optional(),
    declaredChannels: z.number().int().positive().max(64).optional(),
    // Bit depth of the PCM samples as the recorder wrote them (16 or 24).
    declaredBitDepth: z.number().int().min(8).max(64).optional(),
    // The class of the input device (INPUT_DEVICE_CLASSES), never the raw label.
    deviceLabel: deviceClassField.optional(),
    constraintMismatches: constraintMismatchesSchema.optional(),
    fallbackReason: z.enum(RECORDER_FALLBACK_REASONS).optional(),
    fallbackDetail: z.string().max(500).optional(),
    // Number of channels the capture node received. Above 1 means channel 0 was kept.
    inputChannelCount: z.number().int().positive().max(64).optional(),
    // Samples at or beyond full scale, which the recorder limited to full scale.
    clippedSampleCount: z.number().int().min(0).max(1_000_000_000_000).optional(),
    // Largest absolute sample value before conversion. Above 1 when the input clipped.
    peak: z.number().min(0).max(1000).optional(),
    // "user": the participant pressed Stop. "max_duration": the recorder stopped at the limit.
    stoppedBy: z.enum(["user", "max_duration"]).optional(),
  })
  .strict();
export type CaptureMetadata = z.infer<typeof captureMetadataSchema>;

// POST /api/study/utterances/:id/submit
export const submitUtteranceBodySchema = z
  .object({
    mediaAssetId: z.uuid(),
    // Number of recordings the participant made for this turn, including the
    // accepted one (spec 10). Values below 1 are stored as 1.
    attemptCount: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export type SubmitUtteranceBody = z.infer<typeof submitUtteranceBodySchema>;

export const questionnaireKeySchema = z.enum(QUESTIONNAIRE_KEYS);

// POST /api/study/questionnaires/:key
// Answers are keyed by the item key. The value type depends on the item type:
// likert and integer: number, single_choice, short_text and free_text: string,
// multi_choice: array of strings, boolean: boolean. Leave an unanswered optional
// item out (null, "" and [] also count as not answered).
export const questionnaireBodySchema = z
  .object({
    answers: z
      .record(z.string().max(200), z.unknown())
      .refine((value) => Object.keys(value).length <= 500, { message: "too many answers" }),
  })
  .strict();
export type QuestionnaireBody = z.infer<typeof questionnaireBodySchema>;

export const idParamSchema = z.object({ id: z.uuid() });
export const presentationParamSchema = z.object({ presentationId: z.uuid() });
export const questionnaireParamSchema = z.object({ key: questionnaireKeySchema });

// POST /api/study/english-check
// One "yes" (true) or "no" (false) per item, in the order of the state's items.
export const englishCheckBodySchema = z
  .object({ answers: z.array(z.boolean()).min(1).max(200) })
  .strict();
export type EnglishCheckBody = z.infer<typeof englishCheckBodySchema>;

// A fully labelled 5-point rating, or the explicit answer "I can't say".
export const reviewRatingSchema = z.union([z.number().int().min(1).max(5), z.literal("cant_judge")]);
export type ReviewRating = z.infer<typeof reviewRatingSchema>;

// The two questions under each English version (scale version output-review-v2).
export const reviewVersionRatingsSchema = z
  .object({
    // "How well does the English say what you meant?"
    // 1 not at all, 2 a little, 3 partly, 4 mostly, 5 completely.
    meaning: reviewRatingSchema,
    // "How much of the way you said it (your tone, how casual you were, your own
    // expressions) comes through in the English?" The primary outcome.
    // 1 none of it, 2 a little, 3 some, 4 most, 5 all of it.
    representation: reviewRatingSchema,
  })
  .strict();
export type ReviewVersionRatings = z.infer<typeof reviewVersionRatingsSchema>;

// "Is this what you said?" about the speech recognition text.
export const REVIEW_SAID_ANSWERS = ["yes", "partly", "no"] as const;
export type ReviewSaidAnswer = (typeof REVIEW_SAID_ANSWERS)[number];

// POST /api/study/output-review/items/:id/answer
// One screen per recording: the answer about the Finnish text and the two
// questions about each English version. Every part is required; "can't say"
// counts as an answer.
export const outputReviewAnswerBodySchema = z
  .object({
    source: z.object({ said: z.enum(REVIEW_SAID_ANSWERS) }).strict(),
    versions: z.object({ "1": reviewVersionRatingsSchema, "2": reviewVersionRatingsSchema }).strict(),
  })
  .strict();
export type OutputReviewAnswerBody = z.infer<typeof outputReviewAnswerBodySchema>;

export const outputReviewItemParamSchema = z.object({ id: z.uuid() });
// GET /api/study/output-review/items/:id/audio/:which
// Only the participant's own recording is offered (scale version output-review-v2).
export const OUTPUT_REVIEW_AUDIO_SOURCES = ["source"] as const;
export const outputReviewAudioParamSchema = z.object({
  id: z.uuid(),
  which: z.enum(OUTPUT_REVIEW_AUDIO_SOURCES),
});

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export type StudyClosedReason =
  | "study_paused"
  | "study_closed"
  | "new_sessions_disabled"
  | "maintenance"
  | "no_protocol"
  // The current protocol still contains example text (seed placeholders).
  | "example_text_present";

// GET /api/study/info
export type StudyInfoResponse = {
  studyName: string;
  acceptingNewSessions: boolean;
  closedReason: StudyClosedReason | null;
  // The maintenance message set by the researchers, when in maintenance mode.
  closedMessage: string | null;
  // Welcome text of the current published protocol. Null when there is none.
  welcomeContent: string | null;
  // The title and the welcome text per participant locale, for the language
  // buttons of the welcome page (a text without a translation is the base text).
  studyNameByLocale: Record<string, string>;
  welcomeContentByLocale: Record<string, string | null>;
  locales: string[];
  defaultLocale: string;
  studyLaptopMode: boolean;
};

export type ParticipantSettings = {
  maxUtteranceSeconds: number;
  maxUploadMb: number;
  studyLaptopMode: boolean;
};

export type ParticipantProgress = {
  // 1-based position of the current task in the session's stored sequence.
  taskNumber: number;
  totalTasks: number;
};

export type ConsentItemContent = { id: string; text: string; required: boolean };

export type ConsentContent = {
  consentVersionId: string;
  versionNumber: number;
  title: string;
  informationText: string;
  items: ConsentItemContent[];
  privacyNoticeUrl: string | null;
  contactText: string | null;
};

export type CurrentTurn = {
  turnIndex: number;
  totalTurns: number;
  promptText: string;
  isFollowup: boolean;
  // True when the participant may skip this turn with POST /api/study/utterances/:id/skip.
  isOptional: boolean;
  // Set once POST /api/study/utterances has created the row for this turn.
  utteranceId: string | null;
  // An uploaded recording that has not been submitted yet. After a page reload the
  // browser no longer holds the recording, so it should discard this candidate.
  candidate: { mediaAssetId: string; durationMs: number | null } | null;
};

export type CurrentTask = {
  presentationId: string;
  status: "pending" | "started";
  title: string;
  prompt: string;
  context: string | null;
  instructions: string | null;
  taskType: TaskType;
  minDurationSeconds: number | null;
  suggestedDurationSeconds: number | null;
  // The limit that applies to this task: the task's own limit, capped by the study limit.
  maxDurationSeconds: number;
  privacyReminder: boolean;
  topicSuggestions: string[];
  turn: CurrentTurn;
};

export type QuestionnaireItemContent = {
  itemKey: string;
  type: QuestionnaireItemType;
  prompt: string;
  helpText: string | null;
  required: boolean;
  config: {
    options?: Array<{ value: string; label: string }>;
    scaleMin?: number;
    scaleMax?: number;
    scaleMinLabel?: string;
    scaleMaxLabel?: string;
    min?: number;
    max?: number;
    maxLength?: number;
    placeholder?: string;
  };
};

export type QuestionnaireContent = {
  key: QuestionnaireKey;
  questionnaireVersionId: string;
  versionNumber: number;
  name: string;
  description: string | null;
  items: QuestionnaireItemContent[];
};

export type DebriefContent = {
  content: string;
  contactText: string | null;
};

// The English vocabulary test (LexTALE). Only the letter strings are sent: whether
// a string is a word is never sent to the browser, the server scores the answers.
export type EnglishCheckContent = {
  version: string;
  items: Array<{ index: number; text: string }>;
};

// What the participant sees on one review screen: one of their own recordings.
// Labels are neutral: the two English versions are "Version 1" and "Version 2",
// and nothing names the translation condition, the model or the prompt.
export type OutputReviewItemContent = {
  id: string;
  // The speech recognition text of the participant's own recording.
  sourceText: string;
  versions: Array<{ slot: 1 | 2; text: string }>;
  // Whether the participant's own recording can be played, through
  // GET /api/study/output-review/items/:id/audio/source.
  audio: { source: boolean };
};

export type OutputReviewContent =
  // Not every recording has been processed yet. The browser waits and asks again
  // with POST /api/study/output-review/start.
  | { status: "preparing"; waitedSeconds: number; maxWaitSeconds: number }
  | { status: "ready"; itemNumber: number; totalItems: number; item: OutputReviewItemContent };

export type ParticipantStateBase = {
  participantCode: string;
  mode: StudyMode;
  locale: string | null;
  studyName: string;
  // Set only at the step "tasks".
  progress: ParticipantProgress | null;
  settings: ParticipantSettings;
};

// What the browser needs for the current step, and nothing else. During speech
// collection it never contains AI output (transcripts, translations, synthesized
// audio), and at no step does it contain model names, processing conditions or
// any dialect classification (spec 3.1, 83). The one exception is the step
// "output_review", after all speaking tasks: it shows the participant the AI
// output of their own recordings (docs/IMPLEMENTATION-STATUS.md, "Deviations").
export type ParticipantState = ParticipantStateBase &
  (
    | { step: "consent"; information: { content: string }; consent: ConsentContent }
    | { step: "mic_check" }
    | { step: "instructions"; instructions: { content: string } }
    | { step: "tasks"; task: CurrentTask }
    | { step: "background"; questionnaire: QuestionnaireContent }
    | { step: "post_recording"; questionnaire: QuestionnaireContent }
    | { step: "english_check"; englishCheck: EnglishCheckContent }
    | { step: "output_review"; review: OutputReviewContent }
    | { step: "post_review"; questionnaire: QuestionnaireContent }
    | { step: "debrief"; debrief: DebriefContent }
    | { step: "completed" }
    | { step: "withdrawn"; debrief: DebriefContent }
  );

// Most state-changing endpoints answer with the new state.
export type StateResponse = { state: ParticipantState };

// GET /api/study/session and GET /api/study/next-task: null when there is no
// usable session (no cookie, unknown or expired token, abandoned session).
export type SessionResponse = { state: ParticipantState | null };

// GET /api/study/next-task
export type NextTaskResponse = {
  step: ParticipantStep;
  progress: ParticipantProgress | null;
  // Null when the session is not at the step "tasks".
  task: CurrentTask | null;
};

// POST /api/study/sessions
export type CreateSessionResponse = { state: ParticipantState; resumed: boolean };

// POST /api/study/utterances
export type CreateUtteranceResponse = { utteranceId: string; state: ParticipantState };

// POST /api/study/utterances/:id/audio
export type UploadAudioResponse = {
  mediaAssetId: string;
  sha256: string;
  durationMs: number;
  sizeBytes: number;
  captureQualityClass: CaptureQualityClass;
};
