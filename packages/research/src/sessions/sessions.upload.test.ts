import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isImmutableRecordError, jobs, mediaAssets, modelConfigs, sessions, utterances } from "@dialect/db";
import { DEFAULT_TEST_CONSENT_ITEMS } from "@dialect/db/testing-builders";
import { AppError, sessionSchemas } from "@dialect/domain";
import { sha256OfBuffer } from "@dialect/storage";
import { silentLogger, type Logger } from "../context";
import { createTestServiceContext, type TestServiceContext } from "../testing";
import {
  acknowledgeInstructions,
  confirmMicCheck,
  createSession,
  createUtterance,
  decideAutoAsr,
  discardCandidate,
  getParticipantState,
  recordConsent,
  startTask,
  submitUtterance,
  uploadUtteranceAudio,
  withdrawSession,
  type SessionRef,
} from "./index";
import {
  acceptAll,
  createTestStudy,
  expectStep,
  ffmpegInstalled,
  sessionAtTasks,
  sineWav,
  webmOpusSample,
  webmVideoSample,
} from "./test-support";

let t: TestServiceContext;
const hasFfmpeg = ffmpegInstalled();
if (!hasFfmpeg) console.warn("ffmpeg and ffprobe are not installed: tests that need them are skipped");

beforeAll(async () => {
  t = await createTestServiceContext();
});
afterAll(async () => {
  await t.cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

const ONE_TASK = [{ taskKey: "only", title: "Only task", participantPrompt: "Only prompt.", maxDurationSeconds: 3 }];
const TWO_TASKS = [...ONE_TASK, { taskKey: "second", title: "Second task", participantPrompt: "Second prompt." }];

// A session at its first task, started, with the utterance row of turn 0.
async function sessionWithUtterance(options: Parameters<typeof createTestStudy>[1] = {}) {
  const study = await createTestStudy(t.ctx.db, { tasks: TWO_TASKS, ...options });
  const { session, state, created } = await sessionAtTasks(t.ctx, study.slug);
  await startTask(t.ctx, session, state.task.presentationId);
  const { utteranceId } = await createUtterance(t.ctx, session, {
    presentationId: state.task.presentationId,
    turnIndex: 0,
  });
  return { study, session, created, utteranceId, presentationId: state.task.presentationId };
}

const mediaOf = (session: SessionRef) =>
  t.ctx.db.select().from(mediaAssets).where(eq(mediaAssets.sessionId, session.id));
const objectsOf = (session: SessionRef) => t.storage.keys().filter((key) => key.includes(session.id));
const sessionRowOf = async (session: SessionRef) =>
  (await t.ctx.db.select().from(sessions).where(eq(sessions.id, session.id)))[0]!;
const utteranceRow = async (id: string) => (await t.ctx.db.select().from(utterances).where(eq(utterances.id, id)))[0]!;
const jobsFor = async (fragment: string) =>
  (await t.ctx.db.select().from(jobs)).filter((job) => job.idempotencyKey.includes(fragment));

describe("uploadUtteranceAudio", () => {
  it("keeps the facts reported by the browser recorder as declared metadata", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const recorderFacts = {
      declaredBitDepth: 16,
      // The class of the input device. The recorder never sends the raw label.
      deviceLabel: "built_in",
      constraintMismatches: [
        { constraint: "echoCancellation", kind: "not_honored" as const, requested: false, actual: true },
        { constraint: "sampleRate", kind: "context_rate_differs" as const, requested: 48000, actual: 44100 },
      ],
      fallbackReason: "audio_worklet_failed" as const,
      fallbackDetail: "The worklet module could not be loaded.",
      inputChannelCount: 2,
      clippedSampleCount: 3,
      peak: 1.02,
      stoppedBy: "max_duration" as const,
    };
    // The schema of the upload route accepts these fields and bounds them.
    expect(sessionSchemas.captureMetadataSchema.parse(recorderFacts)).toEqual(recorderFacts);
    expect(sessionSchemas.captureMetadataSchema.safeParse({ peak: -1 }).success).toBe(false);
    expect(sessionSchemas.captureMetadataSchema.safeParse({ stoppedBy: "timer" }).success).toBe(false);
    expect(sessionSchemas.captureMetadataSchema.safeParse({ deviceLabel: "x".repeat(201) }).success).toBe(false);
    // A raw label (an older page) is reduced to its class by the schema.
    expect(sessionSchemas.captureMetadataSchema.parse({ deviceLabel: "Anna Virtasen AirPods Pro" })).toEqual({
      deviceLabel: "bluetooth",
    });
    expect(
      sessionSchemas.captureMetadataSchema.safeParse({
        constraintMismatches: [{ constraint: "a", kind: "not_honored", requested: "x".repeat(5000) }],
      }).success,
    ).toBe(false);
    expect(
      sessionSchemas.audioEnvironmentSchema.parse({
        constraintMismatches: recorderFacts.constraintMismatches,
        fallbackReason: "audio_worklet_unavailable",
        fallbackDetail: "AudioWorklet is not available.",
      }),
    ).toMatchObject({ fallbackReason: "audio_worklet_unavailable" });

    await uploadUtteranceAudio(t.ctx, session, {
      utteranceId,
      data: sineWav(800),
      declaredMimeType: "audio/wav",
      captureMetadata: { captureMethod: "audio_worklet_pcm", declaredChannels: 1, ...recorderFacts },
    });
    const [row] = await mediaOf(session);
    expect(row!.metadataJson).toMatchObject({
      declared: {
        mimeType: "audio/wav",
        channels: 1,
        bitDepth: 16,
        deviceLabel: "built_in",
        constraintMismatches: recorderFacts.constraintMismatches,
        fallbackReason: "audio_worklet_failed",
        fallbackDetail: "The worklet module could not be loaded.",
        inputChannelCount: 2,
        clippedSampleCount: 3,
        peak: 1.02,
        stoppedBy: "max_duration",
      },
    });
    // The technical columns still come from the server's own analysis.
    expect(row).toMatchObject({ bitDepth: 16, channels: 1, sampleRateHz: 16000 });
  });

  it("never stores device identifiers or a raw device label, also when the service is called directly", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    await uploadUtteranceAudio(t.ctx, session, {
      utteranceId,
      data: sineWav(600),
      declaredMimeType: "audio/wav",
      captureMetadata: {
        deviceLabel: "Matti Meikalaisen USB Microphone",
        requestedConstraints: { channelCount: 1, deviceId: { ideal: "device-id-secret" } },
        actualTrackSettings: { channelCount: 1, sampleRate: 48000, deviceId: "device-id-secret", groupId: "group-id-secret" },
      },
    });
    const [row] = await mediaOf(session);
    expect(row!.metadataJson).toMatchObject({
      requestedConstraints: { channelCount: 1 },
      actualTrackSettings: { channelCount: 1, sampleRate: 48000 },
      declared: { deviceLabel: "usb" },
    });
    expect(JSON.stringify(row)).not.toMatch(/device-id-secret|group-id-secret|Meikalaisen/);
  });

  it("stores a lossless WAV as source_audio with the hash and the technical values from the server-side analysis", async () => {
    const { study, session, utteranceId } = await sessionWithUtterance();
    const data = sineWav(1200);
    const result = await uploadUtteranceAudio(t.ctx, session, {
      utteranceId,
      data,
      // The browser claims other values. They must not end up in the technical columns.
      declaredMimeType: "audio/webm;codecs=opus",
      captureMetadata: {
        captureMethod: "audio_worklet_pcm",
        requestedConstraints: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        actualTrackSettings: { channelCount: 1, sampleRate: 48000, echoCancellation: true },
        audioContextSampleRate: 48000,
        userAgent: "TestBrowser/1.0",
        declaredDurationMs: 99999,
        declaredSampleRateHz: 48000,
        declaredChannels: 2,
      },
    });
    expect(result).toEqual({
      mediaAssetId: expect.any(String),
      sha256: sha256OfBuffer(data),
      durationMs: 1200,
      sizeBytes: data.length,
      captureQualityClass: "lossless_pcm",
    });

    const [row] = await mediaOf(session);
    expect(row).toMatchObject({
      id: result.mediaAssetId,
      studyId: study.study.id,
      sessionId: session.id,
      utteranceId,
      entityType: "utterance",
      entityId: utteranceId,
      kind: "source_audio",
      storageDriver: "memory",
      mimeType: "audio/wav",
      container: "wav",
      codec: "pcm_s16le",
      sampleRateHz: 16000,
      channels: 1,
      bitDepth: 16,
      durationMs: 1200,
      sizeBytes: data.length,
      sha256: sha256OfBuffer(data),
      captureMethod: "audio_worklet_pcm",
      captureQualityClass: "lossless_pcm",
      deletedAt: null,
    });
    expect(row!.storageKey).toBe(
      `studies/${study.slug}/sessions/${session.id}/utterances/${utteranceId}/source/${result.mediaAssetId}.wav`,
    );
    expect(row!.metadataJson).toMatchObject({
      requestedConstraints: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      actualTrackSettings: { channelCount: 1, sampleRate: 48000, echoCancellation: true },
      audioContextSampleRate: 48000,
      browserUserAgent: "TestBrowser/1.0",
      declared: {
        mimeType: "audio/webm;codecs=opus",
        mimeTypeMatches: false,
        durationMs: 99999,
        sampleRateHz: 48000,
        channels: 2,
      },
      probe: { parser: "wav_header" },
    });
    // The participant code is not part of the key or the media row.
    const [sessionRow] = await t.ctx.db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(JSON.stringify(row)).not.toContain(sessionRow!.participantCode);

    expect(objectsOf(session)).toEqual([row!.storageKey]);
    expect(t.storage.contentTypeOf(row!.storageKey)).toBe("audio/wav");
    const utterance = await utteranceRow(utteranceId);
    expect(utterance.status).toBe("uploading");
    // Not accepted yet: that happens at submit.
    expect(utterance.acceptedMediaAssetId).toBeNull();
    expect(utterance.submittedAt).toBeNull();
  });

  it("rejects an empty file, a file that is not audio, a too long and a too large recording, and leaves no row or object", async () => {
    const { session, utteranceId } = await sessionWithUtterance({ settings: { maxUploadMb: 1 } });
    const cases: Array<{ name: string; data: Buffer; code: string; reason: string }> = [
      { name: "empty", data: Buffer.alloc(0), code: "INVALID_AUDIO", reason: "empty" },
      // The task allows 3 seconds, plus the 2 seconds of tolerance.
      { name: "too long", data: sineWav(5500), code: "INVALID_AUDIO", reason: "too_long" },
      // 40 seconds of 16 kHz 16 bit mono is about 1.28 MB, above the 1 MB limit.
      { name: "too large", data: sineWav(40_000), code: "PAYLOAD_TOO_LARGE", reason: "too_large" },
      { name: "truncated WAV header", data: sineWav(300).subarray(0, 30), code: "INVALID_AUDIO", reason: "" },
    ];
    for (const entry of cases) {
      const error = await expectAppError(
        uploadUtteranceAudio(t.ctx, session, { utteranceId, data: entry.data, declaredMimeType: "audio/wav" }),
        entry.code,
      );
      if (entry.reason) expect((error.details as { reason: string }).reason, entry.name).toBe(entry.reason);
      // User-safe: a short sentence, no stack, no path.
      expect(error.message.length, entry.name).toBeLessThan(120);
      expect(error.message, entry.name).not.toMatch(/\/|Error:|at /);
    }
    expect(await mediaOf(session)).toHaveLength(0);
    expect(objectsOf(session)).toHaveLength(0);
    expect((await utteranceRow(utteranceId)).status).toBe("recording");
    // A recording within the tolerance is accepted.
    await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(4500) });
    expect(await mediaOf(session)).toHaveLength(1);
  });

  it.skipIf(!hasFfmpeg)("rejects text and video files that claim to be audio", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const text = Buffer.from("this is not audio at all, just some text ".repeat(50), "utf8");
    const error = await expectAppError(
      uploadUtteranceAudio(t.ctx, session, { utteranceId, data: text, declaredMimeType: "audio/wav" }),
      "INVALID_AUDIO",
    );
    expect(error.message).not.toMatch(/ffprobe|\/tmp|Error:/);
    const video = webmVideoSample();
    await expectAppError(
      uploadUtteranceAudio(t.ctx, session, { utteranceId, data: video, declaredMimeType: "audio/webm" }),
      "INVALID_AUDIO",
    );
    expect(await mediaOf(session)).toHaveLength(0);
    expect(objectsOf(session)).toHaveLength(0);
  });

  it("replaces an earlier upload when the participant records again: one row, one object", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const first = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(300) });
    const [firstRow] = await mediaOf(session);
    const second = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(600) });
    expect(second.mediaAssetId).not.toBe(first.mediaAssetId);
    const rows = await mediaOf(session);
    expect(rows.map((row) => row.id)).toEqual([second.mediaAssetId]);
    expect(objectsOf(session)).toEqual([rows[0]!.storageKey]);
    expect(await t.storage.exists(firstRow!.storageKey)).toBe(false);

    // The replaced upload can no longer be submitted.
    await expectAppError(
      submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: first.mediaAssetId, attemptCount: 2 }),
      "MEDIA_NOT_FOUND",
    );
    await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: second.mediaAssetId, attemptCount: 2 });
    const utterance = await utteranceRow(utteranceId);
    expect(utterance.acceptedMediaAssetId).toBe(second.mediaAssetId);
    expect(utterance.attemptCount).toBe(2);
    expect(utterance.durationMs).toBe(600);
  });

  it("discardCandidate removes the uploaded recording and can be repeated", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav() });
    const state = expectStep(await discardCandidate(t.ctx, session, { utteranceId }), "tasks");
    expect(state.task.turn.candidate).toBeNull();
    expect(await mediaOf(session)).toHaveLength(0);
    expect(objectsOf(session)).toHaveLength(0);
    expect((await utteranceRow(utteranceId)).status).toBe("recording");
    await discardCandidate(t.ctx, session, { utteranceId });
  });

  it("leaves nothing behind when the storage write fails, and the retry works", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const data = sineWav(500);
    vi.spyOn(t.storage, "put").mockRejectedValueOnce(new Error("disk full at /var/secret/path"));
    const error = await expectAppError(uploadUtteranceAudio(t.ctx, session, { utteranceId, data }), "UPLOAD_FAILED");
    expect(error.message).toBe("The recording could not be saved. Please try again.");
    expect(JSON.stringify(error.details)).not.toContain("secret");
    expect(await mediaOf(session)).toHaveLength(0);
    expect(objectsOf(session)).toHaveLength(0);
    expect((await utteranceRow(utteranceId)).status).toBe("recording");

    // The browser kept the recording and sends the same bytes again.
    const retry = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data });
    expect(await mediaOf(session)).toHaveLength(1);
    expect(objectsOf(session)).toHaveLength(1);
    const next = await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: retry.mediaAssetId });
    expect(expectStep(next, "tasks").task.title).toBe("Second task");
  });

  it("deletes the stored object again when the database step fails", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    // The session ends while the file is being stored: the database step then refuses the row.
    const realPut = t.storage.put.bind(t.storage);
    vi.spyOn(t.storage, "put").mockImplementationOnce(async (input) => {
      const stored = await realPut(input);
      await withdrawSession(t.ctx, session);
      return stored;
    });
    await expectAppError(uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav() }), "INVALID_STATE");
    expect(await mediaOf(session)).toHaveLength(0);
    expect(objectsOf(session)).toHaveLength(0);
  });

  it("keeps one candidate when two uploads for the same utterance run at the same time", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const results = await Promise.all([
      uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(300) }),
      uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(400) }),
    ]);
    const rows = await mediaOf(session);
    expect(rows).toHaveLength(1);
    expect(results.map((result) => result.mediaAssetId)).toContain(rows[0]!.id);
    expect(objectsOf(session)).toEqual([rows[0]!.storageKey]);
  });

  it("refuses the utterance of another session, for upload, submit, discard and task start", async () => {
    const mine = await sessionWithUtterance();
    const other = await sessionWithUtterance();
    const otherUpload = await uploadUtteranceAudio(t.ctx, other.session, { utteranceId: other.utteranceId, data: sineWav() });

    await expectAppError(
      uploadUtteranceAudio(t.ctx, mine.session, { utteranceId: other.utteranceId, data: sineWav() }),
      "NOT_FOUND",
    );
    await expectAppError(
      submitUtterance(t.ctx, mine.session, { utteranceId: other.utteranceId, mediaAssetId: otherUpload.mediaAssetId }),
      "NOT_FOUND",
    );
    // My utterance with the other session's recording.
    await expectAppError(
      submitUtterance(t.ctx, mine.session, { utteranceId: mine.utteranceId, mediaAssetId: otherUpload.mediaAssetId }),
      "MEDIA_NOT_FOUND",
    );
    await expectAppError(discardCandidate(t.ctx, mine.session, { utteranceId: other.utteranceId }), "NOT_FOUND");
    await expectAppError(startTask(t.ctx, mine.session, other.presentationId), "NOT_FOUND");
    await expectAppError(
      createUtterance(t.ctx, mine.session, { presentationId: other.presentationId, turnIndex: 0 }),
      "NOT_FOUND",
    );
    // The other session is untouched.
    expect((await mediaOf(other.session)).map((row) => row.id)).toEqual([otherUpload.mediaAssetId]);
    expect((await utteranceRow(other.utteranceId)).status).toBe("uploading");
    expect(await mediaOf(mine.session)).toHaveLength(0);
  });
});

describe("submitUtterance", () => {
  it("links the accepted recording, stores attempt count, duration and quality, and advances", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(700) });
    t.clock.advance(2000);
    const next = expectStep(
      await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId, attemptCount: 3 }),
      "tasks",
    );
    expect(next.task.title).toBe("Second task");
    expect(next.progress).toEqual({ taskNumber: 2, totalTasks: 2 });
    const utterance = await utteranceRow(utteranceId);
    expect(utterance).toMatchObject({
      status: "submitted",
      acceptedMediaAssetId: upload.mediaAssetId,
      attemptCount: 3,
      durationMs: 700,
      promptSnapshot: "Only prompt.",
      followupId: null,
      turnIndex: 0,
    });
    expect(utterance.submittedAt?.getTime()).toBe(t.clock.now().getTime());
    // Informational values only. A quiet or clipped recording is still accepted.
    expect(utterance.qualityJson).toMatchObject({ peakAmplitude: expect.any(Number), rmsDb: expect.any(Number), warnings: [] });
  });

  it("stores an attempt count of at least 1", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav() });
    await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId, attemptCount: 0 });
    expect((await utteranceRow(utteranceId)).attemptCount).toBe(1);
  });

  it("accepts a silent recording and only notes the warning", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const silent = sineWav(500);
    silent.fill(0, 44);
    const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: silent });
    await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
    const utterance = await utteranceRow(utteranceId);
    expect(utterance.status).toBe("submitted");
    expect(utterance.qualityJson?.warnings).toEqual(expect.arrayContaining(["low_signal", "mostly_silent"]));
  });

  it("is idempotent: a second submit, also at the same time, changes nothing and queues nothing twice", async () => {
    const { session, utteranceId } = await sessionWithUtterance({ settings: { autoQueueAsr: true } });
    const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav() });
    const input = { utteranceId, mediaAssetId: upload.mediaAssetId, attemptCount: 2 };
    const [a, b] = await Promise.all([submitUtterance(t.ctx, session, input), submitUtterance(t.ctx, session, input)]);
    expect(a).toEqual(b);
    const first = await utteranceRow(utteranceId);
    t.clock.advance(5000);
    const again = await submitUtterance(t.ctx, session, { ...input, attemptCount: 9 });
    expect(again).toEqual(a);
    const after = await utteranceRow(utteranceId);
    expect(after.submittedAt?.getTime()).toBe(first.submittedAt?.getTime());
    expect(after.attemptCount).toBe(2);
    // The session moved on by exactly one task.
    expect(expectStep(again, "tasks").progress).toEqual({ taskNumber: 2, totalTasks: 2 });
    expect(await jobsFor(utteranceId)).toHaveLength(1);
  });

  it("never lets a submitted recording be replaced, discarded or re-submitted with another file", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav() });
    await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
    const [before] = await mediaOf(session);

    const error = await expectAppError(
      uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav(900) }),
      "IMMUTABLE_RECORD",
    );
    expect(error.message).toBe("This recording was already submitted and can no longer be replaced.");
    await expectAppError(discardCandidate(t.ctx, session, { utteranceId }), "IMMUTABLE_RECORD");
    await expectAppError(
      submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: "00000000-0000-4000-8000-000000000000" }),
      "IMMUTABLE_RECORD",
    );
    const rows = await mediaOf(session);
    expect(rows).toEqual([before]);
    expect(objectsOf(session)).toEqual([before!.storageKey]);
    expect((await utteranceRow(utteranceId)).acceptedMediaAssetId).toBe(upload.mediaAssetId);

    // The database refuses it too, independent of the service.
    const failure = await t.ctx.db
      .update(utterances)
      .set({ acceptedMediaAssetId: null, status: "recording" })
      .where(eq(utterances.id, utteranceId))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(isImmutableRecordError(failure)).toBe(true);
  });

  it("requires an uploaded recording of this utterance", async () => {
    const { session, utteranceId } = await sessionWithUtterance();
    await expectAppError(
      submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: "00000000-0000-4000-8000-000000000000" }),
      "MEDIA_NOT_FOUND",
    );
    expect((await utteranceRow(utteranceId)).status).toBe("recording");
    expect(expectStep(await getParticipantState(t.ctx, session), "tasks").progress?.taskNumber).toBe(1);
  });
});

describe("jobs after a submission", () => {
  it("queues one automatic ASR job when the study setting is on", async () => {
    const { study, session, utteranceId } = await sessionWithUtterance({ settings: { autoQueueAsr: true } });
    const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav() });
    // Nothing is queued for a candidate.
    expect(await jobsFor(utteranceId)).toHaveLength(0);
    await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
    const queued = await jobsFor(utteranceId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: "asr",
      status: "queued",
      idempotencyKey: `asr:auto:${utteranceId}`,
      payloadJson: { utteranceId, mediaAssetId: upload.mediaAssetId, trigger: "auto_on_upload" },
      processingBatchId: null,
    });
    // The active asr_default configuration at the time of the upload is pinned in the job.
    const [active] = await t.ctx.db
      .select()
      .from(modelConfigs)
      .where(and(eq(modelConfigs.studyId, study.study.id), eq(modelConfigs.key, "asr_default"), eq(modelConfigs.status, "active")));
    expect((queued[0]!.payloadJson as { modelConfigId?: string }).modelConfigId).toBe(active!.id);
    // A lossless upload needs no derived WAV.
    expect(await jobsFor(upload.mediaAssetId)).toHaveLength(0);
  });

  // A session at its first task with a recorded consent in which the item for
  // external AI processing has the given answer.
  async function sessionWithConsentAnswer(
    options: Parameters<typeof createTestStudy>[1],
    externalAiAccepted: boolean,
  ) {
    const study = await createTestStudy(t.ctx.db, { tasks: TWO_TASKS, ...options });
    const created = await createSession(t.ctx, { studySlug: study.slug });
    const responses = acceptAll(created.state).map((response) =>
      response.itemId === "external_ai_processing" ? { ...response, accepted: externalAiAccepted } : response,
    );
    await recordConsent(t.ctx, created.session, { responses });
    await confirmMicCheck(t.ctx, created.session, {});
    const state = expectStep(await acknowledgeInstructions(t.ctx, created.session), "tasks");
    await startTask(t.ctx, created.session, state.task.presentationId);
    const { utteranceId } = await createUtterance(t.ctx, created.session, {
      presentationId: state.task.presentationId,
      turnIndex: 0,
    });
    return { study, session: created.session, utteranceId };
  }

  function loggingContext() {
    const lines: Array<{ level: string; entry: Record<string, unknown> | string; message?: string }> = [];
    const logger: Logger = {
      ...silentLogger,
      info: (entry, message) => void lines.push({ level: "info", entry, message }),
      warn: (entry, message) => void lines.push({ level: "warn", entry, message }),
    };
    return { ctx: { ...t.ctx, logger }, lines };
  }

  it("queues no automatic ASR job when the participant did not accept external AI processing", async () => {
    const { session, utteranceId } = await sessionWithConsentAnswer({ settings: { autoQueueAsr: true } }, false);
    const { ctx, lines } = loggingContext();
    const upload = await uploadUtteranceAudio(ctx, session, { utteranceId, data: sineWav() });
    await submitUtterance(ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
    // The recording is stored, nothing is sent anywhere.
    expect((await utteranceRow(utteranceId)).status).toBe("submitted");
    expect(await jobsFor(utteranceId)).toHaveLength(0);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "info",
        entry: { sessionId: session.id, utteranceId, reason: "external_ai_processing_not_accepted" },
      }),
    ]);
  });

  it("queues no automatic ASR job when the consent version has no item for external AI processing", async () => {
    const { session, utteranceId } = await sessionWithConsentAnswer(
      { settings: { autoQueueAsr: true }, consentItems: DEFAULT_TEST_CONSENT_ITEMS, aiConfigs: true },
      true,
    );
    const { ctx, lines } = loggingContext();
    const upload = await uploadUtteranceAudio(ctx, session, { utteranceId, data: sineWav() });
    await submitUtterance(ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
    expect(await jobsFor(utteranceId)).toHaveLength(0);
    expect(lines[0]).toMatchObject({ level: "info", entry: { reason: "no_external_ai_consent_item" } });
    expect(await decideAutoAsr(t.ctx.db, { id: session.id, studyId: (await sessionRowOf(session)).studyId })).toEqual({
      queue: false,
      reason: "no_external_ai_consent_item",
    });
  });

  it("queues nothing and logs a warning when no asr_default configuration is active at upload time", async () => {
    const { session, utteranceId } = await sessionWithConsentAnswer(
      { settings: { autoQueueAsr: true }, aiConfigs: false },
      true,
    );
    const { ctx, lines } = loggingContext();
    const upload = await uploadUtteranceAudio(ctx, session, { utteranceId, data: sineWav() });
    await submitUtterance(ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
    expect((await utteranceRow(utteranceId)).status).toBe("submitted");
    expect(await jobsFor(utteranceId)).toHaveLength(0);
    expect(lines).toEqual([
      expect.objectContaining({ level: "warn", entry: { sessionId: session.id, utteranceId, reason: "no_active_asr_config" } }),
    ]);
  });

  it("queues nothing when the study setting is off", async () => {
    const { session, utteranceId } = await sessionWithUtterance({ settings: { autoQueueAsr: false } });
    const upload = await uploadUtteranceAudio(t.ctx, session, { utteranceId, data: sineWav() });
    await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
    expect(await jobsFor(utteranceId)).toHaveLength(0);
    expect(await jobsFor(upload.mediaAssetId)).toHaveLength(0);
    expect((await utteranceRow(utteranceId)).status).toBe("submitted");
  });

  it.skipIf(!hasFfmpeg)(
    "stores a compressed upload unchanged as source_audio_raw (compressed_fallback) and queues derive_wav",
    async () => {
      const { session, utteranceId } = await sessionWithUtterance({ settings: { autoQueueAsr: true } });
      const webm = webmOpusSample();
      const upload = await uploadUtteranceAudio(t.ctx, session, {
        utteranceId,
        data: webm,
        declaredMimeType: "audio/webm;codecs=opus",
        captureMetadata: { captureMethod: "media_recorder" },
      });
      expect(upload.captureQualityClass).toBe("compressed_fallback");
      const [row] = await mediaOf(session);
      expect(row).toMatchObject({
        kind: "source_audio_raw",
        captureQualityClass: "compressed_fallback",
        captureMethod: "media_recorder",
        mimeType: "audio/webm",
        container: "webm",
        codec: "opus",
        bitDepth: null,
        sha256: sha256OfBuffer(webm),
        sizeBytes: webm.length,
        derivedFromMediaAssetId: null,
      });
      expect(row!.storageKey.endsWith(".webm")).toBe(true);
      expect(row!.metadataJson).toMatchObject({ declared: { mimeTypeMatches: true }, probe: { parser: "ffprobe" } });
      expect(await jobsFor(upload.mediaAssetId)).toHaveLength(0);

      await submitUtterance(t.ctx, session, { utteranceId, mediaAssetId: upload.mediaAssetId });
      const utterance = await utteranceRow(utteranceId);
      expect(utterance.acceptedMediaAssetId).toBe(upload.mediaAssetId);
      // No WAV analysis for a compressed file.
      expect(utterance.qualityJson).toBeNull();
      const all = await t.ctx.db.select().from(jobs);
      const derive = all.filter((job) => job.idempotencyKey === `derive_wav:${upload.mediaAssetId}`);
      expect(derive).toHaveLength(1);
      expect(derive[0]).toMatchObject({ type: "derive_wav", payloadJson: { mediaAssetId: upload.mediaAssetId } });
      expect(all.filter((job) => job.idempotencyKey === `asr:auto:${utteranceId}`)).toHaveLength(1);
    },
  );

  it("does not queue the automatic ASR job for a demo session", async () => {
    const study = await createTestStudy(t.ctx.db, { tasks: ONE_TASK, settings: { autoQueueAsr: true, demoPublic: true } });
    const created = await createSession(t.ctx, { studySlug: study.slug, mode: "demo" });
    await recordConsent(t.ctx, created.session, { responses: acceptAll(created.state) });
    await confirmMicCheck(t.ctx, created.session, {});
    const state = expectStep(await acknowledgeInstructions(t.ctx, created.session), "tasks");
    await startTask(t.ctx, created.session, state.task.presentationId);
    const { utteranceId } = await createUtterance(t.ctx, created.session, { presentationId: state.task.presentationId, turnIndex: 0 });
    const upload = await uploadUtteranceAudio(t.ctx, created.session, { utteranceId, data: sineWav() });
    await submitUtterance(t.ctx, created.session, { utteranceId, mediaAssetId: upload.mediaAssetId });
    expect(await jobsFor(utteranceId)).toHaveLength(0);
  });
});
