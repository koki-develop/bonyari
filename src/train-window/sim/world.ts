import { Rng } from "../../shared/core/random.ts";
import { DAYS_PER_YEAR, type Timekeeping } from "../../shared/env/clock.ts";
import { Environment } from "../../shared/env/environment.ts";
import type { WeatherKind } from "../../shared/env/weather.ts";
import { Fireworks, type Shell } from "./fireworks.ts";
import type { Journey } from "./journey.ts";
import { Route, type SectionKind, TRANSITION } from "./route.ts";
import { computeRouteSeason, type RouteSeason } from "./season.ts";
import { Traffic } from "./traffic.ts";
import { Train, type TrainEventType } from "./train.ts";

/**
 * Route generated (and kept) this far (m) on both sides of the train: the
 * farthest ridge sees about 30 km along the line, plus its terrain filter.
 */
const ROUTE_REACH = 45000;
/** Time on the train: a day lasts five real minutes, and the year turns. */
export const TIMEKEEPING: Timekeeping = { secondsPerDay: 300, timeOfYear: null };
/** Longest single integration step (s); longer updates are split into steps this long. */
const MAX_STEP = 0.1;

export interface WorldOptions {
  seed: number;
  /** Starting day within the year (0 = first day of spring); random when omitted. */
  day?: number;
  /** Starting minute of the day. */
  minute?: number;
  weather?: WeatherKind;
  /** Kind of the first section. */
  section?: SectionKind;
  /** Keep every section of this kind (development aid). */
  onlySection?: SectionKind;
}

/** Everything that happens outside the window, advanced in real seconds. */
export class World {
  readonly seed: number;
  /** Time, sky and weather. */
  readonly env: Environment<RouteSeason>;
  readonly route: Route;
  readonly train: Train;
  readonly traffic: Traffic;
  readonly fireworks: Fireworks;
  /** Real seconds simulated so far. */
  time = 0;
  /** Train events fired during the last update. */
  readonly trainEvents: TrainEventType[] = [];
  /** Firework shells that burst during the last update. */
  readonly bursts: Shell[] = [];

  private constructor(seed: number, env: Environment<RouteSeason>, route: Route, train: Train) {
    this.seed = seed;
    this.env = env;
    this.route = route;
    this.train = train;
    this.traffic = new Traffic(route, seed);
    this.fireworks = new Fireworks(seed);
  }

  /** A new ride: 23:00 on a random day unless the options say otherwise. */
  static create(options: WorldOptions): World {
    const rng = new Rng(options.seed);
    const day = options.day ?? Math.floor(rng.next() * DAYS_PER_YEAR);
    const route = Route.create(options.seed, options.section ?? null, options.onlySection ?? null);
    // Start well inside the first section, away from its structures.
    const start = route.first.start + TRANSITION + 120;
    route.ensure(start + ROUTE_REACH, start - ROUTE_REACH);
    const env = Environment.create(
      options.seed,
      day + (options.minute ?? 23 * 60) / 1440,
      TIMEKEEPING,
      computeRouteSeason,
      options.weather,
    );
    return new World(options.seed, env, route, new Train(route, start));
  }

  /** The ride `journey` was taken from, or null when its train doesn't fit the route. */
  static resume(journey: Journey): World | null {
    const route = new Route(journey.seed, journey.route);
    const pos = journey.train.pos;
    route.ensure(pos + ROUTE_REACH, pos - ROUTE_REACH);
    const train = Train.restore(route, journey.train);
    if (!train) {
      return null;
    }
    const env = Environment.restore(journey.seed, journey, TIMEKEEPING, computeRouteSeason);
    return new World(journey.seed, env, route, train);
  }

  /** Where the ride is now, enough to resume it with `World.resume`. */
  snapshot(): Journey {
    return {
      seed: this.seed,
      ...this.env.snapshot(),
      route: this.route.anchor,
      train: this.train.snapshot(),
    };
  }

  /** Advances by `dt` real seconds, in steps no longer than `MAX_STEP`. */
  update(dt: number): void {
    this.trainEvents.length = 0;
    this.bursts.length = 0;
    this.env.clearEvents();
    const steps = Math.ceil(dt / MAX_STEP);
    for (let i = 0; i < steps; i++) {
      this.step(dt / steps);
    }
  }

  private step(dt: number): void {
    this.time += dt;
    const env = this.env;
    env.step(dt);
    this.train.update(dt);
    const pos = this.train.pos;
    this.route.ensure(pos + ROUTE_REACH, pos - ROUTE_REACH);
    this.traffic.update(dt, pos, this.train.speed, env.clock.hour, pos - 600, pos + 600);
    this.fireworks.update(dt, env.clock.days, env.clock.hour, pos, env.season);
    this.trainEvents.push(...this.train.events);
    this.bursts.push(...this.fireworks.bursts);
  }
}
