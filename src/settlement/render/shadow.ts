import { clamp } from "../../shared/core/math.ts";
import type { Terrain } from "../sim/terrain.ts";
import { WORLD } from "../sim/terrain.ts";

/** Meters between the cells of the shadow grid. */
export const CELL = 0.5;
/** Columns and rows of the shadow grid. */
export const SHADOW_W = Math.round((WORLD.x1 - WORLD.x0) / CELL);
export const SHADOW_H = Math.round((WORLD.y1 - WORLD.y0) / CELL);
const W = SHADOW_W;
const H = SHADOW_H;
/** Height (m) over which a shadow's edge fades, softening the steps of the grid. */
export const PENUMBRA = 0.4;

/**
 * Where the sun's light reaches. Everything that stands up casts its
 * shadow as a height over a grid: the ground, and on it the tops of
 * buildings and trees. For a sun direction, a sweep from the sun's side
 * carries each cell's height away from the sun, sinking by the sun's slope
 * per step: the height under which a point is in shadow.
 */
export class ShadowMap {
  /** Height (m) of the ground at each cell. */
  private readonly ground = new Float32Array(W * H);
  /** Height (m) of the top of whatever stands on each cell (at least the ground). */
  readonly tops = new Float32Array(W * H);
  /** Height (m) below which each cell is in the sun's shadow. */
  readonly shade = new Float32Array(W * H);
  /** Direction toward the sun the shade was swept for, and whether it is up at all. */
  private sunX = 0;
  private sunY = 0;
  private slope = Infinity;
  up = false;
  /** Counts sweeps, so shaded colors know to be redone. */
  version = 0;
  /** How much of the year's leaves the broadleaf crowns casting shadow have on (0 bare, 1 full). */
  leaves = 1;

  constructor(terrain: Terrain) {
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        this.ground[j * W + i] = terrain.height(
          WORLD.x0 + (i + 0.5) * CELL,
          WORLD.y0 + (j + 0.5) * CELL,
        );
      }
    }
    this.tops.set(this.ground);
    this.shade.set(this.ground);
  }

  /** Grid cell range covering the box [x0, x1] × [y0, y1]. */
  cells(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    return [
      clamp(Math.floor((x0 - WORLD.x0) / CELL), 0, W - 1),
      clamp(Math.floor((y0 - WORLD.y0) / CELL), 0, H - 1),
      clamp(Math.floor((x1 - WORLD.x0) / CELL), 0, W - 1),
      clamp(Math.floor((y1 - WORLD.y0) / CELL), 0, H - 1),
    ];
  }

  /** Lowers the box back to bare ground, before what stands on it is raised again. */
  reset(x0: number, y0: number, x1: number, y1: number): void {
    const [i0, j0, i1, j1] = this.cells(x0, y0, x1, y1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        this.tops[j * W + i] = this.ground[j * W + i];
      }
    }
  }

  /**
   * Raises the cells of a box to `height(x, y)` (m) where that is higher,
   * for every cell whose middle `height` gives a value for (NaN leaves it).
   */
  raise(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    height: (x: number, y: number) => number,
  ): void {
    const [i0, j0, i1, j1] = this.cells(x0, y0, x1, y1);
    for (let j = j0; j <= j1; j++) {
      const y = WORLD.y0 + (j + 0.5) * CELL;
      for (let i = i0; i <= i1; i++) {
        const h = height(WORLD.x0 + (i + 0.5) * CELL, y);
        const k = j * W + i;
        if (h > this.tops[k]) {
          this.tops[k] = h;
        }
      }
    }
  }

  /**
   * Sweeps the shade for a sun in world direction (lx, ly, lz), unit length;
   * a sun at or below the horizon leaves everything unlit by it.
   */
  sweep(lx: number, ly: number, lz: number): void {
    this.version++;
    const flat = Math.hypot(lx, ly);
    this.up = lz > 0.01;
    if (!this.up) {
      return;
    }
    this.sunX = lx / flat;
    this.sunY = ly / flat;
    this.slope = lz / flat;
    const tops = this.tops;
    const shade = this.shade;
    const dx = this.sunX;
    const dy = this.sunY;
    if (Math.abs(dx) >= Math.abs(dy)) {
      // March across columns from the sun's side; each cell looks one column sunward.
      const di = dx > 0 ? 1 : -1;
      const step = dy / Math.abs(dx);
      const fall = CELL * Math.hypot(1, step) * this.slope;
      const iStart = dx > 0 ? W - 1 : 0;
      for (let j = 0; j < H; j++) {
        shade[j * W + iStart] = tops[j * W + iStart];
      }
      for (let i = iStart - di; i >= 0 && i < W; i -= di) {
        const from = i + di;
        for (let j = 0; j < H; j++) {
          const q = j + step;
          const q0 = Math.floor(q);
          const f = q - q0;
          const a = shade[clamp(q0, 0, H - 1) * W + from];
          const b = shade[clamp(q0 + 1, 0, H - 1) * W + from];
          const carried = a + (b - a) * f - fall;
          const own = tops[j * W + i];
          shade[j * W + i] = own > carried ? own : carried;
        }
      }
    } else {
      const dj = dy > 0 ? 1 : -1;
      const step = dx / Math.abs(dy);
      const fall = CELL * Math.hypot(1, step) * this.slope;
      const jStart = dy > 0 ? H - 1 : 0;
      for (let i = 0; i < W; i++) {
        shade[jStart * W + i] = tops[jStart * W + i];
      }
      for (let j = jStart - dj; j >= 0 && j < H; j -= dj) {
        const from = (j + dj) * W;
        const row = j * W;
        for (let i = 0; i < W; i++) {
          const q = i + step;
          const q0 = Math.floor(q);
          const f = q - q0;
          const a = shade[from + clamp(q0, 0, W - 1)];
          const b = shade[from + clamp(q0 + 1, 0, W - 1)];
          const carried = a + (b - a) * f - fall;
          const own = tops[row + i];
          shade[row + i] = own > carried ? own : carried;
        }
      }
    }
  }

  /**
   * How much sun reaches a point at height z over (x, y): 1 in the sun, 0 in
   * shadow, softened over a few centimeters.
   */
  light(x: number, y: number, z: number): number {
    if (!this.up) {
      return 0;
    }
    const gx = (x - WORLD.x0) / CELL - 0.5;
    const gy = (y - WORLD.y0) / CELL - 0.5;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    if (i < 0 || j < 0 || i >= W - 1 || j >= H - 1) {
      return 1;
    }
    const fx = gx - i;
    const fy = gy - j;
    const s = this.shade;
    const k = j * W + i;
    const top = s[k] + (s[k + 1] - s[k]) * fx;
    const bottom = s[k + W] + (s[k + W + 1] - s[k + W]) * fx;
    const edge = top + (bottom - top) * fy;
    const d = z - edge;
    return d >= PENUMBRA ? 1 : d <= -PENUMBRA ? 0 : (d + PENUMBRA) / (2 * PENUMBRA);
  }
}
