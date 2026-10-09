# @dialect/ai

Provider-neutral interfaces for the three pipeline stages (ASR, text translation, TTS), the OpenAI adapters, a deterministic mock provider, the prompt builder and the provider registry.

Services import from `@dialect/ai` only. Nothing outside this package imports a provider SDK (spec 104).

## Rules this package enforces

- **No model identifiers in code** (spec 25, 143). The model arrives in the input, from the model configuration in the database. A test fails if a model identifier literal appears in non-test source.
- **No invented parameters** (spec 103). Each OpenAI endpoint has an explicit allow-list. A parameter outside it is rejected with `VALIDATION_ERROR`, never dropped silently. A parameter the configuration does not set is not sent.
- **Minimum input to the provider** (spec 65, 105). `TranslationInput` has no field for participant metadata. Request metadata and user identifier parameters are not on the allow-list.
- **Raw output** (spec 146, 147, 148). Transcript and translation text are returned exactly as the provider produced them. Nothing is trimmed, re-punctuated or re-cased. Segments and word timestamps are kept when the provider returns them.
- **Provenance** (spec 27). Every result carries `provider`, `requestedModel`, `returnedModel`, `providerRequestId`, `parametersSent`, `usage`, `latencyMs`, `rawMetadata`, `startedAt`, `finishedAt`.
- **No key material** in results, errors or logs. The package never reads the environment: the caller passes the key.

## Usage

```ts
import { createProviderRegistry, buildTranslationRequest } from "@dialect/ai";

const registry = createProviderRegistry({
  openaiApiKey: env.OPENAI_API_KEY, // may be undefined: the app still starts
  allowMock: env.NODE_ENV !== "production",
});

const request = buildTranslationRequest({ promptText, sourceText, sourceLanguage: "fi", targetLanguage: "en" });
const result = await registry.translator(modelConfig.provider).translate({
  model: modelConfig.model,
  instruction: request.instruction,
  sourceText: request.input,
  sourceLanguage: "fi",
  targetLanguage: "en",
  parameters: modelConfig.parameters,
});
// Store result.text, and the provenance fields in model_runs.
// Store request.effectiveInstruction in the input manifest.
```

The registry is created without checking the key. Asking for `openai` without a key throws `AppError("CONFIGURATION_MISSING")` at that moment, so recording collection does not depend on AI availability (spec 29).

## Errors

| Error | Code | Meaning |
|---|---|---|
| `AiProviderError` | `ASR_PROVIDER_ERROR`, `TRANSLATION_PROVIDER_ERROR`, `TTS_PROVIDER_ERROR` | The provider call failed. `retryable` says whether a later attempt can help. |
| `AppError` | `VALIDATION_ERROR` | Parameter outside the allow-list, wrong value, empty input, unknown provider, unknown prompt placeholder. Not retryable. |
| `AppError` | `CONFIGURATION_MISSING` | No API key, or the mock provider is disabled. Not retryable. |

`isAppError` (from `@dialect/domain`), `isAiProviderError` and `isRetryableAiError` check the shape of the error (`name`, `code`, and for provider errors `stage`, `provider` and a boolean `retryable`), with `instanceof` only as a fast path. One process can hold more than one copy of the error classes (the production web build bundles them once per group of routes, a development server keeps old copies after a hot reload), while the provider registry lives for the whole process. Always use these helpers, never `instanceof`, on an error that may come from another package.

`retryable` is true for HTTP 408, 409, 429 and 5xx, timeouts, connection errors and aborted requests. It is false for 400, 401, 403, 404, 422, for a 429 whose code is `insufficient_quota`, for a model refusal, for an incomplete (cut-off) translation and for an empty translation. Use `isRetryableAiError(error)` in the job queue.

The SDK client is created with `maxRetries: 0`: the job queue owns retries, so every attempt is one visible `model_runs` record.

## OpenAI adapters

| Stage | SDK call | Notes |
|---|---|---|
| ASR | `client.audio.transcriptions.create` | Non-streaming. `response_format` defaults to `json`, which every transcription model accepts. Set `verbose_json` (segments, language, duration, optional word timestamps) or `diarized_json` in the model configuration when the configured model supports it. |
| Translation | `client.responses.create` | Responses API. `instructions` is the prompt version text, `input` is the source text alone. A refusal, a failed or incomplete response and an empty output are errors. |
| TTS | `client.audio.speech.create` | `response_format` defaults to `wav`. `instructions` is sent only when the input sets it. |

Allowed `parameters` keys:

- ASR: `response_format` (`json`, `verbose_json`, `diarized_json`), `temperature`, `timestamp_granularities`, `include`, `chunking_strategy`, `keywords`, `languages`.
- Translation: `temperature`, `top_p`, `max_output_tokens`, `reasoning` (`effort`, `mode`), `text` (`verbosity`), `service_tier`, `store`, `truncation`.
- TTS: `speed`.

Language hint, ASR context prompt, voice, speaking instruction and output format are typed input fields, not `parameters` keys.

The translation adapter adds one default to a request: it sends `store: false` unless the model configuration sets `store` itself. The Responses API keeps a response for later retrieval unless `store` is false, and participant speech content must not be retained by the provider beyond the request without a decision by the researchers (spec 65). The value that was sent is part of `parametersSent`, so the provenance of every model run shows it.

The transcription and speech endpoints do not report the model that served the request, so `returnedModel` is undefined for those two stages. The Responses API reports it.

`testOpenAIConnectivity(client)` lists models. It generates no model output and never throws.

## Mock provider

Provider name `mock`. Available only when the registry is created with `allowMock: true`. It never calls a network service.

- `MockTranscriber`: Finnish-looking text derived from the SHA-256 of the audio, starting with `[mock-transkriptio <hash>]`.
- `MockTranslator`: `[mock translation <instruction hash> <source>><target>] <source text>`. Different prompt versions give different outputs.
- `MockSpeechSynthesizer`: a 16 kHz, 16-bit mono PCM WAV sine tone.

Mock parameters (any other key is accepted and recorded):

| Key | Effect |
|---|---|
| `mockText` | ASR and translation return exactly this text. |
| `mockFail` | `"retryable"` or `"permanent"`: the call throws `AiProviderError`. |
| `mockFailTimes` | With `mockFail`: only the first N calls with the same input fail. Without it every call fails. The count is kept in memory per adapter instance. |

Every mock result has `provider: "mock"` and `returnedModel: "mock"`, so a mock run cannot be mistaken for real model output.

## Adding a provider

1. Create `src/providers/<name>/` and implement the interfaces the provider supports (`Transcriber`, `Translator`, `SpeechSynthesizer` from `src/types.ts`). A provider may offer only one stage, for example a local Whisper server that only transcribes.
2. Validate `parameters` with `parseAllowedParameters` and an explicit allow-list for that provider.
3. Fill every provenance field. Throw `AiProviderError` with the right `stage` and `retryable`.
4. Register it. Either add a definition next to `openaiDefinition` in `src/registry.ts`, or pass it from the application:

```ts
createProviderRegistry({
  allowMock: false,
  extraProviders: [
    {
      name: "local-whisper",
      isConfigured: () => Boolean(env.LOCAL_WHISPER_URL),
      transcriber: () => new LocalWhisperTranscriber(env.LOCAL_WHISPER_URL),
    },
  ],
});
```

5. Add tests with a mocked client. Model configurations in the database then select the provider by its name.

## Cost estimate

`estimateCost(usage, pricing)` returns an estimate only when the caller supplies a price table. The package contains no prices (spec 102). The result has `isEstimate: true`.

## Methodological warnings (spec Appendix D)

Relevant to this package:

- A model alias is not a permanently reproducible identifier. Record the date and the returned model metadata (warning 13). For ASR and TTS the provider returns no resolved model, so the run date and request id are the only record.
- Do not send participant metadata to AI providers (warning 16).
- Do not blame TTS for prosodic information that was already lost before synthesis (warning 11).
- Do not let implementation convenience destroy the ability to identify where a transformation occurred (warning 20): outputs are stored raw, per stage.
