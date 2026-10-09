// Request schemas and response types for corpus inspection in the admin:
// Dashboard, Sessions, Session Detail, media, flags, exclusion, notes, audit
// history and Settings (spec 42 to 45, 59, 60, 70, 71, 84, 88, 109, 116).
// Shared by the browser and the server. Every timestamp in a response is an
// ISO 8601 string in UTC.
import { z } from "zod";
import { translationLocaleSchema } from "../localization";
import {
  FLAG_REASON_CODES,
  OUTPUT_STATUSES,
  STUDY_MODES,
  STUDY_STATUSES,
  type BatchStatus,
  type InputDeviceClass,
  type JobStatus,
  type MediaKind,
  type ModelRunStage,
  type ModelRunStatus,
  type OutputStatus,
  type PresentationStatus,
  type QuestionnaireItemType,
  type ReviewStatus,
  type RevisionAuthorType,
  type SessionStatus,
  type StudyMode,
  type StudyStatus,
  type TaskType,
  type TranscriptType,
  type UtteranceStatus,
} from "../enums";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_LIST_DEFAULT_PAGE_SIZE = 50;
export const SESSION_LIST_MAX_PAGE_SIZE = 200;
export const AUDIT_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 200;

export const MAX_REASON_LENGTH = 1000;
export const MAX_NOTE_LENGTH = 5000;
export const MAX_MAINTENANCE_MESSAGE_LENGTH = 1000;

// Typed confirmation phrases for highly destructive actions (spec 38, 116).
export const TEST_DATA_RESET_PHRASE = "DELETE TEST AND DEMO DATA";
export const MEDIA_DELETE_PHRASE = "DELETE RECORDING";

// A recording shorter than this gets the informational chip "too short" when
// the task has no minimum duration of its own (spec 84). Nothing is excluded.
export const SHORT_AUDIO_THRESHOLD_MS = 1000;

export const SESSION_SORT_KEYS = [
  "started_at",
  "completed_at",
  "participant_code",
  "status",
  "utterance_count",
  "audio_duration",
] as const;
export type SessionSortKey = (typeof SESSION_SORT_KEYS)[number];

// Entities that accept a researcher note through the corpus services (spec 88).
export const NOTE_ENTITY_TYPES = ["session", "utterance", "translation", "synthesis"] as const;
export type NoteEntityType = (typeof NOTE_ENTITY_TYPES)[number];

// Derived outputs whose status a researcher may change.
export const OUTPUT_ENTITY_TYPES = ["translation", "synthesis"] as const;
export type OutputEntityType = (typeof OUTPUT_ENTITY_TYPES)[number];

export const RESETTABLE_MODES = ["demo", "test"] as const;
export type ResettableMode = (typeof RESETTABLE_MODES)[number];

// Informational quality indicators of one utterance (spec 84). They never
// exclude anything.
export const QUALITY_INDICATORS = [
  "missing_audio",
  "too_short",
  "possible_clipping",
  "low_signal",
  "mostly_silent",
  "compressed_fallback",
  "asr_failed",
  "missing_b",
  "missing_c",
  "unverified_b",
  "unverified_c",
] as const;
export type QualityIndicator = (typeof QUALITY_INDICATORS)[number];

export const QUALITY_INDICATOR_LABELS: Record<QualityIndicator, string> = {
  missing_audio: "Missing audio",
  too_short: "Too short",
  possible_clipping: "Possible clipping",
  low_signal: "Low signal",
  mostly_silent: "Mostly silent",
  compressed_fallback: "Compressed capture",
  asr_failed: "ASR failed",
  missing_b: "No B transcript",
  missing_c: "No C transcript",
  unverified_b: "B not verified",
  unverified_c: "C not verified",
};

export const COMPLETENESS_KEYS = [
  "source_audio_complete",
  "background_complete",
  "post_questionnaire_complete",
  "required_transcripts_complete",
  "processing_complete",
] as const;
export type CompletenessKey = (typeof COMPLETENESS_KEYS)[number];

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Query strings carry booleans as text.
const booleanText = z.enum(["true", "false"]).transform((value) => value === "true");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in the form YYYY-MM-DD");
const page = z.coerce.number().int().min(1).default(1);
const optionalNotes = z
  .string()
  .trim()
  .max(MAX_NOTE_LENGTH)
  .transform((value) => (value === "" ? null : value))
  .nullish();
const reason = z.string().trim().min(1, "a reason is required").max(MAX_REASON_LENGTH);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const sessionListQuerySchema = z.object({
  page,
  pageSize: z.coerce.number().int().min(1).max(SESSION_LIST_MAX_PAGE_SIZE).default(SESSION_LIST_DEFAULT_PAGE_SIZE),
  sort: z.enum(SESSION_SORT_KEYS).default("started_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  // Participant code (any part) or session UUID (beginning).
  search: z.string().trim().max(100).optional(),
  // Calendar dates in the admin time zone, both inclusive.
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  protocolVersionId: z.uuid().optional(),
  mode: z.enum(STUDY_MODES).optional(),
  completion: z.enum(["completed", "incomplete"]).optional(),
  flagged: booleanText.optional(),
  hasProcessingErrors: booleanText.optional(),
  review: z.enum(["complete", "incomplete"]).optional(),
  excluded: booleanText.optional(),
});
export type SessionListQuery = z.output<typeof sessionListQuerySchema>;
export type SessionListFilters = Omit<SessionListQuery, "page" | "pageSize" | "sort" | "direction">;
export type SessionListPagination = Partial<Pick<SessionListQuery, "page" | "pageSize" | "sort" | "direction">>;

export const flagBodySchema = z.object({
  flagged: z.boolean(),
  notes: optionalNotes,
  reasonCode: z.enum(FLAG_REASON_CODES).optional(),
});
export type FlagBody = z.output<typeof flagBodySchema>;

export const excludeBodySchema = z.object({ reason });
export type ExcludeBody = z.output<typeof excludeBodySchema>;

export const noteBodySchema = z.object({ body: z.string().trim().min(1, "the note is empty").max(MAX_NOTE_LENGTH) });
export type NoteBody = z.output<typeof noteBodySchema>;

export const outputStatusBodySchema = z.object({
  status: z.enum(OUTPUT_STATUSES),
  reasonCode: z.enum(FLAG_REASON_CODES).optional(),
  notes: optionalNotes,
});
export type OutputStatusBody = z.output<typeof outputStatusBodySchema>;

export const outputKindParamSchema = z.enum(["translations", "syntheses"]);
export function outputEntityTypeFromKind(kind: z.output<typeof outputKindParamSchema>): OutputEntityType {
  return kind === "translations" ? "translation" : "synthesis";
}

export const mediaDeleteBodySchema = z.object({
  reason,
  confirmationPhrase: z.string().optional(),
});
export type MediaDeleteBody = z.output<typeof mediaDeleteBodySchema>;

export const auditQuerySchema = z.object({
  page,
  pageSize: z.coerce.number().int().min(1).max(AUDIT_MAX_PAGE_SIZE).default(AUDIT_DEFAULT_PAGE_SIZE),
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.uuid().optional(),
  action: z.string().trim().min(1).max(60).optional(),
});
export type AuditQuery = z.output<typeof auditQuerySchema>;

const versionText = z.string().trim().min(1).max(50);

// The languages the participant interface has dictionaries for
// (apps/web/lib/i18n). A study can only offer these. A test in the web app
// compares this list with the dictionaries, so the two cannot drift apart.
export const INTERFACE_LOCALES = ["en", "fi"] as const;
export type InterfaceLocale = (typeof INTERFACE_LOCALES)[number];

// A short BCP 47 style language tag: a language subtag of two or three letters,
// optionally followed by further subtags, for example "fi", "en" or "en-GB".
export const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const languageTag = z
  .string()
  .trim()
  .regex(LANGUAGE_TAG_PATTERN, 'must be a short language tag such as "fi", "en" or "en-GB"');

export const MAX_STUDY_NAME_LENGTH = 200;
export const MAX_PARTICIPANT_TITLE_LENGTH = 120;
export const DEFAULT_DEMO_DAILY_RUN_LIMIT = 200;

export const OUTPUT_REVIEW_MAX_ITEMS_LIMIT = 20;

// Every field is optional: only the fields that are sent change. Unknown
// fields are rejected, so a typing mistake cannot be stored silently.
export const settingsUpdateSchema = z
  .strictObject({
    status: z.enum(STUDY_STATUSES),
    allowNewSessions: z.boolean(),
    maintenanceMode: z.boolean(),
    maintenanceMessage: z
      .string()
      .trim()
      .max(MAX_MAINTENANCE_MESSAGE_LENGTH)
      .transform((value) => (value === "" ? null : value))
      .nullable(),
    maxUploadMb: z.number().int().min(1).max(2000),
    maxUtteranceSeconds: z.number().int().min(5).max(3600),
    sessionInactivityTimeoutMinutes: z.number().int().min(5).max(10080),
    studyLaptopMode: z.boolean(),
    autoQueueAsr: z.boolean(),
    demoPersist: z.boolean(),
    demoPublic: z.boolean(),
    adminTimezone: z.string().trim().refine(isValidTimeZone, "must be an IANA time zone such as Europe/Helsinki"),
    transcriptionConventionVersion: versionText,
    annotationSchemeVersion: versionText,
    // The internal study name (studies.name). Researchers only.
    studyName: z.string().trim().min(1).max(MAX_STUDY_NAME_LENGTH),
    // The title participants see. Empty or null removes it, and participants
    // then see a neutral standard title, never the internal name.
    participantTitle: z
      .string()
      .trim()
      .max(MAX_PARTICIPANT_TITLE_LENGTH)
      .transform((value) => (value === "" ? null : value))
      .nullable(),
    // The participant-facing title in other languages, keyed by locale. An empty
    // title is dropped: participants of that language then see the base title.
    participantTitleTranslations: z
      .record(translationLocaleSchema, z.string().trim().max(MAX_PARTICIPANT_TITLE_LENGTH))
      .transform((value) => Object.fromEntries(Object.entries(value).filter(([, title]) => title !== ""))),
    // The language participants speak and the language of the translations.
    sourceLanguage: languageTag,
    targetLanguage: languageTag,
    // Interface languages offered to participants, in the order shown.
    participantLocales: z
      .array(z.enum(INTERFACE_LOCALES))
      .min(1)
      .max(INTERFACE_LOCALES.length)
      .refine((value) => new Set(value).size === value.length, "a language is listed twice"),
    defaultLocale: z.enum(INTERFACE_LOCALES),
    // Demo Mode: the largest number of demo pipeline runs per day.
    demoDailyRunLimit: z.number().int().min(1).max(100000),
    // The output review at the end of a session (docs/RESEARCH-DESIGN.md, section 3).
    outputReviewEnabled: z.boolean(),
    outputReviewMaxItems: z.number().int().min(1).max(OUTPUT_REVIEW_MAX_ITEMS_LIMIT),
    englishCheckEnabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "no setting was given");
export type SettingsUpdate = z.output<typeof settingsUpdateSchema>;

export const resetTestDataBodySchema = z.object({
  modes: z.array(z.enum(RESETTABLE_MODES)).min(1).max(2),
  confirmationPhrase: z.string(),
});
export type ResetTestDataBody = z.output<typeof resetTestDataBodySchema>;

// ---------------------------------------------------------------------------
// Dashboard (spec 42). Operational health only: no comparison of conditions.
// ---------------------------------------------------------------------------

export type ModeCounts = { sessions: number; completed: number; utterances: number };

export type ActiveConfigSummary = {
  id: string;
  key: string;
  stage: string;
  conditionKey: string | null;
  versionNumber: number;
  provider: string;
  modelId: string;
  promptKey: string | null;
  promptVersionNumber: number | null;
};

export type DashboardRecentSession = {
  id: string;
  participantCode: string;
  mode: StudyMode;
  completedAt: string;
  utteranceCount: number;
};

export type DashboardRecentError = {
  kind: "model_run" | "job";
  id: string;
  // Stage for a model run, job type for a job.
  label: string;
  errorCode: string | null;
  message: string | null;
  at: string;
  batchName: string | null;
};

export type DashboardRecentVerification = {
  revisionId: string;
  transcriptType: TranscriptType;
  utteranceId: string;
  sessionId: string;
  participantCode: string;
  mode: StudyMode;
  verifiedAt: string;
  verifiedByLabel: string | null;
};

export type DashboardRecentBatch = {
  id: string;
  name: string;
  status: BatchStatus;
  dataMode: StudyMode;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type Dashboard = {
  generatedAt: string;
  adminTimezone: string;
  study: {
    id: string;
    name: string;
    status: StudyStatus;
    allowNewSessions: boolean;
    maintenanceMode: boolean;
    // True when a new participant can start now.
    acceptingNewSessions: boolean;
  };
  // Research mode only. Demo and test sessions are in otherModes.
  participants: {
    started: number;
    consented: number;
    completed: number;
    abandoned: number;
    withdrawn: number;
    inProgress: number;
    // completed / started, null when nobody has started.
    completionRate: number | null;
  };
  sessionsToday: number;
  utterancesSubmitted: number;
  sourceAudioDurationMs: number;
  awaitingTranscriptionReview: number;
  processingErrors: { failedJobs: number; failedModelRuns: number; total: number };
  flagged: { sessions: number; utterances: number };
  excluded: { sessions: number; utterances: number };
  otherModes: { demo: ModeCounts; test: ModeCounts };
  status: {
    protocol: { id: string; versionNumber: number; name: string; publishedAt: string | null } | null;
    configs: { asr: ActiveConfigSummary[]; translation: ActiveConfigSummary[]; tts: ActiveConfigSummary[] };
    worker: { healthy: boolean; workerCount: number; lastSeenAt: string | null };
    queue: { queued: number; running: number; failed: number };
    storage: { ok: boolean; driver: string };
    database: { ok: boolean };
    // Example text from the development seed that is still in the current
    // protocol. Research sessions stay closed while it is present.
    exampleText: { present: boolean; fields: string[]; message: string | null };
  };
  recent: {
    completedSessions: DashboardRecentSession[];
    processingErrors: DashboardRecentError[];
    transcriptVerifications: DashboardRecentVerification[];
    batches: DashboardRecentBatch[];
  };
  // Oldest day first. Dates are calendar days in the admin time zone.
  sessionsPerDay: Array<{ date: string; research: number; demo: number; test: number }>;
};

// ---------------------------------------------------------------------------
// Sessions list (spec 43)
// ---------------------------------------------------------------------------

export type SessionListItem = {
  id: string;
  participantCode: string;
  startedAt: string;
  completedAt: string | null;
  protocolVersionId: string;
  protocolVersionNumber: number;
  mode: StudyMode;
  status: SessionStatus;
  tasksCompleted: number;
  tasksTotal: number;
  // Utterances with an accepted recording that are not excluded.
  utteranceCount: number;
  audioDurationMs: number;
  review: { verifiedB: number; verifiedC: number; complete: boolean };
  flagged: boolean;
  flaggedUtterances: number;
  excluded: boolean;
  excludedUtterances: number;
  processingErrors: number;
};

export type SessionListResult = {
  items: SessionListItem[];
  total: number;
  page: number;
  pageSize: number;
  sort: SessionSortKey;
  direction: "asc" | "desc";
  adminTimezone: string;
  // For the protocol filter.
  protocolVersions: Array<{ id: string; versionNumber: number; name: string }>;
};

// ---------------------------------------------------------------------------
// Session detail (spec 44, 45, 109, 140, 158, 169)
// ---------------------------------------------------------------------------

// What a failed model run kept from the provider (spec 146). A translation that
// was refused, cut off or empty is not stored as a translation: its text is
// here, exactly as the model returned it. A value is null when the provider
// did not report it.
export type ModelRunFailureDetail = {
  // HTTP status of the provider response.
  providerStatus: number | null;
  providerErrorCode: string | null;
  // Whether the queue tries the work again by itself.
  retryable: boolean | null;
  responseId: string | null;
  // Status the provider gave the response, for example "incomplete".
  responseStatus: string | null;
  refusal: string | null;
  // Partial, cut-off or empty output text. An empty string is a real value.
  outputText: string | null;
};

export type ModelRunSummary = {
  id: string;
  stage: ModelRunStage;
  status: ModelRunStatus;
  provider: string;
  requestedModel: string;
  returnedModel: string | null;
  conditionKey: string | null;
  modelConfig: { id: string; key: string; versionNumber: number } | null;
  prompt: { id: string; key: string; versionNumber: number } | null;
  processingBatchId: string | null;
  parameters: Record<string, unknown>;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  latencyMs: number | null;
  providerRequestId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  // Only for a failed run. For a failed run `parameters` holds the request as
  // it was sent, or as it was planned when the provider was never reached.
  failure?: ModelRunFailureDetail | null;
  appVersion: string;
  gitCommitSha: string | null;
};

// What the browser recorder declared about one recording (spec 31.1, 32, 84),
// read from media_assets.metadata_json. These are declared facts: the technical
// truth of the file (sample rate, channels, duration) comes from the server's
// own analysis and is in MediaAssetView. A value is null when the browser did
// not send it.
export type CaptureConstraintMismatch = {
  // The requested capture setting, for example "echoCancellation".
  constraint: string;
  // "not_honored", "not_reported" or "context_rate_differs".
  kind: string;
  // The requested and the actual value as short JSON text. Null when not sent.
  requested: string | null;
  actual: string | null;
};

export type CaptureDetailsView = {
  // Requested capture settings that the browser did not confirm. They matter
  // for acoustic analysis: for example echo cancellation that stayed on.
  constraintMismatches: CaptureConstraintMismatch[];
  // Coarse class of the input device (INPUT_DEVICE_CLASSES). The raw device
  // name the browser reports is never returned: it can identify a person or a
  // machine. Null when the recording declared nothing about the device.
  deviceClass: InputDeviceClass | null;
  // Set when the compressed recorder was used although lossless capture was preferred.
  fallbackReason: string | null;
  fallbackDetail: string | null;
  // Channels the capture node received. Above 1 means channel 0 was kept.
  inputChannelCount: number | null;
  // Samples at or beyond full scale, which the recorder limited to full scale.
  clippedSampleCount: number | null;
  // Largest absolute sample value before conversion. Above 1 when the input clipped.
  peak: number | null;
  declaredBitDepth: number | null;
  // "user": the participant pressed Stop. "max_duration": the recorder stopped at the limit.
  stoppedBy: string | null;
};

export type MediaAssetView = {
  id: string;
  kind: MediaKind;
  mimeType: string;
  container: string | null;
  codec: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  bitDepth: number | null;
  durationMs: number | null;
  sizeBytes: number;
  sha256: string;
  captureMethod: string | null;
  captureQualityClass: string | null;
  // For example "48 kHz, mono, PCM 16-bit".
  captureSummary: string;
  derivedFromMediaAssetId: string | null;
  createdAt: string;
  deletedAt: string | null;
  deletionReason: string | null;
};

export type TranscriptCellView = {
  type: TranscriptType;
  // A, A*, B or C.
  label: string;
  transcriptId: string | null;
  status: ReviewStatus;
  revisionCount: number;
  current: {
    id: string;
    revisionNumber: number;
    text: string;
    createdByType: RevisionAuthorType;
    createdByLabel: string | null;
    createdAt: string;
    verifiedAt: string | null;
    verifiedByLabel: string | null;
    transcriptionConventionVersion: string | null;
    // The ASR run that produced the text (A only).
    modelRun: ModelRunSummary | null;
  } | null;
};

export type SynthesisView = {
  id: string;
  conditionKey: string;
  voiceKey: string;
  status: OutputStatus;
  repetitionIndex: number;
  createdAt: string;
  // The exact text that was synthesized.
  sourceText: string;
  media: MediaAssetView;
  modelRun: ModelRunSummary;
};

export type TranslationCellView = {
  id: string;
  conditionKey: string;
  text: string;
  targetLanguage: string;
  status: OutputStatus;
  repetitionIndex: number;
  createdAt: string;
  sourceRevision: { id: string; revisionNumber: number; isCurrent: boolean; transcriptType: TranscriptType };
  modelRun: ModelRunSummary;
  syntheses: SynthesisView[];
};

export type BatchSummary = {
  id: string;
  name: string;
  status: BatchStatus;
  dataMode: StudyMode;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

// The matrix of spec 45 for one batch: rows A, A*, B, C and one column per
// translation condition. A cell can hold several translations (repetitions,
// or translations of different revisions of the same transcript).
export type TranslationBatchView = {
  batch: BatchSummary;
  conditions: string[];
  rows: Array<{
    transcriptType: TranscriptType;
    label: string;
    cells: Array<{ conditionKey: string; translations: TranslationCellView[] }>;
  }>;
};

export type FlagView = {
  id: string;
  entityType: string;
  entityId: string;
  reasonCode: string | null;
  notes: string | null;
  createdByLabel: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type NoteView = {
  id: string;
  entityType: string;
  entityId: string;
  body: string;
  createdByLabel: string | null;
  createdAt: string;
};

export type UtteranceDetail = {
  id: string;
  // 1-based position in the session, used in file names such as U-03.
  ordinal: number;
  taskPresentationId: string;
  turnIndex: number;
  isFollowup: boolean;
  followupKey: string | null;
  // The exact prompt the participant answered.
  promptSnapshot: string;
  attemptCount: number;
  status: UtteranceStatus;
  exclusionReason: string | null;
  flagged: boolean;
  flagNotes: string | null;
  submittedAt: string | null;
  durationMs: number | null;
  quality: {
    peakAmplitude: number | null;
    clippedSampleRatio: number | null;
    silenceRatio: number | null;
    rmsDb: number | null;
    warnings: string[];
  };
  qualityIndicators: QualityIndicator[];
  sourceMedia: MediaAssetView | null;
  derivedMedia: MediaAssetView | null;
  // Recorder facts of the source recording. Null when none were stored.
  captureDetails: CaptureDetailsView | null;
  transcripts: TranscriptCellView[];
  translationBatches: TranslationBatchView[];
};

export type TaskSequenceEntry = {
  presentationId: string;
  sequenceIndex: number;
  status: PresentationStatus;
  taskKey: string;
  taskType: TaskType;
  blockKey: string;
  titleSnapshot: string;
  promptSnapshot: string;
  contextSnapshot: string | null;
  instructionsSnapshot: string | null;
  startedAt: string | null;
  completedAt: string | null;
  randomization: Record<string, unknown> | null;
  utteranceIds: string[];
};

export type QuestionnaireAnswerView = {
  itemId: string;
  itemKey: string;
  type: QuestionnaireItemType;
  prompt: string;
  required: boolean;
  orderIndex: number;
  // The stored value, null when the item was not answered.
  value: unknown;
  // The answer as text with option labels resolved, null when not answered.
  display: string | null;
};

export type QuestionnaireResponseView = {
  responseId: string;
  submittedAt: string;
  questionnaire: { versionId: string; key: string; versionNumber: number; name: string };
  answers: QuestionnaireAnswerView[];
};

export type ProcessingJobView = {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  processingBatchId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ProcessingRunView = ModelRunSummary & {
  utteranceId: string | null;
  batchName: string | null;
};

export type CompletenessCheck = {
  key: CompletenessKey;
  complete: boolean;
  // False when the check does not apply, for example a protocol without a
  // background questionnaire. A check that does not apply counts as complete.
  applicable: boolean;
  detail: string;
};

// One review screen as the researchers see it: which condition was Version 1 and
// which Version 2, what was shown and what the participant answered.
export type OutputReviewItemView = {
  id: string;
  position: number;
  kind: "practice" | "utterance" | "check" | "audio";
  utteranceId: string | null;
  transcriptRevisionId: string | null;
  sourceText: string | null;
  version1: { text: string | null; conditionKey: string | null; translationId: string | null };
  version2: { text: string | null; conditionKey: string | null; translationId: string | null };
  // Check items: which version had the changed meaning.
  changedSlot: 1 | 2 | null;
  ratings: Record<string, unknown> | null;
  choice: string | null;
  markedTokens: number[] | null;
  markedWords: string[];
  cantJudge: string[];
  // Version of the questions this screen asked (output-review-v1 or -v2).
  scaleVersion: string;
  answeredAt: string | null;
};

export type OutputReviewView = {
  status: "in_progress" | "completed" | "skipped" | "unavailable";
  scaleVersion: string;
  skippedAtStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  selection: Record<string, unknown>;
  items: OutputReviewItemView[];
};

export type SessionDetail = {
  adminTimezone: string;
  session: {
    id: string;
    participantCode: string;
    mode: StudyMode;
    status: SessionStatus;
    locale: string | null;
    startedAt: string;
    consentedAt: string | null;
    completedAt: string | null;
    withdrawnAt: string | null;
    abandonedAt: string | null;
    lastActivityAt: string;
    flagged: boolean;
    flagNotes: string | null;
    excluded: boolean;
    exclusionReason: string | null;
    appVersion: string;
    gitCommitSha: string | null;
    orderSeed: string | null;
  };
  protocol: { id: string; versionNumber: number; name: string; status: string };
  consent: {
    consentVersionId: string;
    versionNumber: number;
    title: string;
    acceptedAt: string;
    items: Array<{ itemId: string; textSnapshot: string; required: boolean; accepted: boolean; scope: string | null }>;
  } | null;
  capture: {
    browserInfo: Record<string, unknown> | null;
    audioEnvironment: Record<string, unknown> | null;
  };
  taskSequence: TaskSequenceEntry[];
  utterances: UtteranceDetail[];
  questionnaires: {
    background: QuestionnaireResponseView | null;
    post: QuestionnaireResponseView | null;
    // Whether the protocol of this session includes each questionnaire.
    backgroundExpected: boolean;
    postExpected: boolean;
    // The questionnaire after the output review.
    postReview: QuestionnaireResponseView | null;
    postReviewExpected: boolean;
  };
  // The English check and the output review at the end of the session
  // (docs/RESEARCH-DESIGN.md, section 3). Null when the session had none.
  englishCheck: {
    testVersion: string;
    score: number;
    wordsCorrect: number;
    nonwordsCorrect: number;
    submittedAt: string;
  } | null;
  outputReview: OutputReviewView | null;
  flags: FlagView[];
  notes: NoteView[];
  processing: { modelRuns: ProcessingRunView[]; jobs: ProcessingJobView[] };
  completeness: CompletenessCheck[];
};

// ---------------------------------------------------------------------------
// Audit history
// ---------------------------------------------------------------------------

export type AuditEntryView = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  actorLabel: string | null;
  createdAt: string;
};

export type AuditHistoryResult = {
  items: AuditEntryView[];
  total: number;
  page: number;
  pageSize: number;
  adminTimezone: string;
};

// ---------------------------------------------------------------------------
// Media deletion and test data reset
// ---------------------------------------------------------------------------

export type MediaDeleteResult = {
  mediaAssetId: string;
  deletedAt: string;
  // True when the asset had been marked deleted before this call.
  alreadyDeleted: boolean;
  storageObjectRemoved: boolean;
  // Derived copies that were deleted together with the asset.
  derivedAssetIds: string[];
  // Set when the asset was the accepted recording of an utterance.
  utterance: { id: string; status: UtteranceStatus } | null;
};

export type ResetTestDataResult = {
  modes: ResettableMode[];
  // Number of deleted rows per table.
  deleted: Record<string, number>;
  storageObjectsRemoved: number;
  storageObjectsFailed: number;
};

// ---------------------------------------------------------------------------
// Settings (spec 59, 87)
// ---------------------------------------------------------------------------

export type ProviderTestResult = {
  configured: boolean;
  ok: boolean;
  message: string;
  at: string | null;
  latencyMs: number | null;
};

export type SettingsView = {
  study: {
    id: string;
    slug: string;
    // The internal study name. Researchers only.
    name: string;
    // The stored participant-facing title, null when none is set.
    participantTitle: string | null;
    // The stored title per other locale.
    participantTitleTranslations: Record<string, string>;
    // What participants see: the stored title, or the neutral standard title.
    effectiveParticipantTitle: string;
    // Wording notes on the participant-facing title (spec 6.1, 6.4). They do not block saving.
    participantTitleWarnings: string[];
  };
  // Stored values. Null or empty means "not set": translation batches then
  // refuse to start and name the missing setting.
  languages: {
    sourceLanguage: string | null;
    targetLanguage: string | null;
    participantLocales: string[];
    defaultLocale: string | null;
    // The languages the participant interface exists in.
    interfaceLocales: string[];
  };
  // Example text from the development seed that is still in the current protocol.
  exampleText: {
    present: boolean;
    protocolVersionNumber: number | null;
    // Plain names of the texts that still contain example text.
    fields: string[];
    message: string | null;
  };
  operational: {
    status: StudyStatus;
    allowNewSessions: boolean;
    maintenanceMode: boolean;
    maintenanceMessage: string | null;
  };
  limits: {
    maxUploadMb: number;
    maxUtteranceSeconds: number;
    sessionInactivityTimeoutMinutes: number;
    demoDailyRunLimit: number;
  };
  flags: {
    studyLaptopMode: boolean;
    autoQueueAsr: boolean;
    demoPersist: boolean;
    demoPublic: boolean;
  };
  adminTimezone: string;
  conventions: {
    transcriptionConventionVersion: string | null;
    annotationSchemeVersion: string | null;
  };
  // The output review at the end of a session, with the values that apply
  // (defaults filled in).
  outputReview: {
    enabled: boolean;
    maxItems: number;
    englishCheckEnabled: boolean;
  };
  database: {
    connected: boolean;
    migrations: {
      // up_to_date: every migration of this code version is applied.
      // pending: the database is behind the code. unknown: could not be compared.
      status: "up_to_date" | "pending" | "unknown";
      applied: number;
      expected: number | null;
      pending: string[];
      latestApplied: string | null;
      detail: string | null;
    };
  };
  storage: {
    driver: string;
    // Local directory or bucket name. Never credentials.
    location: string | null;
    connected: boolean;
    detail: string | null;
    ffmpeg: { available: boolean; ffmpegVersion: string | null; ffprobeVersion: string | null };
  };
  provider: {
    providers: Array<{ name: string; configured: boolean }>;
    openaiConfigured: boolean;
    lastTest: { at: string; ok: boolean; message: string | null } | null;
  };
  application: {
    appVersion: string;
    gitCommitSha: string | null;
    environment: string;
    worker: {
      healthy: boolean;
      workers: Array<{ workerId: string; state: string; lastSeenAt: string; startedAt: string }>;
    };
    queue: { queued: number; running: number; failed: number };
  };
  testDataReset: {
    // False in production unless ALLOW_TEST_DATA_RESET=true.
    allowed: boolean;
    phrase: string;
    counts: { demoSessions: number; testSessions: number };
  };
};
