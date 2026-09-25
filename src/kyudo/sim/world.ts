import { Rng } from "../../shared/core/random.ts";
import type { Timekeeping } from "../../shared/env/clock.ts";
import { Environment } from "../../shared/env/environment.ts";
import { Archer, type ArcherEvent, defaultAim } from "./archer.ts";
import {
  type Hole,
  obstaclesOf,
  type RestingArrow,
  type Settled,
  settle,
  standingArrows,
} from "./arrows.ts";
import { RANGE_PRIMS } from "./dojo.ts";
import { type Impact, type Launch, solveLaunch, traceFlight } from "./flight.ts";
import type { DojoRecord } from "./record.ts";
import { computeDojoSeason, type DojoSeason, TIME_OF_YEAR } from "./season.ts";

/**
 * Time at the dojo: a day lasts fifteen real minutes, slow enough to watch the
 * light change, and every day is the same autumn day.
 */
export const TIMEKEEPING: Timekeeping = { secondsPerDay: 900, timeOfYear: TIME_OF_YEAR };
/** The weather an autumn day at the dojo can have. */
export const DOJO_WEATHER = ["clear", "cloudy", "rain"] as const;
export type DojoWeather = (typeof DOJO_WEATHER)[number];
/** Longest single integration step (s); longer updates are split into steps this long. */
const MAX_STEP = 0.1;
/** Spread (m at the target) of the release itself: no two arrows fly quite alike. */
const RELEASE_SPREAD = 0.012;
/** Seconds the cleared arrows take to fade from the range. */
export const CLEAR_TIME = 0.35;
/** Seconds an arrow that left the range is followed before it is forgotten. */
const LOST_AFTER = 2;

export interface WorldOptions {
  seed: number;
  /** Starting minute of the day. */
  minute?: number;
  weather?: DojoWeather;
}

/** An arrow on its way: flying, then knocked off and falling, until it comes to rest. */
export interface Flight {
  id: number;
  pair: 0 | 1;
  launch: Launch;
  /** What it will strike, or null if it leaves the range. */
  impact: Impact | null;
  /** How it will come to rest. */
  settled: Settled | null;
  /** Seconds since the release. */
  age: number;
}

export type WorldEvent =
  | { kind: "archer"; event: ArcherEvent }
  /** An arrow was loosed; its flight already knows where and when it will strike. */
  | { kind: "loose"; flight: Flight }
  /** The arrows were cleared from the range. */
  | { kind: "cleared" };

/** The dojo and everything in it, advanced in real seconds. */
export class World {
  readonly seed: number;
  /** Time, sky and weather. */
  readonly env: Environment<DojoSeason>;
  readonly archer: Archer;
  /** Arrows at rest in the range. */
  readonly arrows: RestingArrow[];
  /** Holes in the targets' paper. */
  readonly holes: Hole[];
  readonly flights: Flight[] = [];
  /** Arrows just cleared, fading from the range, and since when (world seconds). */
  readonly clearing: RestingArrow[] = [];
  clearedAt = -Infinity;
  /** Cleared since the last update; reported by the next. */
  private justCleared = false;
  /** Real seconds simulated so far. */
  time = 0;
  /** Events of the last update. */
  readonly events: WorldEvent[] = [];
  /** Where the person aims when they draw. */
  readonly userAim: { x: number; y: number };
  private nextId: number;
  private readonly rng: Rng;

  private constructor(
    seed: number,
    env: Environment<DojoSeason>,
    arrows: RestingArrow[],
    holes: Hole[],
    aim: { x: number; y: number },
  ) {
    this.seed = seed;
    this.env = env;
    this.arrows = arrows;
    this.holes = holes;
    this.userAim = { ...aim };
    this.archer = new Archer(seed, aim);
    this.rng = new Rng(seed ^ 0x5eed);
    this.nextId = arrows.reduce((m, a) => Math.max(m, a.id + 1), 0);
  }

  /** A new visit: early morning unless the options say otherwise. */
  static create(options: WorldOptions): World {
    const env = Environment.create(
      options.seed,
      (options.minute ?? 6 * 60 + 30) / 1440,
      TIMEKEEPING,
      computeDojoSeason,
      options.weather,
    );
    return new World(options.seed, env, [], [], defaultAim());
  }

  /** The dojo as it was recorded. */
  static restore(record: DojoRecord): World {
    // Weather the dojo's autumn never has (kept from when its year still turned) is drawn afresh.
    const env = (DOJO_WEATHER as readonly string[]).includes(record.env.weather.state.kind)
      ? Environment.restore(record.seed, record.env, TIMEKEEPING, computeDojoSeason)
      : Environment.create(record.seed, record.env.days, TIMEKEEPING, computeDojoSeason);
    // Arrows left from before have long stopped quivering.
    const arrows = record.arrows.map((a, id) => ({ ...a, id, landedAt: -Infinity }));
    return new World(
      record.seed,
      env,
      arrows,
      record.holes.map((h) => ({ ...h })),
      record.aim,
    );
  }

  /** Enough to restore the dojo with `World.restore`; arrows in the air count as landed. */
  snapshot(): DojoRecord {
    const landing = this.flights.flatMap((f) => (f.settled ? [f.settled.arrow] : []));
    const holes = [
      ...this.holes,
      ...this.flights.flatMap((f) =>
        f.settled?.hole && f.impact && f.age < f.impact.time ? [f.settled.hole] : [],
      ),
    ];
    return {
      seed: this.seed,
      env: this.env.snapshot(),
      arrows: [...this.arrows, ...landing].map((a) => ({
        rest: a.rest,
        x: a.x,
        y: a.y,
        z: a.z,
        dx: a.dx,
        dy: a.dy,
        dz: a.dz,
        material: a.material,
        target: a.target,
        pair: a.pair,
      })),
      holes: holes.map((h) => ({ ...h })),
      aim: { ...this.userAim },
    };
  }

  /** Whether there is anything to clear: arrows in the range, or holes in the targets. */
  get hasArrows(): boolean {
    return this.arrows.length > 0 || this.holes.length > 0;
  }

  /** The person starts a draw; false if the archer cannot now. */
  handBegin(): boolean {
    if (!this.archer.ready) {
      return false;
    }
    if (this.archer.phase === "rest") {
      this.archer.aimAt(this.userAim.x, this.userAim.y);
    }
    return this.archer.begin();
  }

  handPull(goal: number): void {
    this.archer.pull(goal);
  }

  handNudge(dx: number, dy: number): void {
    this.archer.nudge(dx, dy);
    this.userAim.x = this.archer.aimX;
    this.userAim.y = this.archer.aimY;
  }

  handLoose(): void {
    this.archer.loose();
  }

  /** The hand was taken away without a release (the touch was cancelled): the draw is let down. */
  handLetDown(): void {
    this.archer.letDown();
  }

  /**
   * Clears the range at once: every arrow at rest fades away and the targets
   * are fresh again. Arrows still in the air land as usual. False if there
   * was nothing to clear.
   */
  clearArrows(): boolean {
    if (!this.hasArrows) {
      return false;
    }
    this.clearing.length = 0;
    this.clearing.push(...this.arrows);
    this.clearedAt = this.time;
    this.arrows.length = 0;
    this.holes.length = 0;
    this.justCleared = true;
    return true;
  }

  /** Advances by `dt` real seconds, in steps no longer than `MAX_STEP`. */
  update(dt: number): void {
    this.events.length = 0;
    this.env.clearEvents();
    if (this.justCleared) {
      this.justCleared = false;
      this.events.push({ kind: "cleared" });
    }
    const steps = Math.ceil(dt / MAX_STEP);
    for (let i = 0; i < steps; i++) {
      this.step(dt / steps);
    }
  }

  private step(dt: number): void {
    this.time += dt;
    this.env.step(dt);
    const archer = this.archer;
    archer.update(dt);
    for (const event of archer.events) {
      this.events.push({ kind: "archer", event });
    }
    if (archer.shot) {
      this.loose(archer.shot.from, archer.shot.aim);
    }
    this.updateFlights(dt);
    if (this.clearing.length > 0 && this.time - this.clearedAt >= CLEAR_TIME) {
      this.clearing.length = 0;
    }
  }

  private loose(
    from: { x: number; y: number; z: number },
    aim: { x: number; y: number; z: number },
  ): void {
    const r = this.rng;
    const mark = {
      x: aim.x + r.gaussian() * RELEASE_SPREAD,
      y: aim.y + r.gaussian() * RELEASE_SPREAD,
      z: aim.z,
    };
    const launch = solveLaunch(from, mark);
    const standing = standingArrows(this.arrows);
    const impact = traceFlight(launch, RANGE_PRIMS, obstaclesOf(standing));
    const id = this.nextId++;
    const pair: 0 | 1 = id % 2 === 0 ? 0 : 1;
    const settled = impact ? settle(impact, standing, id, pair, this.time + impact.time, r) : null;
    const flight: Flight = { id, pair, launch, impact, settled, age: 0 };
    this.flights.push(flight);
    this.events.push({ kind: "loose", flight });
  }

  private updateFlights(dt: number): void {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      const before = f.age;
      f.age += dt;
      const { impact, settled } = f;
      if (!impact || !settled) {
        if (f.age > LOST_AFTER) {
          this.flights.splice(i, 1);
        }
        continue;
      }
      // The hole shows in the paper the moment the arrow goes through.
      if (before < impact.time && f.age >= impact.time && settled.hole) {
        this.holes.push(settled.hole);
      }
      const restsAt = impact.time + Math.max(0, settled.drop);
      if (f.age >= restsAt) {
        this.arrows.push(settled.arrow);
        this.flights.splice(i, 1);
      }
    }
  }
}
