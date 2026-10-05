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

  function stopClip() {
    if (!clip) return;
    const current = clip;
    clip = null;
    current.node.onended = null;
    try {
      current.node.stop();
    } catch {
      // already stopped
    }
    current.node.disconnect();
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
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(tap);
      node.connect(monitor);
      const entry = { node, startedAt: context.currentTime, duration: buffer.duration };
      node.onended = () => {
        if (clip !== entry) return;
        clip = null;
        node.disconnect();
        onEnded?.();
      };
      clip = entry;
      node.start();
      return { duration: buffer.duration };
    },
    stopClip,
    clipPosition() {
      return clip ? Math.min(clip.duration, context.currentTime - clip.startedAt) : 0;
    },
    close() {
      stopClip();
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
