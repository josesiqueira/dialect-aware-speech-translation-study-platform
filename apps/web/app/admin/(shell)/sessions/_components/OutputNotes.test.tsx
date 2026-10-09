import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { corpusSchemas } from "@dialect/domain";
import { TranslationMatrix } from "./TranslationMatrix";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/api", () => ({ apiFetch, isApiClientError: () => false }));

const TRANSLATION_ID = "11111111-1111-4111-8111-111111111111";
const SYNTHESIS_ID = "22222222-2222-4222-8222-222222222222";

const run: corpusSchemas.ModelRunSummary = {
  id: "33333333-3333-4333-8333-333333333333",
  provider: "mock",
  requestedModel: "mock-translation",
  returnedModel: null,
  prompt: null,
  modelConfig: null,
  parameters: {},
  startedAt: "2026-10-01T10:00:00.000Z",
  finishedAt: "2026-10-01T10:00:01.000Z",
  latencyMs: 1000,
  appVersion: "0.1.0",
  gitCommitSha: null,
  providerRequestId: null,
  attemptNumber: 1,
} as unknown as corpusSchemas.ModelRunSummary;

// Mock data: one batch with one translation (default condition, from B) and one TTS output.
function view(status: corpusSchemas.TranslationCellView["status"] = "generated"): corpusSchemas.TranslationBatchView {
  const translation = {
    id: TRANSLATION_ID,
    conditionKey: "default",
    text: "I do not know.",
    targetLanguage: "en",
    status,
    repetitionIndex: 0,
    createdAt: "2026-10-01T10:00:01.000Z",
    sourceRevision: { id: "44444444-4444-4444-8444-444444444444", revisionNumber: 1, isCurrent: true, transcriptType: "human_dialect" },
    modelRun: run,
    syntheses: [
      {
        id: SYNTHESIS_ID,
        conditionKey: "baseline",
        voiceKey: "mock-voice",
        status: "generated",
        repetitionIndex: 0,
        createdAt: "2026-10-01T10:00:02.000Z",
        sourceText: "I do not know.",
        media: { id: "55555555-5555-4555-8555-555555555555", deletedAt: null, durationMs: 1000, sha256: "ab".repeat(32), captureSummary: "WAV", sizeBytes: 100 },
        modelRun: run,
      },
    ],
  } as unknown as corpusSchemas.TranslationCellView;
  return {
    batch: { id: "66666666-6666-4666-8666-666666666666", name: "batch-1", status: "completed", dataMode: "test", createdAt: "2026-10-01T09:00:00.000Z", startedAt: null, completedAt: null },
    conditions: ["default"],
    rows: [{ transcriptType: "human_dialect", label: "B", cells: [{ conditionKey: "default", translations: [translation] }] }],
  } as unknown as corpusSchemas.TranslationBatchView;
}

const note = (entityType: string, entityId: string, body: string): corpusSchemas.NoteView => ({
  id: `note-${body}`,
  entityType,
  entityId,
  body,
  createdByLabel: "admin",
  createdAt: "2026-10-01T11:00:00.000Z",
});

const flag = (entityId: string, resolvedAt: string | null): corpusSchemas.FlagView => ({
  id: `flag-${entityId}-${resolvedAt}`,
  entityType: "translation",
  entityId,
  reasonCode: "translation_problem",
  notes: "meaning changed",
  createdByLabel: "admin",
  createdAt: "2026-10-01T11:00:00.000Z",
  resolvedAt,
});

function renderMatrix(options: { status?: corpusSchemas.TranslationCellView["status"]; flags?: corpusSchemas.FlagView[]; notes?: corpusSchemas.NoteView[] } = {}) {
  const onChanged = vi.fn(async () => {});
  render(
    <TranslationMatrix
      view={view(options.status)}
      context={{
        participantCode: "P-TEST",
        utteranceOrdinal: 1,
        timeZone: "UTC",
        onChanged,
        flags: options.flags ?? [],
        notes: options.notes ?? [],
      }}
    />,
  );
  return { onChanged };
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({});
});

describe("flags and notes of a processing output (spec 45, 88)", () => {
  it("shows the notes and the open flags of each output inside the cell's disclosure, with a count in its heading", () => {
    renderMatrix({
      notes: [note("translation", TRANSLATION_ID, "Check the idiom."), note("synthesis", SYNTHESIS_ID, "Voice is clipped."), note("utterance", "other", "Not here.")],
      flags: [flag(TRANSLATION_ID, null), flag(TRANSLATION_ID, "2026-10-02T00:00:00.000Z")],
    });
    // Two notes and one open flag.
    expect(screen.getByText("Provenance, status, flags and notes").closest("summary")).toHaveTextContent("(3)");

    const translationPanel = screen.getByTestId(`output-notes-${TRANSLATION_ID}`);
    expect(within(translationPanel).getByText("Check the idiom.")).toBeInTheDocument();
    expect(within(translationPanel).getAllByText(/Flagged: translation problem/)).toHaveLength(1);
    expect(translationPanel).toHaveTextContent("meaning changed");
    expect(within(translationPanel).queryByText("Voice is clipped.")).not.toBeInTheDocument();

    const synthesisPanel = screen.getByTestId(`output-notes-${SYNTHESIS_ID}`);
    expect(within(synthesisPanel).getByText("Voice is clipped.")).toBeInTheDocument();
    expect(screen.queryByText("Not here.")).not.toBeInTheDocument();
  });

  it("adds a note through the output notes route and reloads", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderMatrix();
    const panel = screen.getByTestId(`output-notes-${TRANSLATION_ID}`);
    const add = within(panel).getByRole("button", { name: "Add note" });
    expect(add).toBeDisabled();
    await user.type(within(panel).getByLabelText("Add a note on this translation"), "  Idiom lost.  ");
    await user.click(add);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith(`/api/admin/sessions/outputs/translations/${TRANSLATION_ID}/notes`, {
      method: "POST",
      body: { body: "Idiom lost." },
    });
  });

  it("flags a generated output as reviewed with the reason and the note", async () => {
    const user = userEvent.setup();
    const { onChanged } = renderMatrix();
    const panel = screen.getByTestId(`output-notes-${SYNTHESIS_ID}`);
    await user.selectOptions(within(panel).getByLabelText("Flag this TTS output: reason"), "tts_problem");
    await user.type(within(panel).getByLabelText("Flag note (optional)"), "word skipped");
    await user.click(within(panel).getByRole("button", { name: "Flag" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith(`/api/admin/sessions/outputs/syntheses/${SYNTHESIS_ID}/status`, {
      method: "PATCH",
      body: { status: "reviewed", reasonCode: "tts_problem", notes: "word skipped" },
    });
  });

  it("keeps an excluded output excluded when it is flagged", async () => {
    const user = userEvent.setup();
    renderMatrix({ status: "excluded" });
    const panel = screen.getByTestId(`output-notes-${TRANSLATION_ID}`);
    await user.selectOptions(within(panel).getByLabelText("Flag this translation: reason"), "translation_problem");
    await user.click(within(panel).getByRole("button", { name: "Flag" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[1]).toEqual({ method: "PATCH", body: { status: "excluded", reasonCode: "translation_problem" } });
  });
});
