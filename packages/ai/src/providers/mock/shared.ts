import { createHash } from "node:crypto";
import { AiProviderError, validationError } from "../../errors";
import type { AiStage, ModelParameters } from "../../types";

export const MOCK_PROVIDER = "mock";

// Parameters understood by the mock adapters. Any other key is accepted and
// recorded in `parametersSent`, so a model configuration written for a real
// provider can be tried against the mock provider unchanged.
//
//   mockText       string   ASR and translation: return exactly this text.
//   mockFail       "retryable" | "permanent"   make the call fail.
//   mockFailTimes  integer  with mockFail: only the first N calls with the same
//                           input fail, later calls succeed. Without it every
//                           call fails.
export const MOCK_PARAMETER_KEYS = ["mockText", "mockFail", "mockFailTimes"] as const;

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function mockRequestId(stage: AiStage, inputKey: string): string {
  return `mock-${stage}-${inputKey.slice(0, 16)}`;
}

// Counts calls per input so that "fail N times, then succeed" can be tested.
// The count lives in memory in the adapter instance.
export class MockFailureInjector {
  private readonly calls = new Map<string, number>();

  // Throws when the parameters ask for a failure on this call.
  check(stage: AiStage, inputKey: string, parameters: ModelParameters | undefined): void {
    const mode = parameters?.mockFail;
    if (mode === undefined || mode === null) return;
    if (mode !== "retryable" && mode !== "permanent") {
      throw validationError('Mock provider: "mockFail" must be "retryable" or "permanent".');
    }
    const times = parameters?.mockFailTimes;
    if (times !== undefined && (typeof times !== "number" || !Number.isInteger(times) || times < 0)) {
      throw validationError('Mock provider: "mockFailTimes" must be a whole number of 0 or more.');
    }
    const key = `${stage}:${inputKey}`;
    const callNumber = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, callNumber);
    if (typeof times === "number" && callNumber > times) return;

    throw new AiProviderError({
      stage,
      provider: MOCK_PROVIDER,
      message: `Mock provider: injected ${mode} failure (call ${callNumber} for this input).`,
      retryable: mode === "retryable",
      providerStatus: mode === "retryable" ? 503 : 400,
      providerRequestId: mockRequestId(stage, inputKey),
      providerErrorCode: mode === "retryable" ? "mock_retryable_failure" : "mock_permanent_failure",
    });
  }

  reset(): void {
    this.calls.clear();
  }
}

export function mockTextParameter(parameters: ModelParameters | undefined): string | undefined {
  const value = parameters?.mockText;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw validationError('Mock provider: "mockText" must be a string.');
  }
  return value;
}
