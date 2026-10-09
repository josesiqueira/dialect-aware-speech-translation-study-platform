import { isAppError } from "@dialect/domain";
import { describe, expect, it } from "vitest";
import { AiProviderError, isAiProviderError, isRetryableAiError } from "./errors";

// A second, separately defined class with the same shape as AiProviderError:
// what code sees when one process holds two copies of this module.
class AiProviderErrorCopy extends Error {
  readonly code: string;
  readonly stage: string;
  readonly provider: string;
  readonly retryable: boolean;

  constructor(init: { code?: string; stage?: string; provider?: string; retryable: boolean; name?: string }) {
    super("The provider answered 429.");
    this.name = init.name ?? "AiProviderError";
    this.code = init.code ?? "ASR_PROVIDER_ERROR";
    this.stage = init.stage ?? "asr";
    this.provider = init.provider ?? "openai";
    this.retryable = init.retryable;
  }
}

describe("isAiProviderError and isRetryableAiError", () => {
  it("accept an AiProviderError of this module", () => {
    const error = new AiProviderError({ stage: "tts", provider: "openai", message: "timeout", retryable: true });
    expect(isAiProviderError(error)).toBe(true);
    expect(isRetryableAiError(error)).toBe(true);
    expect(isAppError(error)).toBe(true);
  });

  it("accept an error of the same shape made by a second, separately defined class", () => {
    const retryable = new AiProviderErrorCopy({ retryable: true });
    expect(retryable).not.toBeInstanceOf(AiProviderError);
    expect(isAiProviderError(retryable)).toBe(true);
    expect(isRetryableAiError(retryable)).toBe(true);
    expect(isAppError(retryable)).toBe(true);

    const permanent = new AiProviderErrorCopy({ retryable: false, code: "TRANSLATION_PROVIDER_ERROR", stage: "translation" });
    expect(isAiProviderError(permanent)).toBe(true);
    expect(isRetryableAiError(permanent)).toBe(false);
  });

  it("refuse errors that only look similar", () => {
    expect(isAiProviderError(new AiProviderErrorCopy({ retryable: true, name: "AppError" }))).toBe(false);
    expect(isAiProviderError(new AiProviderErrorCopy({ retryable: true, code: "NOT_FOUND" }))).toBe(false);
    expect(isAiProviderError(Object.assign(new AiProviderErrorCopy({ retryable: true }), { retryable: "yes" }))).toBe(false);
    expect(isAiProviderError({ name: "AiProviderError", code: "ASR_PROVIDER_ERROR", retryable: true, stage: "asr", provider: "x" })).toBe(false);
    expect(isRetryableAiError(Object.assign(new Error("plain"), { retryable: true }))).toBe(false);
    expect(isRetryableAiError(null)).toBe(false);
  });
});
