// Provider-neutral contracts for the three pipeline stages (spec 15, 104).
// Every adapter (OpenAI, mock, and any later provider) implements these interfaces
// and returns the same result shapes, so the processing services never depend on
// one provider's SDK.

export type AiStage = "asr" | "translation" | "tts";

// Free record taken from the model configuration in the database. Each adapter
// validates it against its own allow-list and rejects anything else.
export type ModelParameters = Record<string, unknown>;

// Usage numbers reported by the provider. Every field is optional because
// providers report different things. `raw` keeps the provider's usage object
// unchanged.
export type AiUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  // Billed input audio duration, for ASR models billed by duration.
  audioSeconds?: number;
  // Length of the text sent to a speech model. Counted locally by the adapter
  // (JavaScript string length), because speech endpoints return audio bytes only.
  inputCharacters?: number;
  raw?: unknown;
};

// Fields every result carries, one to one with the `model_runs` table (spec 27).
export type ProvenanceFields = {
  // Provider name as registered in the provider registry, for example "openai" or "mock".
  provider: string;
  // Model identifier exactly as it came from the model configuration.
  requestedModel: string;
  // Model identifier reported by the provider in its response, when it reports one.
  returnedModel?: string;
  providerRequestId?: string;
  // Exactly the request parameters that were sent, without the audio or text
  // payload and never with credentials.
  parametersSent: Record<string, unknown>;
  usage?: AiUsage;
  latencyMs: number;
  // Observable response metadata that helps reproducibility (response id, model,
  // selected headers, hashes of what was sent). Never hidden model reasoning.
  rawMetadata?: Record<string, unknown>;
  startedAt: Date;
  finishedAt: Date;
};

// ---------- ASR ----------

export type TranscriptionInput = {
  audio: Buffer;
  // File name with an extension that matches the audio format, for example "utterance.wav".
  fileName: string;
  mimeType: string;
  model: string;
  // Language hint, ISO 639-1 (for example "fi").
  language?: string;
  // Context text that guides the ASR model.
  prompt?: string;
  parameters?: ModelParameters;
  signal?: AbortSignal;
};

// Every field is present only when the provider returned it. An adapter never
// fills in a value (spec 103).
export type TranscriptionSegment = {
  id?: string | number;
  // Seconds from the start of the audio.
  start?: number;
  end?: number;
  text?: string;
  speaker?: string;
  // Remaining provider fields of the segment (for example average log probability).
  providerFields?: Record<string, unknown>;
};

export type TranscriptionWord = {
  word?: string;
  start?: number;
  end?: number;
};

export type TranscriptionResult = ProvenanceFields & {
  // Exact transcript as returned by the provider. Not trimmed, not cleaned.
  // An empty string is possible (for example a silent recording) and is returned as is.
  text: string;
  // Present only when the provider returned segments (spec 148).
  segments?: TranscriptionSegment[];
  // Present only when the provider returned word timestamps.
  words?: TranscriptionWord[];
  // Language reported by the provider, when it reports one.
  detectedLanguage?: string;
  // Audio duration in seconds reported by the provider, when it reports one.
  durationSeconds?: number;
};

export interface Transcriber {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

// ---------- Translation ----------

// There is deliberately no field for participant code, region, age, questionnaire
// answers or session metadata (spec 65, 105). The provider receives the instruction
// and the source text, nothing else.
export type TranslationInput = {
  model: string;
  // The prompt version text, already built by `buildTranslationRequest`.
  instruction: string;
  // The transcript to translate. Sent alone as the user input.
  sourceText: string;
  // Language codes or names. The OpenAI adapter does not send them (the instruction
  // carries the task). Providers with explicit language parameters use them.
  sourceLanguage: string;
  targetLanguage: string;
  parameters?: ModelParameters;
  signal?: AbortSignal;
};

export type TranslationResult = ProvenanceFields & {
  // The translation. In this package it always equals `rawText`: no trimming,
  // no punctuation or casing changes (spec 146, 147).
  text: string;
  // The model output exactly as produced.
  rawText: string;
};

export interface Translator {
  translate(input: TranslationInput): Promise<TranslationResult>;
}

// ---------- TTS ----------

export const SYNTHESIS_OUTPUT_FORMATS = ["wav", "mp3", "opus", "aac", "flac", "pcm"] as const;
export type SynthesisOutputFormat = (typeof SYNTHESIS_OUTPUT_FORMATS)[number];

export type SynthesisInput = {
  model: string;
  // The exact string to speak. Sent unchanged.
  text: string;
  voice: string;
  // Speaking instruction (spec 94). Omitted from the request when not set.
  instructions?: string;
  // Defaults to "wav" (spec 22).
  outputFormat?: SynthesisOutputFormat;
  parameters?: ModelParameters;
  signal?: AbortSignal;
};

export type SynthesisResult = ProvenanceFields & {
  audio: Buffer;
  mimeType: string;
  format: SynthesisOutputFormat;
};

export interface SpeechSynthesizer {
  synthesize(input: SynthesisInput): Promise<SynthesisResult>;
}

export const SYNTHESIS_MIME_TYPES: Record<SynthesisOutputFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  // Raw samples without a header. Sample rate and width depend on the provider.
  pcm: "audio/pcm",
};
