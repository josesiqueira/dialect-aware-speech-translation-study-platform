import { describe, expect, it } from "vitest";
import {
  INITIAL_RECORDER_STATE,
  isBelowMinimumDuration,
  recorderReducer,
  seemsSilent,
  type CaptureInfo,
  type RecorderEvent,
  type RecorderMachineState,
  type RecordingCandidate,
} from "./recorderMachine";
import { makeResult } from "./recorderTestHelpers";

const capture: CaptureInfo = { captureMethod: "audio_worklet_pcm", captureQualityClass: "lossless_pcm", fallback: null };
const uploadError = { code: "UPLOAD_FAILED", messageKey: "upload.failed" } as const;
const micError = { code: "MICROPHONE_PERMISSION_DENIED", messageKey: "microphone.permission_denied" } as const;

function candidate(url: string, attempt: number, durationMs = 3000): RecordingCandidate {
  return { ...makeResult({ durationMs }), url, attempt };
}

function run(events: RecorderEvent[], from: RecorderMachineState = INITIAL_RECORDER_STATE): RecorderMachineState {
  return events.reduce(recorderReducer, from);
}

describe("recorderReducer", () => {
  it("goes from idle through permission and recording to a stopped candidate", () => {
    let state = run([{ type: "PERMISSION_REQUESTED" }]);
    expect(state.status).toBe("requesting_permission");
    state = run([{ type: "RECORDING_STARTED", capture }], state);
    expect(state).toMatchObject({ status: "recording", attemptCount: 1, capture });
    const first = candidate("blob:1", 1);
    state = run([{ type: "RECORDING_FINISHED", candidate: first }], state);
    expect(state).toMatchObject({ status: "stopped", attemptCount: 1 });
    expect(state.candidate).toBe(first);
  });

  it("the mic check path: permission, microphone ready, then recording", () => {
    const state = run([{ type: "PERMISSION_REQUESTED" }, { type: "MICROPHONE_READY" }]);
    expect(state).toMatchObject({ status: "idle", attemptCount: 0 });
    expect(run([{ type: "RECORDING_STARTED", capture }], state).status).toBe("recording");
  });

  it("counts every started recording as an attempt", () => {
    const state = run([
      { type: "RECORDING_STARTED", capture },
      { type: "RECORDING_FINISHED", candidate: candidate("blob:1", 1) },
      { type: "CANDIDATE_DISCARDED" },
      { type: "RECORDING_STARTED", capture },
      { type: "RECORDING_FINISHED", candidate: candidate("blob:2", 2) },
      { type: "CANDIDATE_DISCARDED" },
      { type: "RECORDING_STARTED", capture },
    ]);
    expect(state.attemptCount).toBe(3);
    expect(state.candidate).toBeNull();
  });

  it("re-recording drops the previous candidate from the state", () => {
    const stopped = run([
      { type: "RECORDING_STARTED", capture },
      { type: "RECORDING_FINISHED", candidate: candidate("blob:1", 1) },
    ]);
    const discarded = run([{ type: "CANDIDATE_DISCARDED" }], stopped);
    expect(discarded).toMatchObject({ status: "idle", candidate: null, attemptCount: 1 });
  });

  it("keeps the same candidate when the upload fails, and sends it again on retry", () => {
    const kept = candidate("blob:1", 1);
    let state = run([
      { type: "RECORDING_STARTED", capture },
      { type: "RECORDING_FINISHED", candidate: kept },
      { type: "UPLOAD_STARTED" },
      { type: "UPLOAD_PROGRESS", fraction: 0.5 },
    ]);
    expect(state).toMatchObject({ status: "uploading", uploadProgress: 0.5 });
    state = run([{ type: "UPLOAD_FAILED", error: uploadError }], state);
    expect(state).toMatchObject({ status: "upload_failed", error: uploadError, attemptCount: 1, uploadProgress: null });
    expect(state.candidate).toBe(kept);
    state = run([{ type: "UPLOAD_STARTED" }], state);
    expect(state.status).toBe("uploading");
    expect(state.candidate).toBe(kept);
    expect(state.error).toBeNull();
    state = run([{ type: "UPLOAD_SUCCEEDED" }], state);
    expect(state).toMatchObject({ status: "submitted", candidate: null, attemptCount: 1 });
  });

  it("allows recording again after a failed upload", () => {
    const state = run([
      { type: "RECORDING_STARTED", capture },
      { type: "RECORDING_FINISHED", candidate: candidate("blob:1", 1) },
      { type: "UPLOAD_STARTED" },
      { type: "UPLOAD_FAILED", error: uploadError },
      { type: "CANDIDATE_DISCARDED" },
      { type: "RECORDING_STARTED", capture },
    ]);
    expect(state).toMatchObject({ status: "recording", attemptCount: 2, candidate: null, error: null });
  });

  it("does not discard or fail while uploading", () => {
    const uploading = run([
      { type: "RECORDING_STARTED", capture },
      { type: "RECORDING_FINISHED", candidate: candidate("blob:1", 1) },
      { type: "UPLOAD_STARTED" },
    ]);
    expect(run([{ type: "CANDIDATE_DISCARDED" }], uploading)).toBe(uploading);
    expect(run([{ type: "FAILED", error: micError }], uploading)).toBe(uploading);
    expect(run([{ type: "RECORDING_STARTED", capture }], uploading)).toBe(uploading);
  });

  it("clamps upload progress to 0..1", () => {
    const uploading = run([
      { type: "RECORDING_STARTED", capture },
      { type: "RECORDING_FINISHED", candidate: candidate("blob:1", 1) },
      { type: "UPLOAD_STARTED" },
    ]);
    expect(run([{ type: "UPLOAD_PROGRESS", fraction: 7 }], uploading).uploadProgress).toBe(1);
    expect(run([{ type: "UPLOAD_PROGRESS", fraction: -1 }], uploading).uploadProgress).toBe(0);
    expect(run([{ type: "UPLOAD_PROGRESS", fraction: Number.NaN }], uploading).uploadProgress).toBe(0);
  });

  it("a refused permission is an error, and trying again leaves the error state", () => {
    let state = run([{ type: "PERMISSION_REQUESTED" }, { type: "FAILED", error: micError }]);
    expect(state).toMatchObject({ status: "error", error: micError, attemptCount: 0 });
    state = run([{ type: "PERMISSION_REQUESTED" }], state);
    expect(state).toMatchObject({ status: "requesting_permission", error: null });
  });

  it("a failure while recording drops everything from that attempt but keeps the count", () => {
    const state = run([
      { type: "RECORDING_STARTED", capture },
      { type: "FAILED", error: { code: "RECORDING_FAILED", messageKey: "recording.device_disconnected" } },
    ]);
    expect(state).toMatchObject({ status: "error", candidate: null, attemptCount: 1 });
  });

  it("ignores events that are not valid in the current state", () => {
    expect(run([{ type: "UPLOAD_STARTED" }])).toBe(INITIAL_RECORDER_STATE);
    expect(run([{ type: "UPLOAD_SUCCEEDED" }])).toBe(INITIAL_RECORDER_STATE);
    expect(run([{ type: "UPLOAD_FAILED", error: uploadError }])).toBe(INITIAL_RECORDER_STATE);
    expect(run([{ type: "RECORDING_FINISHED", candidate: candidate("blob:1", 1) }])).toBe(INITIAL_RECORDER_STATE);
    const recording = run([{ type: "RECORDING_STARTED", capture }]);
    expect(run([{ type: "RECORDING_STARTED", capture }], recording)).toBe(recording);
    expect(run([{ type: "PERMISSION_REQUESTED" }], recording)).toBe(recording);
  });

  it("RESET returns to the first state with zero attempts", () => {
    const state = run([
      { type: "RECORDING_STARTED", capture },
      { type: "RECORDING_FINISHED", candidate: candidate("blob:1", 1) },
      { type: "RESET" },
    ]);
    expect(state).toEqual(INITIAL_RECORDER_STATE);
  });
});

describe("minimum duration and silence", () => {
  it("isBelowMinimumDuration", () => {
    expect(isBelowMinimumDuration(candidate("blob:1", 1, 900), 1000)).toBe(true);
    expect(isBelowMinimumDuration(candidate("blob:1", 1, 1000), 1000)).toBe(false);
    expect(isBelowMinimumDuration(candidate("blob:1", 1, 10), undefined)).toBe(false);
    expect(isBelowMinimumDuration(candidate("blob:1", 1, 10), 0)).toBe(false);
    expect(isBelowMinimumDuration(null, 1000)).toBe(false);
  });

  it("seemsSilent is true only for a measured peak near zero", () => {
    expect(seemsSilent(0)).toBe(true);
    expect(seemsSilent(0.001)).toBe(true);
    expect(seemsSilent(0.01)).toBe(false);
    expect(seemsSilent(null)).toBe(false);
    expect(seemsSilent(undefined)).toBe(false);
  });
});
