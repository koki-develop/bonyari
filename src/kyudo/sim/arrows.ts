import { clamp } from "../../shared/core/math.ts";
import type { Rng } from "../../shared/core/random.ts";
import { AZUCHI_FOOT, groundMaterial, RANGE_PRIMS, TARGET_FACE, TARGETS } from "./dojo.ts";
import { castRay, makeHit, type Material, type Vec3 } from "./geometry.ts";
import { ARROW_LENGTH, type Impact, type Obstacle, SHAFT_RADIUS } from "./flight.ts";

/** How an arrow lies in the range. */
export type Rest =
  /** Point driven into something, the shaft standing out of it. */
  | "stuck"
  /** Fallen flat on the ground. */
  | "lying";

/** An arrow that has come to rest. */
export interface RestingArrow {
  id: number;
  rest: Rest;
  /** Stuck: the buried point. Lying: the middle of the shaft. */
  x: number;
  y: number;
  z: number;
  /** Unit direction from the nock toward the point. */
  dx: number;
  dy: number;
  dz: number;
  /** What holds it or what it lies on. */
  material: Material;
  /** The target it went through, or -1. */
  target: number;
  /** Which of a pair: the two arrows of a pair are fletched to spin opposite ways. */
  pair: 0 | 1;
  /** World seconds when it came to rest; it quivers for a moment after. */
  landedAt: number;
}

/** The sound of an arrow meeting what it hit. */
export type StrikeSound =
  | "target"
  | "rim"
  | "azuchi"
  | "sand"
  | "lawn"
  | "gravel"
  | "wood"
  | "board"
  | "cloth"
  | "hedge"
  | "nock"
  | "shaft";

/** A hole an arrow made in a target's paper, in meters from its center. */
export interface Hole {
  target: number;
  u: number;
  v: number;
}

/** What became of an arrow when it struck. */
export interface Settled {
  arrow: RestingArrow;
  sound: StrikeSound;
  /** Seconds after the strike when the arrow, knocked off, lands on the ground; -1 if it stuck. */
  drop: number;
  hole: Hole | null;
}

/** Depth (m) points sink into each material. */
const SINK: Partial<Record<Material, number>> = {
  azuchi: 0.16,
  sand: 0.2,
  lawn: 0.2,
  soil: 0.2,
  hedge: 0.35,
  wood: 0.035,
};

const HIT = makeHit();

/** Nock end of a resting arrow. */
export function nockOf(a: RestingArrow, out: Vec3): Vec3 {
  const back = a.rest === "stuck" ? ARROW_LENGTH : ARROW_LENGTH / 2;
  out.x = a.x - a.dx * back;
  out.y = a.y - a.dy * back;
  out.z = a.z - a.dz * back;
  return out;
}

/** Point end of a resting arrow. */
export function tipOf(a: RestingArrow, out: Vec3): Vec3 {
  const ahead = a.rest === "stuck" ? 0 : ARROW_LENGTH / 2;
  out.x = a.x + a.dx * ahead;
  out.y = a.y + a.dy * ahead;
  out.z = a.z + a.dz * ahead;
  return out;
}

/** The arrows standing out of the range, which a flight can strike. */
export function standingArrows(arrows: readonly RestingArrow[]): RestingArrow[] {
  return arrows.filter((a) => a.rest === "stuck");
}

/** Standing arrows as obstacles for a flight, in the same order. */
export function obstaclesOf(standing: readonly RestingArrow[]): Obstacle[] {
  return standing.map((a) => ({
    nock: nockOf(a, { x: 0, y: 0, z: 0 }),
    tip: tipOf(a, { x: 0, y: 0, z: 0 }),
  }));
}

/**
 * Where an arrow comes to rest after `impact`. `standing` are the arrows that
 * were given to the flight as obstacles, in the same order.
 */
export function settle(
  impact: Impact,
  standing: readonly RestingArrow[],
  id: number,
  pair: 0 | 1,
  landedAt: number,
  rng: Rng,
): Settled {
  const { point, dir } = impact;
  const stuck = (depth: number, material: Material, target = -1): RestingArrow => ({
    id,
    rest: "stuck",
    x: point.x + dir.x * depth,
    y: point.y + dir.y * depth,
    z: point.z + dir.z * depth,
    dx: dir.x,
    dy: dir.y,
    dz: dir.z,
    material,
    target,
    pair,
    landedAt,
  });
  if (impact.kind === "nock") {
    // The point runs into the shaft of the arrow it split.
    const other = standing[impact.obstacle];
    return {
      arrow: stuck(0.06, other.material, other.target),
      sound: "nock",
      drop: -1,
      hole: null,
    };
  }
  if (impact.kind === "shaft") {
    return fall(point, "shaft", id, pair, landedAt, rng);
  }
  const prim = impact.prim;
  if (!prim) {
    throw new Error("A surface impact without a surface");
  }
  switch (prim.material) {
    case "target": {
      const target = TARGETS.findIndex((t) => t.disc === prim);
      if (Math.hypot(impact.u, impact.v) > TARGET_FACE) {
        // Off the wooden hoop.
        return fall(point, "rim", id, pair, landedAt, rng);
      }
      // Through the paper and into the sand behind it.
      const behind = castRay(
        RANGE_PRIMS.filter((p) => p !== prim),
        point.x,
        point.y,
        point.z,
        dir.x,
        dir.y,
        dir.z,
        0,
        2,
        HIT,
      );
      const depth = (behind ? behind.t : 0.25) + (SINK.azuchi ?? 0);
      return {
        arrow: stuck(depth, "target", target),
        sound: "target",
        drop: -1,
        hole: { target, u: impact.u, v: impact.v },
      };
    }
    case "azuchi":
      return { arrow: stuck(SINK.azuchi ?? 0, "azuchi"), sound: "azuchi", drop: -1, hole: null };
    case "sand":
      return { arrow: stuck(SINK.sand ?? 0, "sand"), sound: "sand", drop: -1, hole: null };
    case "lawn":
    case "soil":
      return { arrow: stuck(SINK.lawn ?? 0, prim.material), sound: "lawn", drop: -1, hole: null };
    case "hedge":
      return { arrow: stuck(SINK.hedge ?? 0, "hedge"), sound: "hedge", drop: -1, hole: null };
    case "cloth":
      return fall(point, "cloth", id, pair, landedAt, rng);
    case "wood":
      // Soft cedar boards behind the bank take the point; posts and trim throw it off.
      return prim.name === "backBoard"
        ? { arrow: stuck(SINK.wood ?? 0, "wood"), sound: "board", drop: -1, hole: null }
        : fall(point, "wood", id, pair, landedAt, rng);
    case "gravel":
    case "floor":
    case "ceiling":
    case "roof":
      return fall(point, "gravel", id, pair, landedAt, rng);
  }
}

/** A glancing arrow drops to the ground below where it struck, and lies there. */
function fall(
  point: Vec3,
  sound: StrikeSound,
  id: number,
  pair: 0 | 1,
  landedAt: number,
  rng: Rng,
): Settled {
  const height = Math.max(0, point.y);
  const drop = Math.sqrt((2 * height) / 9.8) + 0.08;
  // It comes down just short of the bank; on the slope it slides to the foot.
  const x = point.x + rng.range(-0.18, 0.18);
  const z = clamp(point.z - rng.range(0.05, 0.45), 0, AZUCHI_FOOT - 0.12);
  const yaw = rng.range(-0.7, 0.7) + (rng.chance(0.25) ? Math.PI : 0);
  return {
    arrow: {
      id,
      rest: "lying",
      x,
      y: SHAFT_RADIUS,
      z,
      dx: Math.sin(yaw),
      dy: 0,
      dz: Math.cos(yaw),
      material: groundMaterial(x, z),
      target: -1,
      pair,
      landedAt: landedAt + drop,
    },
    sound,
    drop,
    hole: null,
  };
}
