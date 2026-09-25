import { mix, pack, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../shared/core/math.ts";
import { hash2, hash3, Rng, tileNoise } from "../../shared/core/random.ts";
import type { Surface as Framebuffer } from "../../shared/core/surface.ts";
import {
  AIR,
  FILL,
  GRID_HEIGHT,
  GRID_TOP,
  GRID_WIDTH,
  GRID_X0,
  OPEN,
  SOIL,
  STONE,
} from "../sim/geometry.ts";
import { covers, type Horizons, horizonAt, type Stone, STONE_CELL } from "../sim/soil.ts";
import type { World } from "../sim/world.ts";
import {
  CLAY,
  DUST,
  DUSTING,
  HOLLOW,
  LOAM,
  MANGANESE,
  ROOT,
  RUST,
  STONES,
  TOPSOIL,
} from "./palette.ts";

/** Highest the heap of dug soil can rise (mm above the ground) that the cache covers. */
const HEAP_TOP = 36;
/** Kinds of marks in the soil beside its layers. */
const FINE_ROOT = 1;
const THICK_ROOT = 2;

/** Scratch for stone shading, and for colors mixed while painting. */
const HIT = { id: 0, nx: 0, ny: 0, tone: 0 };
const BASE: [number, number, number] = [0, 0, 0];
const MIXED: [number, number, number] = [0, 0, 0];
const THICK_ROOT_COLOR = mix(ROOT, [110, 80, 50], 0.35);
const LOAM_CLAY = mix(LOAM, CLAY, 0.6);
const TOPSOIL_LOAM = mix(TOPSOIL, LOAM, 0.5);
const HEAP_CLAY = mix(LOAM, CLAY, 0.7);
const HEAP_TOPSOIL = mix(TOPSOIL, LOAM, 0.6);

/** Mixes a and b into `out` without making a new array. */
function mixInto(
  out: [number, number, number],
  a: RGB,
  b: RGB,
  t: number,
): [number, number, number] {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** The unlit color of soil of a horizon (0 topsoil .. 2 clay), into `out`. */
function layerColor(out: [number, number, number], layer: number): [number, number, number] {
  return layer < 1
    ? mixInto(out, TOPSOIL, LOAM, layer)
    : mixInto(out, LOAM, CLAY, Math.min(1, layer - 1));
}

/**
 * The cut face of the ground: the soil's layers, grains and mottles, roots,
 * the stones, the tunnels and chambers dug into it, the plugs packed into
 * them and the heap piled on top. The unlit color of every millimeter is kept
 * and redone only where digging or the heap changed it; each frame it is lit
 * by the time of day, darkened where the soil is wet and frosted where it is
 * frozen.
 */
export class SoilPainter {
  private width = 0;
  private rows = 0;
  /** World x of the cache's first column, and y of the top edge of its first row. */
  private x0 = 0;
  private yTop = HEAP_TOP;
  /** Unlit color of each millimeter; 0 where there is only air. */
  private albedo = new Uint32Array(0);
  private marks = new Uint8Array(0);
  private stoneOf = new Int32Array(0);
  private stones: Stone[] = [];
  private columns: Horizons[] = [];
  /** The ground's height (with the heap) each column was last drawn with. */
  private drawnTop = new Float32Array(0);
  private seed = 0;
  private built = false;

  /**
   * Covers the screen columns `width` wide with x = 0 at column `cx`, down to
   * world height `yBottom` (the lowest the view can show).
   */
  resize(width: number, cx: number, yBottom: number): void {
    this.width = width;
    this.x0 = -cx;
    this.rows = Math.max(1, Math.ceil(HEAP_TOP - yBottom) + 1);
    this.albedo = new Uint32Array(width * this.rows);
    this.marks = new Uint8Array(width * this.rows);
    this.stoneOf = new Int32Array(width * this.rows).fill(-1);
    this.drawnTop = new Float32Array(width);
    this.built = false;
  }

  /** Brings the cache up to date with the world: all of it after a resize, else what changed. */
  update(world: World): void {
    if (!this.built) {
      this.build(world);
      world.nest.changed.length = 0;
      return;
    }
    const changed = world.nest.changed;
    for (const c of changed) {
      const x = GRID_X0 + (c % GRID_WIDTH);
      const y = GRID_TOP - Math.floor(c / GRID_WIDTH) - 1;
      // A cell's look depends on its neighbors two cells away.
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          this.repaint(world, x + dx, y + dy);
        }
      }
    }
    changed.length = 0;
    // Columns where the heap rose or settled.
    const surface = world.surface;
    for (let col = 0; col < this.width; col++) {
      const ground = this.columns[col].ground;
      const top = ground + surface.heapAt(this.x0 + col + 0.5);
      if (Math.abs(top - this.drawnTop[col]) > 0.2) {
        const lo = Math.floor(Math.min(ground, this.drawnTop[col], top)) - 1;
        const hi = Math.ceil(Math.max(this.drawnTop[col], top)) + 1;
        this.drawnTop[col] = top;
        for (let y = lo; y <= hi; y++) {
          this.repaint(world, this.x0 + col, y);
        }
      }
    }
  }

  private build(world: World): void {
    this.seed = world.seed;
    const soil = world.soil;
    this.columns = [];
    for (let col = 0; col < this.width; col++) {
      this.columns.push(soil.horizons(this.x0 + col + 0.5, { ground: 0, topsoil: 0, clay: 0 }));
      this.drawnTop[col] = world.surface.height(this.x0 + col + 0.5);
    }
    this.placeStones(world);
    this.markRoots(world);
    for (let r = 0; r < this.rows; r++) {
      const y = this.yTop - r - 1;
      for (let col = 0; col < this.width; col++) {
        this.albedo[r * this.width + col] = this.colorAt(world, col, r, this.x0 + col, y);
      }
    }
    this.built = true;
  }

  /** Recomputes the cell with lower-left corner (x, y), if the cache holds it. */
  private repaint(world: World, x: number, y: number): void {
    const col = x - this.x0;
    const r = this.yTop - y - 1;
    if (col < 0 || col >= this.width || r < 0 || r >= this.rows) {
      return;
    }
    this.albedo[r * this.width + col] = this.colorAt(world, col, r, x, y);
  }

  /** Every stone that reaches into the cache, rasterized once. */
  private placeStones(world: World): void {
    const soil = world.soil;
    this.stones = [];
    this.stoneOf.fill(-1);
    const yBottom = this.yTop - this.rows;
    for (
      let cj = Math.floor(yBottom / STONE_CELL) - 1;
      cj <= Math.ceil(this.yTop / STONE_CELL) + 1;
      cj++
    ) {
      for (
        let ci = Math.floor(this.x0 / STONE_CELL) - 1;
        ci <= Math.ceil((this.x0 + this.width) / STONE_CELL) + 1;
        ci++
      ) {
        const stone = soil.stone(ci, cj);
        if (!stone) {
          continue;
        }
        const index = this.stones.length;
        this.stones.push(stone);
        const reach = Math.max(stone.rx, stone.ry) * 1.1 + 1;
        for (let y = Math.floor(stone.y - reach); y <= Math.ceil(stone.y + reach); y++) {
          for (let x = Math.floor(stone.x - reach); x <= Math.ceil(stone.x + reach); x++) {
            const col = x - this.x0;
            const r = this.yTop - y - 1;
            if (col < 0 || col >= this.width || r < 0 || r >= this.rows) {
              continue;
            }
            if (covers(stone, x + 0.5, y + 0.5)) {
              this.stoneOf[r * this.width + col] = index;
            }
          }
        }
      }
    }
  }

  /**
   * The fine roots of the turf in the topsoil, and the deeper roots of the
   * plants along the cut.
   */
  private markRoots(world: World): void {
    this.marks.fill(0);
    const seed = this.seed;
    const soil = world.soil;
    const mark = (x: number, y: number, kind: number) => {
      const col = Math.floor(x) - this.x0;
      const r = this.yTop - Math.floor(y) - 1;
      if (col >= 0 && col < this.width && r >= 0 && r < this.rows) {
        const i = r * this.width + col;
        if (this.marks[i] < kind) {
          this.marks[i] = kind;
        }
      }
    };
    // Turf roots: a tangle of fine threads, a few reaching deep.
    const spacing = 11;
    for (
      let k = Math.floor(this.x0 / spacing) - 8;
      k <= Math.ceil((this.x0 + this.width) / spacing) + 8;
      k++
    ) {
      const r = new Rng(hash3(k, seed, 0x2007) * 4294967296);
      let x = k * spacing + r.range(0, spacing);
      let y = soil.ground(x) - 1;
      const length = 5 + 60 * Math.pow(r.next(), 3);
      let dx = r.range(-0.35, 0.35);
      for (let s = 0; s < length; s++) {
        mark(x, y, FINE_ROOT);
        dx += r.range(-0.3, 0.3);
        dx = Math.max(-0.9, Math.min(0.9, dx));
        x += dx;
        y -= 1;
        // A side root now and then.
        if (r.chance(0.02)) {
          let bx = x;
          let by = y;
          const side = r.chance(0.5) ? 1 : -1;
          for (let b = 0; b < r.int(4, 14); b++) {
            bx += side * r.range(0.4, 1);
            by -= r.range(0.2, 0.9);
            mark(bx, by, FINE_ROOT);
          }
        }
      }
    }
    // The taproots of the plants along the cut, thick and going deep.
    for (const stem of world.surface.stems) {
      const r = new Rng(stem.seed ^ 0x7a9);
      let x = stem.x;
      let y = soil.ground(x);
      const length = stem.kind === "grass" ? 60 : r.range(110, 170);
      for (let s = 0; s < length; s++) {
        mark(x, y, s < length * 0.6 ? THICK_ROOT : FINE_ROOT);
        if (s < length * 0.4) {
          mark(x + 1, y, THICK_ROOT);
        }
        x += r.range(-0.5, 0.5);
        y -= 1;
      }
    }
  }

  /** What holds cell (x, y) now: from the grid inside it, from the ground's shape beyond. */
  private material(world: World, x: number, y: number): number {
    const i = x - GRID_X0;
    const j = GRID_TOP - y - 1;
    if (i >= 0 && i < GRID_WIDTH && j >= 0 && j < GRID_HEIGHT) {
      return world.nest.material[j * GRID_WIDTH + i];
    }
    if (y + 0.5 > world.soil.ground(x + 0.5)) {
      return AIR;
    }
    return world.soil.stoneAt(x + 0.5, y + 0.5) ? STONE : SOIL;
  }

  private solid(world: World, x: number, y: number): boolean {
    const m = this.material(world, x, y);
    return m === SOIL || m === STONE || m === FILL;
  }

  /** The unlit color of the cell with lower-left corner (x, y), at cache column `col` and row `r`. */
  private colorAt(world: World, col: number, r: number, x: number, y: number): number {
    const h = this.columns[col];
    const cy = y + 0.5;
    const i = r * this.width + col;
    const m = this.material(world, x, y);
    if (m === AIR) {
      // Above the ground: the heap, if it reaches this high.
      const top = h.ground + world.surface.heapAt(x + 0.5);
      if (cy > h.ground && cy <= top) {
        return this.heapColor(x, y);
      }
      return 0;
    }
    if (m === OPEN) {
      return this.hollowColor(world, h, x, y);
    }
    if (m === FILL) {
      return this.edge(world, x, y, this.packedColor(x, y));
    }
    const stone = this.stoneOf[i];
    if (m === STONE || stone >= 0) {
      if (stone >= 0 && covers(this.stones[stone], x + 0.5, cy, HIT)) {
        return this.stoneColor(HIT.nx, HIT.ny, HIT.tone, x, y);
      }
    }
    return this.edge(world, x, y, this.faceColor(h, x, y, this.marks[i]));
  }

  /** The cut face of undisturbed soil. */
  private faceColor(h: Horizons, x: number, y: number, mark: number): number {
    const cy = y + 0.5;
    const layer = horizonAt(h, cy);
    const base = layerColor(BASE, layer);
    const broad = tileNoise(x * 0.075 + 31, y * 0.075 + 7);
    const fine = tileNoise(x * 0.31 + 11, y * 0.31 + 53);
    let k = 0.86 + 0.18 * broad + 0.1 * fine;
    const grain = hash2(x * 7919 + this.seed, y);
    let c: RGB = base;
    const m = MIXED;
    if (mark === THICK_ROOT) {
      c = mixInto(m, THICK_ROOT_COLOR, base, 0.3);
      k = 0.95 + 0.1 * fine;
    } else if (mark === FINE_ROOT) {
      // Roots are paler against the dark topsoil than in the loam.
      c = mixInto(m, ROOT, base, 0.62 + 0.3 * Math.min(1, layer));
      k = 0.92 + 0.12 * fine;
    } else if (grain < 0.075) {
      // Grains of sand catch the light.
      k *= 1.17;
    } else if (grain > 0.955) {
      k *= layer < 0.7 ? 0.72 : 0.82;
    } else if (layer > 1.25) {
      // Rusty mottles and black specks in the clay.
      const rust = smoothstep(0.66, 0.8, tileNoise(x * 0.1 + 91, y * 0.1 + 13));
      c = mixInto(m, base, RUST, rust * clamp01((layer - 1.25) / 0.6) * 0.3);
      if (grain > 0.93) {
        c = mixInto(m, m, MANGANESE, 0.6);
      }
    } else if (layer < 0.6 && grain > 0.9) {
      // Bits of old plant matter in the topsoil.
      k *= 0.78;
    }
    return pack(c[0] * k, c[1] * k, c[2] * k);
  }

  /**
   * The back wall of a dug hole: the soil's color, darker and smoother,
   * shadowed under its upper lip and in its corners, lighter along its floor.
   */
  private hollowColor(world: World, h: Horizons, x: number, y: number): number {
    const layer = horizonAt(h, y + 0.5);
    // Darker soil takes the pale dust more.
    const base = mixInto(
      BASE,
      layerColor(BASE, layer),
      DUST,
      DUSTING * (1.3 - 0.3 * Math.min(1, layer)),
    );
    let k = HOLLOW * (0.94 + 0.12 * tileNoise(x * 0.09 + 3, y * 0.09 + 41));
    if (this.solid(world, x, y + 1)) {
      k *= 0.68;
    } else if (this.solid(world, x, y + 2)) {
      k *= 0.84;
    }
    if (this.solid(world, x - 1, y)) {
      k *= 0.88;
    }
    if (this.solid(world, x, y - 1)) {
      k *= 1.12;
    }
    if (this.solid(world, x + 1, y)) {
      k *= 1.03;
    }
    let near = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if ((dx !== 0 || dy !== 0) && this.solid(world, x + dx, y + dy)) {
          near++;
        }
      }
    }
    k *= 1 - near * 0.011;
    return pack(base[0] * k, base[1] * k, base[2] * k);
  }

  /** Soil packed back into a tunnel: pellets pressed together, their joins dark. */
  private packedColor(x: number, y: number): number {
    const px = Math.floor(x / 2);
    const py = Math.floor(y / 2);
    const tone = hash2(px * 31 + this.seed, py);
    const c = tone < 0.55 ? LOAM : tone < 0.8 ? LOAM_CLAY : TOPSOIL_LOAM;
    let k = 0.84 + 0.2 * hash2(px, py * 17 + this.seed);
    if (hash2(x * 13 + this.seed, y * 7) < 0.16) {
      k *= 0.62;
    }
    return pack(c[0] * k, c[1] * k, c[2] * k);
  }

  /** Loose soil heaped by the entrance: crumbs of loam and clay brought up from below. */
  private heapColor(x: number, y: number): number {
    const px = Math.floor((x + 0.5 * (y & 1)) / 2);
    const tone = hash2(px * 29 + this.seed, y * 3);
    const c = tone < 0.5 ? LOAM : tone < 0.8 ? HEAP_CLAY : HEAP_TOPSOIL;
    let k = 0.94 + 0.2 * hash2(x * 7 + this.seed, y * 11);
    if (hash2(x * 5, y * 19 + this.seed) < 0.13) {
      k *= 0.66;
    }
    return pack(c[0] * k, c[1] * k, c[2] * k);
  }

  /** A stone's cut face, shaded as a rounded lump lit from the upper left. */
  private stoneColor(nx: number, ny: number, tone: number, x: number, y: number): number {
    const c = STONES[Math.min(STONES.length - 1, Math.floor(tone * STONES.length))];
    const d2 = Math.min(1, nx * nx + ny * ny);
    const nz = Math.sqrt(1 - d2);
    const lit = Math.max(0, -0.45 * nx + 0.55 * ny + 0.7 * nz);
    let k = 0.52 + 0.55 * lit;
    k *= 0.93 + 0.12 * hash2(x * 3 + this.seed, y * 5);
    if (d2 > 0.8) {
      k *= 0.82;
    }
    return pack(c[0] * k, c[1] * k, c[2] * k);
  }

  /**
   * Where the cut face meets a hole, its edge: in shadow over a hole,
   * catching the light under one.
   */
  private edge(world: World, x: number, y: number, color: number): number {
    let k = 1;
    if (this.material(world, x, y + 1) === OPEN) {
      k = 1.08;
    } else if (this.material(world, x, y - 1) === OPEN) {
      k = 0.92;
    } else if (this.material(world, x - 1, y) === OPEN || this.material(world, x + 1, y) === OPEN) {
      k = 0.94;
    }
    if (k === 1) {
      return color;
    }
    return pack((color & 255) * k, ((color >>> 8) & 255) * k, ((color >>> 16) & 255) * k);
  }

  /**
   * Draws the cut face into `view` with the ground level at row `ground`:
   * below the ground lit by `under`, the heap above it by `above` (channel
   * multipliers); darker where the soil is wet, frosted where it is frozen.
   */
  draw(
    view: Framebuffer,
    world: World,
    ground: number,
    under: RGB,
    above: RGB,
    time: number,
  ): void {
    const data = view.data;
    const w = view.width;
    const climate = world.climate;
    const weather = world.env.weather.state;
    for (let sy = 0; sy < view.height; sy++) {
      const r = this.yTop - (ground - sy);
      if (r < 0 || r >= this.rows) {
        continue;
      }
      // Depth (mm) below the original ground of this row's middle.
      const depth = sy + 0.5 - ground;
      const moisture = depth <= 0 ? weather.wetness * 0.7 : climate.moistureAt(depth);
      const damp = 1 - 0.3 * smoothstep(0.28, 0.85, moisture);
      const ur = under[0] * damp;
      const ug = under[1] * damp;
      const ub = under[2] * damp * 0.97;
      const ar = above[0] * damp;
      const ag = above[1] * damp;
      const ab = above[2] * damp * 0.97;
      // Height of this row's middle, against the ground of each column.
      const yc = ground - sy - 0.5;
      const frozen = depth > -2 ? clamp01(-climate.temperatureAt(Math.max(0, depth)) / 3) : 0;
      const row = r * this.width;
      const out = sy * w;
      for (let sx = 0; sx < w; sx++) {
        const a = this.albedo[row + sx];
        if (a === 0) {
          continue;
        }
        const up = yc > this.columns[sx].ground;
        let red = (a & 255) * (up ? ar : ur);
        let green = ((a >>> 8) & 255) * (up ? ag : ug);
        let blue = ((a >>> 16) & 255) * (up ? ab : ub);
        if (frozen > 0) {
          // Rime: a pale, cold film with glints of ice.
          const glint =
            hash2(sx * 17 + this.seed, sy * 29 + Math.floor(time * 0.5)) < 0.06 ? 0.55 : 0.14;
          const f = frozen * glint;
          red += (225 - red) * f;
          green += (234 - green) * f;
          blue += (244 - blue) * f;
        }
        data[out + sx] = pack(red, green, blue);
      }
    }
  }
}
