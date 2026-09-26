import { clamp01, smoothstep } from "../../shared/core/math.ts";
import { hash3 } from "../../shared/core/random.ts";
import { inRect } from "./geometry.ts";
import type { Plan } from "./plan.ts";
import { fbm2, type Point, type Terrain, WORLD } from "./terrain.ts";

export type TreeKind = "oak" | "birch" | "spruce" | "pine" | "willow";

export interface Tree {
  id: number;
  kind: TreeKind;
  x: number;
  y: number;
  /** Ground height (m) at the foot of the trunk. */
  z: number;
  /** Height (m) to the top of the crown. */
  height: number;
  /** Radius (m) of the crown. */
  radius: number;
  seed: number;
}

/** What is left of a tree: standing, a stump where it was felled, or nothing. */
export const STANDING = 2;
export const STUMP = 1;
export const GONE = 0;

/** Meters between the cells trees are scattered over, one tree per cell at most. */
const SPACING = 4.2;
/** Side (m) of the buckets trees are indexed by. */
const BUCKET = 12;
/** Fields (nearest first) lying on open ground before anyone comes. */
const OPEN_FIELDS = 2;
/** Rough radius (m) of the clearing the settlers find; the woods close round beyond it. */
const MEADOW = 32;

/**
 * The woods that cover the valley before anyone comes: broadleaves in the
 * lowland, spruce and pine up in the hills, willows along the river. There
 * is an open meadow by the river where the settlers will stop, and the old
 * trade road runs through the trees. The trees stand where the seed puts
 * them; what the settlers have felled is kept as their state.
 */
export class Forest {
  readonly trees: Tree[] = [];
  /** STANDING, STUMP or GONE for each tree. */
  readonly state: Uint8Array;
  private readonly buckets: number[][];
  private readonly bucketsW: number;
  private readonly bucketsH: number;
  private readonly terrain: Terrain;
  private readonly plan: Plan;
  /** Counts that change whenever a tree is felled or a stump is cleared. */
  version = 0;

  constructor(seed: number, terrain: Terrain, plan: Plan) {
    this.terrain = terrain;
    this.plan = plan;
    this.bucketsW = Math.ceil((WORLD.x1 - WORLD.x0) / BUCKET);
    this.bucketsH = Math.ceil((WORLD.y1 - WORLD.y0) / BUCKET);
    this.buckets = Array.from({ length: this.bucketsW * this.bucketsH }, () => []);
    const cols = Math.floor((WORLD.x1 - WORLD.x0) / SPACING);
    const rows = Math.floor((WORLD.y1 - WORLD.y0) / SPACING);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = WORLD.x0 + (i + 0.15 + 0.7 * hash3(i, j, seed ^ 0x71)) * SPACING;
        const y = WORLD.y0 + (j + 0.15 + 0.7 * hash3(i, j, seed ^ 0x72)) * SPACING;
        const density = this.density(x, y);
        if (hash3(i, j, seed ^ 0x73) >= density) {
          continue;
        }
        const tree = this.grow(
          x,
          y,
          hash3(i, j, seed ^ 0x74),
          (seed ^ (i * 7919 + j * 104729)) >>> 0,
        );
        tree.id = this.trees.length;
        this.trees.push(tree);
        this.buckets[this.bucketOf(x, y)].push(tree.id);
      }
    }
    this.state = new Uint8Array(this.trees.length).fill(STANDING);
  }

  /**
   * How thickly trees grow at (x, y) before anyone clears them: 0 on the
   * water, the old road and the meadow the settlers find, thinning toward
   * the river's banks.
   */
  density(x: number, y: number): number {
    const t = this.terrain;
    const plan = this.plan;
    const off = Math.abs(t.riverOffset(x, y)) - t.riverHalfWidth(y);
    if (off < 1.2) {
      return 0;
    }
    // The meadow: an open, uneven clearing about the site by the river, running along the bank.
    const c = plan.center;
    const ragged = 16 * (fbm2(x / 18, y / 18, t.seed + 5, 3) - 0.5);
    const along = Math.max(0, 1 - Math.abs(t.riverOffset(x, y)) / 40) * 10;
    const meadow = Math.hypot((x - c.x) * 0.85, (y - c.y) * 1.05) - (MEADOW + ragged + along);
    if (meadow < 0) {
      return 0;
    }
    // The open ground the settlers chose the place for: where their first fields will be.
    for (let k = 0; k < OPEN_FIELDS && k < plan.fields.length; k++) {
      if (inRect(plan.fields[k].rect, x, y, 2)) {
        return 0;
      }
    }
    for (const s of plan.streets) {
      if (s.old && nearPolyline(x, y, s.points, s.half + 1.6)) {
        return 0;
      }
    }
    // Grassland where the flock will graze, with a lone tree or two for shade.
    for (const q of plan.pastures) {
      if (inRect(q.rect, x, y, 3)) {
        return 0.03;
      }
    }
    // Glades here and there in the woods.
    const glade = smoothstep(0.62, 0.72, fbm2(x / 40, y / 40, t.seed + 41, 3));
    const edge = smoothstep(0, 14, meadow);
    const bank = smoothstep(1.2, 6, off) * 0.55 + 0.25;
    const hills = t.hills(y);
    return clamp01(Math.min(bank + 0.3, 0.86 + 0.1 * hills) * edge * (1 - glade * 0.85));
  }

  /**
   * Whether no trees grow at (x, y) before anyone clears them: the same as
   * `density(x, y) === 0`, without working out how thickly they grow elsewhere.
   */
  cleared(x: number, y: number): boolean {
    const t = this.terrain;
    const plan = this.plan;
    const river = t.riverOffset(x, y);
    if (Math.abs(river) - t.riverHalfWidth(y) < 1.2) {
      return true;
    }
    const c = plan.center;
    const along = Math.max(0, 1 - Math.abs(river) / 40) * 10;
    const ex = (x - c.x) * 0.85;
    const ey = (y - c.y) * 1.05;
    const round = Math.sqrt(ex * ex + ey * ey);
    // The ragged edge moves the meadow's rim by less than 8 m either way.
    if (round < MEADOW + 8 + along) {
      const ragged = 16 * (fbm2(x / 18, y / 18, t.seed + 5, 3) - 0.5);
      if (round < MEADOW + ragged + along) {
        return true;
      }
    }
    for (let k = 0; k < OPEN_FIELDS && k < plan.fields.length; k++) {
      if (inRect(plan.fields[k].rect, x, y, 2)) {
        return true;
      }
    }
    for (const s of plan.streets) {
      if (s.old && nearPolyline(x, y, s.points, s.half + 1.6)) {
        return true;
      }
    }
    return false;
  }

  /** A tree fitting where it grows. */
  private grow(x: number, y: number, pick: number, seed: number): Tree {
    const t = this.terrain;
    const hills = t.hills(y);
    const off = Math.abs(t.riverOffset(x, y)) - t.riverHalfWidth(y);
    const k = (seed % 997) / 997;
    let kind: TreeKind;
    if (off < 7 && pick < 0.7) {
      kind = "willow";
    } else if (pick < 0.15 + hills * 0.7) {
      kind = pick < 0.08 + hills * 0.3 ? "pine" : "spruce";
    } else {
      kind = pick < 0.75 ? "oak" : "birch";
    }
    const size = 0.75 + 0.5 * k;
    const shape: Record<TreeKind, readonly [number, number]> = {
      oak: [9.5, 3.4],
      birch: [10, 2.3],
      spruce: [12.5, 2.4],
      pine: [13, 2.6],
      willow: [7.5, 3.3],
    };
    const [height, radius] = shape[kind];
    return {
      id: 0,
      kind,
      x,
      y,
      z: t.height(x, y),
      height: height * size,
      radius: radius * (0.8 + 0.4 * size),
      seed,
    };
  }

  private bucketOf(x: number, y: number): number {
    const i = Math.min(this.bucketsW - 1, Math.max(0, Math.floor((x - WORLD.x0) / BUCKET)));
    const j = Math.min(this.bucketsH - 1, Math.max(0, Math.floor((y - WORLD.y0) / BUCKET)));
    return j * this.bucketsW + i;
  }

  /** Calls `visit` with every tree whose trunk is within `reach` of (x, y). */
  near(x: number, y: number, reach: number, visit: (tree: Tree) => void): void {
    const i0 = Math.max(0, Math.floor((x - reach - WORLD.x0) / BUCKET));
    const i1 = Math.min(this.bucketsW - 1, Math.floor((x + reach - WORLD.x0) / BUCKET));
    const j0 = Math.max(0, Math.floor((y - reach - WORLD.y0) / BUCKET));
    const j1 = Math.min(this.bucketsH - 1, Math.floor((y + reach - WORLD.y0) / BUCKET));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const id of this.buckets[j * this.bucketsW + i]) {
          const tree = this.trees[id];
          if (Math.hypot(tree.x - x, tree.y - y) <= reach) {
            visit(tree);
          }
        }
      }
    }
  }

  /** Trees in the box [x0, x1] × [y0, y1], each once. */
  inBox(x0: number, y0: number, x1: number, y1: number, visit: (tree: Tree) => void): void {
    const i0 = Math.max(0, Math.floor((x0 - WORLD.x0) / BUCKET));
    const i1 = Math.min(this.bucketsW - 1, Math.floor((x1 - WORLD.x0) / BUCKET));
    const j0 = Math.max(0, Math.floor((y0 - WORLD.y0) / BUCKET));
    const j1 = Math.min(this.bucketsH - 1, Math.floor((y1 - WORLD.y0) / BUCKET));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const id of this.buckets[j * this.bucketsW + i]) {
          const tree = this.trees[id];
          if (tree.x >= x0 && tree.x <= x1 && tree.y >= y0 && tree.y <= y1) {
            visit(tree);
          }
        }
      }
    }
  }

  fell(id: number): void {
    if (this.state[id] === STANDING) {
      this.state[id] = STUMP;
      this.version++;
    }
  }

  clearStump(id: number): void {
    if (this.state[id] !== GONE) {
      this.state[id] = GONE;
      this.version++;
    }
  }
}

/** Whether (x, y) lies closer than `reach` to the polyline. */
function nearPolyline(x: number, y: number, points: readonly Point[], reach: number): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    const ax = points[i].x;
    const ay = points[i].y;
    const dx = points[i + 1].x - ax;
    const dy = points[i + 1].y - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const ex = x - (ax + dx * u);
    const ey = y - (ay + dy * u);
    if (ex * ex + ey * ey < reach * reach) {
      return true;
    }
  }
  return false;
}
