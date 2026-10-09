// Server-side validation of an uploaded recording (spec 63).
// Nothing the browser says about the file is trusted: container, codec and
// duration are determined from the bytes.
import * as fs from "node:fs/promises";
import { AppError, isAppError, type CaptureQualityClass } from "@dialect/domain";
import { errnoCode, storageError } from "../errors";
import { probeAudio } from "./ffmpeg";
import { isWavBuffer, isWavParseError, parseWavHeader } from "./wav";

export type ValidateUploadedAudioInput = {
  // The uploaded bytes, or the path of a file that holds them.
  data: Buffer | string;
  // Content type sent by the browser. Recorded for comparison only.
  declaredMimeType?: string;
  maxBytes: number;
  maxDurationSeconds: number;
  // Shortest accepted duration. Default 1 ms (any non-zero duration).
  minDurationMs?: number;
};

export type AcceptedAudioContainer = "wav" | "webm" | "ogg" | "mp4";

export type ValidatedAudio = {
  // MIME type determined from the bytes.
  mimeType: "audio/wav" | "audio/webm" | "audio/ogg" | "audio/mp4";
  // File extension without a dot, for the object key.
  extension: "wav" | "webm" | "ogg" | "mp4";
  container: AcceptedAudioContainer;
  // ffprobe style codec name: "pcm_s16le", "pcm_s24le", "pcm_f32le", "opus", "aac", ...
  codec: string;
  sampleRateHz: number;
  channels: number;
  // Null for lossy codecs.
  bitDepth: number | null;
  durationMs: number;
  sizeBytes: number;
  captureQualityClass: CaptureQualityClass;
  // False when the browser declared a different type than the bytes show. This is
  // information for the media record, not a reason to reject.
  declaredMimeTypeMatches: boolean | null;
  // Parser output, for media_assets.metadata_json.probe.
  probe: Record<string, unknown>;
};

const MIME_TYPES = {
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp4: "audio/mp4",
} as const;

const DECLARED_MIME_ALIASES: Record<AcceptedAudioContainer, readonly string[]> = {
  wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  webm: ["audio/webm", "video/webm"],
  ogg: ["audio/ogg", "application/ogg"],
  mp4: ["audio/mp4", "audio/x-m4a", "audio/m4a", "video/mp4", "audio/aac"],
};

// Codec required for each compressed container.
const REQUIRED_CODEC: Record<Exclude<AcceptedAudioContainer, "wav">, string> = {
  webm: "opus",
  ogg: "opus",
  mp4: "aac",
};

// Technical limits of an accepted recording (spec 31, 63). A recording of speech
// is mono or stereo. The sample rate range covers telephone quality up to 96 kHz.
// A file outside these limits is refused before anything decodes it: a header
// that declares 255 channels or a 1 Hz rate would otherwise make the tools
// allocate or produce far more data than the upload limit allows.
export const MAX_AUDIO_CHANNELS = 2;
export const MIN_SAMPLE_RATE_HZ = 8000;
export const MAX_SAMPLE_RATE_HZ = 96000;
// PCM sample sizes accepted in a WAV file. 8-bit audio is refused: the
// specification asks for at least 16 bits.
export const ACCEPTED_PCM_BIT_DEPTHS = [16, 24, 32] as const;

// The fields of the ffprobe output that are kept in media_assets.metadata_json.probe.
// Technical facts only. File tags (title, artist, comment, encoder, ...) are chosen
// by whoever made the file and are never stored, and neither is the path of the
// temporary file that ffprobe read.
const PROBE_FORMAT_FIELDS = ["format_name", "nb_streams", "duration", "size", "bit_rate", "probe_score"] as const;
const PROBE_STREAM_FIELDS = [
  "index",
  "codec_type",
  "codec_name",
  "profile",
  "sample_fmt",
  "sample_rate",
  "channels",
  "channel_layout",
  "bits_per_sample",
  "bits_per_raw_sample",
  "bit_rate",
  "duration",
  "start_time",
  "time_base",
] as const;

function pick(source: unknown, fields: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (typeof source !== "object" || source === null) return kept;
  for (const field of fields) {
    const value = (source as Record<string, unknown>)[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") kept[field] = value;
  }
  return kept;
}

// Reduces the ffprobe JSON output to the allow-listed technical fields.
export function technicalProbeFields(raw: unknown): Record<string, unknown> {
  const output = (typeof raw === "object" && raw !== null ? raw : {}) as { format?: unknown; streams?: unknown };
  const streams = Array.isArray(output.streams) ? output.streams : [];
  return {
    format: pick(output.format, PROBE_FORMAT_FIELDS),
    streams: streams.slice(0, 8).map((stream) => pick(stream, PROBE_STREAM_FIELDS)),
  };
}

function invalid(reason: string, message: string, cause?: unknown): AppError {
  return new AppError("INVALID_AUDIO", message, { reason }, cause === undefined ? undefined : { cause });
}

function declaredMatches(declared: string | undefined, container: AcceptedAudioContainer): boolean | null {
  if (!declared) return null;
  const base = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  return DECLARED_MIME_ALIASES[container].includes(base);
}

function wavCodecName(audioFormat: "pcm" | "ieee_float", bytesPerSample: number): string {
  if (audioFormat === "ieee_float") return bytesPerSample === 8 ? "pcm_f64le" : "pcm_f32le";
  if (bytesPerSample === 1) return "pcm_u8";
  return `pcm_s${bytesPerSample * 8}le`;
}

function assertChannelsAndRate(channels: number, sampleRateHz: number): void {
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_AUDIO_CHANNELS) {
    throw new AppError("INVALID_AUDIO", "The recording must be mono or stereo.", {
      reason: "unsupported_channel_count",
      channels,
    });
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < MIN_SAMPLE_RATE_HZ || sampleRateHz > MAX_SAMPLE_RATE_HZ) {
    throw new AppError(
      "INVALID_AUDIO",
      `The sample rate of the recording must be between ${MIN_SAMPLE_RATE_HZ} and ${MAX_SAMPLE_RATE_HZ} Hz.`,
      { reason: "unsupported_sample_rate", sampleRateHz },
    );
  }
}

async function readHead(data: Buffer | string, length: number): Promise<Buffer> {
  if (typeof data !== "string") return data.subarray(0, length);
  const handle = await fs.open(data, "r");
  try {
    const head = Buffer.alloc(length);
    const { bytesRead } = await handle.read(head, 0, length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Accepts: WAV with 16, 24 or 32 bit PCM or 32 bit IEEE float samples, WebM with
// Opus, Ogg with Opus, and MP4 with AAC (what Safari's MediaRecorder produces),
// each with 1 or 2 channels and a sample rate of 8000 to 96000 Hz. Throws
// AppError("PAYLOAD_TOO_LARGE") or AppError("INVALID_AUDIO") with a message that
// is safe to show; `details.reason` holds a stable code.
export async function validateUploadedAudio(input: ValidateUploadedAudioInput): Promise<ValidatedAudio> {
  const { data, maxBytes, maxDurationSeconds } = input;
  const minDurationMs = Math.max(1, input.minDurationMs ?? 1);

  let sizeBytes: number;
  if (typeof data === "string") {
    try {
      const stats = await fs.stat(data);
      if (!stats.isFile()) throw invalid("unparsable", "The file could not be read as audio.");
      sizeBytes = stats.size;
    } catch (error) {
      if (isAppError(error)) throw error;
      if (errnoCode(error) === "ENOENT") {
        throw new AppError("MEDIA_NOT_FOUND", "The uploaded file was not found on the server.", undefined, {
          cause: error,
        });
      }
      throw storageError("Reading the uploaded file failed.", error);
    }
  } else {
    sizeBytes = data.length;
  }

  if (sizeBytes === 0) throw invalid("empty", "The recording is empty.");
  if (sizeBytes > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", "The recording is larger than the allowed size.", {
      reason: "too_large",
      sizeBytes,
      maxBytes,
    });
  }

  let technical: Pick<ValidatedAudio, "container" | "codec" | "sampleRateHz" | "channels" | "bitDepth" | "durationMs" | "probe">;

  const head = await readHead(data, 12);
  if (isWavBuffer(head)) {
    // WAV is parsed directly, so lossless uploads do not depend on ffprobe.
    const fileBytes = typeof data === "string" ? await fs.readFile(data) : data;
    let wav;
    try {
      wav = parseWavHeader(fileBytes);
    } catch (error) {
      if (isWavParseError(error)) {
        throw invalid(error.reason, "The recording is not a valid WAV file.", error);
      }
      throw error;
    }
    assertChannelsAndRate(wav.channels, wav.sampleRateHz);
    const storedBits = (wav.blockAlign / wav.channels) * 8;
    const accepted = ACCEPTED_PCM_BIT_DEPTHS as readonly number[];
    if (!accepted.includes(wav.bitDepth) || !accepted.includes(storedBits)) {
      throw new AppError("INVALID_AUDIO", "The recording must be 16, 24 or 32 bit PCM audio.", {
        reason: "unsupported_bit_depth",
        bitDepth: wav.bitDepth,
      });
    }
    technical = {
      container: "wav",
      codec: wavCodecName(wav.audioFormat, wav.blockAlign / wav.channels),
      sampleRateHz: wav.sampleRateHz,
      channels: wav.channels,
      bitDepth: wav.bitDepth,
      durationMs: wav.durationMs,
      // Numbers and the format name from the header. A WAV file can carry text
      // chunks (LIST/INFO): the parser skips them and none of it is kept.
      probe: { parser: "wav_header", ...wav },
    };
    if (wav.frameCount === 0) throw invalid("zero_duration", "The recording contains no audio.");
  } else {
    const probe = await probeAudio(data);
    if (!probe.hasAudioTrack || probe.codec === null) {
      throw invalid("no_audio_track", "The file does not contain an audio track.");
    }
    if (probe.hasVideoTrack) {
      throw invalid("has_video_track", "The file contains video. Only audio recordings are accepted.");
    }
    const container = probe.container;
    if (container !== "webm" && container !== "ogg" && container !== "mp4") {
      throw invalid("unsupported_container", "This audio format is not accepted.");
    }
    if (probe.codec !== REQUIRED_CODEC[container]) {
      throw invalid("unsupported_codec", "This audio format is not accepted.");
    }
    if (probe.sampleRateHz === null || probe.channels === null) {
      throw invalid("unparsable", "The file could not be read as audio.");
    }
    if (probe.durationMs === null || probe.durationMs <= 0) {
      throw invalid("zero_duration", "The recording contains no audio.");
    }
    assertChannelsAndRate(probe.channels, probe.sampleRateHz);
    technical = {
      container,
      codec: probe.codec,
      sampleRateHz: probe.sampleRateHz,
      channels: probe.channels,
      bitDepth: probe.bitDepth,
      durationMs: probe.durationMs,
      probe: { parser: "ffprobe", ...technicalProbeFields(probe.raw) },
    };
  }

  if (technical.durationMs < minDurationMs) {
    throw invalid(
      technical.durationMs <= 0 ? "zero_duration" : "too_short",
      technical.durationMs <= 0 ? "The recording contains no audio." : "The recording is too short.",
    );
  }
  if (technical.durationMs > maxDurationSeconds * 1000) {
    throw new AppError("INVALID_AUDIO", "The recording is longer than the allowed duration.", {
      reason: "too_long",
      durationMs: technical.durationMs,
      maxDurationSeconds,
    });
  }

  return {
    ...technical,
    mimeType: MIME_TYPES[technical.container],
    extension: technical.container,
    sizeBytes,
    captureQualityClass: technical.container === "wav" ? "lossless_pcm" : "compressed_fallback",
    declaredMimeTypeMatches: declaredMatches(input.declaredMimeType, technical.container),
  };
}
