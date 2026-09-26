import { chain, filter, gainNode, noiseBuffer, resonate } from "../../shared/audio/synth.ts";
import type { Rng } from "../../shared/core/random.ts";

/** Eighth notes (s) of the dance, a lilting six-eight. */
const EIGHTH = 0.19;
/** Eighths in a bar, and bars in a phrase. */
const BAR = 6;
const BARS = 4;
/** Seconds one phrase lasts. */
export const PHRASE = EIGHTH * BAR * BARS;
/** Seconds of a beat, three eighths; there are two in a bar. */
export const BEAT = EIGHTH * 3;
/** Beats in a phrase. */
export const BEATS = (BAR / 3) * BARS;
/** The pipe's scale: D major, the fifth and sixth below the tonic to the ninth above (Hz). */
const SCALE = [440, 493.9, 587.3, 659.3, 740, 880, 987.8, 1174.7, 1318.5];
/** Where the tonic lies in the scale. */
const TONIC = 2;

/**
 * A phrase of dance music for the harvest fire: a wooden pipe playing a
 * jig over a frame drum. `part` 0 and 1 are the tune's first strain (ending
 * open, then home), 2 and 3 its second, a little higher.
 */
export function tune(ctx: OfflineAudioContext, noise: AudioBuffer, r: Rng, part: number): void {
  const notes = melody(r, part);
  pipe(ctx, r, notes);
  // The frame drum: a deep stroke on each bar's first beat, a lighter one on its second.
  for (let bar = 0; bar < BARS; bar++) {
    const t = bar * BAR * EIGHTH;
    resonate(
      ctx,
      noise,
      ctx.destination,
      t,
      [
        [110, 0.22, 0.55],
        [190, 0.12, 0.25],
      ],
      0.006,
      r.next(),
    );
    resonate(
      ctx,
      noise,
      ctx.destination,
      t + 3 * EIGHTH,
      [
        [140, 0.12, 0.3],
        [260, 0.06, 0.15],
      ],
      0.004,
      r.next(),
    );
    if (bar % 2 === 1) {
      resonate(ctx, noise, ctx.destination, t + 5 * EIGHTH, [[160, 0.08, 0.18]], 0.003, r.next());
    }
  }
}

/** The notes of a phrase: scale steps and lengths in eighths. */
function melody(r: Rng, part: number): { step: number; eighths: number }[] {
  const high = part >= 2 ? 2 : 0;
  const home = part % 2 === 1;
  const out: { step: number; eighths: number }[] = [];
  let step = TONIC + high;
  for (let bar = 0; bar < BARS; bar++) {
    // Each bar: two groups of three eighths, now and then a long note and a short one.
    for (let beat = 0; beat < 2; beat++) {
      // The held last note fills the last half bar.
      if (bar === BARS - 1 && beat === 1) {
        break;
      }
      if (r.chance(0.3)) {
        out.push({ step, eighths: 2 });
        step = move(r, step, high);
        out.push({ step, eighths: 1 });
      } else {
        for (let k = 0; k < 3; k++) {
          out.push({ step, eighths: 1 });
          step = move(r, step, high);
        }
      }
    }
  }
  // The phrase ends held: open on the fifth, or home on the tonic.
  out.push({ step: home ? (high ? TONIC + 5 : TONIC) : TONIC + 3, eighths: 3 });
  return out;
}

/** The next note: mostly a step up or down, sometimes a leap of a third, kept in the pipe's range. */
function move(r: Rng, step: number, high: number): number {
  const leap = r.chance(0.25) ? 2 : 1;
  const dir = r.chance(0.5) ? 1 : -1;
  const next = step + dir * leap;
  return Math.max(high, Math.min(SCALE.length - 1, next));
}

/**
 * A wooden pipe: a breathy, nearly pure tone with a little of its octave
 * and twelfth, each note tongued softly on, a slow vibrato on the long ones.
 */
function pipe(ctx: OfflineAudioContext, r: Rng, notes: { step: number; eighths: number }[]): void {
  const rate = ctx.sampleRate;
  const length = Math.ceil(PHRASE * rate) + Math.ceil(0.3 * rate);
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  let t = 0;
  let phase = 0;
  for (const n of notes) {
    const f = SCALE[n.step] * (1 + r.range(-0.002, 0.002));
    const dur = n.eighths * EIGHTH;
    const i0 = Math.floor(t * rate);
    const count = Math.floor(dur * rate);
    const vib = n.eighths >= 2 ? 0.006 : 0.002;
    for (let i = 0; i < count && i0 + i < length; i++) {
      const s = i / rate;
      phase += (2 * Math.PI * f * (1 + vib * Math.sin(2 * Math.PI * 5.2 * s))) / rate;
      // Tongued on, a breath of a gap before the next.
      const env = Math.min(1, s / 0.025) * Math.min(1, Math.max(0, dur - 0.03 - s) / 0.03);
      data[i0 + i] +=
        env * (Math.sin(phase) + 0.18 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase));
    }
    t += dur;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.start(0);
  // Wood softens the top.
  chain(src, filter(ctx, "lowpass", 3200, 0.7), gainNode(ctx, 0.45), ctx.destination);
  // The breath in it, following the tune's own loudness.
  const air = ctx.createBufferSource();
  air.buffer = noiseBuffer(ctx, PHRASE + 0.3, "pink", r.int(0, 1 << 30));
  air.start(0);
  const follow = ctx.createGain();
  follow.gain.value = 0;
  const shape = ctx.createBufferSource();
  shape.buffer = buffer;
  shape.start(0);
  // Breath only while a note sounds: the tone's envelope opens a gate on the noise.
  const rectify = ctx.createWaveShaper();
  rectify.curve = new Float32Array([1, 0, 1]);
  chain(shape, rectify, filter(ctx, "lowpass", 30), follow.gain);
  chain(air, filter(ctx, "bandpass", 1800, 0.8), follow, gainNode(ctx, 0.05), ctx.destination);
}
