// Constraint request, mismatch detection, MIME type selection and error mapping.
import { describe, expect, it, vi } from "vitest";
import { claimRecording, isRecordingActive, releaseRecording } from "./activeRecording";
import { buildAudioConstraints, contextRateMismatch, detectConstraintMismatches } from "./constraints";
import { mapGetUserMediaError, RecorderError, toRecorderError } from "./errors";
import { FALLBACK_MIME_TYPES, selectFallbackMimeType } from "./MediaRecorderFallback";
import { describeMicrophone, releaseStream, requestMicrophone } from "./microphone";

function fakeTrack(settings: Record<string, unknown>, label = "Test microphone") {
  return {
    label,
    readyState: "live",
    getSettings: () => settings,
    getCapabilities: () => ({ sampleRate: { min: 8000, max: 48000 } }),
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function fakeStream(track: ReturnType<typeof fakeTrack>): MediaStream {
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

describe("buildAudioConstraints", () => {
  it("asks for mono without browser processing (spec 31.1)", () => {
    expect(buildAudioConstraints()).toEqual({
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it("adds the 48 kHz preference only where sampleRate is a supported constraint", () => {
    expect(buildAudioConstraints({ supportedConstraints: { sampleRate: true } }).sampleRate).toEqual({ ideal: 48000 });
    expect("sampleRate" in buildAudioConstraints({ supportedConstraints: { sampleRate: false } })).toBe(false);
    expect("sampleRate" in buildAudioConstraints({ supportedConstraints: {} })).toBe(false);
  });

  it("uses only preferences, never hard requirements", () => {
    const constraints = buildAudioConstraints({ supportedConstraints: { sampleRate: true }, deviceId: "abc" });
    expect(JSON.stringify(constraints)).not.toContain("exact");
    expect(constraints.deviceId).toEqual({ ideal: "abc" });
  });
});

describe("detectConstraintMismatches", () => {
  const requested = buildAudioConstraints({ supportedConstraints: { sampleRate: true } });

  it("reports nothing when every setting was honored", () => {
    expect(
      detectConstraintMismatches(requested, {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
      }),
    ).toEqual([]);
  });

  it("reports echo cancellation that is still on, another rate and another channel count", () => {
    expect(
      detectConstraintMismatches(requested, {
        channelCount: 2,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 16000,
      }),
    ).toEqual([
      { constraint: "channelCount", kind: "not_honored", requested: 1, actual: 2 },
      { constraint: "echoCancellation", kind: "not_honored", requested: false, actual: true },
      { constraint: "sampleRate", kind: "not_honored", requested: 48000, actual: 16000 },
    ]);
  });

  it("treats a non-boolean echo cancellation mode as not honored", () => {
    const mismatches = detectConstraintMismatches(requested, {
      channelCount: 1,
      echoCancellation: "all",
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48000,
    });
    expect(mismatches).toEqual([{ constraint: "echoCancellation", kind: "not_honored", requested: false, actual: "all" }]);
  });

  it("reports a setting the browser does not report as unknown, not as honored", () => {
    const mismatches = detectConstraintMismatches(requested, { channelCount: 1, echoCancellation: false });
    expect(mismatches).toEqual([
      { constraint: "noiseSuppression", kind: "not_reported", requested: false, actual: null },
      { constraint: "autoGainControl", kind: "not_reported", requested: false, actual: null },
      { constraint: "sampleRate", kind: "not_reported", requested: 48000, actual: null },
    ]);
  });

  it("does not compare a rate that was never requested", () => {
    const withoutRate = buildAudioConstraints();
    expect(
      detectConstraintMismatches(withoutRate, {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
      }),
    ).toEqual([]);
  });
});

describe("contextRateMismatch", () => {
  it("is null when the context ran at the track rate or the track rate is unknown", () => {
    expect(contextRateMismatch(48000, 48000)).toBeNull();
    expect(contextRateMismatch(undefined, 48000)).toBeNull();
  });

  it("makes browser resampling visible", () => {
    expect(contextRateMismatch(16000, 48000)).toEqual({
      constraint: "sampleRate",
      kind: "context_rate_differs",
      requested: 16000,
      actual: 48000,
    });
  });
});

describe("selectFallbackMimeType", () => {
  it("prefers WebM Opus, then Ogg Opus, then MP4", () => {
    expect([...FALLBACK_MIME_TYPES]).toEqual(["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]);
    expect(selectFallbackMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(selectFallbackMimeType((type) => type !== "audio/webm;codecs=opus")).toBe("audio/ogg;codecs=opus");
    expect(selectFallbackMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("returns null when nothing is supported and survives a throwing check", () => {
    expect(selectFallbackMimeType(() => false)).toBeNull();
    expect(
      selectFallbackMimeType((type) => {
        if (type.includes("webm")) throw new Error("boom");
        return type.includes("ogg");
      }),
    ).toBe("audio/ogg;codecs=opus");
  });
});

describe("mapGetUserMediaError", () => {
  const named = (name: string) => Object.assign(new Error("x"), { name });

  it("maps a refused permission to MICROPHONE_PERMISSION_DENIED", () => {
    const error = mapGetUserMediaError(named("NotAllowedError"));
    expect(error).toBeInstanceOf(RecorderError);
    expect(error.code).toBe("MICROPHONE_PERMISSION_DENIED");
    expect(error.messageKey).toBe("microphone.permission_denied");
  });

  it("maps missing and busy devices to RECORDING_FAILED with their own message keys", () => {
    expect(mapGetUserMediaError(named("NotFoundError"))).toMatchObject({ code: "RECORDING_FAILED", messageKey: "microphone.not_found" });
    expect(mapGetUserMediaError(named("NotReadableError"))).toMatchObject({ code: "RECORDING_FAILED", messageKey: "microphone.busy" });
    expect(mapGetUserMediaError(named("AbortError"))).toMatchObject({ code: "RECORDING_FAILED", messageKey: "microphone.busy" });
    expect(mapGetUserMediaError(named("TypeError"))).toMatchObject({ code: "RECORDING_FAILED", messageKey: "microphone.unsupported" });
    expect(mapGetUserMediaError(named("SomethingElse"))).toMatchObject({ code: "RECORDING_FAILED", messageKey: "recording.start_failed" });
  });

  it("toRecorderError keeps a RecorderError and wraps anything else", () => {
    const original = new RecorderError("RECORDING_FAILED", "recording.empty", "empty");
    expect(toRecorderError(original)).toBe(original);
    expect(toRecorderError(new Error("boom"), "recording.interrupted")).toMatchObject({
      code: "RECORDING_FAILED",
      messageKey: "recording.interrupted",
    });
  });
});

describe("requestMicrophone", () => {
  it("requests the spec constraints and returns the actual settings and mismatches", async () => {
    const track = fakeTrack({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 16000,
      deviceId: "device-id-secret",
      groupId: "group-id-secret",
    });
    const getUserMedia = vi.fn(async () => fakeStream(track));
    const access = await requestMicrophone({
      mediaDevices: { getUserMedia, getSupportedConstraints: () => ({ sampleRate: true }) as MediaTrackSupportedConstraints },
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 48000 },
      },
      video: false,
    });
    expect(access.actualTrackSettings).toMatchObject({ echoCancellation: true, sampleRate: 16000 });
    // Nothing that identifies the device is kept: no deviceId, no groupId, and
    // the class of the device instead of its label.
    expect(access.actualTrackSettings).not.toHaveProperty("deviceId");
    expect(access.actualTrackSettings).not.toHaveProperty("groupId");
    expect(access.deviceLabel).toBe("unknown");
    expect(JSON.stringify({ ...access, stream: null, track: null })).not.toMatch(/device-id-secret|group-id-secret|Test microphone/);
    expect(access.capabilities).toEqual({ sampleRate: { min: 8000, max: 48000 } });
    expect(access.constraintMismatches.map((mismatch) => mismatch.constraint)).toEqual(["echoCancellation", "sampleRate"]);
  });

  it("reports the class of the input device and never its label or identifiers", async () => {
    const track = fakeTrack({ channelCount: 1, deviceId: "device-id-secret", groupId: "group-id-secret" }, "Anna Virtasen AirPods Pro");
    const getUserMedia = vi.fn(async () => fakeStream(track));
    const access = await requestMicrophone({ deviceId: "device-id-secret", mediaDevices: { getUserMedia } });
    // The chosen device is still requested from the browser.
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: expect.objectContaining({ deviceId: { ideal: "device-id-secret" } }) }),
    );
    expect(access.deviceLabel).toBe("bluetooth");
    expect(access.requestedConstraints).not.toHaveProperty("deviceId");
    expect(JSON.stringify({ ...access, stream: null, track: null })).not.toMatch(/device-id-secret|group-id-secret|Virtasen/);
  });

  it("maps a refused permission", async () => {
    const getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    await expect(requestMicrophone({ mediaDevices: { getUserMedia } })).rejects.toMatchObject({
      code: "MICROPHONE_PERMISSION_DENIED",
      messageKey: "microphone.permission_denied",
    });
  });

  it("reports an unsupported browser when there is no getUserMedia", async () => {
    await expect(
      requestMicrophone({ mediaDevices: {} as unknown as Pick<MediaDevices, "getUserMedia"> }),
    ).rejects.toMatchObject({ code: "RECORDING_FAILED", messageKey: "microphone.unsupported" });
  });

  it("describeMicrophone gives a null label when the permission does not expose it", () => {
    const access = describeMicrophone(fakeStream(fakeTrack({}, "")), buildAudioConstraints());
    expect(access.deviceLabel).toBeNull();
  });

  it("releaseStream stops every track", () => {
    const track = fakeTrack({});
    releaseStream(fakeStream(track));
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(() => releaseStream(null)).not.toThrow();
  });
});

describe("one recording at a time", () => {
  it("refuses a second owner until the first one is released", () => {
    const first = {};
    const second = {};
    claimRecording(first);
    expect(isRecordingActive()).toBe(true);
    expect(() => claimRecording(second)).toThrowError(RecorderError);
    try {
      claimRecording(second);
    } catch (error) {
      expect(error).toMatchObject({ code: "RECORDING_FAILED", messageKey: "recording.already_active" });
    }
    releaseRecording(second); // not the owner: no effect
    expect(isRecordingActive()).toBe(true);
    releaseRecording(first);
    expect(isRecordingActive()).toBe(false);
    expect(() => claimRecording(second)).not.toThrow();
    releaseRecording(second);
  });
});
