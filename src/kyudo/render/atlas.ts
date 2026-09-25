import { smoothstep } from "../../shared/core/math.ts";
import { tileNoise } from "../../shared/core/random.ts";
import { EYE } from "../sim/dojo.ts";
import { type Prim, Quad } from "../sim/geometry.ts";
import { canopyLight, type Tree } from "./background.ts";
import { lampLight, occluded } from "./illum.ts";
import type { Lamp } from "./lamps.ts";

/** Most cells a surface's grid may have; larger surfaces get coarser cells. */
const MAX_CELLS = 24000;
/** Finest cell (m). */
const CELL = 0.1;
/** Cells whose sunlight is refreshed each frame while the sun moves. */
const SUN_BUDGET = 7000;
/** How far (radians) the sun moves before its light is worked out again. */
const SUN_STEP = 0.004;
/** A move this large (radians) is a jump in time, not the sun going on its way. */
const SUN_JUMP = 0.035;

/**
 * Light on one flat surface on a grid over its own coordinates: the lamps'
 * light, which never changes, and the sunlight that gets through, which is
 * refreshed a slice at a time as the sun moves. Sampled smoothly, so shadow
 * edges are a little soft, as the sun's are.
 */
export class Grid {
  readonly quad: Quad;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  /** Sunlight let through (0..1) at each cell. */
  readonly sun: Float32Array;
  /** Lamp light (r, g, b per unit albedo, at full brightness) at each cell. */
  readonly lamp: Float32Array;
  /** Normal facing the archer. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Whether trees shade it: the ground. */
  readonly ground: boolean;

  constructor(quad: Quad, lamps: readonly Lamp[]) {
    this.quad = quad;
    this.cell = Math.max(CELL, Math.sqrt((quad.lu * quad.lv) / MAX_CELLS));
    this.cols = Math.ceil(quad.lu / this.cell) + 1;
    this.rows = Math.ceil(quad.lv / this.cell) + 1;
    this.sun = new Float32Array(this.cols * this.rows).fill(1);
    this.lamp = new Float32Array(this.cols * this.rows * 3);
    // The side seen from the shooting line.
    const cx = quad.ox + (quad.ux * quad.lu + quad.vx * quad.lv) / 2;
    const cy = quad.oy + (quad.uy * quad.lu + quad.vy * quad.lv) / 2;
    const cz = quad.oz + (quad.uz * quad.lu + quad.vz * quad.lv) / 2;
    const toEye = -cx * quad.nx + (EYE - cy) * quad.ny - cz * quad.nz;
    const s = toEye >= 0 ? 1 : -1;
    this.nx = quad.nx * s;
    this.ny = quad.ny * s;
    this.nz = quad.nz * s;
    this.ground = this.ny > 0.99 && Math.abs(quad.oy) < 0.05;
    const rgb: [number, number, number] = [0, 0, 0];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const [x, y, z] = this.point(c, r);
        rgb[0] = 0;
        rgb[1] = 0;
        rgb[2] = 0;
        lampLight(lamps, 1, x, y, z, this.nx, this.ny, this.nz, rgb);
        const i = (r * this.cols + c) * 3;
        this.lamp[i] = rgb[0];
        this.lamp[i + 1] = rgb[1];
        this.lamp[i + 2] = rgb[2];
      }
    }
  }

  /** World position of a cell's corner. */
  point(c: number, r: number): [number, number, number] {
    const q = this.quad;
    const u = Math.min(q.lu, c * this.cell);
    const v = Math.min(q.lv, r * this.cell);
    return [q.ox + q.ux * u + q.vx * v, q.oy + q.uy * u + q.vy * v, q.oz + q.uz * u + q.vz * v];
  }

  get cells(): number {
    return this.cols * this.rows;
  }

  /** Works out the sunlight at cell `i`. */
  refresh(
    i: number,
    lx: number,
    ly: number,
    lz: number,
    trees: readonly Tree[],
    leafiness: number,
    time: number,
  ): void {
    const facing = this.nx * lx + this.ny * ly + this.nz * lz;
    if (facing <= 0) {
      this.sun[i] = 0;
      return;
    }
    const c = i % this.cols;
    const r = (i - c) / this.cols;
    const [x, y, z] = this.point(c, r);
    if (occluded(x + this.nx * 0.01, y + this.ny * 0.01, z + this.nz * 0.01, lx, ly, lz)) {
      this.sun[i] = 0;
      return;
    }
    if (!this.ground || trees.length === 0) {
      this.sun[i] = 1;
      return;
    }
    const light = canopyLight(trees, x, z, lx, ly, lz, leafiness);
    // Sun flecks through gaps in the leaves.
    const gaps = tileNoise(x * 2.3 + time * 0.25, z * 2.3 - time * 0.15);
    this.sun[i] = light + (1 - light) * smoothstep(0.62, 0.85, gaps) * 0.7;
  }

  /** Bilinear sample of a per-cell array at local (u, v), with `stride` values per cell. */
  private sample(data: Float32Array, u: number, v: number, stride: number, offset: number): number {
    const fx = Math.max(0, Math.min(this.cols - 1.001, u / this.cell));
    const fy = Math.max(0, Math.min(this.rows - 1.001, v / this.cell));
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const tx = fx - c;
    const ty = fy - r;
    const i = r * this.cols + c;
    const a = data[i * stride + offset];
    const b = data[(i + 1) * stride + offset];
    const d = data[(i + this.cols) * stride + offset];
    const e = data[(i + this.cols + 1) * stride + offset];
    return (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
  }

  sunAt(u: number, v: number): number {
    return this.sample(this.sun, u, v, 1, 0);
  }

  lampAt(u: number, v: number, out: [number, number, number]): void {
    out[0] = this.sample(this.lamp, u, v, 3, 0);
    out[1] = this.sample(this.lamp, u, v, 3, 1);
    out[2] = this.sample(this.lamp, u, v, 3, 2);
  }
}

/**
 * The light on every flat surface of the dojo, kept in the world rather than
 * on the screen: the same whatever the eye is doing, so drawing and aiming
 * cost nothing extra here.
 */
export class LightAtlas {
  private readonly grids: (Grid | null)[];
  private readonly order: Grid[];
  /** Where the sunlight pass has got to: grid and cell. */
  private gridCursor = 0;
  private cellCursor = 0;
  private passing = false;
  private sunX = Number.NaN;
  private sunY = Number.NaN;
  private sunZ = Number.NaN;

  /** @param skip parts that never need it (the wide ground far off) */
  constructor(prims: readonly Prim[], lamps: readonly Lamp[], skip: (p: Prim) => boolean) {
    this.grids = prims.map((p) => (p instanceof Quad && !skip(p) ? new Grid(p, lamps) : null));
    this.order = this.grids.filter((g): g is Grid => g !== null);
  }

  /** The grid over part `k`, or null if its light is worked out per pixel. */
  grid(k: number): Grid | null {
    return this.grids[k];
  }

  /**
   * Keeps the sunlight up to date as the sun moves, a slice of cells per
   * call. With no sun, nothing is done (the scene ignores the sun then).
   */
  update(
    lx: number,
    ly: number,
    lz: number,
    shining: boolean,
    trees: readonly Tree[],
    leafiness: number,
    time: number,
  ): void {
    if (!shining) {
      return;
    }
    const fresh = Number.isNaN(this.sunX);
    const moved = fresh
      ? Infinity
      : Math.acos(Math.min(1, lx * this.sunX + ly * this.sunY + lz * this.sunZ));
    // After a jump (the first frame, a page woken up) the shadows are redone at once.
    if (moved > SUN_JUMP) {
      this.passing = false;
      this.sunX = Number.NaN;
      this.settle(lx, ly, lz, trees, leafiness, time);
      return;
    }
    if (!this.passing && moved <= SUN_STEP) {
      return;
    }
    if (!this.passing) {
      this.passing = true;
      this.gridCursor = 0;
      this.cellCursor = 0;
      this.sunX = lx;
      this.sunY = ly;
      this.sunZ = lz;
    }
    // Only trees that can stand between the sun and the range this pass.
    const near = trees.filter((t) => t.z < 60 && Math.abs(t.x) < 25);
    let budget = SUN_BUDGET;
    while (budget > 0 && this.gridCursor < this.order.length) {
      const g = this.order[this.gridCursor];
      const end = Math.min(g.cells, this.cellCursor + budget);
      for (let i = this.cellCursor; i < end; i++) {
        g.refresh(i, this.sunX, this.sunY, this.sunZ, near, leafiness, time);
      }
      budget -= end - this.cellCursor;
      this.cellCursor = end;
      if (this.cellCursor >= g.cells) {
        this.gridCursor++;
        this.cellCursor = 0;
      }
    }
    if (this.gridCursor >= this.order.length) {
      this.passing = false;
    }
  }

  /** Works the sunlight out everywhere at once. */
  private settle(
    lx: number,
    ly: number,
    lz: number,
    trees: readonly Tree[],
    leafiness: number,
    time: number,
  ): void {
    this.passing = true;
    this.gridCursor = 0;
    this.cellCursor = 0;
    this.sunX = lx;
    this.sunY = ly;
    this.sunZ = lz;
    const near = trees.filter((t) => t.z < 60 && Math.abs(t.x) < 25);
    for (const g of this.order) {
      for (let i = 0; i < g.cells; i++) {
        g.refresh(i, lx, ly, lz, near, leafiness, time);
      }
    }
    this.passing = false;
  }
}
