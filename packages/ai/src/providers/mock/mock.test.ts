import { describe, expect, it } from "vitest";
import type { AppError } from "@dialect/domain";
import { AiProviderError, isRetryableAiError } from "../../errors";
import { MockSpeechSynthesizer, MockTranscriber, MockTranslator } from "./adapters";

const MODEL = "any-configured-model";

const DEFAULT_PROMPT = "Translate the following Finnish utterance into natural spoken English.";
const PRESERVATION_PROMPT = "Translate this Finnish utterance. Preserve register and stance.";

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw.");
}

describe("MockTranscriber", () => {
  const input = { audio: Buffer.from("audio one"), fileName: "a.wav", mimeType: "audio/wav", model: MODEL, language: "fi" };

  it("is deterministic for the same audio and differs for other audio", async () => {
    const first = await new MockTranscriber().transcribe(input);
    const second = await new MockTranscriber().transcribe(input);
    const other = await new MockTranscriber().transcribe({ ...input, audio: Buffer.from("audio two") });
    expect(first.text).toBe(second.text);
    expect(first.segments).toEqual(second.segments);
    expect(first.providerRequestId).toBe(second.providerRequestId);
    expect(other.text).not.toBe(first.text);
  });

  it("is recognizable as mock output and records the mock provider", async () => {
    const result = await new MockTranscriber().transcribe(input);
    expect(result.text.startsWith("[mock-transkriptio ")).toBe(true);
    expect(result.provider).toBe("mock");
    expect(result.requestedModel).toBe(MODEL);
    expect(result.returnedModel).toBe("mock");
    expect(result.segments?.length).toBeGreaterThan(1);
    expect(result.segments?.map((s) => s.text).join(" ")).toBe(result.text);
    expect(result.parametersSent).toMatchObject({ model: MODEL, language: "fi" });
  });

  it("returns the configured mockText", async () => {
    const result = await new MockTranscriber().transcribe({ ...input, parameters: { mockText: "Mää oon tääl." } });
    expect(result.text).toBe("Mää oon tääl.");
    expect(result.provider).toBe("mock");
  });
});

describe("MockTranslator", () => {
  const input = { model: MODEL, instruction: DEFAULT_PROMPT, sourceText: "Mää oon tääl.", sourceLanguage: "fi", targetLanguage: "en" };

  it("is deterministic and includes the source text", async () => {
    const first = await new MockTranslator().translate(input);
    const second = await new MockTranslator().translate(input);
    expect(first.text).toBe(second.text);
    expect(first.rawText).toBe(first.text);
    expect(first.text.startsWith("[mock translation ")).toBe(true);
    expect(first.text.endsWith("Mää oon tääl.")).toBe(true);
    expect(first.provider).toBe("mock");
    expect(first.returnedModel).toBe("mock");
  });

  it("gives different outputs for different instructions", async () => {
    const translator = new MockTranslator();
    const byDefault = await translator.translate(input);
    const preserving = await translator.translate({ ...input, instruction: PRESERVATION_PROMPT });
    expect(byDefault.text).not.toBe(preserving.text);
  });
});

describe("MockSpeechSynthesizer", () => {
  const input = { model: MODEL, text: "Well, I don't really know.", voice: "voice-a" };

  it("returns a valid 16-bit mono PCM WAV", async () => {
    const result = await new MockSpeechSynthesizer().synthesize(input);
    const wav = result.audio;
    expect(result.format).toBe("wav");
    expect(result.mimeType).toBe("audio/wav");
    expect(result.provider).toBe("mock");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(wav.length).toBeGreaterThan(44 + 1000);
    expect(wav.length).toBeLessThan(44 + 2 * 32_000 + 1);
    // The tone is not silence.
    let peak = 0;
    for (let offset = 44; offset < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    expect(peak).toBeGreaterThan(1000);
  });

  it("is deterministic and depends on the text", async () => {
    const first = await new MockSpeechSynthesizer().synthesize(input);
    const second = await new MockSpeechSynthesizer().synthesize(input);
    const other = await new MockSpeechSynthesizer().synthesize({ ...input, text: "Something else entirely, and longer." });
    expect(first.audio.equals(second.audio)).toBe(true);
    expect(other.audio.equals(first.audio)).toBe(false);
  });

  it("supports only wav", async () => {
    const error = await caught(() => new MockSpeechSynthesizer().synthesize({ ...input, outputFormat: "mp3" }));
    expect((error as AppError).code).toBe("VALIDATION_ERROR");
  });
});

describe("mock failure injection", () => {
  const translation = { model: MODEL, instruction: DEFAULT_PROMPT, sourceText: "Moi.", sourceLanguage: "fi", targetLanguage: "en" };

  it("fails retryably N times for the same input, then succeeds", async () => {
    const translator = new MockTranslator();
    const input = { ...translation, parameters: { mockFail: "retryable", mockFailTimes: 2 } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = (await caught(() => translator.translate(input))) as AiProviderError;
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error.code).toBe("TRANSLATION_PROVIDER_ERROR");
      expect(error.provider).toBe("mock");
      expect(error.retryable).toBe(true);
      expect(isRetryableAiError(error)).toBe(true);
    }
    const result = await translator.translate(input);
    expect(result.text).toContain("Moi.");
    // Another input has its own count.
    const otherError = await caught(() => translator.translate({ ...input, sourceText: "Hei." }));
    expect(otherError).toBeInstanceOf(AiProviderError);
  });

  it("fails on every call when mockFailTimes is not set", async () => {
    const transcriber = new MockTranscriber();
    const input = { audio: Buffer.from("x"), fileName: "a.wav", mimeType: "audio/wav", model: MODEL, parameters: { mockFail: "retryable" } };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = (await caught(() => transcriber.transcribe(input))) as AiProviderError;
      expect(error.code).toBe("ASR_PROVIDER_ERROR");
      expect(error.retryable).toBe(true);
    }
  });

  it("fails permanently with retryable false", async () => {
    const error = (await caught(() =>
      new MockSpeechSynthesizer().synthesize({ model: MODEL, text: "Hi.", voice: "v", parameters: { mockFail: "permanent" } }),
    )) as AiProviderError;
    expect(error.code).toBe("TTS_PROVIDER_ERROR");
    expect(error.retryable).toBe(false);
    expect(isRetryableAiError(error)).toBe(false);
  });

  it("rejects an invalid mockFail value", async () => {
    const error = await caught(() => new MockTranslator().translate({ ...translation, parameters: { mockFail: "sometimes" } }));
    expect((error as AppError).code).toBe("VALIDATION_ERROR");
    expect(isRetryableAiError(error)).toBe(false);
  });
});
