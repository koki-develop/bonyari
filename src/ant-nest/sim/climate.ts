import { clamp01, smoothstep, TAU } from "../../shared/core/math.ts";
import { computeSky } from "../../shared/env/astro.ts";
import { Clock, type Timekeeping } from "../../shared/env/clock.ts";
import type { Environment } from "../../shared/env/environment.ts";
import { computeSeason } from "../../shared/env/season.ts";

/** Depth (mm) between the nodes of the soil column, and how many there are. */
const DZ = 10;
const NODES = 90;
/** Thermal diffusivity of moist loam (mm²/s). */
const HEAT_DIFFUSIVITY = 0.5;
/** How water spreads (mm²/s) and drains downward (mm/s) through the soil. */
const WATER_DIFFUSIVITY = 0.12;
const DRAINAGE = 0.0007;
/** Moisture of soil that has dried out, and of soil at rest between rains. */
const DRY = 0.12;
const FIELD = 0.34;
/** Largest step (s of world time) the explicit integration stays stable at. */
const MAX_WORLD_STEP = 60;

/**
 * The temperature (°C) of the ground's surface: the air of the season and the
 * hour, warmed by the sun on bare soil, cooled by rain, and held near freezing
 * under snow.
 */
export function surfaceTemperature(
  warmth: number,
  hour: number,
  sunAltitude: number,
  cloudCover: number,
  rain: number,
  snowCover: number,
): number {
  const mean = 3 + 24 * warmth;
  const swing = 3.5 + 3 * (1 - cloudCover);
  const air = mean + swing * Math.cos((TAU * (hour - 14.5)) / 24);
  const sun = Math.max(0, Math.sin((sunAltitude * Math.PI) / 180)) * (1 - 0.85 * cloudCover);
  let t = air + 13 * sun - 2.5 * rain;
  // Snow keeps the ground beneath it close to freezing.
  const snow = smoothstep(0.1, 0.4, snowCover);
  t = t + (Math.min(t, 0.5) - t) * snow;
  return t;
}

/**
 * The soil as a column of temperature and moisture by depth, following the
 * surface through the days and the seasons. Heat and water move through it
 * in world time, so the day's warmth reaches only a hand's depth while the
 * season's reaches all the way down, late.
 */
export class Climate {
  readonly temperature = new Float64Array(NODES);
  readonly moisture = new Float64Array(NODES);
  surface = 15;
  private readonly scratch = new Float64Array(NODES);
  private readonly worldPerReal: number;

  private constructor(timekeeping: Timekeeping) {
    this.worldPerReal = 86400 / timekeeping.secondsPerDay;
  }

  /** A column settled into the weather of the days before `days`, for a new colony. */
  static create(days: number, timekeeping: Timekeeping): Climate {
    const c = new Climate(timekeeping);
    // Start from the season's mean, then live through the past year in fair weather.
    const clock = new Clock(days, timekeeping);
    const mean = 3 + 24 * computeSeason(clock.yearFraction).warmth;
    c.temperature.fill(mean);
    c.moisture.fill(FIELD);
    const step = MAX_WORLD_STEP / c.worldPerReal;
    const span = timekeeping.secondsPerDay * 12;
    const past = new Clock(days, timekeeping);
    past.days = days - span / timekeeping.secondsPerDay;
    for (let t = 0; t < span; t += step) {
      past.advance(step);
      const season = computeSeason(past.yearFraction);
      const sky = computeSky(past.calendarDayOfYear, past.hour, past.days);
      c.surface = surfaceTemperature(season.warmth, past.hour, sky.sunAltitude, 0.35, 0, 0);
      c.integrate(step, 0, 0.35, sky.sunAltitude);
    }
    return c;
  }

  static restore(
    temperature: readonly number[],
    moisture: readonly number[],
    timekeeping: Timekeeping,
  ): Climate {
    const c = new Climate(timekeeping);
    c.temperature.set(temperature.slice(0, NODES));
    c.moisture.set(moisture.slice(0, NODES));
    c.surface = c.temperature[0];
    return c;
  }

  /** How many values a record keeps of each column. */
  static get nodes(): number {
    return NODES;
  }

  /** Follows the weather over `dt` real seconds. */
  step(env: Environment, dt: number): void {
    const w = env.weather.state;
    this.surface = surfaceTemperature(
      env.season.warmth,
      env.clock.hour,
      env.sky.sunAltitude,
      w.cloudCover,
      w.rain,
      w.snowCover,
    );
    this.integrate(dt, w.rain, w.cloudCover, env.sky.sunAltitude);
  }

  private integrate(dt: number, rain: number, cloudCover: number, sunAltitude: number): void {
    const total = dt * this.worldPerReal;
    const steps = Math.max(1, Math.ceil(total / MAX_WORLD_STEP));
    const h = total / steps;
    const temp = this.temperature;
    const water = this.moisture;
    const next = this.scratch;
    const kT = (HEAT_DIFFUSIVITY * h) / (DZ * DZ);
    const kW = (WATER_DIFFUSIVITY * h) / (DZ * DZ);
    const drain = (DRAINAGE * h) / DZ;
    // The top follows the surface; rain soaks it, sun and warmth dry it.
    const sun = Math.max(0, Math.sin((sunAltitude * Math.PI) / 180)) * (1 - cloudCover);
    const drying = (0.4 + 1.6 * sun) * clamp01((this.surface + 2) / 30);
    for (let n = 0; n < steps; n++) {
      temp[0] += (this.surface - temp[0]) * Math.min(1, h / 900);
      if (rain > 0.02) {
        water[0] += (1 - water[0]) * Math.min(1, (h / 2400) * (0.3 + rain));
      } else {
        water[0] += (DRY - water[0]) * Math.min(1, (h / 86400) * drying);
      }
      for (let i = 1; i < NODES; i++) {
        const below = i + 1 < NODES ? i + 1 : i;
        next[i] = temp[i] + kT * (temp[i - 1] - 2 * temp[i] + temp[below]);
      }
      for (let i = 1; i < NODES; i++) {
        temp[i] = next[i];
      }
      for (let i = 1; i < NODES; i++) {
        const below = i + 1 < NODES ? i + 1 : i;
        // Water above field capacity drains down; below it, it only spreads.
        const inflow = Math.max(0, water[i - 1] - FIELD) * drain;
        const outflow = i + 1 < NODES ? Math.max(0, water[i] - FIELD) * drain : 0;
        next[i] = water[i] + kW * (water[i - 1] - 2 * water[i] + water[below]) + inflow - outflow;
      }
      for (let i = 1; i < NODES; i++) {
        water[i] = clamp01(next[i]);
      }
      // The deep ground slowly returns to its usual dampness.
      water[NODES - 1] += (FIELD - water[NODES - 1]) * Math.min(1, h / 864000);
    }
  }

  /** Temperature (°C) at `depth` (mm below the surface). */
  temperatureAt(depth: number): number {
    return sample(this.temperature, depth);
  }

  /** Moisture (0 dry .. 1 soaked) at `depth` (mm below the surface). */
  moistureAt(depth: number): number {
    return sample(this.moisture, depth);
  }
}

function sample(column: Float64Array, depth: number): number {
  const t = Math.max(0, depth) / DZ;
  const i = Math.min(NODES - 2, Math.floor(t));
  const f = Math.min(1, t - i);
  return column[i] * (1 - f) + column[i + 1] * f;
}
