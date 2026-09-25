import { DEG } from "../../shared/core/math.ts";
import { Box, Disc, type Material, type Prim, Quad, vec } from "./geometry.ts";

/*
 * The dojo, laid out to the standard near-target range: targets 28 m from
 * the shooting line and 1.8 m apart, their centers 27 cm above the ground and
 * their faces leaning back 5°, a sand bank (azuchi) about 1.5 m high under a
 * roof about 2 m high, and a shooting hall whose eaves reach out over the
 * front of its floor. The archer stands at the middle of five positions.
 */

/** Spacing, width and depth (m) of the rafters under the hall eaves. */
export const RAFTER_PITCH = 0.45;
export const RAFTER_WIDTH = 0.075;
export const RAFTER_DEPTH = 0.09;

/** Height (m) of the hall floor above the range. */
export const FLOOR = 0.45;
/** Eye height (m) of the archer standing on the shooting line. */
export const EYE = FLOOR + 1.52;
/** Front edge of the hall floor (m ahead of the shooting line). */
export const HALL_FRONT = 1.5;
/** Tip of the hall eaves and its height. */
export const EAVE_Z = 2.9;
export const EAVE_Y = FLOOR + 2.3;
/** The beam along the front of the hall that the rafters rest on. */
export const BEAM_Y = FLOOR + 2.55;
export const CEILING_Y = FLOOR + 4;
/** How far the drip line gravel reaches in front of the hall. */
export const GRAVEL_END = 3.4;

/** Distance (m) from the shooting line to the target faces. */
export const TARGET_DISTANCE = 28;
/** Target center height, radius and backward lean. */
export const TARGET_HEIGHT = 0.27;
export const TARGET_RADIUS = 0.18;
export const TARGET_LEAN = 5 * DEG;
export const TARGET_SPACING = 1.8;
export const TARGET_COUNT = 5;
/** The archer's own target. */
export const OWN_TARGET = 2;
/** Outer edge (m from center) of the painted face; beyond it is the rim of the wooden hoop. */
export const TARGET_FACE = 0.175;

/** Front of the flat sand in front of the bank. */
export const SAND_START = 26.4;
/** The bank: its foot, the top of its face and the back of its top. */
export const AZUCHI_FOOT = 28.08;
export const AZUCHI_HEIGHT = 1.5;
export const AZUCHI_CREST = 29.25;
export const AZUCHI_BACK = 29.9;
/** Half width of the target house. */
export const RANGE_HALF = 5;
/** Front of the target house roof and its height; the roof rises toward the back. */
export const RANGE_EAVE_Z = 27.3;
export const RANGE_EAVE_Y = 2.05;
export const RANGE_BACK_Z = 30.4;
export const RANGE_RIDGE_Y = 2.95;
/** Thickness of the target house roof, from its boarded underside to the top of the tiles. */
export const RANGE_ROOF_DEPTH = 0.26;
/** How far the roof reaches past the walls on either side. */
export const RANGE_ROOF_HALF = RANGE_HALF + 0.3;
/** Spacing (m) of the rows of tiles across the roof. */
export const TILE_PITCH = 0.3;
/** The curtain (maku) hung along the front of the target house. */
export const MAKU_Z = 27.36;
export const MAKU_BOTTOM = 1.62;
/** Posts along the front of the target house. */
export const POSTS = [-RANGE_HALF, -2.7, 2.7, RANGE_HALF] as const;
export const POST_HALF = 0.06;

/** Board fence along the left of the range. */
export const FENCE_X = -4.8;
export const FENCE_HEIGHT = 1.8;
/** Clipped hedge between the range and the path on the right. */
export const HEDGE_X0 = 4.55;
export const HEDGE_X1 = 4.95;
export const HEDGE_HEIGHT = 1.15;
export const HEDGE_START = 3.6;
export const HEDGE_END = 25.9;
/** The outer fence beyond the path along the range (yatori-michi). */
export const OUTER_FENCE_X = 6.4;
export const OUTER_FENCE_HEIGHT = 2.0;

export interface Target {
  index: number;
  x: number;
  y: number;
  z: number;
  disc: Disc;
}

function quad(
  material: Material,
  name: string,
  o: [number, number, number],
  u: [number, number, number],
  v: [number, number, number],
): Quad {
  return new Quad(material, name, vec(...o), vec(...u), vec(...v));
}

function box(
  material: Material,
  name: string,
  min: [number, number, number],
  max: [number, number, number],
): Box {
  return new Box(material, name, vec(...min), vec(...max));
}

const lean = TARGET_LEAN;
const azuchiRun = AZUCHI_CREST - AZUCHI_FOOT;

export const TARGETS: readonly Target[] = Array.from({ length: TARGET_COUNT }, (_, index) => {
  const x = (index - OWN_TARGET) * TARGET_SPACING;
  const disc = new Disc(
    "target",
    `target${index}`,
    vec(x, TARGET_HEIGHT, TARGET_DISTANCE),
    // Facing the archer, leaning back.
    vec(0, Math.sin(lean), -Math.cos(lean)),
    vec(1, 0, 0),
    TARGET_RADIUS,
  );
  return { index, x, y: TARGET_HEIGHT, z: TARGET_DISTANCE, disc };
});

/** The sloped face of the bank, where most arrows end up. */
export const AZUCHI_FACE = quad(
  "azuchi",
  "azuchi",
  [-RANGE_HALF, 0, AZUCHI_FOOT],
  [RANGE_HALF * 2, 0, 0],
  [0, AZUCHI_HEIGHT, azuchiRun],
);

/** The curtain along the front of the target house. */
export const MAKU = quad(
  "cloth",
  "maku",
  [-RANGE_HALF, MAKU_BOTTOM, MAKU_Z],
  [RANGE_HALF * 2, 0, 0],
  [0, RANGE_EAVE_Y - MAKU_BOTTOM, 0],
);

const hallHalf = 9;
const roofRise = RANGE_RIDGE_Y - RANGE_EAVE_Y;
const roofRun = RANGE_BACK_Z - RANGE_EAVE_Z;
const roofSlope = Math.hypot(roofRise, roofRun);

/**
 * A board at x along the sloping end of the target house roof, from below
 * its underside to above its tiles, running the length of the slope.
 */
function bargeBoard(x: number, name: string): Quad {
  const width = RANGE_ROOF_DEPTH + 0.18;
  // It starts a little in front of the eave and runs a little past the back.
  const reach = (roofSlope + 0.16) / roofSlope;
  return quad(
    "wood",
    name,
    [x, RANGE_EAVE_Y - 0.06, RANGE_EAVE_Z - 0.04],
    // Across the slope (up and a little back), and up the slope.
    [0, (roofRun / roofSlope) * width, (-roofRise / roofSlope) * width],
    [0, roofRise * reach, roofRun * reach],
  );
}

/** The range and the target house: everything an arrow can reach. */
export const RANGE_PRIMS: readonly Prim[] = [
  ...TARGETS.map((t) => t.disc),
  AZUCHI_FACE,
  quad(
    "azuchi",
    "azuchiTop",
    [-RANGE_HALF, AZUCHI_HEIGHT, AZUCHI_CREST],
    [RANGE_HALF * 2, 0, 0],
    [0, 0, AZUCHI_BACK - AZUCHI_CREST],
  ),
  quad(
    "wood",
    "backBoard",
    [-RANGE_HALF, AZUCHI_HEIGHT, AZUCHI_BACK],
    [RANGE_HALF * 2, 0, 0],
    [0, RANGE_RIDGE_Y - AZUCHI_HEIGHT, 0],
  ),
  MAKU,
  quad(
    "wood",
    "fascia",
    [-RANGE_ROOF_HALF, RANGE_EAVE_Y, RANGE_EAVE_Z],
    [RANGE_ROOF_HALF * 2, 0, 0],
    [0, RANGE_ROOF_DEPTH, 0],
  ),
  quad(
    "wood",
    "rangeSoffit",
    [-RANGE_ROOF_HALF, RANGE_EAVE_Y, RANGE_EAVE_Z],
    [RANGE_ROOF_HALF * 2, 0, 0],
    [0, roofRise, roofRun],
  ),
  quad(
    "roof",
    "rangeRoof",
    [-RANGE_ROOF_HALF, RANGE_EAVE_Y + RANGE_ROOF_DEPTH, RANGE_EAVE_Z],
    [RANGE_ROOF_HALF * 2, 0, 0],
    [0, roofRise, roofRun],
  ),
  // The row of end tiles along the eave, standing a little proud of the fascia.
  box(
    "roof",
    "eaveTiles",
    [-RANGE_ROOF_HALF, RANGE_EAVE_Y + RANGE_ROOF_DEPTH - 0.06, RANGE_EAVE_Z - 0.1],
    [RANGE_ROOF_HALF, RANGE_EAVE_Y + RANGE_ROOF_DEPTH + 0.08, RANGE_EAVE_Z + 0.05],
  ),
  // The ridge along the high back edge: flat tiles laid in courses under a capping row.
  box(
    "roof",
    "ridge",
    [-RANGE_ROOF_HALF - 0.05, RANGE_RIDGE_Y + RANGE_ROOF_DEPTH - 0.04, RANGE_BACK_Z - 0.14],
    [RANGE_ROOF_HALF + 0.05, RANGE_RIDGE_Y + RANGE_ROOF_DEPTH + 0.2, RANGE_BACK_Z + 0.08],
  ),
  // Barge boards closing the sloping ends of the roof.
  ...[-1, 1].map((side) =>
    bargeBoard(side * (RANGE_ROOF_HALF + 0.02), `barge${side < 0 ? "L" : "R"}`),
  ),
  quad(
    "wood",
    "rangeWallL",
    [-RANGE_HALF, 0, RANGE_EAVE_Z],
    [0, 0, AZUCHI_BACK - RANGE_EAVE_Z],
    [0, RANGE_EAVE_Y + 0.1, 0],
  ),
  quad(
    "wood",
    "rangeWallR",
    [RANGE_HALF, 0, RANGE_EAVE_Z],
    [0, RANGE_EAVE_Y + 0.1, 0],
    [0, 0, AZUCHI_BACK - RANGE_EAVE_Z],
  ),
  ...POSTS.map((x, i) =>
    box(
      "wood",
      `post${i}`,
      [x - POST_HALF, 0, RANGE_EAVE_Z - POST_HALF],
      [x + POST_HALF, RANGE_EAVE_Y, RANGE_EAVE_Z + POST_HALF],
    ),
  ),
  quad(
    "sand",
    "sand",
    [-RANGE_HALF, 0, SAND_START],
    [RANGE_HALF * 2, 0, 0],
    [0, 0, AZUCHI_FOOT - SAND_START],
  ),
  quad(
    "lawn",
    "lawn",
    [FENCE_X, 0, GRAVEL_END],
    [HEDGE_X0 - FENCE_X, 0, 0],
    [0, 0, SAND_START - GRAVEL_END],
  ),
  quad(
    "gravel",
    "dripLine",
    [FENCE_X, 0, HALL_FRONT],
    [HEDGE_X0 - FENCE_X, 0, 0],
    [0, 0, GRAVEL_END - HALL_FRONT],
  ),
  // The lawn runs on to the sand on the far side of the hedge, where the path turns in.
  quad(
    "lawn",
    "lawnGap",
    [HEDGE_X0, 0, HEDGE_END],
    [RANGE_HALF - HEDGE_X0, 0, 0],
    [0, 0, SAND_START - HEDGE_END],
  ),
  quad(
    "wood",
    "fence",
    [FENCE_X, 0, HALL_FRONT],
    [0, FENCE_HEIGHT, 0],
    [0, 0, RANGE_EAVE_Z - HALL_FRONT],
  ),
  box(
    "wood",
    "fenceCap",
    [FENCE_X - 0.06, FENCE_HEIGHT, HALL_FRONT],
    [FENCE_X + 0.06, FENCE_HEIGHT + 0.06, RANGE_EAVE_Z],
  ),
  box("hedge", "hedge", [HEDGE_X0, 0, HEDGE_START], [HEDGE_X1, HEDGE_HEIGHT, HEDGE_END]),
  quad(
    "soil",
    "hedgeBed",
    [HEDGE_X0, 0, HALL_FRONT],
    [HEDGE_X1 - HEDGE_X0, 0, 0],
    [0, 0, HEDGE_END - HALL_FRONT],
  ),
  quad(
    "gravel",
    "path",
    [HEDGE_X1, 0, HALL_FRONT],
    [OUTER_FENCE_X - HEDGE_X1, 0, 0],
    [0, 0, RANGE_BACK_Z - HALL_FRONT],
  ),
  quad(
    "wood",
    "outerFence",
    [OUTER_FENCE_X, 0, HALL_FRONT],
    [0, 0, RANGE_BACK_Z + 1 - HALL_FRONT],
    [0, OUTER_FENCE_HEIGHT, 0],
  ),
];

/**
 * The rafters under the hall eaves, from the beam down to the fascia, each
 * as its underside and the side turned to the archer (the eye never moves
 * off the middle of the hall, so the far sides are never seen).
 */
function rafters(): Quad[] {
  const run = EAVE_Z - HALL_FRONT;
  const drop = BEAM_Y - EAVE_Y;
  const slope = Math.hypot(run, drop);
  // Down the slope, and straight down off the boards (down and a little back).
  const along: [number, number, number] = [0, -drop, run];
  const down: [number, number, number] = [
    0,
    (-run / slope) * RAFTER_DEPTH,
    (-drop / slope) * RAFTER_DEPTH,
  ];
  const parts: Quad[] = [];
  const count = Math.floor(hallHalf / RAFTER_PITCH);
  for (let i = -count; i <= count; i++) {
    const x0 = i * RAFTER_PITCH - RAFTER_WIDTH / 2;
    const x1 = x0 + RAFTER_WIDTH;
    const bottom: [number, number, number] = [x0, BEAM_Y + down[1], HALL_FRONT + down[2]];
    parts.push(quad("wood", `rafter${i}`, bottom, [RAFTER_WIDTH, 0, 0], along));
    if (x0 > 0) {
      parts.push(quad("wood", `rafter${i}`, [x0, BEAM_Y, HALL_FRONT], down, along));
    } else if (x1 < 0) {
      parts.push(quad("wood", `rafter${i}`, [x1, BEAM_Y, HALL_FRONT], down, along));
    }
  }
  return parts;
}

/** The shooting hall around the archer: seen, and casting shade, but never shot at. */
export const HALL_PRIMS: readonly Prim[] = [
  ...rafters(),
  quad("floor", "floor", [-hallHalf, FLOOR, -4], [hallHalf * 2, 0, 0], [0, 0, 4 + HALL_FRONT]),
  quad("wood", "floorEdge", [-hallHalf, 0, HALL_FRONT], [hallHalf * 2, 0, 0], [0, FLOOR, 0]),
  quad(
    "ceiling",
    "soffit",
    [-hallHalf, BEAM_Y, HALL_FRONT],
    [hallHalf * 2, 0, 0],
    [0, EAVE_Y - BEAM_Y, EAVE_Z - HALL_FRONT],
  ),
  quad(
    "wood",
    "eaveFascia",
    [-hallHalf, EAVE_Y - 0.12, EAVE_Z],
    [hallHalf * 2, 0, 0],
    [0, 0.12, 0],
  ),
  box(
    "wood",
    "beam",
    [-hallHalf, BEAM_Y - 0.28, HALL_FRONT - 0.12],
    [hallHalf, BEAM_Y, HALL_FRONT + 0.12],
  ),
  quad(
    "ceiling",
    "ceiling",
    [-hallHalf, CEILING_Y, -4],
    [hallHalf * 2, 0, 0],
    [0, 0, 4 + HALL_FRONT],
  ),
];

/**
 * Wide ground around the dojo, seen only at the far edges of the view; a
 * little below the range so the two never fight over a pixel.
 */
export const OUTER_GROUND = quad("lawn", "outer", [-400, -0.02, -20], [800, 0, 0], [0, 0, 600]);

/** Solid shapes that shade the range from the sun. */
export const SHADOW_CASTERS: readonly Prim[] = [
  box("roof", "hallRoof", [-hallHalf, EAVE_Y, -8], [hallHalf, CEILING_Y + 1, EAVE_Z]),
  box(
    "roof",
    "rangeRoofMass",
    [-RANGE_HALF - 0.3, RANGE_EAVE_Y, RANGE_EAVE_Z],
    [RANGE_HALF + 0.3, RANGE_RIDGE_Y + 0.3, RANGE_BACK_Z],
  ),
  box(
    "wood",
    "rangeBack",
    [-RANGE_HALF, 0, AZUCHI_BACK],
    [RANGE_HALF, RANGE_RIDGE_Y, RANGE_BACK_Z],
  ),
  box(
    "wood",
    "rangeSideL",
    [-RANGE_HALF - 0.05, 0, RANGE_EAVE_Z],
    [-RANGE_HALF, RANGE_EAVE_Y, RANGE_BACK_Z],
  ),
  box(
    "wood",
    "rangeSideR",
    [RANGE_HALF, 0, RANGE_EAVE_Z],
    [RANGE_HALF + 0.05, RANGE_EAVE_Y, RANGE_BACK_Z],
  ),
  box(
    "wood",
    "fenceMass",
    [FENCE_X - 0.06, 0, HALL_FRONT],
    [FENCE_X + 0.06, FENCE_HEIGHT + 0.06, RANGE_EAVE_Z],
  ),
  box("hedge", "hedgeMass", [HEDGE_X0, 0, HEDGE_START], [HEDGE_X1, HEDGE_HEIGHT, HEDGE_END]),
  box(
    "wood",
    "outerFenceMass",
    [OUTER_FENCE_X, 0, HALL_FRONT],
    [OUTER_FENCE_X + 0.05, OUTER_FENCE_HEIGHT, RANGE_BACK_Z + 1],
  ),
  box(
    "azuchi",
    "azuchiMass",
    [-RANGE_HALF, 0, AZUCHI_CREST],
    [RANGE_HALF, AZUCHI_HEIGHT, AZUCHI_BACK],
  ),
];

/** Where the arrow's aim may be put, on the plane of the target faces. */
export const AIM_LIMITS = {
  x0: -RANGE_HALF + 0.55,
  x1: RANGE_HALF - 0.55,
  y0: -1.4,
  y1: RANGE_EAVE_Y - 0.08,
} as const;

/** The ground height (always 0) and what covers it at (x, z). */
export function groundMaterial(x: number, z: number): Material {
  if (z >= SAND_START && x > -RANGE_HALF && x < RANGE_HALF) {
    return "sand";
  }
  if (x >= HEDGE_X1) {
    return "gravel";
  }
  if (x >= HEDGE_X0 && z < HEDGE_END) {
    return "soil";
  }
  return z < GRAVEL_END ? "gravel" : "lawn";
}
