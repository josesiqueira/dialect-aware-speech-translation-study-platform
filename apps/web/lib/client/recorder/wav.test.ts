// @vitest-environment node
import { parseWavHeader } from "@dialect/storage";
import { describe, expect, it } from "vitest";
import {
  buildWavHeader,
  concatBytes,
  convertBlock,
  durationMsFromFrames,
  encodeWavMono,
  floatToPcmSample,
  maxFramesForDuration,
  PcmChunkCollector,
  WAV_HEADER_BYTES,
} from "./wav";

function sine(frames: number, sampleRateHz: number, frequencyHz = 440, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRateHz);
  return samples;
}

function readInt24LE(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  return value & 0x800000 ? value - 0x1000000 : value;
}

describe("floatToPcmSample", () => {
  it("scales by 2^15 for 16 bit and limits only at full scale", () => {
    expect(floatToPcmSample(0, 16)).toBe(0);
    expect(floatToPcmSample(0.5, 16)).toBe(16384);
    expect(floatToPcmSample(-0.5, 16)).toBe(-16384);
    expect(floatToPcmSample(-1, 16)).toBe(-32768);
    expect(floatToPcmSample(1, 16)).toBe(32767);
    expect(floatToPcmSample(1.7, 16)).toBe(32767);
    expect(floatToPcmSample(-1.7, 16)).toBe(-32768);
    expect(floatToPcmSample(Number.POSITIVE_INFINITY, 16)).toBe(32767);
    expect(floatToPcmSample(Number.NEGATIVE_INFINITY, 16)).toBe(-32768);
    expect(floatToPcmSample(Number.NaN, 16)).toBe(0);
  });

  it("rounds to the nearest step", () => {
    expect(floatToPcmSample(1 / 32768, 16)).toBe(1);
    expect(floatToPcmSample(0.4 / 32768, 16)).toBe(0);
    expect(floatToPcmSample(0.6 / 32768, 16)).toBe(1);
    expect(floatToPcmSample(-0.6 / 32768, 16)).toBe(-1);
    expect(floatToPcmSample(32766.6 / 32768, 16)).toBe(32767);
  });

  it("scales by 2^23 for 24 bit", () => {
    expect(floatToPcmSample(0.5, 24)).toBe(4194304);
    expect(floatToPcmSample(-1, 24)).toBe(-8388608);
    expect(floatToPcmSample(1, 24)).toBe(8388607);
    expect(floatToPcmSample(2, 24)).toBe(8388607);
    expect(floatToPcmSample(-2, 24)).toBe(-8388608);
  });
});

describe("convertBlock", () => {
  it("writes little-endian 16 bit samples and reports peak and clipped samples", () => {
    const block = convertBlock(new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -0.25]), 16);
    const view = new DataView(block.bytes.buffer);
    expect(block.bytes.length).toBe(14);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => view.getInt16(i * 2, true))).toEqual([
      0, 16384, -16384, 32767, -32768, 32767, -8192,
    ]);
    expect(block.peak).toBe(1.5);
    expect(block.clippedSamples).toBe(3);
  });

  it("writes little-endian 24 bit samples", () => {
    const block = convertBlock(new Float32Array([0.5, -0.5, 1, -1, -1 / 8388608]), 24);
    expect(block.bytes.length).toBe(15);
    expect([0, 1, 2, 3, 4].map((i) => readInt24LE(block.bytes, i * 3))).toEqual([4194304, -4194304, 8388607, -8388608, -1]);
  });

  it("does not change the level of the signal (no gain, no normalization)", () => {
    const quiet = convertBlock(new Float32Array([0.01, -0.01]), 16);
    const view = new DataView(quiet.bytes.buffer);
    expect(view.getInt16(0, true)).toBe(328);
    expect(view.getInt16(2, true)).toBe(-328);
    expect(quiet.peak).toBeCloseTo(0.01, 6);
  });
});

describe("buildWavHeader", () => {
  it("writes exact sizes", () => {
    const header = buildWavHeader({ sampleRateHz: 48000, channels: 1, bitDepth: 16, dataBytes: 9600 });
    const view = new DataView(header.buffer);
    expect(header.length).toBe(WAV_HEADER_BYTES);
    expect(view.getUint32(4, true)).toBe(36 + 9600);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(96000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(9600);
  });

  it("rejects a data size that is not a whole number of frames, and a fractional rate", () => {
    expect(() => buildWavHeader({ sampleRateHz: 48000, channels: 1, bitDepth: 16, dataBytes: 3 })).toThrow(RangeError);
    expect(() => buildWavHeader({ sampleRateHz: 48000, channels: 1, bitDepth: 24, dataBytes: 4 })).toThrow(RangeError);
    expect(() => buildWavHeader({ sampleRateHz: 44100.5, channels: 1, bitDepth: 16, dataBytes: 4 })).toThrow(RangeError);
  });
});

describe("the server's strict WAV parser accepts the encoder output", () => {
  it("0.1 second, 16 bit, 48 kHz", () => {
    const wav = encodeWavMono(sine(4800, 48000), 48000, 16);
    const info = parseWavHeader(wav);
    expect(wav.length).toBe(44 + 9600);
    expect(info).toMatchObject({
      sampleRateHz: 48000,
      channels: 1,
      bitDepth: 16,
      audioFormat: "pcm",
      dataBytes: 9600,
      dataOffset: 44,
      blockAlign: 2,
      frameCount: 4800,
    });
    expect(info.durationMs).toBeCloseTo(100, 6);
  });

  it("0.1 second, 24 bit, 44.1 kHz", () => {
    const wav = encodeWavMono(sine(4410, 44100), 44100, 24);
    const info = parseWavHeader(wav);
    expect(info).toMatchObject({ sampleRateHz: 44100, channels: 1, bitDepth: 24, dataBytes: 13230, blockAlign: 3, frameCount: 4410 });
    expect(info.durationMs).toBeCloseTo(100, 6);
  });

  it("three minutes collected in worklet-sized chunks", () => {
    const sampleRateHz = 48000;
    const totalFrames = sampleRateHz * 180;
    const collector = new PcmChunkCollector({ sampleRateHz, bitDepth: 16, maxFrames: totalFrames + 1000 });
    const chunk = sine(2048, sampleRateHz);
    let remaining = totalFrames;
    while (remaining > 0) {
      const count = Math.min(remaining, chunk.length);
      collector.append(count === chunk.length ? chunk : chunk.subarray(0, count));
      remaining -= count;
    }
    const parts = collector.toWavParts();
    // One header part plus one part per chunk: nothing was merged or copied while recording.
    expect(parts.length).toBe(1 + Math.ceil(totalFrames / 2048));
    const wav = concatBytes(parts);
    const info = parseWavHeader(wav);
    expect(wav.length).toBe(44 + totalFrames * 2);
    expect(info.frameCount).toBe(totalFrames);
    expect(info.dataBytes).toBe(totalFrames * 2);
    expect(info.durationMs).toBe(180_000);
    expect(collector.durationMs).toBe(180_000);
  });

  it("the header carries the rate it was given, whatever that rate is", () => {
    for (const rate of [16000, 44100, 48000, 96000]) {
      expect(parseWavHeader(encodeWavMono(sine(rate / 10, rate), rate)).sampleRateHz).toBe(rate);
    }
  });

  it("a truncated file is rejected by the server parser (the reason sizes must be exact)", () => {
    const wav = encodeWavMono(sine(4800, 48000), 48000);
    expect(() => parseWavHeader(wav.subarray(0, wav.length - 100))).toThrow();
  });
});

describe("PcmChunkCollector", () => {
  it("assembles chunks in order", () => {
    const collector = new PcmChunkCollector({ sampleRateHz: 8000, bitDepth: 16, maxFrames: 100 });
    collector.append(new Float32Array([0.25, 0.5]));
    collector.append(new Float32Array([-0.25]));
    collector.append(new Float32Array([-0.5, 0.75]));
    const wav = collector.toWavBytes();
    const view = new DataView(wav.buffer, 44);
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(i * 2, true))).toEqual([8192, 16384, -8192, -16384, 24576]);
    expect(collector.frames).toBe(5);
    expect(collector.peak).toBe(0.75);
    expect(collector.dataBytes).toBe(10);
  });

  it("does not keep a reference to the caller's buffer", () => {
    const collector = new PcmChunkCollector({ sampleRateHz: 8000, bitDepth: 16, maxFrames: 100 });
    const input = new Float32Array([0.5]);
    collector.append(input);
    input[0] = -0.5;
    expect(new DataView(collector.toWavBytes().buffer, 44).getInt16(0, true)).toBe(16384);
  });

  it("stops exactly at the maximum duration and reports the limit", () => {
    const sampleRateHz = 48000;
    const maxFrames = maxFramesForDuration(1000, sampleRateHz);
    const collector = new PcmChunkCollector({ sampleRateHz, bitDepth: 16, maxFrames });
    const chunk = new Float32Array(2048).fill(0.1);
    let result = collector.append(chunk);
    let appended = 1;
    while (!result.limitReached) {
      result = collector.append(chunk);
      appended += 1;
    }
    expect(appended).toBe(Math.ceil(48000 / 2048));
    expect(result.acceptedFrames).toBe(48000 - 2048 * (appended - 1));
    expect(collector.frames).toBe(48000);
    expect(collector.durationMs).toBe(1000);
    expect(collector.limitReached).toBe(true);
    // Later blocks are ignored.
    expect(collector.append(chunk)).toEqual({ acceptedFrames: 0, peak: 0, limitReached: true });
    expect(collector.frames).toBe(48000);
    expect(parseWavHeader(collector.toWavBytes()).durationMs).toBe(1000);
  });

  it("clear drops the audio", () => {
    const collector = new PcmChunkCollector({ sampleRateHz: 8000, bitDepth: 16, maxFrames: 100 });
    collector.append(new Float32Array([1, 1]));
    collector.clear();
    expect(collector.frames).toBe(0);
    expect(collector.peak).toBe(0);
    expect(collector.clippedSamples).toBe(0);
    expect(collector.toWavBytes().length).toBe(44);
  });
});

describe("duration from sample counts", () => {
  it("durationMsFromFrames", () => {
    expect(durationMsFromFrames(48000, 48000)).toBe(1000);
    expect(durationMsFromFrames(4410, 44100)).toBeCloseTo(100, 9);
    expect(durationMsFromFrames(0, 48000)).toBe(0);
    expect(durationMsFromFrames(24000, 16000)).toBe(1500);
  });

  it("maxFramesForDuration rounds down to whole frames", () => {
    expect(maxFramesForDuration(1000, 48000)).toBe(48000);
    expect(maxFramesForDuration(120_000, 44100)).toBe(5_292_000);
    expect(maxFramesForDuration(1, 44100)).toBe(44);
  });
});
