import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionSchemas } from "@dialect/domain";
import { ApiClientError } from "@/lib/client/api";
import type { RecordingCandidate } from "@/components/participant/recorder/recorderMachine";
import { makeResult } from "@/components/participant/recorder/recorderTestHelpers";
import {
  captureMetadataOf,
  errorCodeOf,
  maintenanceMessageOf,
  participantApi,
  questionnaireIssuesOf,
  recordingFileName,
} from "./participantApi";
import { createTurnTracker, turnKeyOf } from "./turnTracker";

const candidate = (overrides: Partial<RecordingCandidate> = {}): RecordingCandidate => ({
  ...makeResult(),
  url: "blob:test/1",
  attempt: 1,
  ...overrides,
});

const task = (overrides: Partial<sessionSchemas.CurrentTask> = {}, turn: Partial<sessionSchemas.CurrentTurn> = {}) =>
  ({
    presentationId: "11111111-1111-4111-8111-111111111111",
    status: "pending",
    title: "T",
    prompt: "P",
    context: null,
    instructions: null,
    taskType: "controlled",
    minDurationSeconds: null,
    suggestedDurationSeconds: null,
    maxDurationSeconds: 120,
    privacyReminder: false,
    topicSuggestions: [],
    turn: { turnIndex: 0, totalTurns: 1, promptText: "P", isFollowup: false, isOptional: false, utteranceId: null, candidate: null, ...turn },
    ...overrides,
  }) as sessionSchemas.CurrentTask;

afterEach(() => vi.restoreAllMocks());

describe("captureMetadataOf", () => {
  it("sends every fact of the recorder in a shape the upload schema accepts", () => {
    const metadata = captureMetadataOf(
      candidate({
        deviceLabel: "Built-in microphone",
        stoppedBy: "max_duration",
        peak: 1.01,
        clippedSampleCount: 4,
        inputChannelCount: 2,
        constraintMismatches: [{ constraint: "echoCancellation", kind: "not_honored", requested: false, actual: true }],
      }),
      { reason: "audio_worklet_failed", detail: "module load failed" },
    );
    // What is sent is the JSON text: undefined fields disappear.
    const sent = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
    const parsed = sessionSchemas.captureMetadataSchema.safeParse(sent);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(sent).toMatchObject({
      deviceLabel: "Built-in microphone",
      stoppedBy: "max_duration",
      peak: 1.01,
      clippedSampleCount: 4,
      inputChannelCount: 2,
      constraintMismatches: [{ constraint: "echoCancellation", kind: "not_honored", requested: false, actual: true }],
      fallbackReason: "audio_worklet_failed",
      fallbackDetail: "module load failed",
    });
    for (const field of ["captureMethod", "declaredDurationMs", "requestedConstraints", "actualTrackSettings", "userAgent"]) {
      expect(sent, field).toHaveProperty(field);
    }
  });

  it("stays within the bounds of the schema for the compressed fallback and for oversized values", () => {
    const metadata = captureMetadataOf(
      candidate({
        sampleRateHz: null,
        channels: null,
        bitDepth: null,
        audioContextSampleRate: null,
        peak: null,
        inputChannelCount: null,
        clippedSampleCount: null,
        deviceLabel: "x".repeat(500),
        actualTrackSettings: { big: "y".repeat(5000) },
        constraintMismatches: Array.from({ length: 30 }, (_, index) => ({
          constraint: `c${index}`,
          kind: "not_reported" as const,
          requested: "z".repeat(400),
          actual: undefined,
        })),
      }),
      null,
    );
    const sent = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
    const parsed = sessionSchemas.captureMetadataSchema.safeParse(sent);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(sent).not.toHaveProperty("actualTrackSettings");
    expect(sent).not.toHaveProperty("declaredBitDepth");
    expect(sent).not.toHaveProperty("fallbackReason");
    expect((sent.deviceLabel as string).length).toBe(200);
    expect(sent.constraintMismatches).toHaveLength(20);
  });

  it("names the upload after its format", () => {
    expect(recordingFileName("audio/wav")).toBe("recording.wav");
    expect(recordingFileName("audio/webm;codecs=opus")).toBe("recording.webm");
    expect(recordingFileName("audio/mp4")).toBe("recording.m4a");
  });
});

describe("error helpers", () => {
  it("reads codes, the maintenance message and questionnaire issues from API errors only", () => {
    expect(errorCodeOf(new ApiClientError("SESSION_EXPIRED", "x", 401))).toBe("SESSION_EXPIRED");
    expect(errorCodeOf(new Error("boom"))).toBe("UNEXPECTED");
    expect(maintenanceMessageOf(new ApiClientError("STUDY_CLOSED", "Back at 14:00.", 403, { reason: "maintenance" }))).toBe("Back at 14:00.");
    expect(maintenanceMessageOf(new ApiClientError("STUDY_CLOSED", "Closed.", 403, { reason: "study_paused" }))).toBeNull();
    expect(maintenanceMessageOf(new ApiClientError("INTERNAL_ERROR", "stack trace", 500))).toBeNull();
    expect(
      questionnaireIssuesOf(
        new ApiClientError("VALIDATION_ERROR", "x", 400, { issues: [{ path: "age", message: "m", code: "required" }, { path: 3 }] }),
      ),
    ).toEqual([{ itemKey: "age", code: "required" }]);
    expect(questionnaireIssuesOf(new ApiClientError("VALIDATION_ERROR", "x", 400, { reason: "other" }))).toEqual([]);
  });
});

describe("turn tracker", () => {
  it("starts the task and creates the utterance once per turn", async () => {
    const start = vi.spyOn(participantApi, "startTask").mockResolvedValue({ state: {} as never });
    const create = vi.spyOn(participantApi, "createUtterance").mockResolvedValue({ utteranceId: "u1", state: {} as never });
    const remove = vi.spyOn(participantApi, "deleteCandidate").mockResolvedValue({ state: {} as never });
    const turns = createTurnTracker();
    const current = task();
    expect(turnKeyOf(current)).toBe("11111111-1111-4111-8111-111111111111:0");
    expect(await turns.ensure(current)).toBe("u1");
    expect(await turns.ensure(current)).toBe("u1");
    expect(start).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ presentationId: current.presentationId, turnIndex: 0 });
    expect(remove).not.toHaveBeenCalled();

    // The follow-up turn of the same, already started task.
    create.mockResolvedValue({ utteranceId: "u2", state: {} as never });
    const followup = task({ status: "started" }, { turnIndex: 1 });
    expect(await turns.ensure(followup)).toBe("u2");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("removes a candidate that a page reload left on the server", async () => {
    vi.spyOn(participantApi, "startTask").mockResolvedValue({ state: {} as never });
    const create = vi.spyOn(participantApi, "createUtterance");
    const remove = vi.spyOn(participantApi, "deleteCandidate").mockResolvedValue({ state: {} as never });
    const turns = createTurnTracker();
    const reloaded = task({ status: "started" }, { utteranceId: "u9", candidate: { mediaAssetId: "m1", durationMs: 1000 } });
    expect(await turns.ensure(reloaded)).toBe("u9");
    expect(create).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("u9");
  });

  it("tries a failed preparation again", async () => {
    vi.spyOn(participantApi, "startTask").mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ state: {} as never });
    vi.spyOn(participantApi, "createUtterance").mockResolvedValue({ utteranceId: "u1", state: {} as never });
    const turns = createTurnTracker();
    await expect(turns.ensure(task())).rejects.toThrow("offline");
    expect(await turns.ensure(task())).toBe("u1");
  });

  it("reuses the upload for a retried submit and deletes it when the participant records again", async () => {
    vi.spyOn(participantApi, "startTask").mockResolvedValue({ state: {} as never });
    vi.spyOn(participantApi, "createUtterance").mockResolvedValue({ utteranceId: "u1", state: {} as never });
    const remove = vi.spyOn(participantApi, "deleteCandidate").mockResolvedValue({ state: {} as never });
    const turns = createTurnTracker();
    const current = task();
    await turns.ensure(current);

    expect(turns.uploadedAttempt(current, 1)).toBeNull();
    turns.setUploaded(current, 1, "m1");
    expect(turns.uploadedAttempt(current, 1)).toBe("m1");
    // The same recording is still the candidate: nothing is deleted.
    turns.candidateChanged(1);
    expect(remove).not.toHaveBeenCalled();
    // Record again: the candidate is gone from the browser, so the upload is removed.
    turns.candidateChanged(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("u1");
    expect(turns.uploadedAttempt(current, 1)).toBeNull();
    expect(turns.uploadedAttempt(current, 2)).toBeNull();
    // Without an upload a change of the candidate asks the server for nothing.
    turns.candidateChanged(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("never carries an upload over to another turn, and cancels a running upload on reset", async () => {
    vi.spyOn(participantApi, "startTask").mockResolvedValue({ state: {} as never });
    vi.spyOn(participantApi, "createUtterance").mockResolvedValue({ utteranceId: "u1", state: {} as never });
    const turns = createTurnTracker();
    const first = task();
    await turns.ensure(first);
    turns.setUploaded(first, 1, "m1");
    const signal = turns.newAbortSignal();
    const second = task({ presentationId: "22222222-2222-4222-8222-222222222222" });
    expect(turns.uploadedAttempt(second, 1)).toBeNull();
    expect(signal.aborted).toBe(true);
    const next = turns.newAbortSignal();
    turns.reset();
    expect(next.aborted).toBe(true);
    expect(turns.fallback()).toBeNull();
  });
});
