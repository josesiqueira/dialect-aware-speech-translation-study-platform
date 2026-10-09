import type { OpenAI } from "openai";
import { z } from "zod";
import { AiProviderError, validationError } from "../../errors";
import { parseAllowedParameters } from "../../parameters";
import {
  SYNTHESIS_MIME_TYPES,
  SYNTHESIS_OUTPUT_FORMATS,
  type SpeechSynthesizer,
  type SynthesisInput,
  type SynthesisResult,
} from "../../types";
import {
  OPENAI_PROVIDER,
  mapOpenAIError,
  pickHeaders,
  sha256Hex,
  startTimer,
  withResponseInfo,
} from "./shared";

// Endpoint: POST /audio/speech (client.audio.speech.create). The SDK returns
// the fetch `Response`; the audio bytes are read with `arrayBuffer()`.
//
// The SDK (7.x) body fields are: input, model, voice, instructions,
// response_format, speed, stream_format. `instructions` is supported by the
// SDK; the SDK notes that some older speech models ignore or reject it, so it
// is sent only when the synthesis input sets it.
//
// Allow-list of `parameters` keys: only `speed`. Voice, instructions and output
// format are typed input fields. `stream_format` is not supported here.
export const OPENAI_SPEECH_PARAMETERS = {
  speed: z.number().min(0.25).max(4),
} as const;

const RESERVED: Record<string, string> = {
  voice: "Pass the voice in the `voice` input field.",
  instructions: "Pass the speaking instruction in the `instructions` input field.",
  response_format: "Pass the audio format in the `outputFormat` input field.",
  input: "The text comes from the `text` input field.",
  model: "The model comes from the `model` input field.",
  stream_format: "Streaming is not supported by this adapter.",
};

export class OpenAISpeechSynthesizer implements SpeechSynthesizer {
  constructor(private readonly client: OpenAI) {}

  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const params = parseAllowedParameters("OpenAI speech", input.parameters, OPENAI_SPEECH_PARAMETERS, RESERVED);
    const format = input.outputFormat ?? "wav";
    if (!SYNTHESIS_OUTPUT_FORMATS.includes(format)) {
      throw validationError(
        `OpenAI speech: output format "${String(format)}" is not supported. Supported: ${SYNTHESIS_OUTPUT_FORMATS.join(", ")}.`,
      );
    }
    if (input.text.length === 0) {
      throw validationError("OpenAI speech: the text to speak is empty.");
    }
    if (input.voice.trim().length === 0) {
      throw validationError("OpenAI speech: no voice is configured.");
    }

    // Everything that is sent except the text to speak.
    const parametersSent: Record<string, unknown> = {
      model: input.model,
      voice: input.voice,
      response_format: format,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...params,
    };

    const timer = startTimer();
    try {
      const call = this.client.audio.speech.create(
        { ...parametersSent, input: input.text } as unknown as Parameters<OpenAI["audio"]["speech"]["create"]>[0],
        { signal: input.signal },
      );
      const { data, response, requestId } = await withResponseInfo<Response>(call);
      const httpResponse = response ?? data;
      const audio = Buffer.from(await data.arrayBuffer());
      const { finishedAt, latencyMs } = timer.finish();

      if (audio.length === 0) {
        throw new AiProviderError({
          stage: "tts",
          provider: OPENAI_PROVIDER,
          message: "OpenAI speech synthesis returned no audio bytes.",
          retryable: true,
          providerRequestId: requestId,
          providerErrorCode: "empty_audio",
        });
      }

      return {
        audio,
        mimeType: SYNTHESIS_MIME_TYPES[format],
        format,
        provider: OPENAI_PROVIDER,
        requestedModel: input.model,
        // The speech response is audio bytes only: it reports no model.
        returnedModel: undefined,
        providerRequestId: requestId,
        parametersSent,
        // The endpoint reports no usage. The character count is measured locally.
        usage: { inputCharacters: input.text.length },
        latencyMs,
        rawMetadata: {
          endpoint: "audio.speech",
          request: {
            inputSha256: sha256Hex(input.text),
            inputCharacters: input.text.length,
          },
          headers: pickHeaders(httpResponse),
          response: {
            audioBytes: audio.length,
            audioSha256: sha256Hex(audio),
          },
        },
        startedAt: timer.startedAt,
        finishedAt,
      };
    } catch (error) {
      throw mapOpenAIError(error, "tts", this.client);
    }
  }
}
