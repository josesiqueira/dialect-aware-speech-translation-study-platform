import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchDetailCard } from "./BatchDetailCard";
import { BatchTable } from "./BatchTable";
import { PreviewWarnings } from "./PreviewWarnings";
import type { BatchDetail, ConfigSnapshot } from "./types";

const config = (overrides: Partial<ConfigSnapshot>): ConfigSnapshot => ({
  modelConfigId: "11111111-1111-4111-8111-111111111111",
  key: "translation_default",
  stage: "translation",
  conditionKey: "default",
  versionNumber: 1,
  provider: "mock",
  modelId: "mock-translation",
  parameters: {},
  promptVersionId: "22222222-2222-4222-8222-222222222222",
  promptKey: "translation_default",
  promptVersionNumber: 1,
  promptText: "Translate the utterance. Return only the translation.",
  ...overrides,
});

// Mock data for one batch that finished with two failed jobs.
function batch(overrides: Partial<BatchDetail> = {}): BatchDetail {
  const translation = config({});
  const tts = config({
    modelConfigId: "33333333-3333-4333-8333-333333333333",
    key: "tts_baseline",
    stage: "tts",
    conditionKey: "baseline",
    modelId: "mock-tts",
    parameters: { voice: "mock-voice", response_format: "wav" },
    promptKey: "tts_baseline",
    promptText: "Speak the text naturally.",
  });
  const label = (snapshot: ConfigSnapshot) => ({
    modelConfigId: snapshot.modelConfigId,
    key: snapshot.key,
    versionNumber: snapshot.versionNumber,
    conditionKey: snapshot.conditionKey ?? snapshot.key,
    provider: snapshot.provider,
    modelId: snapshot.modelId,
    promptKey: snapshot.promptKey,
    promptVersionNumber: snapshot.promptVersionNumber,
  });
  return {
    id: "44444444-4444-4444-8444-444444444444",
    studyId: "55555555-5555-4555-8555-555555555555",
    name: "2026-10-pilot",
    description: "Pilot run",
    status: "completed_with_errors",
    dataMode: "research",
    createdAt: "2026-10-03T09:00:00.000Z",
    startedAt: "2026-10-03T09:05:00.000Z",
    completedAt: "2026-10-03T09:30:00.000Z",
    cancelledAt: null,
    createdByLabel: "admin",
    utteranceCount: 3,
    jobCounts: { queued: 0, running: 0, succeeded: 34, failed: 2, cancelled: 0, total: 36 },
    transcriptTypes: ["asr", "human_dialect", "normalized"],
    config: { asr: null, translations: [label(translation)], tts: [label(tts)] },
    estimatedJobCounts: { asr: 0, translation: 18, tts: 18 },
    estimatedCost: null,
    configuration: {
      selection: {
        mode: ["research"],
        completedSessionsOnly: true,
        verifiedTranscriptsOnly: true,
        excludeFlagged: true,
        excludeExcluded: true,
        dateFrom: null,
        dateTo: null,
      },
      transcriptTypes: ["asr", "human_dialect", "normalized"],
      runAsr: false,
      asr: null,
      translations: [translation],
      tts: [tts],
      sourceLanguage: "fi",
      targetLanguage: "en",
      utteranceIds: [],
      estimatedJobCounts: { asr: 0, translation: 18, tts: 18 },
    },
    outputCounts: { asrRevisions: 0, translations: 17, syntheses: 17 },
    modelRunCounts: { succeeded: 34, failed: 2, running: 0 },
    failedJobs: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        type: "translation",
        status: "failed",
        attempts: 3,
        maxAttempts: 3,
        lastError: "TRANSLATION_PROVIDER_ERROR: The provider returned HTTP 503.",
        availableAt: "2026-10-03T09:10:00.000Z",
        createdAt: "2026-10-03T09:05:00.000Z",
        updatedAt: "2026-10-03T09:12:00.000Z",
        finishedAt: "2026-10-03T09:12:00.000Z",
        payload: { sourceTranscriptRevisionId: "77777777-7777-4777-8777-777777777777" },
      },
    ],
    ...overrides,
  };
}

describe("BatchDetailCard", () => {
  it("shows counts, failed jobs with their errors and the frozen configuration with prompt texts", () => {
    render(<BatchDetailCard batch={batch()} timeZone="Europe/Helsinki" onChanged={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "2026-10-pilot" })).toBeInTheDocument();
    expect(screen.getByText("Completed with errors")).toBeInTheDocument();
    const failed = screen.getByRole("table", { name: "Failed jobs of this batch" });
    expect(within(failed).getByText("TRANSLATION_PROVIDER_ERROR: The provider returned HTTP 503.")).toBeInTheDocument();
    expect(within(failed).getByText("revision 77777777")).toBeInTheDocument();
    expect(within(failed).getByText("3 of 3")).toBeInTheDocument();

    expect(screen.getByText("Translate the utterance. Return only the translation.").tagName).toBe("PRE");
    expect(screen.getByText("Speak the text naturally.")).toBeInTheDocument();
    expect(screen.getByText('{"voice":"mock-voice","response_format":"wav"}')).toBeInTheDocument();

    // Failed jobs can be retried, a finished batch cannot be started or cancelled.
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start batch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel batch" })).not.toBeInTheDocument();
    // No cost is shown when there is no estimate.
    expect(screen.queryByText(/cost/i)).not.toBeInTheDocument();
  });

  it("offers Start and Cancel for a draft and labels a cost as an estimate", () => {
    render(
      <BatchDetailCard
        batch={batch({
          status: "draft",
          startedAt: null,
          completedAt: null,
          dataMode: "test",
          jobCounts: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, total: 0 },
          failedJobs: [],
          estimatedCost: { isEstimate: true, amount: 1.25 },
        })}
        timeZone="UTC"
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Start batch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel batch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry failed" })).not.toBeInTheDocument();
    expect(screen.getByText("No failed jobs.")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText(/Estimated API cost \(estimate\)/)).toBeInTheDocument();
  });
});

describe("BatchTable", () => {
  it("lists the columns of the batch list and marks the selected batch", () => {
    const row = batch();
    render(<BatchTable batches={[row]} selectedId={row.id} timeZone="UTC" onSelect={vi.fn()} />);
    const table = screen.getByRole("table", { name: "Processing batches" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Name",
      "Created",
      "Status",
      "Utterances",
      "Jobs",
      "Succeeded",
      "Failed",
      "Configs",
    ]);
    // The three configuration columns of spec 53 share one compact cell; the whole text is in its title.
    expect(within(table).getByTitle("ASR: none; Translation: translation_default v1; TTS: tts_baseline v1")).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "2026-10-pilot" })).toHaveAttribute("aria-pressed", "true");
    expect(within(table).getByText("translation_default v1")).toBeInTheDocument();
    expect(within(table).getByText("tts_baseline v1")).toBeInTheDocument();
    expect(within(table).getByText("2026-10-03 09:00")).toBeInTheDocument();
  });

  it("shows an empty state when there is no batch", () => {
    render(<BatchTable batches={[]} selectedId={null} timeZone="UTC" onSelect={vi.fn()} />);
    expect(screen.getByText("No processing batches yet.")).toBeInTheDocument();
  });
});

describe("PreviewWarnings", () => {
  it("shows each note of the preview as a warning that does not block the batch", () => {
    render(
      <PreviewWarnings
        warnings={[
          {
            code: "normalized_from_older_dialect_revision",
            message: "For 2 utterances the normalized transcript (C) was copied from an earlier revision of the dialect transcript (B).",
            utteranceCount: 2,
            utteranceIds: ["66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"],
          },
        ]}
      />,
    );
    const warnings = screen.getByTestId("batch-preview-warnings");
    expect(within(warnings).getByText(/copied from an earlier revision of the dialect transcript \(B\)/)).toBeInTheDocument();
    expect(within(warnings).getByText(/The batch can still be created\./)).toBeInTheDocument();
  });

  it("renders nothing without warnings", () => {
    const { container } = render(<PreviewWarnings warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
