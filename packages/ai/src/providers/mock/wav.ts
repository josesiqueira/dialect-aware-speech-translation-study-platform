// Minimal PCM WAV encoder for the mock speech synthesizer. Kept inside this
// package so that the mock provider has no dependency on the storage package.

export type SineWavOptions = {
  frequencyHz: number;
  durationSeconds: number;
  sampleRate?: number;
  // Peak amplitude from 0 to 1. Default 0.2 (quiet).
  amplitude?: number;
};

// Encodes 16-bit signed little-endian mono samples as a RIFF WAVE file with
// the standard 44-byte header.
export function encodePcm16Wav(samples: Int16Array, sampleRate: number): Buffer {
  const channels = 1;
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // size of the fmt chunk
  buffer.writeUInt16LE(1, 20); // audio format 1 = PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(8 * bytesPerSample, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i] ?? 0, 44 + i * bytesPerSample);
  }
  return buffer;
}

export function sineWav(options: SineWavOptions): Buffer {
  const sampleRate = options.sampleRate ?? 16_000;
  const amplitude = Math.min(Math.max(options.amplitude ?? 0.2, 0), 1);
  const count = Math.max(1, Math.round(options.durationSeconds * sampleRate));
  const samples = new Int16Array(count);
  // Short fade in and out (10 ms) so the tone does not click.
  const fade = Math.min(Math.round(sampleRate * 0.01), Math.floor(count / 2));
  for (let i = 0; i < count; i += 1) {
    const envelope = fade === 0 ? 1 : Math.min(1, i / fade, (count - 1 - i) / fade);
    const value = Math.sin((2 * Math.PI * options.frequencyHz * i) / sampleRate);
    samples[i] = Math.round(value * amplitude * envelope * 32767);
  }
  return encodePcm16Wav(samples, sampleRate);
}
