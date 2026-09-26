import { chain, filter, gainNode, noiseBuffer } from "../../shared/audio/synth.ts";
import type { Rng } from "../../shared/core/random.ts";

/**
 * A voice: a train of glottal pulses at a pitch following `contour`
 * (seconds, Hz), with a little jitter, through the resonances of a throat
 * (`formants`, Hz and bandwidth), and breath mixed in. Not an oscillator's
 * tone: the pulses are shaped one by one, as a larynx makes them.
 */
export function voice(
  ctx: OfflineAudioContext,
  r: Rng,
  start: number,
  contour: readonly (readonly [number, number])[],
  formants: readonly (readonly [number, number, number])[],
  breath: number,
  out: AudioNode,
  roughness = 0.03,
): void {
  const rate = ctx.sampleRate;
  const dur = contour[contour.length - 1][0];
  const length = Math.ceil(rate * (dur + 0.05));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  const pitchAt = (t: number) => {
    for (let i = 1; i < contour.length; i++) {
      if (t <= contour[i][0]) {
        const [t0, f0] = contour[i - 1];
        const [t1, f1] = contour[i];
        return f0 + ((f1 - f0) * (t - t0)) / Math.max(1e-6, t1 - t0);
      }
    }
    return contour[contour.length - 1][1];
  };
  // Rosenberg pulses, one per period, with jitter in their length and height.
  let t = 0;
  while (t < dur) {
    const f = pitchAt(t) * (1 + r.range(-roughness, roughness));
    const period = 1 / f;
    const open = period * 0.6;
    const amp = 1 + r.range(-roughness * 3, roughness * 3);
    const i0 = Math.floor(t * rate);
    const n = Math.floor(open * rate);
    for (let i = 0; i < n && i0 + i < length; i++) {
      const x = i / n;
      // Rising half-cosine then a steep close: the source of a voiced sound.
      const pulse =
        x < 0.7 ? 0.5 * (1 - Math.cos((Math.PI * x) / 0.7)) : Math.cos((Math.PI * (x - 0.7)) / 0.6);
      data[i0 + i] += pulse * amp;
    }
    t += period;
  }
  // Soft edges on the whole utterance.
  for (let i = 0; i < length; i++) {
    const s = i / rate;
    data[i] *= Math.min(1, s / 0.03) * Math.min(1, Math.max(0, dur - s) / 0.08);
  }
  // The pulses' spectrum is steep; differentiate once for the brightness of a real voice.
  let prev = 0;
  for (let i = 0; i < length; i++) {
    const v = data[i];
    data[i] = v - prev;
    prev = v;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.start(start);
  for (const [freq, q, level] of formants) {
    chain(src, filter(ctx, "bandpass", freq, q), gainNode(ctx, level * 6), out);
  }
  if (breath > 0) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(breath, start + 0.05);
    g.gain.setValueAtTime(breath, start + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, start + dur);
    const noise = noiseBuffer(ctx, dur + 0.1, "pink", r.int(0, 1 << 30));
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.start(start);
    chain(n, filter(ctx, "bandpass", formants[0][0] * 1.4, 1), g, out);
  }
}

/** A pure whistle following a pitch `contour` (seconds, Hz), with soft edges: a bird's note. */
export function whistle(
  ctx: BaseAudioContext,
  out: AudioNode,
  start: number,
  contour: readonly (readonly [number, number])[],
  amp: number,
  edge = 0.02,
): void {
  const end = start + contour[contour.length - 1][0];
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(amp, start + Math.min(edge, (end - start) / 3));
  g.gain.setValueAtTime(amp, Math.max(start + edge, end - edge));
  g.gain.linearRampToValueAtTime(0, end);
  g.connect(out);
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(contour[0][1], start);
  for (const [t, f] of contour.slice(1)) {
    o.frequency.linearRampToValueAtTime(f, start + t);
  }
  o.start(start);
  o.stop(end + 0.02);
  o.connect(g);
}
