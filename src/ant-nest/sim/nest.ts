import type { Rng } from "../../shared/core/random.ts";
import { AIR, FILL, GRID_SIZE, GRID_WIDTH, type Loc, OPEN, SOIL, SURFACE } from "./geometry.ts";
import { baseMaterial, type Feature, type Plan } from "./plan.ts";
import type { Soil } from "./soil.ts";

/** Narrowest gap (mm) an ant squeezes through. */
const MIN_PASSAGE = 2.4;
/** How much dearer a millimeter walked on the surface is than one underground, when choosing a way. */
const SURFACE_COST = 3;

/** A point on a way through the nest: walk along `f` to `s`, or step onto `f` at `s` if it is another. */
export interface Waypoint {
  f: number;
  s: number;
}

interface Edge {
  to: number;
  cost: number;
}

/**
 * The nest as dug so far: which cells are open, how far each tunnel and
 * chamber reaches, which entrances are plugged, and the ways through it.
 */
export class Nest {
  readonly soil: Soil;
  readonly plan: Plan;
  readonly features: readonly Feature[];
  /** What each cell holds now. */
  readonly material: Uint8Array;
  /** How many of each feature's cells to dig, counted from the first, are open. */
  readonly dug: Int32Array;
  /** Cells of each portal's plug that are packed, counted from the outside. */
  readonly plugs: Int32Array;
  /** For each feature and 1 mm bin along it, the lowest and highest u (mm) that is open. */
  private readonly lo: Float32Array[];
  private readonly hi: Float32Array[];
  /** How far along each feature (from its start) there is room to walk; stale when NaN. */
  private readonly reach: Float64Array;
  /** Cells dug out, not counting the air the entrance starts in. */
  openCells = 0;
  /** Cells whose look changed since the renderer last caught up; it empties this. */
  readonly changed: number[] = [];
  /** Bumped whenever the ways through the nest may have changed. */
  private version = 0;
  private graphVersion = -1;
  private nodeF: number[] = [];
  private nodeS: number[] = [];
  private edges: Edge[][] = [];
  /** Junction nodes of each feature, sorted by s. */
  private junctions: number[][] = [];
  /** The surface node of each portal. */
  private portalNodes: number[] = [];

  constructor(soil: Soil, plan: Plan) {
    this.soil = soil;
    this.plan = plan;
    this.features = plan.features;
    const material = new Uint8Array(GRID_SIZE);
    for (let c = 0; c < GRID_SIZE; c++) {
      material[c] = baseMaterial(soil, c);
    }
    this.material = material;
    this.dug = new Int32Array(plan.features.length);
    this.plugs = new Int32Array(plan.portals.length);
    this.lo = plan.features.map((f) => new Float32Array(f.bins).fill(Infinity));
    this.hi = plan.features.map((f) => new Float32Array(f.bins).fill(-Infinity));
    this.reach = new Float64Array(plan.features.length).fill(Number.NaN);
    // The air the entrance starts in is open from the first.
    for (let f = 0; f < this.features.length; f++) {
      const feature = this.features[f];
      for (let k = 0; k < feature.shape.length; k++) {
        if (material[feature.shape[k]] === AIR) {
          this.widen(f, k);
        }
      }
    }
  }

  /** Opens `cells` (as restored from a record) and packs the plugs as recorded. */
  restore(cells: Iterable<number>, plugs: readonly number[]): void {
    for (const c of cells) {
      if (c >= 0 && c < GRID_SIZE && this.material[c] === SOIL) {
        this.open(c);
      }
    }
    for (let f = 0; f < this.features.length; f++) {
      this.face(f);
    }
    plugs.forEach((n, p) => {
      if (p < this.plugs.length) {
        this.packPlug(p, n);
      }
    });
  }

  /** Every open cell, in grid order: what a record keeps. */
  openList(): number[] {
    const list: number[] = [];
    const m = this.material;
    for (let c = 0; c < GRID_SIZE; c++) {
      if (m[c] === OPEN || (m[c] === FILL && baseMaterial(this.soil, c) === SOIL)) {
        list.push(c);
      }
    }
    return list;
  }

  /** The next cell of `f` to dig, or -1 when it is all dug. Cells already open are skipped. */
  face(f: number): number {
    const feature = this.features[f];
    let k = this.dug[f];
    while (k < feature.dig.length && this.material[feature.dig[k]] !== SOIL) {
      k++;
    }
    this.dug[f] = k;
    return k < feature.dig.length ? feature.dig[k] : -1;
  }

  /** Index into `f`'s cells to dig of its face (see `face`); its length when all is dug. */
  faceIndex(f: number): number {
    this.face(f);
    return this.dug[f];
  }

  complete(f: number): boolean {
    return this.face(f) < 0;
  }

  /** Share (0..1) of `f` dug out. */
  progress(f: number): number {
    const n = this.features[f].dig.length;
    return n === 0 ? 1 : Math.min(1, this.faceIndex(f) / n);
  }

  /** Digs up to `count` cells from the face of `f`; the cells are pushed to `out`. Returns how many. */
  dig(f: number, count: number, out: number[]): number {
    let done = 0;
    while (done < count) {
      const c = this.face(f);
      if (c < 0) {
        break;
      }
      this.open(c);
      this.dug[f]++;
      out.push(c);
      done++;
    }
    return done;
  }

  private open(c: number): void {
    this.material[c] = OPEN;
    this.openCells++;
    this.changed.push(c);
    const i = c % GRID_WIDTH;
    const j = Math.floor(c / GRID_WIDTH);
    for (let f = 0; f < this.features.length; f++) {
      const b = this.features[f].box;
      const bi = i - b.i0;
      const bj = j - b.j0;
      if (bi < 0 || bj < 0 || bi >= b.w || bj >= b.h) {
        continue;
      }
      const k = this.features[f].boxIndex[bj * b.w + bi];
      if (k >= 0) {
        this.widen(f, k);
      }
    }
  }

  /** Takes shape cell `k` of feature `f` into the room there is to walk. */
  private widen(f: number, k: number): void {
    const feature = this.features[f];
    const bin = Math.floor(feature.shapeS[k]) - feature.binMin;
    const u = feature.shapeU[k];
    if (bin < 0 || bin >= feature.bins) {
      return;
    }
    this.lo[f][bin] = Math.min(this.lo[f][bin], u - 0.5);
    this.hi[f][bin] = Math.max(this.hi[f][bin], u + 0.5);
    this.reach[f] = Number.NaN;
    this.version++;
  }

  /** Packs `count` more cells of portal `p`'s plug; returns how many. */
  packPlug(p: number, count: number): number {
    const plug = this.plan.portals[p].plug;
    let done = 0;
    while (done < count && this.plugs[p] < plug.length) {
      const c = plug[this.plugs[p]++];
      if (this.material[c] === OPEN) {
        this.material[c] = FILL;
        this.changed.push(c);
      }
      done++;
    }
    if (done > 0) {
      this.version++;
    }
    return done;
  }

  /** Takes up to `count` cells out of portal `p`'s plug, the innermost first; returns how many. */
  clearPlug(p: number, count: number): number {
    const plug = this.plan.portals[p].plug;
    let done = 0;
    while (done < count && this.plugs[p] > 0) {
      const c = plug[--this.plugs[p]];
      if (this.material[c] === FILL) {
        this.material[c] = OPEN;
        this.changed.push(c);
      }
      done++;
    }
    if (done > 0) {
      this.version++;
    }
    return done;
  }

  /** Whether any soil is packed into portal `p`. */
  plugged(p: number): boolean {
    return this.plugs[p] > 0;
  }

  /** Whether portal `p`'s plug is packed far enough to shut the way through. */
  sealed(p: number): boolean {
    return this.plugs[p] >= this.plan.portals[p].shut;
  }

  /** Whether portal `p` leads out: dug through and not sealed. */
  portalOpen(p: number): boolean {
    const portal = this.plan.portals[p];
    return !this.sealed(p) && this.passable(portal.feature, portal.s);
  }

  /** Whether portal `p` is dug through, plugged or not. */
  portalDug(p: number): boolean {
    const portal = this.plan.portals[p];
    return this.passable(portal.feature, portal.s);
  }

  /** The room (mm) there is across `f` at `s`: the lowest and highest u, or null where nothing is open. */
  across(f: number, s: number): { lo: number; hi: number } | null {
    const feature = this.features[f];
    const bin = Math.floor(s) - feature.binMin;
    if (bin < 0 || bin >= feature.bins || this.hi[f][bin] < this.lo[f][bin]) {
      return null;
    }
    return { lo: this.lo[f][bin], hi: this.hi[f][bin] };
  }

  /** `u` kept at least `margin` (mm) inside the open room across `f` at `s`. */
  clampU(f: number, s: number, u: number, margin: number): number {
    const feature = this.features[f];
    const bin = Math.floor(s) - feature.binMin;
    if (bin < 0 || bin >= feature.bins) {
      return 0;
    }
    const lo = this.lo[f][bin];
    const hi = this.hi[f][bin];
    if (hi < lo) {
      return u;
    }
    if (hi - lo < margin * 2) {
      return (lo + hi) / 2;
    }
    return Math.min(hi - margin, Math.max(lo + margin, u));
  }

  /** How far along `f`, from its start, there is room to walk. */
  reachOf(f: number): number {
    const cached = this.reach[f];
    if (!Number.isNaN(cached)) {
      return cached;
    }
    const feature = this.features[f];
    const lo = this.lo[f];
    const hi = this.hi[f];
    let bin = -feature.binMin;
    let reach = -Infinity;
    while (bin < feature.bins && hi[bin] - lo[bin] >= MIN_PASSAGE) {
      reach = bin + feature.binMin + 1;
      bin++;
    }
    const value = Math.min(reach, feature.line.length);
    this.reach[f] = value;
    return value;
  }

  /** Whether one can walk to `s` along `f` from its start (which lies on its parent). */
  passable(f: number, s: number): boolean {
    return s <= 0.5 || s <= this.reachOf(f) + 0.5;
  }

  /** The plug (a portal index) that blocks the stretch [s0, s1] of `f`, or -1. */
  private plugBetween(f: number, s0: number, s1: number): number {
    const portals = this.plan.portals;
    for (let p = 0; p < portals.length; p++) {
      const portal = portals[p];
      if (portal.feature === f && this.sealed(p)) {
        const lo = Math.min(s0, s1);
        const hi = Math.max(s0, s1);
        if (hi > portal.plugS0 && lo < portal.plugS1) {
          return p;
        }
      }
    }
    return -1;
  }

  /** Whether one can walk along `f` from `s0` to `s1`. */
  walkable(f: number, s0: number, s1: number): boolean {
    return (
      Math.min(s0, s1) >= -0.5 &&
      this.passable(f, Math.max(s0, s1)) &&
      this.plugBetween(f, s0, s1) < 0
    );
  }

  /** A random place to stand inside feature `f`, kept `margin` from its walls; null if none is open. */
  spot(f: number, r: Rng, margin: number): Loc | null {
    const feature = this.features[f];
    const n = feature.shape.length;
    const reach = this.reachOf(f);
    for (let tries = 0; tries < 24; tries++) {
      const k = Math.floor(r.next() * n);
      const cell = feature.shape[k];
      const s = feature.shapeS[k];
      if (this.material[cell] !== OPEN || s < 0.5 || s > reach) {
        continue;
      }
      return { f, s, u: this.clampU(f, s, feature.shapeU[k], margin) };
    }
    return null;
  }

  /**
   * The way from `from` to `to` through the open nest and, where it must, over
   * the surface between entrances; null if there is none. The first
   * waypoint is where `from` is.
   */
  route(from: Loc, to: Loc): Waypoint[] | null {
    this.buildGraph();
    const count = this.nodeF.length;
    const start = count;
    const end = count + 1;
    const dist = new Float64Array(count + 2).fill(Infinity);
    const prev = new Int32Array(count + 2).fill(-1);
    const done = new Uint8Array(count + 2);
    const startEdges = this.attach(from);
    const endEdges = new Map<number, number>();
    for (const e of this.attach(to)) {
      endEdges.set(e.to, e.cost);
    }
    // Straight there, when both ends are on the same open stretch.
    let direct = Infinity;
    if (from.f === to.f) {
      if (from.f === SURFACE) {
        direct = Math.abs(to.s - from.s) * SURFACE_COST;
      } else if (from.f >= 0 && this.walkable(from.f, from.s, to.s)) {
        direct = Math.abs(to.s - from.s);
      }
    }
    dist[start] = 0;
    for (;;) {
      let best = -1;
      let bestD = Infinity;
      for (let n = 0; n < count + 1; n++) {
        if (!done[n] && dist[n] < bestD) {
          bestD = dist[n];
          best = n;
        }
      }
      if (best < 0 || bestD >= Math.min(direct, dist[end])) {
        break;
      }
      done[best] = 1;
      const edges = best === start ? startEdges : this.edges[best];
      for (const e of edges) {
        const d = bestD + e.cost;
        if (d < dist[e.to]) {
          dist[e.to] = d;
          prev[e.to] = best;
        }
      }
      const last = endEdges.get(best);
      if (last !== undefined && bestD + last < dist[end]) {
        dist[end] = bestD + last;
        prev[end] = best;
      }
    }
    if (direct <= dist[end]) {
      return Number.isFinite(direct)
        ? [
            { f: from.f, s: from.s },
            { f: to.f, s: to.s },
          ]
        : null;
    }
    if (!Number.isFinite(dist[end])) {
      return null;
    }
    const nodes: number[] = [];
    for (let n = prev[end]; n !== start && n >= 0; n = prev[n]) {
      nodes.push(n);
    }
    nodes.reverse();
    const way: Waypoint[] = [{ f: from.f, s: from.s }];
    for (const n of nodes) {
      way.push({ f: this.nodeF[n], s: this.nodeS[n] });
    }
    way.push({ f: to.f, s: to.s });
    return way;
  }

  /** Edges from a place to the graph: the junctions it can walk to along its feature. */
  private attach(loc: Loc): Edge[] {
    const edges: Edge[] = [];
    if (loc.f === SURFACE) {
      this.portalNodes.forEach((n) => {
        if (n >= 0) {
          edges.push({ to: n, cost: Math.abs(this.nodeS[n] - loc.s) * SURFACE_COST });
        }
      });
      return edges;
    }
    if (loc.f < 0) {
      return edges;
    }
    const list = this.junctions[loc.f];
    // The nearest junction on each side that is reachable along the feature.
    let below = -1;
    let above = -1;
    for (const n of list) {
      const s = this.nodeS[n];
      if (s <= loc.s) {
        below = n;
      } else if (above < 0) {
        above = n;
      }
    }
    for (const n of [below, above]) {
      if (n >= 0 && this.walkable(loc.f, loc.s, this.nodeS[n])) {
        edges.push({ to: n, cost: Math.abs(this.nodeS[n] - loc.s) });
      }
    }
    return edges;
  }

  /** The junctions of the nest and the open ways between them; rebuilt when the nest changes. */
  private buildGraph(): void {
    if (this.graphVersion === this.version) {
      return;
    }
    this.graphVersion = this.version;
    const features = this.features;
    const portals = this.plan.portals;
    const nodeF: number[] = [];
    const nodeS: number[] = [];
    const junctions: number[][] = features.map(() => []);
    const nodeAt = (f: number, s: number): number => {
      for (const n of junctions[f]) {
        if (Math.abs(nodeS[n] - s) < 1e-6) {
          return n;
        }
      }
      nodeF.push(f);
      nodeS.push(s);
      junctions[f].push(nodeF.length - 1);
      return nodeF.length - 1;
    };
    const links: [number, number, number][] = [];
    for (const f of features) {
      const own = nodeAt(f.index, 0);
      if (f.parent >= 0) {
        const there = nodeAt(f.parent, f.attachS);
        if (this.passable(f.parent, f.attachS)) {
          links.push([own, there, 0]);
        }
      }
    }
    const portalNodes: number[] = [];
    portals.forEach((portal, p) => {
      const inside = nodeAt(portal.feature, portal.s);
      nodeF.push(SURFACE);
      nodeS.push(portal.x);
      const outside = nodeF.length - 1;
      portalNodes.push(outside);
      if (this.portalOpen(p)) {
        links.push([inside, outside, 0]);
      }
    });
    const edges: Edge[][] = nodeF.map(() => []);
    for (const [a, b, cost] of links) {
      edges[a].push({ to: b, cost });
      edges[b].push({ to: a, cost });
    }
    for (let f = 0; f < features.length; f++) {
      const list = junctions[f];
      list.sort((a, b) => nodeS[a] - nodeS[b]);
      for (let k = 0; k + 1 < list.length; k++) {
        const a = list[k];
        const b = list[k + 1];
        if (this.walkable(f, nodeS[a], nodeS[b])) {
          const cost = nodeS[b] - nodeS[a];
          edges[a].push({ to: b, cost });
          edges[b].push({ to: a, cost });
        }
      }
    }
    // Between entrances over the surface.
    const outside = [...portalNodes].sort((a, b) => nodeS[a] - nodeS[b]);
    for (let k = 0; k + 1 < outside.length; k++) {
      const a = outside[k];
      const b = outside[k + 1];
      const cost = (nodeS[b] - nodeS[a]) * SURFACE_COST;
      edges[a].push({ to: b, cost });
      edges[b].push({ to: a, cost });
    }
    this.nodeF = nodeF;
    this.nodeS = nodeS;
    this.edges = edges;
    this.junctions = junctions;
    this.portalNodes = portalNodes;
  }
}
