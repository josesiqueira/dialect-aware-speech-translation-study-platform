// Job handlers of the processing area: asr, translation, tts, derive_wav.
//
// A handler validates its payload, resolves the frozen configuration, calls one
// step function and enqueues the follow-up jobs. It is safe under redelivery:
// the step returns the stored output when the work already succeeded, and
// follow-up jobs are enqueued with deterministic idempotency keys.
//
// Errors are thrown unchanged, so the queue sees `AiProviderError.retryable`: a
// retryable provider error is retried with backoff, any other provider error or
// a configuration error fails the job at once.
import { eq } from "drizzle-orm";
import type { z } from "zod";
import {
  processingBatches,
  sessions,
  transcriptRevisions,
  transcripts,
  utterances,
  type BatchConfigurationSnapshot,
  type ModelConfigSnapshot,
} from "@dialect/db";
import { AppError, processingSchemas, type BatchStatus } from "@dialect/domain";
import type { ServiceContext } from "../context";
import { enqueueJobs, type Job } from "../jobs/queue";
import { classifyJobError, type JobHandler, type JobHandlerRegistry } from "../jobs/worker";
import {
  DEFAULT_ASR_CONFIG_KEY,
  conditionKeyOf,
  createBatch,
  refreshBatchStatus,
  startBatch,
  translationJobsForRevision,
  ttsJobsForTranslation,
} from "./batches";
import { loadActiveModelConfigSnapshot, loadModelConfigSnapshot } from "./config";
import { deriveWavForAsset } from "./derive";
import {
  assertProviderAllowedForMode,
  asrStepKey,
  runAsrStep,
  runSynthesisStep,
  runTranslationStep,
  synthesisStepKey,
  translationStepKey,
} from "./steps";

function parsePayload<S extends z.ZodType>(schema: S, job: Job): z.output<S> {
  const parsed = schema.safeParse(job.payloadJson);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(payload)").join(", ");
    throw new AppError("VALIDATION_ERROR", `The payload of the ${job.type} job is not valid: ${fields}.`, {
      jobId: job.id,
    });
  }
  return parsed.data;
}

type LoadedBatch = { id: string; status: BatchStatus; snapshot: BatchConfigurationSnapshot };

async function loadBatch(ctx: ServiceContext, batchId: string): Promise<LoadedBatch> {
  const [batch] = await ctx.db
    .select({
      id: processingBatches.id,
      status: processingBatches.status,
      snapshot: processingBatches.configurationSnapshotJson,
    })
    .from(processingBatches)
    .where(eq(processingBatches.id, batchId))
    .limit(1);
  if (!batch) throw new AppError("NOT_FOUND", "Processing batch not found.", { processingBatchId: batchId });
  if (batch.status === "draft") {
    throw new AppError("INVALID_STATE", "The processing batch has not been started.", { processingBatchId: batchId });
  }
  return batch;
}

function configOfBatch(configs: ModelConfigSnapshot[], modelConfigId: string, stage: string): ModelConfigSnapshot {
  const config = configs.find((candidate) => candidate.modelConfigId === modelConfigId);
  if (!config) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      `The ${stage} configuration of this job is not part of the frozen configuration of its batch.`,
      { modelConfigId },
    );
  }
  return config;
}

function assertUtteranceInBatch(batch: LoadedBatch, utteranceId: string): void {
  if (!batch.snapshot.utteranceIds.includes(utteranceId)) {
    throw new AppError("VALIDATION_ERROR", "The utterance is not part of the selection of this batch.", {
      utteranceId,
      processingBatchId: batch.id,
    });
  }
}

async function batchIsCancelled(ctx: ServiceContext, batchId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ status: processingBatches.status })
    .from(processingBatches)
    .where(eq(processingBatches.id, batchId))
    .limit(1);
  return row?.status === "cancelled";
}

// Runs the work of a batch job and keeps the batch status current. The handler
// runs before the queue records the result of the job, so the status the job is
// about to get is passed to refreshBatchStatus.
async function withBatchStatus(ctx: ServiceContext, job: Job, batchId: string | null, work: () => Promise<void>) {
  if (!batchId) return work();
  const refresh = async (assume?: { jobId: string; status: "succeeded" | "failed" | "queued" }) => {
    try {
      await refreshBatchStatus(ctx, batchId, assume ? { assume } : {});
    } catch (error) {
      // The status is derived again by the batch list. Never fail a job for it.
      ctx.logger.warn(
        { jobId: job.id, processingBatchId: batchId, errorName: error instanceof Error ? error.name : "value" },
        "batch status refresh failed",
      );
    }
  };
  await refresh();
  try {
    await work();
  } catch (error) {
    const failure = classifyJobError(error);
    const willRetry = failure.retryable && job.attempts < job.maxAttempts;
    await refresh({ jobId: job.id, status: willRetry ? "queued" : "failed" });
    throw error;
  }
  await refresh({ jobId: job.id, status: "succeeded" });
}

const asr: JobHandler = async ({ ctx }, job) => {
  const payload = parsePayload(processingSchemas.asrJobPayloadSchema, job);
  const batchId = payload.processingBatchId ?? job.processingBatchId ?? null;

  await withBatchStatus(ctx, job, batchId, async () => {
    let modelConfig: ModelConfigSnapshot;
    let batch: LoadedBatch | null = null;
    let automaticOwner: { studyId: string; mode: (typeof sessions.$inferSelect)["mode"]; participantCode: string } | null = null;
    if (batchId) {
      batch = await loadBatch(ctx, batchId);
      if (!batch.snapshot.asr) {
        throw new AppError("CONFIGURATION_MISSING", "The batch has no ASR configuration.", { processingBatchId: batchId });
      }
      modelConfig = payload.modelConfigId
        ? configOfBatch([batch.snapshot.asr], payload.modelConfigId, "ASR")
        : batch.snapshot.asr;
      assertUtteranceInBatch(batch, payload.utteranceId);
    } else {
      const [owner] = await ctx.db
        .select({ studyId: sessions.studyId, mode: sessions.mode, participantCode: sessions.participantCode })
        .from(utterances)
        .innerJoin(sessions, eq(sessions.id, utterances.sessionId))
        .where(eq(utterances.id, payload.utteranceId))
        .limit(1);
      if (!owner) throw new AppError("NOT_FOUND", "Utterance not found.", { utteranceId: payload.utteranceId });
      // Automatic ASR after an upload: the configuration that is active when
      // the job runs. No active configuration is an explicit error (spec 143).
      modelConfig = payload.modelConfigId
        ? await loadModelConfigSnapshot(ctx.db, {
            modelConfigId: payload.modelConfigId,
            studyId: owner.studyId,
            stage: "asr",
            requireActive: false,
          })
        : await loadActiveModelConfigSnapshot(ctx.db, {
            studyId: owner.studyId,
            key: DEFAULT_ASR_CONFIG_KEY,
            stage: "asr",
          });
      // The recording of a research session is never transcribed by the mock
      // provider. The job fails with a clear message and is not retried, and
      // the recording stays untouched until a real configuration is active.
      assertProviderAllowedForMode(modelConfig, owner.mode);
      automaticOwner = owner;
    }

    const result = await runAsrStep(ctx, {
      utteranceId: payload.utteranceId,
      ...(payload.mediaAssetId ? { mediaAssetId: payload.mediaAssetId } : {}),
      modelConfig,
      processingBatchId: batchId,
      idempotencyKey: asrStepKey({
        utteranceId: payload.utteranceId,
        modelConfigId: modelConfig.modelConfigId,
        processingBatchId: batchId,
      }),
    });

    // Translations of the ASR transcript use the revision this batch produced.
    if (
      batch &&
      batch.snapshot.transcriptTypes.includes("asr") &&
      batch.snapshot.translations.length > 0 &&
      result.revision.text.trim().length > 0 &&
      !(await batchIsCancelled(ctx, batch.id))
    ) {
      await enqueueJobs(
        ctx.db,
        translationJobsForRevision(
          batch.id,
          batch.snapshot,
          { utteranceId: payload.utteranceId, transcriptRevisionId: result.revision.id },
          ctx.now(),
        ),
      );
    }

    if (automaticOwner && autoTranslateAfterAsr() && result.revision.text.trim().length > 0) {
      await startAutomaticTranslationBatch(ctx, {
        utteranceId: payload.utteranceId,
        revisionId: result.revision.id,
        studyId: automaticOwner.studyId,
        mode: automaticOwner.mode,
        participantCode: automaticOwner.participantCode,
      });
    }
  });
};

// AUTO_TRANSLATE_AFTER_ASR=true: after the automatic ASR of an upload, the
// worker translates and synthesizes that one recording in its own processing
// batch, with the active configurations, exactly as a batch started on the
// Processing page would. The batch keeps the usual provenance.
function autoTranslateAfterAsr(): boolean {
  return (process.env.AUTO_TRANSLATE_AFTER_ASR ?? "").trim().toLowerCase() === "true";
}

// A failure here never fails the ASR job: the transcript is already stored, and
// a batch can still be started by hand.
async function startAutomaticTranslationBatch(
  ctx: ServiceContext,
  input: { utteranceId: string; revisionId: string; studyId: string; mode: (typeof sessions.$inferSelect)["mode"]; participantCode: string },
): Promise<void> {
  try {
    const batch = await createBatch(ctx, {
      studyId: input.studyId,
      name: `Auto ${input.participantCode} ${input.utteranceId.slice(0, 8)} rev ${input.revisionId.slice(0, 8)}`,
      description: "Started automatically after the ASR of an uploaded recording (AUTO_TRANSLATE_AFTER_ASR).",
      selection: {
        mode: input.mode,
        completedSessionsOnly: false,
        verifiedTranscriptsOnly: false,
        utteranceIds: [input.utteranceId],
      },
      transcriptTypes: ["asr"],
      runAsr: false,
    });
    await startBatch(ctx, batch.id);
  } catch (error) {
    ctx.logger.warn(
      { utteranceId: input.utteranceId, error: error instanceof Error ? error.message : String(error) },
      "automatic translation batch was not started",
    );
  }
}

const translation: JobHandler = async ({ ctx }, job) => {
  const payload = parsePayload(processingSchemas.translationJobPayloadSchema, job);
  const batchId = payload.processingBatchId;

  await withBatchStatus(ctx, job, batchId, async () => {
    const batch = await loadBatch(ctx, batchId);
    const modelConfig = configOfBatch(batch.snapshot.translations, payload.modelConfigId, "translation");

    // The revision must belong to an utterance of the batch, and to the
    // utterance the job was created for.
    const [owner] = await ctx.db
      .select({ utteranceId: transcripts.utteranceId })
      .from(transcriptRevisions)
      .innerJoin(transcripts, eq(transcripts.id, transcriptRevisions.transcriptId))
      .where(eq(transcriptRevisions.id, payload.sourceTranscriptRevisionId))
      .limit(1);
    if (!owner) {
      throw new AppError("NOT_FOUND", "Transcript revision not found.", {
        transcriptRevisionId: payload.sourceTranscriptRevisionId,
      });
    }
    assertUtteranceInBatch(batch, owner.utteranceId);

    const conditionKey = conditionKeyOf(modelConfig);
    const result = await runTranslationStep(ctx, {
      sourceTranscriptRevisionId: payload.sourceTranscriptRevisionId,
      modelConfig,
      conditionKey,
      processingBatchId: batchId,
      repetitionIndex: payload.repetitionIndex,
      idempotencyKey: translationStepKey({
        sourceTranscriptRevisionId: payload.sourceTranscriptRevisionId,
        conditionKey,
        modelConfigId: modelConfig.modelConfigId,
        processingBatchId: batchId,
        repetitionIndex: payload.repetitionIndex,
      }),
      sourceLanguage: batch.snapshot.sourceLanguage,
      targetLanguage: batch.snapshot.targetLanguage,
      ...(payload.utteranceId ? { expectedUtteranceId: payload.utteranceId } : {}),
    });

    if (batch.snapshot.tts.length > 0 && !(await batchIsCancelled(ctx, batch.id))) {
      await enqueueJobs(ctx.db, ttsJobsForTranslation(batch.id, batch.snapshot, result.translation.id, ctx.now()));
    }
  });
};

const tts: JobHandler = async ({ ctx }, job) => {
  const payload = parsePayload(processingSchemas.ttsJobPayloadSchema, job);
  const batchId = payload.processingBatchId;

  await withBatchStatus(ctx, job, batchId, async () => {
    const batch = await loadBatch(ctx, batchId);
    const modelConfig = configOfBatch(batch.snapshot.tts, payload.modelConfigId, "TTS");
    const conditionKey = conditionKeyOf(modelConfig);
    await runSynthesisStep(ctx, {
      translationId: payload.translationId,
      modelConfig,
      conditionKey,
      processingBatchId: batchId,
      repetitionIndex: payload.repetitionIndex,
      idempotencyKey: synthesisStepKey({
        translationId: payload.translationId,
        conditionKey,
        modelConfigId: modelConfig.modelConfigId,
        processingBatchId: batchId,
        repetitionIndex: payload.repetitionIndex,
      }),
    });
  });
};

const deriveWav: JobHandler = async ({ ctx }, job) => {
  const payload = parsePayload(processingSchemas.deriveWavJobPayloadSchema, job);
  await deriveWavForAsset(ctx, payload.mediaAssetId);
};

// Keyed by job type. The worker registers this registry.
export const jobHandlers: JobHandlerRegistry = {
  asr,
  translation,
  tts,
  derive_wav: deriveWav,
};
