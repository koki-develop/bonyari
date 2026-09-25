import { Rng } from "../shared/core/random.ts";
import { obstaclesOf, settle, standingArrows } from "./sim/arrows.ts";
import { OWN_TARGET, RANGE_PRIMS, TARGET_HEIGHT, TARGETS } from "./sim/dojo.ts";
import { solveLaunch, traceFlight } from "./sim/flight.ts";
import { DOJO_WEATHER, type DojoWeather, type World, type WorldOptions } from "./sim/world.ts";

/**
 * Development-only URL parameters for inspecting specific scenes:
 * `time` (HH:MM), `weather`, `timescale` (world speed multiplier),
 * `arrows` (that many arrows already shot around the own target),
 * `kai` (hold at full draw), `aim` (x,y in meters on the plane of the targets).
 */
export interface DevOptions {
  world: Partial<WorldOptions>;
  timescale: number;
  arrows: number;
  kai: boolean;
  aim: { x: number; y: number } | null;
}

export function readDevOptions(params: URLSearchParams): DevOptions {
  const world: Partial<WorldOptions> = {};
  const time = params.get("time");
  if (time !== null) {
    const [h, m] = time.split(":").map(Number);
    world.minute = h * 60 + (m || 0);
  }
  const weather = params.get("weather");
  if (weather !== null && (DOJO_WEATHER as readonly string[]).includes(weather)) {
    world.weather = weather as DojoWeather;
  }
  const timescale = Number(params.get("timescale") ?? 1);
  const aim = params.get("aim")?.split(",").map(Number);
  return {
    world,
    timescale: Number.isFinite(timescale) && timescale > 0 ? timescale : 1,
    arrows: Math.max(0, Math.floor(Number(params.get("arrows") ?? 0)) || 0),
    kai: params.has("kai"),
    aim: aim && aim.length === 2 && aim.every(Number.isFinite) ? { x: aim[0], y: aim[1] } : null,
  };
}

/** Whether any development option asks for a particular scene. */
export function asksForScene(dev: DevOptions): boolean {
  return Object.keys(dev.world).length > 0 || dev.arrows > 0 || dev.kai || dev.aim !== null;
}

/** Sets the world up as the options ask. */
export function applyDevOptions(world: World, dev: DevOptions): void {
  const r = new Rng(world.seed ^ 0xdeb);
  const from = world.archer.launchPoint();
  for (let i = 0; i < dev.arrows; i++) {
    // Around the own target, some wide of it, as a day's practice leaves them.
    const spread = r.chance(0.8) ? 0.1 : 0.45;
    const mark = {
      x: TARGETS[OWN_TARGET].x + r.gaussian() * spread,
      y: TARGET_HEIGHT + r.gaussian() * spread,
      z: TARGETS[OWN_TARGET].z,
    };
    const standing = standingArrows(world.arrows);
    const impact = traceFlight(solveLaunch(from, mark), RANGE_PRIMS, obstaclesOf(standing));
    if (!impact) {
      continue;
    }
    const s = settle(impact, standing, 10000 + i, i % 2 === 0 ? 0 : 1, -Infinity, r);
    world.arrows.push(s.arrow);
    if (s.hole) {
      world.holes.push(s.hole);
    }
  }
  if (dev.aim) {
    world.userAim.x = dev.aim.x;
    world.userAim.y = dev.aim.y;
    world.archer.aimAt(dev.aim.x, dev.aim.y);
  }
  if (dev.kai) {
    world.handBegin();
    world.handPull(1);
    for (let i = 0; i < 120 && !world.archer.full; i++) {
      world.archer.update(1 / 30);
    }
  }
}
