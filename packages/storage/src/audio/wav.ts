// WAV (RIFF/WAVE) header parsing and a small PCM encoder.
// The parser is pure: it reads only the buffer it is given.
import { AppError } from "@dialect/domain";

export type WavAudioFormat = "pcm" | "ieee_float";

export type WavInfo = {
  sampleRateHz: number;
  channels: number;
  // Valid bits per sample. For WAVE_FORMAT_EXTENSIBLE this can be smaller than the
  // stored sample size (for example 24 valid bits stored in 32).
  bitDepth: number;
  audioFormat: WavAudioFormat;
  // Size of the audio data in bytes (whole frames only).
  dataBytes: number;
  durationMs: number;
  // Byte offset of the first sample in the file.
  dataOffset: number;
  // Bytes per frame (one sample for every channel).
  blockAlign: number;
  frameCount: number;
};

// Thrown for input that is not a well-formed PCM or IEEE float WAV file.
// It is an AppError("INVALID_AUDIO"); `reason` is a stable code for tests and logs.
export class WavParseError extends AppError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super("INVALID_AUDIO", message, { reason });
    this.name = "WavParseError";
    this.reason = reason;
  }
}

// True for a WavParseError of this module and for an error of the same shape
// made by another copy of the class.
export function isWavParseError(value: unknown): value is WavParseError {
  if (value instanceof WavParseError) return true;
  return (
    value instanceof Error &&
    value.name === "WavParseError" &&
    (value as { code?: unknown }).code === "INVALID_AUDIO" &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function isWavBuffer(buffer: Buffer | Uint8Array): boolean {
  if (buffer.length < 12) return false;
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.length);
  return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE";
}

// Parses the header of a PCM or IEEE float WAV file, including
// WAVE_FORMAT_EXTENSIBLE, and skips other chunks (LIST, fact, ...) before `data`.
//
// By default the buffer must hold the whole file, and a `data` chunk that declares
// more bytes than the buffer contains is rejected as truncated. With
// `headerOnly: true` the buffer may be just the beginning of a file, and the
// declared data size is returned as is.
export function parseWavHeader(
  input: Buffer | Uint8Array,
  options: { headerOnly?: boolean } = {},
): WavInfo {
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.length);

  if (buffer.length < 12) {
    throw new WavParseError("too_short", "The file is too short to be a WAV file.");
  }
  if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WAVE") {
    throw new WavParseError("not_wav", "The file is not a RIFF/WAVE file.");
  }

  let format:
    | { audioFormat: WavAudioFormat; channels: number; sampleRateHz: number; blockAlign: number; bitDepth: number }
    | undefined;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("latin1", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === "fmt ") {
      if (chunkSize < 16 || bodyStart + 16 > buffer.length) {
        throw new WavParseError("bad_fmt_chunk", "The WAV format chunk is incomplete.");
      }
      let formatTag = buffer.readUInt16LE(bodyStart);
      const channels = buffer.readUInt16LE(bodyStart + 2);
      const sampleRateHz = buffer.readUInt32LE(bodyStart + 4);
      const blockAlign = buffer.readUInt16LE(bodyStart + 12);
      const containerBits = buffer.readUInt16LE(bodyStart + 14);
      let bitDepth = containerBits;

      if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
        if (chunkSize < 40 || bodyStart + 40 > buffer.length) {
          throw new WavParseError("bad_fmt_chunk", "The WAV extensible format chunk is incomplete.");
        }
        const validBits = buffer.readUInt16LE(bodyStart + 18);
        // The first two bytes of the sub-format GUID hold the real format tag.
        formatTag = buffer.readUInt16LE(bodyStart + 24);
        if (validBits > 0 && validBits <= containerBits) bitDepth = validBits;
      }

      let audioFormat: WavAudioFormat;
      if (formatTag === WAVE_FORMAT_PCM) audioFormat = "pcm";
      else if (formatTag === WAVE_FORMAT_IEEE_FLOAT) audioFormat = "ieee_float";
      else {
        throw new WavParseError(
          "unsupported_encoding",
          "The WAV file uses an encoding other than PCM or IEEE float.",
        );
      }

      if (channels < 1 || sampleRateHz < 1) {
        throw new WavParseError("bad_fmt_chunk", "The WAV file declares no channels or no sample rate.");
      }
      if (containerBits < 8 || containerBits % 8 !== 0 || containerBits > 64) {
        throw new WavParseError("bad_fmt_chunk", "The WAV file declares an unsupported sample size.");
      }
      if (audioFormat === "ieee_float" && containerBits !== 32 && containerBits !== 64) {
        throw new WavParseError("bad_fmt_chunk", "The WAV file declares an unsupported float sample size.");
      }
      if (blockAlign !== channels * (containerBits / 8)) {
        throw new WavParseError("bad_fmt_chunk", "The WAV frame size does not match its channels and sample size.");
      }
      format = { audioFormat, channels, sampleRateHz, blockAlign, bitDepth };
    } else if (chunkId === "data") {
      if (!format) {
        throw new WavParseError("missing_fmt_chunk", "The WAV file has audio data before its format chunk.");
      }
      const available = buffer.length - bodyStart;
      if (!options.headerOnly && chunkSize > available) {
        throw new WavParseError("truncated", "The WAV file is truncated: audio data is missing.");
      }
      const frameCount = Math.floor(chunkSize / format.blockAlign);
      return {
        sampleRateHz: format.sampleRateHz,
        channels: format.channels,
        bitDepth: format.bitDepth,
        audioFormat: format.audioFormat,
        dataBytes: frameCount * format.blockAlign,
        durationMs: Math.round((frameCount / format.sampleRateHz) * 1000),
        dataOffset: bodyStart,
        blockAlign: format.blockAlign,
        frameCount,
      };
    }

    // Chunks are padded to an even number of bytes.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!format) {
    throw new WavParseError("missing_fmt_chunk", "The WAV file has no format chunk.");
  }
  throw new WavParseError("missing_data_chunk", "The WAV file has no audio data chunk.");
}

// Encodes interleaved float samples (range -1 to 1) as a 16-bit PCM WAV file.
// Values outside the range are limited to it.
export function encodeWavPcm16(input: {
  samples: Float32Array;
  sampleRateHz: number;
  channels: number;
}): Buffer {
  const { samples, sampleRateHz, channels } = input;
  if (!Number.isInteger(sampleRateHz) || sampleRateHz < 1) {
    throw new AppError("VALIDATION_ERROR", "sampleRateHz must be a positive integer.");
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 65535) {
    throw new AppError("VALIDATION_ERROR", "channels must be a positive integer.");
  }
  if (samples.length % channels !== 0) {
    throw new AppError("VALIDATION_ERROR", "The number of samples must be a multiple of the channel count.");
  }

  const blockAlign = channels * 2;
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "latin1");
  buffer.write("fmt ", 12, "latin1");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRateHz, 24);
  buffer.writeUInt32LE(sampleRateHz * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "latin1");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    const limited = Number.isNaN(value) ? 0 : Math.max(-1, Math.min(1, value));
    const scaled = limited < 0 ? Math.round(limited * 32768) : Math.round(limited * 32767);
    buffer.writeInt16LE(scaled, 44 + index * 2);
  }
  return buffer;
}

// A 16-bit PCM WAV file holding a sine tone. Used by tests, the development seed
// and the mock speech synthesizer. Defaults: mono, amplitude 0.5.
export function generateSineWav(input: {
  durationMs: number;
  sampleRateHz: number;
  frequencyHz: number;
  amplitude?: number;
  channels?: number;
}): Buffer {
  const channels = input.channels ?? 1;
  const amplitude = input.amplitude ?? 0.5;
  const frameCount = Math.max(0, Math.round((input.durationMs / 1000) * input.sampleRateHz));
  const samples = new Float32Array(frameCount * channels);
  const step = (2 * Math.PI * input.frequencyHz) / input.sampleRateHz;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const value = amplitude * Math.sin(step * frame);
    for (let channel = 0; channel < channels; channel += 1) {
      samples[frame * channels + channel] = value;
    }
  }
  return encodeWavPcm16({ samples, sampleRateHz: input.sampleRateHz, channels });
}
