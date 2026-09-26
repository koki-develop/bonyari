import { AudioEngineBase, type Loop, MAX_CADENCE } from "../../shared/audio/engine-base.ts";
import { daytime, nighttime } from "../../shared/audio/chorus.ts";
import { chain, filter, gainNode, impulseResponse } from "../../shared/audio/synth.ts";
import { bump, clamp, clamp01, cyclicBump, smoothstep } from "../../shared/core/math.ts";
import { noise1 } from "../../shared/core/random.ts";
import { KINDS } from "../sim/buildings.ts";
import { bonfireSpot, festive } from "../sim/festival.ts";
import { inRect } from "../sim/geometry.ts";
import type { SoundKind, World } from "../sim/world.ts";
import { buildSoundBank, type Calls, type SoundBank } from "./bank.ts";
import { BEAT, BEATS, PHRASE } from "./tune.ts";

const SPEED_OF_SOUND = 343;
/** Meters within which a sound is heard at full strength, in the view the screen opens on. */
const EAR_REACH = 18;
/** Seconds the ear takes to follow the view most of the way. */
const EAR_GLIDE = 0.5;
/** Seconds over which the one-shots heard are counted against their budgets. */
const BUDGET_WINDOW = 2;
/**
 * Most one-shots of a kind heard per second, the loudest of those offered:
 * forty people at work should be a soft patter of the few nearest, not all
 * of them at once. Kinds not listed are rare enough to be heard every time.
 */
const PER_SECOND: Partial<Record<SoundKind, number>> = {
  chop: 1.2,
  hammer: 1.5,
  saw: 0.8,
  chisel: 1.5,
  dig: 1,
  hoe: 1,
  reap: 1,
  anvil: 1,
  logs: 0.6,
  stones: 0.6,
  door: 0.8,
  bucket: 0.6,
  splash: 0.4,
  cart: 0.5,
  bleat: 0.6,
  moo: 0.4,
  cluck: 0.8,
  bark: 0.6,
  caw: 0.5,
  takeoff: 0.6,
  quack: 0.5,
  hit: 3,
  bow: 2,
  sweep: 2,
};
/** The sounds of work, and the most of them all together heard per second. */
const WORK = new Set<SoundKind>([
  "chop",
  "hammer",
  "saw",
  "chisel",
  "dig",
  "hoe",
  "reap",
  "anvil",
  "logs",
  "stones",
]);
const WORK_PER_SECOND = 3.5;
/** Work farther off than this share of its full loudness is not heard at all. */
const WORK_FLOOR = 0.15;
/**
 * How loud (peak, before the master) each sound is when it happens right by
 * the ear: the work of a busy place a little above the hush of the air,
 * never a jolt. The bells, the alarm and the dragon carry.
 */
const PEAK: Record<SoundKind, number> = {
  chop: 0.05,
  treefall: 0.1,
  hammer: 0.04,
  saw: 0.028,
  chisel: 0.028,
  dig: 0.03,
  hoe: 0.025,
  reap: 0.028,
  anvil: 0.045,
  door: 0.028,
  logs: 0.035,
  stones: 0.03,
  splash: 0.045,
  bucket: 0.028,
  hiss: 0.045,
  collapse: 0.16,
  ignite: 0.08,
  howl: 0.09,
  growl: 0.05,
  drum: 0.1,
  roar: 0.22,
  flap: 0.1,
  takeoff: 0.018,
  breath: 0.16,
  bow: 0.045,
  hit: 0.045,
  magic: 0.05,
  bleat: 0.035,
  moo: 0.04,
  cluck: 0.025,
  rooster: 0.05,
  bark: 0.04,
  cart: 0.035,
  clap: 0.016,
  bell: 0.06,
  alarm: 0.065,
  allclear: 0.05,
  service: 0.045,
  sweep: 0.035,
  caw: 0.03,
  quack: 0.025,
};
/** How much farther than the ear's reach some sounds carry. */
const CARRY: Partial<Record<SoundKind, number>> = {
  treefall: 2,
  collapse: 3,
  howl: 6,
  drum: 5,
  roar: 9,
  flap: 3,
  breath: 3,
  bell: 9,
  alarm: 9,
  allclear: 9,
  service: 8,
  rooster: 4,
  anvil: 1.5,
  caw: 2,
};
/** The peak every one-shot of the bank is brought to (see `normalize`). */
const BANK_PEAK = 0.9;
/** How loud the harvest music is right by the fire, and how far beyond the ear's reach it carries. */
const MUSIC_PEAK = 0.018;
const MUSIC_CARRY = 3;
/**
 * Seconds between one dancer's claps, on average (the sim's `feast` task),
 * and the seconds over which the claps heard are remembered: together they
 * give how many dancers are clapping within earshot.
 */
const CLAP_EVERY = 1.85;
const CLAP_MEMORY = 4;
/** Dancers within earshot at which the clapping is at its fullest. */
const FULL_CLAPPING = 8;

/**
 * What each ringing is: which stroke (index into the kind's buffers, or -1
 * for any), when (s after the first), and how hard (share of the peak).
 */
type Peal = readonly (readonly [number, number, number])[];

/** The hour: three measured strokes of the great bell. */
const HOURS: Peal = [
  [0, 0, 0.65],
  [0, 2.4, 0.8],
  [0, 4.8, 0.75],
];
/** The service: the great bell tolled slowly and gently, seven times. */
const SERVICE: Peal = Array.from({ length: 7 }, (_, i) => [
  0,
  i * 3.2,
  0.65 + 0.05 * Math.min(i, 4),
]);
/** The raid: the watch bell rung fast and hard, the ringer swinging into it. */
const ALARM: Peal = Array.from({ length: 24 }, (_, i) => [
  -1,
  i * 0.3 + (i % 2) * 0.03,
  (0.5 + 0.5 * Math.min(1, i / 6)) * (i % 2 ? 0.85 : 1),
]);
/** The all-clear: a round of three bells coming down, rung four times at an easy pace, then the lowest alone. */
const ALL_CLEAR: Peal = [
  ...Array.from({ length: 12 }, (_, i) => {
    const round = Math.floor(i / 3);
    return [i % 3, i * 0.62 + round * 0.5, 0.7 + 0.1 * (round % 2)] as const;
  }),
  [2, 12 * 0.62 + 4 * 0.5 + 0.6, 0.9],
];
const PEALS: Partial<Record<SoundKind, Peal>> = {
  bell: HOURS,
  service: SERVICE,
  alarm: ALARM,
  allclear: ALL_CLEAR,
};

/** A running budget: how many of a sound are let through per `BUDGET_WINDOW`, the loudest first. */
class Budget {
  /** Times the sounds let through were offered. */
  private readonly heard: number[] = [];
  /** Times and loudness of every sound offered. */
  private readonly offeredAt: number[] = [];
  private readonly offeredLoud: number[] = [];
  private readonly most: number;

  /** Lets through `perSecond` a second, counted over the window. */
  constructor(perSecond: number) {
    this.most = Math.max(1, Math.round(perSecond * BUDGET_WINDOW));
  }

  /** Whether a sound this loud, offered at `t`, is among the few to be heard. */
  allows(t: number, loud: number): boolean {
    this.forget(t);
    let louder = 0;
    for (const l of this.offeredLoud) {
      if (l > loud) {
        louder++;
      }
    }
    this.offeredAt.push(t);
    this.offeredLoud.push(loud);
    return this.heard.length < this.most && louder < this.most;
  }

  take(t: number): void {
    this.heard.push(t);
  }

  private forget(t: number): void {
    const old = t - BUDGET_WINDOW;
    while (this.heard.length > 0 && this.heard[0] < old) {
      this.heard.shift();
    }
    while (this.offeredAt.length > 0 && this.offeredAt[0] < old) {
      this.offeredAt.shift();
      this.offeredLoud.shift();
    }
  }
}

/**
 * All sound, synthesized with Web Audio, heard from where the view looks:
 * the work going on about it, the animals, the bells; the wind in the woods,
 * the river, the rain; the birds of the season and the hour; and in a raid,
 * the drums, the howls, the fire and the dragon.
 */
export class AudioEngine extends AudioEngineBase<SoundBank> {
  /** Sounds close by: dry. */
  private near!: GainNode;
  /** Sounds carried from afar: softened, with an echo off the hills. */
  private far!: GainNode;
  /** Wind, rain, the river. */
  private air!: GainNode;
  private wind!: Loop;
  private leaves!: Loop;
  private river!: Loop;
  private rain!: Loop;
  private fire!: { source: AudioBufferSourceNode; gain: GainNode };
  /** Where the ear is (world m) and where it is going; how far zoomed in the view is. */
  private readonly ear = { x: 0, y: 0 };
  private readonly earGoal = { x: 0, y: 0 };
  private zoom = 1;
  private placed = false;
  private time = 0;
  /** The call each bird made last, so it does not repeat straight away. */
  private readonly lastCall = new Map<readonly AudioBuffer[], number>();
  /** The harvest music: which tune, which of its phrases comes next, and when (audio clock). */
  private tune = 0;
  private phrase = 0;
  private nextPhrase = 0;
  /** The claps of the dancers heard lately, fading over `CLAP_MEMORY`, each by how loud it came. */
  private claps = 0;
  /** Budgets of the kinds that can come thick, and of all work together. */
  private readonly budgets = new Map<SoundKind, Budget>();
  private readonly workBudget = new Budget(WORK_PER_SECOND);

  constructor(seed: number) {
    super(seed, 0x5e77a);
  }

  protected buildBank(sampleRate: number): Promise<SoundBank> {
    return buildSoundBank(sampleRate, this.seed);
  }

  protected buildGraph(ctx: AudioContext): void {
    this.near = ctx.createGain();
    this.near.gain.value = 1;
    this.near.connect(this.master);
    this.far = ctx.createGain();
    this.far.gain.value = 1;
    chain(this.far, filter(ctx, "lowpass", 2600, 0.6), this.master);
    // The hills answer: a soft, long echo for what carries.
    const hills = ctx.createConvolver();
    hills.buffer = impulseResponse(ctx, 2.4, 2.5, this.seed ^ 0x411, 0.3);
    chain(this.far, gainNode(ctx, 0.25), hills, this.master);
    chain(this.near, gainNode(ctx, 0.06), hills);
    this.air = ctx.createGain();
    this.air.gain.value = 1;
    this.air.connect(this.master);
  }

  protected startLoops(ctx: AudioContext, bank: SoundBank): void {
    const { pink, brown } = bank.noise;
    this.wind = this.loop(ctx, pink, "bandpass", 380, 0.5, this.air);
    this.leaves = this.loop(ctx, pink, "highpass", 1500, 0.5, this.air);
    this.river = this.loop(ctx, brown, "bandpass", 700, 0.4, this.air);
    this.rain = this.loop(ctx, pink, "bandpass", 1100, 0.5, this.air);
    const source = ctx.createBufferSource();
    source.buffer = bank.fire;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    chain(source, gain, this.near);
    source.start(ctx.currentTime, this.rng.next() * 5);
    this.fire = { source, gain };
  }

  /** Listens at world point (x, y), `zoom` times closer in than the opening view. */
  listen(x: number, y: number, zoom: number): void {
    this.earGoal.x = x;
    this.earGoal.y = y;
    this.zoom = zoom;
    if (!this.placed) {
      this.placed = true;
      this.ear.x = x;
      this.ear.y = y;
    }
  }

  /** Meters within which things are heard at full strength: nearer when zoomed in. */
  private get reach(): number {
    return EAR_REACH / Math.sqrt(clamp(this.zoom, 0.3, 4));
  }

  /** How loud a sound at distance d is, carried `carry` times the ear's reach. */
  private fall(d: number, carry = 1): number {
    const r = this.reach * carry;
    return 1 / (1 + (d / r) ** 2);
  }

  update(world: World, elapsed: number): void {
    const glide = 1 - Math.exp(-elapsed / EAR_GLIDE);
    this.ear.x += (this.earGoal.x - this.ear.x) * glide;
    this.ear.y += (this.earGoal.y - this.ear.y) * glide;
    const run = this.running();
    if (!run) {
      return;
    }
    const { bank, now } = run;
    const dt = Math.min(elapsed, MAX_CADENCE);
    this.time += dt;
    this.ambient(world, now);
    this.claps *= Math.exp(-dt / CLAP_MEMORY);
    this.events(world, bank, now, dt);
    this.wildlife(world, bank.calls, now, dt);
    this.weather(world, bank, now, dt);
    this.music(world, bank, now);
  }

  /**
   * The pipe and drum by the harvest fire, phrase after phrase while the
   * dancing lasts, a tune played through and then another; and the dancers
   * within earshot clapping on the beat.
   */
  private music(world: World, bank: SoundBank, now: number): void {
    if (!festive(world)) {
      this.phrase = 0;
      this.nextPhrase = 0;
      return;
    }
    if (now + this.lookahead < this.nextPhrase) {
      return;
    }
    const r = this.rng;
    const fire = bonfireSpot(world.plan);
    const d = Math.hypot(fire.x - this.ear.x, fire.y - this.ear.y);
    const at = Math.max(now + 0.05, this.nextPhrase);
    const heard = at + d / SPEED_OF_SOUND;
    const gain = MUSIC_PEAK * this.fall(d, MUSIC_CARRY);
    const bus = d > this.reach * 2 ? this.far : this.near;
    const pan = clamp((fire.x - this.ear.x) / (this.reach * 2.5), -0.9, 0.9);
    const phrases = bank.tunes[this.tune % bank.tunes.length];
    if (gain > 0.001) {
      this.shot(phrases[this.phrase], heard, gain, bus, pan);
    }
    // The first strain is clapped on each bar's first beat, the second on both.
    const crowd = (this.claps * CLAP_EVERY) / CLAP_MEMORY;
    const clap = PEAK.clap * Math.sqrt(Math.min(1, crowd / FULL_CLAPPING));
    if (clap > 0.001) {
      const step = this.phrase < 2 ? 2 : 1;
      for (let beat = 0; beat < BEATS; beat += step) {
        this.shot(
          r.pick(bank.shots.clap),
          heard + beat * BEAT + r.range(-0.012, 0.012),
          clap * r.range(0.8, 1),
          bus,
          clamp(pan + r.range(-0.25, 0.25), -0.9, 0.9),
          r.range(0.96, 1.04),
        );
      }
    }
    this.phrase++;
    if (this.phrase >= phrases.length) {
      this.phrase = 0;
      this.tune = (this.tune + r.int(1, bank.tunes.length - 1)) % bank.tunes.length;
    }
    this.nextPhrase = at + PHRASE;
  }

  private ambient(world: World, now: number): void {
    const w = world.env.weather.state;
    const T = 0.8;
    const ear = this.ear;
    const gust = 0.55 + 0.9 * noise1(this.time * 0.17, this.seed ^ 0x3);
    const wind = w.wind * gust;
    // Woods about the ear: leaves rustle in the wind there.
    let woods = 0;
    for (const [dx, dy] of [
      [0, 0],
      [15, 0],
      [-15, 0],
      [0, 15],
      [0, -15],
    ]) {
      woods += world.forest.density(ear.x + dx, ear.y + dy);
    }
    woods /= 5;
    const leafy = world.season.leafDensity;
    this.wind.gain.gain.setTargetAtTime(0.012 + wind * 0.045, now, T);
    this.wind.filter.frequency.setTargetAtTime(280 + wind * 420, now, T);
    this.leaves.gain.gain.setTargetAtTime(
      (0.004 + wind * 0.02) * (0.3 + woods) * (0.3 + 0.7 * leafy),
      now,
      T,
    );
    // The river: nearer, louder.
    const t = world.terrain;
    const off = Math.max(0, Math.abs(t.riverOffset(ear.x, ear.y)) - t.riverHalfWidth(ear.y));
    this.river.gain.gain.setTargetAtTime(0.05 * this.fall(off, 1.6), now, T);
    this.rain.gain.gain.setTargetAtTime(w.rain * 0.05, now, T);
    // Fires about the ear.
    let fire = 0;
    for (const b of world.town.buildings) {
      if (b.fire > 0.02) {
        fire +=
          b.fire *
          this.fall(Math.hypot(b.rect.x - ear.x, b.rect.y - ear.y), 1.8) *
          (b.phase === "ruin" ? 0.3 : 1);
      }
    }
    for (const q of world.piles) {
      if (q.kind === "brush") {
        fire += 0.3 * clamp01(q.burn / 30) * this.fall(Math.hypot(q.x - ear.x, q.y - ear.y), 1.2);
      }
    }
    const camp = world.town.buildings.find((b) => b.kind === "camp");
    if (camp) {
      fire += 0.25 * this.fall(Math.hypot(camp.rect.x - ear.x, camp.rect.y - ear.y), 1);
    }
    if (festive(world)) {
      const b = bonfireSpot(world.plan);
      fire += 0.5 * this.fall(Math.hypot(b.x - ear.x, b.y - ear.y), 1.2);
    }
    this.fire.gain.gain.setTargetAtTime(Math.min(0.09, fire * 0.06), now, 0.4);
  }

  /** Plays a one-shot of the bank so that its peak comes out at `peak`. */
  private shot(
    buffer: AudioBuffer,
    when: number,
    peak: number,
    bus: GainNode,
    pan: number,
    rate = 1,
  ): void {
    this.play(buffer, when, peak / BANK_PEAK, bus, pan, rate);
  }

  /**
   * What happened in the last update, spread over the time it covered. Kinds
   * that come thick are held to their budgets, the loudest first; the bells
   * ring out their peals; the dancers' claps are counted, to be heard in time
   * with the music.
   */
  private events(world: World, bank: SoundBank, start: number, dt: number): void {
    const r = this.rng;
    const ear = this.ear;
    const heard: { kind: SoundKind; d: number; x: number; gain: number }[] = [];
    for (const e of world.events) {
      const d = Math.hypot(e.x - ear.x, e.y - ear.y);
      if (e.kind === "clap") {
        this.claps += this.fall(d);
        continue;
      }
      const gain = PEAK[e.kind] * this.fall(d, CARRY[e.kind] ?? 1);
      if (gain < 0.0015 || (WORK.has(e.kind) && gain < PEAK[e.kind] * WORK_FLOOR)) {
        continue;
      }
      heard.push({ kind: e.kind, d, x: e.x, gain });
    }
    heard.sort((a, b) => b.gain - a.gain);
    for (const e of heard) {
      const pan = clamp((e.x - ear.x) / (this.reach * 2.5), -0.9, 0.9);
      const when = start + r.next() * dt + e.d / SPEED_OF_SOUND;
      const bus = e.d > this.reach * 2 ? this.far : this.near;
      const peal = PEALS[e.kind];
      if (peal) {
        this.peal(bank.shots[e.kind], peal, when, e.gain, bus, pan);
        continue;
      }
      if (!this.allowed(e.kind, start, e.gain)) {
        continue;
      }
      this.shot(r.pick(bank.shots[e.kind]), when, e.gain, bus, pan, r.range(0.94, 1.06));
    }
  }

  /** Whether a one-shot of `kind` this loud is heard now, within its budget and the budget of work. */
  private allowed(kind: SoundKind, now: number, gain: number): boolean {
    const most = PER_SECOND[kind];
    if (most === undefined) {
      return true;
    }
    let budget = this.budgets.get(kind);
    if (!budget) {
      budget = new Budget(most);
      this.budgets.set(kind, budget);
    }
    const work = WORK.has(kind);
    const loud = gain / PEAK[kind];
    // Both budgets hear every offer, so each knows what it passed over.
    const own = budget.allows(now, loud);
    const all = !work || this.workBudget.allows(now, loud);
    if (!own || !all) {
      return false;
    }
    budget.take(now);
    if (work) {
      this.workBudget.take(now);
    }
    return true;
  }

  /** A bell's ringing: its strokes, each from `strokes`, at `gain` for the loudest. */
  private peal(
    strokes: readonly AudioBuffer[],
    peal: Peal,
    when: number,
    gain: number,
    bus: GainNode,
    pan: number,
  ): void {
    const r = this.rng;
    for (const [which, t, level] of peal) {
      const buffer = which < 0 ? r.pick(strokes) : strokes[which % strokes.length];
      this.shot(buffer, when + t, gain * level, bus, pan, r.range(0.997, 1.003));
    }
  }

  /**
   * Birds and night creatures of the valley, each calling at its season and
   * hour, in the places it lives: sparrows about the houses, the lark over
   * the fields, the blackbird at dusk in the gardens, the cuckoo in the
   * spring woods, the owl by night, frogs by the river, crickets in the grass,
   * and the rooster at first light.
   */
  private wildlife(world: World, calls: Calls, now: number, dt: number): void {
    const r = this.rng;
    const env = world.env;
    const w = env.weather.state;
    const h = env.clock.hour;
    const f = world.season.yearFraction;
    const ear = this.ear;
    const day = daytime(h);
    const night = nighttime(h);
    const dry = 1 - smoothstep(0.05, 0.35, w.rain);
    const calm =
      (1 - w.storm) * (1 - smoothstep(0.45, 0.85, w.wind)) * (1 - smoothstep(0.02, 0.2, w.snow));
    const birds = dry * calm * (1 - 0.4 * w.cloudCover);
    let houses = 0;
    for (const b of world.town.buildings) {
      if (
        b.phase === "standing" &&
        KINDS[b.kind].housing > 0 &&
        Math.hypot(b.rect.x - ear.x, b.rect.y - ear.y) < 45
      ) {
        houses++;
      }
    }
    const town = clamp01(houses / 8);
    let fields = 0;
    for (const fl of world.plan.fields) {
      if (world.town.fields[fl.id].cleared && inRect(fl.rect, ear.x, ear.y, 40)) {
        fields++;
      }
    }
    const open = clamp01(fields / 3);
    const woods = world.forest.density(ear.x, ear.y) * 0.5 + 0.35;
    const t = world.terrain;
    const river = this.fall(
      Math.max(0, Math.abs(t.riverOffset(ear.x, ear.y)) - t.riverHalfWidth(ear.y)),
      2,
    );
    const spring = cyclicBump(f, 0.15, 0.25, 0.06, 1);
    const summer = cyclicBump(f, 0.35, 0.3, 0.08, 1);
    const autumn = cyclicBump(f, 0.6, 0.2, 0.06, 1);
    const dawn = bump(h, 5.8, 1.6, 0.8);
    const dusk = bump(h, 18.2, 1.8, 0.8);
    const call = (set: readonly AudioBuffer[], rate: number, gain: number, pitch = 0.04) => {
      if (rate > 0 && r.chance(rate * dt)) {
        this.shot(
          this.fresh(set),
          now + r.next() * dt,
          gain * r.range(0.5, 1),
          this.far,
          r.range(-0.9, 0.9),
          r.range(1 - pitch, 1 + pitch),
        );
      }
    };
    call(
      calls.sparrow,
      0.3 * birds * day * (0.2 + town) * (0.4 + 0.6 * (spring + summer)),
      0.03,
      0.08,
    );
    call(calls.tit, 0.07 * birds * bump(h, 8, 5, 2) * (spring + summer * 0.5) * woods, 0.028);
    call(calls.crow, 0.05 * birds * (dawn + dusk + 0.3 * day) * (0.3 + open), 0.03);
    call(
      calls.blackbird,
      0.12 * birds * (dawn + dusk) * (spring + summer) * (0.3 + town * 0.5 + woods * 0.5),
      0.035,
    );
    call(calls.lark, 0.1 * birds * day * (spring + summer) * (0.1 + open), 0.02);
    call(calls.cuckoo, 0.06 * birds * day * cyclicBump(f, 0.18, 0.18, 0.05, 1) * woods, 0.03);
    call(calls.owl, 0.035 * night * calm * woods * (1 - w.rain), 0.035);
    call(
      calls.frog,
      2.5 * night * (spring + summer) * river * (1 - smoothstep(0.6, 1, w.rain)),
      0.018,
      0.15,
    );
    call(calls.cricket, 2 * night * (summer * 0.5 + autumn) * dry * calm * (1 - town * 0.5), 0.016);
    const hens = world.animals.some((a) => a.kind === "chicken");
    call(calls.rooster, hens ? 0.15 * bump(h, 5.3, 1.2, 0.5) * calm : 0, 0.035);
  }

  /** A call from `set`, never the same one twice in a row. */
  private fresh(set: readonly AudioBuffer[]): AudioBuffer {
    const last = this.lastCall.get(set);
    let i = this.rng.int(0, set.length - (last === undefined ? 1 : 2));
    if (last !== undefined && i >= last) {
      i++;
    }
    this.lastCall.set(set, i);
    return set[i];
  }

  private weather(world: World, bank: SoundBank, now: number, dt: number): void {
    const r = this.rng;
    const w = world.env.weather.state;
    // Drops tapping on roofs and on the ground.
    for (let n = w.rain * 10 * dt; n > 0; n--) {
      if (n < 1 && !r.chance(n)) {
        break;
      }
      this.shot(
        r.pick(bank.dropTicks),
        now + r.next() * dt,
        0.012 * r.range(0.4, 1) * w.rain,
        this.air,
        r.range(-0.8, 0.8),
        r.range(0.8, 1.2),
      );
    }
    for (const strike of world.env.strikes) {
      const near = strike.distance < 3000;
      const gain = 0.28 * Math.min(1, Math.pow(1500 / strike.distance, 0.7));
      this.shot(
        near ? bank.thunder[0] : bank.thunder[1],
        now + strike.distance / SPEED_OF_SOUND,
        gain,
        this.far,
        strike.direction * 0.6,
      );
    }
  }
}
