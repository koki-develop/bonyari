import type { Rng } from "../core/random.ts";
import { type Build, chain, envelope, filter, noiseBurst } from "./synth.ts";

/**
 * Calls of birds, frogs and insects. Every builder draws its pitch, timing and
 * phrasing from the random source, so rendering one several times gives a set
 * of distinct calls of the same species.
 */

/** A pitch contour as [time from start (s), frequency (Hz)] points. */
type Contour = readonly (readonly [number, number])[];

/** A pure whistle following `contour`, with soft edges. */
function whistle(
  ctx: BaseAudioContext,
  out: AudioNode,
  start: number,
  contour: Contour,
  amp: number,
  edge = 0.03,
  harmonic = 0,
): void {
  const end = start + contour[contour.length - 1][0];
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(amp, start + Math.min(edge, (end - start) / 3));
  g.gain.setValueAtTime(amp, Math.max(start + edge, end - edge));
  g.gain.linearRampToValueAtTime(0, end);
  g.connect(out);
  for (const [mult, level] of harmonic > 0
    ? [[1, 1] as const, [2, harmonic] as const]
    : [[1, 1] as const]) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(contour[0][1] * mult, start);
    for (const [t, f] of contour.slice(1)) {
      o.frequency.linearRampToValueAtTime(f * mult, start + t);
    }
    const lv = ctx.createGain();
    lv.gain.value = level;
    o.start(start);
    o.stop(end + 0.02);
    chain(o, lv, g);
  }
}

function output(ctx: BaseAudioContext): GainNode {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  return out;
}

/**
 * Japanese bush warbler. Most calls are a held "hoo" rising into "hokekyo",
 * each bird with its own pitch and pacing; some skip the "hoo", and now and
 * then one breaks into the rattling "kekyo kekyo" of its valley call.
 */
export const uguisu =
  (variant: number): Build =>
  (ctx, _noise, r) => {
    const out = output(ctx);
    const p = r.range(0.9, 1.1);
    if (variant === 3) {
      // Valley call: a run of "kekyo" that speeds up and trails off.
      let t = 0;
      const count = r.int(7, 11);
      for (let i = 0; i < count; i++) {
        const amp = 0.4 * Math.min(1, (count - i) / 3);
        whistle(
          ctx,
          out,
          t,
          [
            [0, 2650 * p],
            [0.07, 2050 * p],
          ],
          amp,
          0.01,
        );
        whistle(
          ctx,
          out,
          t + 0.1,
          [
            [0, 2350 * p],
            [0.08, 1850 * p],
          ],
          amp * 0.9,
          0.01,
        );
        t += Math.max(0.2, 0.27 - i * 0.008);
      }
      return;
    }
    let t = 0;
    if (variant !== 2) {
      const hoo = r.range(0.7, 1.25);
      whistle(
        ctx,
        out,
        0,
        [
          [0, 1120 * p],
          [hoo * 0.85, 1250 * p],
          [hoo, 1220 * p],
        ],
        0.45,
        0.08,
      );
      t = hoo + r.range(0.08, 0.16);
    }
    const ho = r.range(2200, 2450) * p;
    whistle(
      ctx,
      out,
      t,
      [
        [0, ho],
        [0.09, ho * 0.8],
      ],
      0.4,
      0.012,
    );
    t += r.range(0.11, 0.14);
    whistle(
      ctx,
      out,
      t,
      [
        [0, ho * 0.92],
        [0.1, ho * 0.74],
      ],
      0.4,
      0.012,
    );
    t += r.range(0.14, 0.19);
    const kyo = r.range(2750, 3050) * p;
    const hold = r.range(0.3, 0.55);
    whistle(
      ctx,
      out,
      t,
      [
        [0, kyo],
        [0.16, kyo * 0.86],
        [hold, kyo * 0.8],
      ],
      0.45,
      0.015,
    );
  };

/** Tree sparrow: loose clusters of "chun" chirps. */
export const sparrow: Build = (ctx, _noise, r) => {
  const out = output(ctx);
  const chirps = r.int(2, 6);
  const p = r.range(0.88, 1.12);
  let t = 0;
  for (let i = 0; i < chirps; i++) {
    const top = r.range(4400, 5200) * p;
    const dur = r.range(0.045, 0.08);
    // A quick upstroke on some chirps, then the drop.
    const contour: Contour = r.chance(0.4)
      ? [
          [0, top * 0.8],
          [dur * 0.3, top],
          [dur, top * 0.62],
        ]
      : [
          [0, top],
          [dur, top * r.range(0.58, 0.7)],
        ];
    whistle(ctx, out, t, contour, r.range(0.25, 0.42), 0.006, 0.25);
    t += r.chance(0.3) ? r.range(0.07, 0.1) : r.range(0.15, 0.32);
  }
};

/** Brown-eared bulbul: loud, slurred "pii-yo", once or a few times. */
export const hiyodori: Build = (ctx, _noise, r) => {
  const out = output(ctx);
  const p = r.range(0.9, 1.1);
  const calls = r.int(1, 3);
  let t = 0;
  for (let i = 0; i < calls; i++) {
    const rise = r.range(0.14, 0.22);
    const fall = rise + r.range(0.18, 0.28);
    whistle(
      ctx,
      out,
      t,
      [
        [0, 2600 * p],
        [rise, 3500 * p],
        [rise + 0.04, 3300 * p],
        [fall, 2300 * p],
      ],
      0.4,
      0.02,
      0.35,
    );
    t += fall + r.range(0.35, 0.7);
  }
};

/** Great tit: "tsutsu-pii" phrases repeated two to four times. */
export const shijukara: Build = (ctx, _noise, r) => {
  const out = output(ctx);
  const p = r.range(0.92, 1.08);
  const phrases = r.int(2, 4);
  const notes = r.chance(0.5) ? 2 : 1;
  let t = 0;
  for (let i = 0; i < phrases; i++) {
    for (let k = 0; k < notes; k++) {
      whistle(
        ctx,
        out,
        t,
        [
          [0, 4400 * p],
          [0.05, 4000 * p],
        ],
        0.3,
        0.008,
      );
      t += 0.085;
    }
    whistle(
      ctx,
      out,
      t,
      [
        [0, 3050 * p],
        [0.16, 2900 * p],
      ],
      0.34,
      0.015,
    );
    t += 0.16 + r.range(0.18, 0.28);
  }
};

/** Crow: hoarse "kaa" caws, often in twos and threes, sometimes far off. */
export const crow: Build = (ctx, noise, r) => {
  const out = output(ctx);
  const caws = r.int(1, 4);
  const f0 = r.range(480, 640);
  let t = 0;
  for (let i = 0; i < caws; i++) {
    const dur = r.range(0.26, 0.45);
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f0 * 1.08, t);
    o.frequency.linearRampToValueAtTime(f0, t + dur * 0.3);
    o.frequency.linearRampToValueAtTime(f0 * 0.82, t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.03);
    g.gain.setValueAtTime(0.45, t + dur * 0.6);
    g.gain.linearRampToValueAtTime(0, t + dur);
    // A harsh throat: vowel-like formants plus breath noise.
    const f1 = filter(ctx, "bandpass", r.range(1150, 1400), 3);
    const f2 = filter(ctx, "bandpass", r.range(2300, 2700), 4);
    chain(o, g);
    g.connect(f1);
    g.connect(f2);
    f1.connect(out);
    f2.connect(out);
    chain(
      noiseBurst(ctx, noise, t, dur, r.next()),
      filter(ctx, "bandpass", 1600, 1.5),
      envelope(ctx, t, 0.03, dur * 0.8, 0.12),
      out,
    );
    t += dur + r.range(0.22, 0.5);
  }
};

/**
 * Paddy frogs. Tree frogs chatter a quick "kero kero kero"; pond frogs croak
 * lower and slower. Pulse counts, rates and pitch differ from call to call.
 */
export const frog: Build = (ctx, noise, r) => {
  const out = output(ctx);
  const tree = r.chance(0.65);
  const pulses = tree ? r.int(3, 9) : r.int(2, 5);
  const rate = tree ? r.range(0.085, 0.13) : r.range(0.12, 0.2);
  const f0 = tree ? r.range(380, 520) : r.range(180, 260);
  const formant = tree ? r.range(1400, 1800) : r.range(700, 950);
  for (let i = 0; i < pulses; i++) {
    const t = i * rate * r.range(0.92, 1.08);
    const dur = rate * (tree ? 0.55 : 0.7);
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.setValueAtTime(f0 * 1.05, t);
    o.frequency.linearRampToValueAtTime(f0 * 0.95, t + dur);
    o.start(t);
    o.stop(t + dur + 0.02);
    const g = envelope(ctx, t, 0.005, dur * 0.8, 0.35);
    const f1 = filter(ctx, "bandpass", formant, 4);
    const f2 = filter(ctx, "bandpass", formant * 1.9, 5);
    chain(o, g);
    g.connect(f1);
    g.connect(f2);
    f1.connect(out);
    f2.connect(out);
    chain(
      noiseBurst(ctx, noise, t, dur, r.next()),
      filter(ctx, "bandpass", formant * 1.2, 3),
      envelope(ctx, t, 0.004, dur * 0.6, 0.25),
      out,
    );
  }
};

/** Bell cricket: a clear, trembling "riiin", once or twice. */
export const suzumushi: Build = (ctx, _noise, r) => {
  const out = output(ctx);
  const freq = r.range(4000, 4600);
  const trill = r.range(32, 44);
  const rings = r.int(1, 2);
  let t = 0;
  for (let i = 0; i < rings; i++) {
    const len = r.range(0.4, 0.8);
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    o.start(t);
    o.stop(t + len + 0.05);
    const trem = ctx.createGain();
    trem.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = "square";
    lfo.frequency.value = trill;
    lfo.start(t);
    lfo.stop(t + len + 0.05);
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    chain(lfo, depth, trem.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.05);
    g.gain.setValueAtTime(0.35, t + len * 0.7);
    g.gain.linearRampToValueAtTime(0, t + len);
    chain(o, trem, g, out);
    t += len + r.range(0.25, 0.5);
  }
};

/** Field cricket: a rolling "koro koro" of chirps, sometimes ending in a long "rii". */
export const korogi: Build = (ctx, _noise, r) => {
  const out = output(ctx);
  const freq = r.range(4300, 4900);
  const groups = r.int(1, 3);
  let t = 0;
  for (let k = 0; k < groups; k++) {
    const chirps = r.int(3, 7);
    const gap = r.range(0.035, 0.05);
    for (let i = 0; i < chirps; i++) {
      whistle(
        ctx,
        out,
        t,
        [
          [0, freq],
          [0.028, freq * 0.98],
        ],
        0.3,
        0.004,
      );
      t += gap;
    }
    if (r.chance(0.4)) {
      whistle(
        ctx,
        out,
        t + 0.03,
        [
          [0, freq],
          [0.3, freq * 0.97],
        ],
        0.22,
        0.03,
      );
      t += 0.35;
    }
    t += r.range(0.12, 0.3);
  }
};

/** Pine cricket: a bright "chin-chiro-rin". */
export const matsumushi: Build = (ctx, _noise, r) => {
  const out = output(ctx);
  const f = r.range(4000, 4400);
  const phrases = r.int(1, 2);
  let t = 0;
  for (let i = 0; i < phrases; i++) {
    whistle(
      ctx,
      out,
      t,
      [
        [0, f],
        [0.06, f],
      ],
      0.3,
      0.005,
    );
    t += 0.14;
    whistle(
      ctx,
      out,
      t,
      [
        [0, f * 1.06],
        [0.045, f * 1.06],
      ],
      0.28,
      0.005,
    );
    t += 0.07;
    whistle(
      ctx,
      out,
      t,
      [
        [0, f * 0.96],
        [0.045, f * 0.96],
      ],
      0.28,
      0.005,
    );
    t += 0.09;
    // The ringing "rin".
    for (let k = 0; k < 5; k++) {
      whistle(
        ctx,
        out,
        t,
        [
          [0, f],
          [0.03, f],
        ],
        0.26 * (1 - k * 0.12),
        0.004,
      );
      t += 0.035;
    }
    t += r.range(0.4, 0.7);
  }
};

/** A buzzing cicada syllable: a sawtooth through a resonance, with rasp. */
function cicadaSyllable(
  ctx: BaseAudioContext,
  noise: AudioBuffer,
  r: Rng,
  out: AudioNode,
  t: number,
  dur: number,
  contour: readonly [number, number, number],
  band: number,
  amp: number,
): void {
  const o = ctx.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(contour[0], t);
  o.frequency.linearRampToValueAtTime(contour[1], t + dur * 0.3);
  o.frequency.linearRampToValueAtTime(contour[2], t + dur);
  o.start(t);
  o.stop(t + dur + 0.05);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(amp, t + dur * 0.3);
  g.gain.linearRampToValueAtTime(0, t + dur);
  chain(o, filter(ctx, "bandpass", band, 3), g, out);
  chain(
    noiseBurst(ctx, noise, t, dur, r.next()),
    filter(ctx, "bandpass", band * 1.1, 4),
    envelope(ctx, t, dur * 0.3, dur, amp * 0.8),
    out,
  );
}

/** Robust cicada: "miin min min min ... mii", with a varying number of syllables. */
export const minmin: Build = (ctx, noise, r) => {
  const out = output(ctx);
  const p = r.range(0.94, 1.06);
  const syllables = r.int(6, 12);
  let t = 0;
  for (let i = 0; i < syllables; i++) {
    const long = i === 0 || i === syllables - 1;
    const dur = long ? r.range(0.55, 0.8) : r.range(0.22, 0.3);
    cicadaSyllable(ctx, noise, r, out, t, dur, [3300 * p, 3900 * p, 3600 * p], 3800 * p, 0.18);
    t += dur + 0.04;
  }
};

/** Evening cicada: a falling "kana-kana-kana" of varying length. */
export const higurashi: Build = (ctx, _noise, r) => {
  const out = output(ctx);
  const count = r.int(10, 20);
  const top = r.range(5000, 5600);
  const step = r.range(0.11, 0.15);
  for (let i = 0; i < count; i++) {
    const t = i * step;
    const f = top - i * r.range(35, 60);
    const amp = 0.3 * Math.sin((Math.PI * (i + 1)) / (count + 1));
    whistle(
      ctx,
      out,
      t,
      [
        [0, f],
        [step * 0.75, f - 500],
      ],
      amp,
      0.01,
    );
  }
};

/** Late-summer cicada: "tsuku-tsuku-booshi" repeated, ending in "uiioos". */
export const tsukutsukuboshi: Build = (ctx, noise, r) => {
  const out = output(ctx);
  const p = r.range(0.95, 1.05);
  const phrases = r.int(4, 7);
  let t = 0;
  for (let i = 0; i < phrases; i++) {
    for (let k = 0; k < 2; k++) {
      cicadaSyllable(ctx, noise, r, out, t, 0.09, [4300 * p, 4700 * p, 4500 * p], 4600 * p, 0.15);
      t += 0.12;
    }
    cicadaSyllable(ctx, noise, r, out, t, 0.36, [5000 * p, 4800 * p, 4100 * p], 4500 * p, 0.17);
    t += 0.45;
  }
  // The closing "uiioos".
  for (let k = 0; k < 3; k++) {
    cicadaSyllable(ctx, noise, r, out, t, 0.3, [4000 * p, 4600 * p, 4300 * p], 4400 * p, 0.14);
    t += 0.36;
  }
};

/** Several distinct calls of each species. */
export interface Wildlife {
  uguisu: AudioBuffer[];
  sparrow: AudioBuffer[];
  hiyodori: AudioBuffer[];
  shijukara: AudioBuffer[];
  crow: AudioBuffer[];
  frog: AudioBuffer[];
  suzumushi: AudioBuffer[];
  korogi: AudioBuffer[];
  matsumushi: AudioBuffer[];
  minmin: AudioBuffer[];
  higurashi: AudioBuffer[];
  tsukutsukuboshi: AudioBuffer[];
}

/** Renders every species several times over, each a little different. */
export async function renderWildlife(
  render: (seconds: number, build: Build) => Promise<AudioBuffer>,
): Promise<Wildlife> {
  const many = (count: number, seconds: number, build: Build) =>
    Promise.all(Array.from({ length: count }, () => render(seconds, build)));
  const pending: { [K in keyof Wildlife]: Promise<AudioBuffer[]> } = {
    uguisu: Promise.all([0, 0, 1, 1, 2, 3].map((v) => render(3.2, uguisu(v)))),
    sparrow: many(6, 1.8, sparrow),
    hiyodori: many(4, 3.8, hiyodori),
    shijukara: many(4, 2.8, shijukara),
    crow: many(4, 4, crow),
    frog: many(8, 1.5, frog),
    suzumushi: many(5, 2.8, suzumushi),
    korogi: many(5, 3.2, korogi),
    matsumushi: many(3, 2.6, matsumushi),
    minmin: many(4, 5.2, minmin),
    higurashi: many(4, 3.2, higurashi),
    tsukutsukuboshi: many(3, 6.2, tsukutsukuboshi),
  };
  // Everything renders at once; the awaits only collect the results.
  return {
    uguisu: await pending.uguisu,
    sparrow: await pending.sparrow,
    hiyodori: await pending.hiyodori,
    shijukara: await pending.shijukara,
    crow: await pending.crow,
    frog: await pending.frog,
    suzumushi: await pending.suzumushi,
    korogi: await pending.korogi,
    matsumushi: await pending.matsumushi,
    minmin: await pending.minmin,
    higurashi: await pending.higurashi,
    tsukutsukuboshi: await pending.tsukutsukuboshi,
  };
}
