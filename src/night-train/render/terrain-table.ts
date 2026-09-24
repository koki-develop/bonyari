import { makeTerrainScratch, type Route } from "../sim/route.ts";

const STEP = 6;
/** Half-width (m) of the sampled window around the train. */
const RANGE = 14000;
const SIZE = Math.ceil((2 * RANGE) / STEP) + 4;

/**
 * Terrain sampled on a regular along-track grid around the train, so per-pixel
 * passes can look it up instead of filtering sections for every pixel. Samples
 * live in a ring buffer keyed by absolute grid index and are computed only as
 * the window slides forward.
 */
export class TerrainTable {
  readonly shore = new Float32Array(SIZE);
  readonly road = new Float32Array(SIZE);
  readonly fields = new Float32Array(SIZE);
  readonly houses = new Float32Array(SIZE);
  readonly apartments = new Float32Array(SIZE);
  readonly forest = new Float32Array(SIZE);
  readonly pines = new Float32Array(SIZE);
  readonly doubleTrack = new Float32Array(SIZE);
  readonly elevation = new Float32Array(SIZE);
  readonly barrier = new Float32Array(SIZE);
  private readonly scratch = makeTerrainScratch();
  /** Grid indices currently held: [first, last]. */
  private first = 0;
  private last = -1;

  update(route: Route, pos: number): void {
    const center = Math.floor(pos / STEP);
    const lo = center - Math.floor(RANGE / STEP);
    const hi = center + Math.floor(RANGE / STEP);
    if (this.last < this.first || lo > this.last || hi < this.first) {
      this.first = lo;
      this.last = lo - 1;
    }
    // The train only moves forward, so the window only grows at the end.
    for (let k = this.last + 1; k <= hi; k++) {
      this.compute(route, k);
    }
    this.last = Math.max(this.last, hi);
    this.first = Math.max(this.first, lo);
  }

  private compute(route: Route, k: number): void {
    const along = k * STEP;
    const t = route.terrain(along, this.scratch);
    const i = ring(k);
    this.shore[i] = Math.min(1e9, route.shoreAt(t, along));
    this.road[i] = Math.min(1e9, route.roadAt(t, along));
    this.fields[i] = t.fields;
    this.houses[i] = t.houses;
    this.apartments[i] = t.apartments;
    this.forest[i] = t.forest;
    this.pines[i] = t.pines;
    this.doubleTrack[i] = t.doubleTrack;
    this.elevation[i] = route.elevationAt(along, t);
    this.barrier[i] = t.barrier;
  }

  /** Nearest sample of a table at `along` (clamped to the held window). */
  at(table: Float32Array, along: number): number {
    let k = Math.round(along / STEP);
    k = k < this.first ? this.first : k > this.last ? this.last : k;
    return table[ring(k)];
  }

  /** Linearly interpolated sample of a table at `along`. */
  sample(table: Float32Array, along: number): number {
    let f = along / STEP;
    f = f < this.first ? this.first : f > this.last - 1 ? this.last - 1 : f;
    const k = Math.floor(f);
    const t = f - k;
    const a = table[ring(k)];
    return a + (table[ring(k + 1)] - a) * t;
  }
}

function ring(k: number): number {
  const r = k % SIZE;
  return r < 0 ? r + SIZE : r;
}
