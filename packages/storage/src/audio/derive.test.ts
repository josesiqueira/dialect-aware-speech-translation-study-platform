import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sha256OfBuffer } from "../hashing";
import { FFMPEG_MISSING_MESSAGE, ffmpegInstalled, ffmpegSample, sineInput } from "../testing/audioSamples";
import { deriveCanonicalWav } from "./derive";
import { ffmpegAvailable, probeAudio } from "./ffmpeg";
import { parseWavHeader } from "./wav";

const hasFfmpeg = ffmpegInstalled();
if (!hasFfmpeg) console.warn(FFMPEG_MISSING_MESSAGE);

describe.skipIf(!hasFfmpeg)("deriveCanonicalWav", () => {
  it("decodes WebM Opus to PCM WAV and keeps the sample rate and channel count", async () => {
    const source = ffmpegSample(sineInput(1), ["-c:a", "libopus", "-ac", "2"], "rec.webm");
    const sourceProbe = await probeAudio(source);
    const sourceHash = sha256OfBuffer(source);

    const derived = await deriveCanonicalWav({ data: source });
    if (derived.kind !== "buffer") throw new Error("expected a buffer result");

    const header = parseWavHeader(derived.data);
    expect(header).toEqual(derived.wav);
    expect(header.audioFormat).toBe("pcm");
    expect(header.bitDepth).toBe(16);
    expect(header.sampleRateHz).toBe(sourceProbe.sampleRateHz);
    expect(header.channels).toBe(2);
    expect(header.durationMs).toBeGreaterThan(950);
    expect(header.durationMs).toBeLessThan(1100);
    expect(derived.sizeBytes).toBe(derived.data.length);
    // The source bytes are untouched.
    expect(sha256OfBuffer(source)).toBe(sourceHash);
  });

  it("fills the derivation provenance", async () => {
    const source = ffmpegSample(sineInput(1), ["-c:a", "libopus"], "rec.webm");
    const before = Date.now();
    const derived = await deriveCanonicalWav({ data: source });
    const { provenance } = derived;

    expect(provenance.tool).toBe("ffmpeg");
    expect(provenance.toolVersion).toBe((await ffmpegAvailable()).ffmpegVersion);
    expect(provenance.command.startsWith("ffmpeg ")).toBe(true);
    expect(provenance.command).toContain("-i <input>");
    expect(provenance.command).toContain("-c:a pcm_s16le");
    expect(provenance.command.endsWith("<output>")).toBe(true);
    // No resampling or channel mixing unless asked for.
    expect(provenance.command).not.toContain("-ar ");
    expect(provenance.command).not.toContain("-ac ");
    expect(Date.parse(provenance.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(provenance.createdAt)).toBeLessThanOrEqual(Date.now());
    expect(provenance.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("gives the same bytes for the same input", async () => {
    const source = ffmpegSample(sineInput(1), ["-c:a", "libopus"], "rec.webm");
    const first = await deriveCanonicalWav({ data: source });
    const second = await deriveCanonicalWav({ data: source });
    if (first.kind !== "buffer" || second.kind !== "buffer") throw new Error("expected buffer results");
    expect(sha256OfBuffer(first.data)).toBe(sha256OfBuffer(second.data));
    // No encoder tag chunk: the header is the plain 44 bytes.
    expect(first.wav.dataOffset).toBe(44);
  });

  it("keeps 44.1 kHz from an MP4 AAC source", async () => {
    const source = ffmpegSample(sineInput(1, 44100), ["-c:a", "aac"], "rec.mp4");
    const derived = await deriveCanonicalWav({ data: source });
    expect(derived.wav).toMatchObject({ sampleRateHz: 44100, channels: 1, bitDepth: 16 });
  });

  it("resamples, mixes and changes bit depth only when asked, and records it", async () => {
    const source = ffmpegSample(sineInput(1), ["-c:a", "libopus", "-ac", "2"], "rec.webm");
    const derived = await deriveCanonicalWav({ data: source, sampleRateHz: 16000, channels: 1, bitDepth: 24 });
    expect(derived.wav).toMatchObject({ sampleRateHz: 16000, channels: 1, bitDepth: 24 });
    expect(derived.provenance.command).toContain("-ar 16000");
    expect(derived.provenance.command).toContain("-ac 1");
    expect(derived.provenance.command).toContain("-c:a pcm_s24le");
  });

  it("can write to a temporary file and remove it on cleanup", async () => {
    const source = ffmpegSample(sineInput(1), ["-c:a", "libopus"], "rec.webm");
    const derived = await deriveCanonicalWav({ data: source, output: "file" });
    if (derived.kind !== "file") throw new Error("expected a file result");
    const bytes = await fs.readFile(derived.filePath);
    expect(bytes.length).toBe(derived.sizeBytes);
    expect(parseWavHeader(bytes)).toEqual(derived.wav);
    await derived.cleanup();
    await expect(fs.stat(derived.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects input that cannot be decoded", async () => {
    await expect(deriveCanonicalWav({ data: Buffer.from("not audio") })).rejects.toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "derivation_failed" },
    });
  });

  it("rejects invalid options", async () => {
    const source = ffmpegSample(sineInput(1), ["-c:a", "libopus"], "rec.webm");
    await expect(deriveCanonicalWav({ data: source, sampleRateHz: 0 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(deriveCanonicalWav({ data: source, channels: 1.5 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
