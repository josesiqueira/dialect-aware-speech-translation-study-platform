import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecorderError } from "@/lib/client/recorder";
import { levelToFraction } from "./LevelMeter";
import { fillLabel } from "./labels";
import { MicCheck, type MicCheckProps } from "./MicCheck";
import { makeFakeEnvironment } from "./recorderTestHelpers";
import { RecordingTask } from "./RecordingTask";

describe("RecordingTask", () => {
  it("records, fails the upload, keeps the candidate and retries with the same recording", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const { container } = render(
      <RecordingTask prompt={<p>Describe your morning.</p>} maxDurationMs={120_000} onSubmit={onSubmit} dependencies={env.dependencies} />,
    );
    expect(screen.getByText("Describe your morning.")).toBeInTheDocument();
    expect(screen.getByText("The recording stops by itself after 02:00.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    expect(screen.getByTestId("recording-announcement")).toHaveTextContent("Recording started.");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByTestId("recording-announcement")).toHaveTextContent("Recording stopped.");
    expect(container.querySelector("audio source")).toHaveAttribute("src", "blob:test/1");

    await user.click(screen.getByRole("button", { name: "Submit and continue" }));
    await screen.findByRole("button", { name: "Try uploading again" });
    expect(container.querySelector("audio source")).toHaveAttribute("src", "blob:test/1");
    expect(env.revokedUrls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Try uploading again" }));
    await screen.findByText("The recording was saved.");
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1][0]).toBe(onSubmit.mock.calls[0][0]);
    expect(onSubmit.mock.calls[1][1]).toMatchObject({ attemptCount: 1 });
    expect(env.recorders).toHaveLength(1);
    expect(env.revokedUrls).toEqual(["blob:test/1"]);
  });

  it("moves keyboard focus through Start, Stop, the player and the retry button of a real recorder", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const { container } = render(<RecordingTask maxDurationMs={120_000} onSubmit={onSubmit} dependencies={env.dependencies} />);
    expect(document.body).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Start recording" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus());
    await user.keyboard(" ");
    await waitFor(() => expect(container.querySelector("audio")).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Submit and continue" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try uploading again" })).toHaveFocus());
  });

  it("disables submit below the minimum duration and explains it as a hint", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    env.setResult({ durationMs: 800 });
    const onSubmit = vi.fn();
    render(<RecordingTask maxDurationMs={60_000} minDurationMs={3000} onSubmit={onSubmit} dependencies={env.dependencies} />);
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("button", { name: "Submit and continue" })).toBeDisabled();
    expect(screen.getAllByText(/speak for at least 3 seconds/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record again" })).toBeEnabled();
  });

  it("passes the attempt count of the submitted recording after a re-record", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCandidateChange = vi.fn();
    render(
      <RecordingTask maxDurationMs={60_000} onSubmit={onSubmit} onCandidateChange={onCandidateChange} dependencies={env.dependencies} />,
    );
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Record again" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Submit and continue" }));
    await screen.findByText("The recording was saved.");
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ url: "blob:test/2", attempt: 2 });
    expect(onSubmit.mock.calls[0][1]).toMatchObject({ attemptCount: 2 });
    expect(env.revokedUrls).toEqual(["blob:test/1", "blob:test/2"]);
    expect(onCandidateChange).toHaveBeenLastCalledWith(null);
  });

  it("shows a plain-language message for a refused permission, with localized labels", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    env.failNextMicrophone(new RecorderError("MICROPHONE_PERMISSION_DENIED", "microphone.permission_denied", "denied"));
    render(
      <RecordingTask
        maxDurationMs={60_000}
        onSubmit={vi.fn()}
        dependencies={env.dependencies}
        labels={{ start: "Aloita", errors: { "microphone.permission_denied": "Mikrofonin käyttö on estetty." } }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Aloita" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mikrofonin käyttö on estetty.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("MicCheck", () => {
  it("has no upload prop: the only output is onContinue with technical settings", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const onContinue = vi.fn<MicCheckProps["onContinue"]>();
    const { container } = render(<MicCheck onContinue={onContinue} dependencies={env.dependencies} />);

    // Nothing is requested before the participant presses the button.
    expect(env.dependencies.requestMicrophone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Allow microphone" }));
    await user.click(await screen.findByRole("button", { name: "Record test" }));
    expect(env.recorders[0].options.maxDurationMs).toBe(5000);
    expect(screen.getByTestId("mic-check-announcement")).toHaveTextContent("Recording started.");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    // Playback is the native player alone: no second Play button next to it.
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
    expect(container.querySelector("audio")).toHaveAttribute("controls");
    expect(container.querySelector("audio")).toHaveAccessibleName("Your test recording");

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    const result = onContinue.mock.calls[0][0];
    expect(Object.keys(result).sort()).toEqual(["audioEnvironment", "browserInfo", "constraintMismatches", "fallback"]);
    expect(result.audioEnvironment).toEqual({
      deviceLabel: "Test microphone",
      requestedConstraints: { channelCount: 1 },
      actualTrackSettings: { channelCount: 1, sampleRate: 48000 },
      audioContextSampleRate: 48000,
      captureMethod: "audio_worklet_pcm",
    });
    expect(result.browserInfo).toEqual({ userAgent: navigator.userAgent, language: navigator.language });
    // No audio in the result: no Blob and no blob URL anywhere.
    expect(JSON.stringify(result)).not.toContain("blob:");
    const containsBlob = (value: unknown): boolean =>
      value instanceof Blob || (typeof value === "object" && value !== null && Object.values(value).some(containsBlob));
    expect(containsBlob(result)).toBe(false);
    // The test recording was dropped and the microphone released.
    expect(env.revokedUrls).toEqual(["blob:test/1"]);
    expect(env.microphones[0].track.stop).toHaveBeenCalled();
  });

  it("keeps keyboard focus on the control that replaces the pressed one", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const { container } = render(<MicCheck onContinue={vi.fn()} dependencies={env.dependencies} />);
    // Nothing takes focus before the participant acts.
    expect(document.body).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Allow microphone" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Record test" })).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(container.querySelector("audio")).toHaveFocus());

    // Try again records at once: focus is on Stop again.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus());
  });

  it("moves focus to Try again when the microphone cannot be opened", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    env.failNextMicrophone(new RecorderError("MICROPHONE_PERMISSION_DENIED", "microphone.permission_denied", "test"));
    render(<MicCheck onContinue={vi.fn()} dependencies={env.dependencies} />);
    await user.click(screen.getByRole("button", { name: "Allow microphone" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus());
  });

  it("Try again discards the previous test, and leaving the step discards the last one", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    const { unmount } = render(<MicCheck onContinue={vi.fn()} dependencies={env.dependencies} />);
    await user.click(screen.getByRole("button", { name: "Allow microphone" }));
    await user.click(await screen.findByRole("button", { name: "Record test" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(env.revokedUrls).toEqual(["blob:test/1"]);
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    unmount();
    expect(env.revokedUrls).toEqual(["blob:test/1", "blob:test/2"]);
    expect(env.microphones[0].track.stop).toHaveBeenCalled();
  });

  it("warns in plain language when the test is silent", async () => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    env.setResult({ peak: 0 });
    render(<MicCheck onContinue={vi.fn()} dependencies={env.dependencies} />);
    await user.click(screen.getByRole("button", { name: "Allow microphone" }));
    await user.click(await screen.findByRole("button", { name: "Record test" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByText(/The test seems to be silent/)).toBeInTheDocument();
  });

  it.each([
    ["microphone.permission_denied", "MICROPHONE_PERMISSION_DENIED", /not allowed to use the microphone/],
    ["microphone.not_found", "RECORDING_FAILED", /No microphone was found/],
    ["microphone.busy", "RECORDING_FAILED", /Another program may be using it/],
  ] as const)("explains %s and offers Try again", async (messageKey, code, text) => {
    const user = userEvent.setup();
    const env = makeFakeEnvironment();
    env.failNextMicrophone(new RecorderError(code, messageKey, "test"));
    render(<MicCheck onContinue={vi.fn()} dependencies={env.dependencies} />);
    await user.click(screen.getByRole("button", { name: "Allow microphone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record test" })).toBeInTheDocument());
  });
});

describe("helpers", () => {
  it("fillLabel replaces known placeholders and leaves unknown ones", () => {
    expect(fillLabel("Stops after {duration}.", { duration: "02:00" })).toBe("Stops after 02:00.");
    expect(fillLabel("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });

  it("levelToFraction maps -60 dBFS to 0 and full scale to 1", () => {
    expect(levelToFraction(null)).toBe(0);
    expect(levelToFraction(0)).toBe(0);
    expect(levelToFraction(0.001)).toBeCloseTo(0, 6);
    expect(levelToFraction(1)).toBe(1);
    expect(levelToFraction(2)).toBe(1);
    expect(levelToFraction(0.0316)).toBeCloseTo(0.5, 2);
  });
});
