// Request schemas and response types of Demo Mode and the admin pipeline test
// (spec 3.2, 52, 80, 81). Shared by the browser and the server.
import { z } from "zod";
import type { CaptureQualityClass, StudyMode } from "../enums";
import type { ErrorCode } from "../errors";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

// A demo recording has the limits of the study settings (maxUtteranceSeconds,
// maxUploadMb), the same as a recording of the study: see DemoAccess.
//
// A pipeline test clip is short on purpose: it checks that every stage runs.
// 30 seconds of 48 kHz, 24 bit, mono PCM is 4.3 MB. The study settings apply
// too when they are lower.
export const PIPELINE_TEST_MAX_RECORDING_SECONDS = 30;
export const PIPELINE_TEST_MAX_UPLOAD_BYTES = 9 * 1024 * 1024;

// The notice a demo visitor must accept before the microphone is used. A demo
// session has no research consent record (session_consents is for the versioned
// research consent). The version and the text the visitor agreed to are stored
// with the acceptance time in sessions.browser_info_json.demoAcknowledgement.
export const DEMO_RECORDING_NOTICE = {
  version: "2026-10-03",
  title: "Before you record",
  paragraphs: [
    "This is a demonstration. Your voice is recorded when you press Start recording.",
    "The recording is sent to an external AI service, which transcribes it, translates it and produces synthetic speech for the demonstration.",
    "The recording and the results are marked as demo data. They are not research data and are never part of a research export.",
    "Do not say names, addresses or other personal details about yourself or other people.",
  ],
  agreeLabel: "I agree, use the microphone",
} as const;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// "active": the active model configurations of the AI Pipeline page.
// "mock": the stored mock provider configurations. A check of the plumbing, never
// real model output. Only for an admin, and only where the mock provider is allowed.
export const PIPELINE_PROVIDER_MODES = ["active", "mock"] as const;
export const pipelineProviderModeSchema = z.enum(PIPELINE_PROVIDER_MODES);
export type PipelineProviderMode = z.infer<typeof pipelineProviderModeSchema>;

const browserInfoSchema = z
  .object({
    userAgent: z.string().max(500).optional(),
    platform: z.string().max(200).optional(),
    language: z.string().max(50).optional(),
  })
  .strict();

// POST /api/demo/session
export const startDemoSessionBodySchema = z
  .object({
    // The visitor pressed "I agree" under the recording notice. Nothing is
    // created without it.
    acknowledged: z.literal(true, { error: "The recording notice must be accepted first." }),
    locale: z.string().max(20).optional(),
    browserInfo: browserInfoSchema.optional(),
  })
  .strict();
export type StartDemoSessionBody = z.infer<typeof startDemoSessionBodySchema>;

// "all" runs the whole pipeline in one request. The demo page asks for "asr",
// "translation" and "tts" in turn, so each result is shown as soon as it exists.
export const PIPELINE_STAGE_SELECTIONS = ["all", "asr", "translation", "tts"] as const;
export const pipelineStageSelectionSchema = z.enum(PIPELINE_STAGE_SELECTIONS);
export type PipelineStageSelection = z.infer<typeof pipelineStageSelectionSchema>;

// POST /api/demo/recordings/:id/run
export const runDemoRecordingBodySchema = z
  .object({
    stage: pipelineStageSelectionSchema.optional(),
    provider: pipelineProviderModeSchema.optional(),
  })
  .strict();
export type RunDemoRecordingBody = z.infer<typeof runDemoRecordingBodySchema>;

export const PIPELINE_TEST_SOURCES = ["recording", "generated_tone"] as const;
export const pipelineTestSourceSchema = z.enum(PIPELINE_TEST_SOURCES);
export type PipelineTestSource = z.infer<typeof pipelineTestSourceSchema>;

// POST /api/admin/ai/test with a JSON body: the generated test tone.
export const pipelineTestBodySchema = z
  .object({
    source: z.literal("generated_tone"),
    provider: pipelineProviderModeSchema.optional(),
  })
  .strict();
export type PipelineTestBody = z.infer<typeof pipelineTestBodySchema>;

// The "options" part of POST /api/admin/ai/test (multipart, JSON text).
export const pipelineTestOptionsSchema = z.object({ provider: pipelineProviderModeSchema.optional() }).strict();

export const mediaIdParamSchema = z.object({ id: z.uuid() });

// POST /api/demo/purge-leftovers (admin only): removes demo sessions that were
// left behind while the study setting demoPersist is false.
export const purgeLeftoversBodySchema = z.object({ confirm: z.literal(true) }).strict();

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type PipelineStageStatus = "succeeded" | "failed" | "skipped";

// A failure that is safe to show. `message` is plain language without provider
// internals. `detail` is the cleaned provider message and is only sent to an admin.
export type PipelineStageError = {
  code: ErrorCode;
  message: string;
  // "provider_not_configured", "configuration_missing", "provider_error", "storage", "other".
  reason: string;
  detail?: string;
  retryable?: boolean;
};

// What produced a stage output (spec 27, 163).
export type PipelineStageProvenance = {
  modelRunId: string | null;
  modelConfigId: string;
  configKey: string;
  configVersionNumber: number;
  provider: string;
  requestedModel: string;
  returnedModel: string | null;
  promptKey: string | null;
  promptVersionNumber: number | null;
  // Time the provider call took, as recorded on the model run.
  latencyMs: number | null;
};

export type PipelineStage = {
  status: PipelineStageStatus;
  // Wall time of the whole step on the server, including storage and database writes.
  durationMs: number | null;
  error: PipelineStageError | null;
  provenance: PipelineStageProvenance | null;
};

export type PipelineConditionResult = {
  conditionKey: string;
  // "Default translation", "Preserve variation", or the condition key of another configuration.
  label: string;
  translation: PipelineStage & { translationId: string | null; text: string | null };
  synthesis: PipelineStage & {
    synthesisId: string | null;
    mediaAssetId: string | null;
    mimeType: string | null;
    voiceKey: string | null;
  };
};

export type PipelineSourceInfo = {
  mediaAssetId: string;
  mimeType: string;
  durationMs: number | null;
  sizeBytes: number;
  sha256: string;
  captureQualityClass: CaptureQualityClass | null;
};

export type DemoResult = {
  sessionId: string;
  participantCode: string;
  utteranceId: string;
  // 0 for the first recording of the demo session, then 1, 2, ...
  turnIndex: number;
  dataMode: StudyMode;
  processingBatchId: string | null;
  batchName: string | null;
  providerMode: PipelineProviderMode | "explicit";
  // True when any stage used the mock provider. The page then labels the output.
  isMock: boolean;
  source: PipelineSourceInfo;
  asr: PipelineStage & { transcriptRevisionId: string | null; text: string | null };
  conditions: PipelineConditionResult[];
  // True when every stage succeeded.
  ok: boolean;
  totalDurationMs: number;
};

export type DemoAccess = {
  // False: the page needs an admin session.
  demoPublic: boolean;
  // False: the data of a demo session is deleted when the session ends.
  demoPersist: boolean;
  // True when the caller may use the mock provider option.
  mockAvailable: boolean;
  // From the study settings: maxUtteranceSeconds and maxUploadMb.
  maxRecordingSeconds: number;
  maxUploadBytes: number;
};

export type DemoSessionInfo = {
  sessionId: string;
  participantCode: string;
  acknowledgedAt: string;
  recordingCount: number;
};

// POST /api/demo/session
export type StartDemoSessionResponse = { session: DemoSessionInfo; access: DemoAccess };
// GET /api/demo/session
export type DemoSessionResponse = { session: DemoSessionInfo | null; access: DemoAccess };
// POST /api/demo/recordings
export type DemoRecordingResponse = {
  recording: { utteranceId: string; turnIndex: number; source: PipelineSourceInfo };
};
// POST /api/demo/recordings/:id/run
export type RunDemoRecordingResponse = { result: DemoResult };
// DELETE /api/demo/session
export type EndDemoSessionResponse = { ended: boolean; purged: boolean };

export type PurgeDemoSessionResult = {
  sessionId: string;
  deleted: Record<string, number>;
  storageObjectsRemoved: number;
  storageObjectsFailed: number;
};

export type PurgeLeftoversResponse = { sessions: number; results: PurgeDemoSessionResult[] };

// The five rows of spec 52, in this order.
export const PIPELINE_TEST_ROW_KEYS = ["asr", "translation_default", "translation_preserve", "tts", "storage"] as const;
export type PipelineTestRowKey = (typeof PIPELINE_TEST_ROW_KEYS)[number];

export const PIPELINE_TEST_ROW_LABELS: Record<PipelineTestRowKey, string> = {
  asr: "ASR",
  translation_default: "Default translation",
  translation_preserve: "Preserve translation",
  tts: "TTS",
  storage: "Storage",
};

export type PipelineTestRow = {
  key: PipelineTestRowKey;
  label: string;
  result: "PASS" | "FAIL";
  latencyMs: number | null;
  // "provider / model", or the storage driver for the storage row. Null when no
  // configuration exists for the row.
  model: string | null;
  // Set on FAIL. Safe to show.
  message: string | null;
  errorCode: ErrorCode | null;
};

export type PipelineTestResult = {
  ranAt: string;
  providerMode: PipelineProviderMode;
  isMock: boolean;
  source: PipelineTestSource;
  passed: boolean;
  rows: PipelineTestRow[];
  sessionId: string;
  participantCode: string;
  utteranceId: string;
  processingBatchId: string | null;
  dataMode: StudyMode;
  // A short excerpt of the ASR text, so the researcher sees that something was recognized.
  transcriptExcerpt: string | null;
};

// POST /api/admin/ai/test
export type PipelineTestResponse = { result: PipelineTestResult };
// GET /api/admin/ai/test
export type LastPipelineTestResponse = {
  last: PipelineTestResult | null;
  mockAvailable: boolean;
  // The admin time zone of the study settings, for showing the time of the last test.
  timeZone: string;
};
