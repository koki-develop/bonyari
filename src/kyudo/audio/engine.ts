import { WildlifeChorus } from "../../shared/audio/chorus.ts";
import { AudioEngineBase, type Loop, MAX_CADENCE } from "../../shared/audio/engine-base.ts";
import { chain, filter, gainNode, impulseResponse } from "../../shared/audio/synth.ts";
import { clamp01 } from "../../shared/core/math.ts";
import { noise1 } from "../../shared/core/random.ts";
import type { StrikeSound } from "../sim/arrows.ts";
import { EAVE_Z, EYE } from "../sim/dojo.ts";
import type { Material } from "../sim/geometry.ts";
import type { World } from "../sim/world.ts";
import { buildSoundBank, type Landing, type SoundBank } from "./bank.ts";

const SPEED_OF_SOUND = 343;
/** Loudness of each strike heard from close by; distance softens it from there. */
const STRIKE_LEVEL: Record<StrikeSound, number> = {
  target: 1.3,
  rim: 0.9,
  azuchi: 0.45,
  sand: 0.7,
  lawn: 0.45,
  gravel: 0.6,
  wood: 0.6,
  board: 0.5,
  cloth: 0.55,
  hedge: 0.5,
  nock: 0.9,
  shaft: 0.7,
};
/** How each ground a knocked-off arrow can lie on sounds as it lands. */
const LANDING: Record<Material, Landing> = {
  lawn: "lawn",
  soil: "lawn",
  hedge: "lawn",
  sand: "sand",
  azuchi: "sand",
  gravel: "gravel",
  floor: "gravel",
  wood: "gravel",
  roof: "gravel",
  ceiling: "gravel",
  target: "sand",
  cloth: "sand",
};
/** Slips a second while the bow is bent fast and far. */
const SLIPS_PER_SECOND = 90;
/** In-world hours at which the temple bell rings, and how many strokes, how far apart (s). */
const BELL_HOURS = [6, 18] as const;
const BELL_STROKES = 3;
const BELL_GAP = 6.5;
/** What lives around the dojo: a garden of trees on the edge of a quiet town. */
const HABITAT = { rural: 0.75, houses: 0.35, fields: 0.15 } as const;

/** How loud something `distance` m away is, relative to close by. */
function falloff(distance: number): number {
  return Math.min(1, Math.pow(4 / Math.max(0.5, distance), 0.7));
}

/**
 * All sound, synthesized with Web Audio: the archer's own bow in the wooden
 * hall, the arrow's flight and where it lands, heard a moment later from 28 m
 * off; the wind in the trees, the rain on the roof, the life around the dojo
 * and a temple bell at dusk and dawn.
 */
export class AudioEngine extends AudioEngineBase<SoundBank> {
  private readonly chorus: WildlifeChorus;
  /** The archer's own sounds, in the hall. */
  private hallBus!: GainNode;
  /** Sounds out on the range, softened a little by the distance. */
  private rangeBus!: GainNode;
  private ambience!: GainNode;
  private wind!: Loop;
  private leaves!: Loop;
  private roofRain!: Loop;
  private fieldRain!: Loop;
  private rumble!: Loop;
  private lastDraw = 0;
  /** Slips owed by the bending bow, sounded as they come due. */
  private slipDue = 0;
  private lastHour = Number.NaN;
  private time = 0;

  constructor(seed: number) {
    super(seed, 0xb0a1);
    this.chorus = new WildlifeChorus(seed);
  }

  protected buildBank(sampleRate: number): Promise<SoundBank> {
    return buildSoundBank(sampleRate, this.seed);
  }

  protected buildGraph(ctx: AudioContext): void {
    // The hall: a bright wooden room, most of it open to the range.
    this.hallBus = ctx.createGain();
    this.hallBus.connect(this.master);
    const hallVerb = ctx.createConvolver();
    hallVerb.buffer = impulseResponse(ctx, 1.3, 2.6, this.seed ^ 0x4a11, 0.55);
    chain(this.hallBus, gainNode(ctx, 0.32), hallVerb, this.master);

    // The range: the air takes the edge off, the fences and the hall answer.
    this.rangeBus = ctx.createGain();
    const air = filter(ctx, "lowpass", 7000, 0.5);
    chain(this.rangeBus, air, this.master);
    const yardVerb = ctx.createConvolver();
    yardVerb.buffer = impulseResponse(ctx, 0.9, 3.4, this.seed ^ 0x7a2d, 0.4);
    chain(air, gainNode(ctx, 0.28), yardVerb, this.master);

    this.ambience = ctx.createGain();
    this.ambience.connect(this.master);
  }

  protected startLoops(ctx: AudioContext, bank: SoundBank): void {
    const { white, pink, brown } = bank.noise;
    this.wind = this.loop(ctx, pink, "bandpass", 480, 0.5, this.ambience);
    this.leaves = this.loop(ctx, pink, "highpass", 2600, 0.5, this.ambience);
    this.roofRain = this.loop(ctx, pink, "bandpass", 1500, 0.5, this.ambience);
    this.fieldRain = this.loop(ctx, white, "highpass", 3400, 0.5, this.ambience);
    this.rumble = this.loop(ctx, brown, "lowpass", 260, 0.6, this.ambience);
  }

  /** Follows the world after it advanced by `elapsed` real seconds. */
  update(world: World, elapsed: number): void {
    const run = this.running();
    if (!run) {
      this.resync(world);
      return;
    }
    const { bank, now } = run;
    // Chance events are drawn for one cadence at most: a stall's worth would all sound at once.
    const dt = Math.min(elapsed, MAX_CADENCE);
    this.time += dt;
    this.ambient(world, now);
    this.drawing(world, bank, now, elapsed);
    this.events(world, bank, now);
    this.weatherEvents(world, bank, now, dt);
    this.chorus.update(world.env, bank.wildlife, HABITAT, dt, 1, (call, gain, pan, rate) =>
      this.play(call, now, gain, this.ambience, pan, rate),
    );
    this.templeBell(world, bank, now);
  }

  /** Keeps the cursors at the present while sound is off, so nothing is owed on resume. */
  private resync(world: World): void {
    this.lastDraw = world.archer.draw;
    this.lastHour = world.env.clock.hour;
  }

  /** Wind in the trees, and rain on the roof and the ground. */
  private ambient(world: World, now: number): void {
    const env = world.env;
    const w = env.weather.state;
    const season = env.season;
    const T = 0.6;
    // Gusts come and go.
    const gust = 0.55 + 0.9 * noise1(this.time * 0.18, this.seed ^ 0x9);
    const wind = w.wind * gust;
    this.wind.gain.gain.setTargetAtTime(0.012 + wind * 0.07, now, T);
    this.wind.filter.frequency.setTargetAtTime(350 + wind * 500, now, T);
    this.leaves.gain.gain.setTargetAtTime(
      wind * 0.035 * (0.25 + season.leafDensity * 0.75),
      now,
      T,
    );
    this.roofRain.gain.gain.setTargetAtTime(w.rain * 0.08, now, T);
    this.fieldRain.gain.gain.setTargetAtTime(w.rain * 0.035, now, T);
    this.rumble.gain.gain.setTargetAtTime(w.rain * 0.05, now, T);
  }

  /**
   * The bow creaks while it is being bent: slips of the grip and the bamboo,
   * thicker and louder the faster and the further it is drawn.
   */
  private drawing(world: World, bank: SoundBank, now: number, elapsed: number): void {
    const archer = world.archer;
    const speed = elapsed > 0 ? Math.abs(archer.draw - this.lastDraw) / elapsed : 0;
    this.lastDraw = archer.draw;
    const bending = archer.phase === "draw" ? clamp01(speed * 1.4) * (0.4 + 0.6 * archer.draw) : 0;
    if (bending === 0) {
      this.slipDue = 0;
      return;
    }
    const r = this.rng;
    this.slipDue += bending * SLIPS_PER_SECOND * Math.min(elapsed, MAX_CADENCE);
    while (this.slipDue >= 1) {
      this.slipDue -= r.range(0.5, 1.5);
      this.play(
        r.pick(bank.slip),
        now + r.range(0, elapsed),
        bending * r.range(0.02, 0.07),
        this.hallBus,
        0.15,
        r.range(0.9, 1.1) * (0.95 + archer.draw * 0.25),
      );
    }
  }

  private events(world: World, bank: SoundBank, now: number): void {
    const r = this.rng;
    for (const e of world.events) {
      switch (e.kind) {
        case "archer":
          switch (e.event) {
            case "raise":
              this.play(r.pick(bank.rustle), now, 0.14, this.hallBus, 0.1);
              break;
            case "full":
              this.play(r.pick(bank.creak), now, 0.05, this.hallBus, 0.15);
              break;
            case "letdown":
              this.play(r.pick(bank.creak), now, 0.06, this.hallBus, 0.15, 0.9);
              break;
            case "nock":
              this.play(bank.nock, now + 0.1, 0.12, this.hallBus, 0.3);
              break;
          }
          break;
        case "loose": {
          const f = e.flight;
          this.play(r.pick(bank.tsurune), now, 0.7, this.hallBus, 0.05, r.range(0.98, 1.02));
          this.play(r.pick(bank.whoosh), now + 0.01, 0.16, this.hallBus, 0.2);
          const impact = f.impact;
          const settled = f.settled;
          if (!impact || !settled) {
            break;
          }
          // Heard a moment after it strikes, when the sound has crossed the range.
          const p = impact.point;
          const distance = Math.hypot(p.x, p.y - EYE, p.z);
          const at = now + Math.max(0, impact.time - f.age) + distance / SPEED_OF_SOUND;
          const pan = Math.max(-0.8, Math.min(0.8, (p.x / distance) * 4));
          this.play(
            r.pick(bank.strikes[settled.sound]),
            at,
            STRIKE_LEVEL[settled.sound] * falloff(distance),
            this.rangeBus,
            pan,
            r.range(0.96, 1.04),
          );
          if (settled.drop > 0) {
            this.play(
              r.pick(bank.landing[LANDING[settled.arrow.material]]),
              at + settled.drop,
              0.3 * falloff(distance),
              this.rangeBus,
              pan,
            );
          }
          break;
        }
        case "cleared":
          this.play(bank.clear, now, 0.3, this.hallBus, 0.2);
          break;
      }
    }
  }

  /** Plays a sound from a point in the range, delayed and softened by its distance. */
  private atRange(
    buffer: AudioBuffer,
    now: number,
    gain: number,
    x: number,
    y: number,
    z: number,
    rate = 1,
  ): void {
    const distance = Math.max(0.5, Math.hypot(x, y - EYE, z));
    const pan = Math.max(-0.9, Math.min(0.9, (x / distance) * 1.6));
    this.play(
      buffer,
      now + distance / SPEED_OF_SOUND,
      gain * falloff(distance),
      this.rangeBus,
      pan,
      rate,
    );
  }

  private weatherEvents(world: World, bank: SoundBank, now: number, dt: number): void {
    const r = this.rng;
    // Drops from the eaves onto the gravel right in front.
    const rain = world.env.weather.state.rain;
    const drips = rain * 9 * dt;
    for (let n = drips; n > 0; n--) {
      if (n < 1 && !r.chance(n)) {
        break;
      }
      this.atRange(
        r.pick(bank.dropTicks),
        now + r.next() * dt,
        r.range(0.05, 0.14),
        r.range(-2, 2),
        0,
        EAVE_Z,
      );
    }
  }

  /** A temple bell some way off at dawn and dusk. */
  private templeBell(world: World, bank: SoundBank, now: number): void {
    const hour = world.env.clock.hour;
    const last = this.lastHour;
    this.lastHour = hour;
    if (Number.isNaN(last)) {
      return;
    }
    for (const h of BELL_HOURS) {
      // Crossed the hour since the last update (and not a jump of the clock).
      if (last < h && hour >= h && hour - last < 0.5) {
        for (let k = 0; k < BELL_STROKES; k++) {
          this.play(
            bank.bell,
            now + k * BELL_GAP,
            0.14,
            this.ambience,
            -0.55,
            this.rng.range(0.99, 1.01),
          );
        }
      }
    }
  }
}
