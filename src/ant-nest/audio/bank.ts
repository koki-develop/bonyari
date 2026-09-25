import { Rng } from "../../shared/core/random.ts";
import {
  type Build,
  chain,
  filter,
  noiseBuffer,
  noiseBurst,
  normalize,
  renderOffline,
} from "../../shared/audio/synth.ts";
import { thunder } from "../../shared/audio/weather-sounds.ts";
import { renderWildlife, type Wildlife } from "../../shared/audio/wildlife.ts";

/**
 * Every one-shot sound of the nest, synthesized once when the visit starts.
 * They are heard as if through the soil itself: soft, dull and dry, soil
 * scraped, pressed and dropped, and what falls on the ground above.
 */
export interface SoundBank {
  /** A bite at the face of a tunnel: soil scraped loose. */
  bite: AudioBuffer[];
  /** A pellet dropped on the heap, the loose soil hushing down. */
  drop: AudioBuffer[];
  /** Soil pressed into a plug. */
  pack: AudioBuffer[];
  /** A crumb landing on the ground above. */
  crumb: AudioBuffer[];
  /** A dead insect landing, lighter. */
  insect: AudioBuffer[];
  /** Wings beating: a small whirr. */
  whirr: AudioBuffer;
  /** Wings snapped off, a cocoon torn open: a faint rustle. */
  rustle: AudioBuffer[];
  /** A raindrop on the ground above, heard below. */
  thud: AudioBuffer[];
  thunder: AudioBuffer[];
  wildlife: Wildlife;
  noise: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer };
}

/**
 * A soft puff of filtered noise: rising over `attack`, fading over `decay`
 * (seconds), through a gentle band around `freq`. Every sound of the soil is
 * made of these, with no ringing tones, so nothing clicks or smacks.
 */
function puff(
  ctx: OfflineAudioContext,
  noise: AudioBuffer,
  out: AudioNode,
  at: number,
  type: BiquadFilterType,
  freq: number,
  attack: number,
  decay: number,
  level: number,
  offset: number,
): void {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(level, at + attack);
  g.gain.setTargetAtTime(0, at + attack, decay / 3);
  chain(
    noiseBurst(ctx, noise, at, attack + decay * 2, offset),
    filter(ctx, type, freq, 0.6),
    g,
    out,
  );
}

/** The jaws working at the face: a soft scrape of soil loosening, and a dull push through the ground. */
const bite: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  puff(ctx, noise, out, 0, "bandpass", r.range(900, 1500), 0.012, 0.09, 0.6, r.next());
  puff(ctx, noise, out, 0.01, "lowpass", r.range(220, 320), 0.01, 0.05, 0.8, r.next());
};

/** A pellet landing on the heap: a soft knock, and the loose soil hushing down its side. */
const drop: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  puff(ctx, noise, out, 0, "lowpass", r.range(380, 520), 0.004, 0.05, 1, r.next());
  puff(ctx, noise, out, 0.02, "bandpass", r.range(1200, 1800), 0.03, 0.18, 0.18, r.next());
};

/** Soil pressed into a plug: a muffled pat. */
const pack: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  puff(ctx, noise, out, 0, "lowpass", r.range(300, 480), 0.006, 0.05, 1, r.next());
};

/** A crumb of bread landing on the ground: a small, soft "tup". */
const crumb: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  puff(ctx, noise, out, 0, "lowpass", r.range(500, 700), 0.003, 0.04, 1, r.next());
};

/** A dead insect dropping onto the ground: lighter still. */
const insect: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  puff(ctx, noise, out, 0, "lowpass", r.range(700, 900), 0.003, 0.025, 1, r.next());
};

/**
 * Wings beating: noise shaped by the wingbeat, a fast flutter well below the
 * whine of a fly, swelling up and fading as the ant goes.
 */
function whirr(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.floor(sampleRate * 1.4), sampleRate);
  const data = buffer.getChannelData(0);
  const r = new Rng(seed);
  let lp = 0;
  let bp = 0;
  const beat = 170;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    // Filtered noise, pumped by the wingbeat, its rate wavering a little.
    const white = r.next() * 2 - 1;
    lp += (white - lp) * 0.18;
    bp += (lp - bp) * 0.05;
    const band = lp - bp;
    const phase = t * beat * (1 + 0.04 * Math.sin(t * 7));
    const pump = Math.pow(0.5 + 0.5 * Math.sin(phase * Math.PI * 2), 3);
    const swell = Math.min(1, t / 0.15) * Math.min(1, (1.4 - t) / 0.6);
    data[i] = band * pump * swell;
  }
  return normalize(buffer, 0.8);
}

/** Wings snapped off, a cocoon torn open: a faint, dry rustle. */
const rustle: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  puff(ctx, noise, out, 0, "bandpass", r.range(1400, 2000), 0.02, 0.12, 1, r.next());
};

/** A raindrop hitting the ground above, heard from below: a soft, low thud. */
const thud: Build = (ctx, noise, r) => {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  puff(ctx, noise, out, 0, "lowpass", r.range(160, 280), 0.004, 0.06, 1, r.next());
};

export async function buildSoundBank(sampleRate: number, seed: number): Promise<SoundBank> {
  const probe = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate });
  const white = noiseBuffer(probe, 3, "white", seed);
  const pink = noiseBuffer(probe, 6, "pink", seed + 1);
  const brown = noiseBuffer(probe, 6, "brown", seed + 2);
  let n = 0;
  const render = (seconds: number, build: Build) => {
    const rng = new Rng(seed + 300 + n++);
    return renderOffline(sampleRate, seconds, (ctx) => build(ctx, white, rng));
  };
  // Every one-shot is brought to one peak; how loud each plays is set where it is played.
  const shots = (count: number, seconds: number, build: Build) =>
    Promise.all(
      Array.from({ length: count }, () => render(seconds, build).then((b) => normalize(b))),
    );
  const [bites, drops, packs, crumbs, insects, rustles, thuds, thunders, wildlife] =
    await Promise.all([
      shots(8, 0.35, bite),
      shots(6, 0.6, drop),
      shots(4, 0.25, pack),
      shots(4, 0.2, crumb),
      shots(3, 0.15, insect),
      shots(4, 0.4, rustle),
      shots(6, 0.3, thud),
      Promise.all([render(9, thunder(true)), render(9, thunder(false))]),
      renderWildlife(render),
    ]);
  return {
    bite: bites,
    drop: drops,
    pack: packs,
    crumb: crumbs,
    insect: insects,
    whirr: whirr(probe, seed ^ 0x5717),
    rustle: rustles,
    thud: thuds,
    thunder: thunders,
    wildlife,
    noise: { white, pink, brown },
  };
}
