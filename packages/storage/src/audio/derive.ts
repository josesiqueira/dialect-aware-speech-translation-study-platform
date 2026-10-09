// Canonical WAV derivation (spec 64, 106). The raw upload is never replaced: the
// caller stores the result as a separate media asset that points at its source
// and records the provenance returned here.
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "@dialect/domain";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  ffmpegBinary,
  PROBE_FORMAT_ALLOWLIST,
  runToolOrThrow,
  withInputFile,
} from "./ffmpeg";
import { parseWavHeader, type WavInfo } from "./wav";

export type DeriveCanonicalWavInput = {
  // The source audio bytes, or the path of a file that holds them.
  data: Buffer | string;
  // By default the source sample rate and channel count are kept (no resampling,
  // no mixing). Set these only for an explicitly requested conversion.
  sampleRateHz?: number;
  channels?: number;
  // Output sample size. Default 16.
  bitDepth?: 16 | 24;
  // "buffer" (default) returns the bytes. "file" returns the path of a temporary
  // file and a cleanup function, for large inputs.
  output?: "buffer" | "file";
  timeoutMs?: number;
};

// Matches media_assets.metadata_json.derivation.
export type DerivationProvenance = {
  tool: "ffmpeg";
  toolVersion: string;
  // The exact arguments used, with the temporary file paths replaced by
  // "<input>" and "<output>".
  command: string;
  // ISO 8601 timestamp.
  createdAt: string;
};

type DerivedWavCommon = {
  wav: WavInfo;
  sizeBytes: number;
  provenance: DerivationProvenance;
};

export type DerivedWav =
  | (DerivedWavCommon & { kind: "buffer"; data: Buffer })
  | (DerivedWavCommon & { kind: "file"; filePath: string; cleanup: () => Promise<void> });

function positiveInteger(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a positive integer.`);
  }
  return value;
}

async function readFfmpegVersion(): Promise<string> {
  const result = await runToolOrThrow(ffmpegBinary(), ["-version"], { timeoutMs: 5_000 });
  const match = /^ffmpeg version (\S+)/m.exec(result.stdout.toString("utf8"));
  return match?.[1] ?? "unknown";
}

// Decodes compressed audio to a PCM WAV file with ffmpeg.
// Throws AppError("INVALID_AUDIO") when the source cannot be decoded.
export async function deriveCanonicalWav(input: DeriveCanonicalWavInput): Promise<DerivedWav> {
  const sampleRateHz = positiveInteger("sampleRateHz", input.sampleRateHz);
  const channels = positiveInteger("channels", input.channels);
  const codec = input.bitDepth === 24 ? "pcm_s24le" : "pcm_s16le";
  const toolVersion = await readFfmpegVersion();

  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dialect-derive-"));
  const outputPath = path.join(outputDirectory, "derived.wav");
  const cleanup = async (): Promise<void> => {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  };

  // -map 0:a:0 takes the first audio stream only; -map_metadata -1 and the
  // bitexact flags keep tags and encoder names out of the output, so the same
  // input and tool version give the same bytes.
  const buildArgs = (inputPath: string, outPath: string): string[] => [
    "-nostdin",
    "-hide_banner",
    "-v", "error",
    "-protocol_whitelist", "file",
    "-format_whitelist", PROBE_FORMAT_ALLOWLIST.join(","),
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-map_metadata", "-1",
    "-c:a", codec,
    ...(sampleRateHz !== undefined ? ["-ar", String(sampleRateHz)] : []),
    ...(channels !== undefined ? ["-ac", String(channels)] : []),
    "-fflags", "+bitexact",
    "-flags:a", "+bitexact",
    "-f", "wav",
    "-y",
    outPath,
  ];

  try {
    const createdAt = new Date().toISOString();
    await withInputFile(input.data, async (inputPath) => {
      const result = await runToolOrThrow(ffmpegBinary(), buildArgs(inputPath, outputPath), {
        timeoutMs: input.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS * 4,
      });
      if (result.exitCode !== 0) {
        throw new AppError(
          "INVALID_AUDIO",
          "The recording could not be converted to WAV.",
          { reason: "derivation_failed" },
          { cause: new Error(result.stderr.trim() || `ffmpeg exited with code ${result.exitCode}`) },
        );
      }
    });

    const provenance: DerivationProvenance = {
      tool: "ffmpeg",
      toolVersion,
      command: ["ffmpeg", ...buildArgs("<input>", "<output>")].join(" "),
      createdAt,
    };

    if (input.output === "file") {
      const stats = await fs.stat(outputPath);
      const handle = await fs.open(outputPath, "r");
      let head: Buffer;
      try {
        const buffer = Buffer.alloc(Math.min(stats.size, 65_536));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      return {
        kind: "file",
        filePath: outputPath,
        cleanup,
        wav: parseWavHeader(head, { headerOnly: true }),
        sizeBytes: stats.size,
        provenance,
      };
    }

    const data = await fs.readFile(outputPath);
    await cleanup();
    return { kind: "buffer", data, wav: parseWavHeader(data), sizeBytes: data.length, provenance };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
