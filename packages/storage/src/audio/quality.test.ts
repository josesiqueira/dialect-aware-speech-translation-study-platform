import { describe, expect, it } from "vitest";
import { buildWav } from "../testing/audioSamples";
import { computeWavQuality, RMS_FLOOR_DB } from "./quality";
import { encodeWavPcm16, generateSineWav, WavParseError } from "./wav";

describe("computeWavQuality", () => {
  it("reports a normal recording without warnings", () => {
    const wav = generateSineWav({ durationMs: 1000, sampleRateHz: 48000, frequencyHz: 440, amplitude: 0.5 });
    const quality = computeWavQuality(wav);
    expect(quality.peakAmplitude).toBeCloseTo(0.5, 3);
    expect(quality.clippedSampleRatio).toBe(0);
    expect(quality.silenceRatio).toBe(0);
    // A sine at amplitude 0.5 has RMS 0.5 / sqrt(2), about -9.03 dBFS.
    expect(quality.rmsDb).toBeCloseTo(-9.03, 1);
    expect(quality.warnings).toEqual([]);
  });

  it("flags digital silence", () => {
    const wav = encodeWavPcm16({ samples: new Float32Array(16000), sampleRateHz: 16000, channels: 1 });
    expect(computeWavQuality(wav)).toEqual({
      peakAmplitude: 0,
      clippedSampleRatio: 0,
      silenceRatio: 1,
      rmsDb: RMS_FLOOR_DB,
      warnings: ["low_signal", "mostly_silent"],
    });
  });

  it("flags a very quiet recording as low signal", () => {
    const wav = generateSineWav({ durationMs: 500, sampleRateHz: 16000, frequencyHz: 440, amplitude: 0.005 });
    const quality = computeWavQuality(wav);
    expect(quality.rmsDb).toBeLessThan(-40);
    expect(quality.warnings).toContain("low_signal");
    expect(quality.warnings).not.toContain("possible_clipping");
  });

  it("flags clipping", () => {
    // A sine driven to three times full scale is flat at the limits most of the time.
    const samples = new Float32Array(48000);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = 3 * Math.sin((2 * Math.PI * 440 * index) / 48000);
    }
    const quality = computeWavQuality(encodeWavPcm16({ samples, sampleRateHz: 48000, channels: 1 }));
    expect(quality.peakAmplitude).toBe(1);
    expect(quality.clippedSampleRatio).toBeGreaterThan(0.5);
    expect(quality.warnings).toEqual(["possible_clipping"]);
  });

  it("measures the share of silent windows", () => {
    // First half tone, second half silence.
    const samples = new Float32Array(32000);
    for (let index = 0; index < 16000; index += 1) {
      samples[index] = 0.5 * Math.sin((2 * Math.PI * 440 * index) / 16000);
    }
    const quality = computeWavQuality(encodeWavPcm16({ samples, sampleRateHz: 16000, channels: 1 }));
    expect(quality.silenceRatio).toBeCloseTo(0.5, 2);
    expect(quality.warnings).toEqual([]);
  });

  it("reads 24 bit and 32 bit PCM", () => {
    const pcm24 = Buffer.alloc(3 * 4);
    pcm24.writeIntLE(4194304, 0, 3); // 0.5
    pcm24.writeIntLE(-4194304, 3, 3);
    pcm24.writeIntLE(8388607, 6, 3); // positive full scale
    pcm24.writeIntLE(0, 9, 3);
    const quality24 = computeWavQuality(buildWav({ formatTag: 1, channels: 1, sampleRateHz: 48000, bitsPerSample: 24, data: pcm24 }));
    expect(quality24.peakAmplitude).toBeCloseTo(1, 5);
    expect(quality24.clippedSampleRatio).toBe(0.25);

    const pcm32 = Buffer.alloc(4 * 2);
    pcm32.writeInt32LE(1073741824, 0); // 0.5
    pcm32.writeInt32LE(-2147483648, 4); // negative full scale
    const quality32 = computeWavQuality(buildWav({ formatTag: 1, channels: 2, sampleRateHz: 48000, bitsPerSample: 32, data: pcm32 }));
    expect(quality32.peakAmplitude).toBe(1);
    expect(quality32.clippedSampleRatio).toBe(0.5);
  });

  it("reads 32 bit float, where values at or beyond 1.0 count as clipped", () => {
    const data = Buffer.alloc(4 * 4);
    data.writeFloatLE(0.25, 0);
    data.writeFloatLE(-0.25, 4);
    data.writeFloatLE(1.5, 8);
    data.writeFloatLE(0.99, 12);
    const quality = computeWavQuality(buildWav({ formatTag: 3, channels: 1, sampleRateHz: 48000, bitsPerSample: 32, data }));
    expect(quality.peakAmplitude).toBe(1.5);
    expect(quality.clippedSampleRatio).toBe(0.25);
    expect(quality.warnings).toContain("possible_clipping");
  });

  it("returns only a warning for sample formats it does not read", () => {
    const pcm8 = buildWav({ formatTag: 1, channels: 1, sampleRateHz: 8000, bitsPerSample: 8, data: Buffer.alloc(8000, 128) });
    expect(computeWavQuality(pcm8)).toEqual({ warnings: ["unsupported_sample_format"] });
    const float64 = buildWav({ formatTag: 3, channels: 1, sampleRateHz: 8000, bitsPerSample: 64, data: Buffer.alloc(800) });
    expect(computeWavQuality(float64)).toEqual({ warnings: ["unsupported_sample_format"] });
  });

  it("returns only a warning for a file without samples", () => {
    const wav = generateSineWav({ durationMs: 0, sampleRateHz: 16000, frequencyHz: 440 });
    expect(computeWavQuality(wav)).toEqual({ warnings: ["no_audio_data"] });
  });

  it("does not change the input and produces JSON-safe numbers", () => {
    const wav = generateSineWav({ durationMs: 200, sampleRateHz: 16000, frequencyHz: 440 });
    const copy = Buffer.from(wav);
    const quality = computeWavQuality(wav);
    expect(wav.equals(copy)).toBe(true);
    expect(JSON.parse(JSON.stringify(quality))).toEqual(quality);
  });

  it("throws WavParseError for input that is not a WAV file", () => {
    expect(() => computeWavQuality(Buffer.from("not a wav file at all"))).toThrowError(WavParseError);
  });
});
