import { clamp01 } from "../../shared/core/math.ts";
import { type Building, KINDS } from "./buildings.ts";
import type { World } from "./world.ts";

/** Seconds a building of flammability 1 burns at full blaze before it falls; stone lasts longer. */
const BURN_TIME = 55;
/** Reach (m) a blaze can jump to the next building. */
const SPREAD_REACH = 6;
/** How much one bucket-thrower puts out per second, against a full blaze. */
const DOUSE_RATE = 0.022;

/** Sets a building alight, or feeds a fire already burning. */
export function ignite(world: World, b: Building, amount: number): void {
  const spec = KINDS[b.kind];
  if (b.phase === "clearing" || spec.flammable <= 0.01) {
    return;
  }
  const was = b.fire;
  b.fire = clamp01(b.fire + amount * (0.4 + 0.6 * spec.flammable));
  if (was < 0.02 && b.fire >= 0.02) {
    const d = world.door(b);
    world.sound("ignite", d.x, d.y, b.base + 2);
    world.council.fireStarted(world, b);
  }
}

/** Burning buildings: fires grow or die down, char and weaken what burns, jump to neighbors, and bring it down. */
export function updateFires(world: World, dt: number, _days: number): void {
  const w = world.env.weather.state;
  const buildings = world.town.buildings;
  for (const b of buildings) {
    if (b.fire <= 0) {
      continue;
    }
    const spec = KINDS[b.kind];
    const fallen = b.phase === "ruin";
    // A fire grows on what it can burn; rain beats it down; a fallen house smoulders out.
    const grow = fallen ? -0.012 : 0.03 * spec.flammable * (1 - 0.8 * w.rain) - 0.03 * w.rain;
    b.fire = clamp01(b.fire + grow * dt - (spec.flammable < 0.25 ? 0.01 * dt : 0));
    if (fallen) {
      continue;
    }
    b.damage += (b.fire * dt) / (BURN_TIME * (0.6 + (1 - spec.flammable) * 2.2));
    b.char = Math.max(b.char, clamp01(b.damage * 1.3 + b.fire * 0.2));
    // Sparks carried downwind to the neighbors.
    if (b.fire > 0.5 && world.rng.chance(dt * 0.2)) {
      for (const o of buildings) {
        if (o === b || o.fire > 0.3 || o.phase === "ruin" || o.phase === "clearing") {
          continue;
        }
        const d =
          Math.hypot(o.rect.x - b.rect.x, o.rect.y - b.rect.y) - (o.rect.width + b.rect.width) / 4;
        if (
          d < SPREAD_REACH &&
          world.rng.chance(
            (1 - d / SPREAD_REACH) * b.fire * KINDS[o.kind].flammable * (0.15 + w.wind * 0.45),
          )
        ) {
          ignite(world, o, 0.15);
        }
      }
    }
    if (b.damage >= 1) {
      collapse(world, b);
    }
  }
}

/** A building burned or battered through falls in: a ruin to be cleared and built again. */
export function collapse(world: World, b: Building): void {
  b.phase = "ruin";
  b.damage = 1;
  b.char = 1;
  b.cleared = 0;
  b.fire = Math.min(b.fire, 0.6);
  b.lamps = 0;
  const d = world.door(b);
  world.sound("collapse", d.x, d.y, b.base + 2);
  world.council.fell(world, b);
}

/** A bucket thrown on a fire; false when there is no more fire to put out. */
export function douse(world: World, id: number, dt: number): boolean {
  const b = world.building(id);
  if (!b || b.fire <= 0) {
    return false;
  }
  b.fire = Math.max(0, b.fire - dt * DOUSE_RATE * (1.3 - KINDS[b.kind].flammable * 0.5));
  if (b.fire <= 0.02) {
    b.fire = 0;
    const d = world.door(b);
    world.sound("hiss", d.x, d.y, b.base + 1.5);
    return false;
  }
  return true;
}

/** Whether anything is burning. */
export function anyFire(world: World): boolean {
  return world.town.buildings.some((b) => b.fire > 0.02 && b.phase !== "ruin");
}
