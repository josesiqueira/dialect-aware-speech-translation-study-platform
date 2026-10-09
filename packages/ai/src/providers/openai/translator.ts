import type { OpenAI } from "openai";
import { z } from "zod";
import { AiProviderError, validationError } from "../../errors";
import { parseAllowedParameters } from "../../parameters";
import type { AiUsage, TranslationInput, TranslationResult, Translator } from "../../types";
import {
  OPENAI_PROVIDER,
  asRecord,
  mapOpenAIError,
  pickHeaders,
  safeMessage,
  sha256Hex,
  startTimer,
  withResponseInfo,
} from "./shared";

// Endpoint: POST /responses (client.responses.create), non-streaming.
//
// Why the Responses API and not Chat Completions: the installed SDK (7.x)
// documents the Responses API as the primary text generation API, it has a
// top-level `instructions` field that carries the prompt version text without
// the adapter choosing a message role, and its response reports status,
// incomplete reason, refusals and the resolved model in one object.
//
// Request shape: `instructions` = the prompt version text, `input` = the source
// text alone as a plain string. No tools, no conversation state, no metadata.
//
// Allow-list of `parameters` keys. Left out on purpose: `metadata`, `user` and
// `safety_identifier` (they could carry participant data, spec 65), `tools`,
// `tool_choice`, `conversation`, `previous_response_id`, `prompt` (they change
// what the model sees beyond instruction plus source text), `stream` and
// `background` (not supported by this adapter), `text.format` (structured
// output could alter the translation, spec 146) and `reasoning.summary` (no
// model reasoning is stored, spec 27).
export const OPENAI_TRANSLATION_PARAMETERS = {
  temperature: z.number().min(0).max(2),
  top_p: z.number().min(0).max(1),
  max_output_tokens: z.number().int().positive(),
  reasoning: z.strictObject({
    effort: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
  }),
  text: z.strictObject({
    verbosity: z.enum(["low", "medium", "high"]),
  }),
  service_tier: z.string().min(1),
  // Whether the provider keeps the response for later retrieval. When the model
  // configuration does not set it, the adapter sends `store: false` (see
  // DEFAULT_STORE below).
  store: z.boolean(),
  truncation: z.enum(["auto", "disabled"]),
} as const;

// The one default this adapter adds to a request. The Responses API keeps a
// response for later retrieval unless `store` is false. Participant speech
// content must not be retained by the provider beyond the request without a
// decision by the researchers (spec 65), so the adapter sends `store: false`
// unless the model configuration sets `store` itself. The value is part of
// `parametersSent`, so the provenance of every run shows it.
export const DEFAULT_STORE = false;

// Message of a refused translation. The text of the refusal is model output
// about the participant's speech, so it is kept out of the error message (which
// is stored in model_runs.error_message and shown in lists) and travels only in
// `details.refusal`.
export const REFUSAL_MESSAGE = "OpenAI translation was refused by the model. The refusal text is kept in the run details.";

const RESERVED: Record<string, string> = {
  instructions: "The instruction comes from the `instruction` input field (the prompt version text).",
  input: "The source text comes from the `sourceText` input field.",
  model: "The model comes from the `model` input field.",
  stream: "Streaming is not supported by this adapter.",
  metadata: "Request metadata is not sent, so that no participant data can reach the provider.",
  user: "User identifiers are not sent to the provider.",
  safety_identifier: "User identifiers are not sent to the provider.",
};

const RETRYABLE_RESPONSE_ERROR_CODES = ["server_error", "rate_limit_exceeded", "vector_store_timeout"];

type OutputSummary = {
  text: string;
  refusal?: string;
  items: Array<Record<string, unknown>>;
};

// Reads the output items. The text is the concatenation of every `output_text`
// content part in order, which is also how the SDK computes `output_text`.
// The item list kept for metadata has ids, types, status and phase only: no
// message text and no reasoning content.
function readOutput(output: unknown): OutputSummary {
  const summary: OutputSummary = { text: "", items: [] };
  if (!Array.isArray(output)) return summary;
  for (const rawItem of output) {
    const item = asRecord(rawItem);
    const kept: Record<string, unknown> = {};
    for (const key of ["id", "type", "status", "role", "phase"]) {
      if (item[key] !== undefined) kept[key] = item[key];
    }
    summary.items.push(kept);
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const rawPart of item.content) {
      const part = asRecord(rawPart);
      if (part.type === "output_text" && typeof part.text === "string") {
        summary.text += part.text;
      } else if (part.type === "refusal" && typeof part.refusal === "string") {
        summary.refusal = (summary.refusal ?? "") + part.refusal;
      }
    }
  }
  return summary;
}

function normalizeUsage(raw: unknown): AiUsage | undefined {
  if (raw === null || raw === undefined) return undefined;
  const usage = asRecord(raw);
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    totalTokens: num(usage.total_tokens),
    raw,
  };
}

// Response fields copied into `rawMetadata`. Excludes `output` and
// `output_text` (the text is returned in its own field), `instructions` (the
// prompt, stored through the prompt version) and `usage` (its own field).
const KEPT_RESPONSE_FIELDS = [
  "id",
  "object",
  "created_at",
  "completed_at",
  "status",
  "model",
  "system_fingerprint",
  "service_tier",
  "temperature",
  "top_p",
  "max_output_tokens",
  "truncation",
  "store",
  "reasoning",
  "text",
  "incomplete_details",
  "error",
];

export class OpenAITranslator implements Translator {
  constructor(private readonly client: OpenAI) {}

  async translate(input: TranslationInput): Promise<TranslationResult> {
    const params = parseAllowedParameters(
      "OpenAI translation (Responses API)",
      input.parameters,
      OPENAI_TRANSLATION_PARAMETERS,
      RESERVED,
    );
    if (input.instruction.trim().length === 0) {
      throw validationError("OpenAI translation: the instruction is empty. An explicit prompt version is required.");
    }
    if (input.sourceText.trim().length === 0) {
      throw validationError("OpenAI translation: the source text is empty.");
    }

    // Everything that is sent except the two text payloads.
    const parametersSent: Record<string, unknown> = { model: input.model, store: DEFAULT_STORE, ...params };

    const timer = startTimer();
    try {
      const call = this.client.responses.create(
        {
          ...parametersSent,
          instructions: input.instruction,
          input: input.sourceText,
        } as unknown as Parameters<OpenAI["responses"]["create"]>[0],
        { signal: input.signal },
      );
      const { data, response, requestId } = await withResponseInfo<unknown>(call);
      const { finishedAt, latencyMs } = timer.finish();

      const body = asRecord(data);
      const output = readOutput(body.output);
      // Raw model output. Never trimmed or changed (spec 147).
      const rawText = Array.isArray(body.output)
        ? output.text
        : typeof body.output_text === "string"
          ? body.output_text
          : "";

      const responseMetadata: Record<string, unknown> = {};
      for (const key of KEPT_RESPONSE_FIELDS) {
        if (body[key] !== undefined) responseMetadata[key] = body[key];
      }
      const rawMetadata: Record<string, unknown> = {
        endpoint: "responses",
        request: {
          instructionSha256: sha256Hex(input.instruction),
          inputSha256: sha256Hex(input.sourceText),
        },
        headers: pickHeaders(response),
        response: responseMetadata,
        outputItems: output.items,
      };

      const responseId = typeof body.id === "string" ? body.id : undefined;
      const fail = (init: { message: string; retryable: boolean; code: string; details?: Record<string, unknown> }) =>
        new AiProviderError({
          stage: "translation",
          provider: OPENAI_PROVIDER,
          message: safeMessage(init.message, this.client),
          retryable: init.retryable,
          providerRequestId: requestId,
          providerErrorCode: init.code,
          details: { responseId, rawMetadata, parametersSent, ...init.details },
        });

      const responseError = asRecord(body.error);
      if (body.status === "failed" || typeof responseError.code === "string") {
        const code = typeof responseError.code === "string" ? responseError.code : "response_failed";
        const text = typeof responseError.message === "string" ? responseError.message : "no message";
        throw fail({
          message: `OpenAI translation response failed (${code}): ${text}`,
          retryable: RETRYABLE_RESPONSE_ERROR_CODES.includes(code),
          code,
        });
      }
      if (output.refusal !== undefined) {
        throw fail({
          message: REFUSAL_MESSAGE,
          retryable: false,
          code: "refusal",
          details: { refusal: output.refusal, partialText: rawText },
        });
      }
      if (body.status === "incomplete") {
        const reason = asRecord(body.incomplete_details).reason;
        const reasonText = typeof reason === "string" ? reason : "unknown";
        // A cut-off output is not stored as a translation. The partial text is
        // kept in the error details so the admin can inspect it.
        throw fail({
          message: `OpenAI translation response is incomplete (reason: ${reasonText}). The output was cut off and is not stored as a translation.`,
          retryable: false,
          code: `incomplete_${reasonText}`,
          details: { partialText: rawText },
        });
      }
      if (typeof body.status === "string" && body.status !== "completed") {
        throw fail({
          message: `OpenAI translation response has unexpected status "${body.status}".`,
          retryable: false,
          code: `status_${body.status}`,
        });
      }
      // Spec 146: the output must be non-empty. Checked without changing the text.
      if (rawText.trim().length === 0) {
        throw fail({
          message: "OpenAI translation returned an empty output.",
          retryable: false,
          code: "empty_output",
          details: { rawText },
        });
      }

      return {
        text: rawText,
        rawText,
        provider: OPENAI_PROVIDER,
        requestedModel: input.model,
        returnedModel: typeof body.model === "string" ? body.model : undefined,
        providerRequestId: requestId,
        parametersSent,
        usage: normalizeUsage(body.usage),
        latencyMs,
        rawMetadata,
        startedAt: timer.startedAt,
        finishedAt,
      };
    } catch (error) {
      throw mapOpenAIError(error, "translation", this.client, parametersSent);
    }
  }
}
