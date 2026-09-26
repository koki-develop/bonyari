import type { Rng } from "../../shared/core/random.ts";
import {
  type BuildingKind,
  KINDS,
  type RoofStuff,
  type Site,
  type Style,
  type Trim,
  type WallStuff,
} from "./buildings.ts";
import { type Rect, rectPoint } from "./geometry.ts";
import type { Plan } from "./plan.ts";
import type { Point, Terrain } from "./terrain.ts";

/** Room (m) a gatehouse or tower takes out of the wall either side of its point. */
export const GATE_ROOM = 6;
export const WOODGATE_ROOM = 4.2;
export const TOWER_ROOM = 3;

/** Angle (as `Rect.angle`) of a rect whose front faces along (fx, fy). */
function angleFacing(fx: number, fy: number): number {
  return Math.atan2(fx, -fy);
}

/** Direction pointing out of the wall ring across the stretch from point i to i + 1. */
function outward(plan: Plan, i: number): Point {
  const pts = plan.wall.points;
  const a = pts[i];
  const b = pts[(i + 1) % pts.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // The ring runs counterclockwise, so outward is the edge turned clockwise.
  return { x: (b.y - a.y) / len, y: -(b.x - a.x) / len };
}

/** Whether wall point i carries a gate. */
function gateAt(plan: Plan, i: number): boolean {
  return plan.wall.gates.some((g) => g.index === i);
}

/**
 * Where a building of `kind` stands on `site`: its footprint rect, and the
 * height of the ground under it. On a lot it stands at the front, facing the
 * street; on the wall ring it follows the ring; over the ford it spans the river.
 */
export function placeOnSite(
  plan: Plan,
  terrain: Terrain,
  kind: BuildingKind,
  site: Site,
): { rect: Rect; base: number } {
  const spec = KINDS[kind];
  switch (site.type) {
    case "lot": {
      const lot = plan.lots[site.lot];
      const lr = lot.rect;
      const width = Math.min(spec.width, lr.width - 0.4);
      const depth = Math.min(spec.depth, lr.depth - 0.4);
      const setback = lot.zone === "outer" ? Math.min(2.5, (lr.depth - depth) / 2) : 0.5;
      const middle = rectPoint(lr, 0, -lr.depth / 2 + setback + depth / 2);
      // A post mill turns its body, sails and all, into the wind off the hills.
      const angle = kind === "windmill" ? 0.3 : lr.angle;
      const rect = { x: middle.x, y: middle.y, angle, width, depth };
      return { rect, base: groundUnder(terrain, rect) };
    }
    case "square": {
      const c = plan.square;
      const rect = {
        x: c.x - c.radius * 0.45,
        y: c.y + c.radius * 0.35,
        angle: 0,
        width: spec.width,
        depth: spec.depth,
      };
      return { rect, base: groundUnder(terrain, rect) };
    }
    case "wall": {
      const pts = plan.wall.points;
      const i = site.index;
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      // Leave room at either end for a gate, and for a tower along a stone wall.
      const stone = kind === "wall";
      const room = (k: number) =>
        gateAt(plan, k)
          ? stone
            ? GATE_ROOM
            : WOODGATE_ROOM
          : stone && plan.wall.towers.includes(k)
            ? TOWER_ROOM
            : 0;
      const start = room(i);
      const end = len - room((i + 1) % pts.length);
      const mid = (start + end) / 2;
      const n = outward(plan, i);
      const rect = {
        x: a.x + ux * mid,
        y: a.y + uy * mid,
        angle: angleFacing(n.x, n.y),
        width: Math.max(0.5, end - start),
        depth: spec.depth,
      };
      return { rect, base: groundUnder(terrain, rect) };
    }
    case "tower": {
      const p = plan.wall.points[site.index];
      const n = outward(plan, site.index);
      const rect = {
        x: p.x,
        y: p.y,
        angle: angleFacing(n.x, n.y),
        width: spec.width,
        depth: spec.depth,
      };
      return { rect, base: groundUnder(terrain, rect) };
    }
    case "gate": {
      const gate = plan.wall.gates[site.gate];
      const n = outward(plan, gate.index);
      const rect = {
        x: gate.point.x,
        y: gate.point.y,
        angle: angleFacing(n.x, n.y),
        width: spec.width,
        depth: spec.depth,
      };
      return { rect, base: groundUnder(terrain, rect) };
    }
    case "ford": {
      const c = plan.crossing;
      const length = Math.hypot(c.to.x - c.from.x, c.to.y - c.from.y);
      const rect = {
        x: (c.from.x + c.to.x) / 2,
        y: (c.from.y + c.to.y) / 2,
        angle: c.angle,
        width: kind === "stonebridge" ? 4.4 : 3.8,
        depth: length + 1,
      };
      const base = Math.max(terrain.height(c.from.x, c.from.y), terrain.height(c.to.x, c.to.y));
      return { rect, base };
    }
  }
}

/** Height of the ground under a footprint: its lowest corner, so nothing floats. */
function groundUnder(terrain: Terrain, rect: Rect): number {
  let lo = terrain.height(rect.x, rect.y);
  for (const [a, b] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ]) {
    const p = rectPoint(rect, a * rect.width, b * rect.depth);
    lo = Math.min(lo, terrain.height(p.x, p.y));
  }
  return lo;
}

/**
 * How a new building looks: what its walls and roof are made of, by its kind
 * and by how far the settlement has come (0 the first hamlet .. 2 a town).
 */
export function chooseStyle(kind: BuildingKind, era: number, r: Rng): Style {
  const trim = r.pick<Trim>(["green", "green", "brown", "blue", "red"]);
  const plaster = r.pick<WallStuff>(["plaster", "plaster", "plasterWarm", "plasterPink"]);
  const roofByEra: RoofStuff =
    era < 1
      ? "thatch"
      : era < 2
        ? r.pick<RoofStuff>(["thatch", "shingle"])
        : r.pick<RoofStuff>(["shingle", "tile", "tile"]);
  switch (kind) {
    case "camp":
      return { wall: "plank", roof: "thatch", trim };
    case "cabin":
      return { wall: "log", roof: r.chance(0.5) ? "bark" : "thatch", trim };
    case "house":
    case "workshop":
    case "bakery":
    case "watermill":
      return { wall: plaster, roof: roofByEra, trim };
    case "farmhouse":
    case "barn":
      return { wall: plaster, roof: "thatch", trim };
    case "townhouse":
      return { wall: plaster, roof: r.pick<RoofStuff>(["shingle", "tile", "tile"]), trim };
    case "stonehouse":
      return { wall: plaster, roof: r.pick<RoofStuff>(["tile", "tile", "slate"]), trim };
    case "smithy":
      return { wall: "stone", roof: "shingle", trim };
    case "tavern":
      return { wall: "plasterWarm", roof: "tile", trim: "green" };
    case "chapel":
    case "windmill":
    case "lumberyard":
    case "quarry":
    case "watchtower":
      return { wall: "plank", roof: "shingle", trim };
    case "church":
    case "wizard":
      return { wall: "stone", roof: "slate", trim: "brown" };
    case "townhall":
      return { wall: "plaster", roof: "slate", trim: "blue" };
    case "tower":
      return { wall: "stone", roof: "tile", trim };
    default:
      return { wall: "stone", roof: "shingle", trim };
  }
}
