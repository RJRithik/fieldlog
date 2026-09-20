// pcm-processor.js - AudioWorklet: microphone -> 24 kHz mono PCM16 in ~50 ms chunks.
//
// The AudioContext runs at the device's native rate (44.1/48 kHz). Forcing 24 kHz
// only works on Chromium and breaks echo cancellation on Firefox / garbles audio
// on Safari, so we resample here instead (linear interpolation, which is plenty
// for speech).
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate, targetSampleRate, chunkSamples } = options.processorOptions;
    this.ratio = inputSampleRate / targetSampleRate;
    this.chunkSamples = chunkSamples;
    this.pos = 0;   // read position, relative to the current block (>= -1)
    this.prev = 0;  // last sample of the previous block
    this.out = new Int16Array(chunkSamples);
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    let pos = this.pos;
    while (pos < input.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const s0 = i < 0 ? this.prev : input[i];
      const s1 = input[i + 1];
      const sample = s0 + (s1 - s0) * frac;
      this.out[this.count++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      if (this.count === this.chunkSamples) {
        const chunk = this.out.slice(0).buffer;
        this.port.postMessage(chunk, [chunk]);
        this.count = 0;
      }
      pos += this.ratio;
    }
    this.pos = pos - input.length;
    this.prev = input[input.length - 1];
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
