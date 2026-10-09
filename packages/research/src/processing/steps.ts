// Pipeline step functions (spec 15, 20 to 23, 27, 30, 65, 143 to 148).
//
// Each function performs ONE model call and stores everything about it: the
// model_runs row (also for a failed call) and the output row. The job handlers,
// Demo Mode and the admin pipeline test all call these same functions.
//
// Rules kept here (the design is explained in docs/AI-PROVENANCE.md):
// - the model_runs row is inserted with status `running` before the provider is
//   called and is finished exactly once, as `succeeded` or `failed`;
// - the output row and the run completion are written in one transaction, so a
//   crash can never leave an output without its finished run or the reverse;
// - every attempt is its own model_runs row (idempotency key "<base>#<attempt>");
// - work that already succeeded is never run again: the existing output is returned;
// - the provider receives the minimum input (spec 65): audio and context prompt,
//   or transcript text and instruction, or translated text and voice instruction;
// - model output is stored exactly as returned, never trimmed or cleaned;
// - a failed run keeps what the provider answered (status, request id, refusal,
//   partial or empty text) in response_metadata_json, so the researcher can see
//   why there is no output (spec 146);
// - the mock provider never processes research data;
// - request values the adapters would otherwise fill in themselves (ASR response
//   format, TTS output format) are resolved here and recorded with the run.
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  MOCK_PROVIDER,
  SYNTHESIS_OUTPUT_FORMATS,
  buildSynthesisRequest,
  buildTranslationRequest,
  estimateCost,
  redactSecrets,
  type PricingTable,
  type ProvenanceFields,
  type SynthesisOutputFormat,
} from "@dialect/ai";
import {
  getPgError,
  isUniqueViolation,
  mediaAssets,
  modelRuns,
  processingBatches,
  sessions,
  studies,
  syntheses,
  transcriptRevisions,
  transcripts,
  translations,
  utterances,
  type ModelConfigSnapshot,
  type ModelParameters,
  type ModelRunInputManifest,
  type Transaction,
} from "@dialect/db";
import { AppError, isAppError, type EntityType, type StudyMode, type TranscriptType } from "@dialect/domain";
import { parseWavHeader, probeAudio, sha256OfBuffer, ttsAudioKey, isWavBuffer } from "@dialect/storage";
import type { ServiceContext } from "../context";
import { sanitizeErrorMessage } from "../jobs/queue";

export type ModelRunRow = typeof modelRuns.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
export type TranscriptRevisionRow = typeof transcriptRevisions.$inferSelect;
export type TranslationRow = typeof translations.$inferSelect;
export type SynthesisRow = typeof syntheses.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;

export type StepStage = "asr" | "translation" | "tts";

// error_code of a run whose process stopped between the insert of the run and
// its completion (crash, kill). The next attempt marks it before it starts.
export const INTERRUPTED_RUN_ERROR_CODE = "INTERRUPTED";

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

const NO_BATCH = "no-batch";

// A condition key is free text. Encoding keeps ":" and "#" out of the key, so
// two different pieces of work can never share a key or a key prefix.
export function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

// Base key of one logical ASR: utterance, model configuration (which pins the
// prompt version and the parameters) and processing batch.
export function asrStepKey(input: {
  utteranceId: string;
  modelConfigId: string;
  processingBatchId: string | null;
}): string {
  return `asr:${input.utteranceId}:${input.modelConfigId}:${input.processingBatchId ?? NO_BATCH}`;
}

// Base key of one logical translation: transcript revision, condition, model
// configuration, processing batch and repetition.
export function translationStepKey(input: {
  sourceTranscriptRevisionId: string;
  conditionKey: string;
  modelConfigId: string;
  processingBatchId: string;
  repetitionIndex?: number;
}): string {
  return [
    "translation",
    input.sourceTranscriptRevisionId,
    encodeKeyPart(input.conditionKey),
    input.modelConfigId,
    input.processingBatchId,
    String(input.repetitionIndex ?? 0),
  ].join(":");
}

// Base key of one logical synthesis: translation, condition, model
// configuration, processing batch and repetition.
export function synthesisStepKey(input: {
  translationId: string;
  conditionKey: string;
  modelConfigId: string;
  processingBatchId: string;
  repetitionIndex?: number;
}): string {
  return [
    "tts",
    input.translationId,
    encodeKeyPart(input.conditionKey),
    input.modelConfigId,
    input.processingBatchId,
    String(input.repetitionIndex ?? 0),
  ].join(":");
}

// model_runs.idempotency_key of one attempt.
export function attemptKey(baseKey: string, attemptNumber: number): string {
  return `${baseKey}#${attemptNumber}`;
}

// ---------------------------------------------------------------------------
// Shared run handling
// ---------------------------------------------------------------------------

type RunSpec = {
  stage: StepStage;
  baseKey: string;
  modelConfig: ModelConfigSnapshot;
  processingBatchId: string | null;
  conditionKey: string | null;
  sourceEntityType: EntityType;
  sourceEntityId: string;
  // The request as it is handed to the adapter, without the audio or text payload.
  parameters: ModelParameters;
  manifest: ModelRunInputManifest;
  pricing?: PricingTable | null;
};

type CallOutcome<R extends ProvenanceFields, O> = {
  result: R;
  // Extra observable response data for response_metadata_json.
  responseMetadata?: Record<string, unknown>;
  // Writes the output row inside the transaction that finishes the run.
  persist: (tx: Transaction, run: ModelRunRow) => Promise<O>;
  // Removes side effects made outside the database (a stored audio file) when
  // the transaction fails.
  undo?: () => Promise<void>;
};

function assertStage(config: ModelConfigSnapshot, stage: StepStage): void {
  if (config.stage !== stage) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The model configuration "${config.key}" is for the ${config.stage} stage, not for ${stage}.`,
      { modelConfigId: config.modelConfigId },
    );
  }
}

// The mock provider returns invented text and a test tone. It exists for tests,
// Demo Mode and development. Research data is never processed with it: a mock
// output next to real outputs could be mistaken for a model result.
export function assertProviderAllowedForMode(
  config: Pick<ModelConfigSnapshot, "provider" | "key" | "versionNumber" | "modelConfigId">,
  mode: StudyMode,
): void {
  if (mode !== "research" || config.provider !== MOCK_PROVIDER) return;
  throw new AppError(
    "CONFIGURATION_MISSING",
    `The model configuration "${config.key}" version ${config.versionNumber} uses the mock provider, which returns invented output. Research data cannot be processed with it. Activate a configuration with a real provider on the AI Pipeline page, or process test data in a test batch.`,
    { modelConfigId: config.modelConfigId, provider: config.provider, dataMode: mode },
  );
}

// Request values that a model configuration may leave out. The step fills them
// in here, passes them to the adapter explicitly and records them in
// model_runs.parameters_json, so no run depends on a default inside an adapter.
export const ASR_RESPONSE_FORMAT_WHEN_NOT_CONFIGURED = "json";
export const TTS_OUTPUT_FORMAT_WHEN_NOT_CONFIGURED: SynthesisOutputFormat = "wav";

function assertBaseKey(baseKey: string): void {
  if (!baseKey || baseKey.includes("#")) {
    throw new AppError("VALIDATION_ERROR", "A step needs an idempotency key without the character #.");
  }
}

// All earlier attempts of the same logical work, oldest first.
async function findAttempts(ctx: ServiceContext, spec: Pick<RunSpec, "stage" | "baseKey" | "sourceEntityId">) {
  return ctx.db
    .select()
    .from(modelRuns)
    .where(
      and(
        eq(modelRuns.stage, spec.stage),
        eq(modelRuns.sourceEntityId, spec.sourceEntityId),
        sql`starts_with(${modelRuns.idempotencyKey}, ${`${spec.baseKey}#`})`,
      ),
    )
    .orderBy(asc(modelRuns.attemptNumber));
}

// Inserts the `running` row of a new attempt. An earlier attempt that is still
// `running` belongs to a process that stopped: it is closed as failed first, so
// it can never complete later and produce a second output.
async function beginRun(ctx: ServiceContext, spec: RunSpec, earlier: ModelRunRow[]): Promise<ModelRunRow> {
  const now = ctx.now();
  for (const run of earlier) {
    if (run.status !== "running") continue;
    await ctx.db
      .update(modelRuns)
      .set({
        status: "failed",
        errorCode: INTERRUPTED_RUN_ERROR_CODE,
        errorMessage: "The attempt did not finish (the process stopped or lost its job lock). A new attempt was started.",
        finishedAt: now,
      })
      .where(and(eq(modelRuns.id, run.id), eq(modelRuns.status, "running")));
  }
  const attemptNumber = earlier.reduce((max, run) => Math.max(max, run.attemptNumber), 0) + 1;
  try {
    const [row] = await ctx.db
      .insert(modelRuns)
      .values({
        stage: spec.stage,
        provider: spec.modelConfig.provider,
        requestedModel: spec.modelConfig.modelId,
        modelConfigId: spec.modelConfig.modelConfigId,
        promptVersionId: spec.modelConfig.promptVersionId,
        processingBatchId: spec.processingBatchId,
        conditionKey: spec.conditionKey,
        sourceEntityType: spec.sourceEntityType,
        sourceEntityId: spec.sourceEntityId,
        parametersJson: spec.parameters,
        inputManifestJson: spec.manifest,
        status: "running",
        attemptNumber,
        startedAt: now,
        appVersion: ctx.appVersion,
        gitCommitSha: ctx.gitCommitSha,
        idempotencyKey: attemptKey(spec.baseKey, attemptNumber),
      })
      .returning();
    if (!row) throw new AppError("DATABASE_ERROR", "The model run could not be stored.");
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Two deliveries of the same work started at the same moment. This one
      // steps back. The queue tries again later and then finds the result.
      throw new AppError("CONFLICT", "Another attempt of the same work was started at the same time.", {
        stage: spec.stage,
      });
    }
    throw error;
  }
}

// Converts any thrown value to an AppError whose message is safe to store: no
// key material, and no database error text (it can quote transcript text).
function toSafeError(ctx: ServiceContext, error: unknown, stage: StepStage, runId: string): AppError {
  if (isAppError(error)) return error;
  if (isUniqueViolation(error)) {
    return new AppError(
      "CONFLICT",
      "An output for the same source, condition, batch and repetition already exists.",
      { stage },
      { cause: error },
    );
  }
  const name = error instanceof Error ? error.name : "value";
  ctx.logger.error({ modelRunId: runId, stage, errorName: name }, "pipeline step failed with an unexpected error");
  if (getPgError(error)) {
    return new AppError("DATABASE_ERROR", `The ${stage} result could not be stored in the database.`, { stage }, { cause: error });
  }
  return new AppError("INTERNAL_ERROR", `The ${stage} step failed with an unexpected error (${name}).`, { stage }, { cause: error });
}

// Keys whose value could be a credential. They are never stored.
const SECRET_KEY_PATTERN = /authorization|api[_-]?key|secret|password|access[_-]?token|auth[_-]?token|cookie/i;
// Model output inside error details. Stored exactly as returned (spec 146, 147).
const RAW_OUTPUT_KEYS = new Set(["partialText", "rawText", "refusal"]);

// A copy of error details that is safe to store as JSON: no credential keys, no
// key material inside text, nothing that is not plain data.
function toStorableJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactSecrets(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= 10) return undefined;
  if (Array.isArray(value)) return value.map((item) => toStorableJson(item, depth + 1) ?? null);
  if (typeof value === "object" && !Buffer.isBuffer(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      const stored =
        RAW_OUTPUT_KEYS.has(key) && typeof item === "string" ? item : toStorableJson(item, depth + 1);
      if (stored !== undefined) result[key] = stored;
    }
    return result;
  }
  return undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export type FailedRunRecord = {
  // response_metadata_json of the failed run, or null when the error carries nothing.
  responseMetadata: Record<string, unknown> | null;
  // The parameters the adapter reports as sent, when the error carries them.
  parametersSent: ModelParameters | null;
  providerRequestId: string | null;
  returnedModel: string | null;
};

// What a failed run keeps from its error. An adapter error carries the response
// metadata under `rawMetadata` and, for a refused, cut-off or empty answer, the
// text under `refusal`, `partialText` or `rawText`. Everything except
// `rawMetadata` and `parametersSent` is stored under `failure`.
export function failedRunRecord(error: AppError): FailedRunRecord {
  const details = plainRecord(error.details) ?? {};
  const { rawMetadata, parametersSent, returnedModel, ...rest } = details;
  const failure = plainRecord(toStorableJson(rest)) ?? {};
  const metadata = plainRecord(toStorableJson(plainRecord(rawMetadata) ?? {})) ?? {};
  const hasContent = Object.keys(failure).length > 0 || Object.keys(metadata).length > 0;
  const sent = plainRecord(parametersSent);
  const direct = (error as { providerRequestId?: unknown }).providerRequestId;
  const requestId = typeof direct === "string" ? direct : details.providerRequestId;
  return {
    responseMetadata: hasContent ? { ...metadata, failure } : null,
    parametersSent: sent ? (plainRecord(toStorableJson(sent)) as ModelParameters) : null,
    providerRequestId: typeof requestId === "string" ? requestId : null,
    returnedModel: typeof returnedModel === "string" ? returnedModel : null,
  };
}

async function failRun(ctx: ServiceContext, runId: string, error: AppError, startedMs: number): Promise<void> {
  try {
    const record = failedRunRecord(error);
    await ctx.db
      .update(modelRuns)
      .set({
        status: "failed",
        errorCode: error.code,
        errorMessage: sanitizeErrorMessage(error.message),
        finishedAt: ctx.now(),
        latencyMs: Math.max(0, Math.round(performance.now() - startedMs)),
        providerRequestId: record.providerRequestId,
        // Without this the row keeps the request as it was planned by the step.
        ...(record.parametersSent ? { parametersJson: record.parametersSent } : {}),
        ...(record.returnedModel ? { returnedModel: record.returnedModel } : {}),
        responseMetadataJson: record.responseMetadata,
      })
      .where(and(eq(modelRuns.id, runId), eq(modelRuns.status, "running")));
  } catch (updateError) {
    // The original error matters more. The run stays `running` and is closed as
    // interrupted by the next attempt.
    ctx.logger.error(
      { modelRunId: runId, errorName: updateError instanceof Error ? updateError.name : "value" },
      "could not mark the model run as failed",
    );
  }
}

// Runs one attempt: insert the run, call the provider, then finish the run and
// write the output in one transaction. A failure at any point leaves a failed
// run and no output, and the error is thrown again for the caller.
async function executeModelRun<R extends ProvenanceFields, O>(
  ctx: ServiceContext,
  spec: RunSpec,
  earlier: ModelRunRow[],
  call: () => Promise<CallOutcome<R, O>>,
): Promise<{ modelRun: ModelRunRow; output: O }> {
  const run = await beginRun(ctx, spec, earlier);
  const startedMs = performance.now();
  let undo: (() => Promise<void>) | undefined;
  try {
    const outcome = await call();
    undo = outcome.undo;
    const { result } = outcome;
    const cost = estimateCost(result.usage, spec.pricing ?? null);
    const responseMetadata: Record<string, unknown> = {
      ...(result.rawMetadata ?? {}),
      ...(outcome.responseMetadata ?? {}),
      ...(cost ? { costEstimate: { isEstimate: true, currency: cost.currency, basis: cost.basis } } : {}),
    };
    return await ctx.db.transaction(async (tx) => {
      const [finished] = await tx
        .update(modelRuns)
        .set({
          status: "succeeded",
          returnedModel: result.returnedModel ?? null,
          providerRequestId: result.providerRequestId ?? null,
          // What the adapter reports as sent replaces the planned request.
          parametersJson: result.parametersSent,
          usageJson: result.usage ?? null,
          latencyMs: Math.max(0, Math.round(result.latencyMs)),
          responseMetadataJson: responseMetadata,
          estimatedCost: cost ? cost.amount.toFixed(6) : null,
          finishedAt: ctx.now(),
        })
        .where(and(eq(modelRuns.id, run.id), eq(modelRuns.status, "running")))
        .returning();
      if (!finished) {
        throw new AppError(
          "CONFLICT",
          "This attempt was closed by a newer attempt of the same work. Its result was not stored.",
          { stage: spec.stage },
        );
      }
      const output = await outcome.persist(tx, finished);
      return { modelRun: finished, output };
    });
  } catch (error) {
    if (undo) await undo().catch(() => undefined);
    const safe = toSafeError(ctx, error, spec.stage, run.id);
    await failRun(ctx, run.id, safe, startedMs);
    throw safe;
  }
}

// ---------------------------------------------------------------------------
// Loading the source and its context
// ---------------------------------------------------------------------------

type UtteranceContext = {
  utterance: typeof utterances.$inferSelect;
  sessionId: string;
  sessionMode: StudyMode;
  studyId: string;
  studySlug: string;
};

async function loadUtteranceContext(ctx: ServiceContext, utteranceId: string): Promise<UtteranceContext> {
  const [row] = await ctx.db
    .select({
      utterance: utterances,
      sessionId: sessions.id,
      sessionMode: sessions.mode,
      studyId: studies.id,
      studySlug: studies.slug,
    })
    .from(utterances)
    .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
    .innerJoin(studies, eq(studies.id, sessions.studyId))
    .where(eq(utterances.id, utteranceId))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Utterance not found.", { utteranceId });
  return row;
}

// A batch only processes data of its own mode, so research outputs never sit in
// a demo or test batch or the reverse (docs/DATA-MODEL.md, "data reset").
async function assertBatchMatchesSource(
  ctx: ServiceContext,
  processingBatchId: string | null,
  source: UtteranceContext,
): Promise<void> {
  if (!processingBatchId) return;
  const [batch] = await ctx.db
    .select({ id: processingBatches.id, dataMode: processingBatches.dataMode, studyId: processingBatches.studyId })
    .from(processingBatches)
    .where(eq(processingBatches.id, processingBatchId))
    .limit(1);
  if (!batch) throw new AppError("NOT_FOUND", "Processing batch not found.", { processingBatchId });
  if (batch.studyId !== source.studyId) {
    throw new AppError("INVALID_STATE", "The processing batch belongs to another study than the source data.", {
      processingBatchId,
    });
  }
  if (batch.dataMode !== source.sessionMode) {
    throw new AppError(
      "INVALID_STATE",
      `A ${batch.dataMode} batch cannot process data of a ${source.sessionMode} session.`,
      { processingBatchId, batchDataMode: batch.dataMode, sessionMode: source.sessionMode },
    );
  }
}

async function loadRevisionContext(ctx: ServiceContext, revisionId: string) {
  const [row] = await ctx.db
    .select({ revision: transcriptRevisions, transcript: transcripts })
    .from(transcriptRevisions)
    .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
    .where(eq(transcriptRevisions.id, revisionId))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Transcript revision not found.", { transcriptRevisionId: revisionId });
  return row;
}

async function readStoredObject(ctx: ServiceContext, key: string): Promise<Buffer> {
  const stream = await ctx.storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function sha256OfText(text: string): string {
  return sha256OfBuffer(Buffer.from(text, "utf8"));
}

// Takes a typed value out of the free parameter record of a model configuration.
function takeString(parameters: ModelParameters, key: string): string | undefined {
  const value = parameters[key];
  delete parameters[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_ERROR", `The model configuration parameter "${key}" must be text.`, { key });
  }
  return value.length > 0 ? value : undefined;
}

const SOURCE_AUDIO_KINDS = ["source_audio", "source_audio_raw", "source_audio_derived"] as const;

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/aac": "aac",
};

function audioFileName(asset: MediaAssetRow): string {
  const fromKey = /\.([a-z0-9]{1,8})$/i.exec(asset.storageKey)?.[1]?.toLowerCase();
  const mime = (asset.mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return `utterance.${AUDIO_EXTENSIONS[mime] ?? fromKey ?? "wav"}`;
}

// ---------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------

export type RunAsrStepInput = {
  utteranceId: string;
  // Default: the accepted recording of the utterance.
  mediaAssetId?: string;
  modelConfig: ModelConfigSnapshot;
  processingBatchId: string | null;
  // Base key of the logical work, see asrStepKey.
  idempotencyKey: string;
  // Only when a price table is configured. Without it estimated_cost stays null.
  pricing?: PricingTable | null;
};

export type AsrStepResult = {
  // False when the work had already succeeded and the stored output is returned.
  created: boolean;
  modelRun: ModelRunRow;
  transcript: TranscriptRow;
  revision: TranscriptRevisionRow;
};

// Transcribes the accepted recording of one utterance and stores the exact
// output as a new revision of the utterance's `asr` transcript. The new
// revision becomes the current one. Earlier ASR revisions are kept.
//
// The ASR transcript is a model output, so this step never sets a review
// status: a new `asr` transcript row keeps the column default `not_started`
// and an existing row keeps whatever status it has.
export async function runAsrStep(ctx: ServiceContext, input: RunAsrStepInput): Promise<AsrStepResult> {
  assertStage(input.modelConfig, "asr");
  assertBaseKey(input.idempotencyKey);
  const source = await loadUtteranceContext(ctx, input.utteranceId);
  const assetId = input.mediaAssetId ?? source.utterance.acceptedMediaAssetId;
  if (!assetId) {
    throw new AppError("INVALID_STATE", "The utterance has no accepted recording to transcribe.", {
      utteranceId: input.utteranceId,
    });
  }
  const [asset] = await ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
  if (!asset) throw new AppError("MEDIA_NOT_FOUND", "The recording was not found.", { mediaAssetId: assetId });
  if (asset.utteranceId !== input.utteranceId) {
    throw new AppError("VALIDATION_ERROR", "The recording belongs to another utterance.", {
      mediaAssetId: assetId,
      utteranceId: input.utteranceId,
    });
  }
  if (!(SOURCE_AUDIO_KINDS as readonly string[]).includes(asset.kind)) {
    throw new AppError("VALIDATION_ERROR", `A ${asset.kind} file is not a source recording.`, { mediaAssetId: assetId });
  }
  if (asset.deletedAt) {
    throw new AppError("MEDIA_NOT_FOUND", "The recording was deleted and can no longer be transcribed.", {
      mediaAssetId: assetId,
    });
  }
  assertProviderAllowedForMode(input.modelConfig, source.sessionMode);
  await assertBatchMatchesSource(ctx, input.processingBatchId, source);

  const baseSpec = { stage: "asr" as const, baseKey: input.idempotencyKey, sourceEntityId: input.utteranceId };
  const earlier = await findAttempts(ctx, baseSpec);
  const succeeded = earlier.find((run) => run.status === "succeeded");
  if (succeeded) {
    const [existing] = await ctx.db
      .select({ revision: transcriptRevisions, transcript: transcripts })
      .from(transcriptRevisions)
      .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
      .where(eq(transcriptRevisions.sourceModelRunId, succeeded.id))
      .limit(1);
    if (!existing) {
      throw new AppError("INTERNAL_ERROR", "A succeeded ASR run has no transcript revision.", { modelRunId: succeeded.id });
    }
    return { created: false, modelRun: succeeded, transcript: existing.transcript, revision: existing.revision };
  }

  // Language hint and context prompt are typed adapter inputs, not parameters.
  const parameters: ModelParameters = { ...input.modelConfig.parameters };
  const language = takeString(parameters, "language");
  // The response format decides which fields the provider returns (segments,
  // word timestamps). It is always sent and recorded, never left to the adapter.
  const responseFormat = takeString(parameters, "response_format") ?? ASR_RESPONSE_FORMAT_WHEN_NOT_CONFIGURED;
  const adapterParameters: ModelParameters = { ...parameters, response_format: responseFormat };
  const promptText = input.modelConfig.promptText ?? "";
  // An empty prompt text means that no context prompt is sent.
  const prompt = promptText.trim().length > 0 ? promptText : undefined;
  const fileName = audioFileName(asset);

  const spec: RunSpec = {
    ...baseSpec,
    modelConfig: input.modelConfig,
    processingBatchId: input.processingBatchId,
    conditionKey: input.modelConfig.conditionKey,
    sourceEntityType: "utterance",
    parameters: {
      model: input.modelConfig.modelId,
      ...(language ? { language } : {}),
      ...(prompt ? { prompt } : {}),
      ...adapterParameters,
    },
    manifest: {
      utteranceId: input.utteranceId,
      mediaAssetId: asset.id,
      mediaSha256: asset.sha256,
      mediaKind: asset.kind,
      mediaMimeType: asset.mimeType,
      ...(language ? { sourceLanguage: language } : {}),
      ...(prompt ? { effectiveInstruction: prompt } : {}),
      ...(input.modelConfig.promptVersionId ? { promptVersionId: input.modelConfig.promptVersionId } : {}),
      modelConfigId: input.modelConfig.modelConfigId,
    },
    pricing: input.pricing,
  };

  const { modelRun, output } = await executeModelRun(ctx, spec, earlier, async () => {
    const audio = await readStoredObject(ctx, asset.storageKey);
    if (sha256OfBuffer(audio) !== asset.sha256) {
      throw new AppError("STORAGE_ERROR", "The stored recording does not match its recorded SHA-256.", {
        mediaAssetId: asset.id,
      });
    }
    const result = await ctx.providers.transcriber(input.modelConfig.provider).transcribe({
      audio,
      fileName,
      mimeType: asset.mimeType,
      model: input.modelConfig.modelId,
      ...(language ? { language } : {}),
      ...(prompt ? { prompt } : {}),
      parameters: adapterParameters,
    });
    const hasTiming = result.segments !== undefined || result.words !== undefined;
    return {
      result,
      responseMetadata: {
        ...(result.detectedLanguage !== undefined ? { detectedLanguage: result.detectedLanguage } : {}),
        ...(result.durationSeconds !== undefined ? { durationSeconds: result.durationSeconds } : {}),
      },
      persist: async (tx: Transaction, run: ModelRunRow) => {
        await tx
          .insert(transcripts)
          .values({ utteranceId: input.utteranceId, type: "asr" })
          .onConflictDoNothing({ target: [transcripts.utteranceId, transcripts.type] });
        // The row lock serializes two ASR runs of the same utterance.
        const [transcript] = await tx
          .select()
          .from(transcripts)
          .where(and(eq(transcripts.utteranceId, input.utteranceId), eq(transcripts.type, "asr")))
          .for("update");
        if (!transcript) throw new AppError("DATABASE_ERROR", "The ASR transcript row could not be created.");
        const [latest] = await tx
          .select({ value: sql<number>`coalesce(max(${transcriptRevisions.revisionNumber}), 0)::int` })
          .from(transcriptRevisions)
          .where(eq(transcriptRevisions.transcriptId, transcript.id));
        await tx
          .update(transcriptRevisions)
          .set({ isCurrent: false })
          .where(and(eq(transcriptRevisions.transcriptId, transcript.id), eq(transcriptRevisions.isCurrent, true)));
        const [revision] = await tx
          .insert(transcriptRevisions)
          .values({
            transcriptId: transcript.id,
            revisionNumber: (latest?.value ?? 0) + 1,
            // Exact provider output, including an empty text for a silent recording.
            text: result.text,
            // Segments and words exactly as the adapter returned them. The
            // OpenAI adapter fills a field the provider left out with 0 or ""
            // (docs/AI-PROVENANCE.md, "ASR segments").
            segmentsJson: hasTiming
              ? {
                  ...(result.segments !== undefined ? { segments: result.segments } : {}),
                  ...(result.words !== undefined ? { words: result.words } : {}),
                }
              : null,
            sourceModelRunId: run.id,
            createdByType: "model",
            createdByLabel: `${run.provider}/${run.requestedModel}`,
            isCurrent: true,
            createdAt: ctx.now(),
          })
          .returning();
        if (!revision) throw new AppError("DATABASE_ERROR", "The ASR transcript revision could not be stored.");
        await tx.update(transcripts).set({ updatedAt: ctx.now() }).where(eq(transcripts.id, transcript.id));
        return { transcript, revision };
      },
    };
  });
  return { created: true, modelRun, transcript: output.transcript, revision: output.revision };
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

export type RunTranslationStepInput = {
  sourceTranscriptRevisionId: string;
  modelConfig: ModelConfigSnapshot;
  conditionKey: string;
  processingBatchId: string;
  repetitionIndex?: number;
  // Base key of the logical work, see translationStepKey.
  idempotencyKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  // When given, the revision must belong to this utterance. The check runs
  // before any model call.
  expectedUtteranceId?: string;
  pricing?: PricingTable | null;
};

export type TranslationStepResult = {
  created: boolean;
  modelRun: ModelRunRow;
  translation: TranslationRow;
};

async function loadRun(ctx: ServiceContext, modelRunId: string): Promise<ModelRunRow> {
  const [run] = await ctx.db.select().from(modelRuns).where(eq(modelRuns.id, modelRunId)).limit(1);
  if (!run) throw new AppError("INTERNAL_ERROR", "An output row points at a model run that does not exist.", { modelRunId });
  return run;
}

// Translates the text of one transcript revision under one condition. The
// provider receives the instruction of the prompt version and the transcript
// text, nothing else (spec 65). The raw model output is stored unchanged.
export async function runTranslationStep(
  ctx: ServiceContext,
  input: RunTranslationStepInput,
): Promise<TranslationStepResult> {
  assertStage(input.modelConfig, "translation");
  assertBaseKey(input.idempotencyKey);
  const repetitionIndex = input.repetitionIndex ?? 0;
  if (!input.conditionKey) throw new AppError("VALIDATION_ERROR", "A translation needs a condition key.");

  const { revision, transcript } = await loadRevisionContext(ctx, input.sourceTranscriptRevisionId);
  if (input.expectedUtteranceId && transcript.utteranceId !== input.expectedUtteranceId) {
    throw new AppError("VALIDATION_ERROR", "The transcript revision belongs to another utterance.", {
      transcriptRevisionId: revision.id,
      expectedUtteranceId: input.expectedUtteranceId,
    });
  }
  const source = await loadUtteranceContext(ctx, transcript.utteranceId);
  assertProviderAllowedForMode(input.modelConfig, source.sessionMode);
  await assertBatchMatchesSource(ctx, input.processingBatchId, source);

  // Last line of defense: the output identity is unique in the database.
  const [existing] = await ctx.db
    .select()
    .from(translations)
    .where(
      and(
        eq(translations.sourceTranscriptRevisionId, revision.id),
        eq(translations.conditionKey, input.conditionKey),
        eq(translations.processingBatchId, input.processingBatchId),
        eq(translations.repetitionIndex, repetitionIndex),
      ),
    )
    .limit(1);
  if (existing) {
    return { created: false, modelRun: await loadRun(ctx, existing.modelRunId), translation: existing };
  }

  const baseSpec = { stage: "translation" as const, baseKey: input.idempotencyKey, sourceEntityId: revision.id };
  const earlier = await findAttempts(ctx, baseSpec);

  const promptText = input.modelConfig.promptText;
  if (promptText === null || promptText.trim().length === 0) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The translation configuration "${input.modelConfig.key}" has no prompt version with an instruction. A translation is never run without an explicit prompt.`,
      { modelConfigId: input.modelConfig.modelConfigId },
    );
  }
  const request = buildTranslationRequest({
    promptText,
    sourceText: revision.text,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
  });
  const parameters: ModelParameters = { ...input.modelConfig.parameters };

  const spec: RunSpec = {
    ...baseSpec,
    modelConfig: input.modelConfig,
    processingBatchId: input.processingBatchId,
    conditionKey: input.conditionKey,
    sourceEntityType: "transcript_revision",
    parameters: { model: input.modelConfig.modelId, ...parameters },
    manifest: {
      utteranceId: transcript.utteranceId,
      transcriptRevisionId: revision.id,
      transcriptType: transcript.type as TranscriptType,
      textSha256: sha256OfText(revision.text),
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      effectiveInstruction: request.effectiveInstruction,
      ...(input.modelConfig.promptVersionId ? { promptVersionId: input.modelConfig.promptVersionId } : {}),
      modelConfigId: input.modelConfig.modelConfigId,
      repetitionIndex,
    },
    pricing: input.pricing,
  };

  const { modelRun, output } = await executeModelRun(ctx, spec, earlier, async () => {
    const result = await ctx.providers.translator(input.modelConfig.provider).translate({
      model: input.modelConfig.modelId,
      instruction: request.instruction,
      sourceText: request.input,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      parameters,
    });
    if (result.rawText.trim().length === 0) {
      // Spec 146: a translation must not be empty. The run is stored as failed,
      // with the raw answer and the response metadata.
      throw new AppError("TRANSLATION_PROVIDER_ERROR", "The model returned an empty translation.", {
        provider: result.provider,
        providerRequestId: result.providerRequestId,
        providerErrorCode: "empty_output",
        rawText: result.rawText,
        rawMetadata: result.rawMetadata,
        parametersSent: result.parametersSent,
        returnedModel: result.returnedModel,
      });
    }
    return {
      result,
      persist: async (tx: Transaction, run: ModelRunRow) => {
        const [translation] = await tx
          .insert(translations)
          .values({
            sourceTranscriptRevisionId: revision.id,
            conditionKey: input.conditionKey,
            processingBatchId: input.processingBatchId,
            modelRunId: run.id,
            // Raw model output: not trimmed, not re-punctuated (spec 146, 147).
            translatedText: result.rawText,
            targetLanguage: input.targetLanguage,
            repetitionIndex,
            createdAt: ctx.now(),
          })
          .returning();
        if (!translation) throw new AppError("DATABASE_ERROR", "The translation could not be stored.");
        return translation;
      },
    };
  });
  return { created: true, modelRun, translation: output };
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export type RunSynthesisStepInput = {
  translationId: string;
  modelConfig: ModelConfigSnapshot;
  conditionKey: string;
  processingBatchId: string;
  repetitionIndex?: number;
  // Base key of the logical work, see synthesisStepKey.
  idempotencyKey: string;
  pricing?: PricingTable | null;
};

export type SynthesisStepResult = {
  created: boolean;
  modelRun: ModelRunRow;
  synthesis: SynthesisRow;
  mediaAsset: MediaAssetRow;
};

type AudioDescription = {
  container: string | null;
  codec: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  bitDepth: number | null;
  durationMs: number | null;
  // How the values were found: "wav_header", "ffprobe" or "unknown".
  source: string;
};

const UNKNOWN_AUDIO: AudioDescription = {
  container: null,
  codec: null,
  sampleRateHz: null,
  channels: null,
  bitDepth: null,
  durationMs: null,
  source: "unknown",
};

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

// Technical metadata of the returned audio, read from the bytes themselves. A
// streamed WAV can declare a data size that is not the real one, so the
// duration is computed from the bytes that are really there. Fields that cannot
// be determined stay null. Nothing is guessed.
export async function describeSynthesizedAudio(audio: Buffer, format: string): Promise<AudioDescription> {
  if (isWavBuffer(audio)) {
    try {
      const header = parseWavHeader(audio, { headerOnly: true });
      const available = Math.max(0, audio.length - header.dataOffset);
      const dataBytes = Math.min(header.dataBytes, available);
      const frames = header.blockAlign > 0 ? Math.floor(dataBytes / header.blockAlign) : 0;
      const storedBits = header.channels > 0 ? (header.blockAlign / header.channels) * 8 : header.bitDepth;
      const codec =
        header.audioFormat === "ieee_float"
          ? `pcm_f${storedBits}le`
          : storedBits === 8
            ? "pcm_u8"
            : `pcm_s${storedBits}le`;
      return {
        container: "wav",
        codec,
        sampleRateHz: positiveOrNull(header.sampleRateHz),
        channels: positiveOrNull(header.channels),
        bitDepth: positiveOrNull(header.bitDepth),
        durationMs: header.sampleRateHz > 0 ? Math.round((frames / header.sampleRateHz) * 1000) : null,
        source: "wav_header",
      };
    } catch {
      // Not a PCM WAV the parser understands: try ffprobe below.
    }
  }
  if (format === "pcm") return UNKNOWN_AUDIO; // raw samples have no header to read
  try {
    const probe = await probeAudio(audio);
    return {
      container: probe.container ?? null,
      codec: probe.codec,
      sampleRateHz: positiveOrNull(probe.sampleRateHz),
      channels: positiveOrNull(probe.channels),
      bitDepth: positiveOrNull(probe.bitDepth),
      durationMs: probe.durationMs !== null && probe.durationMs >= 0 ? Math.round(probe.durationMs) : null,
      source: "ffprobe",
    };
  } catch {
    return UNKNOWN_AUDIO;
  }
}

// True when the `instructions` parameter of a configuration holds a text.
function hasInstructionsParameter(parameters: ModelParameters): boolean {
  const value = parameters.instructions;
  return typeof value === "string" && value.length > 0;
}

// A TTS configuration names its speaking instruction in one place only.
export function assertSingleTtsInstruction(
  config: Pick<ModelConfigSnapshot, "key" | "versionNumber" | "modelConfigId" | "promptVersionId" | "parameters">,
  parameterInstructions: string | undefined = hasInstructionsParameter(config.parameters) ? "set" : undefined,
): void {
  if (!config.promptVersionId || parameterInstructions === undefined) return;
  throw new AppError(
    "CONFIGURATION_MISSING",
    `The TTS configuration "${config.key}" version ${config.versionNumber} has a linked prompt version and an "instructions" parameter. Only one speaking instruction can be sent. Create a new configuration version that keeps one of the two.`,
    { modelConfigId: config.modelConfigId },
  );
}

// Synthesizes the exact stored text of one translation. The text is stored
// again on the synthesis row as a snapshot, the audio goes to storage and gets
// a media_assets row of kind `tts_audio`.
export async function runSynthesisStep(ctx: ServiceContext, input: RunSynthesisStepInput): Promise<SynthesisStepResult> {
  assertStage(input.modelConfig, "tts");
  assertBaseKey(input.idempotencyKey);
  const repetitionIndex = input.repetitionIndex ?? 0;
  if (!input.conditionKey) throw new AppError("VALIDATION_ERROR", "A synthesis needs a condition key.");

  const [translation] = await ctx.db
    .select()
    .from(translations)
    .where(eq(translations.id, input.translationId))
    .limit(1);
  if (!translation) throw new AppError("NOT_FOUND", "Translation not found.", { translationId: input.translationId });
  const { revision, transcript } = await loadRevisionContext(ctx, translation.sourceTranscriptRevisionId);
  const source = await loadUtteranceContext(ctx, transcript.utteranceId);
  assertProviderAllowedForMode(input.modelConfig, source.sessionMode);
  await assertBatchMatchesSource(ctx, input.processingBatchId, source);

  const [existing] = await ctx.db
    .select()
    .from(syntheses)
    .where(
      and(
        eq(syntheses.translationId, translation.id),
        eq(syntheses.conditionKey, input.conditionKey),
        eq(syntheses.processingBatchId, input.processingBatchId),
        eq(syntheses.repetitionIndex, repetitionIndex),
      ),
    )
    .limit(1);
  if (existing) {
    const [asset] = await ctx.db.select().from(mediaAssets).where(eq(mediaAssets.id, existing.mediaAssetId)).limit(1);
    if (!asset) throw new AppError("INTERNAL_ERROR", "A synthesis points at a media row that does not exist.");
    return { created: false, modelRun: await loadRun(ctx, existing.modelRunId), synthesis: existing, mediaAsset: asset };
  }

  const baseSpec = { stage: "tts" as const, baseKey: input.idempotencyKey, sourceEntityId: translation.id };
  const earlier = await findAttempts(ctx, baseSpec);

  // Voice, output format and speaking instruction are typed adapter inputs.
  const parameters: ModelParameters = { ...input.modelConfig.parameters };
  const voice = takeString(parameters, "voice");
  const responseFormat = takeString(parameters, "response_format");
  const parameterInstructions = takeString(parameters, "instructions");
  if (!voice) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The TTS configuration "${input.modelConfig.key}" has no voice. A voice is never chosen automatically.`,
      { modelConfigId: input.modelConfig.modelConfigId },
    );
  }
  if (responseFormat !== undefined && !(SYNTHESIS_OUTPUT_FORMATS as readonly string[]).includes(responseFormat)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The TTS output format "${responseFormat}" is not supported. Supported: ${SYNTHESIS_OUTPUT_FORMATS.join(", ")}.`,
      { modelConfigId: input.modelConfig.modelConfigId },
    );
  }
  // Always sent and recorded, never left to the adapter.
  const outputFormat = (responseFormat as SynthesisOutputFormat | undefined) ?? TTS_OUTPUT_FORMAT_WHEN_NOT_CONFIGURED;
  // The instruction text comes from the linked prompt version. A configuration
  // without a prompt version may carry it in its `instructions` parameter. A
  // configuration with both is refused: one of the two texts would be dropped
  // without anyone noticing. The AI configuration service refuses it when the
  // configuration is saved, this check covers rows that reached the database
  // another way.
  assertSingleTtsInstruction(input.modelConfig, parameterInstructions);
  const request = buildSynthesisRequest({
    promptText: input.modelConfig.promptVersionId ? input.modelConfig.promptText : (parameterInstructions ?? null),
    text: translation.translatedText,
    targetLanguage: translation.targetLanguage,
  });

  const spec: RunSpec = {
    ...baseSpec,
    modelConfig: input.modelConfig,
    processingBatchId: input.processingBatchId,
    conditionKey: input.conditionKey,
    sourceEntityType: "translation",
    parameters: {
      model: input.modelConfig.modelId,
      voice,
      response_format: outputFormat,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      ...parameters,
    },
    manifest: {
      utteranceId: transcript.utteranceId,
      transcriptRevisionId: revision.id,
      transcriptType: transcript.type as TranscriptType,
      translationId: translation.id,
      textSha256: sha256OfText(translation.translatedText),
      targetLanguage: translation.targetLanguage,
      ...(request.effectiveInstruction ? { effectiveInstruction: request.effectiveInstruction } : {}),
      ...(input.modelConfig.promptVersionId ? { promptVersionId: input.modelConfig.promptVersionId } : {}),
      modelConfigId: input.modelConfig.modelConfigId,
      voice,
      repetitionIndex,
    },
    pricing: input.pricing,
  };

  const { modelRun, output } = await executeModelRun(ctx, spec, earlier, async () => {
    const result = await ctx.providers.synthesizer(input.modelConfig.provider).synthesize({
      model: input.modelConfig.modelId,
      text: request.input,
      voice,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      outputFormat,
      parameters,
    });
    if (result.audio.length === 0) {
      throw new AppError("TTS_PROVIDER_ERROR", "The model returned no audio.", {
        provider: result.provider,
        providerRequestId: result.providerRequestId,
        providerErrorCode: "empty_output",
        rawMetadata: result.rawMetadata,
        parametersSent: result.parametersSent,
        returnedModel: result.returnedModel,
      });
    }
    const description = await describeSynthesizedAudio(result.audio, result.format);
    const synthesisId = randomUUID();
    const assetId = randomUUID();
    const key = ttsAudioKey({ studySlug: source.studySlug, synthesisId, assetId, extension: result.format });
    const stored = await ctx.storage.put({ key, body: result.audio, contentType: result.mimeType });
    return {
      result,
      responseMetadata: {
        audio: { mimeType: result.mimeType, format: result.format, sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
      },
      undo: () => ctx.storage.delete(key),
      persist: async (tx: Transaction, run: ModelRunRow) => {
        const [asset] = await tx
          .insert(mediaAssets)
          .values({
            id: assetId,
            studyId: source.studyId,
            entityType: "synthesis",
            entityId: synthesisId,
            kind: "tts_audio",
            storageDriver: stored.driver,
            storageKey: stored.key,
            mimeType: result.mimeType,
            container: description.container,
            codec: description.codec,
            sampleRateHz: description.sampleRateHz,
            channels: description.channels,
            bitDepth: description.bitDepth,
            durationMs: description.durationMs,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            metadataJson: { technicalMetadataSource: description.source, modelRunId: run.id },
            createdAt: ctx.now(),
          })
          .returning();
        if (!asset) throw new AppError("DATABASE_ERROR", "The audio metadata could not be stored.");
        const [synthesis] = await tx
          .insert(syntheses)
          .values({
            id: synthesisId,
            translationId: translation.id,
            // Snapshot of the exact text that was sent to the speech model.
            sourceText: request.input,
            conditionKey: input.conditionKey,
            processingBatchId: input.processingBatchId,
            modelRunId: run.id,
            mediaAssetId: asset.id,
            voiceKey: voice,
            repetitionIndex,
            createdAt: ctx.now(),
          })
          .returning();
        if (!synthesis) throw new AppError("DATABASE_ERROR", "The synthesis could not be stored.");
        return { synthesis, asset };
      },
    };
  });
  return { created: true, modelRun, synthesis: output.synthesis, mediaAsset: output.asset };
}
