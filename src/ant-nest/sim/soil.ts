import { clamp01, smoothstep } from "../../shared/core/math.ts";
import { fbm1, hash3 } from "../../shared/core/random.ts";

/** Side (mm) of the lattice cells a stone may sit in; no stone reaches past its neighbors. */
export const STONE_CELL = 22;
/** Largest radius (mm) of a stone; below half a lattice cell. */
const STONE_MAX = 10;

/** A stone in the soil: an irregular ellipse. */
export interface Stone {
  /** Stable id. */
  id: number;
  x: number;
  y: number;
  rx: number;
  ry: number;
  cos: number;
  sin: number;
  /** Lumpiness of the outline: depth and phase of its three bulges. */
  lump: number;
  phase: number;
  /** 0..1: which of the stone colors it takes. */
  tone: number;
}

/** Where a point lies on a stone, for shading its cut face. */
export interface StoneHit {
  id: number;
  /** Position within the stone's outline, -1..1 across each of its axes. */
  nx: number;
  ny: number;
  tone: number;
}

/** The depths (mm below the ground) where the topsoil gives way to loam, and loam to clay, at some x. */
export interface Horizons {
  ground: number;
  topsoil: number;
  clay: number;
}

/**
 * The ground as it lies undisturbed: the relief of its surface, the layers of
 * the soil, and the stones in it. Everything is a pure function of the seed
 * and the position, so it can be read anywhere, inside the grid or out.
 */
export class Soil {
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Height (mm) of the original ground surface at x: a gentle, lumpy relief. */
  ground(x: number): number {
    return (fbm1(x / 11, this.seed ^ 0x9a0d, 3) - 0.5) * 3.2;
  }

  /** The ground and the depths of the soil's layers at x. */
  horizons(x: number, out: Horizons): Horizons {
    out.ground = this.ground(x);
    out.topsoil = 44 + 14 * fbm1(x / 37, this.seed ^ 0x51, 3);
    out.clay = 205 + 28 * fbm1(x / 53, this.seed ^ 0x52, 3);
    return out;
  }

  /**
   * The soil horizon at a point as a continuous value: 0 in the dark topsoil,
   * 1 in the loam below it, 2 in the pale, gravelly clay deeper down.
   */
  horizon(x: number, y: number): number {
    return horizonAt(this.horizons(x, SCRATCH), y);
  }

  /**
   * How long digging takes here, relative to loam: the crumbly topsoil gives
   * easily, the clay is stiff.
   */
  hardness(x: number, y: number): number {
    const h = this.horizon(x, y);
    return h < 1 ? 0.8 + 0.3 * h : 1.1 + 0.35 * (h - 1);
  }

  /** Whether a stone lies at (x, y); if so, and `out` is given, where on it. */
  stoneAt(x: number, y: number, out?: StoneHit): boolean {
    const ci = Math.floor(x / STONE_CELL);
    const cj = Math.floor(y / STONE_CELL);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const stone = this.stone(ci + di, cj + dj);
        if (stone && covers(stone, x, y, out)) {
          return true;
        }
      }
    }
    return false;
  }

  /** The stone of lattice cell (ci, cj), or null if it has none. */
  stone(ci: number, cj: number): Stone | null {
    const seed = this.seed ^ 0x570e;
    const cy = (cj + 0.2 + 0.6 * hash3(ci, cj, seed + 2)) * STONE_CELL;
    // Stones grow commoner with depth: a few in the topsoil, many in the clay.
    const depth = -cy;
    const chance = 0.1 + 0.3 * smoothstep(40, 260, depth);
    if (depth < 8 || hash3(ci, cj, seed) >= chance) {
      return null;
    }
    const cx = (ci + 0.2 + 0.6 * hash3(ci, cj, seed + 1)) * STONE_CELL;
    const big = hash3(ci, cj, seed + 3);
    let rx = 1.4 + 4.2 * big * big;
    if (big > 0.93) {
      rx = 6 + 16 * (big - 0.93) * (STONE_MAX - 6);
    }
    rx = Math.min(STONE_MAX, rx);
    const ry = rx * (0.55 + 0.35 * hash3(ci, cj, seed + 4));
    // A stone never breaks the surface.
    if (cy + ry > this.ground(cx) - 4) {
      return null;
    }
    const angle = (hash3(ci, cj, seed + 5) - 0.5) * 1.4;
    return {
      id: (Math.imul(ci, 7919) ^ Math.imul(cj, 104729)) >>> 0,
      x: cx,
      y: cy,
      rx,
      ry,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      lump: 0.12 * (hash3(ci, cj, seed + 6) - 0.5),
      phase: big * 9,
      tone: clamp01(hash3(ci, cj, seed + 7)),
    };
  }
}

const SCRATCH: Horizons = { ground: 0, topsoil: 0, clay: 0 };

/** The horizon value (0 topsoil .. 2 clay) at height y below ground whose layers are `h`. */
export function horizonAt(h: Horizons, y: number): number {
  const depth = h.ground - y;
  return (
    smoothstep(h.topsoil - 6, h.topsoil + 6, depth) + smoothstep(h.clay - 10, h.clay + 10, depth)
  );
}

/** Whether `stone` covers (x, y); if so, and `out` is given, where on it. */
export function covers(stone: Stone, x: number, y: number, out?: StoneHit): boolean {
  const dx = x - stone.x;
  const dy = y - stone.y;
  const lx = (dx * stone.cos + dy * stone.sin) / stone.rx;
  const ly = (-dx * stone.sin + dy * stone.cos) / stone.ry;
  const d2 = lx * lx + ly * ly;
  if (d2 > 1.25) {
    return false;
  }
  // A lumpy outline rather than a clean ellipse.
  const lump = 1 + stone.lump * Math.sin(Math.atan2(ly, lx) * 3 + stone.phase);
  if (d2 > lump * lump) {
    return false;
  }
  if (out) {
    out.id = stone.id;
    out.nx = lx;
    out.ny = ly;
    out.tone = stone.tone;
  }
  return true;
}
