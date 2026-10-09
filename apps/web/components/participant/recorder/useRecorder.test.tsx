import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecorderError } from "@/lib/client/recorder";
import { makeFakeEnvironment, makeResult } from "./recorderTestHelpers";
import { useRecorder, type UseRecorderOptions } from "./useRecorder";

function setup(options: Partial<UseRecorderOptions> = {}) {
  const env = makeFakeEnvironment();
  const hook = renderHook(() => useRecorder({ maxDurationMs: 60_000, dependencies: env.dependencies, ...options }));
  return { env, hook };
}

async function recordOnce(hook: ReturnType<typeof setup>["hook"]) {
  await act(() => hook.result.current.start());
  await act(() => hook.result.current.stop());
}

describe("useRecorder", () => {
  it("does not touch the microphone on mount", () => {
    const { env, hook } = setup();
    expect(hook.result.current.state).toBe("idle");
    expect(env.dependencies.requestMicrophone).not.toHaveBeenCalled();
    expect(env.dependencies.createRecorder).not.toHaveBeenCalled();
  });

  it("records, stops and exposes a candidate with a blob URL", async () => {
    const { env, hook } = setup();
    await act(() => hook.result.current.start());
    expect(hook.result.current.state).toBe("recording");
    expect(hook.result.current.attemptCount).toBe(1);
    expect(hook.result.current.microphone?.constraintMismatches).toHaveLength(1);
    expect(env.recorders[0].options).toMatchObject({ prefer: "pcm", maxDurationMs: 60_000 });

    await act(() => hook.result.current.stop());
    const { candidate } = hook.result.current;
    expect(hook.result.current.state).toBe("stopped");
    expect(candidate).toMatchObject({
      url: "blob:test/1",
      attempt: 1,
      captureMethod: "audio_worklet_pcm",
      captureQualityClass: "lossless_pcm",
      durationMs: 3000,
    });
    expect(hook.result.current.canSubmit).toBe(true);
    expect(hook.result.current.elapsedMs).toBe(3000);
  });

  it("shows requesting_permission while the browser prompt is open", async () => {
    const env = makeFakeEnvironment();
    let grant: () => void = () => undefined;
    const original = env.dependencies.requestMicrophone;
    env.dependencies.requestMicrophone = vi.fn(async (options) => {
      await new Promise<void>((resolve) => {
        grant = resolve;
      });
      return original(options);
    });
    const hook = renderHook(() => useRecorder({ maxDurationMs: 1000, dependencies: env.dependencies }));
    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = hook.result.current.start();
    });
    expect(hook.result.current.state).toBe("requesting_permission");
    await act(async () => {
      grant();
      await started;
    });
    expect(hook.result.current.state).toBe("recording");
  });

  it("re-recording revokes the previous blob URL at once, reuses the microphone and counts the attempt", async () => {
    const { env, hook } = setup();
    await recordOnce(hook);
    expect(env.revokedUrls).toEqual([]);

    await act(() => hook.result.current.recordAgain());
    expect(env.revokedUrls).toEqual(["blob:test/1"]);
    expect(hook.result.current.state).toBe("recording");
    expect(hook.result.current.candidate).toBeNull();
    expect(hook.result.current.attemptCount).toBe(2);
    // Same stream: no second permission request.
    expect(env.dependencies.requestMicrophone).toHaveBeenCalledTimes(1);

    await act(() => hook.result.current.stop());
    expect(hook.result.current.candidate).toMatchObject({ url: "blob:test/2", attempt: 2 });
    expect(env.revokedUrls).toEqual(["blob:test/1"]);
  });

  it("upload failure keeps the candidate, retry sends the same one, success releases it", async () => {
    const { env, hook } = setup();
    await recordOnce(hook);
    const candidate = hook.result.current.candidate;

    const upload = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(undefined);
    await act(() => hook.result.current.submit(upload));
    expect(hook.result.current.state).toBe("upload_failed");
    expect(hook.result.current.error).toMatchObject({ code: "UPLOAD_FAILED", messageKey: "upload.failed" });
    expect(hook.result.current.candidate).toBe(candidate);
    expect(env.revokedUrls).toEqual([]);

    await act(() => hook.result.current.submit(upload));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0][0]).toBe(candidate);
    expect(upload.mock.calls[1][0]).toBe(candidate);
    expect(upload.mock.calls[1][1].attemptCount).toBe(1);
    expect(hook.result.current.state).toBe("submitted");
    expect(hook.result.current.candidate).toBeNull();
    expect(env.revokedUrls).toEqual(["blob:test/1"]);
    // The step is over: the microphone is released.
    expect(env.microphones[0].track.stop).toHaveBeenCalled();
    // No new recording was made for the retry.
    expect(env.recorders).toHaveLength(1);
  });

  it("reports upload progress while uploading", async () => {
    const { hook } = setup();
    await recordOnce(hook);
    let finish: () => void = () => undefined;
    let submitted: Promise<void> = Promise.resolve();
    act(() => {
      submitted = hook.result.current.submit(async (_candidate, context) => {
        context.onProgress(0.4);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
    });
    expect(hook.result.current.state).toBe("uploading");
    expect(hook.result.current.uploadProgress).toBe(0.4);
    await act(async () => {
      finish();
      await submitted;
    });
    expect(hook.result.current.state).toBe("submitted");
  });

  it("a recording below the minimum duration cannot be submitted, and is not an error", async () => {
    const { env, hook } = setup({ minDurationMs: 5000 });
    env.setResult({ durationMs: 1200 });
    await recordOnce(hook);
    expect(hook.result.current.state).toBe("stopped");
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.belowMinimumDuration).toBe(true);
    expect(hook.result.current.canSubmit).toBe(false);
    const upload = vi.fn();
    await act(() => hook.result.current.submit(upload));
    expect(upload).not.toHaveBeenCalled();
    expect(hook.result.current.state).toBe("stopped");
  });

  it("a limit stop from the recorder becomes a candidate marked max_duration", async () => {
    const { env, hook } = setup();
    await act(() => hook.result.current.start());
    act(() => {
      env.recorders[0].options.onAutoStop?.(makeResult({ stoppedBy: "max_duration", durationMs: 60_000 }));
    });
    expect(hook.result.current.state).toBe("stopped");
    expect(hook.result.current.candidate).toMatchObject({ stoppedBy: "max_duration", durationMs: 60_000 });
  });

  it("maps a refused permission and lets the participant try again", async () => {
    const { env, hook } = setup();
    env.failNextMicrophone(new RecorderError("MICROPHONE_PERMISSION_DENIED", "microphone.permission_denied", "denied"));
    await act(() => hook.result.current.start());
    expect(hook.result.current.state).toBe("error");
    expect(hook.result.current.error).toMatchObject({
      code: "MICROPHONE_PERMISSION_DENIED",
      messageKey: "microphone.permission_denied",
    });
    expect(hook.result.current.attemptCount).toBe(0);
    await act(() => hook.result.current.start());
    expect(hook.result.current.state).toBe("recording");
  });

  it("a device that disappears while recording is RECORDING_FAILED and releases the microphone", async () => {
    const { env, hook } = setup();
    await act(() => hook.result.current.start());
    act(() => {
      env.recorders[0].options.onError?.(
        new RecorderError("RECORDING_FAILED", "recording.device_disconnected", "track ended"),
      );
    });
    expect(hook.result.current.state).toBe("error");
    expect(hook.result.current.error).toMatchObject({ code: "RECORDING_FAILED", messageKey: "recording.device_disconnected" });
    expect(hook.result.current.candidate).toBeNull();
    expect(env.microphones[0].track.stop).toHaveBeenCalled();
    expect(hook.result.current.microphone).toBeNull();
  });

  it("reports the compressed fallback instead of hiding it", async () => {
    const onFallback = vi.fn();
    const { env, hook } = setup({ onFallback });
    env.useFallback();
    env.setResult({ captureMethod: "media_recorder", captureQualityClass: "compressed_fallback", mimeType: "audio/webm;codecs=opus", bitDepth: null });
    await recordOnce(hook);
    expect(onFallback).toHaveBeenCalledWith({ reason: "audio_worklet_failed", detail: "test" });
    expect(hook.result.current.capture).toMatchObject({ captureMethod: "media_recorder", captureQualityClass: "compressed_fallback" });
    expect(hook.result.current.candidate).toMatchObject({ captureQualityClass: "compressed_fallback", bitDepth: null });
  });

  it("discard cancels a running recording, revokes the URL and releases the microphone", async () => {
    const { env, hook } = setup();
    await recordOnce(hook);
    act(() => hook.result.current.discard());
    expect(env.revokedUrls).toEqual(["blob:test/1"]);
    expect(hook.result.current.state).toBe("idle");
    expect(hook.result.current.candidate).toBeNull();
    expect(env.microphones[0].track.stop).toHaveBeenCalled();

    await act(() => hook.result.current.start());
    act(() => hook.result.current.discard());
    expect(env.recorders[1].cancelled).toBe(true);
    expect(env.microphones[1].track.stop).toHaveBeenCalled();
    expect(hook.result.current.state).toBe("idle");
  });

  it("unmount revokes the blob URL, cancels the recorder and releases the microphone", async () => {
    const first = setup();
    await recordOnce(first.hook);
    first.hook.unmount();
    expect(first.env.revokedUrls).toEqual(["blob:test/1"]);
    expect(first.env.microphones[0].track.stop).toHaveBeenCalled();

    const second = setup();
    await act(() => second.hook.result.current.start());
    second.hook.unmount();
    expect(second.env.recorders[0].cancelled).toBe(true);
    expect(second.env.microphones[0].track.stop).toHaveBeenCalled();
  });

  it("pagehide releases everything", async () => {
    const { env, hook } = setup();
    await recordOnce(hook);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(env.revokedUrls).toEqual(["blob:test/1"]);
    expect(env.microphones[0].track.stop).toHaveBeenCalled();
    expect(hook.result.current.state).toBe("idle");
    expect(hook.result.current.candidate).toBeNull();
  });

  it("a microphone that is granted after the step was left is released at once", async () => {
    const env = makeFakeEnvironment();
    let grant: () => void = () => undefined;
    const original = env.dependencies.requestMicrophone;
    env.dependencies.requestMicrophone = vi.fn(async (options) => {
      await new Promise<void>((resolve) => {
        grant = resolve;
      });
      return original(options);
    });
    const hook = renderHook(() => useRecorder({ maxDurationMs: 1000, dependencies: env.dependencies }));
    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = hook.result.current.start();
    });
    hook.unmount();
    await act(async () => {
      grant();
      await started;
    });
    expect(env.microphones[0].track.stop).toHaveBeenCalled();
    expect(env.recorders).toHaveLength(0);
  });

  it("openMicrophone opens the device without recording", async () => {
    const { env, hook } = setup();
    await act(() => hook.result.current.openMicrophone());
    expect(hook.result.current.state).toBe("idle");
    expect(hook.result.current.microphone).toMatchObject({ deviceLabel: "Test microphone" });
    expect(hook.result.current.attemptCount).toBe(0);
    expect(env.recorders).toHaveLength(0);
  });

  it("ignores a second start while one is running", async () => {
    const { env, hook } = setup();
    await act(async () => {
      const first = hook.result.current.start();
      const second = hook.result.current.start();
      await Promise.all([first, second]);
    });
    await act(() => hook.result.current.start());
    expect(env.recorders).toHaveLength(1);
    expect(hook.result.current.attemptCount).toBe(1);
  });
});
