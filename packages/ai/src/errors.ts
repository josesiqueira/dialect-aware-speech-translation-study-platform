import { AppError, type ErrorCode } from "@dialect/domain";
import type { AiStage } from "./types";

export type AiProviderErrorCode =
  | "ASR_PROVIDER_ERROR"
  | "TRANSLATION_PROVIDER_ERROR"
  | "TTS_PROVIDER_ERROR";

const STAGE_ERROR_CODES: Record<AiStage, AiProviderErrorCode> = {
  asr: "ASR_PROVIDER_ERROR",
  translation: "TRANSLATION_PROVIDER_ERROR",
  tts: "TTS_PROVIDER_ERROR",
};

export function errorCodeForStage(stage: AiStage): AiProviderErrorCode {
  return STAGE_ERROR_CODES[stage];
}

export type AiProviderErrorInit = {
  stage: AiStage;
  provider: string;
  // Must be safe to store and to show to an admin: no key material.
  message: string;
  retryable: boolean;
  providerStatus?: number;
  providerRequestId?: string;
  providerErrorCode?: string;
  // Extra safe context, for example a partial output of an incomplete response.
  details?: Record<string, unknown>;
  cause?: unknown;
};

// A failed call to an AI provider. `retryable` tells the job queue whether trying
// again later can help (rate limit, timeout, 5xx, connection error) or not
// (authentication, invalid request, unknown model, refusal).
export class AiProviderError extends AppError {
  readonly stage: AiStage;
  readonly provider: string;
  readonly retryable: boolean;
  readonly providerStatus?: number;
  readonly providerRequestId?: string;
  readonly providerErrorCode?: string;

  constructor(init: AiProviderErrorInit) {
    super(
      errorCodeForStage(init.stage),
      init.message,
      {
        ...init.details,
        provider: init.provider,
        stage: init.stage,
        retryable: init.retryable,
        providerStatus: init.providerStatus,
        providerRequestId: init.providerRequestId,
        providerErrorCode: init.providerErrorCode,
      },
      { cause: init.cause },
    );
    this.name = "AiProviderError";
    this.stage = init.stage;
    this.provider = init.provider;
    this.retryable = init.retryable;
    this.providerStatus = init.providerStatus;
    this.providerRequestId = init.providerRequestId;
    this.providerErrorCode = init.providerErrorCode;
  }
}

const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(STAGE_ERROR_CODES));

// True for an AiProviderError of this module and for an error of the same shape
// made by another copy of the class (see isAppError in @dialect/domain: one
// process can hold several copies of a module). The structural check: an Error
// named "AiProviderError" with a provider error code, a stage, a provider and a
// boolean `retryable`.
export function isAiProviderError(value: unknown): value is AiProviderError {
  if (value instanceof AiProviderError) return true;
  if (!(value instanceof Error) || value.name !== "AiProviderError") return false;
  const candidate = value as { code?: unknown; retryable?: unknown; stage?: unknown; provider?: unknown };
  return (
    typeof candidate.code === "string" &&
    PROVIDER_ERROR_CODES.has(candidate.code) &&
    typeof candidate.retryable === "boolean" &&
    typeof candidate.stage === "string" &&
    typeof candidate.provider === "string"
  );
}

// True only for an AiProviderError marked retryable. Validation errors and a
// missing configuration are never retryable: someone has to change the
// configuration first.
export function isRetryableAiError(value: unknown): boolean {
  return isAiProviderError(value) && value.retryable;
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError("VALIDATION_ERROR" satisfies ErrorCode, message, details);
}

// Removes API key material from a message before it is stored or shown.
// `secrets` are exact strings to remove (for example the configured key). The
// pattern also removes key-like tokens, including the partly masked form that
// the provider echoes in authentication errors.
export function redactSecrets(text: string, secrets: Array<string | undefined | null> = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      result = result.split(secret).join("[redacted]");
    }
  }
  result = result.replace(/\bsk-[A-Za-z0-9_\-*.]{3,}/g, "[redacted]");
  result = result.replace(/\bBearer\s+[A-Za-z0-9_\-*.=+/]{8,}/gi, "Bearer [redacted]");
  return result;
}
