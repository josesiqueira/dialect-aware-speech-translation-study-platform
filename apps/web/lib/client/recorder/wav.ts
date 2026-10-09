// PCM WAV encoding for the research recorder (spec 31.1). Pure functions and one
// small collector class, with no browser API, so everything here is unit tested.
//
// Conversion from the Web Audio float samples to integer PCM:
//   value = round(sample * 2^(bits-1)), limited to [-2^(bits-1), 2^(bits-1) - 1]
// One linear scale for the whole range (the same rule ffmpeg uses), so the
// signal is not bent around zero. Only a sample at or beyond full scale is
// limited, and those samples are counted. No dither is added and nothing else
// is done to the signal: no gain, no normalization, no trimming (spec 85).
import type { PcmBitDepth } from "./types";

export const WAV_HEADER_BYTES = 44;
export const WAV_MIME_TYPE = "audio/wav";

/** Largest data size a RIFF file can declare (32-bit sizes). */
const MAX_WAV_DATA_BYTES = 0xffffffff - 36;

export function bytesPerSample(bitDepth: PcmBitDepth): number {
  return bitDepth / 8;
}

/** One float sample to a signed integer of the given bit depth. NaN becomes 0. */
export function floatToPcmSample(sample: number, bitDepth: PcmBitDepth): number {
  if (Number.isNaN(sample)) return 0;
  const scale = bitDepth === 16 ? 32768 : 8388608;
  const value = Math.round(sample * scale);
  if (value > scale - 1) return scale - 1;
  if (value < -scale) return -scale;
  return value;
}

export interface ConvertedBlock {
  /** Little-endian PCM bytes. */
  bytes: Uint8Array;
  /** Largest absolute value in the block before conversion. */
  peak: number;
  /** Number of samples at or beyond full scale (absolute value of 1 or more). */
  clippedSamples: number;
}

/** Converts a block of float samples to little-endian PCM bytes and measures its peak. */
export function convertBlock(samples: Float32Array, bitDepth: PcmBitDepth): ConvertedBlock {
  const width = bytesPerSample(bitDepth);
  const bytes = new Uint8Array(samples.length * width);
  let peak = 0;
  let clippedSamples = 0;
  for (let i = 0, offset = 0; i < samples.length; i += 1, offset += width) {
    const sample = samples[i];
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= 1) clippedSamples += 1;
    const value = floatToPcmSample(sample, bitDepth);
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    if (width === 3) bytes[offset + 2] = (value >> 16) & 0xff;
  }
  return { bytes, peak, clippedSamples };
}

/**
 * The 44-byte RIFF/WAVE header for integer PCM. `dataBytes` must be the exact
 * number of audio bytes that follow: the server rejects any other value.
 */
export function buildWavHeader(input: {
  sampleRateHz: number;
  channels: number;
  bitDepth: PcmBitDepth;
  dataBytes: number;
}): Uint8Array {
  const { sampleRateHz, channels, bitDepth, dataBytes } = input;
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new RangeError(`WAV sample rate must be a positive integer, got ${sampleRateHz}`);
  }
  const blockAlign = channels * bytesPerSample(bitDepth);
  if (dataBytes < 0 || dataBytes % blockAlign !== 0 || dataBytes > MAX_WAV_DATA_BYTES) {
    throw new RangeError(`WAV data size ${dataBytes} is not valid for a block size of ${blockAlign}`);
  }
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) header[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // size of the fmt chunk
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * blockAlign, true); // bytes per second
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/** Duration from a sample count. The recorder never measures time with a clock. */
export function durationMsFromFrames(frames: number, sampleRateHz: number): number {
  return (frames / sampleRateHz) * 1000;
}

/** Number of whole frames allowed by a duration limit. */
export function maxFramesForDuration(maxDurationMs: number, sampleRateHz: number): number {
  return Math.floor((maxDurationMs * sampleRateHz) / 1000);
}

/** Joins byte chunks with one allocation. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export interface PcmCollectorOptions {
  sampleRateHz: number;
  bitDepth: PcmBitDepth;
  /** Hard limit in frames. Samples beyond it are not stored. */
  maxFrames: number;
}

export interface AppendResult {
  /** Frames of this block that were stored. */
  acceptedFrames: number;
  /** Peak of the stored part of this block. */
  peak: number;
  /** True once the limit is reached. Further blocks are ignored. */
  limitReached: boolean;
}

/**
 * Collects mono blocks as they arrive from the audio thread. Each block is
 * converted to PCM bytes once and kept as its own chunk, so memory use grows
 * linearly and nothing is copied again until the file is assembled. The file is
 * a list of parts (header first) that a Blob joins without a JavaScript copy.
 */
export class PcmChunkCollector {
  readonly sampleRateHz: number;
  readonly bitDepth: PcmBitDepth;
  readonly maxFrames: number;
  private readonly chunks: Uint8Array[] = [];
  private frameCount = 0;
  private peakValue = 0;
  private clippedCount = 0;

  constructor(options: PcmCollectorOptions) {
    this.sampleRateHz = options.sampleRateHz;
    this.bitDepth = options.bitDepth;
    this.maxFrames = Math.max(0, Math.floor(options.maxFrames));
  }

  get frames(): number {
    return this.frameCount;
  }

  get peak(): number {
    return this.peakValue;
  }

  get clippedSamples(): number {
    return this.clippedCount;
  }

  get durationMs(): number {
    return durationMsFromFrames(this.frameCount, this.sampleRateHz);
  }

  get limitReached(): boolean {
    return this.frameCount >= this.maxFrames;
  }

  get dataBytes(): number {
    return this.frameCount * bytesPerSample(this.bitDepth);
  }

  append(samples: Float32Array): AppendResult {
    const room = this.maxFrames - this.frameCount;
    if (room <= 0 || samples.length === 0) {
      return { acceptedFrames: 0, peak: 0, limitReached: this.limitReached };
    }
    const block = samples.length > room ? samples.subarray(0, room) : samples;
    const converted = convertBlock(block, this.bitDepth);
    this.chunks.push(converted.bytes);
    this.frameCount += block.length;
    this.clippedCount += converted.clippedSamples;
    if (converted.peak > this.peakValue) this.peakValue = converted.peak;
    return { acceptedFrames: block.length, peak: converted.peak, limitReached: this.limitReached };
  }

  /** Header (with the final sizes) followed by the audio chunks. */
  toWavParts(): Uint8Array[] {
    const header = buildWavHeader({
      sampleRateHz: this.sampleRateHz,
      channels: 1,
      bitDepth: this.bitDepth,
      dataBytes: this.dataBytes,
    });
    return [header, ...this.chunks];
  }

  /** The whole file as one array. For tests and small recordings; the recorder uses toWavParts with a Blob. */
  toWavBytes(): Uint8Array {
    return concatBytes(this.toWavParts());
  }

  /** Drops the audio from memory. */
  clear(): void {
    this.chunks.length = 0;
    this.frameCount = 0;
    this.peakValue = 0;
    this.clippedCount = 0;
  }
}

/** Encodes one mono float buffer as a complete WAV file. */
export function encodeWavMono(samples: Float32Array, sampleRateHz: number, bitDepth: PcmBitDepth = 16): Uint8Array {
  const collector = new PcmChunkCollector({ sampleRateHz, bitDepth, maxFrames: samples.length });
  collector.append(samples);
  return collector.toWavBytes();
}
