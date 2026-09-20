// audio.js - browser microphone capture and agent playback (needs a real browser).
//
// Capture: getUserMedia with echoCancellation ON and noiseSuppression OFF (the
// server already cleans the signal; a second denoiser hurts accuracy). The
// browser's echo canceller is what lets this work on laptop speakers.
// Playback: agent audio is 24 kHz PCM16; each chunk is scheduled back-to-back so
// there are no gaps, and everything can be flushed instantly on barge-in.

const TARGET_RATE = 24000;

export function toBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class AudioIO {
  constructor({ onChunk, chunkMs = 50 }) {
    this.onChunk = onChunk;
    this.chunkSamples = Math.round((TARGET_RATE * chunkMs) / 1000);
    this.ctx = null;
    this.stream = null;
    this.playbackTime = 0;
    this.playing = new Set();
  }

  /** Must be called from a click handler (browsers block audio otherwise). */
  async start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, channelCount: 1 },
    });

    await this.ctx.audioWorklet.addModule(new URL("./pcm-processor.js", import.meta.url));
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.ctx, "pcm-processor", {
      processorOptions: {
        inputSampleRate: this.ctx.sampleRate,
        targetSampleRate: TARGET_RATE,
        chunkSamples: this.chunkSamples,
      },
    });
    this.worklet.port.onmessage = (event) => this.onChunk(toBase64(new Uint8Array(event.data)));

    // Route through a muted gain node so the graph is "pulled" without echoing the mic.
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.worklet);
    this.worklet.connect(this.mute);
    this.mute.connect(this.ctx.destination);
    this.playbackTime = this.ctx.currentTime;
  }

  /** Queue one base64 PCM16 chunk from the agent for gapless playback. */
  play(base64) {
    if (!this.ctx) return;
    const bytes = fromBase64(base64);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (samples.length === 0) return;
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) floats[i] = samples[i] / 32768;

    const buffer = this.ctx.createBuffer(1, floats.length, TARGET_RATE);
    buffer.getChannelData(0).set(floats);
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    node.onended = () => this.playing.delete(node);
    this.playbackTime = Math.max(this.playbackTime, this.ctx.currentTime + 0.02);
    node.start(this.playbackTime);
    this.playbackTime += buffer.duration;
    this.playing.add(node);
  }

  /** Stop everything queued (the user interrupted the agent). */
  flush() {
    for (const node of this.playing) {
      try { node.stop(); } catch { /* already stopped */ }
    }
    this.playing.clear();
    if (this.ctx) this.playbackTime = this.ctx.currentTime;
  }

  async stop() {
    this.flush();
    this.stream?.getTracks().forEach((track) => track.stop());
    try { await this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
    this.stream = null;
  }
}
