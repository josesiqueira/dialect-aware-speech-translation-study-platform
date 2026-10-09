import OpenAI from "openai";
import { AppError } from "@dialect/domain";
import { OPENAI_PROVIDER, mapOpenAIError, safeMessage, startTimer } from "./shared";

export type OpenAIClientOptions = {
  // Time limit for one request in milliseconds. Default 120000 (two minutes).
  timeoutMs?: number;
  // Retries done inside the SDK. Default 0, see below.
  maxRetries?: number;
  // For an OpenAI-compatible endpoint or a proxy. Default: the SDK default.
  baseURL?: string;
  organization?: string;
  project?: string;
};

export const OPENAI_DEFAULT_TIMEOUT_MS = 120_000;
export const OPENAI_DEFAULT_MAX_RETRIES = 0;

// Creates the server-side OpenAI client (spec 26: the key never reaches the browser).
//
// maxRetries is 0 on purpose. The SDK default is 2 hidden retries. Here the job
// queue owns retries, so that every attempt is one visible `model_runs` record
// with its own request id and latency, and a job is never billed or delayed by
// attempts nobody can see.
//
// The timeout is two minutes instead of the SDK default of ten, so a stuck
// request frees its worker and the job is retried by the queue.
export function createOpenAIClient(apiKey: string, options: OpenAIClientOptions = {}): OpenAI {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new AppError(
      "CONFIGURATION_MISSING",
      "No OpenAI API key is configured. Set OPENAI_API_KEY on the server to use the openai provider.",
      { provider: OPENAI_PROVIDER },
    );
  }
  return new OpenAI({
    apiKey: apiKey.trim(),
    timeout: options.timeoutMs ?? OPENAI_DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? OPENAI_DEFAULT_MAX_RETRIES,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.organization ? { organization: options.organization } : {}),
    ...(options.project ? { project: options.project } : {}),
  });
}

export type ConnectivityResult = {
  ok: boolean;
  // Safe to show to an admin and to store.
  message: string;
  latencyMs: number;
};

// Explicit provider connectivity test for the admin Settings page (spec 113).
// Lists models (first page only): this checks the network path and the API key
// and generates no model output. Never throws.
export async function testOpenAIConnectivity(
  client: OpenAI,
  options: { signal?: AbortSignal } = {},
): Promise<ConnectivityResult> {
  const timer = startTimer();
  try {
    await client.models.list({ signal: options.signal });
    return {
      ok: true,
      message: "OpenAI API reachable and the API key was accepted.",
      latencyMs: timer.finish().latencyMs,
    };
  } catch (error) {
    // The stage only selects wording that is replaced below.
    const mapped = mapOpenAIError(error, "asr", client);
    const text = mapped.message.replace(/^OpenAI transcription request/, "OpenAI connectivity test");
    return { ok: false, message: safeMessage(text, client), latencyMs: timer.finish().latencyMs };
  }
}
