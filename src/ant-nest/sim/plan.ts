import { smoothstep } from "../../shared/core/math.ts";
import { hash2, noise1, Rng } from "../../shared/core/random.ts";
import {
  AIR,
  cellIndex,
  cellX,
  cellY,
  DOMAIN,
  GRID_HEIGHT,
  GRID_SIZE,
  GRID_TOP,
  GRID_WIDTH,
  GRID_X0,
  type Point,
  SOIL,
  STONE,
} from "./geometry.ts";
import { Centerline } from "./line.ts";
import type { Soil } from "./soil.ts";

export type FeatureKind = "tunnel" | "chamber";

/**
 * What a feature is for: the entrance the founding queen digs, the shafts
 * going down, the short passages to the chambers, the chambers themselves,
 * and passages that come up to the surface as further entrances.
 */
export type FeatureRole = "entrance" | "shaft" | "passage" | "chamber" | "exit";

/**
 * One tunnel or chamber of the nest as it will be when dug. Its centerline
 * starts on its parent's centerline, so walking from one into the other is
 * seamless; the entrance starts at the surface instead.
 */
export interface Feature {
  index: number;
  kind: FeatureKind;
  role: FeatureRole;
  /** The feature it branches from, or -1 for the entrance, which opens at the surface. */
  parent: number;
  /** Where on the parent it branches off; for the entrance, the x where it opens. */
  attachS: number;
  line: Centerline;
  /** Half the width (mm) of a tunnel; half the greatest height of a chamber. */
  half: number;
  /** Workers the colony needs before it starts on this feature. */
  minWorkers: number;
  /** The cells to dig out, in the order they are dug. */
  dig: Int32Array;
  /** Position (s, u) of each cell to dig. */
  digS: Float32Array;
  digU: Float32Array;
  /** Every cell of the shape, owned by this feature or an earlier one, with its (s, u). */
  shape: Int32Array;
  shapeS: Float32Array;
  shapeU: Float32Array;
  /** Bounding box of the shape in grid cells, and each box cell's index into `shape` (or -1). */
  box: { i0: number; j0: number; w: number; h: number };
  boxIndex: Int32Array;
  /** First 1 mm bin along s, and the number of bins, covering the shape. */
  binMin: number;
  bins: number;
  /** For a chamber: the height of its floor. */
  floor: number;
}

/** A place where the nest opens to the surface: an end of the entrance or of an exit. */
export interface Portal {
  feature: number;
  /** s of the opening: 0 for the entrance, the length of an exit. */
  s: number;
  x: number;
  /** The cells a plug fills, in the order they are packed, and the s range they span. */
  plug: Int32Array;
  /** How many of the plug's cells are packed when the way through is shut. */
  shut: number;
  plugS0: number;
  plugS1: number;
}

export interface Plan {
  features: Feature[];
  portals: Portal[];
}

const TUNNEL_HALF = 3.0;
/** The founding queen is broad: her entrance is wider. */
const ENTRANCE_HALF = 3.5;
const PASSAGE_HALF = 2.7;
/** Depths (mm below the ground) at which the main shaft gives onto a chamber. */
const SHAFT_STOPS = [-78, -120, -163, -207, -250, -288];
/** Depth (mm) of a plug below the surface, and its length. */
const PLUG_DEPTH = 1.5;
const PLUG_LENGTH = 8;
/** Half-width (mm) of the hole left in the middle of a plug until it is closed last. */
const PLUG_HOLE = 1.6;
/** Height (mm) of the doorway where a passage comes into a chamber. */
const DOORWAY = 5.5;

/** Turns (radians per mm) a tunnel may take while it is laid out. */
const TURNS = [-0.42, -0.24, -0.12, -0.06, 0, 0.06, 0.12, 0.24, 0.42];

/** Scratch point for sampling. */
const P: Point = { x: 0, y: 0 };

/**
 * Lays out the whole nest the colony will dig over the years, from the
 * founding queen's entrance and first chamber down to the deepest chambers,
 * steering around the stones. Features are listed in the order the colony
 * takes them on.
 */
export function generatePlan(seed: number, soil: Soil): Plan {
  return new Planner(seed, soil).build();
}

class Planner {
  private readonly r: Rng;
  private readonly soil: Soil;
  private readonly seed: number;
  /** Which feature (index + 1) each cell's shape belongs to, 0 for none. */
  private readonly owner = new Int16Array(GRID_SIZE);
  private readonly features: Feature[] = [];
  private readonly portals: Portal[] = [];

  constructor(seed: number, soil: Soil) {
    this.seed = seed;
    this.r = new Rng(seed ^ 0x9a17);
    this.soil = soil;
  }

  build(): Plan {
    const r = this.r;
    const soil = this.soil;
    // The founding queen's entrance, somewhere near the middle, and her first chamber.
    let entrance: Feature | null = null;
    for (let attempt = 0; attempt < 24 && !entrance; attempt++) {
      const xe = r.range(-24, 24);
      const slant = r.range(-0.4, 0.4);
      const depth = r.range(27, 33);
      const top = soil.ground(xe) + 3;
      const points = this.trace({ x: xe, y: top }, -Math.PI / 2 + slant, {
        half: ENTRANCE_HALF,
        maxLength: 70,
        aim: () => -Math.PI / 2 + slant,
        stop: (x, y) => y < soil.ground(x) - depth,
        ignore: [],
        free: 6,
      });
      if (points) {
        entrance = this.addTunnel("entrance", -1, xe, points, ENTRANCE_HALF, 0);
      }
    }
    if (!entrance) {
      throw new Error("no room for an entrance");
    }
    this.addPortal(entrance, 0);
    const end = entrance.line.length;
    const toCenter = entrance.line.x(end) > 0 ? -1 : 1;
    const founding =
      this.addChamber(entrance, end, toCenter, 20, 9.5, 0) ??
      this.addChamber(entrance, end, -toCenter, 19, 9, 0) ??
      this.addChamber(entrance, end, toCenter, 16, 8.5, 0);
    if (!founding) {
      throw new Error("no room for the founding chamber");
    }

    // The main shaft, going down from the foot of the entrance, with a chamber at each stop.
    const shaft: Feature[] = [];
    const chambers: Feature[] = [];
    let from = entrance;
    let fromS = end;
    // What else branches off where the next stretch starts, and may be crossed right there.
    let siblings = [founding.index];
    let side = -Math.sign(founding.line.x(founding.line.length) - founding.line.x(0)) || 1;
    const gates = [1, 8, 20, 40, 70, 100];
    for (let k = 0; k < SHAFT_STOPS.length; k++) {
      let segment = this.shaftSegment(from, fromS, SHAFT_STOPS[k], gates[k], siblings);
      // No way down from here: go on from the far end of the last chamber instead.
      const last = chambers.at(-1);
      if (!segment && last && last.index !== from.index) {
        const far = last.line.length - 3;
        segment = this.shaftSegment(last, far, SHAFT_STOPS[k], gates[k], []);
      }
      if (!segment) {
        break;
      }
      shaft.push(segment);
      from = segment;
      fromS = segment.line.length;
      siblings = [];
      const chamber = this.chamberBeside(segment, segment.line.length, side, gates[k] + 1, k);
      if (chamber) {
        chambers.push(chamber);
        siblings = [chamber.parent, chamber.index];
        side = -side;
      }
    }

    // A second way out, rising from the first chamber of the shaft.
    const first = chambers[0];
    if (first) {
      this.exitFrom(first, 30);
    }
    // A branch going down on the far side of the second chamber, with chambers of its own.
    const second = chambers[1];
    if (second) {
      this.branchFrom(second, 55);
    }
    // More chambers off the shaft, on the side left empty at each level, as the colony grows.
    shaft.forEach((segment, k) => {
      if (k > 0) {
        const s = segment.line.length * this.r.range(0.4, 0.6);
        this.chamberBeside(segment, s, k % 2 === 0 ? 1 : -1, 85 + k * 12, k + 3);
      }
    });
    return { features: this.features, portals: this.portals };
  }

  /** A stretch of the main shaft down to `stop`, wandering a little. */
  private shaftSegment(
    parent: Feature,
    attachS: number,
    stop: number,
    minWorkers: number,
    siblings: readonly number[],
  ): Feature | null {
    const start = pointOn(parent, attachS);
    // A stone in the way may stop one course; others wander around it differently.
    for (let attempt = 0; attempt < 8; attempt++) {
      const seed = this.seed ^ (0x5af7 + parent.index * 31 + attempt * 7919);
      const lean = attempt === 0 ? 0 : (attempt % 2 === 0 ? 1 : -1) * 0.12 * Math.ceil(attempt / 2);
      const points = this.trace(start, -Math.PI / 2 + lean, {
        half: TUNNEL_HALF,
        maxLength: 120,
        aim: (x, _y, s) => {
          // Keep toward the middle of the ground the colony can use.
          const pull = x > 55 ? -0.35 : x < -55 ? 0.35 : 0;
          return -Math.PI / 2 + lean + (noise1(s / 26, seed) - 0.5) * 1.1 + pull;
        },
        stop: (_x, y) => y < stop,
        ignore: [parent.index, parent.parent, ...siblings],
        free: parent.half + 6,
      });
      if (points && points.length >= 12) {
        return this.addTunnel("shaft", parent.index, attachS, points, TUNNEL_HALF, minWorkers);
      }
    }
    return null;
  }

  /**
   * A chamber off `parent` at `s`, reached by a short passage toward `side`
   * (1 right, -1 left); tries smaller chambers, and the other side, before
   * giving up.
   */
  private chamberBeside(
    parent: Feature,
    s: number,
    side: number,
    minWorkers: number,
    level: number,
  ): Feature | null {
    const r = this.r;
    const long = r.range(32, 48) + level * 2;
    const tall = r.range(10, 13);
    for (const dir of [side, -side]) {
      for (const scale of [1, 0.82, 0.66]) {
        for (const reach of [r.range(5, 11), r.range(12, 18)]) {
          const chamber = this.tryPassageAndChamber(
            parent,
            s,
            dir,
            reach,
            long * scale,
            tall * Math.min(1, 0.4 + scale * 0.6),
            minWorkers,
          );
          if (chamber) {
            return chamber;
          }
        }
      }
    }
    return null;
  }

  private tryPassageAndChamber(
    parent: Feature,
    s: number,
    dir: number,
    reach: number,
    long: number,
    tall: number,
    minWorkers: number,
  ): Feature | null {
    const q = pointOn(parent, s);
    const drop = this.r.range(0.5, 3.5);
    const entry = { x: q.x + dir * reach, y: q.y - drop };
    // The passage must be clear beyond the parent's own width.
    const steps = Math.ceil(reach);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = q.x + (entry.x - q.x) * t;
      const y = q.y + (entry.y - q.y) * t;
      if (Math.hypot(x - q.x, y - q.y) < parent.half + 2) {
        continue;
      }
      if (!this.clear(x, y, PASSAGE_HALF + 1.5, [parent.index])) {
        return null;
      }
    }
    if (!this.chamberFits(entry, dir, long, tall, [])) {
      return null;
    }
    const mid = {
      x: (q.x + entry.x) / 2,
      y: (q.y + entry.y) / 2 + this.r.range(-0.8, 0.8),
    };
    const passage = this.addTunnel(
      "passage",
      parent.index,
      s,
      [q, mid, entry],
      PASSAGE_HALF,
      minWorkers,
    );
    return this.addChamber(passage, passage.line.length, dir, long, tall, minWorkers, true);
  }

  /**
   * Whether a chamber with its entry at `entry` has room: no stones, and no
   * features but those in `ignore` (the tunnel it opens from).
   */
  private chamberFits(
    entry: Point,
    dir: number,
    long: number,
    tall: number,
    ignore: readonly number[],
  ): boolean {
    const floor = entry.y - 2.5;
    for (let t = 0; t <= long + 3; t += 1.5) {
      for (let y = floor - 3; y <= floor + tall + 3; y += 1.5) {
        if (!this.clear(entry.x + dir * t, y, 0, ignore)) {
          return false;
        }
      }
    }
    return true;
  }

  /** A passage rising from the far end of `chamber` to the surface: another way in and out. */
  private exitFrom(chamber: Feature, minWorkers: number): void {
    const soil = this.soil;
    const s = chamber.line.length - 3;
    const start = pointOn(chamber, s);
    const dir = Math.sign(chamber.line.x(chamber.line.length) - chamber.line.x(0)) || 1;
    const seed = this.seed ^ 0xe417;
    const points = this.trace(start, Math.PI / 2 - dir * 0.3, {
      half: TUNNEL_HALF,
      maxLength: 160,
      aim: (_x, _y, len) => Math.PI / 2 - dir * 0.25 + (noise1(len / 20, seed) - 0.5) * 0.7,
      stop: (x, y) => y > soil.ground(x) + 3,
      ignore: [chamber.index],
      free: 10,
      reachSurface: true,
    });
    if (!points) {
      return;
    }
    const exit = this.addTunnel("exit", chamber.index, s, points, TUNNEL_HALF, minWorkers);
    this.addPortal(exit, exit.line.length);
  }

  /** A second shaft going down from the far end of `chamber`, with chambers along it. */
  private branchFrom(chamber: Feature, minWorkers: number): void {
    const s = chamber.line.length - 3;
    const start = pointOn(chamber, s);
    const dir = Math.sign(chamber.line.x(chamber.line.length) - chamber.line.x(0)) || 1;
    const seed = this.seed ^ 0xb7a4;
    const depth = start.y - this.r.range(95, 135);
    const points = this.trace(start, -Math.PI / 2 + dir * 0.35, {
      half: TUNNEL_HALF,
      maxLength: 180,
      aim: (x, _y, len) => {
        const pull = x > 70 ? -0.4 : x < -70 ? 0.4 : 0;
        return -Math.PI / 2 + dir * 0.2 + (noise1(len / 22, seed) - 0.5) * 0.9 + pull;
      },
      stop: (_x, y) => y < depth,
      ignore: [chamber.index],
      free: 8,
    });
    if (!points || points.length < 30) {
      return;
    }
    const branch = this.addTunnel("shaft", chamber.index, s, points, TUNNEL_HALF, minWorkers);
    const len = branch.line.length;
    this.chamberBeside(branch, len * 0.5, dir, minWorkers + 10, 3);
    this.chamberBeside(branch, len, dir, minWorkers + 25, 4);
  }

  /**
   * Walks a tunnel's path a millimeter at a time, turning gently toward where
   * `aim` points and away from stones and other features ahead. Null if it
   * gets stuck before `stop` says it has arrived.
   */
  private trace(
    start: Point,
    heading: number,
    opts: {
      half: number;
      maxLength: number;
      aim: (x: number, y: number, s: number) => number;
      stop: (x: number, y: number) => boolean;
      /** Features whose cells don't count as obstacles near the start. */
      ignore: readonly number[];
      /** Distance (mm) from the start within which `ignore` applies. */
      free: number;
      /** Whether it may end above the ground (an exit). */
      reachSurface?: boolean;
    },
  ): Point[] | null {
    const points: Point[] = [{ x: start.x, y: start.y }];
    let x = start.x;
    let y = start.y;
    let angle = heading;
    const look = opts.half + 3;
    for (let s = 1; s <= opts.maxLength; s++) {
      const target = opts.aim(x, y, s);
      let best = -Infinity;
      let bestAngle = angle;
      for (const turn of TURNS) {
        const a = angle + turn;
        const qx = x + Math.cos(a) * look;
        const qy = y + Math.sin(a) * look;
        const ignore = s < opts.free ? opts.ignore : [];
        const aboveGround = opts.reachSurface === true && qy > this.soil.ground(qx) - 2;
        const ok = aboveGround || this.clear(qx, qy, opts.half + 1.2, ignore);
        // Gentle turns are free; sharp ones only to get round a stone.
        const sharp = Math.max(0, Math.abs(turn) - 0.12);
        const score = Math.cos(a - target) - 0.04 * Math.abs(turn) - 0.5 * sharp + (ok ? 0 : -5);
        if (score > best) {
          best = score;
          bestAngle = a;
        }
      }
      if (best < -3) {
        return null;
      }
      angle = bestAngle;
      x += Math.cos(angle);
      y += Math.sin(angle);
      points.push({ x, y });
      if (opts.stop(x, y)) {
        return smooth(points);
      }
    }
    return null;
  }

  /**
   * Whether a disc of radius `radius` around (x, y) is free to dig: inside
   * the colony's ground, clear of stones and of other features' shapes.
   */
  private clear(x: number, y: number, radius: number, ignore: readonly number[]): boolean {
    const samples = radius > 0 ? 8 : 0;
    for (let k = -1; k < samples; k++) {
      const px = k < 0 ? x : x + Math.cos((k / samples) * Math.PI * 2) * radius;
      const py = k < 0 ? y : y + Math.sin((k / samples) * Math.PI * 2) * radius;
      if (px < DOMAIN.x0 || px > DOMAIN.x1 || py < DOMAIN.y0) {
        return false;
      }
      if (py > this.soil.ground(px) + 1) {
        continue;
      }
      if (this.soil.stoneAt(px, py)) {
        return false;
      }
      const c = cellIndex(px, py);
      const o = c < 0 ? 0 : this.owner[c];
      if (o !== 0 && !ignore.includes(o - 1)) {
        return false;
      }
    }
    return true;
  }

  private addPortal(feature: Feature, s: number): void {
    const soil = this.soil;
    const line = feature.line;
    const x = line.x(s);
    // The plug starts a little below where the tunnel meets the ground.
    const inward = s === 0 ? 1 : -1;
    let edge = s;
    for (let k = 0; k < line.length; k++) {
      const at = s + inward * k;
      if (line.y(at) < soil.ground(line.x(at)) - PLUG_DEPTH) {
        edge = at;
        break;
      }
    }
    const s0 = Math.min(edge, edge + inward * PLUG_LENGTH);
    const s1 = Math.max(edge, edge + inward * PLUG_LENGTH);
    // Packed from the walls in, from the outside down, so the way narrows to a
    // hole in the middle that is closed last.
    const cells: { cell: number; order: number; channel: boolean }[] = [];
    for (let k = 0; k < feature.shape.length; k++) {
      const cs = feature.shapeS[k];
      const cell = feature.shape[k];
      if (cs >= s0 && cs <= s1 && this.soilCell(cell)) {
        const u = Math.abs(feature.shapeU[k]);
        const channel = u < PLUG_HOLE;
        const order =
          (channel ? 100 : 0) - u * 4 + Math.abs(cs - edge) * 0.5 + hash2(cell, this.seed) * 0.8;
        cells.push({ cell, order, channel });
      }
    }
    cells.sort((a, b) => a.order - b.order);
    this.portals.push({
      feature: feature.index,
      s,
      x,
      plug: Int32Array.from(cells, (c) => c.cell),
      shut: shutAt(cells),
      plugS0: s0,
      plugS1: s1,
    });
  }

  /** Whether a cell was undisturbed soil to begin with (not air, not stone). */
  private soilCell(cell: number): boolean {
    return baseMaterial(this.soil, cell) === SOIL;
  }

  private addTunnel(
    role: FeatureRole,
    parent: number,
    attachS: number,
    points: Point[],
    half: number,
    minWorkers: number,
  ): Feature {
    const line = Centerline.through(points);
    const index = this.features.length;
    const seed = this.seed ^ (0x7a11 + index * 977);
    const halfAt = (s: number) => half * (1 + 0.24 * (noise1(s / 4.5, seed) - 0.5));
    // Every cell within the tunnel's width of the line, with its (s, u) off the nearest segment.
    const reach = half * 1.2 + 1.5;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < line.xs.length; k++) {
      x0 = Math.min(x0, line.xs[k]);
      x1 = Math.max(x1, line.xs[k]);
      y0 = Math.min(y0, line.ys[k]);
      y1 = Math.max(y1, line.ys[k]);
    }
    const box = boxAround(x0 - reach, y0 - reach, x1 + reach, y1 + reach);
    const size = box.w * box.h;
    const bestD = new Float32Array(size).fill(Infinity);
    const bestS = new Float32Array(size);
    const bestU = new Float32Array(size);
    const n = line.xs.length;
    for (let k = 0; k < n - 1; k++) {
      const ax = line.xs[k];
      const ay = line.ys[k];
      const bx = line.xs[k + 1];
      const by = line.ys[k + 1];
      const sx = bx - ax;
      const sy = by - ay;
      const len2 = sx * sx + sy * sy || 1;
      const len = Math.sqrt(len2);
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach - GRID_X0) - box.i0);
      const i1 = Math.min(box.w - 1, Math.ceil(Math.max(ax, bx) + reach - GRID_X0) - box.i0);
      const j0 = Math.max(0, Math.floor(GRID_TOP - Math.max(ay, by) - reach) - box.j0);
      const j1 = Math.min(box.h - 1, Math.ceil(GRID_TOP - Math.min(ay, by) + reach) - box.j0);
      for (let j = j0; j <= j1; j++) {
        const cy = GRID_TOP - (box.j0 + j) - 0.5;
        for (let i = i0; i <= i1; i++) {
          const cx = GRID_X0 + box.i0 + i + 0.5;
          const dx = cx - ax;
          const dy = cy - ay;
          let t = (dx * sx + dy * sy) / len2;
          // Past the ends the tunnel is rounded off.
          const lo = k === 0 ? -Infinity : 0;
          const hi = k === n - 2 ? Infinity : 1;
          t = Math.min(hi, Math.max(lo, t));
          const tc = Math.min(1, Math.max(0, t));
          const px = ax + sx * tc;
          const py = ay + sy * tc;
          const d = Math.hypot(cx - px, cy - py);
          const b = j * box.w + i;
          if (d < bestD[b]) {
            bestD[b] = d;
            bestS[b] = k * line.step + t * len;
            bestU[b] = (sx * dy - sy * dx) / len;
          }
        }
      }
    }
    const shape: number[] = [];
    const shapeS: number[] = [];
    const shapeU: number[] = [];
    const digOrder: { cell: number; s: number; u: number; key: number }[] = [];
    const boxIndex = new Int32Array(size).fill(-1);
    for (let b = 0; b < size; b++) {
      const s = bestS[b];
      if (bestD[b] > halfAt(s)) {
        continue;
      }
      const i = box.i0 + (b % box.w);
      const j = box.j0 + Math.floor(b / box.w);
      const cell = j * GRID_WIDTH + i;
      if (baseMaterial(this.soil, cell) === STONE) {
        continue;
      }
      boxIndex[b] = shape.length;
      shape.push(cell);
      shapeS.push(s);
      shapeU.push(bestU[b]);
      if (this.owner[cell] === 0 && baseMaterial(this.soil, cell) === SOIL) {
        // The middle of the face goes first, so the tunnel's end stays rounded.
        digOrder.push({
          cell,
          s,
          u: bestU[b],
          key: s + 0.5 * Math.abs(bestU[b]) + 0.8 * hash2(cell, seed),
        });
      }
    }
    return this.register({
      index,
      kind: "tunnel",
      role,
      parent,
      attachS,
      line,
      half,
      minWorkers,
      shape,
      shapeS,
      shapeU,
      digOrder,
      box,
      boxIndex,
      floor: 0,
    });
  }

  /**
   * A chamber opening from the end of `parent` (at `attachS`) toward `dir`:
   * a flat floor under a low vault, dug outward from its entry along the
   * floor first.
   */
  private addChamber(
    parent: Feature,
    attachS: number,
    dir: number,
    long: number,
    tall: number,
    minWorkers: number,
    checked = false,
  ): Feature | null {
    const entry = pointOn(parent, attachS);
    if (!checked && !this.chamberFits(entry, dir, long, tall, [parent.index])) {
      return null;
    }
    const index = this.features.length;
    const seed = this.seed ^ (0xc4a3 + index * 613);
    const floor = entry.y - 2.5;
    const floorAt = (t: number) => floor + 0.9 * (noise1(t / 6, seed) - 0.5);
    // A low vault over the floor, with a doorway at the entry end where the passage comes in.
    const heightAt = (t: number) => {
      const q = (2 * t) / long - 1;
      const vault = tall * Math.sqrt(Math.max(0, 1 - q * q * q * q));
      const door = DOORWAY * (1 - smoothstep(DOORWAY * 0.8, DOORWAY * 1.4, t));
      return Math.max(vault, door);
    };
    const line = Centerline.through([entry, { x: entry.x + dir * long, y: entry.y }]);
    const xa = Math.min(entry.x, entry.x + dir * long) - 1;
    const xb = Math.max(entry.x, entry.x + dir * long) + 1;
    const box = boxAround(xa, floor - 2, xb, floor + tall + 2);
    const size = box.w * box.h;
    const boxIndex = new Int32Array(size).fill(-1);
    const shape: number[] = [];
    const shapeS: number[] = [];
    const shapeU: number[] = [];
    const digOrder: { cell: number; s: number; u: number; key: number }[] = [];
    for (let b = 0; b < size; b++) {
      const i = box.i0 + (b % box.w);
      const j = box.j0 + Math.floor(b / box.w);
      const cell = j * GRID_WIDTH + i;
      const x = cellX(cell);
      const y = cellY(cell);
      const t = (x - entry.x) * dir;
      if (t < 0 || t > long) {
        continue;
      }
      const f = floorAt(t);
      if (y < f || y > f + heightAt(t)) {
        continue;
      }
      if (baseMaterial(this.soil, cell) === STONE) {
        continue;
      }
      const u = (y - entry.y) * dir;
      boxIndex[b] = shape.length;
      shape.push(cell);
      shapeS.push(t);
      shapeU.push(u);
      if (this.owner[cell] === 0 && baseMaterial(this.soil, cell) === SOIL) {
        digOrder.push({
          cell,
          s: t,
          u,
          key: Math.hypot(t, 1.8 * (y - f)) + 0.8 * hash2(cell, seed),
        });
      }
    }
    return this.register({
      index,
      kind: "chamber",
      role: "chamber",
      parent: parent.index,
      attachS,
      line,
      half: tall / 2,
      minWorkers,
      shape,
      shapeS,
      shapeU,
      digOrder,
      box,
      boxIndex,
      floor,
    });
  }

  private register(f: {
    index: number;
    kind: FeatureKind;
    role: FeatureRole;
    parent: number;
    attachS: number;
    line: Centerline;
    half: number;
    minWorkers: number;
    shape: number[];
    shapeS: number[];
    shapeU: number[];
    digOrder: { cell: number; s: number; u: number; key: number }[];
    box: { i0: number; j0: number; w: number; h: number };
    boxIndex: Int32Array;
    floor: number;
  }): Feature {
    f.digOrder.sort((a, b) => a.key - b.key);
    let sMin = Infinity;
    let sMax = -Infinity;
    for (const s of f.shapeS) {
      sMin = Math.min(sMin, s);
      sMax = Math.max(sMax, s);
    }
    const binMin = Math.floor(Math.min(sMin, 0));
    const sHi = Math.max(sMax, f.line.length);
    const feature: Feature = {
      index: f.index,
      kind: f.kind,
      role: f.role,
      parent: f.parent,
      attachS: f.attachS,
      line: f.line,
      half: f.half,
      minWorkers: f.minWorkers,
      dig: Int32Array.from(f.digOrder, (d) => d.cell),
      digS: Float32Array.from(f.digOrder, (d) => d.s),
      digU: Float32Array.from(f.digOrder, (d) => d.u),
      shape: Int32Array.from(f.shape),
      shapeS: Float32Array.from(f.shapeS),
      shapeU: Float32Array.from(f.shapeU),
      box: f.box,
      boxIndex: f.boxIndex,
      binMin,
      bins: Math.ceil(sHi) - binMin + 1,
      floor: f.floor,
    };
    for (const cell of feature.shape) {
      if (this.owner[cell] === 0) {
        this.owner[cell] = f.index + 1;
      }
    }
    this.features.push(feature);
    return feature;
  }
}

/**
 * How many of a plug's cells (in packing order) are packed when the way is
 * shut: once the hole in the middle is half filled.
 */
function shutAt(cells: readonly { channel: boolean }[]): number {
  const first = cells.findIndex((c) => c.channel);
  if (first < 0) {
    return Math.max(1, cells.length);
  }
  const channel = cells.length - first;
  return first + Math.max(1, Math.ceil(channel * 0.45));
}

/** The material a cell had before any digging. */
export function baseMaterial(soil: Soil, cell: number): number {
  const x = cellX(cell);
  const y = cellY(cell);
  if (y > soil.ground(x)) {
    return AIR;
  }
  return soil.stoneAt(x, y) ? STONE : SOIL;
}

function pointOn(feature: Feature, s: number): Point {
  feature.line.point(s, 0, P);
  return { x: P.x, y: P.y };
}

function boxAround(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { i0: number; j0: number; w: number; h: number } {
  // Only what lies on the grid: above its top there is nothing but air.
  const i0 = Math.max(0, Math.floor(x0 - GRID_X0));
  const i1 = Math.min(GRID_WIDTH - 1, Math.ceil(x1 - GRID_X0));
  const j0 = Math.max(0, Math.floor(GRID_TOP - y1));
  const j1 = Math.min(GRID_HEIGHT - 1, Math.ceil(GRID_TOP - y0));
  return { i0, j0, w: i1 - i0 + 1, h: j1 - j0 + 1 };
}

/** Evens out the little zigzags of a traced path, keeping its ends where they are. */
function smooth(points: Point[]): Point[] {
  let current = points;
  for (let pass = 0; pass < 3; pass++) {
    const next = current.map((p) => ({ x: p.x, y: p.y }));
    for (let i = 1; i < current.length - 1; i++) {
      next[i].x = (current[i - 1].x + 2 * current[i].x + current[i + 1].x) / 4;
      next[i].y = (current[i - 1].y + 2 * current[i].y + current[i + 1].y) / 4;
    }
    current = next;
  }
  return current;
}
