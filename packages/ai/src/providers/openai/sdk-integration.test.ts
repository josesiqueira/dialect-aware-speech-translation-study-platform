import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import type { AiProviderError } from "../../errors";
import { testOpenAIConnectivity } from "./client";
import { OpenAISpeechSynthesizer } from "./synthesizer";
import { OpenAITranscriber } from "./transcriber";
import { OpenAITranslator } from "./translator";

// These tests run the adapters through the real installed SDK client. The
// network is replaced by a local `fetch` function, so no request leaves the
// machine. They check what the mocked-client tests cannot: the real request
// encoding, `withResponse()`, and the real error classes.

type Seen = { url: string; method: string; headers: Headers; body: unknown };

function clientWith(handler: (seen: Seen) => Response): { client: OpenAI; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchStub = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as string, init as RequestInit);
    // The SDK probes multipart support once with a `data:` URL. Not an API call.
    if (request.url.startsWith("data:")) return new Response();
    const contentType = request.headers.get("content-type") ?? "";
    let body: unknown;
    if (contentType.includes("multipart/form-data")) body = await request.formData();
    else if (contentType.includes("application/json")) body = await request.json();
    const entry = { url: request.url, method: request.method, headers: request.headers, body };
    seen.push(entry);
    return handler(entry);
  };
  const client = new OpenAI({
    apiKey: "sk-test-local-stub-key-000000",
    baseURL: "http://127.0.0.1:9/v1",
    maxRetries: 0,
    fetch: fetchStub as unknown as typeof fetch,
  });
  return { client, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("adapters through the real SDK client (local fetch stub)", () => {
  it("transcription: multipart request, request id from the header", async () => {
    const { client, seen } = clientWith(() => json({ text: "Moi vaan." }, 200, { "x-request-id": "req_sdk_asr" }));
    const audio = Buffer.from([1, 2, 3, 4, 5]);
    const result = await new OpenAITranscriber(client).transcribe({
      audio,
      fileName: "utterance.wav",
      mimeType: "audio/wav",
      model: "configured-asr-model",
      language: "fi",
    });
    expect(seen[0]?.url).toBe("http://127.0.0.1:9/v1/audio/transcriptions");
    const form = seen[0]?.body as FormData;
    expect(form.get("model")).toBe("configured-asr-model");
    expect(form.get("language")).toBe("fi");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.name).toBe("utterance.wav");
    expect(Buffer.from(await file.arrayBuffer()).equals(audio)).toBe(true);
    expect(result.text).toBe("Moi vaan.");
    expect(result.providerRequestId).toBe("req_sdk_asr");
  });

  it("translation: Responses API body, raw output text, returned model", async () => {
    const raw = " Hi there.\n";
    const { client, seen } = clientWith(() =>
      json(
        {
          id: "resp_sdk",
          object: "response",
          status: "completed",
          model: "returned-text-model",
          output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: raw, annotations: [] }] }],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
        200,
        { "x-request-id": "req_sdk_tr", "openai-processing-ms": "77" },
      ),
    );
    const result = await new OpenAITranslator(client).translate({
      model: "configured-text-model",
      instruction: "Translate.",
      sourceText: "Moi vaan.",
      sourceLanguage: "fi",
      targetLanguage: "en",
    });
    expect(seen[0]?.url).toBe("http://127.0.0.1:9/v1/responses");
    expect(seen[0]?.body).toEqual({ model: "configured-text-model", instructions: "Translate.", input: "Moi vaan.", store: false });
    expect(result.text).toBe(raw);
    expect(result.returnedModel).toBe("returned-text-model");
    expect(result.providerRequestId).toBe("req_sdk_tr");
    expect((result.rawMetadata as { headers: Record<string, string> }).headers["openai-processing-ms"]).toBe("77");
  });

  it("speech: JSON body, audio bytes and request id", async () => {
    const bytes = Buffer.from("RIFFxxxxWAVE");
    const { client, seen } = clientWith(
      () => new Response(new Uint8Array(bytes), { headers: { "content-type": "audio/wav", "x-request-id": "req_sdk_tts" } }),
    );
    const result = await new OpenAISpeechSynthesizer(client).synthesize({
      model: "configured-speech-model",
      text: "Hi there.",
      voice: "voice-a",
      instructions: "Speak naturally.",
    });
    expect(seen[0]?.url).toBe("http://127.0.0.1:9/v1/audio/speech");
    expect(seen[0]?.body).toEqual({
      model: "configured-speech-model",
      voice: "voice-a",
      response_format: "wav",
      instructions: "Speak naturally.",
      input: "Hi there.",
    });
    expect(result.audio.equals(bytes)).toBe(true);
    expect(result.providerRequestId).toBe("req_sdk_tts");
  });

  it("maps a real SDK HTTP error and a real connection error", async () => {
    const unauthorized = clientWith(() =>
      json({ error: { message: "Incorrect API key provided: sk-test****0000.", type: "invalid_request_error", code: "invalid_api_key" } }, 401, {
        "x-request-id": "req_sdk_401",
      }),
    );
    const input = { model: "m", instruction: "Translate.", sourceText: "Moi.", sourceLanguage: "fi", targetLanguage: "en" };
    const authError = (await new OpenAITranslator(unauthorized.client).translate(input).catch((e: unknown) => e)) as AiProviderError;
    expect(authError.code).toBe("TRANSLATION_PROVIDER_ERROR");
    expect(authError.retryable).toBe(false);
    expect(authError.providerStatus).toBe(401);
    expect(authError.providerRequestId).toBe("req_sdk_401");
    expect(authError.providerErrorCode).toBe("invalid_api_key");
    expect(authError.message).not.toContain("sk-");

    const broken = clientWith(() => {
      throw new TypeError("fetch failed");
    });
    const connectionError = (await new OpenAITranslator(broken.client).translate(input).catch((e: unknown) => e)) as AiProviderError;
    expect(connectionError.retryable).toBe(true);
    expect(connectionError.providerErrorCode).toBe("connection_error");
  });

  it("connectivity test calls GET /models only", async () => {
    const { client, seen } = clientWith(() => json({ object: "list", data: [] }));
    const result = await testOpenAIConnectivity(client);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe("http://127.0.0.1:9/v1/models");
  });
});
