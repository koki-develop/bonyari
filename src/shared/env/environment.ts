import { clamp01, smoothstep } from "../core/math.ts";
import { asRecord, isFiniteNumber } from "../core/validate.ts";
import { computeSky, type SkyState } from "./astro.ts";
import { Clock, type Timekeeping } from "./clock.ts";
import type { SeasonState } from "./season.ts";
import { SkyEvents } from "./sky-events.ts";
import { buildStarField, type Star } from "./stars.ts";
import {
  type LightningStrike,
  readWeatherSnapshot,
  USUAL_WEATHER,
  Weather,
  type WeatherKind,
  type WeatherSnapshot,
  type WeatherTendency,
} from "./weather.ts";

/** Everything that carries the time, sky and weather on from one moment to the next. */
export interface EnvironmentSnapshot {
  /** Clock reading in days (`Clock.days`). */
  days: number;
  weather: WeatherSnapshot;
}

/**
 * Time, sky and weather: the clock and the seasons, the sun, moon and stars,
 * the weather, and what passes across the sky. Works add what happens on the
 * ground; `S` is the seasonal state a work derives from the time of year.
 */
export class Environment<S extends SeasonState = SeasonState> {
  readonly seed: number;
  readonly clock: Clock;
  readonly weather: Weather;
  readonly skyEvents: SkyEvents;
  readonly stars: readonly Star[];
  season: S;
  sky: SkyState;
  /** Lightning strikes since the last `clearEvents`. */
  readonly strikes: LightningStrike[] = [];
  private readonly seasonOf: (yearFraction: number) => S;

  private constructor(
    seed: number,
    clock: Clock,
    weather: Weather,
    seasonOf: (yearFraction: number) => S,
  ) {
    this.seed = seed;
    this.clock = clock;
    this.weather = weather;
    this.seasonOf = seasonOf;
    this.season = seasonOf(clock.yearFraction);
    this.sky = computeSky(clock.calendarDayOfYear, clock.hour, clock.days);
    this.skyEvents = new SkyEvents(seed);
    this.stars = buildStarField(seed);
  }

  /**
   * New conditions at `days`, keeping time as `timekeeping` says, with the
   * weather settled into `weather` or one picked for the season, and leaning
   * as `tendency` says from then on.
   */
  static create<S extends SeasonState>(
    seed: number,
    days: number,
    timekeeping: Timekeeping,
    seasonOf: (yearFraction: number) => S,
    weather?: WeatherKind,
    tendency: WeatherTendency = USUAL_WEATHER,
  ): Environment<S> {
    const clock = new Clock(days, timekeeping);
    return new Environment(
      seed,
      clock,
      Weather.create(seed, seasonOf(clock.yearFraction), weather, tendency),
      seasonOf,
    );
  }

  static restore<S extends SeasonState>(
    seed: number,
    snapshot: EnvironmentSnapshot,
    timekeeping: Timekeeping,
    seasonOf: (yearFraction: number) => S,
    tendency: WeatherTendency = USUAL_WEATHER,
  ): Environment<S> {
    return new Environment(
      seed,
      new Clock(snapshot.days, timekeeping),
      Weather.restore(seed, snapshot.weather, tendency),
      seasonOf,
    );
  }

  snapshot(): EnvironmentSnapshot {
    return { days: this.clock.days, weather: this.weather.snapshot() };
  }

  /** Forgets the events of the previous update; call before a series of `step`s. */
  clearEvents(): void {
    this.strikes.length = 0;
  }

  /** Advances by `dt` real seconds in one step; callers keep steps short. */
  step(dt: number): void {
    const daysBefore = this.clock.days;
    this.clock.advance(dt);
    const worldDt = this.clock.days - daysBefore;
    this.season = this.seasonOf(this.clock.yearFraction);
    this.sky = computeSky(this.clock.calendarDayOfYear, this.clock.hour, this.clock.days);
    this.weather.update(dt, worldDt, this.clock.days, this.clock.hour, this.season);
    this.skyEvents.update(dt, this.darkness * clamp01(1 - this.weather.state.cloudCover * 1.3));
    this.strikes.push(...this.weather.strikes);
  }

  /** 1 at full night, 0 in daylight. */
  get darkness(): number {
    return smoothstep(-4, -14, this.sky.sunAltitude);
  }
}

/** The snapshot in `value`, or null unless it is well formed. */
export function readEnvironmentSnapshot(value: unknown): EnvironmentSnapshot | null {
  const o = asRecord(value);
  const weather = readWeatherSnapshot(o?.weather);
  return o && isFiniteNumber(o.days) && weather ? { days: o.days, weather } : null;
}
