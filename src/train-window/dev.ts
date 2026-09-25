import { SECTION_KINDS, type SectionKind } from "./sim/route.ts";
import { WEATHER_KINDS, type WeatherKind } from "../shared/env/weather.ts";
import type { WorldOptions } from "./sim/world.ts";

/**
 * Development-only URL parameters for inspecting specific scenes:
 * `day` (0-11), `time` (HH:MM), `weather`, `section`, `only` (repeat a section kind),
 * `timescale` (world speed multiplier).
 */
export interface DevOptions {
  world: Partial<WorldOptions>;
  timescale: number;
}

export function readDevOptions(params: URLSearchParams): DevOptions {
  const world: Partial<WorldOptions> = {};
  const day = params.get("day");
  if (day !== null) {
    world.day = Number(day);
  }
  const time = params.get("time");
  if (time !== null) {
    const [h, m] = time.split(":").map(Number);
    world.minute = h * 60 + (m || 0);
  }
  const weather = params.get("weather");
  if (weather !== null && (WEATHER_KINDS as readonly string[]).includes(weather)) {
    world.weather = weather as WeatherKind;
  }
  const section = params.get("section");
  if (section !== null && (SECTION_KINDS as readonly string[]).includes(section)) {
    world.section = section as SectionKind;
  }
  const only = params.get("only");
  if (only !== null && (SECTION_KINDS as readonly string[]).includes(only)) {
    world.onlySection = only as SectionKind;
  }
  const timescale = Number(params.get("timescale") ?? 1);
  return { world, timescale: Number.isFinite(timescale) && timescale > 0 ? timescale : 1 };
}
