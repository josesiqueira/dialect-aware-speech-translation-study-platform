// TypeScript shapes for the JSONB columns. JSONB is used only for flexible,
// versioned configuration and provider metadata. Scientifically central fields are
// ordinary relational columns (spec 125).
import type {
  JobType,
  OrderMode,
  StudyMode,
  TaskType,
  TranscriptType,
} from "@dialect/domain";

// studies.settings_json (spec 59, 80, 86, 87, 108, 137)
export type StudySettings = {
  allowNewSessions?: boolean;
  maintenanceMode?: boolean;
  maintenanceMessage?: string | null;
  maxUploadMb?: number;
  maxUtteranceSeconds?: number;
  sessionInactivityTimeoutMinutes?: number;
  // Show "Start next participant" on the completion screen (study laptop mode).
  studyLaptopMode?: boolean;
  // Queue an ASR job right after each research upload (spec 79).
  autoQueueAsr?: boolean;
  // Demo Mode: when false, demo recordings are processed but not kept (spec 80).
  demoPersist?: boolean;
  demoPublic?: boolean;
  adminTimezone?: string;
  participantLocales?: string[];
  defaultLocale?: string;
  transcriptionConventionVersion?: string;
  annotationSchemeVersion?: string;
  targetLanguage?: string;
  sourceLanguage?: string;
  lastProviderTest?: { at: string; ok: boolean; message?: string } | null;
  // Title shown to participants. Kept apart from the internal study name so the
  // research focus is not revealed before the speech tasks (spec 6.4).
  participantTitle?: string | null;
  // The participant-facing title in other languages, keyed by locale.
  participantTitleTranslations?: Record<string, string> | null;
  // Maximum number of demo pipeline runs per day across all visitors.
  demoDailyRunLimit?: number;
  // Never-consented sessions are marked abandoned after this many minutes.
  preConsentTimeoutMinutes?: number;
  // Language of the study texts, when the researchers declare it.
  contentLanguage?: string | null;
  // The output review at the end of a session (docs/RESEARCH-DESIGN.md, section 3).
  // Off: no session gets the English check, the review or the post-review questionnaire.
  outputReviewEnabled?: boolean;
  // Most of the participant's own recordings shown in the review. The default is a
  // starting value; the pilot sets the real number.
  outputReviewMaxItems?: number;
  // The English vocabulary test (LexTALE) before the review. Off unless set to
  // true: the project owner removed it from the flow on 2026-10-09.
  englishCheckEnabled?: boolean;
};

// output_reviews.selection_json: how the reviewed recordings were chosen.
export type OutputReviewSelection = {
  algorithm: string;
  maxItems: number;
  // Submitted, non-excluded recordings of the session in the spread order.
  candidates: string[];
  ready: string[];
  chosen: string[];
  // Candidates that were not ready, with the reason.
  unavailable: Array<{ utteranceId: string; reason: string }>;
  waitedSeconds: number;
  // Why the review shows nothing, when status is "unavailable".
  reason?: string;
};

// output_review_items.shown_json: exactly what the screen showed. Scale version
// output-review-v2 stores only "own" screens with sourceTokens null; the other
// displays and changedSlot belong to rows stored with output-review-v1.
export type OutputReviewShown = {
  display: "practice" | "own" | "example" | "audio";
  sourceText: string | null;
  sourceTokens: string[] | null;
  // The text of Version 1 and Version 2 as shown.
  version1: string | null;
  version2: string | null;
  // Check items: the slot (1 or 2) whose meaning was changed.
  changedSlot?: 1 | 2;
};

// consent_versions.items_json
export type ConsentItem = {
  id: string; // stable id, never reused for a different meaning
  text: string;
  required: boolean;
  // Free label such as participation, voice_recording, external_ai_processing.
  scope?: string;
};

// session_consents.responses_json
export type ConsentResponse = {
  itemId: string;
  textSnapshot: string;
  required: boolean;
  accepted: boolean;
};

// protocol_versions.order_config_json (spec 8)
export type ProtocolOrderConfig = {
  blocks: Array<{
    key: string;
    title?: string;
    orderMode: OrderMode;
  }>;
};

// protocol_tasks.config_json
export type ProtocolTaskConfig = {
  topicSuggestions?: string[];
  randomizationEligible?: boolean;
  // How follow-ups are offered: always shown, or optional for the participant.
  followupMode?: "always" | "optional";
};

// questionnaire_items.config_json
export type QuestionnaireItemConfig = {
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

// task_presentations.randomization_metadata_json
export type RandomizationMetadata = {
  seed: string;
  algorithm: string;
  blockKey: string;
  orderMode: OrderMode;
  indexInBlock: number;
  protocolOrderIndex: number;
};

export type BrowserInfo = {
  userAgent?: string;
  platform?: string;
  language?: string;
  browserName?: string;
  browserVersion?: string;
  os?: string;
};

export type AudioEnvironment = {
  // Coarse microphone class (built_in, usb, bluetooth, headset, unknown). The raw
  // device label is not stored because it can contain a person's name.
  deviceClass?: string;
  /** @deprecated Raw labels are no longer stored. */
  deviceLabel?: string;
  requestedConstraints?: Record<string, unknown>;
  actualTrackSettings?: Record<string, unknown>;
  audioContextSampleRate?: number;
  captureMethod?: string;
};

export type UtteranceQuality = {
  peakAmplitude?: number;
  clippedSampleRatio?: number;
  silenceRatio?: number;
  rmsDb?: number;
  warnings?: string[];
};

// media_assets.metadata_json
export type MediaMetadata = {
  requestedConstraints?: Record<string, unknown>;
  actualTrackSettings?: Record<string, unknown>;
  audioContextSampleRate?: number;
  browserUserAgent?: string;
  originalFileName?: string;
  probe?: Record<string, unknown>;
  derivation?: {
    tool: string;
    toolVersion: string;
    command: string;
    createdAt: string;
  };
  deletion?: { reason: string; deletedByLabel?: string };
  [key: string]: unknown;
};

export type ModelParameters = Record<string, unknown>;

// model_runs.input_manifest_json: identifies inputs by ids and hashes (spec 27, 105).
export type ModelRunInputManifest = {
  mediaAssetId?: string;
  mediaSha256?: string;
  utteranceId?: string;
  transcriptRevisionId?: string;
  transcriptType?: TranscriptType;
  translationId?: string;
  textSha256?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  // Final instruction sent to the provider, so the run can be reproduced.
  effectiveInstruction?: string;
  promptVersionId?: string;
  modelConfigId?: string;
  [key: string]: unknown;
};

export type ModelConfigSnapshot = {
  modelConfigId: string;
  key: string;
  stage: string;
  conditionKey: string | null;
  versionNumber: number;
  provider: string;
  modelId: string;
  parameters: ModelParameters;
  promptVersionId: string | null;
  promptKey: string | null;
  promptVersionNumber: number | null;
  promptText: string | null;
};

// processing_batches.configuration_snapshot_json: frozen when the batch is created.
export type BatchConfigurationSnapshot = {
  selection: {
    mode: StudyMode[];
    completedSessionsOnly: boolean;
    verifiedTranscriptsOnly: boolean;
    excludeFlagged: boolean;
    excludeExcluded: boolean;
    protocolVersionIds?: string[];
    taskTypes?: TaskType[];
    dateFrom?: string | null;
    dateTo?: string | null;
    sessionIds?: string[];
    utteranceIds?: string[];
  };
  transcriptTypes: TranscriptType[];
  runAsr: boolean;
  asr: ModelConfigSnapshot | null;
  translations: ModelConfigSnapshot[];
  tts: ModelConfigSnapshot[];
  sourceLanguage: string;
  targetLanguage: string;
  // Utterance ids resolved from the selection when the batch was created.
  utteranceIds: string[];
  estimatedJobCounts?: { asr: number; translation: number; tts: number };
};

export type JobPayload = {
  type?: JobType;
  [key: string]: unknown;
};

// export_jobs.filters_json (spec 57)
export type ExportFilters = {
  dateFrom?: string | null;
  dateTo?: string | null;
  protocolVersionIds?: string[];
  modes?: StudyMode[];
  includeTest?: boolean;
  includeDemo?: boolean;
  completedOnly?: boolean;
  taskTypes?: TaskType[];
  verifiedTranscriptsOnly?: boolean;
  includeFlagged?: boolean;
  includeExcluded?: boolean;
  includeWithdrawn?: boolean;
  processingBatchIds?: string[];
  participantRegion?: string | null;
  includeResearcherNotes?: boolean;
  sessionIds?: string[];
};
