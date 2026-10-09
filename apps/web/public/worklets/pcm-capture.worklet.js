// AudioWorklet processor of the research recorder (spec 31.1).
// Static code only. This file runs on the audio rendering thread.
//
// It copies channel 0 of its input into a buffer and sends each full buffer to
// the main thread through the message port. It does not change the samples in
// any way and writes nothing to its output, so the microphone is never audible.
//
// Messages from the main thread:
//   { type: "start" }  begin capturing with the next render block
//   { type: "stop" }   send what is buffered, then { type: "done", ... }
// Messages to the main thread:
//   { type: "chunk", samples: Float32Array }           (the buffer is transferred)
//   { type: "done", frames, inputChannelCount }
//
// Usage: new AudioWorkletNode(context, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1 })

// 16 render blocks of 128 frames: about 43 ms at 48 kHz per message.
const CHUNK_FRAMES = 2048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capturing = false;
    this.finished = false;
    this.buffer = new Float32Array(CHUNK_FRAMES);
    this.filled = 0;
    this.frames = 0;
    this.inputChannelCount = 0;
    this.port.onmessage = (event) => {
      const type = event.data && event.data.type;
      if (type === "start" && !this.finished) {
        this.capturing = true;
      } else if (type === "stop" && !this.finished) {
        this.capturing = false;
        this.finished = true;
        this.flush();
        this.port.postMessage({ type: "done", frames: this.frames, inputChannelCount: this.inputChannelCount });
      }
    };
  }

  flush() {
    if (this.filled === 0) return;
    const samples = this.buffer.slice(0, this.filled);
    this.port.postMessage({ type: "chunk", samples }, [samples.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    if (this.finished) return false;
    if (!this.capturing) return true;
    const input = inputs[0];
    // No channels means that nothing is connected to the input at the moment.
    if (!input || input.length === 0) return true;
    if (input.length > this.inputChannelCount) this.inputChannelCount = input.length;
    const channel = input[0];
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, CHUNK_FRAMES - this.filled);
      this.buffer.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === CHUNK_FRAMES) this.flush();
    }
    this.frames += channel.length;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
