import type { BuildingKind } from "./buildings.ts";
import { inPolygon, inRect } from "./geometry.ts";
import type { Plan } from "./plan.ts";
import { type Point, type Terrain, WORLD } from "./terrain.ts";
import type { Town } from "./town.ts";

/** Meters between the cells of the grid of regions, and of the buckets nodes are found by. */
const CELL = 1;
const CELLS_W = Math.ceil((WORLD.x1 - WORLD.x0) / CELL);
const CELLS_H = Math.ceil((WORLD.y1 - WORLD.y0) / CELL);
const BUCKET = 8;
const BUCKETS_W = Math.ceil((WORLD.x1 - WORLD.x0) / BUCKET);
const BUCKETS_H = Math.ceil((WORLD.y1 - WORLD.y0) / BUCKET);
/** Region code of water in the grid: a region of its own, never walked into straight. */
const WATER = 4;
/**
 * What is walked into or under rather than round: tents round a fire, the
 * well, the yards and the pit, the smithy's open front, the ring of wall
 * (the wall line has its own regions; gates are passed through) and bridges.
 */
const OPEN_KINDS: ReadonlySet<BuildingKind> = new Set([
  "camp",
  "well",
  "quarry",
  "lumberyard",
  "smithy",
  "palisade",
  "wall",
  "tower",
  "woodgate",
  "gatehouse",
  "bridge",
  "stonebridge",
]);
/** How much farther (m) than the nearest node a node reached without passing through a building may be. */
const OPEN_NODE_REACH = 25;
/** Meters between the points looked at along a way for the river, and how far up the bank from the water the way then keeps. */
const BANK_STEP = 2;
const BANK_KEEP = 1.5;
/** Meters from the ford's middle that a way into or out of it may wade. */
const FORD_WADE = 9;
/** Meters in from a footprint's edge that still count as open ground, so eaves are brushed past. */
const EAVES = 0.3;

/**
 * Finding the way: along the streets, from the node nearest where one is to
 * the node nearest where one is going, then straight on. Streets not yet
 * built can still be walked, only slower going; the ford is slower still
 * until a bridge spans it.
 *
 * The land is cut into regions by the river and the line of the wall: a
 * straight walk off the streets never leaves the region it starts in, so no
 * one wades the river or passes through the wall except by a street.
 */
export class Navigator {
  private readonly plan: Plan;
  private readonly terrain: Terrain;
  private readonly town: Town;
  /** Region of each node. */
  private readonly regions: Uint8Array;
  /** Region of each cell of the world (see `region`), or `WATER`. */
  private readonly grid: Uint8Array;
  /** The nodes in each bucket of the world. */
  private readonly buckets: number[][];
  /** The building (its id + 1) that takes up each cell of the world, or 0 (see `refreshSolid`). */
  private readonly solid: Int32Array;
  /** The town's `version` the solid cells were worked out for. */
  private solidFor = -1;
  // Scratch for the searches.
  private readonly dist: Float64Array;
  private readonly prev: Int32Array;
  private readonly heap: Int32Array;
  private readonly heapKey: Float64Array;
  /** Whether a bridge spans the ford, so it is walked at ordinary pace. */
  bridged = false;

  constructor(plan: Plan, terrain: Terrain, town: Town) {
    this.plan = plan;
    this.terrain = terrain;
    this.town = town;
    const n = plan.nodes.length;
    this.grid = new Uint8Array(CELLS_W * CELLS_H);
    for (let j = 0; j < CELLS_H; j++) {
      const y = WORLD.y0 + (j + 0.5) * CELL;
      for (let i = 0; i < CELLS_W; i++) {
        const x = WORLD.x0 + (i + 0.5) * CELL;
        const bank = terrain.riverOffset(x, y) > 0 ? 1 : 0;
        const inside = inPolygon(x, y, plan.wall.points) ? 2 : 0;
        this.grid[j * CELLS_W + i] = terrain.isWater(x, y) ? WATER : bank + inside;
      }
    }
    this.solid = new Int32Array(CELLS_W * CELLS_H);
    this.regions = new Uint8Array(n);
    this.buckets = Array.from({ length: BUCKETS_W * BUCKETS_H }, () => []);
    plan.nodes.forEach((node, i) => {
      this.regions[i] = this.exactRegion(node.x, node.y);
      this.buckets[this.bucketOf(node.x, node.y)].push(i);
    });
    this.dist = new Float64Array(n);
    this.prev = new Int32Array(n);
    this.heap = new Int32Array(plan.edges.length * 2 + n + 8);
    this.heapKey = new Float64Array(plan.edges.length * 2 + n + 8);
  }

  /** Which side of the river and of the wall line (x, y) is on, worked out exactly. */
  private exactRegion(x: number, y: number): number {
    const bank = this.terrain.riverOffset(x, y) > 0 ? 1 : 0;
    const inside = inPolygon(x, y, this.plan.wall.points) ? 2 : 0;
    return bank + inside;
  }

  /** The grid's cell under (x, y): the region, or `WATER`. */
  private cell(x: number, y: number): number {
    const i = Math.floor((x - WORLD.x0) / CELL);
    const j = Math.floor((y - WORLD.y0) / CELL);
    if (i < 0 || j < 0 || i >= CELLS_W || j >= CELLS_H) {
      return this.exactRegion(x, y);
    }
    return this.grid[j * CELLS_W + i];
  }

  /** Marks again the cells buildings stand on, if the town has changed since they were last marked. */
  private refreshSolid(): void {
    if (this.solidFor === this.town.version) {
      return;
    }
    this.solidFor = this.town.version;
    const solid = this.solid;
    solid.fill(0);
    for (const b of this.town.buildings) {
      if (b.phase === "clearing" || OPEN_KINDS.has(b.kind)) {
        continue;
      }
      const r = b.rect;
      const reach = (r.width + r.depth) / 2;
      const i0 = Math.max(0, Math.floor((r.x - reach - WORLD.x0) / CELL));
      const i1 = Math.min(CELLS_W - 1, Math.floor((r.x + reach - WORLD.x0) / CELL));
      const j0 = Math.max(0, Math.floor((r.y - reach - WORLD.y0) / CELL));
      const j1 = Math.min(CELLS_H - 1, Math.floor((r.y + reach - WORLD.y0) / CELL));
      for (let j = j0; j <= j1; j++) {
        const y = WORLD.y0 + (j + 0.5) * CELL;
        for (let i = i0; i <= i1; i++) {
          if (inRect(r, WORLD.x0 + (i + 0.5) * CELL, y, -EAVES)) {
            solid[j * CELLS_W + i] = b.id + 1;
          }
        }
      }
    }
  }

  /** The id of the building standing at (x, y), or -1 where the ground is open. */
  private solidAt(x: number, y: number): number {
    const i = Math.floor((x - WORLD.x0) / CELL);
    const j = Math.floor((y - WORLD.y0) / CELL);
    if (i < 0 || j < 0 || i >= CELLS_W || j >= CELLS_H) {
      return -1;
    }
    return this.solid[j * CELLS_W + i] - 1;
  }

  /** Whether one can stand at (x, y): on land in the world, and not inside a building. */
  standable(x: number, y: number): boolean {
    if (x < WORLD.x0 || x > WORLD.x1 || y < WORLD.y0 || y > WORLD.y1) {
      return false;
    }
    this.refreshSolid();
    return this.cell(x, y) !== WATER && this.solidAt(x, y) < 0;
  }

  /** Which side of the river and of the wall line (x, y) is on. */
  region(x: number, y: number): number {
    const c = this.cell(x, y);
    return c === WATER
      ? (this.terrain.riverOffset(x, y) > 0 ? 1 : 0) +
          (inPolygon(x, y, this.plan.wall.points) ? 2 : 0)
      : c;
  }

  private bucketOf(x: number, y: number): number {
    const i = Math.min(BUCKETS_W - 1, Math.max(0, Math.floor((x - WORLD.x0) / BUCKET)));
    const j = Math.min(BUCKETS_H - 1, Math.max(0, Math.floor((y - WORLD.y0) / BUCKET)));
    return j * BUCKETS_W + i;
  }

  /**
   * The node nearest (x, y) that can be walked to straight from it: looked
   * for ring by ring of buckets outward, until no nearer one can be left.
   */
  nearestNode(x: number, y: number): number {
    const region = this.region(x, y);
    const nodes = this.plan.nodes;
    const ci = Math.min(BUCKETS_W - 1, Math.max(0, Math.floor((x - WORLD.x0) / BUCKET)));
    const cj = Math.min(BUCKETS_H - 1, Math.max(0, Math.floor((y - WORLD.y0) / BUCKET)));
    let best = -1;
    let bestD = Infinity;
    let fallback = -1;
    let fallbackD = Infinity;
    const most = Math.max(BUCKETS_W, BUCKETS_H);
    for (let ring = 0; ring <= most; ring++) {
      // Everything in this ring is at least this far off.
      const near = Math.max(0, ring - 1) * BUCKET;
      if (best >= 0 && near * near > bestD) {
        break;
      }
      for (let j = cj - ring; j <= cj + ring; j++) {
        if (j < 0 || j >= BUCKETS_H) {
          continue;
        }
        const edge = j === cj - ring || j === cj + ring;
        for (let i = ci - ring; i <= ci + ring; i += edge ? 1 : ring * 2 || 1) {
          if (i < 0 || i >= BUCKETS_W) {
            continue;
          }
          for (const k of this.buckets[j * BUCKETS_W + i]) {
            const d = (nodes[k].x - x) ** 2 + (nodes[k].y - y) ** 2;
            if (this.regions[k] === region && d < bestD) {
              bestD = d;
              best = k;
            }
            if (d < fallbackD) {
              fallbackD = d;
              fallback = k;
            }
          }
        }
      }
    }
    return best >= 0 ? best : fallback;
  }

  /**
   * The nearest node that can be walked to straight from (x, y) without
   * passing through a building, among those not much farther than the
   * nearest; the nearest if none can.
   */
  private openNode(x: number, y: number): number {
    const nearest = this.nearestNode(x, y);
    const nodes = this.plan.nodes;
    if (this.clear(x, y, nodes[nearest].x, nodes[nearest].y)) {
      return nearest;
    }
    const region = this.regions[nearest];
    const reach = Math.hypot(nodes[nearest].x - x, nodes[nearest].y - y) + OPEN_NODE_REACH;
    const ci = Math.floor((x - WORLD.x0) / BUCKET);
    const cj = Math.floor((y - WORLD.y0) / BUCKET);
    const span = Math.ceil(reach / BUCKET);
    let best = -1;
    let bestD = Infinity;
    for (let j = Math.max(0, cj - span); j <= Math.min(BUCKETS_H - 1, cj + span); j++) {
      for (let i = Math.max(0, ci - span); i <= Math.min(BUCKETS_W - 1, ci + span); i++) {
        for (const k of this.buckets[j * BUCKETS_W + i]) {
          const d = Math.hypot(nodes[k].x - x, nodes[k].y - y);
          if (
            this.regions[k] === region &&
            d < bestD &&
            d <= reach &&
            this.clear(x, y, nodes[k].x, nodes[k].y)
          ) {
            bestD = d;
            best = k;
          }
        }
      }
    }
    return best >= 0 ? best : nearest;
  }

  /** Cost of walking an edge: its length, more on unbuilt ways and through the water. */
  private cost(e: number): number {
    const edge = this.plan.edges[e];
    let k = this.town.streetGrade[edge.street] === 0 ? 2.2 : 1;
    if (edge.ford && !this.bridged) {
      k *= 3;
    }
    return edge.length * k;
  }

  /** The nodes along the cheapest way from node `from` to node `to`, both included. */
  route(from: number, to: number): number[] {
    if (from === to) {
      return [from];
    }
    const plan = this.plan;
    const dist = this.dist;
    const prev = this.prev;
    dist.fill(Infinity);
    prev.fill(-1);
    dist[from] = 0;
    let size = 0;
    const heap = this.heap;
    const key = this.heapKey;
    const push = (node: number, k: number) => {
      let i = size++;
      heap[i] = node;
      key[i] = k;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (key[p] <= key[i]) {
          break;
        }
        [heap[p], heap[i]] = [heap[i], heap[p]];
        [key[p], key[i]] = [key[i], key[p]];
        i = p;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      size--;
      heap[0] = heap[size];
      key[0] = key[size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < size && key[l] < key[m]) {
          m = l;
        }
        if (r < size && key[r] < key[m]) {
          m = r;
        }
        if (m === i) {
          break;
        }
        [heap[m], heap[i]] = [heap[i], heap[m]];
        [key[m], key[i]] = [key[i], key[m]];
        i = m;
      }
      return top;
    };
    push(from, 0);
    while (size > 0) {
      const d0 = key[0];
      const node = pop();
      if (d0 > dist[node]) {
        continue;
      }
      if (node === to) {
        break;
      }
      for (const e of plan.adjacency[node]) {
        const edge = plan.edges[e];
        const other = edge.a === node ? edge.b : edge.a;
        const d = d0 + this.cost(e);
        if (d < dist[other]) {
          dist[other] = d;
          prev[other] = node;
          push(other, d);
        }
      }
    }
    if (prev[to] < 0) {
      return [from];
    }
    const out: number[] = [];
    for (let n = to; n >= 0; n = prev[n]) {
      out.push(n);
      if (n === from) {
        break;
      }
    }
    return out.reverse();
  }

  /**
   * The points to walk from (x, y) to (tx, ty): straight on if they are close
   * and on the same side of everything, otherwise out to the streets, along
   * them, and off them again.
   */
  path(x: number, y: number, tx: number, ty: number): Point[] {
    const direct = Math.hypot(tx - x, ty - y);
    const open = this.clear(x, y, tx, ty);
    if (open && direct < 40) {
      return [{ x: tx, y: ty }];
    }
    const a = this.openNode(x, y);
    const b = this.openNode(tx, ty);
    const nodes = this.route(a, b);
    const out: Point[] = [];
    // Off the streets and back onto them along the bank, where a bend of the river lies across the straight way.
    const first = this.plan.nodes[a];
    out.push(...this.byTheBank(x, y, first.x, first.y));
    let length = Math.hypot(this.plan.nodes[a].x - x, this.plan.nodes[a].y - y);
    for (const n of nodes) {
      const node = this.plan.nodes[n];
      const last = out[out.length - 1];
      if (last) {
        length += Math.hypot(node.x - last.x, node.y - last.y);
      }
      out.push({ x: node.x, y: node.y });
    }
    length += Math.hypot(tx - out[out.length - 1].x, ty - out[out.length - 1].y);
    // Across open ground rather than a long way round by the streets.
    if (open && length > direct * 1.35) {
      return [{ x: tx, y: ty }];
    }
    const last = out[out.length - 1];
    out.push(...this.byTheBank(last.x, last.y, tx, ty), { x: tx, y: ty });
    return out;
  }

  /**
   * The points to go by between (x, y) and (tx, ty) so as to keep out of
   * the river where a bend of it lies across the straight way: wherever that
   * way is in the water, a point on the bank instead. None where the way is
   * dry. An end in the water is the ford: it is waded near there, and the
   * bank of the dry end kept to beyond.
   */
  private byTheBank(x: number, y: number, tx: number, ty: number): Point[] {
    const t = this.terrain;
    const wetStart = this.cell(x, y) === WATER;
    const wetEnd = this.cell(tx, ty) === WATER;
    if (wetStart && wetEnd) {
      return [];
    }
    const dry = wetEnd ? { x, y } : { x: tx, y: ty };
    const side = t.riverOffset(dry.x, dry.y) > 0 ? 1 : -1;
    const d = Math.hypot(tx - x, ty - y);
    const steps = Math.ceil(d / BANK_STEP);
    const out: Point[] = [];
    for (let k = 1; k < steps; k++) {
      const along = (d * k) / steps;
      if ((wetStart && along < FORD_WADE) || (wetEnd && d - along < FORD_WADE)) {
        continue;
      }
      const px = x + ((tx - x) * k) / steps;
      const py = y + ((ty - y) * k) / steps;
      if (Math.abs(t.riverOffset(px, py)) < t.riverHalfWidth(py) + 0.5) {
        out.push(t.bankPoint(py, side, BANK_KEEP));
      }
    }
    return out;
  }

  /**
   * Whether the straight way from (x, y) to (tx, ty) is open: on one side of
   * the river, not through the line of the wall, and through no building
   * (but the ones it starts or ends in, to be walked out of or into).
   */
  clear(x: number, y: number, tx: number, ty: number): boolean {
    const region = this.region(x, y);
    if (region !== this.region(tx, ty)) {
      return false;
    }
    this.refreshSolid();
    const from = this.solidAt(x, y);
    const to = this.solidAt(tx, ty);
    const d = Math.hypot(tx - x, ty - y);
    // Half a cell at a time, so a corner of a building is not stepped over.
    const steps = Math.ceil((d / CELL) * 2);
    for (let k = 1; k < steps; k++) {
      const px = x + ((tx - x) * k) / steps;
      const py = y + ((ty - y) * k) / steps;
      if (this.cell(px, py) !== region) {
        return false;
      }
      const b = this.solidAt(px, py);
      if (b >= 0 && b !== from && b !== to) {
        return false;
      }
    }
    return true;
  }

  /** Whether walking the segment from a to b wades the river (off a bridge). */
  wading(ax: number, ay: number, bx: number, by: number): boolean {
    if (this.bridged) {
      return false;
    }
    const t = this.terrain;
    return t.isWater((ax + bx) / 2, (ay + by) / 2);
  }
}
