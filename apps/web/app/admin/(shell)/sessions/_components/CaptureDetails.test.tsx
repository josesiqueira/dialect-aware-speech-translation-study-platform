import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { corpusSchemas } from "@dialect/domain";
import { CaptureDetails } from "./UtteranceBlock";

const EMPTY: corpusSchemas.CaptureDetailsView = {
  constraintMismatches: [],
  deviceClass: null,
  fallbackReason: null,
  fallbackDetail: null,
  inputChannelCount: null,
  clippedSampleCount: null,
  peak: null,
  declaredBitDepth: null,
  stoppedBy: null,
};

describe("CaptureDetails", () => {
  it("is a closed disclosure that lists the recorder facts", () => {
    render(
      <CaptureDetails
        details={{
          ...EMPTY,
          deviceClass: "usb",
          inputChannelCount: 2,
          clippedSampleCount: 1200,
          peak: 1.0234,
          declaredBitDepth: 24,
          stoppedBy: "max_duration",
        }}
      />,
    );
    const disclosure = screen.getByTestId("capture-details");
    expect(disclosure.tagName).toBe("DETAILS");
    expect(disclosure).not.toHaveAttribute("open");
    expect(within(disclosure).getByText("Capture details")).toBeInTheDocument();

    const facts = Object.fromEntries(
      within(disclosure)
        .getAllByRole("term")
        .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
    );
    expect(facts).toEqual({
      "Input device class": "USB microphone",
      "Input channels": "2 (channel 1 was kept)",
      "Declared bit depth": "24-bit",
      "Peak before conversion": "1.023",
      "Clipped samples": "1,200",
      "Stopped by": "the maximum duration",
    });
    // No mismatch: no warning.
    expect(within(disclosure).queryByText(/not confirmed/)).not.toBeInTheDocument();
    expect(within(disclosure).queryByText(/did not confirm/)).not.toBeInTheDocument();
  });

  it("calls out capture settings the browser did not confirm, as a warning and not as an error", () => {
    render(
      <CaptureDetails
        details={{
          ...EMPTY,
          constraintMismatches: [
            { constraint: "echoCancellation", kind: "not_honored", requested: "false", actual: "true" },
            { constraint: "noiseSuppression", kind: "not_reported", requested: "false", actual: null },
          ],
        }}
      />,
    );
    const disclosure = screen.getByTestId("capture-details");
    // Visible in the summary line while the disclosure is closed.
    expect(within(disclosure.querySelector("summary") as HTMLElement).getByText("2 settings not confirmed")).toBeInTheDocument();
    expect(within(disclosure).getByText("Requested capture settings the browser did not confirm")).toBeInTheDocument();
    const items = within(disclosure).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("echoCancellation: the browser used a different value (requested false, actual true)");
    expect(items[1]).toHaveTextContent(
      "noiseSuppression: the browser did not report the value it used (requested false, actual not reported)",
    );
    expect(within(disclosure).getByText(/Consider this in acoustic analysis/)).toBeInTheDocument();
    expect(disclosure.querySelector(".text-rose-700, .bg-rose-50")).toBeNull();
  });

  it("never shows a raw device label, also when a legacy response still carries one", () => {
    // A response of an older server version: a raw label and no class.
    const legacy = { ...EMPTY, inputChannelCount: 1, deviceLabel: "Jose's AirPods Pro" } as corpusSchemas.CaptureDetailsView;
    render(<CaptureDetails details={legacy} />);
    const disclosure = screen.getByTestId("capture-details");
    expect(disclosure).not.toHaveTextContent("AirPods");
    expect(within(disclosure).queryByText(/Input device/)).not.toBeInTheDocument();
  });

  it("explains a compressed fallback", () => {
    render(
      <CaptureDetails
        details={{ ...EMPTY, fallbackReason: "audio_worklet_failed", fallbackDetail: "The worklet did not load." }}
      />,
    );
    expect(screen.getByText("Compressed capture used because")).toBeInTheDocument();
    expect(screen.getByText("lossless capture failed to start (The worklet did not load.)")).toBeInTheDocument();
    expect(screen.queryByText(/not confirmed/)).not.toBeInTheDocument();
  });
});
