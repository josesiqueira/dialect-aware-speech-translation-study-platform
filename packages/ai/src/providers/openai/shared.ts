import { createHash } from "node:crypto";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  type OpenAI,
} from "openai";
import { isAppError, type AppError } from "@dialect/domain";
import { AiProviderError, redactSecrets } from "../../errors";
import type { AiStage } from "../../types";

export const OPENAI_PROVIDER = "openai";

const STAGE_LABELS: Record<AiStage, string> = {
  asr: "transcription",
  translation: "translation",
  tts: "speech synthesis",
};

const MAX_MESSAGE_LENGTH = 1000;

// Response headers worth keeping for reproducibility and support requests.
// Deliberately excludes the organization and project headers and all cookies.
const KEPT_HEADERS = ["x-request-id", "openai-processing-ms", "openai-version", "content-type", "date"];

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function startTimer(): { startedAt: Date; finish(): { finishedAt: Date; latencyMs: number } } {
  const startedAt = new Date();
  const t0 = performance.now();
  return {
    startedAt,
    finish() {
      return { finishedAt: new Date(), latencyMs: Math.round(performance.now() - t0) };
    },
  };
}

export function pickHeaders(response: Response | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!response || typeof response.headers?.get !== "function") return result;
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

export type OpenAICallResult<T> = {
  data: T;
  response?: Response;
  requestId?: string;
};

// Awaits an SDK call and returns the parsed data together with the HTTP response
// and the request id. The SDK returns an `APIPromise` whose `withResponse()`
// gives `{ data, response, request_id }` (request id from the `x-request-id`
// header). A plain promise (a simple test double) is also accepted: then the
// request id is read from `_request_id`, which the SDK adds to parsed objects.
export async function withResponseInfo<T>(call: unknown): Promise<OpenAICallResult<T>> {
  const maybe = call as { withResponse?: () => Promise<{ data: T; response: Response; request_id: string | null }> };
  if (maybe !== null && typeof maybe === "object" && typeof maybe.withResponse === "function") {
    const { data, response, request_id } = await maybe.withResponse();
    return { data, response, requestId: request_id ?? undefined };
  }
  const data = (await call) as T;
  let requestId: string | undefined;
  if (data !== null && typeof data === "object") {
    const fromBody = (data as { _request_id?: unknown })._request_id;
    if (typeof fromBody === "string") requestId = fromBody;
    const headers = (data as { headers?: { get?: (name: string) => string | null } }).headers;
    if (requestId === undefined && headers && typeof headers.get === "function") {
      requestId = headers.get("x-request-id") ?? undefined;
    }
  }
  return { data, requestId };
}

function apiKeyOf(client: OpenAI | undefined): string | undefined {
  const key = (client as { apiKey?: unknown } | undefined)?.apiKey;
  return typeof key === "string" ? key : undefined;
}

export function safeMessage(text: string, client?: OpenAI): string {
  const redacted = redactSecrets(text, [apiKeyOf(client)]);
  return redacted.length > MAX_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}...` : redacted;
}

// Retry classification of an HTTP status from the provider.
// Retryable: 408 (request timeout), 409 (conflict, transient on this API), 429
// (rate limit) and every 5xx. Not retryable: everything else, and also a 429
// whose code says the account quota is used up, because waiting does not help.
function isRetryableStatus(status: number, code: string | undefined): boolean {
  if (status === 429) return code !== "insufficient_quota";
  return status === 408 || status === 409 || status >= 500;
}

// Converts anything thrown during an OpenAI call into an error that is safe to
// store. AppError instances (validation, earlier mapping) pass through unchanged.
//
// `parametersSent`: the request parameters without the payload (text, audio).
// When given they are stored in `details.parametersSent`, so a failed model run
// records what was actually sent, like a successful one does.
export function mapOpenAIError(
  error: unknown,
  stage: AiStage,
  client?: OpenAI,
  parametersSent?: Record<string, unknown>,
): AppError {
  if (isAppError(error)) return error;

  const label = STAGE_LABELS[stage];
  const base = {
    stage,
    provider: OPENAI_PROVIDER,
    cause: error,
    ...(parametersSent ? { details: { parametersSent } } : {}),
  };

  if (error instanceof APIUserAbortError || (error instanceof Error && error.name === "AbortError")) {
    return new AiProviderError({
      ...base,
      message: `OpenAI ${label} request was aborted before it finished.`,
      retryable: true,
      providerErrorCode: "aborted",
    });
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new AiProviderError({
      ...base,
      message: `OpenAI ${label} request timed out.`,
      retryable: true,
      providerErrorCode: "timeout",
    });
  }
  if (error instanceof APIConnectionError) {
    return new AiProviderError({
      ...base,
      message: safeMessage(`OpenAI ${label} request failed: could not reach the provider. ${error.message}`, client),
      retryable: true,
      providerErrorCode: "connection_error",
    });
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const code = typeof error.code === "string" ? error.code : undefined;
    const type = typeof error.type === "string" ? error.type : undefined;
    return new AiProviderError({
      ...base,
      message: safeMessage(`OpenAI ${label} request failed: ${error.message}`, client),
      retryable: status !== undefined && isRetryableStatus(status, code),
      providerStatus: status,
      providerRequestId: error.requestID ?? undefined,
      providerErrorCode: code ?? type,
    });
  }
  const text = error instanceof Error ? error.message : String(error);
  return new AiProviderError({
    ...base,
    message: safeMessage(`OpenAI ${label} request failed with an unexpected error: ${text}`, client),
    retryable: false,
    providerErrorCode: "unexpected_error",
  });
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
