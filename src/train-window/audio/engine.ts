import { bump, clamp01, smoothstep } from "../../shared/core/math.ts";
import { hash2, noise1 } from "../../shared/core/random.ts";
import { crossingActive } from "../sim/crossing.ts";
import { type Crossing, makeTerrainScratch, RAIL_LENGTH } from "../sim/route.ts";
import { ONCOMING_CAR_LENGTH, type OncomingTrain } from "../sim/traffic.ts";
import { AXLES } from "../sim/train.ts";
import type { World } from "../sim/world.ts";
import { daytime, WildlifeChorus } from "../../shared/audio/chorus.ts";
import { AudioEngineBase, type Loop, MAX_CADENCE } from "../../shared/audio/engine-base.ts";
import { buildSoundBank, type SoundBank } from "./bank.ts";
import { chain, filter, gainNode, impulseResponse } from "../../shared/audio/synth.ts";

const SPEED_OF_SOUND = 343;
/** Lateral distance (m) of the crossing bells from our seat. */
const BELL_LATERAL = 4;
/** Strikes per second of a crossing bell. */
const BELL_RATE = 2.2;
/** Share of the physical Doppler shift applied to the crossing bells. */
const DOPPLER = 0.35;
/** Fundamental (Hz) of the brake squeal. */
const SQUEAL_PITCH = 2700;
/** Speed (m/s) below which the brakes start to squeal. */
const SQUEAL_SPEED = 6;

interface BellState {
  next: number;
  parity: number;
}

/**
 * All sound, synthesized with Web Audio: the rolling train and its rail
 * joints, stations, crossings, weather, and the life outside that is heard
 * best when the train stands still.
 */
export class AudioEngine extends AudioEngineBase<SoundBank> {
  private readonly chorus: WildlifeChorus;
  private trainBus!: GainNode;
  private cabinBus!: GainNode;
  private outsideBus!: GainNode;
  private outsideFilter!: BiquadFilterNode;
  private tunnelSend!: GainNode;
  private stationSend!: GainNode;
  private rolling!: Loop;
  private hiss!: Loop;
  private rumble!: { osc: OscillatorNode; gain: GainNode };
  private motor!: { a: OscillatorNode; b: OscillatorNode; gain: GainNode };
  private squeal!: { osc: OscillatorNode; band: BiquadFilterNode; gain: GainNode };
  private wind!: Loop;
  private rain!: Loop;
  private waves!: Loop;
  private wavesSwell!: GainNode;
  private cicadas!: Loop;
  private murmur!: Loop;
  private passing!: Loop;
  private bridgeRoar!: Loop;
  private readonly lastJoint = AXLES.map(() => Number.NaN);
  private readonly bells = new Map<Crossing, BellState>();
  /** Number of car boundaries of each passing train that have gone by. */
  private readonly oncomingPassed = new Map<OncomingTrain, number>();
  private readonly terrain = makeTerrainScratch();
  private wasInTunnel = false;
  private nextCreak = 20;

  constructor(seed: number) {
    super(seed, 0xa0d10);
    this.chorus = new WildlifeChorus(seed);
  }

  private resync(world: World): void {
    const pos = world.train.pos;
    AXLES.forEach((axle, i) => {
      this.lastJoint[i] = Math.floor((pos + axle.offset) / RAIL_LENGTH);
    });
    this.oncomingPassed.clear();
    this.bells.clear();
    this.wasInTunnel = world.route.tunnelAt(pos) !== null;
  }

  protected buildBank(sampleRate: number): Promise<SoundBank> {
    return buildSoundBank(sampleRate, this.seed);
  }

  protected buildGraph(ctx: AudioContext): void {
    this.trainBus = ctx.createGain();
    this.trainBus.connect(this.master);
    this.cabinBus = ctx.createGain();
    this.cabinBus.connect(this.master);
    this.outsideBus = ctx.createGain();
    this.outsideFilter = filter(ctx, "lowpass", 2200, 0.5);
    chain(this.outsideBus, this.outsideFilter, this.master);

    const tunnelVerb = ctx.createConvolver();
    tunnelVerb.buffer = impulseResponse(ctx, 1.8, 2.2, this.seed ^ 0x7e, 0.35);
    this.tunnelSend = ctx.createGain();
    this.tunnelSend.gain.value = 0;
    chain(this.trainBus, this.tunnelSend, tunnelVerb, this.master);

    const platformVerb = ctx.createConvolver();
    platformVerb.buffer = impulseResponse(ctx, 1.2, 3, this.seed ^ 0x9f, 0.6);
    this.stationSend = ctx.createGain();
    this.stationSend.gain.value = 0.35;
    chain(this.stationSend, platformVerb, this.outsideBus);
  }

  protected startLoops(ctx: AudioContext, bank: SoundBank): void {
    const { white, pink, brown } = bank.noise;
    this.rolling = this.loop(ctx, brown, "lowpass", 300, 0.7, this.trainBus);
    this.hiss = this.loop(ctx, pink, "bandpass", 1100, 0.6, this.trainBus);
    this.bridgeRoar = this.loop(ctx, pink, "bandpass", 700, 2.5, this.trainBus);
    this.wind = this.loop(ctx, pink, "bandpass", 600, 0.5, this.cabinBus);
    this.rain = this.loop(ctx, pink, "highpass", 700, 0.5, this.cabinBus);
    this.waves = this.loop(ctx, brown, "lowpass", 520, 0.5, this.outsideBus);
    this.cicadas = this.loop(ctx, white, "bandpass", 5200, 2.5, this.outsideBus);
    this.murmur = this.loop(ctx, pink, "bandpass", 520, 0.8, this.outsideBus);
    this.passing = this.loop(ctx, brown, "lowpass", 900, 0.6, this.trainBus);

    // The swell of the sea: a slow tremolo on the wave noise.
    this.wavesSwell = ctx.createGain();
    this.waves.gain.disconnect();
    chain(this.waves.gain, this.wavesSwell, this.outsideBus);
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.11;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 0.45;
    this.wavesSwell.gain.value = 0.55;
    chain(swell, swellDepth, this.wavesSwell.gain);
    swell.start();

    // Cicadas throb.
    const throb = ctx.createOscillator();
    throb.frequency.value = 7;
    const throbDepth = ctx.createGain();
    throbDepth.gain.value = 0.3;
    const cicadaAm = ctx.createGain();
    cicadaAm.gain.value = 0.7;
    this.cicadas.gain.disconnect();
    chain(this.cicadas.gain, cicadaAm, this.outsideBus);
    chain(throb, throbDepth, cicadaAm.gain);
    throb.start();

    const rumble = ctx.createOscillator();
    rumble.frequency.value = 44;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    chain(rumble, rumbleGain, this.trainBus);
    rumble.start();
    this.rumble = { osc: rumble, gain: rumbleGain };

    const a = ctx.createOscillator();
    a.type = "sawtooth";
    const b = ctx.createOscillator();
    b.type = "sawtooth";
    const motorGain = ctx.createGain();
    motorGain.gain.value = 0;
    const motorFilter = filter(ctx, "lowpass", 1400, 0.8);
    a.connect(motorFilter);
    b.connect(motorFilter);
    chain(motorFilter, motorGain, this.trainBus);
    a.start();
    b.start();
    this.motor = { a, b, gain: motorGain };

    // Brake squeal: a strident tone rich in harmonics, roughened by the
    // stick-slip of the shoes on the wheels, with scraping noise around it.
    // Its pitch wander and on-off chatter are driven from `update`.
    const sq = ctx.createOscillator();
    sq.setPeriodicWave(
      ctx.createPeriodicWave(
        new Float32Array([0, 0, 0.1, 0, 0.05, 0]),
        new Float32Array([0, 1, 0.6, 0.42, 0.25, 0.14]),
      ),
    );
    sq.frequency.value = SQUEAL_PITCH;
    const rough = ctx.createGain();
    rough.gain.value = 1;
    const chatter = ctx.createBufferSource();
    chatter.buffer = white;
    chatter.loop = true;
    chain(chatter, filter(ctx, "bandpass", 55, 0.7), gainNode(ctx, 16), rough.gain);
    const scrape = ctx.createBufferSource();
    scrape.buffer = white;
    scrape.loop = true;
    const scrapeBand = filter(ctx, "bandpass", SQUEAL_PITCH, 9);
    const sqGain = ctx.createGain();
    sqGain.gain.value = 0;
    chain(sq, rough, sqGain);
    chain(scrape, scrapeBand, gainNode(ctx, 1.6), sqGain);
    chain(sqGain, filter(ctx, "highpass", 900, 0.7), this.trainBus);
    sq.start();
    chatter.start(ctx.currentTime, this.rng.next() * white.duration * 0.9);
    scrape.start(ctx.currentTime, this.rng.next() * white.duration * 0.9);
    this.squeal = { osc: sq, band: scrapeBand, gain: sqGain };

    // Air conditioning hum in the car.
    const hum = ctx.createOscillator();
    hum.frequency.value = 100;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.006;
    chain(hum, humGain, this.cabinBus);
    hum.start();
    const air = this.loop(ctx, pink, "lowpass", 260, 0.7, this.cabinBus);
    air.gain.gain.value = 0.02;
  }

  /** The switch of the car lights. */
  playClick(): void {
    if (this.bank && this.ctx) {
      this.play(this.bank.click, this.ctx.currentTime, 0.35, this.cabinBus, -0.4);
    }
  }

  /** Follows the world after it advanced by `elapsed` real seconds. */
  update(world: World, elapsed: number): void {
    const run = this.running();
    if (!run) {
      // Muted, interrupted or not started: keep the event cursors at the present
      // so nothing that happened meanwhile plays all at once on resume.
      this.resync(world);
      return;
    }
    const { bank, now } = run;
    // Chance events (birds, drops, creaks) are drawn for one cadence at most:
    // a stall's worth would all sound at once.
    const dt = Math.min(elapsed, MAX_CADENCE);
    const train = world.train;
    const route = world.route;
    const v = train.speed;
    const s = clamp01(v / 25);
    const terrain = route.terrain(train.pos, this.terrain);
    const tunnel = route.tunnelAt(train.pos);
    const inTunnel = tunnel
      ? clamp01(Math.min(train.pos - tunnel.start, tunnel.end - train.pos) / 25 + 0.3)
      : 0;
    const bridge = route.bridgeAt(train.pos);
    const onTruss = bridge?.kind === "truss" ? 1 : 0;
    const weather = world.env.weather.state;
    const T = 0.12;

    // Rolling noise, hiss and rumble grow with speed; tunnels roar.
    this.rolling.gain.gain.setTargetAtTime(
      0.32 * Math.pow(s, 1.2) * (1 + inTunnel * 0.9 + onTruss * 0.3),
      now,
      T,
    );
    this.rolling.filter.frequency.setTargetAtTime(110 + 420 * s + inTunnel * 160, now, T);
    this.hiss.gain.gain.setTargetAtTime(0.07 * s * s * (1 + inTunnel * 1.4), now, T);
    this.rumble.gain.gain.setTargetAtTime(0.1 * s * (1 + inTunnel * 0.6), now, T);
    this.rumble.osc.frequency.setTargetAtTime(40 + 10 * s, now, T);
    this.bridgeRoar.gain.gain.setTargetAtTime(0.16 * onTruss * s, now, 0.2);
    this.tunnelSend.gain.setTargetAtTime(0.55 * inTunnel, now, 0.3);
    if (tunnel && !this.wasInTunnel) {
      this.play(bank.pressure, now, 0.55 * s, this.trainBus);
    } else if (!tunnel && this.wasInTunnel) {
      this.play(bank.pressure, now, 0.25 * s, this.trainBus);
    }
    this.wasInTunnel = tunnel !== null;

    // Motor whine while powering or braking.
    const traction = Math.abs(train.traction);
    this.motor.gain.gain.setTargetAtTime(
      0.022 * clamp01(traction) * (v > 0.3 ? 1 : traction > 0.2 ? 1 : 0),
      now,
      0.2,
    );
    const motorFreq = 60 + v * 30;
    this.motor.a.frequency.setTargetAtTime(motorFreq, now, 0.1);
    this.motor.b.frequency.setTargetAtTime(motorFreq * 1.5, now, 0.1);
    this.updateSqueal(train.phase === "braking", v, train.stationsVisited, now);

    // The glass muffles the outside unless the doors are open.
    this.outsideFilter.frequency.setTargetAtTime(train.doorsOpen ? 9000 : 2000, now, 0.35);
    this.outsideBus.gain.setTargetAtTime((train.doorsOpen ? 1.5 : 1) * (1 - inTunnel), now, 0.3);

    this.wind.gain.gain.setTargetAtTime(0.012 + weather.wind * 0.05 + s * 0.02, now, 0.5);
    this.wind.filter.frequency.setTargetAtTime(400 + weather.wind * 500 + s * 300, now, 0.5);
    const shelter = inTunnel;
    this.rain.gain.gain.setTargetAtTime(
      weather.rain * 0.09 * (1 - shelter) + weather.snow * 0.01,
      now,
      0.6,
    );
    this.rain.filter.frequency.setTargetAtTime(weather.snow > weather.rain ? 1400 : 700, now, 0.6);

    const shore = route.shoreAt(terrain, train.pos);
    const sea = Number.isFinite(shore) ? Math.exp(-shore / 140) : 0;
    this.waves.gain.gain.setTargetAtTime(sea * 0.35, now, 1);

    const hour = world.env.clock.hour;
    const season = world.env.season;
    const rural = clamp01(terrain.fields + terrain.forest);
    const day = daytime(hour);
    this.cicadas.gain.gain.setTargetAtTime(
      0.03 *
        season.cicadas *
        day *
        (0.4 + rural * 0.6) *
        (1 - smoothstep(0.05, 0.35, weather.rain)) *
        (1 - weather.storm) *
        (1 - 0.7 * smoothstep(0.5, 1, weather.cloudCover)),
      now,
      1.5,
    );
    const station = train.phase === "stopped" && train.station ? train.station : null;
    const rush = Math.max(bump(hour, 8, 2, 1), bump(hour, 18, 3, 1.5));
    this.murmur.gain.gain.setTargetAtTime(
      station && train.doorsOpen ? 0.03 * (0.3 + station.size) * (0.3 + rush) : 0,
      now,
      0.8,
    );

    this.scheduleJoints(world, now, terrain.jointed, bridge !== null);
    this.scheduleBells(world, now);
    this.updateOncoming(world, now);
    this.stationEvents(world, now);
    this.weatherEvents(world, now, dt, shelter);
    this.chorus.update(
      world.env,
      bank.wildlife,
      { rural, houses: terrain.houses, fields: terrain.fields },
      dt,
      1 - inTunnel,
      (call, gain, pan, rate) => this.play(call, now, gain, this.outsideBus, pan, rate),
    );
    this.fireworks(world, now);

    this.nextCreak -= dt;
    if (this.nextCreak <= 0) {
      this.nextCreak = this.rng.range(15, 55);
      if (v > 5) {
        this.play(this.rng.pick(bank.creaks), now, 0.04, this.cabinBus, this.rng.range(-0.6, 0.6));
      }
    }
  }

  /** Clickety-clack: every axle near us strikes each rail joint as it passes. */
  private scheduleJoints(world: World, now: number, jointed: number, bridge: boolean): void {
    const bank = this.bank!;
    const train = world.train;
    const v = train.speed;
    const reach = v * this.lookahead;
    AXLES.forEach((axle, i) => {
      const p = train.pos + axle.offset;
      const next = Math.floor(p / RAIL_LENGTH) + 1;
      if (Number.isNaN(this.lastJoint[i])) {
        this.lastJoint[i] = next - 1;
      }
      if (v < 0.3) {
        this.lastJoint[i] = Math.max(this.lastJoint[i], next - 1);
        return;
      }
      // Joints already behind the axle were passed during a stall; they no longer sound.
      for (let k = Math.max(this.lastJoint[i] + 1, next); k * RAIL_LENGTH - p <= reach; k++) {
        this.lastJoint[i] = k;
        if (jointed < 0.5) {
          continue;
        }
        const when = now + (k * RAIL_LENGTH - p) / v;
        const gain = axle.gain * 0.3 * Math.min(1, 0.25 + v / 22) * this.rng.range(0.85, 1.1);
        const buffers = bridge ? bank.bridgeJoints : bank.joints;
        const rate = 0.92 + v / 120 + this.rng.range(-0.04, 0.04);
        this.play(
          this.rng.pick(buffers),
          when,
          gain * (bridge ? 1.2 : 1),
          this.trainBus,
          Math.max(-0.5, Math.min(0.5, axle.offset / 28)),
          rate,
        );
      }
    });
  }

  /** Level crossing bells, with Doppler as we rush past. */
  private scheduleBells(world: World, now: number): void {
    const bank = this.bank!;
    const pos = world.train.pos;
    const v = world.train.speed;
    const nearby = world.route.crossingsIn(pos - 800, pos + 800);
    for (const c of nearby) {
      const active = crossingActive(c, pos);
      let st = this.bells.get(c);
      if (!active) {
        this.bells.delete(c);
        continue;
      }
      if (!st) {
        st = { next: now, parity: 0 };
        this.bells.set(c, st);
      }
      // Strikes missed during a stall are dropped rather than rung all at once.
      st.next = Math.max(st.next, now);
      while (st.next < now + this.lookahead) {
        const dx = c.at - pos;
        const dist = Math.hypot(dx, BELL_LATERAL);
        const approach = (v * dx) / dist;
        // The true shift at our speed sounds exaggerated on small speakers; keep a hint of it.
        const rate = (1 + (DOPPLER * approach) / SPEED_OF_SOUND) * (st.parity === 0 ? 1 : 0.94);
        const gain = 0.22 * Math.min(1, 30 / dist);
        this.play(
          bank.crossingBell,
          st.next + dist / SPEED_OF_SOUND,
          gain,
          this.outsideBus,
          Math.max(-0.9, Math.min(0.9, dx / 30)),
          rate,
        );
        st.next += 1 / BELL_RATE;
        st.parity ^= 1;
      }
    }
    for (const c of this.bells.keys()) {
      if (!nearby.includes(c)) {
        this.bells.delete(c);
      }
    }
  }

  /** A train passing on the other track: a roar, a thump of pressure and its wheels. */
  private updateOncoming(world: World, now: number): void {
    const bank = this.bank!;
    const pos = world.train.pos;
    let roar = 0;
    for (const tr of world.traffic.trains) {
      const tail = tr.front - tr.cars * ONCOMING_CAR_LENGTH;
      const d = pos > tr.front ? pos - tr.front : pos < tail ? tail - pos : 0;
      roar = Math.max(roar, Math.exp(-d / 45));
      // Car boundaries (front, joints between cars, tail) that have passed our window.
      const passed = Math.max(
        0,
        Math.min(tr.cars + 1, tr.cars + 1 - Math.ceil((tr.front - pos) / ONCOMING_CAR_LENGTH)),
      );
      const before = this.oncomingPassed.get(tr) ?? passed;
      if (before === 0 && passed > 0) {
        this.play(bank.pressure, now, 0.5, this.trainBus);
      }
      if (before <= tr.cars && passed === tr.cars + 1) {
        this.play(bank.pressure, now, 0.25, this.trainBus);
      }
      // Wheels clatter as the bogies either side of each boundary go by.
      const rel = tr.speed + world.train.speed;
      for (let k = before; k < passed; k++) {
        const offsets =
          k === 0 ? [1.3, 3.4] : k === tr.cars ? [-3.4, -1.3] : [-3.4, -1.3, 1.3, 3.4];
        for (const off of offsets) {
          this.play(
            this.rng.pick(bank.joints),
            now + (off + 3.4) / rel,
            0.18,
            this.trainBus,
            0.1,
            1.1,
          );
        }
      }
      this.oncomingPassed.set(tr, passed);
    }
    for (const tr of this.oncomingPassed.keys()) {
      if (!world.traffic.trains.includes(tr)) {
        this.oncomingPassed.delete(tr);
      }
    }
    this.passing.gain.gain.setTargetAtTime(roar * 0.45, now, 0.08);
    this.passing.filter.frequency.setTargetAtTime(500 + roar * 1400, now, 0.1);
  }

  private stationEvents(world: World, now: number): void {
    const bank = this.bank!;
    for (const e of world.trainEvents) {
      switch (e) {
        case "arrive":
          this.play(bank.stopThunk, now, 0.5, this.trainBus);
          break;
        case "airRelease":
          this.play(bank.airRelease, now, 0.16, this.trainBus, -0.2);
          break;
        case "doorOpen":
          this.play(bank.doorSlide, now, 0.3, this.trainBus, 0.3);
          this.play(bank.chimeOpen, now + 0.1, 0.12, this.cabinBus, 0.2);
          break;
        case "melody":
          this.play(bank.melody, now, 0.16, this.outsideBus, 0.35);
          this.play(bank.melody, now, 0.12, this.stationSend, 0.35);
          break;
        case "doorChime":
          this.play(bank.chimeClose, now, 0.12, this.cabinBus, 0.2);
          break;
        case "doorClose":
          this.play(bank.doorSlide, now, 0.3, this.trainBus, 0.3);
          break;
        case "brake":
        case "depart":
          break;
      }
    }
  }

  /**
   * The brakes squeal over the last few meters before a stop: the tone breaks
   * up and returns as the shoes grab and slip, climbs a little as the wheels
   * slow, and cuts off sharply the moment the train stands.
   */
  private updateSqueal(braking: boolean, v: number, stop: number, now: number): void {
    const { osc, band, gain } = this.squeal;
    if (!braking || v <= 0.15 || v >= SQUEAL_SPEED) {
      gain.gain.setTargetAtTime(0, now, v <= 0.15 ? 0.015 : 0.08);
      return;
    }
    // Each stop squeals a little differently, and some barely at all.
    const seed = this.seed ^ Math.imul(stop + 1, 0x2c1b3c6d);
    const strength = 0.25 + 0.75 * hash2(stop, this.seed);
    const pitch =
      SQUEAL_PITCH *
      (0.88 + 0.24 * hash2(stop, this.seed ^ 0x51)) *
      (1 + 0.03 * (1 - v / SQUEAL_SPEED));
    const wander =
      (noise1(now * 7, seed) - 0.5) * 0.025 + (noise1(now * 23, seed ^ 7) - 0.5) * 0.008;
    osc.frequency.setTargetAtTime(pitch * (1 + wander), now, 0.02);
    band.frequency.setTargetAtTime(pitch * (1 + wander), now, 0.02);
    const grab = smoothstep(0.3, 0.55, noise1(now * 2.6, seed ^ 3));
    const fade = smoothstep(SQUEAL_SPEED, SQUEAL_SPEED * 0.55, v);
    // A last grab just before the stop.
    const last = v < 0.9 ? 1 : grab;
    gain.gain.setTargetAtTime(0.009 * strength * fade * last, now, 0.03);
  }

  private weatherEvents(world: World, now: number, dt: number, shelter: number): void {
    const bank = this.bank!;
    const w = world.env.weather.state;
    for (const strike of world.env.strikes) {
      const near = strike.distance < 3000;
      const gain = 0.7 * Math.min(1, Math.pow(1500 / strike.distance, 0.7));
      this.play(
        near ? bank.thunder[0] : bank.thunder[1],
        now + strike.distance / SPEED_OF_SOUND,
        gain,
        this.outsideBus,
        strike.direction * 0.6,
      );
    }
    // Drops tapping on the glass.
    const ticks = w.rain * (1 - shelter) * (14 + world.train.speed * 0.8) * dt;
    for (let n = ticks; n > 0; n--) {
      if (n < 1 && !this.rng.chance(n)) {
        break;
      }
      this.play(
        this.rng.pick(bank.dropTicks),
        now + this.rng.next() * dt,
        this.rng.range(0.02, 0.09),
        this.cabinBus,
        this.rng.range(-0.8, 0.8),
      );
    }
  }

  private fireworks(world: World, now: number): void {
    const bank = this.bank!;
    for (const shell of world.bursts) {
      const dist = Math.hypot(shell.lateral, shell.height, shell.along - world.train.pos);
      const delay = dist / SPEED_OF_SOUND;
      const gain = 0.5 * Math.min(1, 1500 / dist);
      const pan = Math.max(-0.8, Math.min(0.8, (shell.along - world.train.pos) / 1500));
      this.play(
        this.rng.pick(bank.fireworkBoom),
        now + delay,
        gain,
        this.outsideBus,
        pan,
        this.rng.range(0.9, 1.1),
      );
      if (shell.kind === "chrysanthemum" || shell.kind === "willow") {
        this.play(bank.crackle, now + delay + 0.5, gain * 0.35, this.outsideBus, pan);
      }
    }
  }
}
