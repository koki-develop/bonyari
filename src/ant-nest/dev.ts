import { mod } from "../shared/core/math.ts";
import { DAYS_PER_YEAR } from "../shared/env/clock.ts";
import { WEATHER_KINDS, type WeatherKind } from "../shared/env/weather.ts";
import { TIMEKEEPING, type World } from "./sim/world.ts";

/**
 * Development-only URL parameters for inspecting specific scenes:
 * `age` (in-world days the colony has lived, simulated on the spot),
 * `day` (0-11, the day of the year to go on to) and `time` (HH:MM),
 * `weather` (settled at once), `timescale` (world speed multiplier).
 */
export interface DevOptions {
  age: number;
  day: number | null;
  minute: number | null;
  weather: WeatherKind | null;
  timescale: number;
}

export function readDevOptions(params: URLSearchParams): DevOptions {
  const time = params.get("time");
  let minute: number | null = null;
  if (time !== null) {
    const [h, m] = time.split(":").map(Number);
    minute = h * 60 + (m || 0);
  }
  const day = params.get("day");
  const weather = params.get("weather");
  const age = Number(params.get("age") ?? 0);
  const timescale = Number(params.get("timescale") ?? 1);
  return {
    age: Number.isFinite(age) && age > 0 ? age : 0,
    day: day !== null && Number.isFinite(Number(day)) ? mod(Number(day), DAYS_PER_YEAR) : null,
    minute: minute !== null && Number.isFinite(minute) ? mod(minute, 1440) : null,
    weather:
      weather !== null && (WEATHER_KINDS as readonly string[]).includes(weather)
        ? (weather as WeatherKind)
        : null,
    timescale: Number.isFinite(timescale) && timescale > 0 ? timescale : 1,
  };
}

/** Whether any development option asks for a particular scene. */
export function asksForScene(dev: DevOptions): boolean {
  return dev.age > 0 || dev.day !== null || dev.minute !== null || dev.weather !== null;
}

/**
 * Lives the colony through `age` days, then on to the day and time asked
 * for, so everything (the nest, the heap, the soil's warmth) is as it would
 * be; then settles the weather asked for.
 */
export function applyDevOptions(world: World, dev: DevOptions): void {
  const seconds = TIMEKEEPING.secondsPerDay;
  simulate(world, dev.age * seconds);
  if (dev.day !== null || dev.minute !== null) {
    const now = world.day;
    const minute = dev.minute ?? mod(now, 1) * 1440;
    // On to that day of the year, or with only a time given, to the next time the clock shows it.
    const ahead =
      dev.day === null
        ? mod(minute / 1440 - mod(now, 1), 1)
        : mod(dev.day + minute / 1440 - mod(now, DAYS_PER_YEAR), DAYS_PER_YEAR);
    simulate(world, ahead * seconds);
  }
  if (dev.weather) {
    const env = world.env;
    env.weather.setKind(dev.weather, env.season);
    // Let the sky and the ground come round to it without moving the clock.
    for (let i = 0; i < 240; i++) {
      env.weather.update(1, 0, env.clock.days, env.clock.hour, env.season);
    }
  }
}

function simulate(world: World, seconds: number): void {
  const step = 1;
  for (let t = 0; t < seconds; t += step) {
    world.update(Math.min(step, seconds - t));
  }
}
