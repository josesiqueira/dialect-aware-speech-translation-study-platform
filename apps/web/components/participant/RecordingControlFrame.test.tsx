import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RECORDING_LABELS,
  RecordingControlFrame,
  type RecordingControlFrameProps,
  type RecordingControlState,
} from "./RecordingControlFrame";

function setup(overrides: Partial<RecordingControlFrameProps> = {}) {
  const handlers = {
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRecordAgain: vi.fn(),
    onSubmit: vi.fn(),
    onRetryUpload: vi.fn(),
  };
  const props: RecordingControlFrameProps = { state: "idle", ...handlers, ...overrides };
  const view = render(<RecordingControlFrame {...props} />);
  const rerender = (next: Partial<RecordingControlFrameProps>) =>
    view.rerender(<RecordingControlFrame {...props} {...next} />);
  return { handlers, rerender, container: view.container, unmount: view.unmount };
}

const announcement = () => screen.getByTestId("recording-announcement");

describe("RecordingControlFrame", () => {
  it("announces each state through one polite live region", () => {
    const { rerender } = setup();
    expect(announcement()).toHaveAttribute("aria-live", "polite");
    expect(announcement()).toHaveAttribute("role", "status");
    expect(announcement()).toBeEmptyDOMElement();

    const expected: [RecordingControlState, string][] = [
      ["requesting_permission", DEFAULT_RECORDING_LABELS.announceRequestingPermission],
      ["recording", DEFAULT_RECORDING_LABELS.announceRecording],
      ["stopped", DEFAULT_RECORDING_LABELS.announceStopped],
      ["uploading", DEFAULT_RECORDING_LABELS.announceUploading],
      ["upload_failed", DEFAULT_RECORDING_LABELS.announceUploadFailed],
      ["error", DEFAULT_RECORDING_LABELS.announceError],
    ];
    for (const [state, text] of expected) {
      rerender({ state, candidateUrl: "blob:placeholder" });
      expect(announcement()).toHaveTextContent(text);
    }
  });

  it("does not change the announcement while the timer runs, and keeps the timer out of live regions", () => {
    const { rerender } = setup({ state: "recording", elapsedMs: 1000 });
    const region = announcement();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(region, { childList: true, characterData: true, subtree: true });

    rerender({ state: "recording", elapsedMs: 14_000 });
    rerender({ state: "recording", elapsedMs: 15_000 });
    mutations.push(...observer.takeRecords());
    observer.disconnect();

    expect(mutations).toHaveLength(0);
    expect(region).toHaveTextContent("Recording started.");

    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("00:15");
    expect(timer).toHaveAttribute("aria-live", "off");
    expect(timer.closest("[aria-live='polite'], [aria-live='assertive'], [role='status'], [role='alert']")).toBeNull();
    expect(region).not.toHaveTextContent("00:15");
  });

  it("starts from idle and stops while recording", async () => {
    const user = userEvent.setup();
    const { handlers, rerender } = setup();
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    expect(handlers.onStart).toHaveBeenCalledTimes(1);

    rerender({ state: "recording", elapsedMs: 14_000 });
    expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();
    expect(screen.getByText("Recording")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
  });

  it("disables Start while permission is requested", () => {
    setup({ state: "requesting_permission" });
    const button = screen.getByRole("button", { name: DEFAULT_RECORDING_LABELS.requestingPermission });
    expect(button).toBeDisabled();
    expect(screen.getByText(DEFAULT_RECORDING_LABELS.permissionHint)).toBeVisible();
  });

  it("offers native playback, Record again and Submit once stopped", async () => {
    const user = userEvent.setup();
    const { handlers, container } = setup({ state: "stopped", candidateUrl: "blob:placeholder" });
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAccessibleName("Your recording");
    await user.click(screen.getByRole("button", { name: "Record again" }));
    await user.click(screen.getByRole("button", { name: "Submit and continue" }));
    expect(handlers.onRecordAgain).toHaveBeenCalledTimes(1);
    expect(handlers.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("respects canSubmit", () => {
    setup({ state: "stopped", candidateUrl: "blob:placeholder", canSubmit: false });
    expect(screen.getByRole("button", { name: "Submit and continue" })).toBeDisabled();
  });

  it("locks both actions while uploading", () => {
    setup({ state: "uploading", candidateUrl: "blob:placeholder" });
    expect(screen.getByRole("button", { name: "Uploading..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Record again" })).toBeDisabled();
  });

  it("keeps the candidate after a failed upload and retries without re-recording", async () => {
    const user = userEvent.setup();
    const { handlers, container } = setup({ state: "upload_failed", candidateUrl: "blob:placeholder" });
    expect(screen.getByRole("alert")).toHaveTextContent(DEFAULT_RECORDING_LABELS.uploadFailed);
    expect(container.querySelector("audio")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Try uploading again" }));
    expect(handlers.onRetryUpload).toHaveBeenCalledTimes(1);
    expect(handlers.onSubmit).not.toHaveBeenCalled();
  });

  it("explains a microphone error in plain language and lets the participant try again", async () => {
    const user = userEvent.setup();
    const { handlers } = setup({ state: "error", errorMessage: "Microphone access was blocked for this page." });
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone access was blocked for this page.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
  });

  describe("keyboard focus when the controls are replaced (WCAG 2.4.3)", () => {
    it("does not take focus on the first render, in any state", () => {
      for (const state of ["idle", "recording", "stopped", "upload_failed", "error"] as const) {
        const { unmount } = render(
          <RecordingControlFrame
            state={state}
            candidateUrl="blob:placeholder"
            onStart={vi.fn()}
            onStop={vi.fn()}
            onRecordAgain={vi.fn()}
            onSubmit={vi.fn()}
          />,
        );
        expect(document.body, state).toHaveFocus();
        unmount();
      }
    });

    it("moves focus to Stop after Start, also through the permission state", async () => {
      const user = userEvent.setup();
      const { rerender } = setup();
      await user.click(screen.getByRole("button", { name: "Start recording" }));
      rerender({ state: "requesting_permission" });
      // Nothing can be used while the browser asks for permission: focus waits.
      expect(document.body).toHaveFocus();
      rerender({ state: "recording" });
      expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
    });

    it("moves focus to the player after Stop, with Record again and Submit next in tab order", async () => {
      const user = userEvent.setup();
      const { rerender, container } = setup({ state: "recording" });
      screen.getByRole("button", { name: "Stop" }).focus();
      await user.keyboard("{Enter}");
      rerender({ state: "stopped", candidateUrl: "blob:placeholder" });
      expect(container.querySelector("audio")).toHaveFocus();
      // The announcement is unchanged: one polite message.
      expect(announcement()).toHaveTextContent(DEFAULT_RECORDING_LABELS.announceStopped);
      await user.tab();
      expect(screen.getByRole("button", { name: "Submit and continue" })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "Record again" })).toHaveFocus();
    });

    it("moves focus to the player when the recording stops by itself while focus is on Stop", () => {
      const { rerender, container } = setup({ state: "recording" });
      screen.getByRole("button", { name: "Stop" }).focus();
      rerender({ state: "stopped", candidateUrl: "blob:placeholder" });
      expect(container.querySelector("audio")).toHaveFocus();
    });

    it("moves focus to Submit when there is no player, and to Record again when Submit is disabled", async () => {
      const user = userEvent.setup();
      const first = setup({ state: "recording" });
      await user.click(screen.getByRole("button", { name: "Stop" }));
      first.rerender({ state: "stopped", candidateUrl: null });
      expect(screen.getByRole("button", { name: "Submit and continue" })).toHaveFocus();
      first.unmount();

      const second = setup({ state: "recording" });
      await user.click(screen.getByRole("button", { name: "Stop" }));
      second.rerender({ state: "stopped", candidateUrl: null, canSubmit: false });
      expect(screen.getByRole("button", { name: "Record again" })).toHaveFocus();
    });

    it("moves focus to Stop after Record again, and to the retry button after a failed upload", async () => {
      const user = userEvent.setup();
      const { rerender } = setup({ state: "stopped", candidateUrl: "blob:placeholder" });
      await user.click(screen.getByRole("button", { name: "Record again" }));
      rerender({ state: "recording" });
      expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Stop" }));
      rerender({ state: "stopped", candidateUrl: "blob:placeholder" });
      await user.click(screen.getByRole("button", { name: "Submit and continue" }));
      rerender({ state: "uploading", candidateUrl: "blob:placeholder" });
      rerender({ state: "upload_failed", candidateUrl: "blob:placeholder" });
      expect(screen.getByRole("button", { name: "Try uploading again" })).toHaveFocus();
    });

    it("moves focus to Try again when the microphone cannot be used", async () => {
      const user = userEvent.setup();
      const { rerender } = setup();
      await user.click(screen.getByRole("button", { name: "Start recording" }));
      rerender({ state: "error" });
      expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
    });

    it("leaves focus alone when the state changes without the participant using the control", async () => {
      const user = userEvent.setup();
      const outside = document.createElement("button");
      outside.textContent = "Outside";
      document.body.append(outside);
      try {
        // Focus was never in the control: a state change does not take it.
        const first = setup({ state: "recording" });
        first.rerender({ state: "stopped", candidateUrl: "blob:placeholder" });
        expect(document.body).toHaveFocus();
        first.unmount();

        // The participant started, then moved to another part of the page.
        const second = setup();
        await user.click(screen.getByRole("button", { name: "Start recording" }));
        outside.focus();
        second.rerender({ state: "recording" });
        expect(outside).toHaveFocus();
        second.rerender({ state: "stopped", candidateUrl: "blob:placeholder" });
        expect(outside).toHaveFocus();
      } finally {
        outside.remove();
      }
    });
  });

  it("accepts localized labels", () => {
    setup({ labels: { start: "Aloita nauhoitus" } });
    expect(screen.getByRole("button", { name: "Aloita nauhoitus" })).toBeVisible();
  });
});
