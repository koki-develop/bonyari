/** Integer hash (lowbias32) returning an unsigned 32-bit value. */
export function hashU32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Stable hash of several integers, mapped to [0, 1). */
export function hash(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = hashU32(h ^ hashU32(Math.floor(p) | 0));
  }
  return h / 4294967296;
}

/** Hash of two integers mapped to [0, 1); the allocation-free hot-path variant of `hash`. */
export function hash2(a: number, b: number): number {
  return hashU32(hashU32(a | 0) ^ Math.imul(b | 0, 0x27d4eb2d)) / 4294967296;
}

/** Hash of three integers mapped to [0, 1). */
export function hash3(a: number, b: number, c: number): number {
  return (
    hashU32(hashU32(hashU32(a | 0) ^ Math.imul(b | 0, 0x27d4eb2d)) ^ Math.imul(c | 0, 0x165667b1)) /
    4294967296
  );
}

/** Seeded PRNG (mulberry32). */
export class Rng {
  private current: number;

  constructor(seed: number) {
    this.current = seed >>> 0;
  }

  /** Position in the sequence; `new Rng(rng.state)` continues exactly where this one is. */
  get state(): number {
    return this.current;
  }

  next(): number {
    this.current = (this.current + 0x6d2b79f5) >>> 0;
    let t = this.current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hiInclusive: number): number {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Picks a key with probability proportional to its weight. */
  weighted<K extends string>(weights: Readonly<Partial<Record<K, number>>>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let r = this.next() * total;
    for (const [key, w] of entries) {
      r -= w;
      if (r < 0) {
        return key;
      }
    }
    return entries[entries.length - 1][0];
  }
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 1D value noise in [0, 1]. */
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash2(i, seed);
  const b = hash2(i + 1, seed);
  return a + (b - a) * smooth(f);
}

/** 1D fractal noise in [0, 1]. */
export function fbm1(x: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(x * freq, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** 2D value noise in [0, 1], optionally periodic in both axes. */
export function noise2(x: number, y: number, seed: number, period = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  let x0 = ix;
  let x1 = ix + 1;
  let y0 = iy;
  let y1 = iy + 1;
  if (period > 0) {
    x0 = ((x0 % period) + period) % period;
    x1 = ((x1 % period) + period) % period;
    y0 = ((y0 % period) + period) % period;
    y1 = ((y1 % period) + period) % period;
  }
  const a = hash3(x0, y0, seed);
  const b = hash3(x1, y0, seed);
  const c = hash3(x0, y1, seed);
  const d = hash3(x1, y1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/** Side (cells) of the precomputed tile behind `tileNoise`. */
const TILE = 256;
const TILE_NOISE = (() => {
  const t = new Float32Array(TILE * TILE);
  for (let i = 0; i < t.length; i++) {
    t[i] = hash2(i, 0x5a17);
  }
  return t;
})();

/**
 * Smooth value noise in [0, 1], tiling every 256 units: a cheap stand-in for
 * `noise2` in per-pixel loops.
 */
export function tileNoise(u: number, v: number): number {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  let fu = u - iu;
  let fv = v - iv;
  fu = fu * fu * (3 - 2 * fu);
  fv = fv * fv * (3 - 2 * fv);
  const x0 = iu & (TILE - 1);
  const x1 = (iu + 1) & (TILE - 1);
  const y0 = (iv & (TILE - 1)) * TILE;
  const y1 = ((iv + 1) & (TILE - 1)) * TILE;
  const a = TILE_NOISE[y0 + x0];
  const b = TILE_NOISE[y0 + x1];
  const c = TILE_NOISE[y1 + x0];
  const d = TILE_NOISE[y1 + x1];
  const top = a + (b - a) * fu;
  return top + (c + (d - c) * fu - top) * fv;
}
