import { KINDS } from "../sim/buildings.ts";
import {
  alongPolyline,
  inRect,
  polylineDistance,
  polylineLength,
  rectPoint,
} from "../sim/geometry.ts";
import type { World } from "../sim/world.ts";

/** A light by the way at night: a torch on a pole, or (in a town) an iron lantern. */
export interface StreetLamp {
  x: number;
  y: number;
  iron: boolean;
}

/** Meters between lamps along a street, and how far from a house a street is still lit. */
const SPACING = 15;
const NEAR_HOUSES = 14;
/** Lamps round the edge of the square, and the turns (radians) each may be moved to keep off a street. */
const SQUARE_LAMPS = 6;
const SQUARE_SHIFTS = [0, 0.12, -0.12, 0.24, -0.24, 0.36, -0.36];
/** Meters a lamp keeps clear of the edge of a trodden street. */
const STREET_CLEAR = 0.4;

/**
 * Where the lamps stand: along the streets that have been trodden, wherever
 * there are houses near to light the way home; round the square; by the
 * gates. None in a hamlet of a few cabins, lanterns of iron in a town.
 */
export function placeStreetLamps(world: World): StreetLamp[] {
  const town = world.town;
  const plan = world.plan;
  const homes = town.buildings.filter(
    (b) => b.phase === "standing" && KINDS[b.kind].housing > 0 && b.kind !== "camp",
  );
  if (homes.length < 4) {
    return [];
  }
  const iron = world.council.era >= 2;
  const out: StreetLamp[] = [];
  const graded = plan.streets.filter((s) => town.streetGrade[s.id] > 0);
  // Clear of every street that has been trodden, so no lamp stands in anyone's way.
  const offStreets = (x: number, y: number) =>
    graded.every((s) => polylineDistance(x, y, s.points).distance > s.half + STREET_CLEAR);
  const free = (x: number, y: number) =>
    !world.terrain.isWater(x, y) &&
    !town.buildings.some((b) => inRect(b.rect, x, y, 0.8)) &&
    Math.hypot(x - plan.square.x, y - plan.square.y) > plan.square.radius + 1.5 &&
    offStreets(x, y);
  for (const s of graded) {
    const len = polylineLength(s.points);
    let side = 1;
    for (let along = SPACING * 0.5; along < len; along += SPACING, side = -side) {
      const p = alongPolyline(s.points, along);
      const x = p.x - p.dy * side * (s.half + 0.9);
      const y = p.y + p.dx * side * (s.half + 0.9);
      if (!homes.some((b) => Math.hypot(b.rect.x - x, b.rect.y - y) < NEAR_HOUSES) || !free(x, y)) {
        continue;
      }
      out.push({ x, y, iron });
    }
  }
  if (town.squareGrade > 0) {
    // Round the square's edge, each moved along it off the mouths of the streets, or left out.
    const sq = plan.square;
    const r = sq.radius + 0.6;
    for (let k = 0; k < SQUARE_LAMPS; k++) {
      const a0 = (k / SQUARE_LAMPS) * Math.PI * 2 + 0.45;
      for (const shift of SQUARE_SHIFTS) {
        const x = sq.x + Math.cos(a0 + shift) * r;
        const y = sq.y + Math.sin(a0 + shift) * r;
        if (offStreets(x, y)) {
          out.push({ x, y, iron });
          break;
        }
      }
    }
  }
  for (const b of town.buildings) {
    if ((b.kind === "woodgate" || b.kind === "gatehouse") && b.phase === "standing") {
      for (const side of [-1, 1]) {
        const p = rectPoint(b.rect, side * (b.rect.width / 2 + 0.7), -b.rect.depth / 2 - 0.6);
        if (offStreets(p.x, p.y)) {
          out.push({ x: p.x, y: p.y, iron: b.kind === "gatehouse" });
        }
      }
    }
  }
  return out;
}

/** How brightly the lamps burn: lit at dusk, put out at dawn. */
export function lampsLit(darkness: number): number {
  return Math.min(1, Math.max(0, (darkness - 0.15) / 0.35));
}
