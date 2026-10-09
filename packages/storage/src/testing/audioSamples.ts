// Helpers for the audio tests: sample files generated at test time with ffmpeg,
// and a WAV builder for unusual headers.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FFMPEG_MISSING_MESSAGE =
  "ffmpeg and ffprobe are not installed: tests that need them are skipped";

export function ffmpegInstalled(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Runs ffmpeg with the given input and output arguments and returns the bytes of
// the output file. Example: ffmpegSample(SINE_1S, ["-c:a", "libopus"], "a.webm").
export function ffmpegSample(inputArgs: string[], outputArgs: string[], fileName: string): Buffer {
  const directory = mkdtempSync(path.join(os.tmpdir(), "dialect-sample-"));
  try {
    const outputPath = path.join(directory, fileName);
    execFileSync("ffmpeg", ["-v", "error", "-y", ...inputArgs, ...outputArgs, outputPath], { stdio: "pipe" });
    return readFileSync(outputPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Same, but ffmpeg writes to a pipe. The muxer cannot seek back, so a WebM made
// this way has no duration in its header, like a MediaRecorder recording.
export function ffmpegSampleToPipe(inputArgs: string[], outputArgs: string[]): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...inputArgs, ...outputArgs, "pipe:1"], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function sineInput(durationSeconds: number, sampleRateHz = 48000): string[] {
  return ["-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSeconds}:sample_rate=${sampleRateHz}`];
}

export function videoInput(durationSeconds: number): string[] {
  return ["-f", "lavfi", "-i", `testsrc=duration=${durationSeconds}:size=64x64:rate=5`];
}

function chunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  const padding = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, body, padding]);
}

// Builds a WAV file from explicit header fields, so tests can produce 24 bit,
// float and WAVE_FORMAT_EXTENSIBLE files and files with extra chunks.
export function buildWav(input: {
  formatTag: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  data: Buffer;
  // WAVE_FORMAT_EXTENSIBLE: the real format tag goes into the sub-format GUID.
  extensible?: { validBits: number; subFormatTag: number };
  chunksBeforeData?: { id: string; body: Buffer }[];
  chunksAfterData?: { id: string; body: Buffer }[];
  // Overrides the size written in the data chunk header.
  declaredDataBytes?: number;
}): Buffer {
  const blockAlign = input.channels * (input.bitsPerSample / 8);
  const fmt = Buffer.alloc(input.extensible ? 40 : 16);
  fmt.writeUInt16LE(input.extensible ? 0xfffe : input.formatTag, 0);
  fmt.writeUInt16LE(input.channels, 2);
  fmt.writeUInt32LE(input.sampleRateHz, 4);
  fmt.writeUInt32LE(input.sampleRateHz * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(input.bitsPerSample, 14);
  if (input.extensible) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(input.extensible.validBits, 18);
    fmt.writeUInt32LE(input.channels === 1 ? 0x4 : 0x3, 20);
    // KSDATAFORMAT_SUBTYPE: xxxxxxxx-0000-0010-8000-00aa00389b71
    Buffer.from([0, 0, 0, 0, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]).copy(fmt, 24);
    fmt.writeUInt16LE(input.extensible.subFormatTag, 24);
  }

  const dataChunk = chunk("data", input.data);
  if (input.declaredDataBytes !== undefined) dataChunk.writeUInt32LE(input.declaredDataBytes, 4);

  const body = Buffer.concat([
    Buffer.from("WAVE", "latin1"),
    chunk("fmt ", fmt),
    ...(input.chunksBeforeData ?? []).map((extra) => chunk(extra.id, extra.body)),
    dataChunk,
    ...(input.chunksAfterData ?? []).map((extra) => chunk(extra.id, extra.body)),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
