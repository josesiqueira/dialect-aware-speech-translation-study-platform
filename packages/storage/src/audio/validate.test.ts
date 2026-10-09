import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWav,
  FFMPEG_MISSING_MESSAGE,
  ffmpegInstalled,
  ffmpegSample,
  ffmpegSampleToPipe,
  sineInput,
  videoInput,
} from "../testing/audioSamples";
import { ffmpegAvailable, probeAudio } from "./ffmpeg";
import { validateUploadedAudio } from "./validate";
import { generateSineWav } from "./wav";

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxDurationSeconds: 300 };
const hasFfmpeg = ffmpegInstalled();
if (!hasFfmpeg) console.warn(FFMPEG_MISSING_MESSAGE);

let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dialect-validate-test-"));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<{ code?: string; details?: { reason?: string }; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; details?: { reason?: string }; message: string };
  }
  throw new Error("expected the validation to reject");
}

describe("validateUploadedAudio with WAV input (no ffmpeg needed)", () => {
  it("accepts a PCM WAV buffer and reports metadata read from the bytes", async () => {
    const data = generateSineWav({ durationMs: 1500, sampleRateHz: 48000, frequencyHz: 440 });
    const result = await validateUploadedAudio({ data, declaredMimeType: "audio/wav", ...LIMITS });
    expect(result).toMatchObject({
      mimeType: "audio/wav",
      extension: "wav",
      container: "wav",
      codec: "pcm_s16le",
      sampleRateHz: 48000,
      channels: 1,
      bitDepth: 16,
      durationMs: 1500,
      sizeBytes: data.length,
      captureQualityClass: "lossless_pcm",
      declaredMimeTypeMatches: true,
    });
    expect(result.probe).toMatchObject({ parser: "wav_header", frameCount: 72000 });
  });

  it("accepts a WAV file given as a path", async () => {
    const filePath = path.join(tempDir, "upload.bin");
    await fs.writeFile(filePath, generateSineWav({ durationMs: 200, sampleRateHz: 44100, frequencyHz: 440, channels: 2 }));
    const result = await validateUploadedAudio({ data: filePath, ...LIMITS });
    expect(result).toMatchObject({ container: "wav", sampleRateHz: 44100, channels: 2, durationMs: 200, declaredMimeTypeMatches: null });
  });

  it("accepts 24 bit PCM and 32 bit float WAV as lossless", async () => {
    const pcm24 = buildWav({ formatTag: 1, channels: 1, sampleRateHz: 48000, bitsPerSample: 24, data: Buffer.alloc(48000 * 3) });
    expect(await validateUploadedAudio({ data: pcm24, ...LIMITS })).toMatchObject({
      codec: "pcm_s24le",
      bitDepth: 24,
      captureQualityClass: "lossless_pcm",
    });
    const float32 = buildWav({ formatTag: 3, channels: 1, sampleRateHz: 48000, bitsPerSample: 32, data: Buffer.alloc(48000 * 4) });
    expect(await validateUploadedAudio({ data: float32, ...LIMITS })).toMatchObject({
      codec: "pcm_f32le",
      bitDepth: 32,
      captureQualityClass: "lossless_pcm",
    });
  });

  it("does not trust the declared MIME type", async () => {
    const data = generateSineWav({ durationMs: 200, sampleRateHz: 16000, frequencyHz: 440 });
    const result = await validateUploadedAudio({ data, declaredMimeType: "audio/webm;codecs=opus", ...LIMITS });
    expect(result.mimeType).toBe("audio/wav");
    expect(result.declaredMimeTypeMatches).toBe(false);
  });

  it("rejects an empty file", async () => {
    const error = await rejection(validateUploadedAudio({ data: Buffer.alloc(0), ...LIMITS }));
    expect(error).toMatchObject({ code: "INVALID_AUDIO", details: { reason: "empty" } });

    const filePath = path.join(tempDir, "empty.wav");
    await fs.writeFile(filePath, "");
    expect(await rejection(validateUploadedAudio({ data: filePath, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "empty" },
    });
  });

  it("rejects a file that is too large with PAYLOAD_TOO_LARGE", async () => {
    const data = generateSineWav({ durationMs: 1000, sampleRateHz: 48000, frequencyHz: 440 });
    const error = await rejection(validateUploadedAudio({ data, maxBytes: 1000, maxDurationSeconds: 300 }));
    expect(error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", details: { reason: "too_large", maxBytes: 1000 } });
  });

  it("rejects a recording that is too long", async () => {
    const data = generateSineWav({ durationMs: 2100, sampleRateHz: 16000, frequencyHz: 440 });
    const error = await rejection(validateUploadedAudio({ data, maxBytes: LIMITS.maxBytes, maxDurationSeconds: 2 }));
    expect(error).toMatchObject({ code: "INVALID_AUDIO", details: { reason: "too_long", durationMs: 2100 } });
    await expect(
      validateUploadedAudio({ data: generateSineWav({ durationMs: 2000, sampleRateHz: 16000, frequencyHz: 440 }), maxBytes: LIMITS.maxBytes, maxDurationSeconds: 2 }),
    ).resolves.toMatchObject({ durationMs: 2000 });
  });

  it("rejects a WAV with zero duration", async () => {
    const data = generateSineWav({ durationMs: 0, sampleRateHz: 48000, frequencyHz: 440 });
    expect(await rejection(validateUploadedAudio({ data, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "zero_duration" },
    });
  });

  it("rejects a recording shorter than the minimum duration", async () => {
    const data = generateSineWav({ durationMs: 100, sampleRateHz: 16000, frequencyHz: 440 });
    expect(await rejection(validateUploadedAudio({ data, minDurationMs: 300, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "too_short" },
    });
  });

  it("rejects a truncated WAV and a WAV with a non-PCM encoding", async () => {
    const whole = generateSineWav({ durationMs: 500, sampleRateHz: 16000, frequencyHz: 440 });
    expect(await rejection(validateUploadedAudio({ data: whole.subarray(0, 5000), ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "truncated" },
    });
    const mulaw = buildWav({ formatTag: 7, channels: 1, sampleRateHz: 8000, bitsPerSample: 8, data: Buffer.alloc(8000) });
    expect(await rejection(validateUploadedAudio({ data: mulaw, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unsupported_encoding" },
    });
  });

  it("refuses a channel count other than 1 or 2", async () => {
    const many = buildWav({ formatTag: 1, channels: 255, sampleRateHz: 48000, bitsPerSample: 16, data: Buffer.alloc(255 * 2 * 100) });
    expect(await rejection(validateUploadedAudio({ data: many, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unsupported_channel_count", channels: 255 },
    });
    const three = buildWav({ formatTag: 1, channels: 3, sampleRateHz: 48000, bitsPerSample: 16, data: Buffer.alloc(3 * 2 * 100) });
    expect(await rejection(validateUploadedAudio({ data: three, ...LIMITS }))).toMatchObject({
      details: { reason: "unsupported_channel_count" },
    });
  });

  it("refuses a sample rate outside 8000 to 96000 Hz", async () => {
    // 200 bytes at 1 Hz, 16 bit mono would count as 100 seconds of audio.
    const oneHertz = buildWav({ formatTag: 1, channels: 1, sampleRateHz: 1, bitsPerSample: 16, data: Buffer.alloc(200) });
    expect(await rejection(validateUploadedAudio({ data: oneHertz, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unsupported_sample_rate", sampleRateHz: 1 },
    });
    const tooFast = buildWav({ formatTag: 1, channels: 1, sampleRateHz: 192000, bitsPerSample: 16, data: Buffer.alloc(19200) });
    expect(await rejection(validateUploadedAudio({ data: tooFast, ...LIMITS }))).toMatchObject({
      details: { reason: "unsupported_sample_rate" },
    });
    for (const sampleRateHz of [8000, 96000]) {
      const edge = buildWav({ formatTag: 1, channels: 1, sampleRateHz, bitsPerSample: 16, data: Buffer.alloc(sampleRateHz * 2) });
      expect(await validateUploadedAudio({ data: edge, ...LIMITS })).toMatchObject({ sampleRateHz, durationMs: 1000 });
    }
  });

  it("refuses 8 bit PCM and 64 bit float, and accepts 32 bit PCM", async () => {
    const pcm8 = buildWav({ formatTag: 1, channels: 1, sampleRateHz: 16000, bitsPerSample: 8, data: Buffer.alloc(16000) });
    expect(await rejection(validateUploadedAudio({ data: pcm8, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unsupported_bit_depth", bitDepth: 8 },
    });
    const float64 = buildWav({ formatTag: 3, channels: 1, sampleRateHz: 16000, bitsPerSample: 64, data: Buffer.alloc(16000 * 8) });
    expect(await rejection(validateUploadedAudio({ data: float64, ...LIMITS }))).toMatchObject({
      details: { reason: "unsupported_bit_depth" },
    });
    const pcm32 = buildWav({ formatTag: 1, channels: 2, sampleRateHz: 16000, bitsPerSample: 32, data: Buffer.alloc(16000 * 8) });
    expect(await validateUploadedAudio({ data: pcm32, ...LIMITS })).toMatchObject({ codec: "pcm_s32le", bitDepth: 32, channels: 2 });
  });

  it("gives messages that are safe to show (no paths, no tool output)", async () => {
    const error = await rejection(validateUploadedAudio({ data: Buffer.alloc(0), ...LIMITS }));
    expect(error.message).toBe("The recording is empty.");
  });
});

describe.skipIf(!hasFfmpeg)("validateUploadedAudio with ffprobe", () => {
  it("accepts WebM with Opus as a compressed fallback", async () => {
    const data = ffmpegSample(sineInput(1), ["-c:a", "libopus"], "rec.webm");
    const result = await validateUploadedAudio({ data, declaredMimeType: "audio/webm;codecs=opus", ...LIMITS });
    expect(result).toMatchObject({
      mimeType: "audio/webm",
      extension: "webm",
      container: "webm",
      codec: "opus",
      sampleRateHz: 48000,
      channels: 1,
      bitDepth: null,
      captureQualityClass: "compressed_fallback",
      declaredMimeTypeMatches: true,
    });
    expect(result.durationMs).toBeGreaterThan(950);
    expect(result.durationMs).toBeLessThan(1100);
    expect(result.probe).toMatchObject({ parser: "ffprobe" });
  });

  it("stores only technical probe fields: no file tags and no temporary file path", async () => {
    const data = ffmpegSample(
      sineInput(1),
      ["-c:a", "libopus", "-metadata", "title=TAG-TITLE-SECRET", "-metadata", "artist=Matti Meikalainen", "-metadata", "comment=TAG-COMMENT-SECRET"],
      "tagged.webm",
    );
    // The tags are really in the file.
    const raw = JSON.stringify((await probeAudio(data)).raw);
    expect(raw).toContain("TAG-TITLE-SECRET");

    const result = await validateUploadedAudio({ data, ...LIMITS });
    const stored = JSON.stringify(result.probe);
    expect(stored).not.toMatch(/TAG-TITLE-SECRET|Meikalainen|TAG-COMMENT-SECRET|filename|tags|\/tmp|encoder/i);
    expect(result.probe).toMatchObject({
      parser: "ffprobe",
      format: { format_name: expect.any(String) },
      streams: [{ codec_type: "audio", codec_name: "opus", channels: 1 }],
    });
  });

  it("refuses a compressed file with more than two channels", async () => {
    const data = ffmpegSample(sineInput(1), ["-ac", "6", "-c:a", "libopus", "-mapping_family", "1"], "surround.webm");
    expect(await rejection(validateUploadedAudio({ data, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unsupported_channel_count" },
    });
  });

  it("determines the duration of a WebM that has none in its header", async () => {
    const data = ffmpegSampleToPipe(sineInput(2), ["-c:a", "libopus", "-f", "webm"]);
    const probe = await probeAudio(data);
    expect((probe.raw as { format: { duration?: string } }).format.duration).toBeUndefined();
    expect(probe.durationMs).toBeGreaterThan(1950);
    expect(probe.durationMs).toBeLessThan(2100);

    const result = await validateUploadedAudio({ data, ...LIMITS });
    expect(result.durationMs).toBe(probe.durationMs);
    expect(await rejection(validateUploadedAudio({ data, maxBytes: LIMITS.maxBytes, maxDurationSeconds: 1 }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "too_long" },
    });
  });

  it("accepts Ogg with Opus and MP4 with AAC", async () => {
    const ogg = ffmpegSample(sineInput(1), ["-c:a", "libopus"], "rec.ogg");
    expect(await validateUploadedAudio({ data: ogg, ...LIMITS })).toMatchObject({
      mimeType: "audio/ogg",
      extension: "ogg",
      codec: "opus",
      captureQualityClass: "compressed_fallback",
    });
    const mp4 = ffmpegSample(sineInput(1, 44100), ["-c:a", "aac"], "rec.mp4");
    expect(await validateUploadedAudio({ data: mp4, declaredMimeType: "audio/mp4", ...LIMITS })).toMatchObject({
      mimeType: "audio/mp4",
      extension: "mp4",
      codec: "aac",
      sampleRateHz: 44100,
      captureQualityClass: "compressed_fallback",
      declaredMimeTypeMatches: true,
    });
  });

  it("rejects a text file renamed to .wav", async () => {
    const filePath = path.join(tempDir, "notes.wav");
    await fs.writeFile(filePath, "These are my notes. This is not audio.\n".repeat(50));
    const error = await rejection(validateUploadedAudio({ data: filePath, declaredMimeType: "audio/wav", ...LIMITS }));
    expect(error).toMatchObject({ code: "INVALID_AUDIO", details: { reason: "unparsable" } });
    expect(error.message).not.toContain(tempDir);
  });

  it("rejects random bytes", async () => {
    const data = Buffer.alloc(4096, 0x5a);
    expect(await rejection(validateUploadedAudio({ data, ...LIMITS }))).toMatchObject({ code: "INVALID_AUDIO" });
  });

  it("rejects a video-only file: no audio track", async () => {
    const data = ffmpegSample(videoInput(1), ["-c:v", "libvpx", "-b:v", "100k"], "video.webm");
    expect(await rejection(validateUploadedAudio({ data, declaredMimeType: "audio/webm", ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "no_audio_track" },
    });
  });

  it("rejects a file that has video next to the audio", async () => {
    const data = ffmpegSample([...videoInput(1), ...sineInput(1)], ["-c:v", "libvpx", "-b:v", "100k", "-c:a", "libopus"], "both.webm");
    expect(await rejection(validateUploadedAudio({ data, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "has_video_track" },
    });
  });

  it("rejects containers and codecs outside the accepted list", async () => {
    const mp3 = ffmpegSample(sineInput(1, 44100), ["-c:a", "libmp3lame"], "rec.mp3");
    expect(await rejection(validateUploadedAudio({ data: mp3, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unsupported_container" },
    });
    const vorbisWebm = ffmpegSample(sineInput(1), ["-c:a", "libvorbis"], "rec.webm");
    expect(await rejection(validateUploadedAudio({ data: vorbisWebm, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unsupported_codec" },
    });
    const matroska = ffmpegSample(sineInput(1), ["-c:a", "libopus"], "rec.mkv");
    expect(await rejection(validateUploadedAudio({ data: matroska, ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unsupported_container" },
    });
  });

  it("rejects a compressed file that is too long", async () => {
    const data = ffmpegSample(sineInput(3), ["-c:a", "libopus"], "long.webm");
    expect(await rejection(validateUploadedAudio({ data, maxBytes: LIMITS.maxBytes, maxDurationSeconds: 2 }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "too_long" },
    });
  });

  it("does not follow a playlist to other files", async () => {
    // An HLS playlist would make ffprobe open the listed file. The format
    // allowlist stops that before anything is opened.
    const secret = path.join(tempDir, "secret.wav");
    await fs.writeFile(secret, generateSineWav({ durationMs: 500, sampleRateHz: 16000, frequencyHz: 440 }));
    const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n${secret}\n#EXT-X-ENDLIST\n`;
    expect(await rejection(validateUploadedAudio({ data: Buffer.from(playlist), ...LIMITS }))).toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unparsable" },
    });
  });
});

describe.skipIf(!hasFfmpeg)("probeAudio", () => {
  it("returns normalized metadata for a WAV buffer", async () => {
    const probe = await probeAudio(generateSineWav({ durationMs: 1000, sampleRateHz: 44100, frequencyHz: 440, channels: 2 }));
    expect(probe).toMatchObject({
      container: "wav",
      codec: "pcm_s16le",
      sampleRateHz: 44100,
      channels: 2,
      bitDepth: 16,
      durationMs: 1000,
      hasAudioTrack: true,
      hasVideoTrack: false,
    });
    expect(probe.raw).toHaveProperty("format");
    expect(probe.raw).toHaveProperty("streams");
  });

  it("probes a file path and tells WebM from Matroska", async () => {
    const webmPath = path.join(tempDir, "probe.webm");
    await fs.writeFile(webmPath, ffmpegSample(sineInput(1), ["-c:a", "libopus"], "a.webm"));
    expect(await probeAudio(webmPath)).toMatchObject({ container: "webm", codec: "opus", bitDepth: null });
    const mkv = ffmpegSample(sineInput(1), ["-c:a", "libopus"], "a.mkv");
    expect(await probeAudio(mkv)).toMatchObject({ container: "matroska", codec: "opus" });
  });

  it("reports a video-only file as having no audio track", async () => {
    const probe = await probeAudio(ffmpegSample(videoInput(1), ["-c:v", "libvpx", "-b:v", "100k"], "v.webm"));
    expect(probe).toMatchObject({ hasAudioTrack: false, hasVideoTrack: true, codec: null, sampleRateHz: null });
  });

  it("throws INVALID_AUDIO for bytes that are not media", async () => {
    await expect(probeAudio(Buffer.from("not media at all"))).rejects.toMatchObject({
      code: "INVALID_AUDIO",
      details: { reason: "unparsable" },
    });
  });

  it("leaves no temporary files behind", async () => {
    const before = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("dialect-audio-"));
    await probeAudio(generateSineWav({ durationMs: 100, sampleRateHz: 16000, frequencyHz: 440 }));
    await probeAudio(Buffer.from("not media")).catch(() => undefined);
    const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("dialect-audio-"));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});

describe("ffmpegAvailable", () => {
  it.skipIf(!hasFfmpeg)("reports the installed versions", async () => {
    const result = await ffmpegAvailable();
    expect(result.available).toBe(true);
    expect(result.ffmpegVersion).toMatch(/^\S+$/);
    expect(result.ffprobeVersion).toMatch(/^\S+$/);
  });

  it("reports missing tools without throwing, and probing then fails with CONFIGURATION_MISSING", async () => {
    const saved = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
    process.env.FFMPEG_PATH = path.join(tempDir, "no-such-ffmpeg");
    process.env.FFPROBE_PATH = path.join(tempDir, "no-such-ffprobe");
    try {
      expect(await ffmpegAvailable()).toEqual({ available: false, ffmpegVersion: null, ffprobeVersion: null });
      await expect(probeAudio(Buffer.from("anything"))).rejects.toMatchObject({ code: "CONFIGURATION_MISSING" });
      // WAV validation does not need the tools.
      await expect(
        validateUploadedAudio({ data: generateSineWav({ durationMs: 100, sampleRateHz: 16000, frequencyHz: 440 }), ...LIMITS }),
      ).resolves.toMatchObject({ container: "wav" });
    } finally {
      if (saved.ffmpeg === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = saved.ffmpeg;
      if (saved.ffprobe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = saved.ffprobe;
    }
  });
});
