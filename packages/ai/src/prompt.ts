import { validationError } from "./errors";

// Prompt construction (spec 105).
//
// The prompt version text written by the researcher is used verbatim as the
// instruction. The only change ever made is replacing the documented
// placeholders below. No participant metadata can be added: the builders have
// no parameter for it (spec 65).
//
// Placeholders:
//   {{source_language}}  replaced by `sourceLanguage`
//   {{target_language}}  replaced by `targetLanguage`
//
// Any other `{{name}}` placeholder is rejected, so that a typing mistake is not
// sent to the model unnoticed.

export const TRANSLATION_PROMPT_PLACEHOLDERS = ["source_language", "target_language"] as const;
export const SYNTHESIS_PROMPT_PLACEHOLDERS = ["target_language"] as const;

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// Names of `{{name}}` placeholders in `text` that are not in `allowed`.
// The prompt editor can call this before saving a prompt version.
export function findUnknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !allowed.includes(name)) unknown.add(name);
  }
  return [...unknown];
}

function fillPlaceholders(text: string, values: Record<string, string | undefined>): string {
  const allowed = Object.keys(values);
  const unknown = findUnknownPlaceholders(text, allowed);
  if (unknown.length > 0) {
    throw validationError(
      `Unknown placeholder in prompt text: ${unknown.map((n) => `{{${n}}}`).join(", ")}. ` +
        `Supported placeholders: ${allowed.map((n) => `{{${n}}}`).join(", ")}.`,
      { unknownPlaceholders: unknown },
    );
  }
  return text.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = values[name];
    if (value === undefined || value.length === 0) {
      throw validationError(`Prompt text uses {{${name}}} but no value was given for it.`);
    }
    return value;
  });
}

export type BuildTranslationRequestInput = {
  // Text of the prompt version (ai_prompt_versions row).
  promptText: string;
  // Transcript revision text to translate.
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslationRequest = {
  // Pass as `TranslationInput.instruction`.
  instruction: string;
  // Pass as `TranslationInput.sourceText`. Always the source text, unchanged.
  input: string;
  // Store in the model run input manifest. Equal to `instruction`: it is the
  // final text after placeholder replacement.
  effectiveInstruction: string;
};

export function buildTranslationRequest(args: BuildTranslationRequestInput): TranslationRequest {
  if (args.promptText.trim().length === 0) {
    throw validationError("The translation prompt text is empty. An explicit prompt version is required.");
  }
  if (args.sourceText.trim().length === 0) {
    throw validationError("The source text to translate is empty.");
  }
  const instruction = fillPlaceholders(args.promptText, {
    source_language: args.sourceLanguage,
    target_language: args.targetLanguage,
  });
  return { instruction, input: args.sourceText, effectiveInstruction: instruction };
}

export type BuildSynthesisRequestInput = {
  // Text of the TTS prompt version. Null or empty means no speaking instruction.
  promptText?: string | null;
  // The exact text to speak (the stored translation text).
  text: string;
  // Used only for the {{target_language}} placeholder.
  targetLanguage?: string;
};

export type SynthesisRequest = {
  // Pass as `SynthesisInput.instructions`. Undefined when there is no instruction.
  instructions?: string;
  // Pass as `SynthesisInput.text`. Always the given text, unchanged.
  input: string;
  // Store in the model run input manifest. Null when no instruction was sent.
  effectiveInstruction: string | null;
};

export function buildSynthesisRequest(args: BuildSynthesisRequestInput): SynthesisRequest {
  if (args.text.trim().length === 0) {
    throw validationError("The text to synthesize is empty.");
  }
  const promptText = args.promptText ?? "";
  if (promptText.trim().length === 0) {
    return { input: args.text, effectiveInstruction: null };
  }
  const instructions = fillPlaceholders(promptText, { target_language: args.targetLanguage });
  return { instructions, input: args.text, effectiveInstruction: instructions };
}
