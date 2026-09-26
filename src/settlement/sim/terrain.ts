import { clamp, lerp, smoothstep } from "../../shared/core/math.ts";
import { noise2, Rng } from "../../shared/core/random.ts";

/**
 * World coordinates are meters: x to the right of the view, y away from the
 * viewer, z up. The ground is known over this rectangle; the view never
 * shows past it.
 */
export const WORLD = { x0: -130, x1: 140, y0: -70, y1: 250 } as const;
/** Meters between the samples of the height grid. */
export const GRID = 1;
/** Samples of the height grid along x and y. */
export const GRID_W = (WORLD.x1 - WORLD.x0) / GRID + 1;
export const GRID_H = (WORLD.y1 - WORLD.y0) / GRID + 1;
/** Meters between the rows the river is worked out at, and the rows' span (a margin past the world). */
const ROW = 0.25;
const ROW_FROM = WORLD.y0 - 20;
const ROWS = Math.ceil((WORLD.y1 + 20 - ROW_FROM) / ROW) + 1;
/** Depth (m) of the river's water over its bed, and how far its surface lies under the banks. */
const RIVER_DEPTH = 1.1;
const RIVER_SINK = 0.55;
/** Radius (m) of the level ground the town is built on, and the width of its edge. */
const SITE_RADIUS = 92;
const SITE_EDGE = 40;
/** Where the far hills begin to rise (y, m) and their greatest height (m). */
const HILLS_FROM = 155;
const HILLS_HEIGHT = 46;

export interface Point {
  x: number;
  y: number;
}

/** 2D fractal value noise in [0, 1]. */
export function fbm2(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * f, y * f, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return sum / norm;
}

/**
 * The land: gentle rolling ground rising away from the viewer into wooded
 * hills, a river running down it toward the viewer, a knoll off to the side,
 * and a stretch of level ground by the river where the town will stand.
 * Everything is a function of the seed; the heights are sampled once into a
 * grid that every other part reads.
 */
export class Terrain {
  readonly seed: number;
  /** Middle of the town site: the market square will be here. */
  readonly center: Point;
  /** Top of the knoll the windmill and the wizard's tower stand on. */
  readonly knoll: Point;
  private readonly riverBase: number;
  private readonly meander: readonly [number, number, number, number];
  private readonly siteHeight: number;
  private readonly heights: Float32Array;
  private readonly knollHeight: number;
  /** The river along y, row by row (see `ROW`): its middle, how it bends, its half width, its surface. */
  private readonly rowX = new Float64Array(ROWS);
  private readonly rowSlope = new Float64Array(ROWS);
  private readonly rowHalf = new Float64Array(ROWS);
  private readonly rowWater = new Float64Array(ROWS);
  /** Lowest and highest the river's surface lies anywhere along it (m). */
  readonly waterLow: number;
  readonly waterHigh: number;

  constructor(seed: number) {
    this.seed = seed;
    const r = new Rng(seed ^ 0x7e22a1);
    this.riverBase = r.range(-52, -38);
    this.meander = [r.range(0, 6.28), r.range(0, 6.28), r.range(7, 11), r.range(2.5, 4)];
    for (let k = 0; k < ROWS; k++) {
      const y = ROW_FROM + k * ROW;
      this.rowX[k] = this.bend(y);
      this.rowSlope[k] = this.bendSlope(y);
      this.rowHalf[k] = this.halfWidth(y);
    }
    const cy = r.range(66, 78);
    this.center = { x: this.riverX(cy) + r.range(52, 58), y: cy };
    const side = r.chance(0.5) ? 1 : -1;
    this.knoll = {
      x: this.center.x + r.range(78, 92),
      y: this.center.y + side * r.range(10, 30) + 18,
    };
    this.knollHeight = r.range(6.5, 8.5);
    this.siteHeight = this.natural(this.center.x, this.center.y);
    let low = Infinity;
    let high = -Infinity;
    for (let k = 0; k < ROWS; k++) {
      const y = ROW_FROM + k * ROW;
      const z = this.banks(this.rowX[k], y) - RIVER_SINK;
      this.rowWater[k] = z;
      low = Math.min(low, z);
      high = Math.max(high, z);
    }
    this.waterLow = low;
    this.waterHigh = high;
    this.heights = new Float32Array(GRID_W * GRID_H);
    for (let j = 0; j < GRID_H; j++) {
      const y = WORLD.y0 + j * GRID;
      for (let i = 0; i < GRID_W; i++) {
        this.heights[j * GRID_W + i] = this.shape(WORLD.x0 + i * GRID, y);
      }
    }
  }

  /** x (m) of the middle of the river where it crosses `y`. */
  riverX(y: number): number {
    return this.row(this.rowX, y);
  }

  /** How far x the river's middle moves per meter of y. */
  riverSlope(y: number): number {
    return this.row(this.rowSlope, y);
  }

  /** Half the width (m) of the water where the river crosses `y`. */
  riverHalfWidth(y: number): number {
    return this.row(this.rowHalf, y);
  }

  /** A value of the river looked up in its row table, between rows by a straight line. */
  private row(table: Float64Array, y: number): number {
    const f = clamp((y - ROW_FROM) / ROW, 0, ROWS - 1.001);
    const k = Math.floor(f);
    return table[k] + (table[k + 1] - table[k]) * (f - k);
  }

  private bend(y: number): number {
    const [p1, p2, a1, a2] = this.meander;
    return this.riverBase + a1 * Math.sin(y / 64 + p1) + a2 * Math.sin(y / 27 + p2);
  }

  private bendSlope(y: number): number {
    const [p1, p2, a1, a2] = this.meander;
    return (a1 / 64) * Math.cos(y / 64 + p1) + (a2 / 27) * Math.cos(y / 27 + p2);
  }

  private halfWidth(y: number): number {
    // Narrower up in the hills it comes down from.
    return 4.6 + 0.9 * Math.sin(y / 23 + this.meander[1] * 2) - 1.4 * smoothstep(110, 230, y);
  }

  /** Distance (m) across the river from its middle, negative on its left bank. */
  riverOffset(x: number, y: number): number {
    const k = this.riverSlope(y);
    return (x - this.riverX(y)) / Math.sqrt(1 + k * k);
  }

  /** Height (m) of the river's surface where it crosses `y`. */
  waterLevel(y: number): number {
    return this.row(this.rowWater, y);
  }

  /**
   * The point `out` meters from the water's edge on one side of the river
   * (`side` 1 the right bank, -1 the left) where it crosses `y`.
   */
  bankPoint(y: number, side: 1 | -1, out: number): Point {
    const k = this.riverSlope(y);
    return { x: this.riverX(y) + side * (this.riverHalfWidth(y) + out) * Math.sqrt(1 + k * k), y };
  }

  /** Whether (x, y) is under the river's water. */
  isWater(x: number, y: number): boolean {
    return Math.abs(this.riverOffset(x, y)) < this.riverHalfWidth(y);
  }

  /** Ground height (m) at (x, y), from the grid; the river's bed under its water. */
  height(x: number, y: number): number {
    const gx = clamp((x - WORLD.x0) / GRID, 0, GRID_W - 1.001);
    const gy = clamp((y - WORLD.y0) / GRID, 0, GRID_H - 1.001);
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const h = this.heights;
    const k = j * GRID_W + i;
    const top = h[k] + (h[k + 1] - h[k]) * fx;
    const bottom = h[k + GRID_W] + (h[k + GRID_W + 1] - h[k + GRID_W]) * fx;
    return top + (bottom - top) * fy;
  }

  /** Height (m) of the grid sample (i, j). */
  sample(i: number, j: number): number {
    return this.heights[clamp(j, 0, GRID_H - 1) * GRID_W + clamp(i, 0, GRID_W - 1)];
  }

  /** Steepness at (x, y): rise per meter across the steepest way. */
  slope(x: number, y: number): number {
    const dx = this.height(x + 0.5, y) - this.height(x - 0.5, y);
    const dy = this.height(x, y + 0.5) - this.height(x, y - 0.5);
    return Math.hypot(dx, dy);
  }

  /** How level-built the town site is at (x, y): 1 in it, 0 well outside it. */
  siteWeight(x: number, y: number): number {
    const d = Math.hypot((x - this.center.x) * 0.92, y - this.center.y);
    return 1 - smoothstep(SITE_RADIUS - SITE_EDGE, SITE_RADIUS, d);
  }

  /** How high the far hills have risen at y (0 below them, 1 on their crest). */
  hills(y: number): number {
    return smoothstep(HILLS_FROM, WORLD.y1 - 20, y);
  }

  /** The ground as it lay before the river cut its channel. */
  private banks(x: number, y: number): number {
    const natural = this.natural(x, y);
    const w = this.siteWeight(x, y);
    // The town site is gently leveled, still sloping a little down to the river.
    const toRiver = clamp(this.riverOffset(x, y) / 60, -1, 1);
    const site =
      this.siteHeight + 0.9 * toRiver + 0.35 * (fbm2(x / 30, y / 30, this.seed + 91, 2) - 0.5);
    return lerp(natural, site, w * w * (3 - 2 * w));
  }

  /** Rolling ground, the far hills, the knoll, and the valley the river runs in. */
  private natural(x: number, y: number): number {
    const s = this.seed;
    const rolling = 5 * fbm2(x / 95, y / 95, s + 11, 4) + 1.2 * fbm2(x / 22, y / 22, s + 17, 3);
    const rise = 0.018 * (y - WORLD.y0);
    const ridge =
      HILLS_HEIGHT * this.hills(y) * (0.55 + 0.7 * fbm2(x / 70, y / 50, s + 23, 4)) +
      10 * this.hills(y) * this.hills(y) * fbm2(x / 24, y / 24, s + 29, 3);
    const k = this.knoll;
    const kd = Math.hypot(x - k.x, (y - k.y) * 1.2);
    const knoll = this.knollHeight * Math.exp(-((kd / 26) ** 2));
    const off = this.riverOffset(x, y);
    const valley = -2.8 * Math.exp(-((off / 20) ** 2)) - 1.2 * Math.exp(-((off / 55) ** 2));
    return rolling + rise + ridge + knoll + valley;
  }

  /** The ground with the river's channel cut into it. */
  private shape(x: number, y: number): number {
    const banks = this.banks(x, y);
    const off = Math.abs(this.riverOffset(x, y));
    const half = this.riverHalfWidth(y);
    const water = this.waterLevel(y);
    // Banks slope down into the water; the bed deepens toward the middle.
    const bed = water - RIVER_DEPTH * (1 - (off / half) ** 2);
    const bank = smoothstep(half + 2.2, half - 0.3, off);
    const down = Math.min(banks, lerp(banks, water - 0.15, bank));
    return off < half ? Math.min(down, bed) : down;
  }
}
