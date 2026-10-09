// Validation of model_configs.parameters_json when a config is saved, so that a
// bad parameter is caught in the editor and not when a batch runs (spec 103).
//
// Nothing is ever added: a parameter the researcher did not set is not stored
// and not sent.
import { z } from "zod";
import {
  OPENAI_PROVIDER,
  OPENAI_SPEECH_PARAMETERS,
  OPENAI_TRANSCRIPTION_DEFAULT_RESPONSE_FORMAT,
  OPENAI_TRANSCRIPTION_PARAMETERS,
  OPENAI_TRANSLATION_PARAMETERS,
  SYNTHESIS_OUTPUT_FORMATS,
  parseAllowedParameters,
  type ModelParameters,
  type ProviderRegistry,
} from "@dialect/ai";
import { AppError, type ProcessingStage } from "@dialect/domain";

// Keys stored in parameters_json that the processing code passes to the
// adapters as typed input fields instead of provider parameters (plan,
// "Model config parameters").
const ASR_CONFIG_KEYS = {
  language: z.string().trim().min(1, "must not be empty"),
} as const;

const TTS_CONFIG_KEYS = {
  voice: z.string().trim().min(1, "must not be empty"),
  response_format: z.enum(SYNTHESIS_OUTPUT_FORMATS),
  instructions: z.string(),
} as const;

export const CONFIG_LEVEL_KEYS: Record<ProcessingStage, readonly string[]> = {
  asr: Object.keys(ASR_CONFIG_KEYS),
  translation: [],
  tts: Object.keys(TTS_CONFIG_KEYS),
  realtime_translation: [],
};

function configLevelShape(stage: ProcessingStage): z.ZodRawShape {
  if (stage === "asr") return ASR_CONFIG_KEYS;
  if (stage === "tts") return TTS_CONFIG_KEYS;
  return {};
}

// The parameters the openai adapters accept, per stage, plus the config level keys.
function openaiShape(stage: ProcessingStage): { label: string; shape: z.ZodRawShape } | null {
  if (stage === "asr") {
    return {
      label: "an OpenAI transcription configuration",
      shape: { ...OPENAI_TRANSCRIPTION_PARAMETERS, ...ASR_CONFIG_KEYS },
    };
  }
  if (stage === "translation") {
    return { label: "an OpenAI translation configuration", shape: { ...OPENAI_TRANSLATION_PARAMETERS } };
  }
  if (stage === "tts") {
    return {
      label: "an OpenAI speech synthesis configuration",
      shape: { ...OPENAI_SPEECH_PARAMETERS, ...TTS_CONFIG_KEYS },
    };
  }
  // No adapter and no allow-list exists for this stage yet.
  return null;
}

export function assertKnownProvider(providers: ProviderRegistry, provider: string): void {
  const registered = providers.listProviders();
  if (registered.includes(provider)) return;
  throw new AppError(
    "VALIDATION_ERROR",
    `Unknown AI provider "${provider}". Available providers: ${registered.join(", ") || "(none)"}.`,
    { provider, availableProviders: registered },
  );
}

// Returns the parameters to store: the given record without undefined values.
export function validateModelParameters(input: {
  provider: string;
  stage: ProcessingStage;
  parameters: ModelParameters;
}): ModelParameters {
  if (input.parameters === null || typeof input.parameters !== "object" || Array.isArray(input.parameters)) {
    throw new AppError("VALIDATION_ERROR", "The parameters must be a JSON object, for example {} or {\"speed\": 1}.");
  }
  const given: ModelParameters = {};
  for (const [key, value] of Object.entries(input.parameters)) {
    if (value !== undefined) given[key] = value;
  }

  if (input.provider === OPENAI_PROVIDER) {
    const openai = openaiShape(input.stage);
    if (openai) {
      const parsed = parseAllowedParameters(openai.label, given, openai.shape) as Record<string, unknown>;
      if (input.stage === "asr") assertTranscriptionCombination(parsed);
    }
    return given;
  }

  // Other providers define their own parameters. Only the config level keys
  // have a fixed meaning, so only those are checked.
  const shape = configLevelShape(input.stage);
  const subset: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (key in given) subset[key] = given[key];
  }
  const result = z.object(shape).partial().safeParse(subset);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ parameter: issue.path.join("."), message: issue.message }));
    throw new AppError(
      "VALIDATION_ERROR",
      `Invalid parameter value: ${issues.map((i) => `"${i.parameter}": ${i.message}`).join("; ")}`,
      { issues },
    );
  }
  return given;
}

// The same two rules the OpenAI transcription adapter applies at run time.
function assertTranscriptionCombination(parameters: Record<string, unknown>): void {
  const responseFormat = parameters.response_format ?? OPENAI_TRANSCRIPTION_DEFAULT_RESPONSE_FORMAT;
  if (parameters.timestamp_granularities !== undefined && responseFormat !== "verbose_json") {
    throw new AppError(
      "VALIDATION_ERROR",
      'The parameter "timestamp_granularities" requires "response_format": "verbose_json".',
    );
  }
  if (parameters.include !== undefined && responseFormat !== "json") {
    throw new AppError("VALIDATION_ERROR", 'The parameter "include" requires "response_format": "json".');
  }
}
