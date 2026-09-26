import {
  type Build,
  chain,
  envelope,
  filter,
  gainNode,
  type Mode,
  noiseBuffer,
  noiseBurst,
  normalize,
  renderOffline,
  resonate,
  seamlessLoop,
} from "../../shared/audio/synth.ts";
import { dropTick, thunder } from "../../shared/audio/weather-sounds.ts";
import { crow, frog, korogi, shijukara, sparrow } from "../../shared/audio/wildlife.ts";
import { Rng } from "../../shared/core/random.ts";
import type { SoundKind } from "../sim/world.ts";
import { blackbird, cuckoo, lark, owl, rooster } from "./calls.ts";
import { PHRASE, tune } from "./tune.ts";
import { voice } from "./voice.ts";

/** The birds and beasts of the valley, a few calls each. */
export interface Calls {
  sparrow: AudioBuffer[];
  tit: AudioBuffer[];
  crow: AudioBuffer[];
  blackbird: AudioBuffer[];
  lark: AudioBuffer[];
  cuckoo: AudioBuffer[];
  owl: AudioBuffer[];
  frog: AudioBuffer[];
  cricket: AudioBuffer[];
  rooster: AudioBuffer[];
}

/** Every one-shot sound of the valley, synthesized once when the visit starts. */
export interface SoundBank {
  /** A few variants of each sound the world makes. */
  shots: Record<SoundKind, AudioBuffer[]>;
  calls: Calls;
  thunder: [AudioBuffer, AudioBuffer];
  dropTicks: AudioBuffer[];
  /** A long loop of a fire crackling and roaring. */
  fire: AudioBuffer;
  /** The dance tunes played round the harvest fire: each four phrases, in the order they are played. */
  tunes: AudioBuffer[][];
  noise: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer };
}

/** How many dance tunes the pipe knows. */
const TUNES = 3;
/**
 * Sample rate (Hz) for the bells and the dance tunes: nothing in them rings
 * above a few kHz, and they are long.
 */
const MELLOW_RATE = 24000;

/** Modes of struck things: wood, a log, stone, iron; frequencies scaled by `k`. */
function woodModes(k: number, decay = 0.08): Mode[] {
  return [
    [180 * k, decay * 1.6, 0.8],
    [410 * k, decay, 0.6],
    [870 * k, decay * 0.7, 0.35],
    [1550 * k, decay * 0.4, 0.15],
  ];
}

/** An axe biting into a trunk: a dull knock of the wood and the sharp edge going in. */
const chop: Build = (ctx, noise, r) => {
  const k = r.range(0.85, 1.15);
  resonate(ctx, noise, ctx.destination, 0, woodModes(k * 0.8, 0.07), 0.004, r.next());
  chain(
    noiseBurst(ctx, noise, 0, 0.05, r.next()),
    filter(ctx, "bandpass", 2400 * k, 1.2),
    envelope(ctx, 0, 0.001, 0.02, 0.25),
    ctx.destination,
  );
};

/**
 * A tree coming down: the trunk creaking as it goes, the rush of the crown
 * through the air, the thud and the crash of branches.
 */
const treefall: Build = (ctx, noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  // The creak: the fibers tearing, one small slip after another, quickening.
  let t = 0;
  for (let i = 0; i < 26; i++) {
    t += Math.max(0.02, 0.09 - i * 0.003) * r.range(0.7, 1.3);
    resonate(
      ctx,
      noise,
      out,
      t,
      [
        [r.range(260, 360), 0.05, 0.3],
        [r.range(700, 900), 0.03, 0.15],
      ],
      0.002,
      r.next(),
    );
  }
  // The crown rushing down.
  const rush = ctx.createGain();
  rush.gain.setValueAtTime(0, t);
  rush.gain.linearRampToValueAtTime(0.35, t + 0.8);
  rush.gain.linearRampToValueAtTime(0, t + 1.1);
  const sweep = filter(ctx, "bandpass", 500, 0.8);
  sweep.frequency.setValueAtTime(400, t);
  sweep.frequency.linearRampToValueAtTime(1600, t + 1);
  chain(noiseBurst(ctx, noise, t, 1.2, r.next()), sweep, rush, out);
  // The trunk hitting the ground, and the branches snapping.
  const land = t + 1.05;
  resonate(
    ctx,
    noise,
    out,
    land,
    [
      [55, 0.5, 1],
      [95, 0.35, 0.7],
      [180, 0.2, 0.35],
    ],
    0.03,
    r.next(),
  );
  for (let i = 0; i < 9; i++) {
    const s = land + r.range(0, 0.5);
    resonate(ctx, noise, out, s, woodModes(r.range(1.4, 2.4), 0.03), 0.003, r.next());
  }
  chain(
    noiseBurst(ctx, noise, land, 0.9, r.next()),
    filter(ctx, "lowpass", 900),
    envelope(ctx, land, 0.01, 0.6, 0.3),
    out,
  );
};

/** A hammer on a peg or a beam. */
const hammer: Build = (ctx, noise, r) => {
  const k = r.range(0.9, 1.3);
  resonate(
    ctx,
    noise,
    ctx.destination,
    0,
    [
      [330 * k, 0.07, 0.7],
      [760 * k, 0.05, 0.5],
      [1900 * k, 0.03, 0.25],
      [3100 * k, 0.02, 0.12],
    ],
    0.0025,
    r.next(),
  );
};

/** One stroke of a saw through a plank. */
const saw: Build = (ctx, noise, r) => {
  const dur = r.range(0.45, 0.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.5, dur * 0.3);
  g.gain.linearRampToValueAtTime(0, dur);
  const band = filter(ctx, "bandpass", r.range(2400, 3200), 2.5);
  band.frequency.setValueAtTime(2200, 0);
  band.frequency.linearRampToValueAtTime(3200, dur);
  // The teeth catching: a buzz in the noise.
  const teeth = ctx.createGain();
  teeth.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = r.range(70, 110);
  lfo.start(0);
  lfo.stop(dur + 0.05);
  const depth = gainNode(ctx, 0.5);
  chain(lfo, depth, teeth.gain);
  chain(noiseBurst(ctx, noise, 0, dur + 0.05, r.next()), band, teeth, g, ctx.destination);
};

/** A chisel into stone: a hard, bright tap and a little grit. */
const chisel: Build = (ctx, noise, r) => {
  const k = r.range(0.9, 1.15);
  resonate(
    ctx,
    noise,
    ctx.destination,
    0,
    [
      [1350 * k, 0.03, 0.5],
      [2600 * k, 0.025, 0.45],
      [4100 * k, 0.015, 0.25],
    ],
    0.0015,
    r.next(),
  );
  chain(
    noiseBurst(ctx, noise, 0.005, 0.06, r.next()),
    filter(ctx, "highpass", 2500),
    envelope(ctx, 0.005, 0.002, 0.04, 0.12),
    ctx.destination,
  );
};

/** A spade or a mattock into the earth. */
const dig: Build = (ctx, noise, r) => {
  chain(
    noiseBurst(ctx, noise, 0, 0.2, r.next()),
    filter(ctx, "bandpass", r.range(350, 550), 0.9),
    envelope(ctx, 0, 0.004, 0.12, 0.7),
    ctx.destination,
  );
  chain(
    noiseBurst(ctx, noise, 0.08, 0.25, r.next()),
    filter(ctx, "bandpass", 1800, 0.8),
    envelope(ctx, 0.08, 0.02, 0.15, 0.18),
    ctx.destination,
  );
};

/** A hoe breaking the soil. */
const hoe: Build = (ctx, noise, r) => {
  chain(
    noiseBurst(ctx, noise, 0, 0.15, r.next()),
    filter(ctx, "bandpass", r.range(500, 800), 1.1),
    envelope(ctx, 0, 0.003, 0.08, 0.6),
    ctx.destination,
  );
};

/** A scythe or a sickle through standing grain. */
const reap: Build = (ctx, noise, r) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.5, 0.12);
  g.gain.linearRampToValueAtTime(0, 0.35);
  const band = filter(ctx, "bandpass", 2500, 1.2);
  band.frequency.setValueAtTime(r.range(1800, 2400), 0);
  band.frequency.linearRampToValueAtTime(r.range(3500, 4500), 0.3);
  chain(noiseBurst(ctx, noise, 0, 0.4, r.next()), band, g, ctx.destination);
};

/** The hammer on the anvil: a bright, long ring of iron. */
const anvil: Build = (ctx, noise, r) => {
  const k = r.range(0.96, 1.04);
  resonate(
    ctx,
    noise,
    ctx.destination,
    0,
    [
      [620 * k, 1.1, 0.6],
      [1530 * k, 0.9, 0.55],
      [2480 * k, 0.7, 0.4],
      [3920 * k, 0.5, 0.25],
      [5310 * k, 0.3, 0.12],
    ],
    0.0015,
    r.next(),
  );
};

/** A plank door closing. */
const door: Build = (ctx, noise, r) => {
  resonate(ctx, noise, ctx.destination, 0, woodModes(r.range(0.6, 0.8), 0.1), 0.006, r.next());
  resonate(ctx, noise, ctx.destination, 0.07, [[r.range(1800, 2400), 0.04, 0.3]], 0.002, r.next());
};

/** Logs put down on a heap: two or three wooden knocks. */
const logs: Build = (ctx, noise, r) => {
  const n = r.int(2, 3);
  for (let i = 0; i < n; i++) {
    resonate(
      ctx,
      noise,
      ctx.destination,
      i * r.range(0.06, 0.12),
      woodModes(r.range(0.55, 0.85), 0.09),
      0.006,
      r.next(),
    );
  }
};

/** Stones set down: dull knocks with a scrape. */
const stones: Build = (ctx, noise, r) => {
  for (let i = 0; i < 2; i++) {
    resonate(
      ctx,
      noise,
      ctx.destination,
      i * r.range(0.05, 0.1),
      [
        [r.range(700, 900), 0.03, 0.5],
        [r.range(1800, 2300), 0.02, 0.3],
      ],
      0.003,
      r.next(),
    );
  }
  chain(
    noiseBurst(ctx, noise, 0.02, 0.1, r.next()),
    filter(ctx, "bandpass", 1400, 1),
    envelope(ctx, 0.02, 0.004, 0.06, 0.2),
    ctx.destination,
  );
};

/** A bucket of water thrown: a slap and the splash spreading. */
const splash: Build = (ctx, noise, r) => {
  const band = filter(ctx, "bandpass", 1200, 0.8);
  band.frequency.setValueAtTime(900, 0);
  band.frequency.linearRampToValueAtTime(r.range(2400, 3200), 0.3);
  chain(
    noiseBurst(ctx, noise, 0, 0.5, r.next()),
    band,
    envelope(ctx, 0, 0.01, 0.35, 0.8),
    ctx.destination,
  );
};

/** The bucket let down into the well and hauled up full. */
const bucket: Build = (ctx, noise, r) => {
  resonate(ctx, noise, ctx.destination, 0, woodModes(r.range(1, 1.3), 0.06), 0.004, r.next());
  chain(
    noiseBurst(ctx, noise, 0.25, 0.4, r.next()),
    filter(ctx, "bandpass", 700, 1.2),
    envelope(ctx, 0.25, 0.05, 0.3, 0.35),
    ctx.destination,
  );
};

/** Water on embers: a long hiss. */
const hiss: Build = (ctx, noise, r) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.5, 0.1);
  g.gain.setTargetAtTime(0, 0.3, 0.5);
  chain(
    noiseBurst(ctx, noise, 0, 2, r.next()),
    filter(ctx, "highpass", r.range(3000, 4000)),
    g,
    ctx.destination,
  );
};

/** A burning house falling in: timbers breaking, the roof coming down, a long rumble. */
const collapse: Build = (ctx, noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  for (let i = 0; i < 14; i++) {
    resonate(ctx, noise, out, r.range(0, 1.2), woodModes(r.range(0.4, 1.2), 0.1), 0.006, r.next());
  }
  chain(
    noiseBurst(ctx, noise, 0.1, 2.5, r.next()),
    filter(ctx, "lowpass", 300),
    envelope(ctx, 0.1, 0.05, 1.5, 0.8),
    out,
  );
  chain(
    noiseBurst(ctx, noise, 0.1, 1.5, r.next()),
    filter(ctx, "bandpass", 1500, 0.7),
    envelope(ctx, 0.1, 0.02, 0.8, 0.25),
    out,
  );
};

/** Fire catching: a soft rising whoomph. */
const ignite: Build = (ctx, noise, r) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.6, 0.35);
  g.gain.setTargetAtTime(0, 0.4, 0.4);
  const low = filter(ctx, "lowpass", 200, 0.8);
  low.frequency.setValueAtTime(150, 0);
  low.frequency.linearRampToValueAtTime(700, 0.4);
  chain(noiseBurst(ctx, noise, 0, 1.8, r.next()), low, g, ctx.destination);
};

/** A sheep: a quavering "baa". */
const bleat: Build = (ctx, _noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  const f = r.range(320, 460);
  const dur = r.range(0.45, 0.75);
  const contour: [number, number][] = [];
  // The quaver: the pitch wobbling as the sheep bleats.
  for (let t = 0; t <= dur; t += 0.02) {
    contour.push([t, f * (1 + 0.06 * Math.sin(t * 2 * Math.PI * r.range(7, 9)) - 0.1 * (t / dur))]);
  }
  voice(
    ctx,
    r,
    0,
    contour,
    [
      [700, 5, 1],
      [1250, 6, 0.6],
      [2600, 8, 0.2],
    ],
    0.05,
    out,
    0.05,
  );
};

/** A cow: a long, low "moo" rising and falling. */
const moo: Build = (ctx, _noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  const f = r.range(95, 130);
  const dur = r.range(0.9, 1.4);
  voice(
    ctx,
    r,
    0,
    [
      [0, f * 0.9],
      [dur * 0.4, f * 1.15],
      [dur, f * 0.85],
    ],
    [
      [330, 4, 1],
      [650, 5, 0.5],
      [1900, 7, 0.1],
    ],
    0.04,
    out,
    0.02,
  );
};

/** A hen: a few short clucks. */
const cluck: Build = (ctx, _noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  const n = r.int(2, 4);
  for (let i = 0; i < n; i++) {
    const f = r.range(520, 680);
    const d = r.range(0.06, 0.1);
    voice(
      ctx,
      r,
      i * r.range(0.14, 0.22),
      [
        [0, f],
        [d, f * 0.8],
      ],
      [
        [1100, 4, 1],
        [2300, 6, 0.4],
      ],
      0.02,
      out,
      0.06,
    );
  }
};

/** A dog: a bark or two. */
const bark: Build = (ctx, noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  const n = r.int(1, 2);
  for (let i = 0; i < n; i++) {
    const s = i * r.range(0.25, 0.4);
    const f = r.range(240, 330);
    voice(
      ctx,
      r,
      s,
      [
        [0, f * 1.2],
        [0.05, f],
        [0.14, f * 0.75],
      ],
      [
        [600, 3, 1],
        [1400, 4, 0.5],
      ],
      0.15,
      out,
      0.08,
    );
    chain(
      noiseBurst(ctx, noise, s, 0.12, r.next()),
      filter(ctx, "bandpass", 900, 1.2),
      envelope(ctx, s, 0.004, 0.08, 0.2),
      out,
    );
  }
};

/** A wolf's howl, long and far off: rising, held, falling away. */
const howl: Build = (ctx, _noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  const f = r.range(380, 460);
  const dur = r.range(2.2, 3);
  voice(
    ctx,
    r,
    0,
    [
      [0, f * 0.75],
      [0.5, f * 1.1],
      [dur * 0.6, f * 1.15],
      [dur, f * 0.8],
    ],
    [
      [f * 1.1, 6, 1],
      [f * 2.2, 8, 0.3],
    ],
    0.08,
    out,
    0.01,
  );
};

/** A low growl. */
const growl: Build = (ctx, noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  const f = r.range(70, 95);
  voice(
    ctx,
    r,
    0,
    [
      [0, f],
      [0.7, f * 0.9],
    ],
    [
      [400, 3, 1],
      [900, 4, 0.4],
    ],
    0.3,
    out,
    0.15,
  );
  chain(
    noiseBurst(ctx, noise, 0, 0.7, r.next()),
    filter(ctx, "lowpass", 400),
    envelope(ctx, 0, 0.05, 0.5, 0.3),
    out,
  );
};

/** Goblin war drums: a few beats of a skin drum, some way off. */
const drum: Build = (ctx, noise, r) => {
  const beats = [0, 0.32, 0.48, 0.8, 1.12, 1.28];
  for (const b of beats) {
    const k = r.range(0.95, 1.05);
    resonate(
      ctx,
      noise,
      ctx.destination,
      b + r.range(0, 0.02),
      [
        [92 * k, 0.35, 1],
        [156 * k, 0.2, 0.5],
        [240 * k, 0.1, 0.25],
      ],
      0.008,
      r.next(),
    );
  }
};

/** The dragon's roar: a great rough voice deep in a huge throat. */
const roar: Build = (ctx, noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  const f = r.range(58, 70);
  const dur = r.range(2.2, 2.8);
  voice(
    ctx,
    r,
    0,
    [
      [0, f * 0.8],
      [0.4, f * 1.3],
      [dur * 0.7, f * 1.1],
      [dur, f * 0.7],
    ],
    [
      [280, 2.5, 1],
      [620, 3, 0.6],
      [1400, 4, 0.25],
    ],
    0.5,
    out,
    0.18,
  );
  chain(
    noiseBurst(ctx, noise, 0, dur, r.next()),
    filter(ctx, "lowpass", 500),
    envelope(ctx, 0, 0.2, dur * 0.8, 0.4),
    out,
  );
};

/** A beat of great wings: a low rush of air. */
const flap: Build = (ctx, noise, r) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.8, 0.12);
  g.gain.setTargetAtTime(0, 0.18, 0.12);
  chain(
    noiseBurst(ctx, noise, 0, 0.7, r.next()),
    filter(ctx, "lowpass", r.range(220, 320), 0.8),
    g,
    ctx.destination,
  );
};

/** A crow taking off: a few quick, soft wingbeats, slowing as it rises. */
const flutter: Build = (ctx, noise, r) => {
  const beats = r.int(4, 7);
  let t = 0;
  let gap = r.range(0.07, 0.09);
  for (let i = 0; i < beats; i++) {
    const s = t;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, s);
    g.gain.linearRampToValueAtTime(0.6 * (1 - i / (beats + 2)), s + 0.02);
    g.gain.linearRampToValueAtTime(0, s + 0.06);
    chain(
      noiseBurst(ctx, noise, s, 0.07, r.next()),
      filter(ctx, "bandpass", r.range(700, 1100), 0.9),
      g,
      ctx.destination,
    );
    t += gap;
    gap *= r.range(1.08, 1.18);
  }
};

/** The dragon's fire: a roaring blast of flame. */
const breath: Build = (ctx, noise, r) => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.8, 0.1);
  g.gain.setValueAtTime(0.7, 0.6);
  g.gain.setTargetAtTime(0, 0.7, 0.25);
  const band = filter(ctx, "lowpass", 900, 0.7);
  chain(noiseBurst(ctx, noise, 0, 1.5, r.next()), band, g, ctx.destination);
  chain(
    noiseBurst(ctx, noise, 0, 1.2, r.next()),
    filter(ctx, "bandpass", 2400, 0.8),
    envelope(ctx, 0, 0.05, 0.6, 0.15),
    ctx.destination,
  );
};

/** A bow loosed: the string's twang and the arrow's hiss away. */
const bow: Build = (ctx, noise, r) => {
  resonate(
    ctx,
    noise,
    ctx.destination,
    0,
    [
      [r.range(150, 190), 0.25, 0.5],
      [r.range(600, 700), 0.1, 0.3],
    ],
    0.003,
    r.next(),
  );
  chain(
    noiseBurst(ctx, noise, 0.02, 0.25, r.next()),
    filter(ctx, "bandpass", 3500, 1.5),
    envelope(ctx, 0.02, 0.01, 0.15, 0.2),
    ctx.destination,
  );
};

/** A blow landing: a dull thump. */
const hit: Build = (ctx, noise, r) => {
  resonate(
    ctx,
    noise,
    ctx.destination,
    0,
    [
      [r.range(110, 150), 0.08, 1],
      [r.range(300, 380), 0.05, 0.4],
    ],
    0.006,
    r.next(),
  );
};

/** The wizard's spell: a soft shimmer of glassy tones, rising. */
const magic: Build = (ctx, noise, r) => {
  const base = r.range(900, 1100);
  const steps = [1, 1.25, 1.5, 2, 2.5, 3];
  steps.forEach((m, i) => {
    resonate(
      ctx,
      noise,
      ctx.destination,
      i * 0.07 + r.range(0, 0.02),
      [
        [base * m, 1.2, 0.5],
        [base * m * 2.01, 0.6, 0.15],
      ],
      0.02,
      r.next(),
    );
  });
};

/** A cartwheel rolling over a stone. */
const cart: Build = (ctx, noise, r) => {
  resonate(ctx, noise, ctx.destination, 0, woodModes(r.range(0.5, 0.7), 0.12), 0.01, r.next());
  chain(
    noiseBurst(ctx, noise, 0, 0.5, r.next()),
    filter(ctx, "lowpass", 300),
    envelope(ctx, 0, 0.05, 0.3, 0.4),
    ctx.destination,
  );
};

/**
 * One clap of the dancers round the fire: a few pairs of hands, not quite
 * together, each a short low-Q ring of cupped palms.
 */
const clap: Build = (ctx, noise, r) => {
  const out = filter(ctx, "lowpass", 3800, 0.6);
  out.connect(ctx.destination);
  const hands = r.int(3, 6);
  for (let i = 0; i < hands; i++) {
    resonate(
      ctx,
      noise,
      out,
      0.01 + r.range(0, 0.035),
      [
        [r.range(900, 1400), 0.012, r.range(0.5, 0.8)],
        [r.range(1900, 2700), 0.008, 0.35],
      ],
      0.003,
      r.next(),
    );
  }
};

/** A bell to be struck: its pitch (Hz of the prime), how long it rings, and how hard it is struck. */
interface BellVoice {
  f: number;
  /** Scales how long every partial rings. */
  ring: number;
  /** Seconds the clapper's blow lasts: longer is softer. */
  blow: number;
  /** How much of the upper partials the stroke brings out, 0 to 1. */
  bright: number;
}

/**
 * A bell: a struck bronze body, its hum, prime, tierce, quint and nominal
 * each ringing and fading at its own pace. The stroke swells over a few
 * milliseconds rather than cracking, heard from a tower across the town.
 */
const bell =
  (v: BellVoice): Build =>
  (ctx, noise, r) => {
    const f = v.f * r.range(0.995, 1.005);
    const t = v.ring;
    const b = v.bright;
    const out = filter(ctx, "lowpass", f * (3 + 3 * b), 0.5);
    out.connect(ctx.destination);
    resonate(
      ctx,
      noise,
      out,
      0.005,
      [
        [f * 0.5, 4.5 * t, 0.45],
        [f, 3.6 * t, 0.6],
        [f * 1.004, 3.4 * t, 0.35],
        [f * 1.19, 2.4 * t, 0.3 * (0.5 + b / 2)],
        [f * 1.5, 1.8 * t, 0.25 * (0.4 + b * 0.6)],
        [f * 2, 1.4 * t, 0.3 * b],
        [f * 2.67, 0.9 * t, 0.15 * b],
        [f * 3.01, 0.7 * t, 0.1 * b],
      ],
      v.blow,
      r.next(),
    );
  };

/** The great bell, tolled for the hours. */
const HOUR_BELL: BellVoice = { f: 270, ring: 1, blow: 0.008, bright: 0.8 };
/** The small watch bell, rung fast for a raid. */
const WATCH_BELL: BellVoice = { f: 560, ring: 0.35, blow: 0.004, bright: 1 };
/** The great bell struck gently, a tone lower, for the service. */
const SERVICE_BELL: BellVoice = { f: 240, ring: 1.1, blow: 0.016, bright: 0.45 };
/** The peal of three rung when the raid is over: the prime of each, from the highest. */
const PEAL = [392, 330, 262];

/** A duck: a run of nasal, rasping quacks, each lower and shorter than the one before. */
const quack: Build = (ctx, noise, r) => {
  const out = gainNode(ctx, 1);
  out.connect(ctx.destination);
  const n = r.int(1, 4);
  let s = 0;
  let f = r.range(230, 290);
  let len = r.range(0.16, 0.22);
  for (let i = 0; i < n; i++) {
    voice(
      ctx,
      r,
      s,
      [
        [0, f * 0.92],
        [len * 0.25, f],
        [len, f * 0.8],
      ],
      [
        [r.range(900, 1100), 5, 1],
        [r.range(1700, 2000), 7, 0.7],
        [r.range(2800, 3200), 9, 0.25],
      ],
      0.04,
      out,
      0.12,
    );
    // The rasp: a burst of breath through the bill.
    chain(
      noiseBurst(ctx, noise, s, len, r.next()),
      filter(ctx, "bandpass", 1500, 2),
      envelope(ctx, s, 0.01, len * 0.7, 0.08),
      out,
    );
    s += len + r.range(0.1, 0.16);
    f *= r.range(0.9, 0.96);
    len *= 0.9;
  }
};

/** A torch thrown: the swish of it through the air. */
const sweep: Build = (ctx, noise, r) => {
  const band = filter(ctx, "bandpass", 800, 1);
  band.frequency.setValueAtTime(500, 0);
  band.frequency.linearRampToValueAtTime(1600, 0.25);
  chain(
    noiseBurst(ctx, noise, 0, 0.35, r.next()),
    band,
    envelope(ctx, 0, 0.08, 0.2, 0.6),
    ctx.destination,
  );
};

/**
 * A long loop of fire: a deep rushing roar with soft crackles in it (low and
 * rounded, never sharp clicks).
 */
async function fireLoop(sampleRate: number, seed: number): Promise<AudioBuffer> {
  const seconds = 6;
  // Rendered past the loop's end, so the tail can be folded into the head.
  const rendered = seconds + 0.3;
  const buffer = await renderOffline(sampleRate, rendered, (ctx) => {
    const r = new Rng(seed);
    const brown = noiseBuffer(ctx, rendered, "brown", seed);
    const pink = noiseBuffer(ctx, rendered, "pink", seed + 1);
    const roarSrc = ctx.createBufferSource();
    roarSrc.buffer = brown;
    roarSrc.start(0);
    chain(roarSrc, filter(ctx, "lowpass", 380), gainNode(ctx, 0.9), ctx.destination);
    for (let t = 0.02; t < rendered - 0.1; t += r.range(0.03, 0.18)) {
      resonate(
        ctx,
        pink,
        ctx.destination,
        t,
        [
          [r.range(500, 1100), 0.02, 0.25],
          [r.range(1500, 2400), 0.012, 0.1],
        ],
        0.004,
        r.next(),
      );
    }
  });
  return seamlessLoop(buffer, seconds);
}

export async function buildSoundBank(sampleRate: number, seed: number): Promise<SoundBank> {
  const probe = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate });
  // Long enough that the longest burst drawn from it, thunder's, never runs out.
  const white = noiseBuffer(probe, 6, "white", seed);
  const pink = noiseBuffer(probe, 6, "pink", seed + 1);
  const brown = noiseBuffer(probe, 6, "brown", seed + 2);
  let n = 0;
  const render = (seconds: number, build: Build, rate = sampleRate) => {
    const rng = new Rng(seed + 100 + n++);
    return renderOffline(rate, seconds, (ctx) => build(ctx, white, rng));
  };
  // Every sound is brought to one peak; the engine sets how loud each is heard.
  const set = (count: number, seconds: number, build: Build, rate = sampleRate) =>
    Promise.all(
      Array.from({ length: count }, () => render(seconds, build, rate).then((b) => normalize(b))),
    );
  const shots: Record<SoundKind, Promise<AudioBuffer[]>> = {
    chop: set(4, 0.4, chop),
    treefall: set(2, 3, treefall),
    hammer: set(4, 0.3, hammer),
    saw: set(3, 0.7, saw),
    chisel: set(4, 0.25, chisel),
    dig: set(3, 0.5, dig),
    hoe: set(3, 0.3, hoe),
    reap: set(3, 0.45, reap),
    anvil: set(3, 2, anvil),
    door: set(3, 0.5, door),
    logs: set(3, 0.6, logs),
    stones: set(3, 0.4, stones),
    splash: set(3, 0.7, splash),
    bucket: set(2, 0.8, bucket),
    hiss: set(2, 2.2, hiss),
    collapse: set(2, 3, collapse),
    ignite: set(2, 1.6, ignite),
    howl: set(3, 3.3, howl),
    growl: set(2, 1, growl),
    drum: set(2, 2, drum),
    roar: set(2, 3.2, roar),
    flap: set(3, 0.8, flap),
    takeoff: set(3, 1, flutter),
    breath: set(2, 1.6, breath),
    bow: set(2, 0.5, bow),
    hit: set(3, 0.4, hit),
    magic: set(2, 2.5, magic),
    bleat: set(4, 1, bleat),
    moo: set(3, 1.6, moo),
    cluck: set(3, 1, cluck),
    rooster: set(2, 2.2, rooster),
    bark: set(3, 0.9, bark),
    cart: set(2, 0.7, cart),
    clap: set(4, 0.25, clap),
    bell: set(1, 7, bell(HOUR_BELL), MELLOW_RATE),
    alarm: set(2, 1.8, bell(WATCH_BELL), MELLOW_RATE),
    allclear: Promise.all(
      PEAL.map((f) =>
        render(4.5, bell({ f, ring: 0.8, blow: 0.01, bright: 0.6 }), MELLOW_RATE).then((b) =>
          normalize(b),
        ),
      ),
    ),
    service: set(1, 7.5, bell(SERVICE_BELL), MELLOW_RATE),
    sweep: set(2, 0.5, sweep),
    caw: set(3, 4, crow),
    quack: set(3, 1.4, quack),
  };
  const calls: { [K in keyof Calls]: Promise<AudioBuffer[]> } = {
    sparrow: set(5, 1.8, sparrow),
    tit: set(3, 2.8, shijukara),
    crow: set(3, 4, crow),
    blackbird: set(4, 3.2, blackbird),
    lark: set(3, 5, lark),
    cuckoo: set(3, 2.9, cuckoo),
    owl: set(3, 2.8, owl),
    frog: set(6, 1.5, frog),
    cricket: set(4, 3.2, korogi),
    rooster: set(2, 2.2, rooster),
  };
  const done = <T extends object>(o: { [K in keyof T]: Promise<T[K]> }): Promise<T> =>
    Promise.all(
      Object.entries(o).map(async ([k, v]) => [k, await (v as Promise<unknown>)] as const),
    ).then((entries) => Object.fromEntries(entries) as T);
  const [shotBuffers, callBuffers, near, far, ticks, fire, tunes] = await Promise.all([
    done<Record<SoundKind, AudioBuffer[]>>(shots),
    done<Calls>(calls),
    render(8.5, thunder(true)),
    render(9, thunder(false)),
    Promise.all([0, 1, 2, 3].map((v) => render(0.06, dropTick(v)))),
    fireLoop(sampleRate, seed + 7),
    Promise.all(
      Array.from({ length: TUNES }, () =>
        Promise.all(
          [0, 1, 2, 3].map((part) =>
            render(PHRASE + 0.5, (ctx, noise, r) => tune(ctx, noise, r, part), MELLOW_RATE).then(
              (b) => normalize(b),
            ),
          ),
        ),
      ),
    ),
  ]);
  return {
    tunes,
    shots: shotBuffers,
    calls: callBuffers,
    thunder: [near, far],
    dropTicks: ticks,
    fire,
    noise: { white, pink, brown },
  };
}
