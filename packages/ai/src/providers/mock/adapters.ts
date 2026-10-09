import { validationError } from "../../errors";
import {
  SYNTHESIS_MIME_TYPES,
  type ProvenanceFields,
  type SpeechSynthesizer,
  type SynthesisInput,
  type SynthesisResult,
  type Transcriber,
  type TranscriptionInput,
  type TranscriptionResult,
  type TranscriptionSegment,
  type TranslationInput,
  type TranslationResult,
  type Translator,
} from "../../types";
import { MOCK_PROVIDER, MockFailureInjector, mockRequestId, mockTextParameter, sha256Hex } from "./shared";
import { sineWav } from "./wav";

// Deterministic adapters for unit tests, end-to-end tests and local development
// without an API key. They never call a network service.
//
// Every output is recognizable as mock output: texts start with a "[mock ...]"
// marker (unless `mockText` sets the text), the audio is a plain sine tone, the
// provider is "mock" and the returned model is "mock". A mock run can therefore
// not be mistaken for real model output.

export const MOCK_RETURNED_MODEL = "mock";

const FINNISH_WORDS = [
  "tämä", "on", "testilause", "ja", "minä", "puhun", "nyt", "vähän", "aikaa", "sitten",
  "kotona", "oli", "hiljaista", "mutta", "ulkona", "satoi", "koko", "päivän", "eikä",
  "kukaan", "tiennyt", "mitä", "seuraavaksi", "tapahtuu", "kyllä", "se", "siitä", "selviää",
];

function provenance(
  stage: "asr" | "translation" | "tts",
  inputKey: string,
  model: string,
  parameters: Record<string, unknown>,
  startedAt: Date,
  t0: number,
): ProvenanceFields {
  return {
    provider: MOCK_PROVIDER,
    requestedModel: model,
    returnedModel: MOCK_RETURNED_MODEL,
    providerRequestId: mockRequestId(stage, inputKey),
    parametersSent: parameters,
    latencyMs: Math.round(performance.now() - t0),
    rawMetadata: { mock: true, inputKey },
    startedAt,
    finishedAt: new Date(),
  };
}

// Builds a Finnish-looking sentence list from a hash. The words are real Finnish
// words in a meaningless order.
function finnishSentences(hash: string): string[] {
  const bytes = Buffer.from(hash, "hex");
  const sentenceCount = 2 + ((bytes[0] ?? 0) % 2);
  const sentences: string[] = [];
  let cursor = 1;
  for (let s = 0; s < sentenceCount; s += 1) {
    const wordCount = 4 + ((bytes[cursor] ?? 0) % 4);
    cursor += 1;
    const words: string[] = [];
    for (let w = 0; w < wordCount; w += 1) {
      const index = (bytes[cursor % bytes.length] ?? 0) % FINNISH_WORDS.length;
      words.push(FINNISH_WORDS[index] ?? "ja");
      cursor += 1;
    }
    const sentence = words.join(" ");
    sentences.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  return sentences;
}

export class MockTranscriber implements Transcriber {
  private readonly failures = new MockFailureInjector();

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const startedAt = new Date();
    const t0 = performance.now();
    const audioHash = sha256Hex(input.audio);
    const configured = mockTextParameter(input.parameters);
    this.failures.check("asr", audioHash, input.parameters);

    const parameters: Record<string, unknown> = {
      model: input.model,
      ...(input.language ? { language: input.language } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...input.parameters,
    };

    let text: string;
    let segments: TranscriptionSegment[];
    if (configured !== undefined) {
      text = configured;
      segments = [{ id: 0, start: 0, end: 1, text: configured }];
    } else {
      const marker = `[mock-transkriptio ${audioHash.slice(0, 8)}]`;
      const parts = [marker, ...finnishSentences(audioHash)];
      text = parts.join(" ");
      // Invented but deterministic timestamps: 1.5 seconds per part.
      segments = parts.map((part, index) => ({ id: index, start: index * 1.5, end: (index + 1) * 1.5, text: part }));
    }

    return {
      text,
      segments,
      detectedLanguage: input.language,
      usage: { audioSeconds: segments.length * 1.5, raw: { mock: true } },
      ...provenance("asr", audioHash, input.model, parameters, startedAt, t0),
    };
  }
}

export class MockTranslator implements Translator {
  private readonly failures = new MockFailureInjector();

  async translate(input: TranslationInput): Promise<TranslationResult> {
    const startedAt = new Date();
    const t0 = performance.now();
    if (input.sourceText.trim().length === 0) {
      throw validationError("Mock translation: the source text is empty.");
    }
    const instructionHash = sha256Hex(input.instruction).slice(0, 8);
    const inputKey = sha256Hex(`${input.model}\n${input.instruction}\n${input.sourceText}`);
    const configured = mockTextParameter(input.parameters);
    this.failures.check("translation", inputKey, input.parameters);

    // The instruction hash differs between prompt versions, so the outputs of
    // the default and the preservation condition can be told apart.
    const text =
      configured ??
      `[mock translation ${instructionHash} ${input.sourceLanguage}>${input.targetLanguage}] ${input.sourceText}`;

    return {
      text,
      rawText: text,
      usage: {
        inputTokens: input.instruction.length + input.sourceText.length,
        outputTokens: text.length,
        totalTokens: input.instruction.length + input.sourceText.length + text.length,
        raw: { mock: true, unit: "characters counted as tokens" },
      },
      ...provenance(
        "translation",
        inputKey,
        input.model,
        { model: input.model, ...input.parameters },
        startedAt,
        t0,
      ),
    };
  }
}

export class MockSpeechSynthesizer implements SpeechSynthesizer {
  private readonly failures = new MockFailureInjector();

  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    const startedAt = new Date();
    const t0 = performance.now();
    const format = input.outputFormat ?? "wav";
    if (format !== "wav") {
      throw validationError(`Mock speech: only the "wav" output format is supported, got "${format}".`);
    }
    if (input.text.length === 0) {
      throw validationError("Mock speech: the text to speak is empty.");
    }
    const inputKey = sha256Hex(`${input.model}\n${input.voice}\n${input.instructions ?? ""}\n${input.text}`);
    this.failures.check("tts", inputKey, input.parameters);

    // A sine tone. Pitch depends on the input hash, length on the text length
    // (0.3 seconds plus 10 ms per character, at most 2 seconds).
    const hashByte = Number.parseInt(inputKey.slice(0, 2), 16);
    const frequencyHz = 220 + hashByte * 2;
    const durationSeconds = Math.min(2, 0.3 + input.text.length * 0.01);
    const audio = sineWav({ frequencyHz, durationSeconds, sampleRate: 16_000 });

    return {
      audio,
      mimeType: SYNTHESIS_MIME_TYPES.wav,
      format: "wav",
      usage: { inputCharacters: input.text.length, raw: { mock: true } },
      ...provenance(
        "tts",
        inputKey,
        input.model,
        {
          model: input.model,
          voice: input.voice,
          response_format: format,
          ...(input.instructions ? { instructions: input.instructions } : {}),
          ...input.parameters,
        },
        startedAt,
        t0,
      ),
    };
  }
}
