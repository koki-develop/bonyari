import { rectCorners } from "./geometry.ts";
import type { Pasture, Plan } from "./plan.ts";
import type { Point } from "./terrain.ts";
import type { World } from "./world.ts";

/** Seconds of work (before `TOIL`) that fence a pasture all round. */
export const FENCE_WORK = 70;
/** Width (m) of the gap left for the gate. */
const GATE = 3;

/**
 * The run of a pasture's fence: from one side of its gate, round the
 * pasture, to the other side. The gate faces the street it opens onto.
 */
export interface FenceRun {
  points: Point[];
  /** Meters from the start to each point. */
  at: number[];
  length: number;
  /** The two posts either side of the gate. */
  gate: [Point, Point];
}

export function fenceRun(plan: Plan, q: Pasture): FenceRun {
  const corners = rectCorners(q.rect);
  const node = plan.nodes[q.node];
  // The gate goes on the edge nearest the street, where the street comes closest.
  let best = { edge: 0, t: 0.5, d: Infinity };
  for (let e = 0; e < 4; e++) {
    const a = corners[e];
    const b = corners[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = Math.max(
      0,
      Math.min(1, ((node.x - a.x) * (b.x - a.x) + (node.y - a.y) * (b.y - a.y)) / (len * len)),
    );
    const d = Math.hypot(a.x + (b.x - a.x) * t - node.x, a.y + (b.y - a.y) * t - node.y);
    if (d < best.d) {
      // Kept clear of the corners.
      const room = (GATE / 2 + 1) / len;
      best = { edge: e, t: Math.max(room, Math.min(1 - room, t)), d };
    }
  }
  const a = corners[best.edge];
  const b = corners[(best.edge + 1) % 4];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const mid = { x: a.x + (b.x - a.x) * best.t, y: a.y + (b.y - a.y) * best.t };
  const start = { x: mid.x + ux * (GATE / 2), y: mid.y + uy * (GATE / 2) };
  const end = { x: mid.x - ux * (GATE / 2), y: mid.y - uy * (GATE / 2) };
  const points = [start];
  for (let k = 1; k <= 4; k++) {
    points.push(corners[(best.edge + k) % 4]);
  }
  points.push(end);
  const at = [0];
  for (let k = 1; k < points.length; k++) {
    at.push(at[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y));
  }
  return { points, at, length: at[at.length - 1], gate: [end, start] };
}

/** The point `s` meters along a fence run. */
export function alongFence(run: FenceRun, s: number): Point {
  const d = Math.max(0, Math.min(run.length, s));
  let k = 1;
  while (k < run.points.length - 1 && run.at[k] < d) {
    k++;
  }
  const a = run.points[k - 1];
  const b = run.points[k];
  const t = (d - run.at[k - 1]) / Math.max(1e-9, run.at[k] - run.at[k - 1]);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** How much of a pasture's fence stands, 0 to 1. */
export function fenceBuilt(world: World, pasture: number): number {
  if (world.town.pastures[pasture].fenced) {
    return 1;
  }
  return world.council.pastureToFence(world) === pasture
    ? Math.min(1, world.council.fencing / FENCE_WORK)
    : 0;
}
