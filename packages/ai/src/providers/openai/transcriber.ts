import { toFile, type OpenAI } from "openai";
import { z } from "zod";
import { validationError } from "../../errors";
import { parseAllowedParameters } from "../../parameters";
import type {
  AiUsage,
  Transcriber,
  TranscriptionInput,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionWord,
} from "../../types";
import {
  OPENAI_PROVIDER,
  asRecord,
  mapOpenAIError,
  pickHeaders,
  sha256Hex,
  startTimer,
  withResponseInfo,
} from "./shared";

// Endpoint: POST /audio/transcriptions (client.audio.transcriptions.create),
// non-streaming.
//
// Allow-list of `parameters` keys. The SDK (7.x) accepts more body fields; the
// ones left out are either typed input fields (file, model, language, prompt),
// change the response into something this adapter does not read (stream, and
// the text, srt and vtt formats), or send extra speaker audio
// (known_speaker_names, known_speaker_references).
export const OPENAI_TRANSCRIPTION_PARAMETERS = {
  // "json" is supported by every transcription model and is the default.
  // "verbose_json" adds segments, language and duration, and word timestamps
  // when requested, but only some models support it. "diarized_json" adds
  // speaker segments on diarization models. Set it in the model configuration
  // to the richest format the configured model supports.
  response_format: z.enum(["json", "verbose_json", "diarized_json"]),
  temperature: z.number().min(0).max(1),
  timestamp_granularities: z.array(z.enum(["word", "segment"])).min(1),
  include: z.array(z.enum(["logprobs"])).min(1),
  chunking_strategy: z.union([
    z.literal("auto"),
    z.strictObject({
      type: z.literal("server_vad"),
      prefix_padding_ms: z.number().optional(),
      silence_duration_ms: z.number().optional(),
      threshold: z.number().optional(),
    }),
  ]),
  keywords: z.array(z.string().min(1)).min(1),
  languages: z.array(z.string().min(1)).min(1),
} as const;

export const OPENAI_TRANSCRIPTION_DEFAULT_RESPONSE_FORMAT = "json";

const RESERVED: Record<string, string> = {
  language: "Pass the language hint in the `language` input field.",
  prompt: "Pass the context text in the `prompt` input field.",
  model: "The model comes from the `model` input field.",
  file: "The audio comes from the `audio` input field.",
  stream: "Streaming is not supported by this adapter.",
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(raw: unknown): AiUsage | undefined {
  if (raw === null || raw === undefined) return undefined;
  const usage = asRecord(raw);
  return {
    inputTokens: numberOrUndefined(usage.input_tokens),
    outputTokens: numberOrUndefined(usage.output_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    audioSeconds: numberOrUndefined(usage.seconds),
    raw,
  };
}

// A field the provider did not return is left out. Nothing is filled in: a
// start time of 0 or an empty text that the provider never sent would be a
// fabricated value in the stored record (spec 103).
function normalizeSegments(raw: unknown): TranscriptionSegment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const { id, start, end, text, speaker, ...rest } = asRecord(item);
    const segment: TranscriptionSegment = {};
    const startSeconds = numberOrUndefined(start);
    const endSeconds = numberOrUndefined(end);
    if (startSeconds !== undefined) segment.start = startSeconds;
    if (endSeconds !== undefined) segment.end = endSeconds;
    if (typeof text === "string") segment.text = text;
    if (typeof id === "string" || typeof id === "number") segment.id = id;
    if (typeof speaker === "string") segment.speaker = speaker;
    if (Object.keys(rest).length > 0) segment.providerFields = rest;
    return segment;
  });
}

function normalizeWords(raw: unknown): TranscriptionWord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const source = asRecord(item);
    const word: TranscriptionWord = {};
    const startSeconds = numberOrUndefined(source.start);
    const endSeconds = numberOrUndefined(source.end);
    if (typeof source.word === "string") word.word = source.word;
    if (startSeconds !== undefined) word.start = startSeconds;
    if (endSeconds !== undefined) word.end = endSeconds;
    return word;
  });
}

export class OpenAITranscriber implements Transcriber {
  constructor(private readonly client: OpenAI) {}

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const params = parseAllowedParameters(
      "OpenAI transcription",
      input.parameters,
      OPENAI_TRANSCRIPTION_PARAMETERS,
      RESERVED,
    );
    const responseFormat = params.response_format ?? OPENAI_TRANSCRIPTION_DEFAULT_RESPONSE_FORMAT;
    if (params.timestamp_granularities && responseFormat !== "verbose_json") {
      throw validationError(
        'OpenAI transcription: "timestamp_granularities" requires "response_format": "verbose_json".',
      );
    }
    if (params.include && responseFormat !== "json") {
      throw validationError('OpenAI transcription: "include" requires "response_format": "json".');
    }
    if (input.audio.length === 0) {
      throw validationError("OpenAI transcription: the audio is empty.");
    }

    // Everything that is sent except the audio bytes.
    const parametersSent: Record<string, unknown> = {
      model: input.model,
      ...(input.language ? { language: input.language } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...params,
      response_format: responseFormat,
    };

    const timer = startTimer();
    try {
      const file = await toFile(input.audio, input.fileName, { type: input.mimeType });
      const call = this.client.audio.transcriptions.create(
        { ...parametersSent, file } as unknown as Parameters<OpenAI["audio"]["transcriptions"]["create"]>[0],
        { signal: input.signal },
      );
      const { data, response, requestId } = await withResponseInfo<unknown>(call);
      const { finishedAt, latencyMs } = timer.finish();

      const body = asRecord(data);
      if (typeof body.text !== "string") {
        throw mapOpenAIError(
          new Error("The response has no transcript text field."),
          "asr",
          this.client,
          parametersSent,
        );
      }

      // Response body without the transcript text and without the lists that are
      // returned in their own result fields.
      const { text, segments, words, usage, _request_id, ...otherFields } = body;
      void _request_id;

      return {
        text,
        segments: normalizeSegments(segments),
        words: normalizeWords(words),
        detectedLanguage: typeof body.language === "string" ? body.language : undefined,
        durationSeconds: numberOrUndefined(body.duration),
        provider: OPENAI_PROVIDER,
        requestedModel: input.model,
        // The transcription response carries no model field.
        returnedModel: typeof body.model === "string" ? body.model : undefined,
        providerRequestId: requestId,
        parametersSent,
        usage: normalizeUsage(usage),
        latencyMs,
        rawMetadata: {
          endpoint: "audio.transcriptions",
          request: {
            fileName: input.fileName,
            mimeType: input.mimeType,
            audioBytes: input.audio.length,
            audioSha256: sha256Hex(input.audio),
          },
          headers: pickHeaders(response),
          response: otherFields,
        },
        startedAt: timer.startedAt,
        finishedAt,
      };
    } catch (error) {
      throw mapOpenAIError(error, "asr", this.client, parametersSent);
    }
  }
}
