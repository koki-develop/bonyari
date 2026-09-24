import { clamp01, smoothstep } from "../core/math.ts";
import { Rng } from "../core/random.ts";
import { computeSky, type SkyState } from "./astro.ts";
import { Clock, DAYS_PER_YEAR } from "./clock.ts";
import { Route, type SectionKind, TRANSITION } from "./route.ts";
import { computeSeason, type SeasonState } from "./season.ts";
import { Spectacle } from "./spectacle.ts";
import { buildStarField, type Star } from "./stars.ts";
import { Traffic } from "./traffic.ts";
import { Train } from "./train.ts";
import { Weather, type WeatherKind } from "./weather.ts";

/**
 * Route generated (and kept) this far (m) on both sides of the train: the
 * farthest ridge sees about 30 km along the line, plus its terrain filter.
 */
const ROUTE_REACH = 45000;

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

  constructor(options: WorldOptions) {
    const rng = new Rng(options.seed);
    this.seed = options.seed;
    const day = options.day ?? Math.floor(rng.next() * DAYS_PER_YEAR);
    this.clock = new Clock(day + (options.minute ?? 23 * 60) / 1440);
    this.season = computeSeason(this.clock.yearFraction);
    this.sky = computeSky(this.clock.calendarDayOfYear, this.clock.hour, this.clock.days);
    this.route = new Route(options.seed, options.section ?? null, options.onlySection ?? null);
    const first = this.route.first;
    // Start well inside the first section, away from its structures.
    const start = first.start + TRANSITION + 120;
    this.route.ensure(start + ROUTE_REACH, start - ROUTE_REACH);
    this.train = new Train(this.route, start);
    this.weather = new Weather(options.seed, this.season, options.weather);
    this.traffic = new Traffic(this.route, options.seed);
    this.spectacle = new Spectacle(options.seed);
    this.stars = buildStarField(options.seed);
  }

  update(dt: number): void {
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
  }

  /** 1 at full night, 0 in daylight. */
  get darkness(): number {
    return smoothstep(-4, -14, this.sky.sunAltitude);
  }
}
