import { WildlifeChorus } from "../../shared/audio/chorus.ts";
import { AudioEngineBase, type Loop, MAX_CADENCE } from "../../shared/audio/engine-base.ts";
import { chain, filter, gainNode, impulseResponse } from "../../shared/audio/synth.ts";
import { clamp, clamp01 } from "../../shared/core/math.ts";
import { noise1 } from "../../shared/core/random.ts";
import { SURFACE } from "../sim/geometry.ts";
import type { World } from "../sim/world.ts";
import { buildSoundBank, type SoundBank } from "./bank.ts";

const SPEED_OF_SOUND = 343;
/** Where the listening ear is pressed into the soil (mm): in the upper nest. */
const EAR = { x: 0, y: -70 };
/** What lives around the ground: a lawn by a wood, a few houses. */
const HABITAT = { rural: 0.8, houses: 0.25, fields: 0.3 } as const;
/**
 * How loud (peak, before the master) each one-shot is when it happens right
 * by the ear: a little above the hush of the ground, never a jolt. Thunder
 * alone is allowed to be loud.
 */
const PEAK = {
  bite: 0.045,
  drop: 0.05,
  pack: 0.035,
  crumb: 0.08,
  insect: 0.05,
  touchdown: 0.04,
  shed: 0.05,
  eclose: 0.02,
  takeoff: 0.06,
  thud: 0.05,
  thunder: 0.3,
} as const;
/** The peak every one-shot of the bank is brought to (see `normalize`). */
const BANK_PEAK = 0.9;
/** Loudness of the rustle of one ant walking right by the ear. */
const RUSTLE = 0.01;

/**
 * All sound, synthesized with Web Audio, as heard with an ear pressed into
 * the soil: close and clear, the grains the ants bite loose and drop, their
 * footsteps a faint crackle that thickens as the colony gets busy; the world
 * above muffled through the ground, rain landing on it as soft thuds.
 */
export class AudioEngine extends AudioEngineBase<SoundBank> {
  private readonly chorus: WildlifeChorus;
  /** The ants' own sounds, close, in a small, damp space. */
  private near!: GainNode;
  /** The world above, heard through the soil. */
  private above!: GainNode;
  /** Blows on the ground over the ear: rain, what falls. */
  private ground!: GainNode;
  private hum!: Loop;
  private wind!: Loop;
  private leaves!: Loop;
  private rain!: Loop;
  private soak!: Loop;
  /** The rustle of the ants' feet, and where it leans. */
  private feet!: Loop;
  private feetPan!: StereoPannerNode;
  private time = 0;

  constructor(seed: number) {
    super(seed, 0xa27);
    this.chorus = new WildlifeChorus(seed);
  }

  protected buildBank(sampleRate: number): Promise<SoundBank> {
    return buildSoundBank(sampleRate, this.seed);
  }

  protected buildGraph(ctx: AudioContext): void {
    // Close sounds: bright, with the short, soft answer of the tunnels.
    this.near = ctx.createGain();
    this.near.gain.value = 2.2;
    this.near.connect(this.master);
    const room = ctx.createConvolver();
    room.buffer = impulseResponse(ctx, 0.3, 3.5, this.seed ^ 0x51d, 0.25);
    chain(this.near, gainNode(ctx, 0.1), room, this.master);
    // Above: the soil takes the highs away.
    this.above = ctx.createGain();
    this.above.gain.value = 2;
    chain(this.above, filter(ctx, "lowpass", 1700, 0.6), this.master);
    this.ground = ctx.createGain();
    this.ground.gain.value = 1.6;
    chain(this.ground, filter(ctx, "lowpass", 900, 0.5), this.master);
  }

  protected startLoops(ctx: AudioContext, bank: SoundBank): void {
    const { pink, brown } = bank.noise;
    // The stillness of the ground: a faint, low hush that is always there.
    this.hum = this.loop(ctx, brown, "lowpass", 140, 0.6, this.near);
    this.wind = this.loop(ctx, pink, "bandpass", 420, 0.5, this.above);
    this.leaves = this.loop(ctx, pink, "highpass", 1400, 0.5, this.above);
    this.rain = this.loop(ctx, pink, "bandpass", 800, 0.6, this.above);
    this.soak = this.loop(ctx, brown, "lowpass", 260, 0.6, this.ground);
    this.feetPan = ctx.createStereoPanner();
    this.feetPan.connect(this.near);
    this.feet = this.loop(ctx, pink, "bandpass", 1500, 0.7, this.feetPan);
  }

  /** Follows the world after it advanced by `elapsed` real seconds. */
  update(world: World, elapsed: number): void {
    const run = this.running();
    if (!run) {
      return;
    }
    const { bank, now } = run;
    // Chance events are drawn for one cadence at most: a stall's worth would all sound at once.
    const dt = Math.min(elapsed, MAX_CADENCE);
    this.time += dt;
    this.ambient(world, now);
    this.events(world, bank, now, dt);
    this.footsteps(world, now);
    this.weather(world, bank, now, dt);
    // Birds and insects, heard through the ground.
    this.chorus.update(world.env, bank.wildlife, HABITAT, dt, 0.7, (call, gain, pan, rate) =>
      this.play(call, now, gain * 0.8, this.above, pan, rate),
    );
  }

  private ambient(world: World, now: number): void {
    const w = world.env.weather.state;
    const T = 0.8;
    const gust = 0.55 + 0.9 * noise1(this.time * 0.17, this.seed ^ 0x3);
    const wind = w.wind * gust;
    this.hum.gain.gain.setTargetAtTime(0.011, now, T);
    this.wind.gain.gain.setTargetAtTime(0.014 + wind * 0.05, now, T);
    this.wind.filter.frequency.setTargetAtTime(300 + wind * 400, now, T);
    this.leaves.gain.gain.setTargetAtTime(wind * 0.012 * (1 - world.season.withered * 0.6), now, T);
    this.rain.gain.gain.setTargetAtTime(w.rain * 0.05, now, T);
    this.soak.gain.gain.setTargetAtTime(w.rain * 0.05 + w.storm * 0.03, now, T);
  }

  /** Pan and loudness of a sound at (x, y) mm, as the ear hears it. */
  private at(x: number, y: number): { pan: number; gain: number } {
    const d = Math.hypot(x - EAR.x, y - EAR.y);
    return { pan: clamp((x - EAR.x) / 110, -0.9, 0.9), gain: 1 / (1 + d / 55) };
  }

  /**
   * What happened in the last update, spread over the time it covered: a
   * hidden page updates only once a second, and a second's bites should not
   * all sound at once.
   */
  private events(world: World, bank: SoundBank, start: number, dt: number): void {
    const r = this.rng;
    for (const e of world.events) {
      const { pan, gain } = this.at(e.x, e.y);
      const now = start + r.next() * dt;
      switch (e.kind) {
        case "bite":
          this.shot(
            r.pick(bank.bite),
            now,
            PEAK.bite * gain * (0.8 + 0.2 * e.hardness),
            this.near,
            pan,
            r.range(0.9, 1.12),
          );
          break;
        case "dump":
          this.shot(r.pick(bank.drop), now, PEAK.drop * gain, this.ground, pan, r.range(0.9, 1.1));
          break;
        case "pack":
          this.shot(r.pick(bank.pack), now, PEAK.pack * gain, this.near, pan, r.range(0.9, 1.1));
          break;
        case "land":
          this.shot(
            r.pick(e.item === "crumb" ? bank.crumb : bank.insect),
            now,
            (e.item === "crumb" ? PEAK.crumb : PEAK.insect) * gain * clamp01(e.size / 4),
            this.ground,
            pan,
            r.range(0.92, 1.08),
          );
          break;
        case "touchdown":
          this.shot(r.pick(bank.insect), now, PEAK.touchdown * gain, this.ground, pan);
          break;
        case "shed":
          this.shot(r.pick(bank.rustle), now, PEAK.shed * gain, this.near, pan);
          break;
        case "eclose":
          this.shot(
            r.pick(bank.rustle),
            now,
            PEAK.eclose * gain,
            this.near,
            pan,
            r.range(1.1, 1.3),
          );
          break;
        case "takeoff":
          this.shot(bank.whirr, now, PEAK.takeoff * gain, this.above, pan, r.range(0.92, 1.08));
          break;
        case "lay":
          break;
      }
    }
  }

  /**
   * The feet of the ants walking in the soil: a faint, dry rustle, fuller
   * the more are about and the nearer they are to the ear, leaning to the
   * side where they are.
   */
  private footsteps(world: World, now: number): void {
    let busy = 0;
    let sumX = 0;
    for (const a of world.ants) {
      if (!a.way || a.wait > 0 || (a.loc.f < 0 && a.loc.f !== SURFACE)) {
        continue;
      }
      const { gain } = this.at(a.x, a.y);
      busy += gain;
      sumX += gain * a.x;
    }
    const level = RUSTLE * Math.sqrt(busy);
    this.feet.gain.gain.setTargetAtTime(Math.min(RUSTLE * 4, level), now, 0.6);
    const pan = busy > 0 ? clamp((sumX / busy - EAR.x) / 110, -0.8, 0.8) : 0;
    this.feetPan.pan.setTargetAtTime(pan, now, 0.8);
  }

  /** Plays a one-shot of the bank through `bus` so that its peak comes out at `peak`. */
  private shot(
    buffer: AudioBuffer,
    when: number,
    peak: number,
    bus: GainNode,
    pan = 0,
    rate = 1,
  ): void {
    this.play(buffer, when, peak / (BANK_PEAK * bus.gain.value), bus, pan, rate);
  }

  private weather(world: World, bank: SoundBank, now: number, dt: number): void {
    const r = this.rng;
    const w = world.env.weather.state;
    // Drops landing on the ground above the ear.
    for (let n = w.rain * 14 * dt; n > 0; n--) {
      if (n < 1 && !r.chance(n)) {
        break;
      }
      this.shot(
        r.pick(bank.thud),
        now + r.next() * dt,
        PEAK.thud * r.range(0.4, 1) * w.rain,
        this.ground,
        r.range(-0.8, 0.8),
        r.range(0.85, 1.15),
      );
    }
    for (const strike of world.env.strikes) {
      const near = strike.distance < 3000;
      const gain = PEAK.thunder * Math.min(1, Math.pow(1500 / strike.distance, 0.7));
      this.shot(
        near ? bank.thunder[0] : bank.thunder[1],
        now + strike.distance / SPEED_OF_SOUND,
        gain,
        this.ground,
        strike.direction * 0.6,
      );
    }
  }
}
