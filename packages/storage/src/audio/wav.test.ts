import { describe, expect, it } from "vitest";
import { buildWav, ffmpegInstalled, ffmpegSample, sineInput } from "../testing/audioSamples";
import { encodeWavPcm16, generateSineWav, isWavBuffer, parseWavHeader, WavParseError } from "./wav";

function parseError(buffer: Buffer): WavParseError {
  try {
    parseWavHeader(buffer);
  } catch (error) {
    if (error instanceof WavParseError) return error;
    throw error;
  }
  throw new Error("expected parseWavHeader to throw");
}

describe("parseWavHeader", () => {
  for (const sampleRateHz of [16000, 44100, 48000]) {
    for (const channels of [1, 2]) {
      it(`parses a generated ${sampleRateHz} Hz file with ${channels} channel(s)`, () => {
        const wav = generateSineWav({ durationMs: 500, sampleRateHz, frequencyHz: 440, channels });
        expect(parseWavHeader(wav)).toEqual({
          sampleRateHz,
          channels,
          bitDepth: 16,
          audioFormat: "pcm",
          dataBytes: (sampleRateHz / 2) * channels * 2,
          durationMs: 500,
          dataOffset: 44,
          blockAlign: channels * 2,
          frameCount: sampleRateHz / 2,
        });
      });
    }
  }

  it("skips LIST and fact chunks before the data chunk", () => {
    const data = Buffer.alloc(48000 * 2);
    const wav = buildWav({
      formatTag: 1,
      channels: 1,
      sampleRateHz: 48000,
      bitsPerSample: 16,
      data,
      chunksBeforeData: [
        // Odd length: checks that the padding byte is skipped.
        { id: "LIST", body: Buffer.from("INFOISFT\u0005\u0000\u0000\u0000Lavf\u0000", "latin1") },
        { id: "fact", body: Buffer.from([0x80, 0xbb, 0x00, 0x00]) },
      ],
      chunksAfterData: [{ id: "LIST", body: Buffer.from("trailing") }],
    });
    const info = parseWavHeader(wav);
    expect(info).toMatchObject({ sampleRateHz: 48000, channels: 1, bitDepth: 16, dataBytes: 96000, durationMs: 1000 });
    expect(wav.subarray(info.dataOffset - 8, info.dataOffset - 4).toString("latin1")).toBe("data");
  });

  it("parses 24 bit PCM", () => {
    const wav = buildWav({ formatTag: 1, channels: 2, sampleRateHz: 44100, bitsPerSample: 24, data: Buffer.alloc(44100 * 6) });
    expect(parseWavHeader(wav)).toMatchObject({ bitDepth: 24, audioFormat: "pcm", blockAlign: 6, durationMs: 1000 });
  });

  it("parses 32 bit IEEE float", () => {
    const wav = buildWav({ formatTag: 3, channels: 1, sampleRateHz: 48000, bitsPerSample: 32, data: Buffer.alloc(48000 * 4) });
    expect(parseWavHeader(wav)).toMatchObject({ bitDepth: 32, audioFormat: "ieee_float", durationMs: 1000 });
  });

  it("parses WAVE_FORMAT_EXTENSIBLE with PCM and with float sub-formats", () => {
    const pcm = buildWav({
      formatTag: 1,
      channels: 1,
      sampleRateHz: 48000,
      bitsPerSample: 32,
      data: Buffer.alloc(48000 * 4),
      extensible: { validBits: 24, subFormatTag: 1 },
    });
    expect(parseWavHeader(pcm)).toMatchObject({ audioFormat: "pcm", bitDepth: 24, blockAlign: 4, durationMs: 1000 });

    const float = buildWav({
      formatTag: 3,
      channels: 2,
      sampleRateHz: 44100,
      bitsPerSample: 32,
      data: Buffer.alloc(44100 * 8),
      extensible: { validBits: 32, subFormatTag: 3 },
    });
    expect(parseWavHeader(float)).toMatchObject({ audioFormat: "ieee_float", bitDepth: 32, channels: 2, durationMs: 1000 });
  });

  it("accepts a Uint8Array view", () => {
    const wav = generateSineWav({ durationMs: 100, sampleRateHz: 16000, frequencyHz: 440 });
    const padded = new Uint8Array(wav.length + 10);
    padded.set(wav, 10);
    expect(parseWavHeader(padded.subarray(10)).durationMs).toBe(100);
  });

  it("rejects a truncated file", () => {
    const wav = generateSineWav({ durationMs: 500, sampleRateHz: 16000, frequencyHz: 440 });
    expect(parseError(wav.subarray(0, wav.length - 1000)).reason).toBe("truncated");
    expect(parseError(wav.subarray(0, 40)).reason).toBe("missing_data_chunk");
    expect(parseError(wav.subarray(0, 30)).reason).toBe("bad_fmt_chunk");
    expect(parseError(wav.subarray(0, 8)).reason).toBe("too_short");
  });

  it("reads the declared size from a header prefix when headerOnly is set", () => {
    const wav = generateSineWav({ durationMs: 500, sampleRateHz: 16000, frequencyHz: 440 });
    expect(parseWavHeader(wav.subarray(0, 44), { headerOnly: true })).toMatchObject({ dataBytes: 16000, durationMs: 500 });
  });

  it("rejects input that is not a WAV file", () => {
    const error = parseError(Buffer.from("This is a text file renamed to .wav, not audio."));
    expect(error).toBeInstanceOf(WavParseError);
    expect(error.code).toBe("INVALID_AUDIO");
    expect(error.reason).toBe("not_wav");
    expect(parseError(Buffer.alloc(0)).reason).toBe("too_short");
  });

  it("rejects encodings other than PCM and IEEE float", () => {
    // Format tag 7 is mu-law.
    const wav = buildWav({ formatTag: 7, channels: 1, sampleRateHz: 8000, bitsPerSample: 8, data: Buffer.alloc(8000) });
    expect(parseError(wav).reason).toBe("unsupported_encoding");
  });

  it("rejects inconsistent format fields", () => {
    const good = generateSineWav({ durationMs: 100, sampleRateHz: 16000, frequencyHz: 440 });

    const zeroChannels = Buffer.from(good);
    zeroChannels.writeUInt16LE(0, 22);
    expect(parseError(zeroChannels).reason).toBe("bad_fmt_chunk");

    const zeroRate = Buffer.from(good);
    zeroRate.writeUInt32LE(0, 24);
    expect(parseError(zeroRate).reason).toBe("bad_fmt_chunk");

    const wrongBlockAlign = Buffer.from(good);
    wrongBlockAlign.writeUInt16LE(3, 32);
    expect(parseError(wrongBlockAlign).reason).toBe("bad_fmt_chunk");
  });

  it("rejects a data chunk that comes before the format chunk, and a file without one", () => {
    const body = Buffer.concat([Buffer.from("WAVEdata", "latin1"), Buffer.from([4, 0, 0, 0, 1, 2, 3, 4])]);
    const header = Buffer.alloc(8);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(body.length, 4);
    expect(parseError(Buffer.concat([header, body])).reason).toBe("missing_fmt_chunk");

    const empty = Buffer.concat([header, Buffer.from("WAVE", "latin1")]);
    expect(parseError(empty).reason).toBe("missing_fmt_chunk");
  });

  it.skipIf(!ffmpegInstalled())("parses WAV files written by ffmpeg (with a LIST chunk)", () => {
    const wav = ffmpegSample(sineInput(1, 44100), ["-c:a", "pcm_s24le", "-ac", "2"], "tone.wav");
    expect(wav.includes(Buffer.from("LIST"))).toBe(true);
    expect(parseWavHeader(wav)).toMatchObject({
      sampleRateHz: 44100,
      channels: 2,
      bitDepth: 24,
      audioFormat: "pcm",
      durationMs: 1000,
    });
  });
});

describe("isWavBuffer", () => {
  it("checks the RIFF and WAVE markers", () => {
    expect(isWavBuffer(generateSineWav({ durationMs: 10, sampleRateHz: 16000, frequencyHz: 440 }))).toBe(true);
    expect(isWavBuffer(Buffer.from("RIFF1234AVI LIST"))).toBe(false);
    expect(isWavBuffer(Buffer.from("RIFF"))).toBe(false);
  });
});

describe("encodeWavPcm16", () => {
  it("writes a 44 byte header and little-endian 16 bit samples", () => {
    const wav = encodeWavPcm16({ samples: new Float32Array([0, 1, -1, 0.5]), sampleRateHz: 16000, channels: 1 });
    expect(wav.length).toBe(44 + 8);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48), wav.readInt16LE(50)]).toEqual([
      0, 32767, -32768, 16384,
    ]);
  });

  it("limits values outside the range and treats NaN as silence", () => {
    const wav = encodeWavPcm16({ samples: new Float32Array([2, -3, Number.NaN]), sampleRateHz: 16000, channels: 1 });
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([32767, -32768, 0]);
  });

  it("rejects a sample count that does not fit the channel count, and bad parameters", () => {
    const invalid = expect.objectContaining({ code: "VALIDATION_ERROR" });
    expect(() => encodeWavPcm16({ samples: new Float32Array(3), sampleRateHz: 16000, channels: 2 })).toThrowError(invalid);
    expect(() => encodeWavPcm16({ samples: new Float32Array(2), sampleRateHz: 0, channels: 1 })).toThrowError(invalid);
    expect(() => encodeWavPcm16({ samples: new Float32Array(2), sampleRateHz: 16000, channels: 0 })).toThrowError(invalid);
  });
});

describe("generateSineWav", () => {
  it("produces the requested duration, rate and amplitude", () => {
    const wav = generateSineWav({ durationMs: 250, sampleRateHz: 48000, frequencyHz: 1000, amplitude: 0.25 });
    const info = parseWavHeader(wav);
    expect(info).toMatchObject({ sampleRateHz: 48000, channels: 1, frameCount: 12000, durationMs: 250 });
    let peak = 0;
    for (let offset = info.dataOffset; offset < wav.length; offset += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    }
    expect(peak / 32768).toBeCloseTo(0.25, 2);
  });

  it("is deterministic and writes the same value to every channel", () => {
    const input = { durationMs: 50, sampleRateHz: 16000, frequencyHz: 440, channels: 2 };
    const wav = generateSineWav(input);
    expect(generateSineWav(input).equals(wav)).toBe(true);
    for (let frame = 0; frame < 800; frame += 1) {
      expect(wav.readInt16LE(44 + frame * 4)).toBe(wav.readInt16LE(44 + frame * 4 + 2));
    }
  });

  it("returns a header-only file for zero duration", () => {
    const wav = generateSineWav({ durationMs: 0, sampleRateHz: 16000, frequencyHz: 440 });
    expect(wav.length).toBe(44);
    expect(parseWavHeader(wav)).toMatchObject({ dataBytes: 0, durationMs: 0, frameCount: 0 });
  });
});
