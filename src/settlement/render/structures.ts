import { smoothstep } from "../../shared/core/math.ts";
import { hash2, Rng } from "../../shared/core/random.ts";
import {
  type Building,
  buildStep,
  KINDS,
  type RoofStuff,
  type Trim,
  type WallStuff,
} from "../sim/buildings.ts";
import { rectCorners } from "../sim/geometry.ts";
import { bridgeDeck, type World } from "../sim/world.ts";
import { M } from "./materials.ts";
import { BUILDING_OWNER } from "./owners.ts";
import {
  bark,
  boards,
  door,
  logs,
  pavingDetail,
  plain,
  shingles,
  stoneCourses,
  thatch,
  tiles,
  timberFrame,
  windowPane,
} from "./paints.ts";
import { COS_E, S, SIN_E } from "./projection.ts";
import { packed, type Face, type Paint, type TileRaster } from "./raster.ts";
import type { Structure } from "./scene.ts";
import { Builder, face, shadowFace, type Side } from "./shapes.ts";

/** How tall (m) each kind stands at most, for its screen box and its shadow. */
export const HEIGHT: Record<Building["kind"], number> = {
  camp: 3,
  cabin: 5,
  house: 7,
  farmhouse: 8,
  townhouse: 12,
  stonehouse: 12,
  barn: 9,
  workshop: 7,
  well: 3.2,
  smithy: 8,
  bakery: 8,
  tavern: 12.5,
  chapel: 12,
  church: 27,
  townhall: 15,
  watermill: 9,
  windmill: 11,
  lumberyard: 5,
  quarry: 4,
  watchtower: 11,
  wizard: 25,
  palisade: 4,
  wall: 7,
  tower: 13,
  woodgate: 8,
  gatehouse: 12,
  bridge: 3,
  stonebridge: 4,
};

/** How far (m) roofs and the like reach past a building's footprint. */
const REACH = 1.2;

const builder = new Builder();

/** Materials of the stuff a style names. */
const ROOF: Record<RoofStuff, number> = {
  bark: M.BARK,
  thatch: M.THATCH,
  shingle: M.SHINGLE,
  tile: M.TILE,
  slate: M.SLATE,
};
const WALL: Record<WallStuff, number> = {
  log: M.LOG,
  plank: M.PLANK,
  plaster: M.PLASTER,
  plasterWarm: M.PLASTER_WARM,
  plasterPink: M.PLASTER_PINK,
  stone: M.STONE,
};
const TRIM: Record<Trim, number> = {
  green: M.SHUTTER,
  brown: M.DOOR,
  blue: M.CLOTH_BLUE,
  red: M.CLOTH_RED,
};

/** The roof surface a style names. */
function roofPaint(stuff: RoofStuff, seed: number): Paint {
  switch (stuff) {
    case "thatch":
      return thatch(seed);
    case "tile":
      return tiles(seed);
    case "bark":
      return bark(seed);
    case "slate":
      return shingles(M.SLATE, seed, 0.22, 0.3);
    case "shingle":
      return shingles(M.SHINGLE, seed);
  }
}

/**
 * A building as the renderer draws it into the world: its screen box, and
 * how to draw it at its present step, from stakes in the ground to finished,
 * or as a ruin.
 */
export class BuildingStructure implements Structure {
  gx0 = 0;
  gy0 = 0;
  gx1 = 0;
  gy1 = 0;
  readonly building: Building;
  /** What it looked like when last drawn (see `look`), to see when it must be drawn again. */
  drawnLook = -1;
  private readonly world: World;

  constructor(world: World, building: Building) {
    this.world = world;
    this.building = building;
    this.bound();
  }

  /** A summary of everything in its drawing that changes over its life. */
  look(): number {
    const b = this.building;
    return buildStep(b) * 2 + (b.shut ? 1 : 0);
  }

  /** Works out the screen box from the footprint and the height. */
  bound(): void {
    const b = this.building;
    const corners = rectCorners(b.rect, REACH + (b.kind === "church" ? 3 : 0));
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const c of corners) {
      x0 = Math.min(x0, c.x);
      x1 = Math.max(x1, c.x);
      y0 = Math.min(y0, c.y);
      y1 = Math.max(y1, c.y);
    }
    const top = b.base + HEIGHT[b.kind];
    this.gx0 = Math.floor(x0 / S) - 2;
    this.gx1 = Math.ceil(x1 / S) + 2;
    this.gy0 = Math.floor(-(y1 * SIN_E + top * COS_E) / S) - 2;
    this.gy1 = Math.ceil(-(y0 * SIN_E + (b.base - 1) * COS_E) / S) + 2;
  }

  draw(r: TileRaster): void {
    const b = this.building;
    const g = builder.at(r, b.rect, b.base);
    const owner = BUILDING_OWNER + b.id;
    const step = buildStep(b);
    if (step >= 6) {
      drawRuin(g, b, owner, step);
      return;
    }
    const kit = new Kit(b, owner);
    DRAW[b.kind](g, b, kit, step, this.world);
  }
}

/** The faces a building is drawn with, made once per drawing. */
class Kit {
  readonly owner: number;
  readonly seed: number;
  readonly wall: Face;
  readonly roof: Face;
  readonly fascia: Face;
  readonly timber: Face;
  readonly plinth: Face;
  readonly stone: Face;
  readonly planks: Face;
  readonly dark: Face;
  readonly iron: Face;
  /** Material of the walls the style names. */
  readonly wallMat: number;
  private readonly trimMat: number;
  private readonly width: number;

  constructor(b: Building, owner: number) {
    this.owner = owner;
    this.seed = b.variant;
    this.width = b.rect.width;
    this.wallMat = WALL[b.style.wall];
    this.trimMat = TRIM[b.style.trim];
    const s = b.variant;
    this.roof = face(ROOF[b.style.roof], owner, roofPaint(b.style.roof, s));
    this.wall = this.wallFace(this.wallMat, 2.8);
    this.fascia = face(M.TIMBER, owner, plain(M.TIMBER, s, 20));
    this.timber = face(M.TIMBER, owner, plain(M.TIMBER, s + 1, 18));
    this.plinth = face(M.STONE_ROUGH, owner, stoneCourses(M.STONE_ROUGH, s, true));
    this.stone = face(M.STONE, owner, stoneCourses(M.STONE, s));
    this.planks = face(M.PLANK, owner, boards(M.PLANK, s));
    this.dark = shadowFace(owner);
    this.iron = face(M.IRON, owner);
  }

  /** The wall surface the style names: timber-framed plaster, logs, boards or stone. */
  wallFace(mat: number, storey: number, width = this.width): Face {
    switch (mat) {
      case M.LOG:
        return face(M.LOG, this.owner, logs(this.seed, width));
      case M.PLANK:
        return face(M.PLANK, this.owner, boards(M.PLANK, this.seed));
      case M.STONE:
        return face(M.STONE, this.owner, stoneCourses(M.STONE, this.seed));
      case M.STONE_ROUGH:
        return face(M.STONE_ROUGH, this.owner, stoneCourses(M.STONE_ROUGH, this.seed, true));
      default:
        return face(mat, this.owner, timberFrame(mat, this.seed, storey));
    }
  }

  window(width: number, height: number): Face {
    return face(M.WINDOW, this.owner, windowPane(width, height));
  }

  door(width: number): Face {
    return face(M.DOOR, this.owner, door(width));
  }

  shutter(): Face {
    return face(this.trimMat, this.owner, boards(this.trimMat, this.seed + 3, 0.15));
  }
}

type Draw = (g: Builder, b: Building, kit: Kit, step: number, world: World) => void;

/**
 * The steps every framed building goes through: stakes and a string round
 * its outline; footings and a floor; the frame of posts; walls without a
 * roof, the rafters showing; the roof half on; and finished.
 */
function rising(
  g: Builder,
  kit: Kit,
  step: number,
  w: number,
  d: number,
  eave: number,
  finish: () => void,
  ridge = eave + Math.min(w, d) * 0.55,
  alongA = true,
): void {
  const a0 = -w / 2;
  const a1 = w / 2;
  const b0 = -d / 2;
  const b1 = d / 2;
  if (step === 0) {
    stakes(g, kit, a0, a1, b0, b1);
    return;
  }
  // Footings and a plank floor.
  g.box(a0, a1, b0, b1, -0.4, 0.3, {
    front: kit.plinth,
    back: kit.plinth,
    left: kit.plinth,
    right: kit.plinth,
  });
  g.poly(
    [a0, b0, 0.3, a1, b0, 0.3, a1, b1, 0.3, a0, b1, 0.3],
    kit.planks,
    [a0, b0, 0.3],
    [1, 0, 0],
    [0, 1, 0],
  );
  if (step === 1) {
    return;
  }
  if (step === 2) {
    frame(g, kit, a0, a1, b0, b1, eave);
    scaffold(g, kit, a0, a1, b0, eave);
    return;
  }
  if (step === 3) {
    g.box(a0, a1, b0, b1, 0.3, eave, {
      front: kit.wall,
      back: kit.wall,
      left: kit.wall,
      right: kit.wall,
      top: kit.dark,
    });
    rafters(g, kit, a0, a1, b0, b1, eave, ridge, alongA);
    scaffold(g, kit, a0, a1, b0, eave);
    return;
  }
  if (step === 4) {
    g.box(a0, a1, b0, b1, 0.3, eave, {
      front: kit.wall,
      back: kit.wall,
      left: kit.wall,
      right: kit.wall,
      top: kit.dark,
    });
    rafters(g, kit, a0, a1, b0, b1, eave, ridge, alongA);
    lowerCourses(g, kit, a0, a1, b0, b1, eave, ridge, alongA, 0.5);
    return;
  }
  finish();
}

/** The lower part (`k` of the way up) of both slopes of a gable roof: a roof going on. */
function lowerCourses(
  g: Builder,
  kit: Kit,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  eave: number,
  ridge: number,
  alongA: boolean,
  k: number,
): void {
  const h = eave + (ridge - eave) * k;
  if (alongA) {
    const bf = b0 + ((b1 - b0) / 2) * k;
    const bb = b1 - ((b1 - b0) / 2) * k;
    g.poly(
      [a0, b0, eave, a1, b0, eave, a1, bf, h, a0, bf, h],
      kit.roof,
      [a0, bf, h],
      [1, 0, 0],
      [0, -1, eave - h],
    );
    g.poly(
      [a1, b1, eave, a0, b1, eave, a0, bb, h, a1, bb, h],
      kit.roof,
      [a1, bb, h],
      [-1, 0, 0],
      [0, 1, eave - h],
    );
  } else {
    const al = a0 + ((a1 - a0) / 2) * k;
    const ar = a1 - ((a1 - a0) / 2) * k;
    g.poly(
      [a0, b1, eave, a0, b0, eave, al, b0, h, al, b1, h],
      kit.roof,
      [al, b1, h],
      [0, -1, 0],
      [-1, 0, eave - h],
    );
    g.poly(
      [a1, b0, eave, a1, b1, eave, ar, b1, h, ar, b0, h],
      kit.roof,
      [ar, b0, h],
      [0, 1, 0],
      [1, 0, eave - h],
    );
  }
}

/** Stakes at the corners and a string between them, marking where it will stand. */
function stakes(g: Builder, kit: Kit, a0: number, a1: number, b0: number, b1: number): void {
  const pts: [number, number][] = [
    [a0, b0],
    [a1, b0],
    [a1, b1],
    [a0, b1],
  ];
  for (const [a, b] of pts) {
    g.line(a, b, 0, a, b, 0.6, 1, kit.timber);
  }
  const string = face(M.CLOTH, kit.owner);
  for (let k = 0; k < 4; k++) {
    const [aa, ba] = pts[k];
    const [ab, bb] = pts[(k + 1) % 4];
    g.line(aa, ba, 0.45, ab, bb, 0.45, 1, string);
  }
}

/** Posts at the corners and along the walls, a top plate round them. */
function frame(
  g: Builder,
  kit: Kit,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  eave: number,
): void {
  const t = 0.12;
  const post = (a: number, b: number) => g.solid(a - t, a + t, b - t, b + t, 0.3, eave, kit.timber);
  for (const a of spaced(a0, a1, 1.6)) {
    post(a, b0);
    post(a, b1);
  }
  for (const b of spaced(b0, b1, 1.6)) {
    post(a0, b);
    post(a1, b);
  }
  g.solid(a0 - t, a1 + t, b0 - t, b0 + t, eave - 0.2, eave, kit.timber);
  g.solid(a0 - t, a1 + t, b1 - t, b1 + t, eave - 0.2, eave, kit.timber);
  g.solid(a0 - t, a0 + t, b0, b1, eave - 0.2, eave, kit.timber);
  g.solid(a1 - t, a1 + t, b0, b1, eave - 0.2, eave, kit.timber);
}

/** Rafters in pairs up to the ridge. */
function rafters(
  g: Builder,
  kit: Kit,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  eave: number,
  ridge: number,
  alongA: boolean,
): void {
  if (alongA) {
    const mid = (b0 + b1) / 2;
    for (const a of spaced(a0, a1, 0.9)) {
      g.line(a, b0, eave, a, mid, ridge, 1, kit.timber);
      g.line(a, b1, eave, a, mid, ridge, 1, kit.timber);
    }
    g.line(a0, mid, ridge, a1, mid, ridge, 1, kit.timber);
  } else {
    const mid = (a0 + a1) / 2;
    for (const b of spaced(b0, b1, 0.9)) {
      g.line(a0, b, eave, mid, b, ridge, 1, kit.timber);
      g.line(a1, b, eave, mid, b, ridge, 1, kit.timber);
    }
    g.line(mid, b0, ridge, mid, b1, ridge, 1, kit.timber);
  }
}

/** Poles and a plank walk along the front while it goes up. */
function scaffold(g: Builder, kit: Kit, a0: number, a1: number, b0: number, eave: number): void {
  const pole = face(M.SCAFFOLD, kit.owner);
  const b = b0 - 0.8;
  for (const a of spaced(a0 - 0.3, a1 + 0.3, 2.2)) {
    g.line(a, b, 0, a, b, eave + 0.8, 1, pole);
  }
  for (let h = 1.4; h < eave; h += 1.5) {
    g.solid(a0 - 0.3, a1 + 0.3, b - 0.2, b + 0.35, h - 0.08, h, pole);
  }
}

/** Evenly spaced positions from lo to hi, about `gap` apart, both ends included. */
function spaced(lo: number, hi: number, gap: number): number[] {
  const n = Math.max(1, Math.round((hi - lo) / gap));
  return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
}

/** Windows along a wall at the given u positions, with shutters either side. */
function windows(
  g: Builder,
  kit: Kit,
  side: Side,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  at: readonly number[],
  h: number,
  width = 0.6,
  height = 0.8,
  shutters = true,
): void {
  const pane = kit.window(width, height);
  const shutter = kit.shutter();
  for (const u of at) {
    g.opening(side, a0, a1, b0, b1, u, h, width, height, pane, 0.03);
    if (shutters) {
      g.opening(side, a0, a1, b0, b1, u - width / 2 - 0.16, h, 0.3, height, shutter, 0.05);
      g.opening(side, a0, a1, b0, b1, u + width / 2 + 0.16, h, 0.3, height, shutter, 0.05);
    }
  }
}

/** A chimney of rough stone rising through the roof. */
function chimney(
  g: Builder,
  kit: Kit,
  a: number,
  b: number,
  h0: number,
  h1: number,
  size = 0.7,
): void {
  g.solid(
    a - size / 2,
    a + size / 2,
    b - size / 2,
    b + size / 2,
    h0,
    h1,
    kit.plinth,
    face(M.TIMBER, kit.owner, () => packed(M.TIMBER, 40)),
  );
}

/** The simple things of the first years: a tent by a fire ring, and a cart. */
const drawCamp: Draw = (g, _b, kit, step) => {
  if (step === 0) {
    return;
  }
  const cloth = face(M.CLOTH, kit.owner, plain(M.CLOTH, kit.seed, 18), true);
  // An A-frame tent.
  const w = 2.4;
  const d = 3;
  g.poly(
    [-w / 2, -d / 2, 0, -w / 2, d / 2, 0, 0, d / 2, 1.9, 0, -d / 2, 1.9],
    cloth,
    [0, -d / 2, 1.9],
    [0, 1, 0],
    [-1, 0, -1],
  );
  g.poly(
    [w / 2, d / 2, 0, w / 2, -d / 2, 0, 0, -d / 2, 1.9, 0, d / 2, 1.9],
    cloth,
    [0, d / 2, 1.9],
    [0, -1, 0],
    [1, 0, -1],
  );
  g.poly(
    [-w / 2, -d / 2, 0, w / 2, -d / 2, 0, 0, -d / 2, 1.9],
    kit.dark,
    [-w / 2, -d / 2, 0],
    [1, 0, 0],
    [0, 0, 1],
  );
  g.poly(
    [w / 2, d / 2, 0, -w / 2, d / 2, 0, 0, d / 2, 1.9],
    cloth,
    [w / 2, d / 2, 0],
    [-1, 0, 0],
    [0, 0, 1],
  );
  // The fire ring in front.
  const ring = face(M.STONE_ROUGH, kit.owner, plain(M.STONE_ROUGH, kit.seed, 30));
  g.cylinder(
    1.9,
    -2.2,
    0.55,
    -0.1,
    0.12,
    ring,
    face(M.ASH_GROUND, kit.owner, plain(M.ASH_GROUND, kit.seed, 20)),
  );
};

const drawCabin: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const eave = 2.3;
  const ridge = eave + d * 0.46;
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      const walls = kit.wallFace(M.LOG, eave, w);
      const sides = kit.wallFace(M.LOG, eave, d);
      g.box(a0, a1, b0, b1, 0, eave, { front: walls, back: walls, left: sides, right: sides });
      g.gable(
        a0,
        a1,
        b0,
        b1,
        eave,
        ridge,
        true,
        0.4,
        kit.roof,
        face(M.PLANK, kit.owner, boards(M.PLANK, kit.seed)),
        kit.fascia,
      );
      g.opening("front", a0, a1, b0, b1, w * 0.35, 0, 0.9, 1.8, kit.door(0.9));
      windows(g, kit, "front", a0, a1, b0, b1, [w * 0.74], 1, 0.55, 0.6, false);
      windows(g, kit, "left", a0, a1, b0, b1, [d / 2], 1, 0.5, 0.55, false);
      chimney(g, kit, a1 - 0.2, 0.4, 0, ridge + 0.6, 0.8);
    },
    ridge,
  );
};

const drawHouse: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const eave = 2.8;
  const ridge = eave + w * 0.62;
  // Eaves to the street, the ridge running back.
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      g.box(a0, a1, b0, b1, -0.3, 0.45, {
        front: kit.plinth,
        back: kit.plinth,
        left: kit.plinth,
        right: kit.plinth,
      });
      g.box(a0, a1, b0, b1, 0.45, eave, {
        front: kit.wall,
        back: kit.wall,
        left: kit.wall,
        right: kit.wall,
      });
      g.gable(
        a0,
        a1,
        b0,
        b1,
        eave,
        ridge,
        false,
        0.45,
        kit.roof,
        kit.wallFace(kit.wallMat, 2.8),
        kit.fascia,
      );
      g.opening("front", a0, a1, b0, b1, w * 0.5, 0.45, 0.95, 1.9, kit.door(0.95));
      windows(g, kit, "front", a0, a1, b0, b1, [w * 0.2, w * 0.8], 1.35);
      windows(g, kit, "front", a0, a1, b0, b1, [w * 0.5], eave + 0.9, 0.5, 0.55, false);
      windows(g, kit, "left", a0, a1, b0, b1, [d * 0.3, d * 0.7], 1.35);
      windows(g, kit, "right", a0, a1, b0, b1, [d * 0.5], 1.35);
      chimney(g, kit, a0 + w * 0.3, d * 0.2, 1, ridge + 0.4);
    },
    ridge,
    false,
  );
};

const drawFarmhouse: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const eave = 2.6;
  const ridge = eave + w * 0.5;
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      g.box(a0, a1, b0, b1, -0.3, 0.4, {
        front: kit.plinth,
        back: kit.plinth,
        left: kit.plinth,
        right: kit.plinth,
      });
      g.box(a0, a1, b0, b1, 0.4, eave, {
        front: kit.wall,
        back: kit.wall,
        left: kit.wall,
        right: kit.wall,
      });
      g.hip(a0, a1, b0, b1, eave, ridge, 0.6, kit.roof);
      // The house end toward the street; the byre's big doors down the side.
      g.opening("front", a0, a1, b0, b1, w * 0.5, 0.4, 0.95, 1.9, kit.door(0.95));
      windows(g, kit, "front", a0, a1, b0, b1, [w * 0.2, w * 0.8], 1.3);
      g.opening(
        "right",
        a0,
        a1,
        b0,
        b1,
        d * 0.7,
        0.4,
        2.2,
        2.1,
        face(M.PLANK, kit.owner, boards(M.PLANK, kit.seed + 2, 0.3)),
      );
      windows(g, kit, "right", a0, a1, b0, b1, [d * 0.2], 1.3);
      windows(g, kit, "left", a0, a1, b0, b1, [d * 0.25, d * 0.6], 1.3);
      chimney(g, kit, 0, farmChimney(w, d), 1, ridge + 0.6);
    },
    ridge,
    false,
  );
};

/** Where along a farmhouse `w` by `d` its chimney stands: on the hip roof's ridge, near its front end. */
function farmChimney(w: number, d: number): number {
  return Math.min(0, (w - d) / 2 + 0.4);
}

const drawTownhouse: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const ground = 3;
  const upper = 2.7;
  const eave = ground + upper;
  const ridge = eave + w * 0.85;
  const jetty = 0.35;
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      const stoneGround = b.kind === "stonehouse";
      const lower = stoneGround ? kit.stone : kit.wallFace(kit.wallMat, ground);
      g.box(a0, a1, b0, b1, -0.3, 0.4, {
        front: kit.plinth,
        back: kit.plinth,
        left: kit.plinth,
        right: kit.plinth,
      });
      g.box(a0, a1, b0, b1, 0.4, ground, { front: lower, back: lower, left: lower, right: lower });
      // The upper floor juts out over the street.
      const up = kit.wallFace(kit.wallMat, upper);
      g.box(a0 - 0.05, a1 + 0.05, b0 - jetty, b1, ground, eave, {
        front: up,
        back: up,
        left: up,
        right: up,
      });
      g.box(a0 - 0.05, a1 + 0.05, b0 - jetty, b0, ground - 0.18, ground, {
        front: kit.timber,
        left: kit.timber,
        right: kit.timber,
      });
      // Gable to the street, the ridge running back.
      g.gable(
        a0 - 0.05,
        a1 + 0.05,
        b0 - jetty,
        b1,
        eave,
        ridge,
        false,
        0.3,
        kit.roof,
        up,
        kit.fascia,
      );
      g.opening("front", a0, a1, b0, b1, w * 0.28, 0.4, 1, 2.1, kit.door(1));
      windows(g, kit, "front", a0, a1, b0, b1, [w * 0.72], 1.2, 0.8, 1);
      windows(
        g,
        kit,
        "front",
        a0 - 0.05,
        a1 + 0.05,
        b0 - jetty,
        b1,
        [w * 0.28, w * 0.72],
        ground + 0.8,
        0.6,
        0.9,
      );
      windows(
        g,
        kit,
        "front",
        a0 - 0.05,
        a1 + 0.05,
        b0 - jetty,
        b1,
        [w * 0.5],
        eave + 0.9,
        0.55,
        0.7,
        false,
      );
      windows(
        g,
        kit,
        "left",
        a0 - 0.05,
        a1 + 0.05,
        b0 - jetty,
        b1,
        [d * 0.35, d * 0.75],
        ground + 0.8,
        0.55,
        0.85,
      );
      windows(
        g,
        kit,
        "right",
        a0 - 0.05,
        a1 + 0.05,
        b0 - jetty,
        b1,
        [d * 0.5],
        ground + 0.8,
        0.55,
        0.85,
      );
      chimney(g, kit, a1 - 1.2, d * 0.15, 2, ridge - 0.6);
    },
    ridge,
    false,
  );
};

const drawBarn: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const eave = 3.2;
  const ridge = eave + w * 0.6;
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      const plank = face(M.PLANK, kit.owner, boards(M.PLANK, kit.seed, 0.3));
      g.box(a0, a1, b0, b1, -0.2, eave, { front: plank, back: plank, left: plank, right: plank });
      g.gable(a0, a1, b0, b1, eave, ridge, false, 0.5, kit.roof, plank, kit.fascia);
      // Great doors in the gable end, a hay loft door above.
      g.opening(
        "front",
        a0,
        a1,
        b0,
        b1,
        w / 2,
        0,
        3,
        2.8,
        face(M.PLANK, kit.owner, boards(M.DOOR, kit.seed + 4, 0.3)),
      );
      g.opening("front", a0, a1, b0, b1, w / 2, eave + 0.5, 1, 1, kit.dark);
    },
    ridge,
    false,
  );
};

const drawWorkshop: Draw = (g, b, kit, step, world) => {
  drawHouse(g, b, kit, step, world);
  if (step < 5) {
    return;
  }
  // An open lean-to shed along one side, with a bench under it.
  const w = b.rect.width;
  const d = b.rect.depth;
  const a1 = w / 2;
  g.poly(
    [a1, -d / 2, 2.6, a1, d / 2, 2.6, a1 + 2, d / 2, 1.9, a1 + 2, -d / 2, 1.9],
    kit.roof,
    [a1, -d / 2, 2.6],
    [0, 1, 0],
    [1, 0, -0.35],
  );
  for (const b0 of [-d / 2 + 0.2, d / 2 - 0.2]) {
    g.solid(a1 + 1.8, a1 + 2, b0 - 0.1, b0 + 0.1, 0, 1.9, kit.timber);
  }
  g.solid(a1 + 0.4, a1 + 1.4, -d / 4, d / 4, 0.7, 0.85, kit.planks);
};

const drawWell: Draw = (g, _b, kit, step) => {
  if (step === 0) {
    stakes(g, kit, -0.9, 0.9, -0.9, 0.9);
    return;
  }
  const rim = face(M.STONE_ROUGH, kit.owner, stoneCourses(M.STONE_ROUGH, kit.seed, true));
  g.cylinder(
    0,
    0,
    0.95,
    -0.3,
    step >= 2 ? 0.85 : 0.4,
    rim,
    face(M.WATER, kit.owner, () => packed(M.TIMBER, 30)),
  );
  if (step < 4) {
    return;
  }
  // Two posts, a windlass and a little roof.
  g.solid(-1.05, -0.9, -0.08, 0.08, 0.3, 2.3, kit.timber);
  g.solid(0.9, 1.05, -0.08, 0.08, 0.3, 2.3, kit.timber);
  g.line(-0.9, 0, 1.5, 0.9, 0, 1.5, 1, kit.timber);
  g.gable(-1.25, 1.25, -0.75, 0.75, 2.2, 2.9, true, 0.1, kit.roof, null, kit.fascia);
};

const drawSmithy: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const eave = 2.8;
  const ridge = eave + w * 0.55;
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      // Stone walls at the back and sides; the front half open under the roof, on posts.
      const wall = kit.stone;
      g.box(a0, a1, b0 + d * 0.4, b1, 0, eave, {
        front: wall,
        back: wall,
        left: wall,
        right: wall,
      });
      g.box(a0 + 0.2, a1 - 0.2, b0, b0 + d * 0.4, -0.1, 0.05, {
        top: face(M.DIRT, kit.owner, plain(M.ASH_GROUND, kit.seed, 30)),
      });
      for (const a of [a0 + 0.15, a1 - 0.15]) {
        g.solid(a - 0.14, a + 0.14, b0 + 0.1, b0 + 0.38, 0, eave, kit.timber);
      }
      // The forge and its glow, the anvil before it.
      g.solid(
        a0 + 0.6,
        a0 + 2,
        b0 + d * 0.4 - 1.1,
        b0 + d * 0.4,
        0,
        0.9,
        kit.plinth,
        face(M.FORGE, kit.owner, plain(M.FORGE, kit.seed, 60)),
      );
      g.solid(0.4, 0.9, b0 + 1.2, b0 + 1.45, 0, 0.75, kit.iron);
      g.gable(a0, a1, b0, b1, eave, ridge, false, 0.4, kit.roof, wall, kit.fascia);
      windows(g, kit, "left", a0, a1, b0, b1, [d * 0.3], 1.3, 0.6, 0.6, false);
      chimney(g, kit, a0 + 1.2, b0 + d * 0.4 - 0.5, 0, ridge + 0.8, 1);
    },
    ridge,
    false,
  );
};

const drawBakery: Draw = (g, b, kit, step, world) => {
  drawHouse(g, b, kit, step, world);
  if (step < 5) {
    return;
  }
  // The oven, a dome of clay against the side wall, and its own chimney.
  const w = b.rect.width;
  const clay = face(M.STONE_ROUGH, kit.owner, plain(M.PLASTER_WARM, kit.seed, 26));
  g.solid(w / 2, w / 2 + 1.8, -0.6, 1.4, 0, 0.7, kit.plinth);
  g.cone(w / 2 + 0.9, 0.4, 1, 0.7, 1.9, clay);
  chimney(g, kit, w / 2 + 0.4, 1.2, 0.7, 4.4, 0.5);
};

const drawTavern: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const ground = 3.2;
  const eave = ground + 2.8;
  const ridge = eave + Math.min(w, d) * 0.5;
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      g.box(a0, a1, b0, b1, -0.3, ground, {
        front: kit.stone,
        back: kit.stone,
        left: kit.stone,
        right: kit.stone,
      });
      const up = kit.wallFace(kit.wallMat, 2.8);
      g.box(a0 - 0.1, a1 + 0.1, b0 - 0.3, b1 + 0.1, ground, eave, {
        front: up,
        back: up,
        left: up,
        right: up,
      });
      g.hip(a0 - 0.1, a1 + 0.1, b0 - 0.3, b1 + 0.1, eave, ridge, 0.45, kit.roof);
      g.opening("front", a0, a1, b0, b1, w * 0.5, 0, 1.4, 2.3, kit.door(1.4));
      windows(
        g,
        kit,
        "front",
        a0,
        a1,
        b0,
        b1,
        [w * 0.18, w * 0.34, w * 0.66, w * 0.82],
        1.2,
        0.75,
        1.1,
        false,
      );
      windows(
        g,
        kit,
        "front",
        a0 - 0.1,
        a1 + 0.1,
        b0 - 0.3,
        b1,
        [w * 0.15, w * 0.38, w * 0.62, w * 0.85],
        ground + 0.8,
        0.6,
        1,
      );
      windows(g, kit, "left", a0 - 0.1, a1, b0 - 0.3, b1, [d * 0.3, d * 0.7], ground + 0.8, 0.6, 1);
      windows(
        g,
        kit,
        "right",
        a0,
        a1 + 0.1,
        b0 - 0.3,
        b1,
        [d * 0.3, d * 0.7],
        ground + 0.8,
        0.6,
        1,
      );
      windows(g, kit, "left", a0, a1, b0, b1, [d * 0.5], 1.2, 0.7, 1, false);
      // The sign hanging on its bracket over the door.
      g.line(w * 0.08, b0, ground + 0.6, w * 0.08, b0 - 1.2, ground + 0.6, 1, kit.iron);
      g.box(w * 0.08 - 0.05, w * 0.08 + 0.05, b0 - 1.1, b0 - 0.4, ground - 0.3, ground + 0.5, {
        left: face(M.CLOTH_RED, kit.owner, plain(M.CLOTH_RED, kit.seed, 30)),
        right: face(M.CLOTH_RED, kit.owner, plain(M.CLOTH_RED, kit.seed, 30)),
        front: kit.timber,
      });
      chimney(g, kit, a0 + 1.5, 0.5, ground, ridge + 0.4, 0.8);
      chimney(g, kit, a1 - 1.5, 0.5, ground, ridge + 0.4, 0.8);
    },
    ridge,
  );
};

const drawChapel: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const eave = 3.2;
  const ridge = eave + w * 0.75;
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      const plank = face(M.PLANK, kit.owner, boards(M.PLANK, kit.seed, 0.22));
      g.box(a0, a1, b0, b1, -0.3, 0.4, {
        front: kit.plinth,
        back: kit.plinth,
        left: kit.plinth,
        right: kit.plinth,
      });
      g.box(a0, a1, b0, b1, 0.4, eave, { front: plank, back: plank, left: plank, right: plank });
      g.gable(a0, a1, b0, b1, eave, ridge, false, 0.4, kit.roof, plank, kit.fascia);
      g.opening("front", a0, a1, b0, b1, w / 2, 0.4, 1.3, 2.2, kit.door(1.3));
      for (const side of ["left", "right"] as const) {
        windows(g, kit, side, a0, a1, b0, b1, [d * 0.3, d * 0.55, d * 0.8], 1.3, 0.45, 1.3, false);
      }
      // A little bell turret astride the front of the ridge.
      const t0 = b0 + 0.6;
      g.solid(-0.7, 0.7, t0, t0 + 1.4, ridge - 1.2, ridge + 1.2, plank);
      g.opening("front", -0.7, 0.7, t0, t0 + 1.4, 0.7, ridge + 0.1, 0.8, 0.9, kit.dark);
      g.pyramid(-0.85, 0.85, t0 - 0.15, t0 + 1.55, ridge + 1.2, ridge + 3, kit.roof);
      g.line(0, t0 + 0.7, ridge + 3, 0, t0 + 0.7, ridge + 3.8, 1, face(M.GOLD, kit.owner));
    },
    ridge,
    false,
  );
};

const drawChurch: Draw = (g, b, kit, step) => {
  // Broadside to its street: the nave runs along the front.
  const w = b.rect.width;
  const d = b.rect.depth;
  const nave = w - 5.5;
  const eave = 7;
  const ridge = eave + d * 0.72;
  const a0 = -w / 2 + 5.5;
  const a1 = w / 2;
  const b0 = -d / 2 + 0.8;
  const b1 = d / 2 - 0.8;
  const t0 = -w / 2;
  const t1 = -w / 2 + 5.5;
  const tb0 = -d / 2 + 2.4;
  const tb1 = tb0 + 5.5;
  const towerTop = 17;
  if (step === 0) {
    stakes(g, kit, t0, a1, b0, b1);
    return;
  }
  g.box(t0, a1, b0, b1, -0.4, 0.6, {
    front: kit.plinth,
    back: kit.plinth,
    left: kit.plinth,
    right: kit.plinth,
    top: kit.planks,
  });
  if (step === 1) {
    return;
  }
  const wall = kit.stone;
  const rise = step === 2 ? 0.35 : step === 3 ? 0.75 : 1;
  g.box(a0, a1, b0, b1, 0.6, eave * rise, {
    front: wall,
    back: wall,
    left: wall,
    right: wall,
    top: step < 5 ? kit.dark : undefined,
  });
  g.box(t0, t1, tb0, tb1, 0.6, towerTop * rise * (step < 5 ? 0.85 : 1), {
    front: wall,
    back: wall,
    left: wall,
    right: wall,
    top: step < 5 ? kit.dark : undefined,
  });
  if (step < 5) {
    scaffold(g, kit, a0, a1, b0, eave * rise);
    if (step === 4) {
      rafters(g, kit, a0, a1, b0, b1, eave, ridge, true);
    }
    return;
  }
  g.gable(a0, a1, b0, b1, eave, ridge, true, 0.5, kit.roof, wall, kit.fascia);
  // Tall arched windows down the nave, a great door in its middle.
  const arch = kit.window(0.8, 2.6);
  for (let k = 0; k < 4; k++) {
    const u = nave * (0.12 + 0.25 * k);
    if (k === 2) {
      continue;
    }
    g.opening("front", a0, a1, b0, b1, u, 2.4, 0.8, 2.6, arch, 0.04);
  }
  g.opening("front", a0, a1, b0, b1, nave * 0.62, 0.6, 1.8, 3, kit.door(1.8));
  g.opening("right", a0, a1, b0, b1, (b1 - b0) / 2, 2.8, 1.6, 1.6, kit.window(1.6, 1.6));
  // The tower: belfry openings near the top, and the spire.
  const tw = t1 - t0;
  for (const side of ["front", "left", "right"] as const) {
    g.opening(side, t0, t1, tb0, tb1, tw / 2, towerTop - 3, 1.2, 2, kit.dark, 0.04);
  }
  g.opening("front", t0, t1, tb0, tb1, tw / 2, towerTop - 7, 0.5, 1.6, kit.window(0.5, 1.6));
  g.pyramid(t0 - 0.2, t1 + 0.2, tb0 - 0.2, tb1 + 0.2, towerTop, towerTop + 8.5, kit.roof);
  g.line(
    -w / 2 + tw / 2,
    tb0 + tw / 2,
    towerTop + 8.5,
    -w / 2 + tw / 2,
    tb0 + tw / 2,
    towerTop + 9.6,
    1,
    face(M.GOLD, kit.owner),
  );
};

const drawTownhall: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const ground = 3.6;
  const eave = ground + 3.2;
  const ridge = eave + Math.min(w, d) * 0.5;
  rising(
    g,
    kit,
    step,
    w,
    d,
    eave,
    () => {
      const a0 = -w / 2;
      const a1 = w / 2;
      const b0 = -d / 2;
      const b1 = d / 2;
      // An arcade of arches along the front, the market hall behind it.
      g.box(a0, a1, b0, b1, -0.3, ground, { back: kit.stone, left: kit.stone, right: kit.stone });
      g.wall("front", a0, a1, b0 + 1.6, b1, 0, ground, kit.dark);
      const arches = 4;
      for (let k = 0; k <= arches; k++) {
        const a = a0 + (w * k) / arches;
        g.solid(a - 0.35, a + 0.35, b0, b0 + 0.7, 0, ground - 0.6, kit.stone);
      }
      g.box(a0, a1, b0, b0 + 0.7, ground - 0.6, ground, { front: kit.stone, top: kit.stone });
      g.poly(
        [a0, b0, 0.02, a1, b0, 0.02, a1, b0 + 1.6, 0.02, a0, b0 + 1.6, 0.02],
        face(M.FLAGSTONE, kit.owner, plain(M.FLAGSTONE, kit.seed, 20)),
        [a0, b0, 0],
        [1, 0, 0],
        [0, 1, 0],
      );
      const up = kit.wallFace(kit.wallMat, 3.2);
      g.box(a0, a1, b0, b1, ground, eave, { front: up, back: up, left: up, right: up });
      g.hip(a0, a1, b0, b1, eave, ridge, 0.5, kit.roof);
      windows(
        g,
        kit,
        "front",
        a0,
        a1,
        b0,
        b1,
        [w * 0.14, w * 0.38, w * 0.62, w * 0.86],
        ground + 0.9,
        0.7,
        1.3,
      );
      windows(g, kit, "left", a0, a1, b0, b1, [d * 0.3, d * 0.7], ground + 0.9, 0.7, 1.3);
      windows(g, kit, "right", a0, a1, b0, b1, [d * 0.3, d * 0.7], ground + 0.9, 0.7, 1.3);
      // A small clock turret on the ridge.
      const cb = 0;
      g.solid(-0.8, 0.8, cb - 0.8, cb + 0.8, ridge - 1, ridge + 1.6, up);
      g.opening(
        "front",
        -0.8,
        0.8,
        cb - 0.8,
        cb + 0.8,
        0.8,
        ridge + 0.2,
        0.9,
        0.9,
        face(M.PLASTER, kit.owner, (u, v) =>
          Math.hypot(u - 0.45, v - 0.45) < 0.45
            ? packed(Math.hypot(u - 0.45, v - 0.45) < 0.1 ? M.IRON : M.PLASTER, 140)
            : packed(M.TIMBER, 110),
        ),
      );
      g.pyramid(-1, 1, cb - 1, cb + 1, ridge + 1.6, ridge + 3.4, kit.roof);
    },
    ridge,
  );
};

const drawWatermill: Draw = (g, b, kit, step, world) => {
  drawHouse(g, b, kit, step, world);
  if (step < 5) {
    return;
  }
  // The race: a wooden channel along the river side; the wheel itself turns and is drawn apart.
  const w = b.rect.width;
  const d = b.rect.depth;
  g.solid(-w / 2 - 2.4, -w / 2 - 0.2, -d / 2 + 0.6, d / 2 - 0.6, -1.2, -0.2, kit.planks);
  g.solid(-w / 2 - 0.35, -w / 2 - 0.1, -0.2, 0.2, 0.2, 2.2, kit.timber);
};

const drawWindmill: Draw = (g, _b, kit, step) => {
  if (step === 0) {
    stakes(g, kit, -2, 2, -2, 2);
    return;
  }
  // A post mill: a trestle, the post, and the body turning on it.
  const t = kit.timber;
  g.line(-1.8, -1.8, 0, 0, 0, 2.4, 2, t);
  g.line(1.8, -1.8, 0, 0, 0, 2.4, 2, t);
  g.line(-1.8, 1.8, 0, 0, 0, 2.4, 2, t);
  g.line(1.8, 1.8, 0, 0, 0, 2.4, 2, t);
  g.solid(-0.2, 0.2, -0.2, 0.2, 0, step >= 2 ? 3 : 1.4, t);
  if (step < 3) {
    return;
  }
  const plank = face(M.PLANK, kit.owner, boards(M.PLANK, kit.seed, 0.2));
  const top = step >= 4 ? 6.8 : 5.5;
  g.box(-1.5, 1.5, -1.8, 1.8, 3, top, {
    front: plank,
    back: plank,
    left: plank,
    right: plank,
    top: kit.dark,
  });
  if (step >= 4) {
    g.gable(-1.5, 1.5, -1.8, 1.8, 6.8, 8.4, false, 0.2, kit.roof, plank, kit.fascia);
  }
  if (step >= 5) {
    g.opening("back", -1.5, 1.5, -1.8, 1.8, 1.5, 3.1, 0.8, 1.6, kit.door(0.8));
    g.line(0, 1.8, 3.1, 0, 3.8, 0, 2, t);
    windows(g, kit, "left", -1.5, 1.5, -1.8, 1.8, [1.8], 4.6, 0.5, 0.5, false);
  }
};

const drawLumberyard: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  if (step === 0) {
    stakes(g, kit, -w / 2, w / 2, -d / 2, d / 2);
    return;
  }
  // An open shed at the back: posts and a shingled roof over the saw pit.
  const b0 = d / 2 - 4.5;
  const b1 = d / 2 - 0.3;
  const a0 = -w / 2 + 0.5;
  const a1 = w / 2 - 4;
  for (const a of spaced(a0, a1, 3)) {
    for (const bb of [b0, b1]) {
      g.solid(a - 0.14, a + 0.14, bb - 0.14, bb + 0.14, 0, step >= 3 ? 3 : 1.5, kit.timber);
    }
  }
  if (step >= 4) {
    g.gable(a0, a1, b0, b1, 3, 4.4, true, 0.4, kit.roof, null, kit.fascia);
  }
  // The saw pit and its trestle.
  g.box(-1.5, 1.5, b0 + 1, b0 + 2.4, -0.6, 0.02, { top: kit.dark });
  g.line(-1.5, b0 + 1.7, 1, 1.5, b0 + 1.7, 1, 2, kit.planks);
};

const drawQuarry: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  if (step === 0) {
    stakes(g, kit, -w / 2, w / 2, -d / 2, d / 2);
    return;
  }
  // Cut faces of rock at the back, stepped; a crane of timber over the pit.
  const rock = face(M.ROCK, kit.owner, stoneCourses(M.ROCK, kit.seed, true));
  const rough = face(M.ROCK, kit.owner, plain(M.ROCK, kit.seed, 36));
  g.box(-w / 2, w / 2, d / 2 - 3, d / 2, 0, 3.6, {
    front: rock,
    left: rock,
    right: rock,
    top: rough,
  });
  g.box(-w / 2 + 2, w / 2 - 3, d / 2 - 5, d / 2 - 3, 0, 1.6, {
    front: rock,
    left: rock,
    right: rock,
    top: rough,
  });
  if (step >= 3) {
    g.line(w / 2 - 3, 0, 0, w / 2 - 3, 0, 5, 2, kit.timber);
    g.line(w / 2 - 3, 0, 5, w / 2 - 6.5, d / 2 - 4, 4.2, 1, kit.timber);
    g.line(w / 2 - 6.5, d / 2 - 4, 4.2, w / 2 - 6.5, d / 2 - 4, 2, 1, face(M.CLOTH, kit.owner));
  }
};

const drawWatchtower: Draw = (g, _b, kit, step) => {
  if (step === 0) {
    stakes(g, kit, -1.4, 1.4, -1.4, 1.4);
    return;
  }
  const t = kit.timber;
  const top = step >= 3 ? 7.2 : step === 2 ? 4.5 : 1.5;
  for (const [a, bb] of [
    [-1.3, -1.3],
    [1.3, -1.3],
    [1.3, 1.3],
    [-1.3, 1.3],
  ] as const) {
    g.solid(a - 0.14, a + 0.14, bb - 0.14, bb + 0.14, 0, top, t);
  }
  // Cross braces.
  for (let h = 0.5; h + 2.2 <= top; h += 2.2) {
    g.line(-1.3, -1.3, h, 1.3, -1.3, h + 2.2, 1, t);
    g.line(1.3, -1.3, h, 1.3, 1.3, h + 2.2, 1, t);
    g.line(-1.3, -1.3, h, -1.3, 1.3, h + 2.2, 1, t);
  }
  if (step < 3) {
    return;
  }
  // The platform, its parapet, and a roof over it.
  const plank = face(M.PLANK, kit.owner, boards(M.PLANK, kit.seed, 0.2));
  g.box(-1.6, 1.6, -1.6, 1.6, 7.0, 7.25, {
    front: plank,
    left: plank,
    right: plank,
    top: kit.planks,
  });
  g.box(-1.6, 1.6, -1.6, 1.6, 7.25, 8.2, { front: plank, left: plank, right: plank });
  if (step >= 4) {
    for (const [a, bb] of [
      [-1.5, -1.5],
      [1.5, -1.5],
    ] as const) {
      g.solid(a - 0.08, a + 0.08, bb - 0.08, bb + 0.08, 8.2, 9.4, t);
    }
    g.pyramid(-1.9, 1.9, -1.9, 1.9, 9.4, 10.8, kit.roof);
  }
  // The ladder up one side.
  g.line(-0.35, -1.45, 0, -0.35, -1.45, 7, 1, t);
  g.line(0.35, -1.45, 0, 0.35, -1.45, 7, 1, t);
};

const drawWizard: Draw = (g, _b, kit, step) => {
  if (step === 0) {
    stakes(g, kit, -2.8, 2.8, -2.8, 2.8);
    return;
  }
  const r = 2.8;
  const stone = face(M.STONE, kit.owner, stoneCourses(M.STONE, kit.seed));
  const top = step >= 5 ? 16 : [0, 1.2, 5, 10, 14][step];
  g.cylinder(0, 0, r + 0.25, -0.4, 0.8, kit.plinth, null);
  g.cylinder(0, 0, r, 0.8, top, stone, step < 5 ? kit.dark : null);
  if (step < 5) {
    return;
  }
  // A ring of battlement-like corbels, the tall cone, a star on the point.
  g.cylinder(0, 0, r + 0.3, top - 0.6, top, stone, null);
  g.cone(0, 0, r + 0.6, top, top + 7, kit.roof);
  g.line(0, 0, top + 7, 0, 0, top + 8.2, 1, face(M.GOLD, kit.owner));
  // Windows: tall ones winding up, glowing at night.
  const magic = face(M.WINDOW, kit.owner, windowPane(0.5, 1.1));
  for (const [angle, h] of [
    [-0.4, 3],
    [0.5, 7],
    [-0.2, 11.2],
  ] as const) {
    const a = Math.sin(angle) * (r + 0.02);
    const bb = -Math.cos(angle) * (r + 0.02);
    g.poly(
      [
        a - 0.25 * Math.cos(angle),
        bb - 0.25 * Math.sin(angle),
        h,
        a + 0.25 * Math.cos(angle),
        bb + 0.25 * Math.sin(angle),
        h,
        a + 0.25 * Math.cos(angle),
        bb + 0.25 * Math.sin(angle),
        h + 1.1,
        a - 0.25 * Math.cos(angle),
        bb - 0.25 * Math.sin(angle),
        h + 1.1,
      ],
      magic,
      [a - 0.25 * Math.cos(angle), bb - 0.25 * Math.sin(angle), h],
      [Math.cos(angle), Math.sin(angle), 0],
      [0, 0, 1],
    );
  }
  g.opening("front", -1, 1, -r - 0.05, r, 1, 0.8, 1, 2, kit.door(1));
};

/** Stakes along a stretch of wall: the rect runs along the wall, its depth across it. */
const drawPalisade: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const count = Math.max(1, Math.floor(w / 0.3));
  const shown = step >= 5 ? count : Math.floor((count * Math.max(0, step - 1)) / 4);
  const stake = face(M.PALISADE, kit.owner, (u, v) =>
    packed(M.PALISADE, 112 + hash2(Math.floor(u / 0.2), 7) * 20 + (v > 2.6 ? 16 : 0)),
  );
  const tip = face(M.PALISADE, kit.owner, plain(M.PALISADE, kit.seed, 20));
  for (let k = 0; k < shown; k++) {
    const a = -w / 2 + (k + 0.5) * (w / count);
    const h = 2.9 + hash2(k, kit.seed) * 0.35;
    g.cylinder(a, 0, 0.15, -0.3, h, stake, null);
    g.cone(a, 0, 0.15, h, h + 0.35, tip);
  }
  if (step >= 4) {
    // A rail behind, and a walkway of planks at the gate side is left to the gates.
    g.solid(-w / 2, w / 2, 0.15, 0.3, 1.9, 2.1, kit.timber);
  }
};

const drawWall: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const top = 5.4;
  const rise = step >= 5 ? 1 : [0, 0.15, 0.45, 0.75, 0.95][step];
  const stone = face(M.STONE, kit.owner, stoneCourses(M.STONE, kit.seed));
  const walk = face(M.FLAGSTONE, kit.owner, plain(M.STONE, kit.seed, 26));
  if (step === 0) {
    stakes(g, kit, -w / 2, w / 2, -d / 2, d / 2);
    return;
  }
  g.box(-w / 2, w / 2, -d / 2, d / 2, -0.5, top * rise, {
    front: stone,
    back: stone,
    left: stone,
    right: stone,
    top: walk,
  });
  if (step < 5) {
    return;
  }
  // Merlons along the outer edge.
  const n = Math.max(1, Math.round(w / 1.2));
  for (let k = 0; k < n; k++) {
    const a = -w / 2 + ((k + 0.5) * w) / n;
    g.solid(a - 0.33, a + 0.33, -d / 2, -d / 2 + 0.5, top, top + 0.8, stone);
  }
};

const drawTower: Draw = (g, _b, kit, step) => {
  const r = 2.9;
  const top = 7.6;
  const rise = step >= 5 ? 1 : [0, 0.12, 0.45, 0.8, 1][step];
  const stone = face(M.STONE, kit.owner, stoneCourses(M.STONE, kit.seed));
  if (step === 0) {
    stakes(g, kit, -r, r, -r, r);
    return;
  }
  g.cylinder(0, 0, r, -0.5, top * rise, stone, step < 4 ? kit.dark : null);
  if (step < 4) {
    return;
  }
  g.cylinder(0, 0, r + 0.25, top - 0.5, top, stone, null);
  g.cone(0, 0, r + 0.5, top, top + 4.6, kit.roof);
  // Arrow slits.
  for (const angle of [-0.6, 0, 0.6]) {
    const a = Math.sin(angle) * (r + 0.02);
    const bb = -Math.cos(angle) * (r + 0.02);
    g.poly(
      [
        a - 0.1 * Math.cos(angle),
        bb - 0.1 * Math.sin(angle),
        3.8,
        a + 0.1 * Math.cos(angle),
        bb + 0.1 * Math.sin(angle),
        3.8,
        a + 0.1 * Math.cos(angle),
        bb + 0.1 * Math.sin(angle),
        4.8,
        a - 0.1 * Math.cos(angle),
        bb - 0.1 * Math.sin(angle),
        4.8,
      ],
      kit.dark,
      [a, bb, 3.8],
      [Math.cos(angle), Math.sin(angle), 0],
      [0, 0, 1],
    );
  }
};

/** The rect of a gate runs along the wall: width along it, depth across (the way through). */
const drawWoodgate: Draw = (g, b, kit, step) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  if (step === 0) {
    stakes(g, kit, -w / 2, w / 2, -d / 2, d / 2);
    return;
  }
  const plank = face(M.PLANK, kit.owner, boards(M.PALISADE, kit.seed, 0.3));
  const towerW = 2.2;
  const top = step >= 3 ? 5.2 : 2.5;
  for (const a0 of [-w / 2, w / 2 - towerW]) {
    g.box(a0, a0 + towerW, -d / 2, d / 2, 0, top, {
      front: plank,
      back: plank,
      left: plank,
      right: plank,
    });
    if (step >= 4) {
      g.pyramid(a0 - 0.2, a0 + towerW + 0.2, -d / 2 - 0.2, d / 2 + 0.2, top, top + 1.8, kit.roof);
    }
  }
  if (step >= 5) {
    // A beam across the top and the gates, open by day.
    g.solid(-w / 2 + towerW, w / 2 - towerW, -0.3, 0.3, 3.6, 4.1, kit.timber);
    const gate = face(M.PLANK, kit.owner, boards(M.DOOR, kit.seed + 1, 0.28));
    if (b.shut) {
      g.wall("front", -w / 2 + towerW, w / 2 - towerW, -0.1, 0.1, 0, 3.6, gate);
    } else {
      g.solid(-w / 2 + towerW, -w / 2 + towerW + 0.12, -0.1 - 1.7, -0.1, 0, 3.4, gate);
      g.solid(w / 2 - towerW - 0.12, w / 2 - towerW, -0.1 - 1.7, -0.1, 0, 3.4, gate);
    }
  }
};

/** Half the width of a gatehouse's way through, and the height its arch springs from. */
const GATE_HALF = 1.6;
const GATE_SPRING = 2.6;

const drawGatehouse: Draw = (g, b, kit, step, world) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const top = 8.2;
  const stone = face(M.STONE, kit.owner, stoneCourses(M.STONE, kit.seed));
  const walk = face(M.FLAGSTONE, kit.owner, plain(M.STONE, kit.seed, 26));
  if (step === 0) {
    stakes(g, kit, -w / 2, w / 2, -d / 2, d / 2);
    return;
  }
  const rise = step >= 5 ? 1 : [0, 0.15, 0.45, 0.75, 0.95][step];
  const half = GATE_HALF;
  const crown = GATE_SPRING + half;
  // Two piers either side of the way through, their inner walls in the passage's shade.
  const inner = passageWalls(kit, d);
  g.box(-w / 2, -half, -d / 2, d / 2, -0.5, top * rise, {
    front: stone,
    back: stone,
    left: stone,
    right: step >= 4 ? inner : stone,
    top: walk,
  });
  g.box(half, w / 2, -d / 2, d / 2, -0.5, top * rise, {
    front: stone,
    back: stone,
    left: step >= 4 ? inner : stone,
    right: stone,
    top: walk,
  });
  if (step < 4) {
    return;
  }
  // The vault over the passage, the round arch at either end, and the paved floor through it.
  g.box(-half, half, -d / 2, d / 2, crown, top, { top: walk });
  const arch = face(M.STONE, kit.owner, archStones(kit.seed, w));
  g.poly(
    [-half, -d / 2, crown, half, -d / 2, crown, half, -d / 2, top, -half, -d / 2, top],
    arch,
    [0, -d / 2, GATE_SPRING],
    [1, 0, 0],
    [0, 0, 1],
  );
  g.poly(
    [half, d / 2, crown, -half, d / 2, crown, -half, d / 2, top, half, d / 2, top],
    arch,
    [0, d / 2, GATE_SPRING],
    [-1, 0, 0],
    [0, 0, 1],
  );
  for (let k = 0; k < ARCH_STRIPS; k++) {
    const a0 = -half + (2 * half * k) / ARCH_STRIPS;
    const a1 = -half + (2 * half * (k + 1)) / ARCH_STRIPS;
    const h0 = GATE_SPRING + Math.sqrt(Math.max(0, half * half - a0 * a0));
    const h1 = GATE_SPRING + Math.sqrt(Math.max(0, half * half - a1 * a1));
    g.poly(
      [a0, -d / 2, h0, a1, -d / 2, h1, a1, -d / 2, crown, a0, -d / 2, crown],
      arch,
      [0, -d / 2, GATE_SPRING],
      [1, 0, 0],
      [0, 0, 1],
    );
    g.poly(
      [a1, d / 2, h1, a0, d / 2, h0, a0, d / 2, crown, a1, d / 2, crown],
      arch,
      [0, d / 2, GATE_SPRING],
      [-1, 0, 0],
      [0, 0, 1],
    );
  }
  passageFloor(g, b, kit, world, half, d);
  if (step < 5) {
    return;
  }
  const n = Math.round(w / 1.2);
  for (let k = 0; k < n; k++) {
    const a = -w / 2 + ((k + 0.5) * w) / n;
    g.solid(a - 0.33, a + 0.33, -d / 2, -d / 2 + 0.5, top, top + 0.8, stone);
  }
  if (b.shut) {
    g.wall(
      "front",
      -half,
      half,
      -d / 2 + 0.5,
      d / 2,
      0,
      crown,
      face(M.PLANK, kit.owner, boards(M.DOOR, kit.seed + 1, 0.28)),
    );
  }
};

/** Upright strips each end of a gate's arch is drawn in. */
const ARCH_STRIPS = 8;

/** How much of the daylight reaches `edge` meters into a passage from its nearer end. */
function passageLight(edge: number): number {
  return 1 - 0.3 * smoothstep(0.3, 2.6, edge);
}

/**
 * The walls of a gate's passage `depth` long: stone courses, dimmer deeper
 * in and up toward the vault. u runs along the passage from one end.
 */
function passageWalls(kit: Kit, depth: number): Face {
  const courses = stoneCourses(M.STONE, kit.seed);
  return face(M.STONE, kit.owner, (u, v, x, y, z) => {
    const p = courses(u, v, x, y, z);
    const dim = passageLight(Math.min(u, depth - u)) * (1 - 0.25 * smoothstep(1.6, 4.2, v));
    return packed(p >>> 8, (p & 255) * dim);
  });
}

/**
 * The face of a gatehouse `width` wide over its arch: wedge-shaped voussoirs
 * round the opening, then courses of stone in line with the piers'. Painted
 * from the middle of the arch at its springing (u across, v up).
 */
function archStones(seed: number, width: number): Paint {
  const courses = stoneCourses(M.STONE, seed);
  return (u, v, x, y, z) => {
    const r = Math.hypot(u, v);
    if (r > GATE_HALF + 0.45 || v < 0) {
      return courses(u + width / 2, v + GATE_SPRING + 0.5, x, y, z);
    }
    const turn = Math.atan2(v, u) / (Math.PI / 11);
    const k = Math.floor(turn);
    if (turn - k < 0.14 || r > GATE_HALF + 0.35) {
      return packed(M.STONE, 92);
    }
    return packed(M.STONE, 132 + hash2(k, seed) * 18);
  };
}

/**
 * The paving through a gate's passage, laid on the ground in strips a meter
 * long and darker toward the middle, where least daylight reaches.
 */
function passageFloor(
  g: Builder,
  b: Building,
  kit: Kit,
  world: World,
  half: number,
  depth: number,
): void {
  const floor = face(M.COBBLE, kit.owner, (_u, v, x, y, z) =>
    packed(M.COBBLE, pavingDetail(x, y, z, false) * passageLight(Math.min(v, depth - v))),
  );
  const t = world.terrain;
  const lift = 0.03;
  const strips = Math.ceil(depth);
  for (let k = 0; k < strips; k++) {
    const b0 = -depth / 2 + (depth * k) / strips;
    const b1 = -depth / 2 + (depth * (k + 1)) / strips;
    const h00 = t.height(g.x(-half, b0), g.y(-half, b0)) - b.base + lift;
    const h10 = t.height(g.x(half, b0), g.y(half, b0)) - b.base + lift;
    const h11 = t.height(g.x(half, b1), g.y(half, b1)) - b.base + lift;
    const h01 = t.height(g.x(-half, b1), g.y(-half, b1)) - b.base + lift;
    const o = [-half, -depth / 2, 0] as const;
    g.poly([-half, b0, h00, half, b0, h10, half, b1, h11], floor, o, [1, 0, 0], [0, 1, 0]);
    g.poly([-half, b0, h00, half, b1, h11, -half, b1, h01], floor, o, [1, 0, 0], [0, 1, 0]);
  }
}

/**
 * The deck of a bridge, as the heights (m above its base) over the frame
 * points b where its slope changes: its ends, and either end of its level
 * middle (see `bridgeDeck`).
 */
function deckProfile(b: Building, world: World): { at: number[]; h: number[] } {
  const d = b.rect.depth;
  const at = [-d / 2, -d / 4, d / 4, d / 2];
  return { at, h: at.map((bb) => bridgeDeck(world.terrain, b, bb) - b.base) };
}

/** The deck's height (m above the base) at frame point bb, from its profile. */
function deckAt(p: { at: number[]; h: number[] }, bb: number): number {
  for (let k = 0; k + 1 < p.at.length; k++) {
    if (bb <= p.at[k + 1] || k + 2 === p.at.length) {
      const t = (bb - p.at[k]) / (p.at[k + 1] - p.at[k]);
      return p.h[k] + (p.h[k + 1] - p.h[k]) * Math.min(1, Math.max(0, t));
    }
  }
  return p.h[0];
}

/** The rect of a bridge runs along the road over the river: width across the road, depth along it. */
const drawBridge: Draw = (g, b, kit, step, world) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const water = world.terrain.waterLevel(b.rect.y) - b.base;
  const deck = deckProfile(b, world);
  const t = kit.timber;
  if (step === 0) {
    stakes(g, kit, -w / 2, w / 2, -d / 2, d / 2);
    return;
  }
  // Trestles of piles in the water.
  for (const bb of spaced(-d / 2 + 1.5, d / 2 - 1.5, 3)) {
    const top = deckAt(deck, bb);
    for (const a of [-w / 2 + 0.3, w / 2 - 0.3]) {
      g.solid(a - 0.14, a + 0.14, bb - 0.14, bb + 0.14, water - 1.2, top, t);
    }
    g.solid(-w / 2, w / 2, bb - 0.12, bb + 0.12, top - 0.4, top - 0.2, t);
  }
  if (step < 3) {
    return;
  }
  const deckFace = face(M.PLANK, kit.owner, (_u, v) =>
    packed(M.PLANK, v % 0.25 < 0.05 ? 90 : 130 + hash2(Math.floor(v / 0.25), 3) * 20),
  );
  // Laid from the near bank, halfway across and then the rest, down to the banks at either end.
  const shown = step >= 4 ? d / 2 : 0;
  for (let k = 0; k + 1 < deck.at.length && deck.at[k] < shown; k++) {
    const b0 = deck.at[k];
    const b1 = Math.min(shown, deck.at[k + 1]);
    const t0 = deckAt(deck, b0);
    const t1 = deckAt(deck, b1);
    g.slopedBox(-w / 2, w / 2, b0, b1, t0 - 0.2, t1 - 0.2, t0, t1, {
      front: k === 0 ? kit.planks : undefined,
      back: b1 === d / 2 ? kit.planks : undefined,
      left: t,
      right: t,
      top: deckFace,
    });
  }
  if (step < 5) {
    return;
  }
  // Railings either side.
  for (const a of [-w / 2 + 0.1, w / 2 - 0.1]) {
    for (let k = 0; k + 1 < deck.at.length; k++) {
      const b0 = deck.at[k];
      const b1 = deck.at[k + 1];
      g.line(a, b0, deck.h[k] + 1, a, b1, deck.h[k + 1] + 1, 1, t);
    }
    for (const bb of spaced(-d / 2, d / 2, 1.5)) {
      const h = deckAt(deck, bb);
      g.line(a, bb, h, a, bb, h + 1, 1, t);
    }
  }
};

const drawStonebridge: Draw = (g, b, kit, step, world) => {
  const w = b.rect.width;
  const d = b.rect.depth;
  const water = world.terrain.waterLevel(b.rect.y) - b.base;
  const deck = deckProfile(b, world);
  if (step === 0) {
    stakes(g, kit, -w / 2, w / 2, -d / 2, d / 2);
    return;
  }
  const stone = face(M.STONE, kit.owner, stoneCourses(M.STONE, kit.seed));
  if (step < 4) {
    // Piers and the arched body rising, the hollows not yet vaulted over.
    g.box(-w / 2, w / 2, -d / 2, d / 2, water - 1, deck.h[1] * (step / 5), {
      front: stone,
      back: stone,
      left: stone,
      right: stone,
      top: kit.dark,
    });
    return;
  }
  const road = face(M.COBBLE, kit.owner, (_u, _v, x, y, z) =>
    packed(M.COBBLE, pavingDetail(x, y, z, false)),
  );
  // The body, its road level over the river and sloping down to either bank; the dark hollows
  // of its arches, over the water; the parapets.
  for (let k = 0; k + 1 < deck.at.length; k++) {
    g.slopedBox(
      -w / 2,
      w / 2,
      deck.at[k],
      deck.at[k + 1],
      water - 1,
      water - 1,
      deck.h[k],
      deck.h[k + 1],
      {
        front: k === 0 ? stone : undefined,
        back: k + 2 === deck.at.length ? stone : undefined,
        left: stone,
        right: stone,
        top: road,
      },
    );
  }
  // Each arch spans from near the middle to a little past the water's edge.
  const span = d / 2 - 2.8;
  for (const side of ["left", "right"] as const) {
    for (const mid of [-(0.4 + span / 2), 0.4 + span / 2]) {
      g.opening(
        side,
        -w / 2,
        w / 2,
        -d / 2,
        d / 2,
        d / 2 + mid,
        water - 0.2,
        span,
        1.2,
        kit.dark,
        0.03,
      );
    }
  }
  if (step >= 5) {
    for (const a of [-w / 2, w / 2 - 0.4]) {
      for (let k = 0; k + 1 < deck.at.length; k++) {
        const h0 = deck.h[k];
        const h1 = deck.h[k + 1];
        g.slopedBox(a, a + 0.4, deck.at[k], deck.at[k + 1], h0, h1, h0 + 0.9, h1 + 0.9, {
          front: k === 0 ? stone : undefined,
          back: k + 2 === deck.at.length ? stone : undefined,
          left: stone,
          right: stone,
          top: stone,
        });
      }
    }
  }
};

const DRAW: Record<Building["kind"], Draw> = {
  camp: drawCamp,
  cabin: drawCabin,
  house: drawHouse,
  farmhouse: drawFarmhouse,
  townhouse: drawTownhouse,
  stonehouse: drawTownhouse,
  barn: drawBarn,
  workshop: drawWorkshop,
  well: drawWell,
  smithy: drawSmithy,
  bakery: drawBakery,
  tavern: drawTavern,
  chapel: drawChapel,
  church: drawChurch,
  townhall: drawTownhall,
  watermill: drawWatermill,
  windmill: drawWindmill,
  lumberyard: drawLumberyard,
  quarry: drawQuarry,
  watchtower: drawWatchtower,
  wizard: drawWizard,
  palisade: drawPalisade,
  wall: drawWall,
  tower: drawTower,
  woodgate: drawWoodgate,
  gatehouse: drawGatehouse,
  bridge: drawBridge,
  stonebridge: drawStonebridge,
};

/**
 * What is left after a fire or a raid: blackened stumps of the walls, the
 * odd post standing, rubble; less of it as it is cleared away, until only
 * the footings are left.
 */
function drawRuin(g: Builder, b: Building, owner: number, step: number): void {
  const w = Math.max(2, b.rect.width);
  const d = Math.max(1, b.rect.depth);
  const rng = new Rng(b.variant ^ 0x2a1);
  const stoneKind = KINDS[b.kind].flammable < 0.3;
  const wallMat = stoneKind ? M.STONE : M.CHARRED;
  const charred = face(
    wallMat,
    owner,
    stoneKind ? stoneCourses(M.STONE, b.variant) : plain(M.CHARRED, b.variant, 30),
  );
  const rubble = face(M.RUBBLE, owner, (u, v) =>
    packed(
      hash2(Math.floor(u / 0.3), Math.floor(v / 0.3)) > 0.6 ? M.CHARRED : M.RUBBLE,
      110 + hash2(Math.floor(u / 0.2), Math.floor(v / 0.2) + 5) * 40,
    ),
  );
  const plinth = face(M.STONE_ROUGH, owner, stoneCourses(M.STONE_ROUGH, b.variant, true));
  const a0 = -w / 2;
  const a1 = w / 2;
  const b0 = -d / 2;
  const b1 = d / 2;
  g.box(a0, a1, b0, b1, -0.3, 0.3, {
    front: plinth,
    back: plinth,
    left: plinth,
    right: plinth,
    top: face(M.ASH_GROUND, owner, plain(M.ASH_GROUND, b.variant, 36)),
  });
  if (step >= 8) {
    return;
  }
  // Broken walls, jagged along the top.
  const keep = step === 6 ? 1 : 0.4;
  const jag = (u: number) =>
    0.3 + (stoneKind ? 2.2 : 1.4) * keep * (0.3 + 0.7 * hash2(Math.floor(u / 0.6), b.variant));
  const broken: Paint = (u, v) =>
    v > jag(u) ? -1 : charred.paint ? charred.paint(u, v, 0, 0, 0) : packed(wallMat, 110);
  const walls = face(wallMat, owner, broken);
  g.box(a0, a1, b0, b1, 0.3, 0.3 + (stoneKind ? 2.6 : 1.8) * keep, {
    front: walls,
    back: walls,
    left: walls,
    right: walls,
  });
  // Heaps of rubble and fallen beams inside.
  const heaps = step === 6 ? 5 : 2;
  const lobes = new Float64Array(heaps * 4);
  for (let k = 0; k < heaps; k++) {
    lobes[k * 4] = g.x(rng.range(a0 + 0.8, a1 - 0.8), rng.range(b0 + 0.8, b1 - 0.8));
    lobes[k * 4 + 1] = g.y(rng.range(a0 + 0.8, a1 - 0.8), rng.range(b0 + 0.8, b1 - 0.8));
    lobes[k * 4 + 2] = g.z(0);
    lobes[k * 4 + 3] = rng.range(0.8, 1.5) * keep + 0.3;
  }
  const mx = g.x(0, 0);
  const my = g.y(0, 0);
  g.r.lobes(lobes, heaps, rubble, mx, my, g.z(0), Math.max(w, d) / 2, 0.3);
  if (!stoneKind && step === 6) {
    const beam = face(M.CHARRED, owner, plain(M.CHARRED, b.variant, 24));
    for (let k = 0; k < 3; k++) {
      const a = rng.range(a0, a1);
      const bb = rng.range(b0, b1);
      g.line(
        a,
        bb,
        0.3,
        a + rng.range(-1.5, 1.5),
        bb + rng.range(-1.5, 1.5),
        rng.range(1, 2.6),
        1,
        beam,
      );
    }
    for (const [a, bb] of [
      [a0, b0],
      [a1, b1],
    ] as const) {
      g.solid(a - 0.14, a + 0.14, bb - 0.14, bb + 0.14, 0.3, rng.range(1.8, 3), beam);
    }
  }
}

/** The top of a building's chimney in the world, where its smoke comes out; null if it has none. */
export function chimneyOf(b: Building): { x: number; y: number; z: number } | null {
  const w = b.rect.width;
  const d = b.rect.depth;
  let a: number;
  let back: number;
  let h: number;
  switch (b.kind) {
    case "cabin":
      a = w / 2 - 0.2;
      back = 0.4;
      h = 2.3 + d * 0.46 + 0.6;
      break;
    case "house":
    case "workshop":
    case "watermill":
      a = -w / 2 + w * 0.3;
      back = d * 0.2;
      h = 2.8 + w * 0.62 + 0.4;
      break;
    case "farmhouse":
      a = 0;
      back = farmChimney(w, d);
      h = 2.6 + w * 0.5 + 0.6;
      break;
    case "townhouse":
    case "stonehouse":
      a = w / 2 - 1.2;
      back = d * 0.15;
      h = 5.7 + w * 0.85 - 0.6;
      break;
    case "smithy":
      a = -w / 2 + 1.2;
      back = -d / 2 + d * 0.4 - 0.5;
      h = 2.8 + w * 0.55 + 0.8;
      break;
    case "bakery":
      a = w / 2 + 0.4;
      back = 1.2;
      h = 4.4;
      break;
    case "tavern":
      a = -w / 2 + 1.5;
      back = 0.5;
      h = 6 + Math.min(w, d) * 0.5 + 0.4;
      break;
    default:
      return null;
  }
  const buildingStep = buildStep(b);
  if (buildingStep !== 5) {
    return null;
  }
  const fx = Math.sin(b.rect.angle);
  const fy = -Math.cos(b.rect.angle);
  return { x: b.rect.x - fy * a - fx * back, y: b.rect.y + fx * a - fy * back, z: b.base + h };
}

/**
 * The height (m above its base) of a building's top over a point of its
 * footprint, frame coordinates (a across, b back): for its shadow. Roofs
 * are approximated by their slopes; anything past the footprint is NaN.
 */
export function topAt(b: Building, a: number, bb: number): number {
  const w = b.rect.width;
  const d = b.rect.depth;
  if (Math.abs(a) > w / 2 + 0.4 || Math.abs(bb) > d / 2 + 0.4) {
    return Number.NaN;
  }
  const step = buildStep(b);
  if (step >= 6) {
    return step >= 8 ? 0.3 : KINDS[b.kind].flammable < 0.3 ? 2.6 : 1.8;
  }
  if (step <= 1) {
    return step === 0 ? Number.NaN : 0.3;
  }
  const full = HEIGHT[b.kind];
  switch (b.kind) {
    case "camp":
      // Only the tent stands up: an A-frame 2.4 m across and 3 m long.
      return Math.abs(bb) < 1.5 && Math.abs(a) < 1.2 ? 1.9 * (1 - Math.abs(a) / 1.2) : Number.NaN;
    case "palisade":
      return step >= 5 ? 3.2 : 1.5;
    case "wall":
      return step >= 5 ? 6 : 5.4 * [0, 0.15, 0.45, 0.75, 0.95][step];
    case "tower":
    case "wizard": {
      const r = Math.hypot(a, bb);
      const R = Math.min(w, d) / 2;
      if (r > R) {
        return Number.NaN;
      }
      return step >= 5 ? full - (r / R) * (b.kind === "tower" ? 4.6 : 7) : full * 0.6;
    }
    case "well":
      return Math.hypot(a, bb) < 1 ? (step >= 4 ? 2.9 : 0.8) : Number.NaN;
    case "church": {
      const inTower = a < -w / 2 + 5.5;
      if (step < 5) {
        return inTower ? 17 * 0.8 : 7 * 0.8;
      }
      if (inTower) {
        return (
          17 + 8.5 * (1 - Math.max(Math.abs(a + w / 2 - 2.75), Math.abs(bb + d / 2 - 5.15)) / 2.75)
        );
      }
      return 7 + d * 0.72 * (1 - Math.abs(bb) / (d / 2 - 0.8));
    }
    default: {
      // A roof sloping down from a ridge along the longer side.
      const eave = full * 0.45;
      if (step < 4) {
        return eave;
      }
      const across = w <= d ? Math.abs(a) / (w / 2) : Math.abs(bb) / (d / 2);
      return eave + (full - eave) * Math.max(0, 1 - across);
    }
  }
}
