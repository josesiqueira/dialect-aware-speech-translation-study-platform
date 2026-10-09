// Thin wrappers around the ffmpeg and ffprobe command line tools.
// Processes are started with an argument array and no shell, with a timeout.
// Uploaded files are untrusted input, so the tools are limited to local files
// (`-protocol_whitelist file`) and to a short list of container formats
// (`-format_whitelist`). This stops playlist-like formats from making the tools
// read other files or open network connections.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "@dialect/domain";
import { errnoCode } from "../errors";

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

// ffmpeg demuxer names accepted when probing.
export const PROBE_FORMAT_ALLOWLIST = [
  "wav",
  "matroska",
  "webm",
  "ogg",
  "mov",
  "mp4",
  "m4a",
  "3gp",
  "3g2",
  "mj2",
  "mp3",
  "flac",
  "aac",
] as const;

// Binary locations. FFMPEG_PATH and FFPROBE_PATH override the lookup in PATH.
export function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

export function ffprobeBinary(): string {
  return process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

export type ToolResult = { exitCode: number | null; stdout: Buffer; stderr: string };

export class ToolNotInstalledError extends Error {
  constructor(binary: string, cause: unknown) {
    super(`${binary} is not installed or not in PATH.`, { cause });
    this.name = "ToolNotInstalledError";
  }
}

export class ToolTimeoutError extends Error {
  constructor(binary: string, timeoutMs: number) {
    super(`${binary} did not finish within ${timeoutMs} ms.`);
    this.name = "ToolTimeoutError";
  }
}

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_CHARS = 16_000;

export function runTool(
  binary: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<ToolResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  return new Promise<ToolResult>((resolve, reject) => {
    const child = spawn(binary, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new ToolTimeoutError(binary, timeoutMs)));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`${binary} produced too much output.`)));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(() =>
        reject(errnoCode(error) === "ENOENT" ? new ToolNotInstalledError(binary, error) : error),
      );
    });
    child.on("close", (exitCode) => {
      finish(() => resolve({ exitCode, stdout: Buffer.concat(stdoutChunks), stderr }));
    });
  });
}

function toolUnavailable(error: unknown): AppError {
  if (error instanceof ToolNotInstalledError) {
    return new AppError(
      "CONFIGURATION_MISSING",
      "Audio processing is not available on this server: ffmpeg and ffprobe must be installed.",
      undefined,
      { cause: error },
    );
  }
  return new AppError("INTERNAL_ERROR", "Audio processing failed on the server.", undefined, {
    cause: error,
  });
}

// Runs a tool and converts "not installed" and timeouts to AppError.
export async function runToolOrThrow(
  binary: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<ToolResult> {
  try {
    return await runTool(binary, args, options);
  } catch (error) {
    throw toolUnavailable(error);
  }
}

function parseVersion(output: string): string | null {
  const match = /^ff(?:mpeg|probe) version (\S+)/m.exec(output);
  return match?.[1] ?? null;
}

async function toolVersion(binary: string): Promise<string | null> {
  try {
    const result = await runTool(binary, ["-version"], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) return null;
    return parseVersion(result.stdout.toString("utf8"));
  } catch {
    return null;
  }
}

export type FfmpegAvailability = {
  // True when both tools can be started.
  available: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
};

// Reports the installed tool versions, for the Settings page and readiness checks.
export async function ffmpegAvailable(): Promise<FfmpegAvailability> {
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([
    toolVersion(ffmpegBinary()),
    toolVersion(ffprobeBinary()),
  ]);
  return {
    available: ffmpegVersion !== null && ffprobeVersion !== null,
    ffmpegVersion,
    ffprobeVersion,
  };
}

// Runs `action` with the audio available as a file. A Buffer is written to a
// private temporary directory that is removed afterwards. The temporary file has
// no extension, so the tools identify the format from the bytes alone.
export async function withInputFile<T>(
  input: Buffer | string,
  action: (filePath: string) => Promise<T>,
): Promise<T> {
  if (typeof input === "string") return action(path.resolve(input));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dialect-audio-"));
  try {
    const filePath = path.join(directory, "input");
    await fs.writeFile(filePath, input, { mode: 0o600 });
    return await action(filePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export type AudioContainer = "wav" | "webm" | "matroska" | "ogg" | "mp4" | "mp3" | "flac" | "aac";

export type AudioProbe = {
  // Normalized container name, or the ffprobe format name when it is not one of
  // the known containers.
  container: AudioContainer | string;
  // Codec of the first audio stream (ffprobe codec name, for example "pcm_s16le",
  // "opus", "aac"). Null when there is no audio stream.
  codec: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  // Bits per sample for PCM and other lossless codecs. Null for lossy codecs.
  bitDepth: number | null;
  // Null when the duration could not be determined.
  durationMs: number | null;
  hasAudioTrack: boolean;
  hasVideoTrack: boolean;
  // The ffprobe JSON output (format and streams).
  raw: Record<string, unknown>;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  bits_per_sample?: number;
  bits_per_raw_sample?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
};

type FfprobeOutput = {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
};

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ffprobe reports "matroska,webm" for both. The EBML header names the real type.
async function matroskaDocType(filePath: string): Promise<"webm" | "matroska"> {
  const handle = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(256);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    // DocType element: id 0x42 0x82, one size byte, then the ASCII name.
    const marker = head.subarray(0, bytesRead).indexOf(Buffer.from([0x42, 0x82]));
    if (marker >= 0 && head.toString("latin1", marker + 3, marker + 7) === "webm") return "webm";
    return "matroska";
  } finally {
    await handle.close();
  }
}

async function normalizeContainer(formatName: string, filePath: string): Promise<string> {
  const names = formatName.split(",");
  if (names.includes("wav")) return "wav";
  if (names.includes("matroska") || names.includes("webm")) return matroskaDocType(filePath);
  if (names.includes("ogg")) return "ogg";
  if (names.includes("mp4") || names.includes("mov")) return "mp4";
  return formatName;
}

// Some files carry no duration in their header (a WebM written by MediaRecorder
// is the common case). Read the packet timestamps of the first audio stream
// instead and return the end of the last packet.
async function durationFromPackets(filePath: string, timeoutMs: number): Promise<number | null> {
  const result = await runToolOrThrow(
    ffprobeBinary(),
    [
      "-v", "error",
      "-protocol_whitelist", "file",
      "-format_whitelist", PROBE_FORMAT_ALLOWLIST.join(","),
      "-select_streams", "a:0",
      "-show_entries", "packet=pts_time,duration_time",
      "-of", "csv=p=0",
      "-i", filePath,
    ],
    { timeoutMs },
  );
  if (result.exitCode !== 0) return null;
  let start: number | null = null;
  let end: number | null = null;
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [ptsText, durationText] = line.trim().split(",");
    const pts = Number(ptsText);
    if (!ptsText || !Number.isFinite(pts)) continue;
    const packetDuration = Number(durationText);
    const packetEnd = pts + (Number.isFinite(packetDuration) ? packetDuration : 0);
    if (start === null || pts < start) start = pts;
    if (end === null || packetEnd > end) end = packetEnd;
  }
  if (start === null || end === null) return null;
  // Codec delay can make the first timestamp slightly negative.
  const seconds = end - Math.max(0, start);
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

// Inspects audio with ffprobe and returns normalized technical metadata.
// Throws AppError("INVALID_AUDIO") when the bytes cannot be parsed as one of the
// accepted container formats, and AppError("CONFIGURATION_MISSING") when ffprobe
// is not installed.
export async function probeAudio(
  input: Buffer | string,
  options: { timeoutMs?: number } = {},
): Promise<AudioProbe> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  return withInputFile(input, async (filePath) => {
    const result = await runToolOrThrow(
      ffprobeBinary(),
      [
        "-v", "error",
        "-protocol_whitelist", "file",
        "-format_whitelist", PROBE_FORMAT_ALLOWLIST.join(","),
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        "-i", filePath,
      ],
      { timeoutMs },
    );

    let parsed: FfprobeOutput | null = null;
    if (result.exitCode === 0) {
      try {
        parsed = JSON.parse(result.stdout.toString("utf8")) as FfprobeOutput;
      } catch {
        parsed = null;
      }
    }
    if (!parsed || !parsed.format || typeof parsed.format.format_name !== "string") {
      throw new AppError(
        "INVALID_AUDIO",
        "The file could not be read as audio.",
        { reason: "unparsable" },
        { cause: new Error(result.stderr.trim() || "ffprobe returned no format information") },
      );
    }

    const streams = parsed.streams ?? [];
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const hasVideoTrack = streams.some(
      (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
    );

    let durationSeconds = positiveNumber(parsed.format.duration) ?? positiveNumber(audio?.duration);
    let durationMs = durationSeconds === null ? null : Math.round(durationSeconds * 1000);
    if (durationMs === null && audio) {
      durationMs = await durationFromPackets(filePath, timeoutMs);
      durationSeconds = durationMs === null ? null : durationMs / 1000;
    }

    const bitDepth =
      positiveNumber(audio?.bits_per_sample) ?? positiveNumber(audio?.bits_per_raw_sample);

    return {
      container: await normalizeContainer(parsed.format.format_name, filePath),
      codec: audio?.codec_name ?? null,
      sampleRateHz: positiveNumber(audio?.sample_rate),
      channels: positiveNumber(audio?.channels),
      bitDepth,
      durationMs,
      hasAudioTrack: audio !== undefined,
      hasVideoTrack,
      raw: parsed as Record<string, unknown>,
    };
  });
}
