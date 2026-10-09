import type { OpenAI } from "openai";
import { AppError } from "@dialect/domain";
import { validationError } from "./errors";
import { MOCK_PROVIDER, MockSpeechSynthesizer, MockTranscriber, MockTranslator } from "./providers/mock";
import {
  OPENAI_PROVIDER,
  OpenAISpeechSynthesizer,
  OpenAITranscriber,
  OpenAITranslator,
  createOpenAIClient,
  type OpenAIClientOptions,
} from "./providers/openai";
import type { SpeechSynthesizer, Transcriber, Translator } from "./types";

export type ProviderRegistry = {
  transcriber(provider: string): Transcriber;
  translator(provider: string): Translator;
  synthesizer(provider: string): SpeechSynthesizer;
  isConfigured(provider: string): boolean;
  listProviders(): string[];
};

// One provider as the registry sees it. To add a provider (local Whisper,
// Seamless, a university ASR service), implement the interfaces it supports and
// pass a definition in `extraProviders`. A stage the provider does not offer is
// left out.
export type ProviderDefinition = {
  name: string;
  // False when required configuration (key, URL) is missing. The registry then
  // throws CONFIGURATION_MISSING when the provider is requested.
  isConfigured(): boolean;
  // Shown in the CONFIGURATION_MISSING error.
  notConfiguredMessage?: string;
  transcriber?: () => Transcriber;
  translator?: () => Translator;
  synthesizer?: () => SpeechSynthesizer;
};

export type ProviderRegistryOptions = {
  openaiApiKey?: string;
  allowMock: boolean;
  // An already built OpenAI client. Used by tests to inject a mock client.
  openaiClient?: unknown;
  openaiClientOptions?: OpenAIClientOptions;
  extraProviders?: ProviderDefinition[];
};

function once<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => {
    if (value === undefined) value = create();
    return value;
  };
}

function openaiDefinition(options: ProviderRegistryOptions): ProviderDefinition {
  const hasKey = typeof options.openaiApiKey === "string" && options.openaiApiKey.trim().length > 0;
  const hasClient = options.openaiClient !== undefined && options.openaiClient !== null;
  // The client is built on first use, not at registry creation.
  const client = once<OpenAI>(() =>
    hasClient
      ? (options.openaiClient as OpenAI)
      : createOpenAIClient(options.openaiApiKey ?? "", options.openaiClientOptions),
  );
  const transcriber = once(() => new OpenAITranscriber(client()));
  const translator = once(() => new OpenAITranslator(client()));
  const synthesizer = once(() => new OpenAISpeechSynthesizer(client()));
  return {
    name: OPENAI_PROVIDER,
    isConfigured: () => hasKey || hasClient,
    notConfiguredMessage:
      "No OpenAI API key is configured. Set OPENAI_API_KEY on the server to use the openai provider.",
    transcriber,
    translator,
    synthesizer,
  };
}

function mockDefinition(): ProviderDefinition {
  // One instance per registry, so that failure injection counts survive across
  // calls (the queue retry test needs "fail twice, then succeed").
  const transcriber = once(() => new MockTranscriber());
  const translator = once(() => new MockTranslator());
  const synthesizer = once(() => new MockSpeechSynthesizer());
  return { name: MOCK_PROVIDER, isConfigured: () => true, transcriber, translator, synthesizer };
}

// Creating the registry never fails and never needs a key: the application can
// start and collect recordings without any AI provider (spec 29). Errors are
// thrown when an adapter is requested.
export function createProviderRegistry(options: ProviderRegistryOptions): ProviderRegistry {
  const definitions = new Map<string, ProviderDefinition>();
  definitions.set(OPENAI_PROVIDER, openaiDefinition(options));
  if (options.allowMock) definitions.set(MOCK_PROVIDER, mockDefinition());
  for (const extra of options.extraProviders ?? []) {
    if (definitions.has(extra.name) || extra.name === MOCK_PROVIDER) {
      throw validationError(`AI provider "${extra.name}" is already registered.`);
    }
    definitions.set(extra.name, extra);
  }

  function resolve<T>(provider: string, stage: "transcriber" | "translator" | "synthesizer"): T {
    if (provider === MOCK_PROVIDER && !options.allowMock) {
      throw new AppError(
        "CONFIGURATION_MISSING",
        "The mock AI provider is disabled in this environment. It is only available for tests and local development.",
        { provider },
      );
    }
    const definition = definitions.get(provider);
    if (!definition) {
      throw validationError(
        `Unknown AI provider "${provider}". Registered providers: ${[...definitions.keys()].join(", ")}.`,
        { provider, registeredProviders: [...definitions.keys()] },
      );
    }
    const factory = definition[stage] as (() => T) | undefined;
    if (!factory) {
      throw validationError(`AI provider "${provider}" does not offer a ${stage}.`, { provider, stage });
    }
    if (!definition.isConfigured()) {
      throw new AppError(
        "CONFIGURATION_MISSING",
        definition.notConfiguredMessage ?? `AI provider "${provider}" is not configured.`,
        { provider },
      );
    }
    return factory();
  }

  return {
    transcriber: (provider) => resolve<Transcriber>(provider, "transcriber"),
    translator: (provider) => resolve<Translator>(provider, "translator"),
    synthesizer: (provider) => resolve<SpeechSynthesizer>(provider, "synthesizer"),
    isConfigured: (provider) => definitions.get(provider)?.isConfigured() ?? false,
    listProviders: () => [...definitions.keys()],
  };
}
