import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { corpusSchemas } from "@dialect/domain";
import { FailedRunDetail } from "./FailedRunDetail";

const RUN: corpusSchemas.ModelRunSummary = {
  id: "0b0b0b0b-0000-4000-8000-000000000001",
  stage: "translation",
  status: "failed",
  provider: "openai",
  requestedModel: "model-x",
  returnedModel: null,
  conditionKey: "default",
  modelConfig: null,
  prompt: null,
  processingBatchId: null,
  parameters: { model: "model-x", max_output_tokens: 16 },
  attemptNumber: 1,
  startedAt: "2026-10-03T12:00:00.000Z",
  finishedAt: "2026-10-03T12:00:01.000Z",
  latencyMs: 1000,
  providerRequestId: "req_123",
  errorCode: "TRANSLATION_PROVIDER_ERROR",
  errorMessage: "The response is incomplete.",
  failure: {
    providerStatus: null,
    providerErrorCode: "incomplete_max_output_tokens",
    retryable: false,
    responseId: "resp_456",
    responseStatus: "incomplete",
    refusal: null,
    outputText: "I do not really",
  },
  appVersion: "test",
  gitCommitSha: null,
};

describe("FailedRunDetail", () => {
  it("shows the error, the provider answer, the cut-off text and the parameters sent", () => {
    render(<FailedRunDetail run={RUN} />);
    const detail = screen.getByTestId("failed-run-detail");
    expect(within(detail).getByText("TRANSLATION_PROVIDER_ERROR: The response is incomplete.")).toBeInTheDocument();
    const facts = Object.fromEntries(
      within(detail)
        .getAllByRole("term")
        .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
    );
    expect(facts).toMatchObject({
      "Provider error code": "incomplete_max_output_tokens",
      "Response status": "incomplete",
      "Request id": "req_123",
      "Response id": "resp_456",
      "Retried automatically": "no",
      "Output text (not stored as a translation)": "I do not really",
    });
    expect(facts["Parameters sent"]).toContain('"max_output_tokens": 16');
  });

  it("names an empty output and a refusal", () => {
    render(
      <FailedRunDetail
        run={{ ...RUN, failure: { ...RUN.failure!, outputText: "", refusal: "I cannot help with that." } }}
      />,
    );
    expect(screen.getByText("(empty)")).toBeInTheDocument();
    expect(screen.getByText("I cannot help with that.")).toBeInTheDocument();
  });

  it("renders nothing for a run that did not fail, and only the error for a run without stored detail", () => {
    const { container, rerender } = render(<FailedRunDetail run={{ ...RUN, status: "succeeded" }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FailedRunDetail run={{ ...RUN, failure: null, parameters: {}, providerRequestId: null }} />);
    expect(screen.getByTestId("failed-run-detail").querySelector("details")).toBeNull();
  });
});
