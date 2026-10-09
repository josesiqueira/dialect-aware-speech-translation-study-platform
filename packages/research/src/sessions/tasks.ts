// Task flow, utterances and audio upload (spec 7 to 10, 62, 63, 79).
//
// Upload and retry sequence:
//   1. createUtterance      a row for the current turn (status "recording")
//   2. uploadUtteranceAudio validate, hash, store, insert the media row (status "uploading")
//   3. submitUtterance      link the accepted recording (status "submitted"), advance
// A recording becomes study data only at step 3. Until then it is a candidate: a
// new upload for the same utterance replaces it, and discardCandidate, withdrawal
// and abandonment remove it. After step 3 the recording can never be replaced.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  consentVersions,
  mediaAssets,
  modelConfigs,
  protocolTasks,
  sessionConsents,
  taskPresentations,
  utterances,
  type DbOrTx,
  type MediaMetadata,
  type Transaction,
  type UtteranceQuality,
} from "@dialect/db";
import { AppError, CONSENT_SCOPE_EXTERNAL_AI_PROCESSING, isAppError, sessionSchemas } from "@dialect/domain";
import {
  computeWavQuality,
  sha256OfBuffer,
  sourceAudioKey,
  validateUploadedAudio,
} from "@dialect/storage";
import type { ServiceContext } from "../context";
import { enqueueJob, type EnqueueJobInput } from "../jobs/queue";
import { DEFAULT_ASR_CONFIG_KEY } from "../processing/batches";
import {
  advanceAfterTurn,
  assertActive,
  assertNotInMaintenance,
  assertStatus,
  completePresentation,
  currentPresentation,
  currentTurnIndex,
  deleteStoredObjects,
  invalidState,
  loadTurns,
  loadUtterances,
  lockActiveSession,
  lockSession,
  removeCandidateRows,
  UPLOAD_KINDS,
  type PresentationRow,
  type SessionRef,
  type SessionRow,
  type UtteranceRow,
} from "./internal";
import { getParticipantState, taskMaxDurationSeconds } from "./state";

type ParticipantState = sessionSchemas.ParticipantState;

// A recorder that stops exactly at the limit can produce a file a little longer
// than the limit. This many seconds above the limit are still accepted.
export const DURATION_GRACE_SECONDS = 2;

const UPLOAD_FAILED_MESSAGE = "The recording could not be saved. Please try again.";
const ALREADY_SUBMITTED_MESSAGE = "This recording was already submitted and can no longer be replaced.";

// An id that belongs to another session is reported as not found, like an id
// that does not exist.
async function ownedPresentation(tx: DbOrTx, sessionId: string, presentationId: string): Promise<PresentationRow> {
  const [row] = await tx
    .select()
    .from(taskPresentations)
    .where(and(eq(taskPresentations.id, presentationId), eq(taskPresentations.sessionId, sessionId)));
  if (!row) throw new AppError("NOT_FOUND", "The task was not found.");
  return row;
}

async function ownedUtterance(tx: DbOrTx, sessionId: string, utteranceId: string): Promise<UtteranceRow> {
  const [row] = await tx
    .select()
    .from(utterances)
    .where(and(eq(utterances.id, utteranceId), eq(utterances.sessionId, sessionId)));
  if (!row) throw new AppError("NOT_FOUND", "The recording slot was not found.");
  return row;
}

function isSubmitted(utterance: UtteranceRow): boolean {
  return utterance.status === "submitted" || utterance.status === "excluded" || utterance.status === "invalid";
}

// The utterance must be the turn the participant is on right now.
async function assertCurrentTurn(tx: DbOrTx, session: SessionRow, utterance: UtteranceRow): Promise<PresentationRow> {
  const current = await currentPresentation(tx, session.id);
  if (!current || current.id !== utterance.taskPresentationId) {
    throw invalidState("This recording does not belong to the current task.");
  }
  const { turns } = await loadTurns(tx, current, session.locale);
  const rows = await loadUtterances(tx, current.id);
  if (currentTurnIndex(turns, rows) !== utterance.turnIndex) {
    throw invalidState("This recording does not belong to the current prompt.");
  }
  return current;
}

// ---------------------------------------------------------------------------
// Task flow
// ---------------------------------------------------------------------------

// Marks the current task as started. Only the next task of the stored sequence
// can start. Starting a task twice changes nothing.
export async function startTask(
  ctx: ServiceContext,
  session: SessionRef,
  presentationId: string,
): Promise<ParticipantState> {
  await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    assertStatus(locked, "recording", "Starting a task");
    const presentation = await ownedPresentation(tx, locked.id, presentationId);
    const current = await currentPresentation(tx, locked.id);
    if (!current || current.id !== presentation.id) {
      throw invalidState("Only the next task in the sequence can be started.", {
        presentationStatus: presentation.status,
      });
    }
    if (presentation.status === "started") return;
    await tx
      .update(taskPresentations)
      .set({ status: "started", startedAt: ctx.now() })
      .where(eq(taskPresentations.id, presentation.id));
  });
  return getParticipantState(ctx, session);
}

// Creates the utterance row for the current turn, or returns the existing one.
export async function createUtterance(
  ctx: ServiceContext,
  session: SessionRef,
  input: { presentationId: string; turnIndex: number },
): Promise<{ utteranceId: string; state: ParticipantState }> {
  const utteranceId = await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    assertStatus(locked, "recording", "Recording");
    const presentation = await ownedPresentation(tx, locked.id, input.presentationId);
    const current = await currentPresentation(tx, locked.id);
    if (!current || current.id !== presentation.id) {
      throw invalidState("This task is not the current task.", { presentationStatus: presentation.status });
    }
    if (presentation.status !== "started") {
      throw invalidState("The task must be started before recording.", { presentationStatus: presentation.status });
    }
    const { turns } = await loadTurns(tx, presentation, locked.locale);
    const rows = await loadUtterances(tx, presentation.id);
    const turnIndex = currentTurnIndex(turns, rows);
    const turn = turns[input.turnIndex];
    if (turnIndex !== input.turnIndex || !turn) {
      throw invalidState("This prompt is not the current prompt of the task.", { currentTurnIndex: turnIndex });
    }
    const existing = rows.find((row) => row.turnIndex === turn.turnIndex);
    if (existing) return existing.id;
    const [created] = await tx
      .insert(utterances)
      .values({
        sessionId: locked.id,
        taskPresentationId: presentation.id,
        followupId: turn.followupId,
        // The exact text the participant answers (spec 77).
        promptSnapshot: turn.promptText,
        turnIndex: turn.turnIndex,
        status: "recording",
      })
      .returning({ id: utterances.id });
    if (!created) throw new AppError("DATABASE_ERROR", "The recording slot could not be created.");
    return created.id;
  });
  return { utteranceId, state: await getParticipantState(ctx, session) };
}

// Skips an optional follow-up turn. The utterance row of the skipped turn (and an
// uploaded candidate) is removed. When another turn follows, its row is created at
// once, so the skip stays visible as a gap in the turn indexes of the presentation.
export async function skipTurn(
  ctx: ServiceContext,
  session: SessionRef,
  input: { utteranceId: string },
): Promise<ParticipantState> {
  const removedKeys = await ctx.db.transaction(async (tx) => {
    const { session: locked } = await lockActiveSession(tx, session.id);
    assertStatus(locked, "recording", "Skipping a prompt");
    const utterance = await ownedUtterance(tx, locked.id, input.utteranceId);
    if (isSubmitted(utterance)) throw invalidState("A submitted recording cannot be skipped.");
    const presentation = await assertCurrentTurn(tx, locked, utterance);
    const { turns } = await loadTurns(tx, presentation, locked.locale);
    const turn = turns[utterance.turnIndex];
    if (!turn || !turn.isOptional) {
      throw invalidState("This prompt must be answered and cannot be skipped.");
    }
    const keys = await removeCandidateRows(tx, { sessionId: locked.id, utteranceId: utterance.id });
    await tx.delete(utterances).where(eq(utterances.id, utterance.id));
    const next = turns[utterance.turnIndex + 1];
    if (next) {
      await tx.insert(utterances).values({
        sessionId: locked.id,
        taskPresentationId: presentation.id,
        followupId: next.followupId,
        promptSnapshot: next.promptText,
        turnIndex: next.turnIndex,
        status: "recording",
      });
    } else {
      await completePresentation(tx, locked, presentation, ctx.now());
    }
    return keys;
  });
  await deleteStoredObjects(ctx, removedKeys);
  return getParticipantState(ctx, session);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export type UploadUtteranceAudioInput = {
  utteranceId: string;
  data: Buffer;
  // Content type sent by the browser. Stored as declared metadata only.
  declaredMimeType?: string | null;
  captureMetadata?: sessionSchemas.CaptureMetadata | null;
};

// Checks that the utterance can take an upload and returns what the upload needs.
async function loadUploadTarget(tx: DbOrTx, sessionId: string, utteranceId: string) {
  const locked = await lockSession(tx, sessionId);
  const utterance = await ownedUtterance(tx, locked.session.id, utteranceId);
  // Clear message first. The database trigger is the safety net behind it.
  if (isSubmitted(utterance)) throw new AppError("IMMUTABLE_RECORD", ALREADY_SUBMITTED_MESSAGE);
  assertActive(locked.session);
  assertNotInMaintenance(locked.settings);
  assertStatus(locked.session, "recording", "Uploading a recording");
  const presentation = await assertCurrentTurn(tx, locked.session, utterance);
  const [task] = await tx
    .select({ maxDurationSeconds: protocolTasks.maxDurationSeconds })
    .from(protocolTasks)
    .where(eq(protocolTasks.id, presentation.protocolTaskId));
  return { ...locked, utterance, taskMaxSeconds: task?.maxDurationSeconds ?? null };
}

// Validates and stores one recording as the candidate of an utterance.
//
// Order of the writes: validation, then the storage write, then the database row.
// - Validation fails: nothing was written.
// - The storage write fails: no row exists. The browser keeps its recording and retries.
// - The database insert fails: the stored object is deleted again.
// An earlier candidate of the same utterance (a retry or a re-record) is replaced:
// its row is deleted in the same transaction that inserts the new row, and its
// object is deleted after the commit.
export async function uploadUtteranceAudio(
  ctx: ServiceContext,
  session: SessionRef,
  input: UploadUtteranceAudioInput,
): Promise<sessionSchemas.UploadAudioResponse> {
  const target = await ctx.db.transaction((tx) => loadUploadTarget(tx, session.id, input.utteranceId));
  const { settings, study } = target;

  // Nothing the browser claims about the file is trusted (spec 63).
  const validated = await validateUploadedAudio({
    data: input.data,
    declaredMimeType: input.declaredMimeType ?? undefined,
    maxBytes: settings.maxUploadMb * 1024 * 1024,
    maxDurationSeconds: taskMaxDurationSeconds(target.taskMaxSeconds, settings) + DURATION_GRACE_SECONDS,
  });
  const sha256 = sha256OfBuffer(input.data);

  // Informational only. Nothing is rejected or excluded because of it (spec 84).
  let quality: UtteranceQuality | null = null;
  if (validated.container === "wav") {
    try {
      quality = computeWavQuality(input.data);
    } catch {
      quality = null;
    }
  }

  const assetId = randomUUID();
  const storageKey = sourceAudioKey({
    studySlug: study.slug,
    sessionId: target.session.id,
    utteranceId: target.utterance.id,
    assetId,
    extension: validated.extension,
  });

  try {
    const stored = await ctx.storage.put({ key: storageKey, body: input.data, contentType: validated.mimeType });
    if (stored.sha256 !== sha256 || stored.sizeBytes !== input.data.length) {
      throw new Error("The stored object does not match the uploaded bytes.");
    }
  } catch (error) {
    // put() may have written the object before the comparison failed.
    await deleteStoredObjects(ctx, [storageKey]);
    throw new AppError("UPLOAD_FAILED", UPLOAD_FAILED_MESSAGE, { stage: "storage" }, { cause: error });
  }

  const capture = input.captureMetadata ?? {};
  // Device identifiers and the raw device label are never stored (spec 6.2).
  // The request schema already removes them. This is the second layer, for
  // callers that do not go through the schema.
  const metadata: MediaMetadata = {
    ...(capture.requestedConstraints
      ? { requestedConstraints: sessionSchemas.stripDeviceIdentifiers(capture.requestedConstraints) }
      : {}),
    ...(capture.actualTrackSettings
      ? { actualTrackSettings: sessionSchemas.stripDeviceIdentifiers(capture.actualTrackSettings) }
      : {}),
    ...(capture.audioContextSampleRate ? { audioContextSampleRate: capture.audioContextSampleRate } : {}),
    ...(capture.userAgent ? { browserUserAgent: capture.userAgent } : {}),
    probe: validated.probe,
    // What the browser said about the file. Never used as the technical truth.
    declared: {
      mimeType: input.declaredMimeType ?? null,
      mimeTypeMatches: validated.declaredMimeTypeMatches,
      durationMs: capture.declaredDurationMs ?? null,
      sampleRateHz: capture.declaredSampleRateHz ?? null,
      channels: capture.declaredChannels ?? null,
      // Further facts reported by the browser recorder. Present only when sent.
      ...(capture.declaredBitDepth !== undefined ? { bitDepth: capture.declaredBitDepth } : {}),
      // The class of the input device (built_in, usb, bluetooth, headset, unknown).
      ...(capture.deviceLabel !== undefined
        ? { deviceLabel: sessionSchemas.toInputDeviceClass(capture.deviceLabel) }
        : {}),
      ...(capture.constraintMismatches !== undefined ? { constraintMismatches: capture.constraintMismatches } : {}),
      ...(capture.fallbackReason !== undefined ? { fallbackReason: capture.fallbackReason } : {}),
      ...(capture.fallbackDetail !== undefined ? { fallbackDetail: capture.fallbackDetail } : {}),
      ...(capture.inputChannelCount !== undefined ? { inputChannelCount: capture.inputChannelCount } : {}),
      ...(capture.clippedSampleCount !== undefined ? { clippedSampleCount: capture.clippedSampleCount } : {}),
      ...(capture.peak !== undefined ? { peak: capture.peak } : {}),
      ...(capture.stoppedBy !== undefined ? { stoppedBy: capture.stoppedBy } : {}),
    },
    ...(quality ? { quality } : {}),
  };

  let replacedKeys: string[];
  try {
    replacedKeys = await ctx.db.transaction(async (tx) => {
      // The state may have changed while the file was validated and stored.
      const again = await loadUploadTarget(tx, session.id, input.utteranceId);
      const keys = await removeCandidateRows(tx, { sessionId: again.session.id, utteranceId: again.utterance.id });
      await tx.insert(mediaAssets).values({
        id: assetId,
        studyId: study.id,
        sessionId: again.session.id,
        utteranceId: again.utterance.id,
        entityType: "utterance",
        entityId: again.utterance.id,
        // Lossless PCM WAV is the source recording. A compressed fallback is kept
        // unchanged as the raw source, and a WAV is derived from it later (spec 31.2, 64).
        kind: validated.captureQualityClass === "lossless_pcm" ? "source_audio" : "source_audio_raw",
        storageDriver: ctx.storage.driver,
        storageKey,
        mimeType: validated.mimeType,
        container: validated.container,
        codec: validated.codec,
        sampleRateHz: validated.sampleRateHz,
        channels: validated.channels,
        bitDepth: validated.bitDepth,
        durationMs: validated.durationMs,
        sizeBytes: validated.sizeBytes,
        sha256,
        captureMethod:
          capture.captureMethod ?? (validated.container === "wav" ? "audio_worklet_pcm" : "media_recorder"),
        captureQualityClass: validated.captureQualityClass,
        metadataJson: metadata,
        createdAt: ctx.now(),
      });
      await tx.update(utterances).set({ status: "uploading" }).where(eq(utterances.id, again.utterance.id));
      return keys;
    });
  } catch (error) {
    await deleteStoredObjects(ctx, [storageKey]);
    if (isAppError(error)) throw error;
    throw new AppError("UPLOAD_FAILED", UPLOAD_FAILED_MESSAGE, { stage: "database" }, { cause: error });
  }
  await deleteStoredObjects(ctx, replacedKeys);

  return {
    mediaAssetId: assetId,
    sha256,
    durationMs: validated.durationMs,
    sizeBytes: validated.sizeBytes,
    captureQualityClass: validated.captureQualityClass,
  };
}

// Removes an uploaded recording that was not submitted (the participant records
// again after an upload). Calling it without a candidate changes nothing.
export async function discardCandidate(
  ctx: ServiceContext,
  session: SessionRef,
  input: { utteranceId: string },
): Promise<ParticipantState> {
  const removedKeys = await ctx.db.transaction(async (tx) => {
    const locked = await lockSession(tx, session.id);
    const utterance = await ownedUtterance(tx, locked.session.id, input.utteranceId);
    if (isSubmitted(utterance)) throw new AppError("IMMUTABLE_RECORD", ALREADY_SUBMITTED_MESSAGE);
    assertActive(locked.session);
    return removeCandidateRows(tx, { sessionId: locked.session.id, utteranceId: utterance.id });
  });
  await deleteStoredObjects(ctx, removedKeys);
  return getParticipantState(ctx, session);
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

// Runs the enqueue inside a savepoint. A failure rolls back only the savepoint
// and is logged: collecting speech never depends on the job queue or on AI
// availability (spec 29, 110.8).
async function enqueueWithoutFailing(ctx: ServiceContext, tx: Transaction, job: EnqueueJobInput): Promise<void> {
  try {
    // The job becomes available at the service clock, the clock the worker claims with.
    await tx.transaction((savepoint) => enqueueJob(savepoint, { availableAt: ctx.now(), ...job }));
  } catch (error) {
    ctx.logger.error(
      {
        jobType: job.type,
        idempotencyKey: job.idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "enqueueing a job after an utterance submission failed",
    );
  }
}

// Decides whether the automatic transcription of a submitted recording may be
// queued, and with which model configuration.
//
// Consent (spec 6.2, 65): audio is sent to an external AI provider automatically
// only when the stored consent of the session has an ACCEPTED item whose scope is
// `external_ai_processing`. The scope is read from the consent version the
// participant answered. A consent version without such an item gives no basis
// for automatic sending: the researcher can still run ASR in a processing batch
// after confirming the consent basis.
//
// Configuration (spec 28, 143): the active `asr_default` configuration at the
// time of the upload is pinned in the job payload, so a job that waits in the
// queue is not run with a configuration that was activated later. Without an
// active configuration nothing is queued.
export type AutoAsrDecision =
  | { queue: true; modelConfigId: string }
  | {
      queue: false;
      reason: "no_consent_record" | "no_external_ai_consent_item" | "external_ai_processing_not_accepted" | "no_active_asr_config";
    };

export async function decideAutoAsr(
  tx: DbOrTx,
  session: Pick<SessionRow, "id" | "studyId">,
): Promise<AutoAsrDecision> {
  const [consent] = await tx
    .select({ responses: sessionConsents.responsesJson, items: consentVersions.itemsJson })
    .from(sessionConsents)
    .innerJoin(consentVersions, eq(consentVersions.id, sessionConsents.consentVersionId))
    .where(eq(sessionConsents.sessionId, session.id))
    .limit(1);
  if (!consent) return { queue: false, reason: "no_consent_record" };
  const scopedItemIds = consent.items
    .filter((item) => item.scope === CONSENT_SCOPE_EXTERNAL_AI_PROCESSING)
    .map((item) => item.id);
  if (scopedItemIds.length === 0) return { queue: false, reason: "no_external_ai_consent_item" };
  const accepted = consent.responses.some(
    (response) => response.accepted === true && scopedItemIds.includes(response.itemId),
  );
  if (!accepted) return { queue: false, reason: "external_ai_processing_not_accepted" };

  const [config] = await tx
    .select({ id: modelConfigs.id })
    .from(modelConfigs)
    .where(
      and(
        eq(modelConfigs.studyId, session.studyId),
        eq(modelConfigs.key, DEFAULT_ASR_CONFIG_KEY),
        eq(modelConfigs.stage, "asr"),
        eq(modelConfigs.status, "active"),
      ),
    )
    .limit(1);
  if (!config) return { queue: false, reason: "no_active_asr_config" };
  return { queue: true, modelConfigId: config.id };
}

// Accepts the uploaded recording as the answer to the turn and advances the
// session. Everything happens in one transaction. Submitting the same recording
// again returns the current state and changes nothing.
export async function submitUtterance(
  ctx: ServiceContext,
  session: SessionRef,
  input: { utteranceId: string; mediaAssetId: string; attemptCount?: number | null },
): Promise<ParticipantState> {
  await ctx.db.transaction(async (tx) => {
    const locked = await lockSession(tx, session.id);
    const utterance = await ownedUtterance(tx, locked.session.id, input.utteranceId);
    if (isSubmitted(utterance)) {
      if (utterance.acceptedMediaAssetId === input.mediaAssetId) return;
      throw new AppError("IMMUTABLE_RECORD", ALREADY_SUBMITTED_MESSAGE);
    }
    assertActive(locked.session);
    assertNotInMaintenance(locked.settings);
    assertStatus(locked.session, "recording", "Submitting a recording");
    const presentation = await assertCurrentTurn(tx, locked.session, utterance);

    const [media] = await tx
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, input.mediaAssetId),
          eq(mediaAssets.utteranceId, utterance.id),
          inArray(mediaAssets.kind, [...UPLOAD_KINDS]),
          isNull(mediaAssets.deletedAt),
        ),
      );
    if (!media) {
      throw new AppError("MEDIA_NOT_FOUND", "The uploaded recording was not found. Please upload it again.");
    }

    const now = ctx.now();
    const quality = (media.metadataJson as MediaMetadata & { quality?: UtteranceQuality }).quality ?? null;
    await tx
      .update(utterances)
      .set({
        acceptedMediaAssetId: media.id,
        status: "submitted",
        submittedAt: now,
        durationMs: media.durationMs,
        // As reported by the browser (spec 10), never below 1.
        attemptCount: Math.max(1, Math.trunc(input.attemptCount ?? 1)),
        qualityJson: quality,
      })
      .where(eq(utterances.id, utterance.id));
    await advanceAfterTurn(tx, locked.session, presentation, now);

    // Background work (plan, "Cross-slice agreements"). Demo Mode runs its own
    // pipeline right away, so only research and test sessions get the automatic ASR job.
    if (media.kind === "source_audio_raw") {
      await enqueueWithoutFailing(ctx, tx, {
        type: "derive_wav",
        payload: { mediaAssetId: media.id },
        idempotencyKey: `derive_wav:${media.id}`,
      });
    }
    if (locked.settings.autoQueueAsr && locked.session.mode !== "demo") {
      const decision = await decideAutoAsr(tx, locked.session);
      if (decision.queue) {
        await enqueueWithoutFailing(ctx, tx, {
          type: "asr",
          payload: {
            utteranceId: utterance.id,
            mediaAssetId: media.id,
            modelConfigId: decision.modelConfigId,
            trigger: "auto_on_upload",
          },
          idempotencyKey: `asr:auto:${utterance.id}`,
        });
      } else {
        // Ids and a fixed reason only. The recording is stored either way.
        const entry = { sessionId: locked.session.id, utteranceId: utterance.id, reason: decision.reason };
        if (decision.reason === "no_active_asr_config") {
          ctx.logger.warn(entry, "automatic transcription was not queued: no active asr_default configuration");
        } else {
          ctx.logger.info(entry, "automatic transcription was not queued: no consent to external AI processing");
        }
      }
    }
  });
  return getParticipantState(ctx, session);
}
