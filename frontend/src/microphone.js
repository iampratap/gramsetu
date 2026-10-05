export const BROADCAST_RATE = 16000;
const FRAME_SAMPLES = 640; // 40 ms at 16 kHz

const TAP_WORKLET = `
class GramSetuTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("gramsetu-tap", GramSetuTap);
`;

/** Averages each run of input samples into one output sample, which also filters out most aliasing. */
class Downsampler {
  constructor(inputRate, outputRate) {
    this.ratio = inputRate / outputRate;
    this.position = 0;
    this.next = this.ratio;
    this.sum = 0;
    this.count = 0;
  }

  push(input, out) {
    for (let index = 0; index < input.length; index += 1) {
      this.sum += input[index];
      this.count += 1;
      this.position += 1;
      if (this.position >= this.next) {
        out.push(this.sum / this.count);
        this.sum = 0;
        this.count = 0;
        this.next += this.ratio;
      }
    }
    if (this.position > 1e6) {
      this.position -= 1e6;
      this.next -= 1e6;
    }
  }
}

export function microphoneSupported() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);
}

export function audioCaptureSupported() {
  return Boolean(window.isSecureContext && window.AudioWorkletNode);
}

/**
 * Opens the broadcast mixer and calls onFrame with 16 kHz mono 16-bit PCM (ArrayBuffer, 40 ms each)
 * and onLevel with a 0..1 loudness value for a meter. The microphone (optional) and any clip
 * started with playClip are mixed into the same stream; silence is sent while nothing is audible.
 */
export async function openBroadcastInput({ microphone = true, onFrame, onLevel }) {
  const stream = microphone
    ? await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    : null;
  const context = new AudioContext();
  try {
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  } catch (err) {
    stream?.getTracks().forEach((track) => track.stop());
    context.close();
    throw err;
  }
  const tap = new AudioWorkletNode(context, "gramsetu-tap", { channelCount: 1, channelCountMode: "explicit" });
  const silent = context.createGain();
  silent.gain.value = 0;
  tap.connect(silent);
  silent.connect(context.destination);

  // Keeps the tap running (and frames flowing) while neither the mic nor a clip is connected.
  const keepAlive = context.createConstantSource();
  keepAlive.offset.value = 0;
  keepAlive.connect(tap);
  keepAlive.start();

  const micGain = context.createGain();
  micGain.connect(tap);
  const source = stream ? context.createMediaStreamSource(stream) : null;
  source?.connect(micGain);

  const monitor = context.createGain();
  monitor.gain.value = 0;
  monitor.connect(context.destination);
  const clipGain = context.createGain();
  clipGain.connect(tap);
  clipGain.connect(monitor);
  let clip = null;

  const downsampler = new Downsampler(context.sampleRate, BROADCAST_RATE);
  let samples = [];
  let peak = 0;
  let lastLevel = 0;

  tap.port.onmessage = (event) => {
    const input = event.data;
    for (let index = 0; index < input.length; index += 1) peak = Math.max(peak, Math.abs(input[index]));
    const now = performance.now();
    if (now - lastLevel > 80) {
      onLevel?.(Math.min(1, peak));
      peak = 0;
      lastLevel = now;
    }
    downsampler.push(input, samples);
    while (samples.length >= FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let index = 0; index < FRAME_SAMPLES; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        frame[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
      samples = samples.slice(FRAME_SAMPLES);
      onFrame(frame.buffer);
    }
  };

  if (context.state === "suspended") await context.resume();

  function detachSource(entry) {
    const node = entry.node;
    if (!node) return;
    entry.node = null;
    node.onended = null;
    try {
      node.stop();
    } catch {
      // already stopped
    }
    node.disconnect();
  }

  // A buffer source cannot pause or seek, so each resume/seek starts a fresh one at the wanted offset.
  function startSource(entry, offset) {
    detachSource(entry);
    const node = context.createBufferSource();
    node.buffer = entry.buffer;
    node.connect(clipGain);
    node.onended = () => {
      if (entry.node !== node) return;
      entry.node = null;
      if (clip === entry) clip = null;
      node.disconnect();
      entry.onEnded?.();
    };
    entry.node = node;
    entry.paused = false;
    entry.startedAt = context.currentTime - offset;
    node.start(0, offset);
  }

  function clipPosition() {
    if (!clip) return 0;
    if (clip.paused) return clip.offset;
    return Math.min(clip.duration, Math.max(0, context.currentTime - clip.startedAt));
  }

  function stopClip() {
    if (!clip) return;
    detachSource(clip);
    clip = null;
  }

  return {
    hasMicrophone: Boolean(stream),
    setMuted(value) {
      micGain.gain.value = value ? 0 : 1;
    },
    /** Hear clips in this browser too (off by default so the microphone does not pick them up twice). */
    setMonitor(value) {
      monitor.gain.value = value ? 1 : 0;
    },
    /** Decodes any browser-supported audio file and starts it; resolves with { duration } once playing. */
    async playClip(data, { onEnded } = {}) {
      const buffer = await context.decodeAudioData(data);
      stopClip();
      const entry = { buffer, duration: buffer.duration, node: null, paused: false, offset: 0, startedAt: 0, onEnded };
      clip = entry;
      startSource(entry, 0);
      return { duration: buffer.duration };
    },
    stopClip,
    clipPosition,
    clipPaused() {
      return Boolean(clip?.paused);
    },
    pauseClip() {
      if (!clip || clip.paused) return;
      clip.offset = clipPosition();
      detachSource(clip);
      clip.paused = true;
    },
    resumeClip() {
      if (!clip?.paused) return;
      startSource(clip, Math.min(clip.offset, Math.max(0, clip.duration - 0.05)));
    },
    seekClip(seconds) {
      if (!clip) return;
      const offset = Math.min(Math.max(0, seconds), Math.max(0, clip.duration - 0.05));
      if (clip.paused) clip.offset = offset;
      else startSource(clip, offset);
    },
    /** Level of clips in the broadcast mix; 1 is the file's own level. */
    setClipVolume(value) {
      clipGain.gain.setTargetAtTime(value, context.currentTime, 0.02);
    },
    close() {
      stopClip();
      clipGain.disconnect();
      tap.port.onmessage = null;
      keepAlive.stop();
      keepAlive.disconnect();
      source?.disconnect();
      micGain.disconnect();
      monitor.disconnect();
      tap.disconnect();
      silent.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      context.close();
    },
  };
}
