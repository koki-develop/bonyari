import { clamp01, cyclicBump, smoothstep } from "../../shared/core/math.ts";
import { Rng } from "../../shared/core/random.ts";
import { type Point, SURFACE_X0, SURFACE_X1 } from "./geometry.ts";
import type { Soil } from "./soil.ts";

/** Bins of the heap profile, one per millimeter of the surface. */
const BINS = SURFACE_X1 - SURFACE_X0;
/** Steepest slope loose soil holds (rise per mm). */
const REPOSE = 0.72;
/** Half-width (mm) of the hollow the ants keep open around an entrance. */
const CRATER = 3.5;
/** Share of a pellet's soil that heaps up in the cut; the rest spreads around the entrance. */
const HEAPED = 0.12;
/** In-world days over which a heap settles and spreads away. */
const SETTLE_DAYS = 36;
/** How fast rain washes a heap flatter: its spreading (mm² a day) in the heaviest rain. */
const RAIN_WASH = 4.4;

export type StemKind = "foxtail" | "grass" | "fleabane";

/** A plant rooted at the cut edge, whose stem the ants may climb. */
export interface Stem {
  x: number;
  kind: StemKind;
  /** Height (mm) when fully grown. */
  height: number;
  /** Sideways lean at the top (mm per mm of height) and the bow of its curve (mm). */
  lean: number;
  bow: number;
  /** Whether aphids live on it in the warm months. */
  aphids: boolean;
  seed: number;
}

/**
 * The ground surface along the cut: the relief of the ground, the heap of
 * soil the colony brings up (kept open where an entrance is), and the plants
 * growing along the edge.
 */
export class Surface {
  readonly soil: Soil;
  /** Loose soil (mm) heaped on the original ground, per millimeter of x. */
  readonly heap: Float32Array;
  readonly stems: readonly Stem[];
  /** Where the entrances open; the ground there is kept hollow. */
  private craters: number[] = [];

  constructor(soil: Soil, entrances: readonly number[]) {
    this.soil = soil;
    this.heap = new Float32Array(BINS);
    this.stems = plantStems(soil.seed, entrances);
  }

  /** Keeps the ground hollow around these x (the open entrances). */
  setCraters(xs: readonly number[]): void {
    this.craters = [...xs];
  }

  /** Height (mm) of the ground at x, heap included. */
  height(x: number): number {
    return this.soil.ground(x) + this.heapAt(x);
  }

  /** Loose soil (mm) heaped at x. */
  heapAt(x: number): number {
    const t = x - SURFACE_X0 - 0.5;
    const i = Math.floor(t);
    if (i < 0 || i >= BINS - 1) {
      return 0;
    }
    const f = t - i;
    return this.heap[i] * (1 - f) + this.heap[i + 1] * f;
  }

  /** Slope of the ground at x (rise per mm). */
  slope(x: number): number {
    return (this.height(x + 1) - this.height(x - 1)) / 2;
  }

  /** A pellet of `cells` mm² of soil dropped at x: it heaps and slides down to its angle of rest. */
  deposit(x: number, cells: number): void {
    const i = Math.round(x - SURFACE_X0 - 0.5);
    if (i < 2 || i >= BINS - 2) {
      return;
    }
    const amount = cells * HEAPED;
    const heap = this.heap;
    heap[i - 1] += amount * 0.25;
    heap[i] += amount * 0.5;
    heap[i + 1] += amount * 0.25;
    this.slide(i - 24, i + 24);
  }

  /** Lets the soil between bins i0 and i1 slide until no slope is steeper than it holds. */
  private slide(i0: number, i1: number): void {
    const heap = this.heap;
    const from = Math.max(1, i0);
    const to = Math.min(BINS - 2, i1);
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = from; i < to; i++) {
        const a = heap[i] + this.soil.ground(i + SURFACE_X0 + 0.5);
        const b = heap[i + 1] + this.soil.ground(i + SURFACE_X0 + 1.5);
        const excess = Math.abs(a - b) - REPOSE;
        if (excess <= 0.01) {
          continue;
        }
        // Only loose soil moves: never more than lies on the higher side.
        const high = a > b ? i : i + 1;
        const low = a > b ? i + 1 : i;
        const m = Math.min(heap[high], excess / 2);
        if (m > 0) {
          heap[high] -= m;
          heap[low] += m;
          moved = true;
        }
      }
      this.hollow();
      if (!moved) {
        break;
      }
    }
  }

  /** Moves soil out of the entrances' hollows onto their rims. */
  private hollow(): void {
    const heap = this.heap;
    for (const x of this.craters) {
      const c = Math.round(x - SURFACE_X0 - 0.5);
      for (let d = -Math.ceil(CRATER); d <= Math.ceil(CRATER); d++) {
        const i = c + d;
        if (i < 1 || i >= BINS - 1 || heap[i] <= 0) {
          continue;
        }
        // Deeper in the hollow means lower; the soil goes to the nearer rim.
        const allowed = Math.max(0, (Math.abs(d) - CRATER * 0.4) * 0.6);
        const extra = heap[i] - allowed;
        if (extra > 0) {
          heap[i] -= extra;
          const rim = c + (d < 0 ? -1 : 1) * (Math.ceil(CRATER) + 1);
          if (rim >= 0 && rim < BINS) {
            heap[rim] += extra;
          }
        }
      }
    }
  }

  /** The heap settles and spreads over `days`, faster in rain. */
  update(days: number, rain: number): void {
    const heap = this.heap;
    const decay = Math.exp(-days / SETTLE_DAYS);
    const k = Math.min(0.24, RAIN_WASH * rain * days);
    let prev = heap[0];
    for (let i = 1; i < BINS - 1; i++) {
      const cur = heap[i];
      const next = heap[i + 1];
      heap[i] = (cur + k * (prev + next - 2 * cur)) * decay;
      prev = cur;
    }
    if (rain > 0.05) {
      this.hollow();
    }
  }

  /** Height (mm) of stem k's plant now, at `yearFraction`; 0 while it is dead back in winter. */
  stemHeight(k: number, yearFraction: number): number {
    return this.stems[k].height * stemGrowth(this.stems[k].kind, yearFraction);
  }

  /** The point `s` (mm) up stem k from its foot, as tall as it is at `yearFraction`. */
  stemPoint(k: number, s: number, yearFraction: number, out: Point): Point {
    const stem = this.stems[k];
    const h = Math.max(1, this.stemHeight(k, yearFraction));
    const t = clamp01(s / h);
    const base = this.height(stem.x);
    out.x = stem.x + stem.lean * h * t * t + stem.bow * Math.sin(Math.PI * t);
    out.y = base + h * t * (1 - 0.08 * t * Math.abs(stem.lean));
    return out;
  }

  /** How many aphids (0..1 of a full colony) live on the stem at `yearFraction`. */
  aphids(k: number, yearFraction: number): number {
    if (!this.stems[k].aphids) {
      return 0;
    }
    return (
      cyclicBump(yearFraction, 0.37, 0.28, 0.06, 1) * stemGrowth(this.stems[k].kind, yearFraction)
    );
  }
}

/** How grown (0..1) a plant of `kind` is at `yearFraction` (0 = Mar 1). */
export function stemGrowth(kind: StemKind, yearFraction: number): number {
  const f = yearFraction;
  switch (kind) {
    case "foxtail":
      // Sprouts in late spring, heads out through summer, stands dry into late autumn.
      return smoothstep(0.1, 0.36, f) * (1 - smoothstep(0.72, 0.82, f));
    case "grass":
      return 0.25 + 0.75 * smoothstep(0.02, 0.28, f) * (1 - smoothstep(0.7, 0.85, f));
    case "fleabane":
      // Himejoon: grows in spring, flowers into summer, is gone by late autumn.
      return smoothstep(0.05, 0.25, f) * (1 - smoothstep(0.62, 0.74, f));
  }
}

/** The plants along the cut edge: a few, clear of the entrances; the tallest has aphids. */
function plantStems(seed: number, entrances: readonly number[]): Stem[] {
  const r = new Rng(seed ^ 0x57e3);
  const stems: Stem[] = [];
  const kinds: StemKind[] = ["foxtail", "grass", "fleabane", "grass", "foxtail", "grass"];
  for (const kind of kinds) {
    for (let tries = 0; tries < 20; tries++) {
      const x = r.range(-92, 92);
      const clearOfEntrances = entrances.every((e) => Math.abs(x - e) > 16);
      const clearOfStems = stems.every((s) => Math.abs(x - s.x) > 14);
      if (!clearOfEntrances || !clearOfStems) {
        continue;
      }
      const tall =
        kind === "foxtail"
          ? r.range(55, 80)
          : kind === "fleabane"
            ? r.range(62, 90)
            : r.range(30, 50);
      stems.push({
        x,
        kind,
        height: tall,
        lean: r.range(-0.18, 0.18),
        bow: r.range(-6, 6),
        aphids: false,
        seed: r.int(0, 1 << 30),
      });
      break;
    }
  }
  // Aphids on the fleabane if there is one, otherwise on the tallest plant.
  const host =
    stems.find((s) => s.kind === "fleabane") ??
    stems.reduce<Stem | null>((a, b) => (!a || b.height > a.height ? b : a), null);
  if (host) {
    host.aphids = true;
  }
  return stems;
}
