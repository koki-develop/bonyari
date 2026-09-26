import { mod } from "../shared/core/math.ts";
import { DAYS_PER_YEAR } from "../shared/env/clock.ts";
import { WEATHER_KINDS, type WeatherKind } from "../shared/env/weather.ts";
import type { BuildingKind } from "./sim/buildings.ts";
import { RAID_KINDS, type RaidKind } from "./sim/raids.ts";
import { TIMEKEEPING, type World } from "./sim/world.ts";

/**
 * Development-only URL parameters for inspecting particular scenes:
 * `age` (in-world days the settlement has lived, simulated on the spot),
 * `day` (0-11, the day of the year to go on to) and `time` (HH:MM),
 * `weather` (settled at once), `timescale` (world speed multiplier),
 * `showcase` (every kind of building raised at once, some half built and
 * some in ruins, to look them over), and `raid` (a raid of that kind set
 * loose at once).
 */
export interface DevOptions {
  age: number;
  showcase: boolean;
  raid: RaidKind | null;
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
    showcase: params.get("showcase") === "1",
    raid: RAID_KINDS.find((k) => k === params.get("raid")) ?? null,
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
  return (
    dev.age > 0 ||
    dev.showcase ||
    dev.raid !== null ||
    dev.day !== null ||
    dev.minute !== null ||
    dev.weather !== null ||
    dev.timescale !== 1
  );
}

/**
 * Lives the settlement through `age` days, then on to the day and time asked
 * for, so everything is as it would have come to be; then settles the
 * weather asked for.
 */
export function applyDevOptions(world: World, dev: DevOptions): void {
  if (dev.showcase) {
    showcase(world);
  }
  const seconds = TIMEKEEPING.secondsPerDay;
  simulate(world, dev.age * seconds);
  if (dev.day !== null || dev.minute !== null) {
    const now = world.env.clock.days;
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
  if (dev.raid) {
    // The view opens on the square: the raid comes where it will be seen.
    world.attention = { x: world.plan.center.x, y: world.plan.center.y };
    world.raids.start(world, dev.raid);
  }
}

/**
 * Lives the world through `seconds`, in steps longer than when it is
 * watched: it comes out much the same, a few times sooner.
 */
function simulate(world: World, seconds: number): void {
  const chunk = 5;
  for (let t = 0; t < seconds; t += chunk) {
    world.update(Math.min(chunk, seconds - t), FAST_STEP);
  }
}

/** Seconds a step of the world lasts while days are lived through at once. */
const FAST_STEP = 0.5;

/** Raises every kind of building on the plan at once: most finished, some going up, some burned. */
function showcase(world: World): void {
  const plan = world.plan;
  const special: Partial<Record<string, BuildingKind>> = {
    church: "church",
    townhall: "townhall",
    tavern: "tavern",
    watermill: "watermill",
    windmill: "windmill",
    lumberyard: "lumberyard",
    quarry: "quarry",
    watchtower: "watchtower",
    wizard: "wizard",
    well: "well",
  };
  const inner: BuildingKind[] = [
    "townhouse",
    "stonehouse",
    "house",
    "cabin",
    "smithy",
    "bakery",
    "workshop",
  ];
  const outer: BuildingKind[] = ["farmhouse", "barn", "house", "cabin"];
  let k = 0;
  for (const lot of plan.lots) {
    const kind =
      lot.kind === "plot"
        ? lot.zone === "outer"
          ? outer[k % outer.length]
          : inner[k % inner.length]
        : special[lot.kind];
    if (!kind) {
      continue;
    }
    const b = world.found(kind, { type: "lot", lot: lot.id }, 2, "standing");
    // Every seventh one half built, every eleventh a ruin.
    if (k % 7 === 3) {
      b.phase = "building";
      b.progress = [0.02, 0.15, 0.35, 0.6, 0.9][((k / 7) % 5) | 0];
    } else if (k % 11 === 5) {
      b.phase = "ruin";
      b.cleared = 0;
    }
    k++;
  }
  const w = plan.wall;
  w.points.forEach((_, i) => {
    world.found(i % 3 === 0 ? "palisade" : "wall", { type: "wall", index: i }, 2, "standing");
  });
  for (const t of w.towers) {
    world.found("tower", { type: "tower", index: t }, 2, "standing");
  }
  w.gates.forEach((_, i) =>
    world.found(i === 0 ? "woodgate" : "gatehouse", { type: "gate", gate: i }, 2, "standing"),
  );
  world.found("stonebridge", { type: "ford" }, 2, "standing");
  world.found("camp", { type: "square" }, 0, "standing");
  for (const b of world.town.buildings) {
    for (const id of b.clearing) {
      world.fell(id);
      world.grub(id);
    }
  }
  world.town.squareGrade = 3;
  world.town.streetGrade.fill(3);
}
