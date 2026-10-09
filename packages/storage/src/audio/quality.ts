// Lightweight signal checks on a WAV file (spec 84, 85).
// The values only inform flags that a researcher reviews. Nothing is excluded
// automatically and the audio itself is never changed.
import { parseWavHeader, type WavInfo } from "./wav";

// Same shape as UtteranceQuality in packages/db/src/json-types.ts.
export type WavQuality = {
  // Largest absolute sample value, 0 to 1 (1 is full scale).
  peakAmplitude?: number;
  // Share of samples at or beyond full scale, 0 to 1.
  clippedSampleRatio?: number;
  // Share of 20 ms windows whose level is below SILENCE_THRESHOLD_DB, 0 to 1.
  silenceRatio?: number;
  // Level of the whole file in dB relative to full scale. Limited to RMS_FLOOR_DB
  // for digital silence so the value can be stored as JSON.
  rmsDb?: number;
  warnings?: string[];
};

export const QUALITY_WARNINGS = {
  possibleClipping: "possible_clipping",
  lowSignal: "low_signal",
  mostlySilent: "mostly_silent",
  noAudioData: "no_audio_data",
  unsupportedSampleFormat: "unsupported_sample_format",
} as const;

export const SILENCE_THRESHOLD_DB = -50;
export const LOW_SIGNAL_THRESHOLD_DB = -40;
export const RMS_FLOOR_DB = -120;
export const CLIPPING_WARNING_RATIO = 0.001;
export const MOSTLY_SILENT_RATIO = 0.8;
const WINDOW_MS = 20;

function sampleReader(buffer: Buffer, wav: WavInfo): ((offset: number) => number) | null {
  const bytesPerSample = wav.blockAlign / wav.channels;
  if (wav.audioFormat === "ieee_float") {
    return bytesPerSample === 4 ? (offset) => buffer.readFloatLE(offset) : null;
  }
  switch (bytesPerSample) {
    case 2:
      return (offset) => buffer.readInt16LE(offset) / 32768;
    case 3:
      return (offset) => buffer.readIntLE(offset, 3) / 8388608;
    case 4:
      return (offset) => buffer.readInt32LE(offset) / 2147483648;
    default:
      return null;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Supports 16, 24 and 32 bit PCM and 32 bit float. Other sample formats return
// only an "unsupported_sample_format" warning. Throws WavParseError for input
// that is not a WAV file.
export function computeWavQuality(input: Buffer | Uint8Array): WavQuality {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.length);
  const wav = parseWavHeader(buffer);
  const read = sampleReader(buffer, wav);
  if (!read) return { warnings: [QUALITY_WARNINGS.unsupportedSampleFormat] };

  const bytesPerSample = wav.blockAlign / wav.channels;
  const sampleCount = wav.frameCount * wav.channels;
  if (sampleCount === 0) return { warnings: [QUALITY_WARNINGS.noAudioData] };

  // Integer PCM clips at the largest and smallest code. Float clips at 1.0.
  const positiveLimit = wav.audioFormat === "ieee_float" ? 1 : 1 - 1 / 2 ** (bytesPerSample * 8 - 1);
  const silenceLinear = 10 ** (SILENCE_THRESHOLD_DB / 20);
  const framesPerWindow = Math.max(1, Math.round((wav.sampleRateHz * WINDOW_MS) / 1000));

  let peak = 0;
  let clipped = 0;
  let sumSquares = 0;
  let windowSumSquares = 0;
  let windowSamples = 0;
  let windows = 0;
  let silentWindows = 0;

  const closeWindow = (): void => {
    if (windowSamples === 0) return;
    windows += 1;
    if (Math.sqrt(windowSumSquares / windowSamples) < silenceLinear) silentWindows += 1;
    windowSumSquares = 0;
    windowSamples = 0;
  };

  for (let frame = 0; frame < wav.frameCount; frame += 1) {
    for (let channel = 0; channel < wav.channels; channel += 1) {
      const raw = read(wav.dataOffset + frame * wav.blockAlign + channel * bytesPerSample);
      const value = Number.isFinite(raw) ? raw : 0;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      if (value >= positiveLimit || value <= -1) clipped += 1;
      const square = value * value;
      sumSquares += square;
      windowSumSquares += square;
      windowSamples += 1;
    }
    if ((frame + 1) % framesPerWindow === 0) closeWindow();
  }
  closeWindow();

  const rms = Math.sqrt(sumSquares / sampleCount);
  const rmsDb = rms > 0 ? Math.max(RMS_FLOOR_DB, 20 * Math.log10(rms)) : RMS_FLOOR_DB;
  const clippedSampleRatio = clipped / sampleCount;
  const silenceRatio = windows === 0 ? 0 : silentWindows / windows;

  const warnings: string[] = [];
  if (clippedSampleRatio > CLIPPING_WARNING_RATIO) warnings.push(QUALITY_WARNINGS.possibleClipping);
  if (rmsDb < LOW_SIGNAL_THRESHOLD_DB) warnings.push(QUALITY_WARNINGS.lowSignal);
  if (silenceRatio > MOSTLY_SILENT_RATIO) warnings.push(QUALITY_WARNINGS.mostlySilent);

  return {
    peakAmplitude: round(peak, 6),
    clippedSampleRatio: round(clippedSampleRatio, 6),
    silenceRatio: round(silenceRatio, 4),
    rmsDb: round(rmsDb, 2),
    warnings,
  };
}
