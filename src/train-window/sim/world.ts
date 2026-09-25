import { clamp01, smoothstep } from "../core/math.ts";
import { Rng } from "../core/random.ts";
import { computeSky, type SkyState } from "./astro.ts";
import { Clock, DAYS_PER_YEAR } from "./clock.ts";
import type { Journey } from "./journey.ts";
import { Route, type SectionKind, TRANSITION } from "./route.ts";
import { computeSeason, type SeasonState } from "./season.ts";
import { type Shell, Spectacle } from "./spectacle.ts";
import { buildStarField, type Star } from "./stars.ts";
import { Traffic } from "./traffic.ts";
import { Train, type TrainEventType } from "./train.ts";
import { type LightningStrike, Weather, type WeatherKind } from "./weather.ts";

/**
 * Route generated (and kept) this far (m) on both sides of the train: the
 * farthest ridge sees about 30 km along the line, plus its terrain filter.
 */
const ROUTE_REACH = 45000;
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
  readonly clock: Clock;
  readonly route: Route;
  readonly train: Train;
  readonly weather: Weather;
  readonly traffic: Traffic;
  readonly spectacle: Spectacle;
  readonly stars: readonly Star[];
  season: SeasonState;
  sky: SkyState;
  /** Real seconds simulated so far. */
  time = 0;
  /** Train events fired during the last update. */
  readonly trainEvents: TrainEventType[] = [];
  /** Lightning strikes during the last update. */
  readonly strikes: LightningStrike[] = [];
  /** Firework shells that burst during the last update. */
  readonly bursts: Shell[] = [];

  private constructor(seed: number, clock: Clock, route: Route, train: Train, weather: Weather) {
    this.seed = seed;
    this.clock = clock;
    this.route = route;
    this.train = train;
    this.weather = weather;
    this.season = computeSeason(clock.yearFraction);
    this.sky = computeSky(clock.calendarDayOfYear, clock.hour, clock.days);
    this.traffic = new Traffic(route, seed);
    this.spectacle = new Spectacle(seed);
    this.stars = buildStarField(seed);
  }

  /** A new ride: 23:00 on a random day unless the options say otherwise. */
  static create(options: WorldOptions): World {
    const rng = new Rng(options.seed);
    const day = options.day ?? Math.floor(rng.next() * DAYS_PER_YEAR);
    const clock = new Clock(day + (options.minute ?? 23 * 60) / 1440);
    const route = Route.create(options.seed, options.section ?? null, options.onlySection ?? null);
    // Start well inside the first section, away from its structures.
    const start = route.first.start + TRANSITION + 120;
    route.ensure(start + ROUTE_REACH, start - ROUTE_REACH);
    const weather = Weather.create(
      options.seed,
      computeSeason(clock.yearFraction),
      options.weather,
    );
    return new World(options.seed, clock, route, new Train(route, start), weather);
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
    const weather = Weather.restore(journey.seed, journey.weather);
    return new World(journey.seed, new Clock(journey.days), route, train, weather);
  }

  /** Where the ride is now, enough to resume it with `World.resume`. */
  snapshot(): Journey {
    return {
      seed: this.seed,
      days: this.clock.days,
      route: this.route.anchor,
      train: this.train.snapshot(),
      weather: this.weather.snapshot(),
    };
  }

  /** Advances by `dt` real seconds, in steps no longer than `MAX_STEP`. */
  update(dt: number): void {
    this.trainEvents.length = 0;
    this.strikes.length = 0;
    this.bursts.length = 0;
    const steps = Math.ceil(dt / MAX_STEP);
    for (let i = 0; i < steps; i++) {
      this.step(dt / steps);
    }
  }

  private step(dt: number): void {
    this.time += dt;
    const daysBefore = this.clock.days;
    this.clock.advance(dt);
    const worldDt = this.clock.days - daysBefore;
    this.season = computeSeason(this.clock.yearFraction);
    this.sky = computeSky(this.clock.calendarDayOfYear, this.clock.hour, this.clock.days);
    this.weather.update(dt, worldDt, this.clock.days, this.clock.hour, this.season);
    this.train.update(dt);
    const pos = this.train.pos;
    this.route.ensure(pos + ROUTE_REACH, pos - ROUTE_REACH);
    this.traffic.update(dt, pos, this.train.speed, this.clock.hour, pos - 600, pos + 600);
    this.spectacle.update(
      dt,
      this.clock.days,
      this.clock.hour,
      pos,
      this.season,
      this.darkness,
      clamp01(1 - this.weather.state.cloudCover * 1.3),
    );
    this.trainEvents.push(...this.train.events);
    this.strikes.push(...this.weather.strikes);
    this.bursts.push(...this.spectacle.bursts);
  }

  /** 1 at full night, 0 in daylight. */
  get darkness(): number {
    return smoothstep(-4, -14, this.sky.sunAltitude);
  }
}
