import { Rng } from "../../shared/core/random.ts";
import {
  type Build,
  chain,
  envelope,
  filter,
  noiseBuffer,
  noiseBurst,
  renderOffline,
  type Mode,
  normalize,
  resonate,
  tone,
} from "../../shared/audio/synth.ts";
import { dropTick } from "../../shared/audio/weather-sounds.ts";
import { renderWildlife, type Wildlife } from "../../shared/audio/wildlife.ts";
import type { StrikeSound } from "../sim/arrows.ts";

/** The kinds of ground a knocked-off arrow can land on, as they sound. */
export type Landing = "sand" | "lawn" | "gravel";

/** Every one-shot sound of the dojo, synthesized once when the visit starts. */
export interface SoundBank {
  /** The string's ring on release (tsurune). */
  tsurune: AudioBuffer[];
  /** The air torn by the arrow as it leaves. */
  whoosh: AudioBuffer[];
  /** What an arrow makes when it strikes each thing, a few variants each. */
  strikes: Record<StrikeSound, AudioBuffer[]>;
  /** A knocked-off arrow landing flat on each kind of ground. */
  landing: Record<Landing, AudioBuffer[]>;
  /** The bow creaking under the draw. */
  creak: AudioBuffer[];
  /** Single slips of the grip and the bamboo, strewn while the bow is being bent. */
  slip: AudioBuffer[];
  /** Sleeves and the body moving as the bow is raised. */
  rustle: AudioBuffer[];
  /** The next arrow set on the string. */
  nock: AudioBuffer;
  /** The arrows swept from the range. */
  clear: AudioBuffer;
  /** A temple bell some way off. */
  bell: AudioBuffer;
  dropTicks: AudioBuffer[];
  wildlife: Wildlife;
  noise: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer };
}

/**
 * A plucked string (Karplus–Strong): a burst of noise circulating in a delay
 * one period long, softened a little each time round, so the ring has the
 * harmonics and the decay of a real string. `brightness` (0..1) sets how
 * sharp the pluck is; `decay` is the seconds it takes to fall by 60 dB.
 */
function pluck(
  sampleRate: number,
  length: number,
  freq: number,
  decay: number,
  brightness: number,
  r: Rng,
): Float32Array {
  const out = new Float32Array(length);
  const period = sampleRate / freq;
  // The loop is n samples, its two-tap average adds ½, and a first-order
  // allpass the rest, kept between 0.1 and 1.1 samples where it is stable.
  const n = Math.floor(period - 0.6);
  const frac = period - 0.5 - n;
  const c = (1 - frac) / (1 + frac);
  const loss = Math.pow(10, -3 / (decay * freq));
  const line = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < line.length; i++) {
    lp += (r.next() * 2 - 1 - lp) * brightness;
    line[i] = lp;
  }
  let prev = 0;
  let apIn = 0;
  let apOut = 0;
  for (let i = 0, k = 0; i < length; i++) {
    const cur = line[k];
    const avg = 0.5 * (cur + prev) * loss;
    prev = cur;
    // Fractional part of the delay.
    const y = c * (avg - apOut) + apIn;
    apIn = avg;
    apOut = y;
    line[k] = y;
    out[i] = cur;
    k = k === n - 1 ? 0 : k + 1;
  }
  return out;
}

/**
 * The string's ring on the release (tsurune). The string is long and heavy,
 * so its own note is low; what rings out is the blow of the string against
 * the bow and the bow itself, a laminate of bamboo, answering with its
 * uneven modes. The ring is cut short as the bow turns in the hand.
 */
const tsurune: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  // Damped as the bow turns in the hand.
  out.gain.setValueAtTime(1, 0);
  out.gain.setValueAtTime(1, 0.14);
  out.gain.setTargetAtTime(0, 0.14, 0.07);
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * 0.6);
  // The string's own low thrum, two strands a hair apart.
  const f = r.range(92, 110);
  const a = pluck(rate, length, f, 0.3, 0.85, r);
  const b = pluck(rate, length, f * 1.004, 0.25, 0.8, r);
  const thrum = ctx.createBuffer(1, length, rate);
  const data = thrum.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < length; i++) {
    data[i] = a[i] + 0.8 * b[i];
    peak = Math.max(peak, Math.abs(data[i]));
  }
  const gain = peak > 0 ? 0.35 / peak : 0;
  for (let i = 0; i < length; i++) {
    data[i] *= gain;
  }
  const src = ctx.createBufferSource();
  src.buffer = thrum;
  chain(src, filter(ctx, "highpass", 140, 0.7), out);
  src.start(0);
  // The string striking the bow: a hard, bright blow into the bamboo's modes.
  const k = r.range(0.95, 1.06);
  resonate(
    ctx,
    noise,
    out,
    0,
    [
      [310 * k, 0.12, 0.35],
      [835 * k, 0.1, 0.5],
      [1610 * k, 0.08, 0.7],
      [2480 * k, 0.07, 0.8],
      [3390 * k, 0.05, 0.6],
      [4520 * k, 0.035, 0.4],
      [6100 * k, 0.02, 0.25],
    ],
    0.0025,
    r.next(),
  );
  // The crack of the blow itself.
  chain(
    noiseBurst(ctx, noise, 0, 0.02, r.next()),
    filter(ctx, "highpass", 2500),
    envelope(ctx, 0, 0.0003, 0.005, 0.7),
    out,
  );
};

/** The air torn by the arrow leaving: a short, soft "fsh". */
const whoosh: Build = (ctx, noise, r) => {
  const src = noiseBurst(ctx, noise, 0, 0.4, r.next());
  const band = filter(ctx, "bandpass", 3200, 0.8);
  band.frequency.setValueAtTime(3200, 0);
  band.frequency.exponentialRampToValueAtTime(1100, 0.22);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.5, 0.008);
  g.gain.setTargetAtTime(0, 0.02, 0.05);
  chain(src, band, g, ctx.destination);
};

/** The arrows swept from the range: a quick, soft brush. */
const clear: Build = (ctx, noise, r) => {
  const src = noiseBurst(ctx, noise, 0, 0.5, r.next());
  const band = filter(ctx, "bandpass", 1800, 0.7);
  band.frequency.setValueAtTime(1400, 0);
  band.frequency.linearRampToValueAtTime(2600, 0.25);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.35, 0.06);
  g.gain.linearRampToValueAtTime(0, 0.32);
  chain(src, band, g, ctx.destination);
};

/**
 * Through the paper of the target: the taut paper drum cracks and booms
 * once in its uneven modes, the wooden hoop knocks, and the sand behind
 * takes the point.
 */
const target: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  // The paper tearing open.
  chain(
    noiseBurst(ctx, noise, 0, 0.04, r.next()),
    filter(ctx, "bandpass", r.range(1800, 2400), 0.9),
    envelope(ctx, 0, 0.0004, 0.012, 1),
    out,
  );
  // The paper drum: modes of a round membrane.
  const f = r.range(165, 195);
  resonate(
    ctx,
    noise,
    out,
    0,
    [
      [f, 0.09, 1],
      [f * 1.59, 0.07, 0.8],
      [f * 2.14, 0.06, 0.6],
      [f * 2.3, 0.05, 0.5],
      [f * 2.65, 0.045, 0.45],
      [f * 2.92, 0.04, 0.4],
      [f * 3.5, 0.03, 0.3],
    ],
    0.004,
    r.next(),
  );
  // The hoop.
  resonate(
    ctx,
    noise,
    out,
    0.001,
    [
      [r.range(860, 960), 0.08, 0.35],
      [r.range(2150, 2350), 0.05, 0.25],
    ],
    0.002,
    r.next(),
  );
  sandBehind(ctx, noise, r, out, 0.012, 0.35);
};

/** The dull thump and hiss of a point going into packed sand. */
function sandBehind(
  ctx: BaseAudioContext,
  noise: AudioBuffer,
  r: Rng,
  out: AudioNode,
  at: number,
  level: number,
): void {
  chain(
    noiseBurst(ctx, noise, at, 0.15, r.next()),
    filter(ctx, "lowpass", 480),
    envelope(ctx, at, 0.002, 0.06, level),
    out,
  );
  chain(
    noiseBurst(ctx, noise, at, 0.12, r.next()),
    filter(ctx, "bandpass", 2600, 0.8),
    envelope(ctx, at, 0.001, 0.035, level * 0.35),
    out,
  );
}

/** Into the bank: a deep, soft "doss". */
const azuchi: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  resonate(
    ctx,
    noise,
    out,
    0,
    [
      [r.range(85, 105), 0.07, 0.8],
      [r.range(170, 200), 0.05, 0.5],
    ],
    0.006,
    r.next(),
  );
  sandBehind(ctx, noise, r, out, 0, 0.8);
};

/** Into the loose sand in front of the bank: lighter, grittier. */
const sand: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  sandBehind(ctx, noise, r, out, 0, 0.7);
  chain(
    noiseBurst(ctx, noise, 0.02, 0.25, r.next()),
    filter(ctx, "highpass", 3000),
    envelope(ctx, 0.02, 0.01, 0.08, 0.2),
    out,
  );
};

/** Into the turf: a short, crisp "sak". */
const lawn: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  chain(
    noiseBurst(ctx, noise, 0, 0.08, r.next()),
    filter(ctx, "bandpass", r.range(1100, 1500), 1.5),
    envelope(ctx, 0, 0.001, 0.025, 0.8),
    out,
  );
  resonate(ctx, noise, out, 0, [[r.range(110, 140), 0.04, 0.5]], 0.005, r.next());
};

/** Glancing off gravel: a skitter of little knocks. */
const gravel: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  for (let i = 0; i < 5; i++) {
    const t = i * r.range(0.02, 0.05);
    chain(
      noiseBurst(ctx, noise, t, 0.03, r.next()),
      filter(ctx, "bandpass", r.range(1800, 3200), 3),
      envelope(ctx, t, 0.0005, 0.01, 0.6 / (i + 1)),
      out,
    );
  }
};

/** Against a post or a beam: a hollow "kon". */
const wood: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const f = r.range(520, 620);
  resonate(
    ctx,
    noise,
    out,
    0,
    [
      [f, 0.12, 1],
      [f * 2.57, 0.08, 0.6],
      [f * 4.2, 0.05, 0.35],
      [f * 6.1, 0.03, 0.2],
    ],
    0.0015,
    r.next(),
  );
};

/** Into the soft boards behind the bank: a dull "doh". */
const board: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const f = r.range(210, 250);
  resonate(
    ctx,
    noise,
    out,
    0,
    [
      [f, 0.08, 1],
      [f * 2.3, 0.05, 0.5],
      [f * 3.9, 0.03, 0.3],
    ],
    0.003,
    r.next(),
  );
};

/** Into the hanging curtain: a muffled "boff" and the cloth swaying. */
const cloth: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  chain(
    noiseBurst(ctx, noise, 0, 0.3, r.next()),
    filter(ctx, "lowpass", 420),
    envelope(ctx, 0, 0.006, 0.09, 0.9),
    out,
  );
  chain(
    noiseBurst(ctx, noise, 0.04, 0.5, r.next()),
    filter(ctx, "bandpass", 900, 0.8),
    envelope(ctx, 0.04, 0.05, 0.25, 0.12),
    out,
  );
};

/** Into the hedge: leaves shaken. */
const hedge: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.5, 0.01);
  g.gain.setTargetAtTime(0, 0.05, 0.12);
  chain(noiseBurst(ctx, noise, 0, 0.6, r.next()), filter(ctx, "highpass", 2500), g, out);
};

/** Onto the nock of an arrow already there: a sharp split of bamboo. */
const nockSplit: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  chain(
    noiseBurst(ctx, noise, 0, 0.05, r.next()),
    filter(ctx, "highpass", 2800),
    envelope(ctx, 0, 0.0004, 0.012, 1),
    out,
  );
  resonate(
    ctx,
    noise,
    out,
    0,
    [
      [r.range(1800, 2000), 0.05, 0.6],
      [r.range(3000, 3300), 0.035, 0.5],
      [r.range(4600, 5000), 0.02, 0.3],
    ],
    0.001,
    r.next(),
  );
};

/** Off the side of another arrow: a thin "kachi". */
const shaft: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const f = r.range(1300, 1550);
  resonate(
    ctx,
    noise,
    out,
    0,
    [
      [f, 0.05, 0.8],
      [f * 2.6, 0.03, 0.5],
      [f * 4.9, 0.02, 0.3],
    ],
    0.001,
    r.next(),
  );
};

/** Off the wooden hoop of a target: a hard "katsu". */
const rim: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const f = r.range(900, 1020);
  resonate(
    ctx,
    noise,
    out,
    0,
    [
      [f, 0.07, 1],
      [f * 2.2, 0.045, 0.6],
      [f * 3.8, 0.03, 0.35],
    ],
    0.0012,
    r.next(),
  );
};

/**
 * A knocked-off arrow landing flat. It falls a meter or two and lies where it
 * lands: one end touches, then the other, and the ground damps the shaft at
 * once, so it barely rings. `ground` is what the touches sound like.
 */
function landing(ground: Landing): Build {
  return (ctx, noise, r) => {
    const out = ctx.createGain();
    out.connect(ctx.destination);
    // The tip end first, the fletched end a moment later and softer.
    const touches: readonly [number, number][] = [
      [0, 1],
      [r.range(0.025, 0.07), r.range(0.4, 0.65)],
    ];
    for (const [at, level] of touches) {
      if (ground === "gravel") {
        // Stones knocked against each other and against the shaft.
        const knocks = 2 + Math.floor(r.range(0, 3));
        for (let i = 0; i < knocks; i++) {
          const t = at + r.range(0, 0.02);
          resonate(
            ctx,
            noise,
            out,
            t,
            [
              [r.range(1800, 2600), 0.02, 0.6],
              [r.range(3500, 5200), 0.012, 0.4],
            ],
            0.0006,
            r.next(),
          );
        }
        chain(
          noiseBurst(ctx, noise, at, 0.06, r.next()),
          filter(ctx, "bandpass", r.range(2500, 3500), 0.8),
          envelope(ctx, at, 0.001, 0.018, level * 0.5),
          out,
        );
      } else {
        // A soft thud into the ground.
        chain(
          noiseBurst(ctx, noise, at, 0.08, r.next()),
          filter(ctx, "lowpass", ground === "sand" ? 520 : 700),
          envelope(ctx, at, 0.002, 0.025, level),
          out,
        );
        // Sand hisses a little; grass brushes.
        chain(
          noiseBurst(ctx, noise, at, 0.12, r.next()),
          filter(ctx, "bandpass", ground === "sand" ? 3200 : 2400, 0.9),
          envelope(ctx, at, 0.003, ground === "sand" ? 0.03 : 0.05, level * 0.35),
          out,
        );
      }
      // The shaft, damped where it lies against the ground.
      const f = r.range(950, 1150);
      resonate(
        ctx,
        noise,
        out,
        at,
        [
          [f, 0.018, 0.25 * level],
          [f * 2.7, 0.01, 0.12 * level],
        ],
        0.001,
        r.next(),
      );
    }
  };
}

/**
 * The bow creaking as it bends: many tiny slips of the grip and the bamboo,
 * each a faint knock in the wood, coming thicker as it goes.
 */
const creak: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const f = r.range(190, 240);
  const modes: Mode[] = [
    [f, 0.03, 0.8],
    [f * 2.4, 0.02, 0.6],
    [f * 5.3, 0.012, 0.4],
  ];
  let t = 0;
  while (t < 0.5) {
    resonate(ctx, noise, out, t, modes, 0.0008, r.next());
    // Slips come quicker in the middle of the groan.
    t += r.range(0.006, 0.03) * (1.4 - Math.sin((Math.PI * t) / 0.5));
  }
};

/** One slip of the grip or the bamboo while the bow bends: a faint knock in the wood. */
const slip: Build = (ctx, noise, r) => {
  const f = r.range(170, 260);
  resonate(
    ctx,
    noise,
    ctx.destination,
    0,
    [
      [f, 0.025, 0.8],
      [f * r.range(2.3, 2.6), 0.018, 0.6],
      [f * r.range(5, 5.6), 0.01, 0.4],
    ],
    r.range(0.0005, 0.0012),
    r.next(),
  );
};

/** Sleeves brushing as the arms rise. */
const rustle: Build = (ctx, noise, r) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.45, 0.12);
  g.gain.linearRampToValueAtTime(0, 0.55);
  chain(
    noiseBurst(ctx, noise, 0, 0.6, r.next()),
    filter(ctx, "bandpass", r.range(1600, 2400), 0.6),
    g,
    ctx.destination,
  );
};

/** The nock clicking onto the string. */
const nock: Build = (ctx, noise, r) => {
  chain(
    noiseBurst(ctx, noise, 0, 0.02, r.next()),
    filter(ctx, "bandpass", 3000, 3),
    envelope(ctx, 0, 0.0005, 0.006, 0.7),
    ctx.destination,
  );
};

/**
 * A temple bell (bonshō) far off: a long hum with slow beats between its
 * partials, fading over many seconds.
 */
const bell: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(ctx.destination);
  const f = r.range(128, 140);
  for (const [ratio, amp, decay] of [
    [0.5, 0.35, 9],
    [1, 0.55, 7],
    [1.006, 0.35, 7],
    [1.19, 0.2, 4],
    [1.5, 0.18, 3.2],
    [2.0, 0.22, 2.6],
    [2.66, 0.1, 1.6],
    [3.0, 0.08, 1.2],
    [4.07, 0.05, 0.6],
  ] as const) {
    const o = tone(ctx, "sine", f * ratio, 0, 14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(amp, 0.02);
    g.gain.setTargetAtTime(0, 0.02, decay / 2);
    chain(o, g, out);
  }
  // The wooden beam striking.
  chain(
    noiseBurst(ctx, noise, 0, 0.1, r.next()),
    filter(ctx, "lowpass", 900),
    envelope(ctx, 0, 0.002, 0.03, 0.4),
    out,
  );
};

export async function buildSoundBank(sampleRate: number, seed: number): Promise<SoundBank> {
  const probe = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate });
  const white = noiseBuffer(probe, 3, "white", seed);
  const pink = noiseBuffer(probe, 6, "pink", seed + 1);
  const brown = noiseBuffer(probe, 6, "brown", seed + 2);
  let n = 0;
  const render = (seconds: number, build: Build) => {
    const rng = new Rng(seed + 100 + n++);
    return renderOffline(sampleRate, seconds, (ctx) => build(ctx, white, rng));
  };
  const many = (count: number, seconds: number, build: Build) =>
    Promise.all(Array.from({ length: count }, () => render(seconds, build)));
  // Struck bodies ring at levels that depend on their modes: they are brought to one peak.
  const bodies = (count: number, seconds: number, build: Build) =>
    Promise.all(
      Array.from({ length: count }, () => render(seconds, build).then((b) => normalize(b))),
    );
  const strikeSounds: Record<StrikeSound, Promise<AudioBuffer[]>> = {
    target: bodies(4, 0.6, target),
    rim: bodies(2, 0.4, rim),
    azuchi: bodies(4, 0.5, azuchi),
    sand: many(3, 0.5, sand),
    lawn: bodies(3, 0.3, lawn),
    gravel: many(2, 0.4, gravel),
    wood: bodies(2, 0.5, wood),
    board: bodies(2, 0.4, board),
    cloth: many(2, 0.8, cloth),
    hedge: many(2, 0.8, hedge),
    nock: bodies(2, 0.3, nockSplit),
    shaft: bodies(2, 0.3, shaft),
  };
  const landings: Record<Landing, Promise<AudioBuffer[]>> = {
    sand: bodies(3, 0.4, landing("sand")),
    lawn: bodies(3, 0.4, landing("lawn")),
    gravel: bodies(3, 0.4, landing("gravel")),
  };
  // Everything renders at once; the awaits only collect the results.
  const strikes: Record<StrikeSound, AudioBuffer[]> = {
    target: await strikeSounds.target,
    rim: await strikeSounds.rim,
    azuchi: await strikeSounds.azuchi,
    sand: await strikeSounds.sand,
    lawn: await strikeSounds.lawn,
    gravel: await strikeSounds.gravel,
    wood: await strikeSounds.wood,
    board: await strikeSounds.board,
    cloth: await strikeSounds.cloth,
    hedge: await strikeSounds.hedge,
    nock: await strikeSounds.nock,
    shaft: await strikeSounds.shaft,
  };
  const [
    tsuruneSounds,
    whooshes,
    creaks,
    slips,
    rustles,
    nockClick,
    sweep,
    temple,
    ticks,
    wildlife,
  ] = await Promise.all([
    bodies(4, 1.2, tsurune),
    many(3, 0.5, whoosh),
    bodies(3, 1, creak),
    bodies(8, 0.1, slip),
    many(2, 0.6, rustle),
    render(0.05, nock),
    render(0.5, clear),
    render(14, bell),
    Promise.all([0, 1, 2, 3].map((v) => render(0.06, dropTick(v)))),
    renderWildlife(render),
  ]);
  return {
    tsurune: tsuruneSounds,
    whoosh: whooshes,
    strikes,
    landing: {
      sand: await landings.sand,
      lawn: await landings.lawn,
      gravel: await landings.gravel,
    },
    creak: creaks,
    slip: slips,
    rustle: rustles,
    nock: nockClick,
    clear: sweep,
    bell: temple,
    dropTicks: ticks,
    wildlife,
    noise: { white, pink, brown },
  };
}
