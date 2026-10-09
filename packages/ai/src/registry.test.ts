import { describe, expect, it, vi } from "vitest";
import { AppError } from "@dialect/domain";
import { MockSpeechSynthesizer, MockTranscriber, MockTranslator } from "./providers/mock";
import { OpenAISpeechSynthesizer, OpenAITranscriber, OpenAITranslator } from "./providers/openai";
import { createProviderRegistry } from "./registry";
import type { Transcriber } from "./types";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error("Expected a throw.");
}

describe("createProviderRegistry", () => {
  it("can be created without a key and reports openai as not configured", () => {
    const registry = createProviderRegistry({ allowMock: false });
    expect(registry.isConfigured("openai")).toBe(false);
    expect(registry.isConfigured("mock")).toBe(false);
    expect(registry.isConfigured("nothing")).toBe(false);
    expect(registry.listProviders()).toEqual(["openai"]);
  });

  it("throws CONFIGURATION_MISSING for openai without a key, at call time", () => {
    for (const openaiApiKey of [undefined, "", "  "]) {
      const registry = createProviderRegistry({ openaiApiKey, allowMock: true });
      expect(codeOf(() => registry.transcriber("openai"))).toBe("CONFIGURATION_MISSING");
      expect(codeOf(() => registry.translator("openai"))).toBe("CONFIGURATION_MISSING");
      expect(codeOf(() => registry.synthesizer("openai"))).toBe("CONFIGURATION_MISSING");
    }
  });

  it("returns OpenAI adapters when a key is set", () => {
    const registry = createProviderRegistry({ openaiApiKey: "sk-test-not-a-real-key", allowMock: false });
    expect(registry.isConfigured("openai")).toBe(true);
    expect(registry.transcriber("openai")).toBeInstanceOf(OpenAITranscriber);
    expect(registry.translator("openai")).toBeInstanceOf(OpenAITranslator);
    expect(registry.synthesizer("openai")).toBeInstanceOf(OpenAISpeechSynthesizer);
    expect(registry.translator("openai")).toBe(registry.translator("openai"));
  });

  it("uses an injected client without a key", async () => {
    const create = vi.fn().mockResolvedValue({
      status: "completed",
      model: "returned-model",
      output_text: "Hello.",
    });
    const registry = createProviderRegistry({ allowMock: false, openaiClient: { responses: { create } } });
    expect(registry.isConfigured("openai")).toBe(true);
    const result = await registry.translator("openai").translate({
      model: "configured-model",
      instruction: "Translate.",
      sourceText: "Moi.",
      sourceLanguage: "fi",
      targetLanguage: "en",
    });
    expect(result.text).toBe("Hello.");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns mock adapters only when allowMock is true", () => {
    const allowed = createProviderRegistry({ allowMock: true });
    expect(allowed.isConfigured("mock")).toBe(true);
    expect(allowed.listProviders()).toEqual(["openai", "mock"]);
    expect(allowed.transcriber("mock")).toBeInstanceOf(MockTranscriber);
    expect(allowed.translator("mock")).toBeInstanceOf(MockTranslator);
    expect(allowed.synthesizer("mock")).toBeInstanceOf(MockSpeechSynthesizer);
    // Same instance each time, so failure injection counts are kept.
    expect(allowed.translator("mock")).toBe(allowed.translator("mock"));

    const denied = createProviderRegistry({ openaiApiKey: "sk-test-not-a-real-key", allowMock: false });
    expect(codeOf(() => denied.transcriber("mock"))).toBe("CONFIGURATION_MISSING");
    expect(codeOf(() => denied.translator("mock"))).toBe("CONFIGURATION_MISSING");
    expect(codeOf(() => denied.synthesizer("mock"))).toBe("CONFIGURATION_MISSING");
  });

  it("throws a clear error for an unknown provider", () => {
    const registry = createProviderRegistry({ allowMock: true });
    try {
      registry.translator("seamless");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
      expect((error as AppError).message).toContain('"seamless"');
      expect((error as AppError).message).toContain("openai");
    }
  });

  it("accepts an extra provider that offers only some stages", () => {
    const localAsr: Transcriber = { transcribe: vi.fn() };
    const registry = createProviderRegistry({
      allowMock: false,
      extraProviders: [{ name: "local-asr", isConfigured: () => true, transcriber: () => localAsr }],
    });
    expect(registry.listProviders()).toEqual(["openai", "local-asr"]);
    expect(registry.transcriber("local-asr")).toBe(localAsr);
    expect(codeOf(() => registry.translator("local-asr"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() =>
      createProviderRegistry({ allowMock: false, extraProviders: [{ name: "openai", isConfigured: () => true }] }),
    )).toBe("VALIDATION_ERROR");
  });
});
