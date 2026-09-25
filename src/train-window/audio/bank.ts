import { Rng } from "../core/random.ts";
import {
  type Build,
  chain,
  envelope,
  filter,
  noiseBuffer,
  noiseBurst,
  renderOffline,
} from "./synth.ts";
import * as calls from "./wildlife.ts";

/** Every one-shot sound, synthesized once when the ride starts. */
export interface SoundBank {
  joints: AudioBuffer[];
  bridgeJoints: AudioBuffer[];
  crossingBell: AudioBuffer;
  chimeOpen: AudioBuffer;
  chimeClose: AudioBuffer;
  melody: AudioBuffer;
  airRelease: AudioBuffer;
  doorSlide: AudioBuffer;
  stopThunk: AudioBuffer;
  thunder: AudioBuffer[];
  fireworkBoom: AudioBuffer[];
  crackle: AudioBuffer;
  dropTicks: AudioBuffer[];
  click: AudioBuffer;
  pressure: AudioBuffer;
  /** Several distinct calls of each species. */
  wildlife: Wildlife;
  creaks: AudioBuffer[];
  noise: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer };
}

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

function tone(
  ctx: BaseAudioContext,
  type: OscillatorType,
  freq: number,
  start: number,
  stop: number,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  o.start(start);
  o.stop(stop);
  return o;
}

/** A struck note: partials with individual decays, like a bell or a marimba bar. */
function strike(
  ctx: BaseAudioContext,
  out: AudioNode,
  freq: number,
  start: number,
  partials: readonly (readonly [number, number, number])[],
): void {
  for (const [ratio, amp, decay] of partials) {
    const o = tone(ctx, "sine", freq * ratio, start, start + decay * 5);
    const g = envelope(ctx, start, 0.002, decay, amp);
    chain(o, g, out);
  }
}

const MARIMBA = [
  [1, 0.55, 0.5],
  [4, 0.12, 0.08],
  [10, 0.03, 0.02],
] as const;

const BELL = [
  [1, 0.5, 0.45],
  [2.02, 0.28, 0.25],
  [2.76, 0.2, 0.18],
  [3.9, 0.12, 0.1],
] as const;

function midi(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}

const joint =
  (variant: number, bridge: boolean): Build =>
  (ctx, noise, r) => {
    const out = ctx.createGain();
    out.connect(ctx.destination);
    // Wheel thump.
    const thump = tone(ctx, "sine", 78 + variant * 9, 0, 0.4);
    thump.frequency.exponentialRampToValueAtTime(44, 0.09);
    chain(thump, envelope(ctx, 0, 0.002, 0.13, 0.9), out);
    // Steel click.
    chain(
      noiseBurst(ctx, noise, 0, 0.08, r.next()),
      filter(ctx, "bandpass", 1700 + variant * 280, 1.1),
      envelope(ctx, 0, 0.001, 0.04, 0.7),
      out,
    );
    // Body clack.
    chain(
      noiseBurst(ctx, noise, 0.004, 0.15, r.next()),
      filter(ctx, "bandpass", 430 + variant * 40, 2.2),
      envelope(ctx, 0.004, 0.003, 0.08, 0.55),
      out,
    );
    // Faint ring of the rail.
    chain(
      noiseBurst(ctx, noise, 0, 0.4, r.next()),
      filter(ctx, "bandpass", 3100 + variant * 150, 28),
      envelope(ctx, 0, 0.001, 0.25, bridge ? 1.2 : 0.35),
      out,
    );
    if (bridge) {
      const boom = tone(ctx, "sine", 52, 0, 0.8);
      chain(boom, envelope(ctx, 0, 0.004, 0.45, 0.6), out);
      chain(
        noiseBurst(ctx, noise, 0, 0.6, r.next()),
        filter(ctx, "bandpass", 880, 9),
        envelope(ctx, 0, 0.002, 0.3, 0.8),
        out,
      );
      chain(
        noiseBurst(ctx, noise, 0, 0.6, r.next()),
        filter(ctx, "bandpass", 1450, 14),
        envelope(ctx, 0, 0.002, 0.22, 0.5),
        out,
      );
    }
  };

const crossingBell: Build = (ctx) => {
  const out = ctx.createGain();
  out.gain.value = 0.8;
  out.connect(ctx.destination);
  strike(ctx, out, 760, 0, BELL);
};

const chimeOpen: Build = (ctx) => {
  const speaker = filter(ctx, "bandpass", 1800, 0.5);
  speaker.connect(ctx.destination);
  strike(ctx, speaker, midi(88), 0, [
    [1, 0.6, 0.5],
    [2, 0.12, 0.2],
  ]);
  strike(ctx, speaker, midi(84), 0.42, [
    [1, 0.6, 1.3],
    [2, 0.12, 0.4],
  ]);
};

const chimeClose: Build = (ctx) => {
  const speaker = filter(ctx, "bandpass", 1800, 0.5);
  speaker.connect(ctx.destination);
  for (let i = 0; i < 6; i++) {
    strike(ctx, speaker, midi(i % 2 === 0 ? 86 : 81), i * 0.3, [
      [1, 0.45, 0.28],
      [2, 0.08, 0.12],
    ]);
  }
};

/** An original departure melody, played on a marimba over soft chords. */
const melody: Build = (ctx) => {
  const out = ctx.createGain();
  out.gain.value = 0.7;
  out.connect(ctx.destination);
  const beat = 0.27;
  // F major: a gentle climb, a turn, and home.
  const tune: readonly (readonly [number, number])[] = [
    [77, 1],
    [81, 1],
    [84, 1],
    [81, 1],
    [82, 1],
    [81, 1],
    [79, 1],
    [77, 1],
    [79, 1],
    [82, 1],
    [86, 1],
    [84, 1],
    [81, 2],
    [84, 2],
    [86, 1],
    [84, 1],
    [82, 1],
    [81, 1],
    [79, 1],
    [81, 1],
    [82, 1],
    [79, 1],
    [76, 1],
    [79, 1],
    [84, 1],
    [82, 1],
    [81, 1],
    [79, 1],
    [77, 2],
  ];
  let t = 0.05;
  for (const [note, beats] of tune) {
    strike(ctx, out, midi(note), t, MARIMBA);
    t += beats * beat;
  }
  const chords: readonly (readonly number[])[] = [
    [53, 57, 60],
    [58, 62, 65],
    [55, 58, 62],
    [53, 57, 60],
    [58, 62, 65],
    [55, 58, 62],
    [48, 55, 58, 64],
    [53, 57, 60],
  ];
  chords.forEach((chord, i) => {
    const start = 0.05 + i * 4 * beat;
    for (const n of chord) {
      const o = tone(ctx, "triangle", midi(n), start, start + 4 * beat + 0.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.05, start + 0.08);
      g.gain.setTargetAtTime(0, start + 4 * beat - 0.05, 0.15);
      chain(o, g, out);
    }
  });
};

const airRelease: Build = (ctx, noise, r) => {
  const hiss = noiseBurst(ctx, noise, 0, 2, r.next());
  const bp = filter(ctx, "bandpass", 4200, 0.9);
  bp.frequency.setValueAtTime(4200, 0);
  bp.frequency.exponentialRampToValueAtTime(2300, 1.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.7, 0.03);
  g.gain.setValueAtTime(0.7, 0.45);
  g.gain.setTargetAtTime(0, 0.45, 0.35);
  chain(hiss, filter(ctx, "highpass", 1500), bp, g, ctx.destination);
};

const doorSlide: Build = (ctx, noise, r) => {
  const rumble = noiseBurst(ctx, noise, 0, 1.3, r.next());
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.5, 0.1);
  g.gain.setValueAtTime(0.5, 0.75);
  g.gain.linearRampToValueAtTime(0, 0.85);
  chain(rumble, filter(ctx, "lowpass", 380), g, ctx.destination);
  const thunk = tone(ctx, "sine", 95, 0.82, 1.2);
  chain(thunk, envelope(ctx, 0.82, 0.003, 0.12, 0.8), ctx.destination);
  chain(
    noiseBurst(ctx, noise, 0.82, 0.1, r.next()),
    filter(ctx, "bandpass", 1200, 1.5),
    envelope(ctx, 0.82, 0.001, 0.05, 0.4),
    ctx.destination,
  );
};

const stopThunk: Build = (ctx, noise, r) => {
  const o = tone(ctx, "sine", 48, 0, 0.6);
  chain(o, envelope(ctx, 0, 0.02, 0.35, 0.7), ctx.destination);
  chain(
    noiseBurst(ctx, noise, 0, 0.5, r.next()),
    filter(ctx, "lowpass", 200),
    envelope(ctx, 0, 0.02, 0.3, 0.6),
    ctx.destination,
  );
};

const thunder =
  (near: boolean): Build =>
  (ctx, noise, r) => {
    const out = ctx.createGain();
    out.connect(ctx.destination);
    if (near) {
      chain(
        noiseBurst(ctx, noise, 0, 0.4, r.next()),
        filter(ctx, "highpass", 900),
        envelope(ctx, 0, 0.002, 0.25, 0.6),
        out,
      );
    }
    // Rolling rumble: several overlapping swells.
    for (let i = 0; i < 7; i++) {
      const start = (near ? 0.05 : 0.2) + i * r.range(0.35, 0.9);
      const dur = r.range(1.2, 2.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(r.range(0.3, 0.8) * (1 - i * 0.1), start + r.range(0.1, 0.4));
      g.gain.setTargetAtTime(0, start + 0.4, dur / 3);
      chain(
        noiseBurst(ctx, noise, start, dur + 1.5, r.next()),
        filter(ctx, "lowpass", near ? 420 : 220),
        g,
        out,
      );
    }
  };

const fireworkBoom =
  (variant: number): Build =>
  (ctx, noise, r) => {
    const o = tone(ctx, "sine", 70 - variant * 8, 0, 1.5);
    o.frequency.exponentialRampToValueAtTime(34, 0.4);
    chain(o, envelope(ctx, 0, 0.004, 0.6, 0.9), ctx.destination);
    chain(
      noiseBurst(ctx, noise, 0, 2, r.next()),
      filter(ctx, "lowpass", 260),
      envelope(ctx, 0, 0.01, 1.3, 0.8),
      ctx.destination,
    );
  };

const crackle: Build = (ctx, noise, r) => {
  for (let i = 0; i < 70; i++) {
    const t = Math.pow(r.next(), 0.7) * 1.6;
    chain(
      noiseBurst(ctx, noise, t, 0.02, r.next()),
      filter(ctx, "highpass", 2500),
      envelope(ctx, t, 0.001, 0.012, r.range(0.2, 0.6)),
      ctx.destination,
    );
  }
};

const dropTick =
  (variant: number): Build =>
  (ctx, noise, r) => {
    chain(
      noiseBurst(ctx, noise, 0, 0.04, r.next()),
      filter(ctx, "bandpass", 2600 + variant * 1300, 3),
      envelope(ctx, 0, 0.001, 0.012, 0.8),
      ctx.destination,
    );
  };

const click: Build = (ctx, noise, r) => {
  chain(
    noiseBurst(ctx, noise, 0, 0.03, r.next()),
    filter(ctx, "bandpass", 2600, 2),
    envelope(ctx, 0, 0.001, 0.01, 0.7),
    ctx.destination,
  );
  const o = tone(ctx, "sine", 220, 0, 0.1);
  chain(o, envelope(ctx, 0, 0.001, 0.03, 0.4), ctx.destination);
};

const pressure: Build = (ctx, noise, r) => {
  const o = tone(ctx, "sine", 32, 0, 1);
  chain(o, envelope(ctx, 0, 0.02, 0.5, 0.9), ctx.destination);
  chain(
    noiseBurst(ctx, noise, 0, 1, r.next()),
    filter(ctx, "lowpass", 140),
    envelope(ctx, 0, 0.02, 0.45, 0.9),
    ctx.destination,
  );
};

const creak =
  (variant: number): Build =>
  (ctx, noise, r) => {
    const src = noiseBurst(ctx, noise, 0, 0.6, r.next());
    const bp = filter(ctx, "bandpass", 320 + variant * 140, 18);
    bp.frequency.linearRampToValueAtTime(520 + variant * 160, 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.9, 0.12);
    g.gain.linearRampToValueAtTime(0, 0.5);
    chain(src, bp, g, ctx.destination);
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
  const [
    joints,
    bridgeJoints,
    crossing,
    open,
    close,
    tune,
    air,
    door,
    stop,
    thunders,
    booms,
    crack,
    ticks,
    clk,
    press,
    creaks,
    wildlife,
  ] = await Promise.all([
    Promise.all([0, 1, 2, 3].map((v) => render(0.5, joint(v, false)))),
    Promise.all([0, 1, 2].map((v) => render(1.0, joint(v, true)))),
    render(0.9, crossingBell),
    render(2.2, chimeOpen),
    render(2.3, chimeClose),
    render(9.6, melody),
    render(2.2, airRelease),
    render(1.3, doorSlide),
    render(0.8, stopThunk),
    Promise.all([true, false].map((near) => render(7, thunder(near)))),
    Promise.all([0, 1].map((v) => render(2.2, fireworkBoom(v)))),
    render(1.8, crackle),
    Promise.all([0, 1, 2, 3].map((v) => render(0.06, dropTick(v)))),
    render(0.12, click),
    render(1.1, pressure),
    Promise.all([0, 1].map((v) => render(0.6, creak(v)))),
    renderWildlife(render),
  ]);
  return {
    joints,
    bridgeJoints,
    crossingBell: crossing,
    chimeOpen: open,
    chimeClose: close,
    melody: tune,
    airRelease: air,
    doorSlide: door,
    stopThunk: stop,
    thunder: thunders,
    fireworkBoom: booms,
    crackle: crack,
    dropTicks: ticks,
    click: clk,
    pressure: press,
    creaks,
    wildlife,
    noise: { white, pink, brown },
  };
}

async function renderWildlife(
  render: (seconds: number, build: Build) => Promise<AudioBuffer>,
): Promise<Wildlife> {
  const many = (count: number, seconds: number, build: Build) =>
    Promise.all(Array.from({ length: count }, () => render(seconds, build)));
  const [
    uguisu,
    sparrow,
    hiyodori,
    shijukara,
    crow,
    frog,
    suzumushi,
    korogi,
    matsumushi,
    minmin,
    higurashi,
    tsukutsukuboshi,
  ] = await Promise.all([
    Promise.all([0, 0, 1, 1, 2, 3].map((v) => render(3.2, calls.uguisu(v)))),
    many(6, 1.8, calls.sparrow),
    many(4, 3.8, calls.hiyodori),
    many(4, 2.8, calls.shijukara),
    many(4, 4, calls.crow),
    many(8, 1.5, calls.frog),
    many(5, 2.8, calls.suzumushi),
    many(5, 3.2, calls.korogi),
    many(3, 2.6, calls.matsumushi),
    many(4, 5.2, calls.minmin),
    many(4, 3.2, calls.higurashi),
    many(3, 6.2, calls.tsukutsukuboshi),
  ]);
  return {
    uguisu,
    sparrow,
    hiyodori,
    shijukara,
    crow,
    frog,
    suzumushi,
    korogi,
    matsumushi,
    minmin,
    higurashi,
    tsukutsukuboshi,
  };
}
