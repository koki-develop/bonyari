import { castRay, type Hit, makeHit, type Prim, segmentDistance, type Vec3 } from "./geometry.ts";

/** Speed (m/s) an arrow leaves the bow at: a bow of about 15 kg. */
export const ARROW_SPEED = 52;
/** Air drag as a linear rate (1/s): the arrow reaches the target at about 42 m/s. */
export const DRAG = 0.35;
export const GRAVITY = 9.8;
/** Full length of an arrow (m), nock to point. */
export const ARROW_LENGTH = 1.0;
/** Radius (m) of the shaft. */
export const SHAFT_RADIUS = 0.0045;
/** Longest flight (s) followed; anything still flying by then has left the range. */
const MAX_FLIGHT = 2;
/** Integration step (s) of the collision search: about 10 cm of flight. */
const STEP = 0.002;
/** Radius (m) of the nock end, which a following arrow can split. */
const NOCK_RADIUS = 0.006;

/** A released arrow: where its point starts and its velocity. */
export interface Launch {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Position of the arrow's point `t` seconds after release. */
export function positionAt(l: Launch, t: number, out: Vec3): Vec3 {
  const e = (1 - Math.exp(-DRAG * t)) / DRAG;
  const gk = GRAVITY / DRAG;
  out.x = l.x + l.vx * e;
  out.y = l.y + (l.vy + gk) * e - gk * t;
  out.z = l.z + l.vz * e;
  return out;
}

/** Velocity of the arrow `t` seconds after release. */
export function velocityAt(l: Launch, t: number, out: Vec3): Vec3 {
  const k = Math.exp(-DRAG * t);
  const gk = GRAVITY / DRAG;
  out.x = l.vx * k;
  out.y = (l.vy + gk) * k - gk;
  out.z = l.vz * k;
  return out;
}

/** Time (s) at which the arrow crosses depth `z`, or Infinity if drag stops it short. */
export function timeAtDepth(l: Launch, z: number): number {
  const q = 1 - (DRAG * (z - l.z)) / l.vz;
  return q > 0 ? -Math.log(q) / DRAG : Infinity;
}

/**
 * The launch from `from` at `ARROW_SPEED` whose path passes through `aim`:
 * the archer holds high enough that the drop over the distance is made good.
 */
export function solveLaunch(from: Vec3, aim: Vec3): Launch {
  // Point at a corrected mark until the path meets the aim.
  let mx = aim.x;
  let my = aim.y;
  const launch: Launch = { x: from.x, y: from.y, z: from.z, vx: 0, vy: 0, vz: 0 };
  const p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 12; i++) {
    const dx = mx - from.x;
    const dy = my - from.y;
    const dz = aim.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    launch.vx = (dx / len) * ARROW_SPEED;
    launch.vy = (dy / len) * ARROW_SPEED;
    launch.vz = (dz / len) * ARROW_SPEED;
    positionAt(launch, timeAtDepth(launch, aim.z), p);
    const ex = aim.x - p.x;
    const ey = aim.y - p.y;
    if (Math.abs(ex) < 1e-6 && Math.abs(ey) < 1e-6) {
      break;
    }
    mx += ex;
    my += ey;
  }
  return launch;
}

/** An arrow already standing in the range that a new one might strike. */
export interface Obstacle {
  /** Nock end and point of the shaft. */
  nock: Vec3;
  tip: Vec3;
}

export type ImpactKind =
  /** Into a surface. */
  | "surface"
  /** Onto the nock of an arrow already there, splitting it (tsugi-ya). */
  | "nock"
  /** Against the side of an arrow already there, and off it. */
  | "shaft";

export interface Impact {
  kind: ImpactKind;
  /** Seconds after release. */
  time: number;
  /** Where the point struck. */
  point: Vec3;
  /** Unit direction of flight at the strike, and the speed. */
  dir: Vec3;
  speed: number;
  /** The surface struck (for "surface"), with its local coordinates. */
  prim: Prim | null;
  u: number;
  v: number;
  /** The arrow struck (for "nock" and "shaft"). */
  obstacle: number;
}

/**
 * Follows the arrow until it strikes a part of the range or an arrow standing
 * in it; null if it leaves the range.
 */
export function traceFlight(
  launch: Launch,
  prims: readonly Prim[],
  obstacles: readonly Obstacle[],
): Impact | null {
  const hit: Hit = makeHit();
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  positionAt(launch, 0, a);
  for (let t = 0; t < MAX_FLIGHT; t += STEP) {
    positionAt(launch, t + STEP, b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    let best = Infinity;
    let impact: Impact | null = null;
    if (castRay(prims, a.x, a.y, a.z, dx, dy, dz, 0, 1, hit) && hit.t < best) {
      best = hit.t;
      impact = makeImpact(launch, t + STEP * hit.t, "surface", hit.prim, hit.u, hit.v, -1);
    }
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      // Only arrows level with this step can be reached.
      if (Math.max(o.nock.z, o.tip.z) < Math.min(a.z, b.z) - 0.05) {
        continue;
      }
      if (Math.min(o.nock.z, o.tip.z) > Math.max(a.z, b.z) + 0.05) {
        continue;
      }
      const contact = strikeArrow(a, b, o);
      if (contact && contact.at < best) {
        best = contact.at;
        impact = makeImpact(launch, t + STEP * contact.at, contact.kind, null, 0, 0, i);
      }
    }
    if (impact) {
      return impact;
    }
    a.x = b.x;
    a.y = b.y;
    a.z = b.z;
  }
  return null;
}

/**
 * Where along the step a → b the flying point meets a standing arrow: through
 * the end of its nock (splitting it), or against the side of its shaft.
 */
function strikeArrow(a: Vec3, b: Vec3, o: Obstacle): { at: number; kind: "nock" | "shaft" } | null {
  const ex = (o.tip.x - o.nock.x) / ARROW_LENGTH;
  const ey = (o.tip.y - o.nock.y) / ARROW_LENGTH;
  const ez = (o.tip.z - o.nock.z) / ARROW_LENGTH;
  // Crossing the plane of the nock's end, within the nock.
  const sa = (a.x - o.nock.x) * ex + (a.y - o.nock.y) * ey + (a.z - o.nock.z) * ez;
  const sb = (b.x - o.nock.x) * ex + (b.y - o.nock.y) * ey + (b.z - o.nock.z) * ez;
  let nock: number | null = null;
  if (sa < 0 && sb >= 0) {
    const f = -sa / (sb - sa);
    const px = a.x + (b.x - a.x) * f - o.nock.x;
    const py = a.y + (b.y - a.y) * f - o.nock.y;
    const pz = a.z + (b.z - a.z) * f - o.nock.z;
    if (Math.hypot(px, py, pz) < NOCK_RADIUS) {
      nock = f;
    }
  }
  // Touching the side of the shaft beyond the nock.
  const start = {
    x: o.nock.x + ex * NOCK_RADIUS,
    y: o.nock.y + ey * NOCK_RADIUS,
    z: o.nock.z + ez * NOCK_RADIUS,
  };
  const d = segmentDistance(a, b, start, o.tip);
  const side = d.distance < 2 * SHAFT_RADIUS ? d.s : null;
  if (nock !== null && (side === null || nock <= side)) {
    return { at: nock, kind: "nock" };
  }
  return side === null ? null : { at: side, kind: "shaft" };
}

function makeImpact(
  launch: Launch,
  time: number,
  kind: ImpactKind,
  prim: Prim | null,
  u: number,
  v: number,
  obstacle: number,
): Impact {
  const point = positionAt(launch, time, { x: 0, y: 0, z: 0 });
  const vel = velocityAt(launch, time, { x: 0, y: 0, z: 0 });
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  return {
    kind,
    time,
    point,
    dir: { x: vel.x / speed, y: vel.y / speed, z: vel.z / speed },
    speed,
    prim,
    u,
    v,
    obstacle,
  };
}
