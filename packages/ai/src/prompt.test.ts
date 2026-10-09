import { describe, expect, it } from "vitest";
import type { AppError } from "@dialect/domain";
import { estimateCost } from "./cost";
import { redactSecrets } from "./errors";
import { buildSynthesisRequest, buildTranslationRequest, findUnknownPlaceholders } from "./prompt";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as AppError).code;
  }
  throw new Error("Expected a throw.");
}

describe("buildTranslationRequest", () => {
  const base = { sourceText: "  Mää oon tääl.\n", sourceLanguage: "Finnish", targetLanguage: "English" };

  it("uses the prompt text verbatim and the source text alone as input", () => {
    const promptText = "Translate the following Finnish utterance into natural spoken English.\nPreserve its meaning.\n";
    const request = buildTranslationRequest({ ...base, promptText });
    expect(request.instruction).toBe(promptText);
    expect(request.effectiveInstruction).toBe(promptText);
    expect(request.input).toBe("  Mää oon tääl.\n");
    expect(Object.keys(request).sort()).toEqual(["effectiveInstruction", "input", "instruction"]);
  });

  it("replaces only the documented placeholders", () => {
    const request = buildTranslationRequest({
      ...base,
      promptText: "Translate from {{source_language}} into {{ target_language }}. Keep {braces} and {{source_language}}.",
    });
    expect(request.instruction).toBe("Translate from Finnish into English. Keep {braces} and Finnish.");
    expect(request.effectiveInstruction).toBe(request.instruction);
    expect(request.instruction).not.toContain("Mää");
  });

  it("rejects unknown placeholders, an empty prompt and an empty source text", () => {
    expect(codeOf(() => buildTranslationRequest({ ...base, promptText: "Translate for {{participant_region}}." }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => buildTranslationRequest({ ...base, promptText: "  " }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => buildTranslationRequest({ ...base, promptText: "Translate.", sourceText: "" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => buildTranslationRequest({ ...base, promptText: "To {{target_language}}.", targetLanguage: "" }))).toBe("VALIDATION_ERROR");
  });

  it("finds unknown placeholders for the prompt editor", () => {
    expect(findUnknownPlaceholders("a {{x}} b {{source_language}} {{x}}", ["source_language"])).toEqual(["x"]);
  });
});

describe("buildSynthesisRequest", () => {
  it("passes the text unchanged and the instruction verbatim", () => {
    const request = buildSynthesisRequest({
      promptText: "Speak the text naturally in conversational {{target_language}}.",
      text: " Well, I don't know. ",
      targetLanguage: "English",
    });
    expect(request.input).toBe(" Well, I don't know. ");
    expect(request.instructions).toBe("Speak the text naturally in conversational English.");
    expect(request.effectiveInstruction).toBe(request.instructions);
  });

  it("has no instruction when the prompt text is missing", () => {
    for (const promptText of [undefined, null, ""]) {
      const request = buildSynthesisRequest({ promptText, text: "Hello." });
      expect(request.instructions).toBeUndefined();
      expect(request.effectiveInstruction).toBeNull();
    }
  });

  it("rejects an empty text and unknown placeholders", () => {
    expect(codeOf(() => buildSynthesisRequest({ text: "" }))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => buildSynthesisRequest({ text: "Hi.", promptText: "Sound like {{region}}." }))).toBe("VALIDATION_ERROR");
  });
});

describe("estimateCost", () => {
  it("returns null without a pricing table or without matching usage", () => {
    expect(estimateCost({ inputTokens: 1000, outputTokens: 500 }, undefined)).toBeNull();
    expect(estimateCost({ inputTokens: 1000 }, null)).toBeNull();
    expect(estimateCost(undefined, { currency: "USD", inputPerMillionTokens: 1 })).toBeNull();
    expect(estimateCost({ audioSeconds: 30 }, { currency: "USD", inputPerMillionTokens: 1 })).toBeNull();
  });

  it("computes a labelled estimate from supplied rates", () => {
    const estimate = estimateCost(
      { inputTokens: 2_000_000, outputTokens: 500_000, audioSeconds: 90, inputCharacters: 1_000_000 },
      { currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8, perAudioMinute: 0.5, perMillionInputCharacters: 3 },
    );
    expect(estimate?.isEstimate).toBe(true);
    expect(estimate?.currency).toBe("USD");
    expect(estimate?.amount).toBeCloseTo(4 + 4 + 0.75 + 3, 10);
    expect(estimate?.basis).toHaveLength(4);
  });
});

describe("redactSecrets", () => {
  it("removes given secrets and key-like tokens", () => {
    const text = "key sk-proj-abc123DEF456 and masked sk-ab***yz and Bearer abcdefgh12345678 and mysecretvalue";
    const result = redactSecrets(text, ["mysecretvalue"]);
    expect(result).not.toContain("sk-");
    expect(result).not.toContain("abcdefgh12345678");
    expect(result).not.toContain("mysecretvalue");
  });
});
