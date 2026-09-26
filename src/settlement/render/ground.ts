import { clamp01 } from "../../shared/core/math.ts";
import { hash2, tileNoise } from "../../shared/core/random.ts";
import { inRect, type Rect } from "../sim/geometry.ts";
import { STANDING, STUMP } from "../sim/forest.ts";
import type { Point } from "../sim/terrain.ts";
import { GRID, GRID_H, GRID_W, WORLD } from "../sim/terrain.ts";
import type { World } from "../sim/world.ts";
import { TILE } from "./gbuffer.ts";
import { M } from "./materials.ts";
import { pavingDetail } from "./paints.ts";
import { FIELD_OWNER, PASTURE_OWNER } from "./owners.ts";
import { COS_E, S, SIN_E } from "./projection.ts";
import type { Face, TileRaster } from "./raster.ts";

/** Meters from a stump's middle its cut shows, and how far a crown's woodland floor frays past it. */
const STUMP_REACH = 0.35;
const FLOOR_RAGGED = 0.6;
/** Steepness (the ground's upward normal) where rock begins to show, and where it is mostly bare. */
const ROCK_FROM = 0.8;
const ROCK_BARE = 0.66;

/** A street segment near the tile being drawn, with how it is built up. */
interface Way {
  a: Point;
  b: Point;
  half: number;
  grade: number;
  street: number;
}

/**
 * The land as drawn: the height grid cut into triangles, shaded with smooth
 * normals, and painted by what lies on it — grass and meadow, the woodland
 * floor under standing trees, streets as far as they are built, the square,
 * yards, gardens and fields, the river's banks.
 */
export class GroundPainter {
  /** Unit normals of the height grid, three per sample. */
  private readonly normals: Float32Array;
  /** Lowest and highest heights of each row of the grid, in blocks of 8 samples. */
  private readonly blockLo: Float32Array;
  private readonly blockHi: Float32Array;
  private readonly blocksW: number;
  private readonly world: World;
  // Scratch lists for the tile being drawn.
  private ways: Way[] = [];
  private rects: { rect: Rect; kind: "field" | "pasture" | "yard" | "garden"; owner: number }[] =
    [];
  private trees: { x: number; y: number; r: number; stump: boolean }[] = [];
  /**
   * The gathered trees by 1 m cells of the gathered box, each listed in every
   * cell its woodland floor may reach, in the order gathered: the trees of
   * cell c are `treeList[treeStart[c] .. treeStart[c + 1])`.
   */
  private treeX0 = 0;
  private treeY0 = 0;
  private treeCols = 0;
  private treeRows = 0;
  private treeStart = new Int32Array(1);
  private treeFill = new Int32Array(1);
  private treeList = new Int32Array(64);
  private readonly quad = new Float64Array(12);
  private readonly waterFace: Face = { mat: M.WATER, owner: 0, paint: null };

  constructor(world: World) {
    this.world = world;
    const t = world.terrain;
    this.normals = new Float32Array(GRID_W * GRID_H * 3);
    for (let j = 0; j < GRID_H; j++) {
      for (let i = 0; i < GRID_W; i++) {
        const dx = (t.sample(i + 1, j) - t.sample(i - 1, j)) / (2 * GRID);
        const dy = (t.sample(i, j + 1) - t.sample(i, j - 1)) / (2 * GRID);
        const len = Math.hypot(dx, dy, 1);
        const k = (j * GRID_W + i) * 3;
        this.normals[k] = -dx / len;
        this.normals[k + 1] = -dy / len;
        this.normals[k + 2] = 1 / len;
      }
    }
    this.blocksW = Math.ceil(GRID_W / 8);
    this.blockLo = new Float32Array(this.blocksW * GRID_H).fill(Infinity);
    this.blockHi = new Float32Array(this.blocksW * GRID_H).fill(-Infinity);
    for (let j = 0; j < GRID_H; j++) {
      for (let i = 0; i < GRID_W; i++) {
        const b = j * this.blocksW + (i >> 3);
        const h = t.sample(i, j);
        this.blockLo[b] = Math.min(this.blockLo[b], h);
        this.blockHi[b] = Math.max(this.blockHi[b], h);
      }
    }
  }

  /** Draws the ground into the tile `r` has begun. */
  draw(r: TileRaster): void {
    const gx0 = r.gx0;
    const gy0 = r.gy0;
    // Grid columns under the tile, and the rows that can reach it.
    const i0 = Math.max(0, Math.floor((gx0 * S - WORLD.x0) / GRID) - 1);
    const i1 = Math.min(GRID_W - 2, Math.ceil(((gx0 + TILE) * S - WORLD.x0) / GRID) + 1);
    if (i0 > i1) {
      return;
    }
    this.gather(r);
    for (let j = 0; j < GRID_H - 1; j++) {
      const y = WORLD.y0 + j * GRID;
      let lo = Infinity;
      let hi = -Infinity;
      for (let b = i0 >> 3; b <= (i1 + 1) >> 3; b++) {
        for (const jj of [j, j + 1]) {
          lo = Math.min(lo, this.blockLo[jj * this.blocksW + b]);
          hi = Math.max(hi, this.blockHi[jj * this.blocksW + b]);
        }
      }
      // Rows of the screen the grid row spans.
      const top = -((y + GRID) * SIN_E + hi * COS_E) / S;
      const bottom = -(y * SIN_E + lo * COS_E) / S;
      if (bottom < gy0 - 1 || top > gy0 + TILE + 1) {
        continue;
      }
      for (let i = i0; i <= i1; i++) {
        this.cell(r, i, j);
      }
    }
  }

  /**
   * The river's surface: level strips across it at the water's height,
   * running a little into the banks, which rise out of it where they are
   * higher.
   */
  drawWater(r: TileRaster): void {
    const t = this.world.terrain;
    const x0 = r.gx0 * S;
    const x1 = (r.gx0 + TILE) * S;
    // The span of y whose water, at any height the river runs at, can show in the tile.
    const yA = (-(r.gy0 + TILE) * S - t.waterHigh * COS_E) / SIN_E;
    const yB = (-r.gy0 * S - t.waterLow * COS_E) / SIN_E;
    const step = 2;
    const v = this.quad;
    for (
      let y = Math.floor(Math.max(WORLD.y0, yA) / step) * step;
      y < Math.min(WORLD.y1, yB);
      y += step
    ) {
      const ya = y;
      const yb = y + step;
      const ha = t.riverHalfWidth(ya) + 1.4;
      const hb = t.riverHalfWidth(yb) + 1.4;
      const ca = t.riverX(ya);
      const cb = t.riverX(yb);
      if (
        Math.max(ca, cb) + Math.max(ha, hb) < x0 - 1 ||
        Math.min(ca, cb) - Math.max(ha, hb) > x1 + 1
      ) {
        continue;
      }
      const za = t.waterLevel(ya);
      const zb = t.waterLevel(yb);
      v[0] = ca - ha;
      v[1] = ya;
      v[2] = za;
      v[3] = ca + ha;
      v[4] = ya;
      v[5] = za;
      v[6] = cb + hb;
      v[7] = yb;
      v[8] = zb;
      v[9] = cb - hb;
      v[10] = yb;
      v[11] = zb;
      r.polygon(v, 4, this.waterFace);
    }
  }

  /** Collects what lies over the tile, so each pixel checks only a few things. */
  private gather(r: TileRaster): void {
    const world = this.world;
    const plan = world.plan;
    // World box the tile can show: all x under it, and y over the range of heights.
    const x0 = r.gx0 * S - 1;
    const x1 = (r.gx0 + TILE) * S + 1;
    const yA = (-(r.gy0 + TILE) * S - 90 * COS_E) / SIN_E;
    const yB = (-r.gy0 * S + 10 * COS_E) / SIN_E;
    const margin = 6;
    this.ways = [];
    for (const s of plan.streets) {
      const grade = world.town.streetGrade[s.id];
      for (let k = 0; k + 1 < s.points.length; k++) {
        const a = s.points[k];
        const b = s.points[k + 1];
        if (
          Math.max(a.x, b.x) < x0 - margin ||
          Math.min(a.x, b.x) > x1 + margin ||
          Math.max(a.y, b.y) < yA - margin ||
          Math.min(a.y, b.y) > yB + margin
        ) {
          continue;
        }
        this.ways.push({ a, b, half: s.half, grade, street: s.id });
      }
    }
    this.rects = [];
    const near = (rect: Rect) => {
      const reach = Math.hypot(rect.width, rect.depth) / 2 + 1;
      return (
        rect.x + reach > x0 && rect.x - reach < x1 && rect.y + reach > yA && rect.y - reach < yB
      );
    };
    for (const f of plan.fields) {
      if (near(f.rect) && world.town.fields[f.id].cleared) {
        this.rects.push({ rect: f.rect, kind: "field", owner: FIELD_OWNER + f.id });
      }
    }
    for (const p of plan.pastures) {
      if (near(p.rect) && world.town.pastures[p.id].fenced) {
        this.rects.push({ rect: p.rect, kind: "pasture", owner: PASTURE_OWNER + p.id });
      }
    }
    for (const lot of plan.lots) {
      const use = world.town.lotGround[lot.id];
      if (use !== 0 && near(lot.rect)) {
        this.rects.push({ rect: lot.rect, kind: use === 2 ? "garden" : "yard", owner: 0 });
      }
    }
    this.trees = [];
    world.forest.inBox(x0 - 4, yA - 4, x1 + 4, yB + 4, (tree) => {
      const state = world.forest.state[tree.id];
      if (state === STANDING || state === STUMP) {
        this.trees.push({ x: tree.x, y: tree.y, r: tree.radius, stump: state === STUMP });
      }
    });
    this.binTrees(Math.floor(x0 - 4), Math.floor(yA - 4), Math.ceil(x1 + 4), Math.ceil(yB + 4));
  }

  /** Sorts the gathered trees into the cells of the box [x0, x1] × [y0, y1] (whole meters). */
  private binTrees(x0: number, y0: number, x1: number, y1: number): void {
    const cols = x1 - x0 + 1;
    const rows = y1 - y0 + 1;
    const cells = cols * rows;
    this.treeX0 = x0;
    this.treeY0 = y0;
    this.treeCols = cols;
    this.treeRows = rows;
    if (this.treeStart.length < cells + 1) {
      this.treeStart = new Int32Array(cells + 1);
      this.treeFill = new Int32Array(cells);
    }
    const start = this.treeStart;
    const fill = this.treeFill;
    start.fill(0, 0, cells + 1);
    // Count each cell's trees, lay the lists end to end, then fill them in.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < this.trees.length; k++) {
        const tr = this.trees[k];
        const reach = tr.stump ? STUMP_REACH : tr.r * 0.95 + FLOOR_RAGGED;
        const i0 = Math.max(0, Math.floor(tr.x - reach) - x0);
        const i1 = Math.min(cols - 1, Math.floor(tr.x + reach) - x0);
        const j0 = Math.max(0, Math.floor(tr.y - reach) - y0);
        const j1 = Math.min(rows - 1, Math.floor(tr.y + reach) - y0);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const c = j * cols + i;
            if (pass === 0) {
              start[c]++;
            } else {
              this.treeList[fill[c]++] = k;
            }
          }
        }
      }
      if (pass === 0) {
        let sum = 0;
        for (let c = 0; c < cells; c++) {
          const n = start[c];
          start[c] = sum;
          fill[c] = sum;
          sum += n;
        }
        start[cells] = sum;
        if (this.treeList.length < sum) {
          this.treeList = new Int32Array(sum * 2);
        }
      }
    }
  }

  /** Draws the two triangles of grid cell (i, j). */
  private cell(r: TileRaster, i: number, j: number): void {
    const t = this.world.terrain;
    const xa = WORLD.x0 + i * GRID;
    const ya = WORLD.y0 + j * GRID;
    const h00 = t.sample(i, j);
    const h10 = t.sample(i + 1, j);
    const h01 = t.sample(i, j + 1);
    const h11 = t.sample(i + 1, j + 1);
    this.triangle(r, i, j, xa, ya, h00, xa + GRID, ya, h10, xa + GRID, ya + GRID, h11);
    this.triangle(r, i, j, xa, ya, h00, xa + GRID, ya + GRID, h11, xa, ya + GRID, h01);
  }

  private triangle(
    r: TileRaster,
    ci: number,
    cj: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    // Screen positions (local to the tile).
    const pax = ax / S - r.gx0;
    const pay = -(ay * SIN_E + az * COS_E) / S - r.gy0;
    const pbx = bx / S - r.gx0;
    const pby = -(by * SIN_E + bz * COS_E) / S - r.gy0;
    const pcx = cx / S - r.gx0;
    const pcy = -(cy * SIN_E + cz * COS_E) / S - r.gy0;
    const minX = Math.max(0, Math.floor(Math.min(pax, pbx, pcx)));
    const maxX = Math.min(TILE - 1, Math.ceil(Math.max(pax, pbx, pcx)));
    const minY = Math.max(0, Math.floor(Math.min(pay, pby, pcy)));
    const maxY = Math.min(TILE - 1, Math.ceil(Math.max(pay, pby, pcy)));
    if (minX > maxX || minY > maxY) {
      return;
    }
    const area = (pbx - pax) * (pcy - pay) - (pby - pay) * (pcx - pax);
    if (Math.abs(area) < 1e-9) {
      return;
    }
    const inv = 1 / area;
    for (let py = minY; py <= maxY; py++) {
      const sy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const sx = px + 0.5;
        const w0 = ((pbx - sx) * (pcy - sy) - (pby - sy) * (pcx - sx)) * inv;
        const w1 = ((pcx - sx) * (pay - sy) - (pcy - sy) * (pax - sx)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) {
          continue;
        }
        const z = w0 * az + w1 * bz + w2 * cz;
        const i = py * TILE + px;
        if (z <= r.heightAt(i)) {
          continue;
        }
        const x = w0 * ax + w1 * bx + w2 * cx;
        const y = w0 * ay + w1 * by + w2 * cy;
        // Smooth facing from the grid's normals.
        const fx = (x - WORLD.x0) / GRID - ci;
        const fy = (y - WORLD.y0) / GRID - cj;
        const n = this.normals;
        const k00 = (cj * GRID_W + ci) * 3;
        const k10 = k00 + 3;
        const k01 = k00 + GRID_W * 3;
        const k11 = k01 + 3;
        const nx =
          (n[k00] * (1 - fx) + n[k10] * fx) * (1 - fy) + (n[k01] * (1 - fx) + n[k11] * fx) * fy;
        const ny =
          (n[k00 + 1] * (1 - fx) + n[k10 + 1] * fx) * (1 - fy) +
          (n[k01 + 1] * (1 - fx) + n[k11 + 1] * fx) * fy;
        const nz =
          (n[k00 + 2] * (1 - fx) + n[k10 + 2] * fx) * (1 - fy) +
          (n[k01 + 2] * (1 - fx) + n[k11 + 2] * fx) * fy;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const owner = this.ownerAt(x, y);
        r.put(i, z, this.paint(x, y, z, nz / len), nx / len, ny / len, nz / len, owner);
      }
    }
  }

  private ownerAt(x: number, y: number): number {
    for (const e of this.rects) {
      if ((e.kind === "field" || e.kind === "pasture") && inRect(e.rect, x, y)) {
        return e.owner;
      }
    }
    return 0;
  }

  /** What the ground is at (x, y), as a packed material and detail. */
  private paint(x: number, y: number, z: number, nz: number): number {
    const t = this.world.terrain;
    const plan = this.world.plan;
    const fine = hash2(Math.floor((x / S) * 1.0001), Math.floor(y / 0.3)) - 0.5;
    const patch = tileNoise(x / 3.1, y / 3.1) - 0.5;
    const off = Math.abs(t.riverOffset(x, y)) - t.riverHalfWidth(y);
    // The river and its banks.
    if (off < 0) {
      return pack(M.RIVERBED, 128 + fine * 20);
    }
    if (off < 1.6 + 1.2 * tileNoise(x / 2, y / 2)) {
      const kind = tileNoise(x / 1.7 + 40, y / 1.7) > 0.55 ? M.PEBBLES : off < 0.7 ? M.MUD : M.SAND;
      return pack(kind, 128 + fine * 26 + patch * 14);
    }
    // Streets, as far as they are built: the nearest one, measured from its middle.
    let way: Way | null = null;
    let wd = Infinity;
    for (const w of this.ways) {
      if (w.grade === 0) {
        continue;
      }
      const d = segmentLength(x, y, w.a, w.b);
      if (d - w.half < wd) {
        wd = d - w.half;
        way = w;
      }
    }
    if (way && wd < 0.25 * (tileNoise(x * 1.3, y * 1.3) - 0.5) * 2) {
      return this.street(x, y, z, wd + way.half, way, fine);
    }
    const sq = plan.square;
    const sd = Math.sqrt((x - sq.x) ** 2 + (y - sq.y) ** 2);
    const squareGrade = this.world.town.squareGrade;
    if (squareGrade > 0 && sd < sq.radius + (squareGrade > 1 ? 0 : 1.5 * tileNoise(x / 2, y / 2))) {
      if (squareGrade >= 3) {
        return pack(M.FLAGSTONE, pavingDetail(x, y, z, true) - 10 + fine * 4);
      }
      return pack(squareGrade === 2 ? M.GRAVEL : M.DIRT, 128 + fine * 22 + patch * 16);
    }
    // Fields, pastures, yards and gardens.
    for (const e of this.rects) {
      if (!inRect(e.rect, x, y)) {
        continue;
      }
      if (e.kind === "field") {
        return this.furrows(x, y, e.rect, fine);
      }
      if (e.kind === "pasture") {
        return pack(M.MEADOW, 124 + fine * 26 + patch * 22);
      }
      if (e.kind === "garden" && !inRect(e.rect, x, y, -1.2)) {
        return pack(M.YARD, 128 + fine * 24 + patch * 14);
      }
      if (e.kind === "garden") {
        return this.furrows(x, y, e.rect, fine, M.GARDEN);
      }
      return pack(M.YARD, 128 + fine * 24 + patch * 20);
    }
    // Under the trees, the woodland floor; stumps where they were felled.
    const ci = Math.floor(x) - this.treeX0;
    const cj = Math.floor(y) - this.treeY0;
    if (ci >= 0 && cj >= 0 && ci < this.treeCols && cj < this.treeRows) {
      const c = cj * this.treeCols + ci;
      for (let k = this.treeStart[c]; k < this.treeStart[c + 1]; k++) {
        const tr = this.trees[this.treeList[k]];
        const dx = x - tr.x;
        const dy = y - tr.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (tr.stump && d < STUMP_REACH) {
          return pack(M.STUMP, 150 - d * 120);
        }
        if (!tr.stump && d < tr.r * 0.95 + FLOOR_RAGGED * tileNoise(x, y)) {
          return pack(M.FOREST_FLOOR, 128 + fine * 30 + patch * 18);
        }
      }
    }
    // Rock breaks through where the ground is steep, more of it the steeper, edged with moss.
    if (nz < ROCK_FROM) {
      const steep = clamp01((ROCK_FROM - nz) / (ROCK_FROM - ROCK_BARE));
      const n = tileNoise(x / 3.3, y / 3.3) * 0.65 + tileNoise(x / 1.1 + 17, y / 1.1) * 0.35;
      const reach = steep * 0.9 - 0.16 + fine * 0.08;
      if (n < reach) {
        const lump = tileNoise(x / 0.9 + 5, y / 0.9);
        const crack = Math.abs(tileNoise(x / 1.6 + 9, y / 1.6) - 0.5) < 0.035 ? -34 : 0;
        return pack(M.ROCK, 96 + lump * 44 + fine * 20 + crack);
      }
      if (n < reach + 0.07) {
        return pack(M.GRASS, 100 + fine * 14);
      }
    }
    const meadow = t.hills(y) < 0.1 && this.world.forest.cleared(x, y);
    const tuft = fine > 0.42 ? 18 : fine < -0.44 ? -14 : 0;
    return pack(meadow ? M.MEADOW : M.GRASS, 128 + fine * 18 + patch * 22 + tuft);
  }

  private street(x: number, y: number, z: number, d: number, w: Way, fine: number): number {
    if (w.grade >= 3) {
      // Cobbles, with a kerb of flagstones along either edge.
      return d / w.half > 0.86
        ? pack(M.FLAGSTONE, pavingDetail(x, y, z, true) - 14)
        : pack(M.COBBLE, pavingDetail(x, y, z, false) + fine * 6);
    }
    // Wheel ruts along trodden roads.
    const rut = w.half > 1.6 && Math.abs(d - w.half * 0.45) < 0.25 ? -18 : 0;
    const kind = w.grade === 2 ? M.GRAVEL : M.TRACK;
    const worn = w.grade === 1 && d > w.half - 0.5 && fine > 0 ? M.GRASS : kind;
    return pack(worn, 128 + fine * 22 + rut + (tileNoise(x / 1.5, y / 1.5) - 0.5) * 18);
  }

  /** Rows plowed along a field's length. */
  private furrows(x: number, y: number, rect: Rect, fine: number, mat: number = M.FIELD): number {
    const across = (x - rect.x) * Math.cos(rect.angle) + (y - rect.y) * Math.sin(rect.angle);
    const phase = (((across / 0.6) % 1) + 1) % 1;
    const ridge = phase < 0.5 ? 18 : -14;
    return pack(mat, 128 + ridge + fine * 16);
  }
}

function pack(mat: number, detail: number): number {
  return (mat << 8) | Math.round(clamp01(detail / 255) * 255);
}

/** Distance from (x, y) to the segment a–b. */
function segmentLength(x: number, y: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
  const ex = x - (a.x + dx * t);
  const ey = y - (a.y + dy * t);
  return Math.sqrt(ex * ex + ey * ey);
}
