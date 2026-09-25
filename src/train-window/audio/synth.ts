import { Rng } from "../core/random.ts";

/** Builds a one-shot sound into an offline context, drawing its variation from `rng`. */
export type Build = (ctx: OfflineAudioContext, noise: AudioBuffer, rng: Rng) => void;

export type NoiseColor = "white" | "pink" | "brown";

/** A looping mono noise buffer. */
export function noiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  color: NoiseColor,
  seed: number,
): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const r = new Rng(seed);
  // Paul Kellet's pink filter state.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let brown = 0;
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const white = r.next() * 2 - 1;
    let v: number;
    if (color === "white") {
      v = white;
    } else if (color === "pink") {
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
    } else {
      brown = (brown + 0.02 * white) / 1.02;
      v = brown;
    }
    data[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  // Normalize, and crossfade the ends so the loop is seamless.
  const fade = Math.min(length >> 3, Math.floor(ctx.sampleRate * 0.05));
  for (let i = 0; i < length; i++) {
    data[i] /= peak;
  }
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const j = length - fade + i;
    data[j] = data[j] * (1 - t) + data[i] * t;
  }
  return buffer;
}

/** A stereo impulse response: exponentially decaying noise with a darkening tail. */
export function impulseResponse(
  ctx: BaseAudioContext,
  seconds: number,
  decay: number,
  seed: number,
  brightness = 0.5,
): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const r = new Rng(seed);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, decay);
      const k = brightness * (1 - t * 0.8);
      lp += (r.next() * 2 - 1 - lp) * k;
      data[i] = lp * env;
    }
  }
  return buffer;
}

/** Renders a short sound offline. `build` wires nodes into `ctx.destination`. */
export async function renderOffline(
  sampleRate: number,
  seconds: number,
  build: (ctx: OfflineAudioContext) => void,
  channels = 1,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: channels,
    length: Math.ceil(sampleRate * seconds),
    sampleRate,
  });
  build(ctx);
  return ctx.startRendering();
}

/** Gain node with a percussive envelope: linear attack, exponential decay. */
export function envelope(
  ctx: BaseAudioContext,
  start: number,
  attack: number,
  decay: number,
  peak: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(peak, start + attack);
  g.gain.setTargetAtTime(0, start + attack, decay / 4);
  return g;
}

/** A one-shot noise source (not looped), started at `start`. */
export function noiseBurst(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  start: number,
  duration: number,
  offset = 0,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.start(start, offset % Math.max(0.001, buffer.duration - duration - 0.01), duration);
  return src;
}

export function filter(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  frequency: number,
  q = 0.707,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = q;
  return f;
}

export function gainNode(ctx: BaseAudioContext, gain: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = gain;
  return g;
}

/** Connects nodes in series; the last one may be an AudioParam (for modulation). */
export function chain(...nodes: [AudioNode, ...AudioNode[], AudioNode | AudioParam]): void {
  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i] as AudioNode;
    const to = nodes[i + 1];
    // connect() has separate overloads for nodes and params.
    if (to instanceof AudioParam) {
      from.connect(to);
    } else {
      from.connect(to);
    }
  }
}
