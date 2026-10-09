import { describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  type OpenAI,
} from "openai";
import { AppError } from "@dialect/domain";
import { AiProviderError } from "../../errors";
import type { AiStage } from "../../types";
import { createOpenAIClient, testOpenAIConnectivity } from "./client";
import { OpenAISpeechSynthesizer } from "./synthesizer";
import { OpenAITranscriber } from "./transcriber";
import { OpenAITranslator } from "./translator";

// Model names in tests are invented on purpose: no real identifier is needed.
const ASR_MODEL = "test-asr-model";
const TEXT_MODEL = "test-text-model";
const TTS_MODEL = "test-speech-model";
const FAKE_KEY = "sk-test-0123456789abcdefghijklmnop";

// Imitates the SDK's APIPromise: awaitable, with withResponse().
function apiPromise<T>(data: T, headers: Record<string, string> = {}) {
  const response = new Response(null, { headers });
  const promise = Promise.resolve(data) as Promise<T> & { withResponse: () => Promise<unknown> };
  promise.withResponse = async () => ({
    data,
    response,
    request_id: response.headers.get("x-request-id"),
  });
  return promise;
}

function rejectedApiPromise(error: unknown) {
  const promise = Promise.reject(error) as Promise<never> & { withResponse: () => Promise<never> };
  promise.catch(() => undefined);
  promise.withResponse = () => Promise.reject(error);
  return promise;
}

type Mocks = {
  transcribe: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  speak: ReturnType<typeof vi.fn>;
  listModels: ReturnType<typeof vi.fn>;
};

function mockClient(): { client: OpenAI; mocks: Mocks } {
  const mocks: Mocks = { transcribe: vi.fn(), respond: vi.fn(), speak: vi.fn(), listModels: vi.fn() };
  const client = {
    apiKey: FAKE_KEY,
    audio: { transcriptions: { create: mocks.transcribe }, speech: { create: mocks.speak } },
    responses: { create: mocks.respond },
    models: { list: mocks.listModels },
  } as unknown as OpenAI;
  return { client, mocks };
}

function completedResponse(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "resp_123",
    object: "response",
    created_at: 1790000000,
    status: "completed",
    model: "test-text-model-2026-09-01",
    output: [
      { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "hidden" },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    usage: {
      input_tokens: 40,
      output_tokens: 12,
      total_tokens: 52,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
    error: null,
    incomplete_details: null,
    ...extra,
  };
}

const translationInput = {
  model: TEXT_MODEL,
  instruction: "Translate the following Finnish utterance into natural spoken English.",
  sourceText: "No emmää oikeen tiiä.",
  sourceLanguage: "fi",
  targetLanguage: "en",
};

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw.");
}

describe("OpenAITranscriber", () => {
  const audio = Buffer.from("RIFF fake audio bytes");

  it("sends the file, model, language and prompt, and defaults to the json format", async () => {
    const { client, mocks } = mockClient();
    mocks.transcribe.mockReturnValue(
      apiPromise(
        { text: " Moi, mitä kuuluu? ", usage: { type: "tokens", input_tokens: 30, output_tokens: 8, total_tokens: 38 } },
        { "x-request-id": "req_asr_1", "openai-processing-ms": "412" },
      ),
    );
    const controller = new AbortController();
    const result = await new OpenAITranscriber(client).transcribe({
      audio,
      fileName: "utterance.wav",
      mimeType: "audio/wav",
      model: ASR_MODEL,
      language: "fi",
      prompt: "Puhuttua suomea.",
      signal: controller.signal,
    });

    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    const [body, options] = mocks.transcribe.mock.calls[0] as [Record<string, unknown>, { signal: AbortSignal }];
    expect(Object.keys(body).sort()).toEqual(["file", "language", "model", "prompt", "response_format"]);
    expect(body.model).toBe(ASR_MODEL);
    expect(body.language).toBe("fi");
    expect(body.prompt).toBe("Puhuttua suomea.");
    expect(body.response_format).toBe("json");
    const file = body.file as File;
    expect(file.name).toBe("utterance.wav");
    expect(file.type).toBe("audio/wav");
    expect(Buffer.from(await file.arrayBuffer()).equals(audio)).toBe(true);
    expect(options.signal).toBe(controller.signal);

    // Raw transcript, including the surrounding spaces.
    expect(result.text).toBe(" Moi, mitä kuuluu? ");
    expect(result.segments).toBeUndefined();
    expect(result.provider).toBe("openai");
    expect(result.requestedModel).toBe(ASR_MODEL);
    expect(result.returnedModel).toBeUndefined();
    expect(result.providerRequestId).toBe("req_asr_1");
    expect(result.parametersSent).toEqual({
      model: ASR_MODEL,
      language: "fi",
      prompt: "Puhuttua suomea.",
      response_format: "json",
    });
    expect(result.parametersSent).not.toHaveProperty("file");
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 8, totalTokens: 38 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.finishedAt.getTime()).toBeGreaterThanOrEqual(result.startedAt.getTime());
    const metadata = result.rawMetadata as { headers: Record<string, string>; request: Record<string, unknown> };
    expect(metadata.headers["openai-processing-ms"]).toBe("412");
    expect(metadata.request.audioBytes).toBe(audio.length);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it("keeps segments, words, language and duration from a verbose response", async () => {
    const { client, mocks } = mockClient();
    mocks.transcribe.mockReturnValue(
      apiPromise({
        task: "transcribe",
        language: "finnish",
        duration: 3.2,
        text: "Moi. Mitä kuuluu?",
        segments: [
          { id: 0, seek: 0, start: 0, end: 1.1, text: "Moi.", avg_logprob: -0.2, tokens: [1, 2] },
          { id: 1, seek: 0, start: 1.1, end: 3.2, text: " Mitä kuuluu?", avg_logprob: -0.3, tokens: [3] },
        ],
        words: [{ word: "Moi", start: 0, end: 0.6 }],
        usage: { type: "duration", seconds: 4 },
      }),
    );
    const result = await new OpenAITranscriber(client).transcribe({
      audio,
      fileName: "a.wav",
      mimeType: "audio/wav",
      model: ASR_MODEL,
      parameters: { response_format: "verbose_json", timestamp_granularities: ["word", "segment"], temperature: 0 },
    });
    const [body] = mocks.transcribe.mock.calls[0] as [Record<string, unknown>];
    expect(body.response_format).toBe("verbose_json");
    expect(body.timestamp_granularities).toEqual(["word", "segment"]);
    expect(body.temperature).toBe(0);
    expect(result.segments).toHaveLength(2);
    expect(result.segments?.[1]).toMatchObject({ id: 1, start: 1.1, end: 3.2, text: " Mitä kuuluu?" });
    expect(result.segments?.[0]?.providerFields).toMatchObject({ avg_logprob: -0.2 });
    expect(result.words).toEqual([{ word: "Moi", start: 0, end: 0.6 }]);
    expect(result.detectedLanguage).toBe("finnish");
    expect(result.durationSeconds).toBe(3.2);
    expect(result.usage?.audioSeconds).toBe(4);
  });

  it("leaves out segment and word fields that the provider did not return", async () => {
    const { client, mocks } = mockClient();
    mocks.transcribe.mockReturnValue(
      apiPromise({
        text: "Moi.",
        segments: [{ id: 0, text: "Moi." }, { start: 1.5, speaker: "A" }],
        words: [{ word: "Moi" }, { start: 0.2, end: 0.6 }],
      }),
    );
    const result = await new OpenAITranscriber(client).transcribe({
      audio,
      fileName: "a.wav",
      mimeType: "audio/wav",
      model: ASR_MODEL,
    });
    // No start or end of 0 and no empty text is made up.
    expect(result.segments).toEqual([{ id: 0, text: "Moi." }, { start: 1.5, speaker: "A" }]);
    expect(result.words).toEqual([{ word: "Moi" }, { start: 0.2, end: 0.6 }]);
  });

  it("records the parameters that were sent when the request fails", async () => {
    const { client, mocks } = mockClient();
    mocks.transcribe.mockRejectedValue(
      APIError.generate(500, { error: { message: "server error", code: "server_error" } }, undefined, new Headers()),
    );
    const error = (await caught(() =>
      new OpenAITranscriber(client).transcribe({
        audio,
        fileName: "a.wav",
        mimeType: "audio/wav",
        model: ASR_MODEL,
        language: "fi",
      }),
    )) as AiProviderError;
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error.details as { parametersSent?: unknown }).parametersSent).toMatchObject({ model: ASR_MODEL, language: "fi" });
  });

  it("does not add parameters that the configuration does not set", async () => {
    const { client, mocks } = mockClient();
    mocks.transcribe.mockReturnValue(apiPromise({ text: "x" }));
    await new OpenAITranscriber(client).transcribe({ audio, fileName: "a.wav", mimeType: "audio/wav", model: ASR_MODEL });
    const [body] = mocks.transcribe.mock.calls[0] as [Record<string, unknown>];
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("language");
    expect(body).not.toHaveProperty("prompt");
  });

  it("returns an empty transcript as is", async () => {
    const { client, mocks } = mockClient();
    mocks.transcribe.mockReturnValue(apiPromise({ text: "" }));
    const result = await new OpenAITranscriber(client).transcribe({
      audio,
      fileName: "a.wav",
      mimeType: "audio/wav",
      model: ASR_MODEL,
    });
    expect(result.text).toBe("");
  });

  it("rejects parameters outside the allow-list without calling the provider", async () => {
    const { client, mocks } = mockClient();
    const transcriber = new OpenAITranscriber(client);
    const base = { audio, fileName: "a.wav", mimeType: "audio/wav", model: ASR_MODEL };
    for (const parameters of [
      { beam_size: 5 },
      { language: "fi" },
      { stream: true },
      { response_format: "srt" },
      { temperature: "0" },
      { timestamp_granularities: ["segment"] },
    ]) {
      const error = await caught(() => transcriber.transcribe({ ...base, parameters }));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});

describe("OpenAITranslator", () => {
  it("sends the prompt text as instructions and the source text alone as input", async () => {
    const { client, mocks } = mockClient();
    mocks.respond.mockReturnValue(apiPromise(completedResponse("Well, I don't really know."), { "x-request-id": "req_tr_1" }));
    const result = await new OpenAITranslator(client).translate({
      ...translationInput,
      parameters: { temperature: 0.2, max_output_tokens: 500, reasoning: { effort: "low" }, store: false },
    });

    const [body] = mocks.respond.mock.calls[0] as [Record<string, unknown>];
    expect(body).toEqual({
      model: TEXT_MODEL,
      instructions: translationInput.instruction,
      input: translationInput.sourceText,
      temperature: 0.2,
      max_output_tokens: 500,
      reasoning: { effort: "low" },
      store: false,
    });

    expect(result.text).toBe("Well, I don't really know.");
    expect(result.rawText).toBe(result.text);
    expect(result.provider).toBe("openai");
    expect(result.requestedModel).toBe(TEXT_MODEL);
    expect(result.returnedModel).toBe("test-text-model-2026-09-01");
    expect(result.providerRequestId).toBe("req_tr_1");
    expect(result.parametersSent).toEqual({
      model: TEXT_MODEL,
      temperature: 0.2,
      max_output_tokens: 500,
      reasoning: { effort: "low" },
      store: false,
    });
    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 12, totalTokens: 52 });
    const metadata = result.rawMetadata as { response: Record<string, unknown>; outputItems: unknown[] };
    expect(metadata.response.id).toBe("resp_123");
    expect(metadata.response.model).toBe("test-text-model-2026-09-01");
    // No hidden reasoning content and no payload text in the stored metadata.
    const stored = JSON.stringify({ meta: result.rawMetadata, sent: result.parametersSent });
    expect(stored).not.toContain("hidden");
    expect(stored).not.toContain(translationInput.sourceText);
    expect(stored).not.toContain(FAKE_KEY);
  });

  it("sends no sampling parameters when the configuration has none, and store: false", async () => {
    const { client, mocks } = mockClient();
    mocks.respond.mockReturnValue(apiPromise(completedResponse("Hi.")));
    const result = await new OpenAITranslator(client).translate(translationInput);
    const [body] = mocks.respond.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(body).sort()).toEqual(["input", "instructions", "model", "store"]);
    // Provider-side retention is off unless the model configuration turns it on (spec 65).
    expect(body.store).toBe(false);
    // The provenance of the run shows the value that was sent.
    expect(result.parametersSent).toEqual({ model: TEXT_MODEL, store: false });
  });

  it("sends store: true only when the model configuration sets it", async () => {
    const { client, mocks } = mockClient();
    mocks.respond.mockReturnValue(apiPromise(completedResponse("Hi.")));
    const result = await new OpenAITranslator(client).translate({ ...translationInput, parameters: { store: true } });
    const [body] = mocks.respond.mock.calls[0] as [Record<string, unknown>];
    expect(body.store).toBe(true);
    expect(result.parametersSent.store).toBe(true);
  });

  it("preserves the raw text byte for byte", async () => {
    const raw = "  \n“Well…  I dunno ,”\tshe said \u2014 maybe?!  ¯\\_(ツ)_/¯ \r\n\n ";
    const { client, mocks } = mockClient();
    mocks.respond.mockReturnValue(apiPromise(completedResponse(raw)));
    const result = await new OpenAITranslator(client).translate(translationInput);
    expect(result.text).toBe(raw);
    expect(result.rawText).toBe(raw);
    expect(Buffer.from(result.text, "utf8").equals(Buffer.from(raw, "utf8"))).toBe(true);
  });

  it("accepts a plain promise and reads the request id from the body", async () => {
    const { client, mocks } = mockClient();
    mocks.respond.mockResolvedValue({ ...completedResponse("Hello."), output: undefined, _request_id: "req_plain" });
    const result = await new OpenAITranslator(client).translate(translationInput);
    expect(result.text).toBe("Hello.");
    expect(result.providerRequestId).toBe("req_plain");
  });

  it("rejects an empty or whitespace-only output", async () => {
    for (const text of ["", "  \n "]) {
      const { client, mocks } = mockClient();
      mocks.respond.mockReturnValue(apiPromise(completedResponse(text), { "x-request-id": "req_empty" }));
      const error = await caught(() => new OpenAITranslator(client).translate(translationInput));
      expect(error).toBeInstanceOf(AiProviderError);
      const providerError = error as AiProviderError;
      expect(providerError.code).toBe("TRANSLATION_PROVIDER_ERROR");
      expect(providerError.providerErrorCode).toBe("empty_output");
      expect(providerError.retryable).toBe(false);
      expect(providerError.providerRequestId).toBe("req_empty");
    }
  });

  it("treats a refusal as a permanent error", async () => {
    const { client, mocks } = mockClient();
    const response = completedResponse("");
    response.output = [
      { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I cannot help with that." }] },
    ] as never;
    mocks.respond.mockReturnValue(apiPromise(response));
    const error = (await caught(() => new OpenAITranslator(client).translate(translationInput))) as AiProviderError;
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.providerErrorCode).toBe("refusal");
    expect(error.retryable).toBe(false);
    // The refusal text is model output about the speech: it is not part of the
    // message (stored in model_runs.error_message), only of the details.
    expect(error.message).not.toContain("I cannot help with that.");
    expect(error.message).toContain("refused");
    expect((error.details as { refusal?: string }).refusal).toBe("I cannot help with that.");
    // A failed run records the parameters that were sent, like a successful one.
    expect((error.details as { parametersSent?: unknown }).parametersSent).toEqual({ model: TEXT_MODEL, store: false });
  });

  it("records the parameters that were sent when the request itself fails", async () => {
    const { client, mocks } = mockClient();
    mocks.respond.mockRejectedValue(
      APIError.generate(429, { error: { message: "slow down", code: "rate_limit_exceeded" } }, undefined, new Headers()),
    );
    const error = (await caught(() =>
      new OpenAITranslator(client).translate({ ...translationInput, parameters: { temperature: 0.3 } }),
    )) as AiProviderError;
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error.details as { parametersSent?: unknown }).parametersSent).toEqual({
      model: TEXT_MODEL,
      store: false,
      temperature: 0.3,
    });
  });

  it("does not return a cut-off output as a translation", async () => {
    const { client, mocks } = mockClient();
    mocks.respond.mockReturnValue(
      apiPromise(completedResponse("Well, I", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })),
    );
    const error = (await caught(() => new OpenAITranslator(client).translate(translationInput))) as AiProviderError;
    expect(error.providerErrorCode).toBe("incomplete_max_output_tokens");
    expect(error.retryable).toBe(false);
    expect((error.details as { partialText: string }).partialText).toBe("Well, I");
  });

  it("maps a failed response by its error code", async () => {
    const { client, mocks } = mockClient();
    mocks.respond.mockReturnValue(
      apiPromise(completedResponse("", { status: "failed", error: { code: "server_error", message: "boom" } })),
    );
    const error = (await caught(() => new OpenAITranslator(client).translate(translationInput))) as AiProviderError;
    expect(error.providerErrorCode).toBe("server_error");
    expect(error.retryable).toBe(true);
  });

  it("rejects parameters outside the allow-list without calling the provider", async () => {
    const { client, mocks } = mockClient();
    const translator = new OpenAITranslator(client);
    for (const parameters of [
      { metadata: { participant: "P-001" } },
      { user: "P-001" },
      { tools: [] },
      { frequency_penalty: 1 },
      { temperature: 3 },
      { reasoning: { effort: "low", summary: "auto" } },
      { text: { format: { type: "json_object" } } },
    ]) {
      const error = await caught(() => translator.translate({ ...translationInput, parameters }));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    }
    const message = ((await caught(() =>
      translator.translate({ ...translationInput, parameters: { top_k: 5 } }),
    )) as AppError).message;
    expect(message).toContain('"top_k"');
    expect(message).toContain("temperature");
    expect(mocks.respond).not.toHaveBeenCalled();
  });

  it("has no input field for participant metadata", () => {
    // Compile-time check: an extra field is a type error.
    const input: Parameters<OpenAITranslator["translate"]>[0] = {
      ...translationInput,
      // @ts-expect-error participant metadata cannot be passed to a translator
      participantCode: "P-001",
    };
    expect(input.model).toBe(TEXT_MODEL);
  });
});

describe("OpenAISpeechSynthesizer", () => {
  const wavBytes = Buffer.from("RIFF....WAVEfmt fake");

  function speechResponse(bytes: Buffer, headers: Record<string, string> = {}) {
    const response = new Response(new Uint8Array(bytes), { headers });
    const promise = Promise.resolve(response) as Promise<Response> & { withResponse: () => Promise<unknown> };
    promise.withResponse = async () => ({ data: response, response, request_id: response.headers.get("x-request-id") });
    return promise;
  }

  it("requests wav by default and returns the bytes", async () => {
    const { client, mocks } = mockClient();
    mocks.speak.mockReturnValue(speechResponse(wavBytes, { "x-request-id": "req_tts_1", "content-type": "audio/wav" }));
    const result = await new OpenAISpeechSynthesizer(client).synthesize({
      model: TTS_MODEL,
      text: " Well, I don't really know. ",
      voice: "voice-a",
      instructions: "Speak the text naturally in conversational English.",
      parameters: { speed: 1 },
    });
    const [body] = mocks.speak.mock.calls[0] as [Record<string, unknown>];
    expect(body).toEqual({
      model: TTS_MODEL,
      input: " Well, I don't really know. ",
      voice: "voice-a",
      response_format: "wav",
      instructions: "Speak the text naturally in conversational English.",
      speed: 1,
    });
    expect(result.audio.equals(wavBytes)).toBe(true);
    expect(result.format).toBe("wav");
    expect(result.mimeType).toBe("audio/wav");
    expect(result.provider).toBe("openai");
    expect(result.requestedModel).toBe(TTS_MODEL);
    expect(result.providerRequestId).toBe("req_tts_1");
    expect(result.parametersSent).toEqual({
      model: TTS_MODEL,
      voice: "voice-a",
      response_format: "wav",
      instructions: "Speak the text naturally in conversational English.",
      speed: 1,
    });
    expect(result.parametersSent).not.toHaveProperty("input");
    expect(result.usage).toEqual({ inputCharacters: 28 });
  });

  it("omits instructions and speed when they are not set, and honors another format", async () => {
    const { client, mocks } = mockClient();
    mocks.speak.mockReturnValue(speechResponse(Buffer.from("ID3")));
    const result = await new OpenAISpeechSynthesizer(client).synthesize({
      model: TTS_MODEL,
      text: "Hello.",
      voice: "voice-a",
      outputFormat: "mp3",
    });
    const [body] = mocks.speak.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(body).sort()).toEqual(["input", "model", "response_format", "voice"]);
    expect(result.mimeType).toBe("audio/mpeg");
  });

  it("rejects parameters outside the allow-list and an empty audio body", async () => {
    const { client, mocks } = mockClient();
    const synthesizer = new OpenAISpeechSynthesizer(client);
    const base = { model: TTS_MODEL, text: "Hello.", voice: "voice-a" };
    for (const parameters of [{ voice: "other" }, { pitch: 2 }, { speed: 9 }, { stream_format: "sse" }]) {
      const error = await caught(() => synthesizer.synthesize({ ...base, parameters }));
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    }
    expect(mocks.speak).not.toHaveBeenCalled();

    mocks.speak.mockReturnValue(speechResponse(Buffer.alloc(0)));
    const error = (await caught(() => synthesizer.synthesize(base))) as AiProviderError;
    expect(error.code).toBe("TTS_PROVIDER_ERROR");
    expect(error.providerErrorCode).toBe("empty_audio");
  });
});

describe("error mapping", () => {
  const headers = new Headers({ "x-request-id": "req_err_1" });
  const apiError = (status: number, code: string, message: string) =>
    APIError.generate(status, { error: { message, code, type: "some_type" } }, undefined, headers);

  const cases: Array<{ name: string; error: unknown; retryable: boolean; status?: number; code?: string }> = [
    {
      name: "401 authentication",
      error: apiError(401, "invalid_api_key", `Incorrect API key provided: sk-test-0123****mnop.`),
      retryable: false,
      status: 401,
      code: "invalid_api_key",
    },
    { name: "400 invalid request", error: apiError(400, "invalid_request_error", "Bad value."), retryable: false, status: 400 },
    { name: "404 unknown model", error: apiError(404, "model_not_found", "The model does not exist."), retryable: false, status: 404, code: "model_not_found" },
    { name: "429 rate limit", error: apiError(429, "rate_limit_exceeded", "Slow down."), retryable: true, status: 429 },
    { name: "429 quota used up", error: apiError(429, "insufficient_quota", "Quota exceeded."), retryable: false, status: 429 },
    { name: "500 server error", error: apiError(500, "server_error", "Oops."), retryable: true, status: 500 },
    { name: "503 unavailable", error: apiError(503, "unavailable", "Overloaded."), retryable: true, status: 503 },
    { name: "timeout", error: new APIConnectionTimeoutError(), retryable: true, code: "timeout" },
    { name: "connection error", error: new APIConnectionError({ message: "ECONNREFUSED" }), retryable: true, code: "connection_error" },
    { name: "abort", error: new APIUserAbortError(), retryable: true, code: "aborted" },
    { name: "unexpected error", error: new TypeError("x is not a function"), retryable: false, code: "unexpected_error" },
  ];

  const stages: Array<{ stage: AiStage; code: string; run: (client: OpenAI) => Promise<unknown>; pick: (m: Mocks) => ReturnType<typeof vi.fn> }> = [
    {
      stage: "asr",
      code: "ASR_PROVIDER_ERROR",
      pick: (m) => m.transcribe,
      run: (client) =>
        new OpenAITranscriber(client).transcribe({ audio: Buffer.from("a"), fileName: "a.wav", mimeType: "audio/wav", model: ASR_MODEL }),
    },
    {
      stage: "translation",
      code: "TRANSLATION_PROVIDER_ERROR",
      pick: (m) => m.respond,
      run: (client) => new OpenAITranslator(client).translate(translationInput),
    },
    {
      stage: "tts",
      code: "TTS_PROVIDER_ERROR",
      pick: (m) => m.speak,
      run: (client) => new OpenAISpeechSynthesizer(client).synthesize({ model: TTS_MODEL, text: "Hi.", voice: "voice-a" }),
    },
  ];

  for (const stage of stages) {
    for (const testCase of cases) {
      it(`${stage.stage}: ${testCase.name}`, async () => {
        const { client, mocks } = mockClient();
        stage.pick(mocks).mockReturnValue(rejectedApiPromise(testCase.error));
        const error = (await caught(() => stage.run(client))) as AiProviderError;
        expect(error).toBeInstanceOf(AiProviderError);
        expect(error).toBeInstanceOf(AppError);
        expect(error.code).toBe(stage.code);
        expect(error.httpStatus).toBe(502);
        expect(error.provider).toBe("openai");
        expect(error.retryable).toBe(testCase.retryable);
        expect(error.providerStatus).toBe(testCase.status);
        if (testCase.code) expect(error.providerErrorCode).toBe(testCase.code);
        if (testCase.status) expect(error.providerRequestId).toBe("req_err_1");
        // No key material, not even the partly masked form the provider echoes.
        expect(error.message).not.toContain("sk-");
        expect(JSON.stringify(error.details)).not.toContain("sk-");
      });
    }
  }

  it("removes the configured key from a message even without the usual prefix", async () => {
    const { client, mocks } = mockClient();
    (client as unknown as { apiKey: string }).apiKey = "plainsecretvalue123";
    mocks.respond.mockReturnValue(
      rejectedApiPromise(new APIConnectionError({ message: "proxy rejected header plainsecretvalue123" })),
    );
    const error = (await caught(() => new OpenAITranslator(client).translate(translationInput))) as AiProviderError;
    expect(error.message).not.toContain("plainsecretvalue123");
    expect(error.message).toContain("[redacted]");
  });
});

describe("createOpenAIClient", () => {
  it("throws CONFIGURATION_MISSING without a key", () => {
    for (const key of ["", "   "]) {
      try {
        createOpenAIClient(key);
        throw new Error("expected a throw");
      } catch (error) {
        expect((error as AppError).code).toBe("CONFIGURATION_MISSING");
      }
    }
  });

  it("disables SDK retries by default and sets a timeout", () => {
    const client = createOpenAIClient(FAKE_KEY);
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(120_000);
    const custom = createOpenAIClient(FAKE_KEY, { timeoutMs: 5000, maxRetries: 1 });
    expect(custom.maxRetries).toBe(1);
    expect(custom.timeout).toBe(5000);
  });
});

describe("testOpenAIConnectivity", () => {
  it("lists models and reports success", async () => {
    const { client, mocks } = mockClient();
    mocks.listModels.mockResolvedValue({ data: [] });
    const result = await testOpenAIConnectivity(client);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mocks.listModels).toHaveBeenCalledTimes(1);
    expect(mocks.respond).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.speak).not.toHaveBeenCalled();
  });

  it("reports a failure without throwing and without key material", async () => {
    const { client, mocks } = mockClient();
    mocks.listModels.mockRejectedValue(
      APIError.generate(401, { error: { message: `Incorrect API key provided: ${FAKE_KEY}`, code: "invalid_api_key" } }, undefined, new Headers()),
    );
    const result = await testOpenAIConnectivity(client);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("connectivity test");
    expect(result.message).toContain("401");
    expect(result.message).not.toContain("sk-");
  });
});
