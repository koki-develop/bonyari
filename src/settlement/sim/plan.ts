import { TAU } from "../../shared/core/math.ts";
import { Rng } from "../../shared/core/random.ts";
import {
  alongPolyline,
  facing,
  inPolygon,
  inRect,
  polygonEdgeDistance,
  polylineDistance,
  polylineLength,
  type Rect,
  rectCorners,
  rectNearPolyline,
  rectPoint,
  rectsOverlap,
  segmentsCross,
  spline,
  stationOf,
} from "./geometry.ts";
import { type Point, type Terrain, WORLD } from "./terrain.ts";

/**
 * The trade road through the valley; roads out of town; lanes between the
 * houses and out to the fields; and tracks to the mill, the quarry and the
 * knoll.
 */
export type StreetTier = "trade" | "road" | "lane" | "track";

export interface Street {
  id: number;
  tier: StreetTier;
  points: Point[];
  /** Half the width (m) of the way. */
  half: number;
  /** Whether it is an old way through the wilds, there before anyone settled. */
  old: boolean;
  /** Whether it runs inside the town wall. */
  inside: boolean;
}

/** What a lot is kept for. */
export type LotKind =
  | "plot"
  | "church"
  | "townhall"
  | "tavern"
  | "watermill"
  | "windmill"
  | "lumberyard"
  | "quarry"
  | "watchtower"
  | "wizard"
  | "well";

/** Where in the town a lot lies: around the square, within the wall, or out along the roads. */
export type Zone = "core" | "inner" | "outer";

export interface Lot {
  id: number;
  kind: LotKind;
  rect: Rect;
  zone: Zone;
  /** The street it faces, and where on it its door opens. */
  street: number;
  door: Point;
  /** Navigation node by the door. */
  node: number;
  /** Distance (m) from the square. */
  distance: number;
}

/** A strip of farmland, fronting a street. */
export interface Field {
  id: number;
  rect: Rect;
  street: number;
  node: number;
  distance: number;
}

/** A fenced meadow for sheep and cows. */
export interface Pasture {
  id: number;
  rect: Rect;
  street: number;
  node: number;
}

/** A gap in the wall where a street passes through. */
export interface Gate {
  /** Index of the wall point the gate stands at. */
  index: number;
  point: Point;
  street: number;
  /** Way the street runs through it (radians, as `Rect.angle`). */
  angle: number;
}

export interface WallPlan {
  /** The ring, closed (the last point joins the first). */
  points: Point[];
  gates: Gate[];
  /** Wall points that carry a tower. */
  towers: number[];
}

/** The ford: where the trade road wades the river, and a bridge will one day span it. */
export interface Crossing {
  street: number;
  /** Middle of the river where the road crosses it, and the road's heading there. */
  point: Point;
  angle: number;
  /** Where the banks are on either side. */
  from: Point;
  to: Point;
}

export interface NavNode {
  x: number;
  y: number;
}

export interface NavEdge {
  a: number;
  b: number;
  length: number;
  street: number;
  /** Whether it wades through the river. */
  ford: boolean;
}

export interface Plan {
  center: Point;
  square: { x: number; y: number; radius: number };
  streets: Street[];
  lots: Lot[];
  fields: Field[];
  pastures: Pasture[];
  wall: WallPlan;
  crossing: Crossing;
  nodes: NavNode[];
  edges: NavEdge[];
  /** Edges at each node. */
  adjacency: number[][];
  /** Nodes where the roads leave the world: travellers come and go there. */
  exits: number[];
}

/** Meters between navigation nodes along a street. */
const NODE_STEP = 3.5;
/** Half widths (m) of each tier of street. */
const HALF: Record<StreetTier, number> = { trade: 2.4, road: 2, lane: 1.5, track: 1.1 };
/** Radius (m) of the market square. */
const SQUARE_RADIUS = 11.5;
/** Half axes (m) of the ring lane around the core, and of the wall. */
const RING = { x: 31, y: 27 };
const WALL = { x: 57, y: 50 };
/** Least distance (m) the wall keeps from the river's middle. */
const WALL_RIVER_GAP = 12;
/** Least room (m) kept between anything built and the edge of a street. */
const STREET_CLEARANCE = 0.4;
/** Farthest from the square (m) a field may lie. */
const FIELD_REACH = 150;
/** Meters between the points of a rect looked at for the river. */
const RIVER_PROBE = 3;

/** Keeps the lay of everything taken so far and checks new pieces against it. */
class Ground {
  readonly rects: Rect[] = [];
  readonly terrain: Terrain;
  readonly streets: Street[];
  readonly square: { x: number; y: number; radius: number };
  readonly wall: Point[];

  constructor(
    terrain: Terrain,
    streets: Street[],
    square: { x: number; y: number; radius: number },
    wall: Point[],
  ) {
    this.terrain = terrain;
    this.streets = streets;
    this.square = square;
    this.wall = wall;
  }

  /**
   * Whether `r` may be taken: clear of what is taken, the streets, the
   * river and the square, level enough, in the world, and on one side of
   * the wall (`inside` says which).
   */
  fits(r: Rect, inside: boolean, gap: number, slope = 0.16): boolean {
    const t = this.terrain;
    const corners = rectCorners(r, 0.5);
    for (const c of corners) {
      if (c.x < WORLD.x0 + 8 || c.x > WORLD.x1 - 8 || c.y < WORLD.y0 + 8 || c.y > WORLD.y1 - 40) {
        return false;
      }
      if (Math.abs(t.riverOffset(c.x, c.y)) < t.riverHalfWidth(c.y) + 4) {
        return false;
      }
      if (t.hills(c.y) > 0.25) {
        return false;
      }
      const inWall = inPolygon(c.x, c.y, this.wall);
      const edge = polygonEdgeDistance(c.x, c.y, this.wall);
      if (inWall !== inside || edge < (inside ? 3.5 : 6)) {
        return false;
      }
    }
    // Clear of the river all over, not only at the corners: a long strip can reach across a bend.
    const across = Math.ceil(r.width / RIVER_PROBE);
    const back = Math.ceil(r.depth / RIVER_PROBE);
    for (let i = 0; i <= across; i++) {
      for (let j = 0; j <= back; j++) {
        const q = rectPoint(
          r,
          (i / across - 0.5) * (r.width + 1),
          (j / back - 0.5) * (r.depth + 1),
        );
        if (Math.abs(t.riverOffset(q.x, q.y)) < t.riverHalfWidth(q.y) + 4) {
          return false;
        }
      }
    }
    // Level enough to build on: the corners and the middle within a small rise.
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of [...corners, r]) {
      const h = t.height(c.x, c.y);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (hi - lo > slope * Math.hypot(r.width, r.depth)) {
      return false;
    }
    const sq = this.square;
    if (Math.hypot(r.x - sq.x, r.y - sq.y) < sq.radius + Math.hypot(r.width, r.depth) / 2 + 1) {
      for (const c of corners) {
        if (Math.hypot(c.x - sq.x, c.y - sq.y) < sq.radius + 1.5) {
          return false;
        }
      }
    }
    for (const s of this.streets) {
      if (rectNearPolyline(r, s.points, s.half, STREET_CLEARANCE)) {
        return false;
      }
    }
    for (const o of this.rects) {
      if (rectsOverlap(r, o, gap)) {
        return false;
      }
    }
    return true;
  }

  take(r: Rect): void {
    this.rects.push(r);
  }
}

/** Angle (as `Rect.angle`) of a rect whose front faces along the unit vector (fx, fy). */
function angleFacing(fx: number, fy: number): number {
  return Math.atan2(fx, -fy);
}

/** Points around an ellipse about `c`, `count` of them, starting at angle `start`. */
function ellipse(c: Point, rx: number, ry: number, count: number, start = 0): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a = start + (i / count) * TAU;
    out.push({ x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * ry });
  }
  return out;
}

/**
 * Lays out the whole town the settlement may grow into, from the seed and the
 * land alone: the streets, the market square, the lots houses and the
 * buildings of a town are raised on, the wall that will ring it, the fields
 * and pastures outside, and the ways people walk between them.
 */
export function generatePlan(seed: number, terrain: Terrain): Plan {
  const r = new Rng(seed ^ 0x9a17);
  const C = terrain.center;
  const square = { x: C.x, y: C.y, radius: SQUARE_RADIUS };
  const streets: Street[] = [];
  const addStreet = (
    tier: StreetTier,
    points: Point[],
    options: { old?: boolean; inside?: boolean } = {},
  ): Street => {
    const s: Street = {
      id: streets.length,
      tier,
      points,
      half: HALF[tier],
      old: options.old ?? false,
      inside: options.inside ?? false,
    };
    streets.push(s);
    return s;
  };

  // The wall: an oval about the square, drawn in on the side of the river.
  const wallCenter = { x: C.x + 4, y: C.y + 3 };
  const wall = ellipse(wallCenter, WALL.x, WALL.y, 28, r.range(0, 0.2)).map((p) => {
    const bank = terrain.riverX(p.y) + WALL_RIVER_GAP;
    return p.x < bank ? { x: bank + (p.x - bank) * 0.08, y: p.y } : p;
  });

  // The trade road: in from the west, wading the river, through the square and out east.
  const fordY = C.y - r.range(3, 8);
  const fordX = terrain.riverX(fordY);
  const trade = addStreet(
    "trade",
    spline(
      [
        { x: WORLD.x0 - 6, y: C.y - r.range(8, 22) },
        { x: fordX - r.range(55, 70), y: fordY - r.range(4, 10) },
        { x: fordX - 14, y: fordY - 1 },
        { x: fordX, y: fordY },
        { x: fordX + 14, y: fordY + 1 },
        { x: C.x - SQUARE_RADIUS - 8, y: C.y - 1 },
        { x: C.x, y: C.y },
        { x: C.x + SQUARE_RADIUS + 10, y: C.y + 1 },
        { x: C.x + 70, y: C.y + r.range(0, 8) },
        { x: WORLD.x1 + 6, y: C.y + r.range(6, 22) },
      ],
      2,
    ),
    { old: true },
  );
  // The south road down toward the viewer, and the track up to the quarry in the hills.
  const south = addStreet(
    "road",
    spline(
      [
        { x: C.x, y: C.y },
        { x: C.x + 2, y: C.y - SQUARE_RADIUS - 6 },
        { x: C.x + r.range(4, 12), y: C.y - 55 },
        { x: C.x + r.range(-10, 4), y: C.y - 115 },
        { x: C.x + r.range(0, 14), y: WORLD.y0 - 6 },
      ],
      2,
    ),
  );
  const quarrySpot = { x: C.x + r.range(-4, 18), y: C.y + r.range(88, 96) };
  const north = addStreet(
    "track",
    spline(
      [
        { x: C.x, y: C.y },
        { x: C.x - 1, y: C.y + SQUARE_RADIUS + 6 },
        { x: C.x - r.range(2, 10), y: C.y + 52 },
        { x: C.x + r.range(-6, 6), y: C.y + 70 },
        { x: quarrySpot.x, y: quarrySpot.y - 12 },
      ],
      2,
    ),
  );

  // The ring lane about the core, and lanes out from it toward the wall.
  const ringPoints = ellipse(C, RING.x, RING.y, 96, 0.05);
  const ring = addStreet("lane", [...ringPoints, { ...ringPoints[0] }], { inside: true });
  const mainWays: number[] = [];
  for (const s of [trade, south, north]) {
    for (let i = 0; i + 1 < s.points.length; i++) {
      const a = Math.hypot(s.points[i].x - C.x, s.points[i].y - C.y);
      const b = Math.hypot(s.points[i + 1].x - C.x, s.points[i + 1].y - C.y);
      if ((a - 20) * (b - 20) <= 0) {
        mainWays.push(Math.atan2(s.points[i].y - C.y, s.points[i].x - C.x));
      }
    }
  }
  const riverSide = Math.atan2(0, terrain.riverX(C.y) - C.x);
  const turn = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU + 0.2;
    if (mainWays.some((b) => turn(a, b) < 0.42) || turn(a, riverSide) < 0.5) {
      continue;
    }
    const from = { x: C.x + Math.cos(a) * RING.x, y: C.y + Math.sin(a) * RING.y };
    const out = { x: C.x + Math.cos(a) * (WALL.x - 9), y: C.y + Math.sin(a) * (WALL.y - 9) };
    if (!inPolygon(out.x, out.y, wall) || polygonEdgeDistance(out.x, out.y, wall) < 6) {
      continue;
    }
    const mid = { x: (from.x + out.x) / 2 + r.range(-2, 2), y: (from.y + out.y) / 2 };
    addStreet("lane", spline([from, mid, out], 2), { inside: true });
  }

  // Tracks off the roads: to the mill by the river, and up the knoll.
  const millY = Math.min(C.y + 70, 150);
  const millX = terrain.riverX(millY) + terrain.riverHalfWidth(millY) + 6;
  const northJoin = alongPolyline(north.points, stationOf(millX, millY, north.points));
  const millTrack = addStreet(
    "track",
    spline(
      [
        { x: northJoin.x, y: northJoin.y },
        { x: (northJoin.x + millX) / 2, y: (northJoin.y + millY) / 2 + 3 },
        { x: millX + 9, y: millY },
      ],
      2,
    ),
  );
  const knoll = terrain.knoll;
  const knollJoin = alongPolyline(trade.points, stationOf(knoll.x, knoll.y, trade.points));
  const knollTrack = addStreet(
    "track",
    spline(
      [
        { x: knollJoin.x, y: knollJoin.y },
        { x: (knollJoin.x + knoll.x) / 2 + 4, y: (knollJoin.y + knoll.y) / 2 },
        { x: knoll.x, y: knoll.y - 6 },
        { x: knoll.x + 8, y: knoll.y + 10 },
      ],
      2,
    ),
  );

  // Farm lanes: straight tracks off the roads outside the wall, out between the fields.
  const outerStreets = [trade, south, north, millTrack, knollTrack];
  const farmLanes: Street[] = [];
  for (const road of [trade, south]) {
    const len = polylineLength(road.points);
    for (let along = 30; along < len - 30; along += r.range(55, 75)) {
      const p = alongPolyline(road.points, along);
      if (inPolygon(p.x, p.y, wall) || polygonEdgeDistance(p.x, p.y, wall) < 30) {
        continue;
      }
      for (const side of [1, -1]) {
        const length = r.range(55, 80);
        const end = { x: p.x - p.dy * side * length, y: p.y + p.dx * side * length };
        const clear = (q: Point) =>
          q.x > WORLD.x0 + 10 &&
          q.x < WORLD.x1 - 10 &&
          q.y > WORLD.y0 + 10 &&
          terrain.hills(q.y) < 0.2 &&
          Math.abs(terrain.riverOffset(q.x, q.y)) > terrain.riverHalfWidth(q.y) + 8 &&
          !inPolygon(q.x, q.y, wall) &&
          polygonEdgeDistance(q.x, q.y, wall) > 12;
        let ok = true;
        for (let t = 0.1; t <= 1 && ok; t += 0.05) {
          const q = { x: p.x + (end.x - p.x) * t, y: p.y + (end.y - p.y) * t };
          ok =
            clear(q) &&
            !streets.some(
              (o) => o !== road && polylineDistance(q.x, q.y, o.points).distance < o.half + 6,
            );
        }
        if (
          ok &&
          Math.sign(terrain.riverOffset(p.x, p.y)) === Math.sign(terrain.riverOffset(end.x, end.y))
        ) {
          const bend = {
            x: (p.x + end.x) / 2 + r.range(-3, 3),
            y: (p.y + end.y) / 2 + r.range(-3, 3),
          };
          farmLanes.push(addStreet("track", spline([{ x: p.x, y: p.y }, bend, end], 2)));
        }
      }
    }
  }

  // Gates: where the streets cross the wall.
  const gates: Gate[] = [];
  for (const s of streets) {
    for (let i = 0; i + 1 < s.points.length; i++) {
      for (let w = 0; w < wall.length; w++) {
        const next = (w + 1) % wall.length;
        const hit = segmentsCross(s.points[i], s.points[i + 1], wall[w], wall[next]);
        if (!hit) {
          continue;
        }
        // Stand the gate on the nearer wall point, and pull the wall onto the street there.
        const index =
          Math.hypot(wall[w].x - hit.x, wall[w].y - hit.y) <
          Math.hypot(wall[next].x - hit.x, wall[next].y - hit.y)
            ? w
            : next;
        if (gates.some((g) => g.index === index)) {
          continue;
        }
        wall[index] = hit;
        const dx = s.points[i + 1].x - s.points[i].x;
        const dy = s.points[i + 1].y - s.points[i].y;
        gates.push({ index, point: hit, street: s.id, angle: angleFacing(dx, dy) });
      }
    }
  }
  const towers: number[] = [];
  for (let i = 0; i < wall.length; i += 2) {
    const nearGate = gates.some((g) => {
      const d = Math.abs(g.index - i);
      return Math.min(d, wall.length - d) <= 1;
    });
    if (!nearGate) {
      towers.push(i);
    }
  }

  const ground = new Ground(terrain, streets, square, wall);
  const zoneOf = (p: Point): Zone => {
    const e = ((p.x - C.x) / (RING.x + 4)) ** 2 + ((p.y - C.y) / (RING.y + 4)) ** 2;
    return e < 1 ? "core" : inPolygon(p.x, p.y, wall) ? "inner" : "outer";
  };
  const lots: Lot[] = [];
  const addLot = (kind: LotKind, rect: Rect, street: Street): Lot => {
    const door = rectPoint(rect, 0, -rect.depth / 2);
    const lot: Lot = {
      id: lots.length,
      kind,
      rect,
      zone: zoneOf(rect),
      street: street.id,
      door,
      node: -1,
      distance: Math.hypot(rect.x - C.x, rect.y - C.y),
    };
    lots.push(lot);
    ground.take(rect);
    return lot;
  };

  /**
   * A lot of `width` × `depth` fronting street `s` at `along` (m) on `side`
   * (±1), set `setback` meters off it.
   */
  const fronting = (
    s: Street,
    along: number,
    side: number,
    width: number,
    depth: number,
    setback: number,
  ): Rect => {
    const p = alongPolyline(s.points, along);
    // Away from the street on this side.
    const nx = -p.dy * side;
    const ny = p.dx * side;
    const off = s.half + setback + depth / 2;
    return {
      x: p.x + nx * off,
      y: p.y + ny * off,
      angle: angleFacing(-nx, -ny),
      width,
      depth,
    };
  };

  /**
   * Finds a place for a special lot along the first street stretch it fits
   * on (`from` and `to` in meters along the street), nearest the start.
   */
  const place = (
    kind: LotKind,
    stretches: readonly { s: Street; from: number; to: number }[],
    width: number,
    depth: number,
    inside: boolean,
    slope?: number,
  ): Lot | null => {
    for (const { s, from, to } of stretches) {
      const end = Math.min(to, polylineLength(s.points));
      for (let along = Math.max(0, from); along <= end; along += 1) {
        for (const side of [1, -1]) {
          const rect = fronting(s, along, side, width, depth, 1.2);
          if (ground.fits(rect, inside, 2, slope)) {
            return addLot(kind, rect, s);
          }
        }
      }
    }
    return null;
  };

  // The buildings every town has, placed first, round the square and along the roads.
  const squareEdge = SQUARE_RADIUS - 1;
  const tradeAtSquare = stationOf(C.x, C.y, trade.points);
  const ringLen = polylineLength(ring.points);
  const nearSquare = [
    { s: north, from: squareEdge, to: 45 },
    { s: south, from: squareEdge, to: 45 },
    { s: trade, from: tradeAtSquare + squareEdge, to: tradeAtSquare + 45 },
    { s: trade, from: tradeAtSquare - 45, to: tradeAtSquare - squareEdge },
    { s: ring, from: 0, to: ringLen },
  ];
  // The church stands broadside to its street, its nave running along it.
  place("church", nearSquare, 25, 13, true);
  place("townhall", nearSquare, 12, 14, true);
  place(
    "tavern",
    [{ s: trade, from: tradeAtSquare + squareEdge, to: tradeAtSquare + 60 }, ...nearSquare],
    11,
    13,
    true,
  );
  const northLen = polylineLength(north.points);
  const millLen = polylineLength(millTrack.points);
  // The quarry is cut into the first rise of the hills: a slope suits it.
  place(
    "quarry",
    [
      { s: north, from: northLen - 18, to: northLen },
      { s: north, from: northLen * 0.6, to: northLen - 18 },
    ],
    18,
    14,
    false,
    0.4,
  );
  // The timber yard just outside the wall on the way up to the woods, or by the mill.
  place(
    "lumberyard",
    [
      { s: north, from: northLen * 0.5, to: northLen - 16 },
      { s: millTrack, from: 12, to: millLen - 12 },
      { s: trade, from: tradeAtSquare + 60, to: tradeAtSquare + 110 },
    ],
    16,
    14,
    false,
  );
  place("watermill", [{ s: millTrack, from: millLen - 10, to: millLen }], 8, 10, false);
  const knollLen = polylineLength(knollTrack.points);
  place("windmill", [{ s: knollTrack, from: knollLen * 0.5, to: knollLen }], 7, 7, false);
  place("wizard", [{ s: knollTrack, from: knollLen * 0.65, to: knollLen }], 8, 8, false);

  // Watchtowers out where raiders come from: by the ford on the far bank, down the south road,
  // and out along the east road.
  const tradeLen = polylineLength(trade.points);
  const fordAt = stationOf(fordX, fordY, trade.points);
  place("watchtower", [{ s: trade, from: fordAt - 60, to: fordAt - 20 }], 4, 4, false);
  place("watchtower", [{ s: south, from: 90, to: 150 }], 4, 4, false);
  place("watchtower", [{ s: trade, from: tradeLen - 70, to: tradeLen - 25 }], 4, 4, false);

  // Pastures on the low meadows by the river, outside the wall, on either bank.
  const nearestStreet = (p: Point): Street =>
    outerStreets.reduce((best, st) =>
      polylineDistance(p.x, p.y, st.points).distance <
      polylineDistance(p.x, p.y, best.points).distance
        ? st
        : best,
    );
  // As near the square as there is room, the first on the town's side of the river and the
  // second across it if it can be: the flock is led out and home every day.
  const pastures: Pasture[] = [];
  const width = 30;
  const depth = 26;
  const side = (x: number, y: number) => Math.sign(terrain.riverOffset(x, y));
  const town = side(C.x, C.y);
  for (const want of [town, -town]) {
    let best: Rect | null = null;
    let bestD = Infinity;
    let fallback: Rect | null = null;
    let fallbackD = Infinity;
    for (let dy = -140; dy <= 140; dy += 4) {
      for (let dx = -140; dx <= 140; dx += 4) {
        const x = C.x + dx;
        const y = C.y + dy;
        const d = Math.hypot(dx, dy);
        const across = side(x, y) !== want;
        if (d >= (across ? fallbackD : bestD)) {
          continue;
        }
        // Long side toward the river.
        const toRiver = Math.sign(terrain.riverX(y) - x);
        const rect: Rect = { x, y, angle: (toRiver * Math.PI) / 2, width, depth };
        if (!ground.fits(rect, false, 3, 0.2)) {
          continue;
        }
        if (across) {
          fallback = rect;
          fallbackD = d;
        } else {
          best = rect;
          bestD = d;
        }
      }
    }
    const rect = best ?? (pastures.length > 0 ? fallback : null);
    if (rect) {
      ground.take(rect);
      pastures.push({ id: pastures.length, rect, street: nearestStreet(rect).id, node: -1 });
    }
  }

  // House plots: round the ring and the square first, then out along the roads.
  const plotRuns: { s: Street; inside: boolean }[] = [
    ...streets.filter((st) => st.inside).map((st) => ({ s: st, inside: true })),
    ...[trade, south, north].map((st) => ({ s: st, inside: true })),
    ...[trade, south, north].map((st) => ({ s: st, inside: false })),
  ];
  for (const run of plotRuns) {
    const len = polylineLength(run.s.points);
    for (const side of [1, -1]) {
      let along = r.range(0, 2);
      while (along < len) {
        const outer = !run.inside;
        const width = outer ? r.range(9, 12) : r.range(6, 8);
        // Town plots run back as far as there is room, with a garden behind the house.
        const depths = outer
          ? [r.range(13, 17)]
          : [r.range(17, 21), r.range(13, 15), r.range(10, 12), r.range(8.5, 9.5)];
        let taken: Rect | null = null;
        for (const depth of depths) {
          const rect = fronting(run.s, along + width / 2, side, width, depth, outer ? 2 : 0.8);
          const far = Math.hypot(rect.x - C.x, rect.y - C.y) > (outer ? 100 : 90);
          if (!far && ground.fits(rect, run.inside, outer ? 5 : 0.6)) {
            taken = rect;
            break;
          }
        }
        if (taken) {
          addLot("plot", taken, run.s);
          along += width + (outer ? r.range(5, 12) : r.range(0.6, 1.2));
        } else {
          along += 0.75;
        }
      }
    }
  }

  // Wells: one on the square, and one along each lane among the houses.
  const wellSpots: { p: Point; s: Street }[] = [{ p: { x: C.x + 3.5, y: C.y + 4 }, s: north }];
  for (const st of streets.filter((o) => o.inside && o !== ring)) {
    const p = alongPolyline(st.points, polylineLength(st.points) * 0.55);
    const off = st.half + 1.8;
    wellSpots.push({ p: { x: p.x - p.dy * off, y: p.y + p.dx * off }, s: st });
  }
  for (const { p, s: st } of wellSpots) {
    const rect: Rect = { x: p.x, y: p.y, angle: 0, width: 2.4, depth: 2.4 };
    const onSquare = Math.hypot(p.x - C.x, p.y - C.y) < SQUARE_RADIUS;
    if (onSquare || ground.fits(rect, true, 0.8)) {
      addLot("well", rect, st);
    }
  }

  // Fields: strips fronting the roads outside the wall, out to the edge of the hills.
  const fields: Field[] = [];
  for (const s of [...outerStreets, ...farmLanes]) {
    const len = polylineLength(s.points);
    for (const side of [1, -1]) {
      let along = r.range(0, 4);
      while (along < len) {
        const width = r.range(10, 13);
        const depth = r.range(30, 42);
        const rect = fronting(s, along + width / 2, side, width, depth, 2.5);
        const d = Math.hypot(rect.x - C.x, rect.y - C.y);
        if (d < FIELD_REACH && ground.fits(rect, false, 1.6, 0.14)) {
          ground.take(rect);
          fields.push({ id: 0, rect, street: s.id, node: -1, distance: d });
          along += width + 1.6;
        } else {
          along += 2;
        }
      }
    }
  }
  // Nearest first, those across the river after those on the town's own bank.
  const townBank = terrain.riverOffset(C.x, C.y) > 0;
  const reach = (f: Field) =>
    f.distance + (terrain.riverOffset(f.rect.x, f.rect.y) > 0 === townBank ? 0 : 90);
  fields.sort((a, b) => reach(a) - reach(b));
  fields.forEach((f, i) => (f.id = i));

  const { nodes, edges, adjacency, near } = buildNavigation(streets, terrain);
  for (const lot of lots) {
    lot.node = near(lot.street, lot.door);
  }
  for (const f of fields) {
    f.node = near(f.street, rectPoint(f.rect, 0, -f.rect.depth / 2));
  }
  for (const p of pastures) {
    p.node = near(p.street, { x: p.rect.x, y: p.rect.y });
  }
  const exits: number[] = [];
  for (const s of [trade, south]) {
    for (const e of [s.points[0], s.points[s.points.length - 1]]) {
      if (e.x < WORLD.x0 || e.x > WORLD.x1 || e.y < WORLD.y0 || e.y > WORLD.y1) {
        exits.push(near(s.id, e));
      }
    }
  }

  return {
    center: C,
    square,
    streets,
    lots,
    fields,
    pastures,
    wall: { points: wall, gates, towers },
    crossing: planCrossing(terrain, trade, fordAt),
    nodes,
    edges,
    adjacency,
    exits,
  };
}

/** Where the trade road meets the river's banks on either side of the ford. */
function planCrossing(terrain: Terrain, trade: Street, fordAt: number): Crossing {
  const at = alongPolyline(trade.points, fordAt);
  const wet = (s: number) => {
    const p = alongPolyline(trade.points, s);
    return Math.abs(terrain.riverOffset(p.x, p.y)) < terrain.riverHalfWidth(p.y) + 1.2;
  };
  let back = 0;
  while (back < 30 && wet(fordAt - back)) {
    back += 0.25;
  }
  let ahead = 0;
  while (ahead < 30 && wet(fordAt + ahead)) {
    ahead += 0.25;
  }
  const from = alongPolyline(trade.points, fordAt - back - 1);
  const to = alongPolyline(trade.points, fordAt + ahead + 1);
  return {
    street: trade.id,
    point: { x: at.x, y: at.y },
    angle: angleFacing(at.dx, at.dy),
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
  };
}

/**
 * Navigation: nodes every few meters along each street, joined where the
 * streets meet; `near` finds the node of a street nearest a point.
 */
function buildNavigation(
  streets: readonly Street[],
  terrain: Terrain,
): {
  nodes: NavNode[];
  edges: NavEdge[];
  adjacency: number[][];
  near: (street: number, p: Point) => number;
} {
  const nodes: NavNode[] = [];
  const edges: NavEdge[] = [];
  const byStreet: number[][] = [];
  const link = (a: number, b: number, street: number) => {
    const na = nodes[a];
    const nb = nodes[b];
    const mx = (na.x + nb.x) / 2;
    const my = (na.y + nb.y) / 2;
    edges.push({
      a,
      b,
      length: Math.hypot(na.x - nb.x, na.y - nb.y),
      street,
      ford: terrain.isWater(mx, my) || terrain.isWater(na.x, na.y) || terrain.isWater(nb.x, nb.y),
    });
  };
  for (const s of streets) {
    const len = polylineLength(s.points);
    const count = Math.max(1, Math.round(len / NODE_STEP));
    const ids: number[] = [];
    for (let i = 0; i <= count; i++) {
      const p = alongPolyline(s.points, (i / count) * len);
      ids.push(nodes.length);
      nodes.push({ x: p.x, y: p.y });
      if (i > 0) {
        link(ids[i - 1], ids[i], s.id);
      }
    }
    byStreet.push(ids);
  }
  const near = (street: number, p: Point): number => {
    let best = -1;
    let bestD = Infinity;
    for (const id of byStreet[street]) {
      const d = Math.hypot(nodes[id].x - p.x, nodes[id].y - p.y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  };
  // Where one street starts or ends on another, or crosses it, join them at their nearest nodes.
  for (const s of streets) {
    const ids = byStreet[s.id];
    for (const o of streets) {
      if (o.id === s.id) {
        continue;
      }
      for (const end of [ids[0], ids[ids.length - 1]]) {
        const other = near(o.id, nodes[end]);
        const d = Math.hypot(nodes[end].x - nodes[other].x, nodes[end].y - nodes[other].y);
        if (d < NODE_STEP * 1.6 && d > 0.01) {
          link(end, other, s.id);
        } else if (d <= 0.01) {
          link(end, other, s.id);
        }
      }
    }
    // Crossings along the way (the ring lane meets the roads mid-street).
    for (const o of streets) {
      if (o.id <= s.id) {
        continue;
      }
      for (let i = 0; i + 1 < s.points.length; i++) {
        for (let j = 0; j + 1 < o.points.length; j++) {
          const hit = segmentsCross(s.points[i], s.points[i + 1], o.points[j], o.points[j + 1]);
          if (hit) {
            const a = near(s.id, hit);
            const b = near(o.id, hit);
            if (!edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) {
              link(a, b, s.id);
            }
          }
        }
      }
    }
  }
  const adjacency: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => {
    adjacency[e.a].push(i);
    adjacency[e.b].push(i);
  });
  return { nodes, edges, adjacency, near };
}

/** Whether (x, y) lies within the wall ring. */
export function insideWall(plan: Plan, x: number, y: number): boolean {
  return inPolygon(x, y, plan.wall.points);
}

/** Whether (x, y) lies on any street (within its half width plus `margin`). */
export function onStreet(plan: Plan, x: number, y: number, margin = 0): boolean {
  for (const s of plan.streets) {
    if (polylineDistance(x, y, s.points).distance < s.half + margin) {
      return true;
    }
  }
  return false;
}

/** The lot, field or pasture rect that contains (x, y), if any. */
export function rectAt(rects: readonly Rect[], x: number, y: number, margin = 0): Rect | null {
  for (const r of rects) {
    if (inRect(r, x, y, margin)) {
      return r;
    }
  }
  return null;
}

/** The front of a rect: unit vector it faces. */
export function front(r: Rect): Point {
  return facing(r.angle);
}
