import { hash3, hashU32 } from "../../core/random.ts";
import type { Bridge, Crossing, Span, Station } from "../../sim/route.ts";
import type { World } from "../../sim/world.ts";
import type { Camera } from "../camera.ts";
import type { TerrainTable } from "../terrain-table.ts";

export type SceneryKind =
  | "house"
  | "apartment"
  | "shop"
  | "factory"
  | "barn"
  | "greenhouse"
  | "shrine"
  | "broadleaf"
  | "sakura"
  | "cedar"
  | "bamboo"
  | "pine"
  | "dryingRack"
  | "vending"
  | "roadPole"
  | "streetLamp"
  | "pylon"
  | "highrise"
  | "cluster"
  | "boat"
  | "island"
  | "lighthouse";

export interface Scenery {
  kind: SceneryKind;
  along: number;
  lateral: number;
  seed: number;
  /** For poles and pylons: position of the next one the wires run to. */
  next?: { along: number; lateral: number };
}

interface Band {
  min: number;
  max: number;
  cell: number;
}

const BANDS: readonly Band[] = [
  { min: 9, max: 14, cell: 11 },
  { min: 15, max: 24, cell: 12 },
  { min: 25, max: 38, cell: 14 },
  { min: 40, max: 60, cell: 16 },
  { min: 62, max: 95, cell: 20 },
  { min: 100, max: 150, cell: 26 },
  { min: 160, max: 240, cell: 34 },
  { min: 250, max: 380, cell: 45 },
  { min: 400, max: 650, cell: 60 },
  { min: 700, max: 1100, cell: 80 },
  { min: 1200, max: 2600, cell: 110 },
];

const TREES: ReadonlySet<SceneryKind> = new Set(["broadleaf", "sakura", "cedar", "bamboo", "pine"]);

const POLE_SPACING = 34;
const LAMP_SPACING = 46;
const PYLON_SPACING = 330;
/** Pylon lines are decided per block of this length. */
const PYLON_BLOCK = 6000;

interface Obstacles {
  waters: readonly Bridge[];
  stations: readonly Station[];
  crossings: readonly Crossing[];
  tunnels: readonly Span[];
}

/**
 * Chooses what stands where. Placement is a pure function of position and
 * seed, so the same stretch of line always looks the same.
 */
export function placeScenery(out: Scenery[], cam: Camera, world: World, table: TerrainTable): void {
  out.length = 0;
  const route = world.route;
  const seed = world.seed;
  const [wa, wb] = cam.alongRange(3000, 40);
  const obstacles: Obstacles = {
    waters: route.bridgesIn(wa, wb),
    stations: route.stationsIn(wa - 200, wb + 200),
    crossings: route.crossingsIn(wa, wb),
    tunnels: route.tunnelsIn(wa - 400, wb + 400),
  };
  const season = world.season;

  BANDS.forEach((band, bi) => {
    const mid = (band.min + band.max) / 2;
    const [a0, a1] = cam.alongRange(band.max, 30);
    for (let c = Math.floor(a0 / band.cell); c <= Math.ceil(a1 / band.cell); c++) {
      const h = (k: number) => hash3(c, bi * 131 + k, seed);
      const along = (c + 0.15 + h(1) * 0.7) * band.cell;
      const lateral = band.min + h(2) * (band.max - band.min);
      const kind = chooseKind(bi, mid, h, table, along, season.dryingRacks);
      if (kind && fits(kind, along, lateral, table, obstacles)) {
        out.push({ kind, along, lateral, seed: hashU32(c * 977 + bi * 7919 + seed) });
      }
    }
  });

  placeRoadside(out, cam, table, obstacles, seed);
  placePylons(out, cam, table, obstacles, seed);
  placeSea(out, cam, table, seed);
}

function chooseKind(
  band: number,
  mid: number,
  h: (k: number) => number,
  table: TerrainTable,
  along: number,
  dryingRacks: number,
): SceneryKind | null {
  const houses = table.at(table.houses, along);
  const apartments = table.at(table.apartments, along);
  const forest = table.at(table.forest, along);
  const pines = table.at(table.pines, along);
  const fields = table.at(table.fields, along);
  const r = h(3);
  const pick = h(4);

  if (band >= 9) {
    // Distant built-up areas read as clusters or as a skyline.
    const skyline = apartments * (band === 10 ? 1 : 0.4);
    if (r < skyline * 0.8) {
      return "highrise";
    }
    if (r < skyline * 0.8 + houses * 0.9 + 0.12 * fields) {
      return "cluster";
    }
    return r < 0.95 - 0.5 * houses ? (forest > 0.2 || pick < 0.5 ? "cedar" : "broadleaf") : null;
  }

  const wBuilt = houses * 1.1 + apartments;
  const wPine = pines * 1.1;
  const wForest = forest * 1.25;
  const wField = fields * 0.14 + 0.08;
  const total = wBuilt + wPine + wForest + wField;
  const occupied = Math.min(1, total);
  if (r >= occupied) {
    return null;
  }
  // Pick a category proportionally to its weight.
  let t = (r / occupied) * total;
  if (t < wBuilt) {
    if (apartments > 0.4 && pick < apartments * 0.55 && mid > 14) {
      return "apartment";
    }
    if (pick > 0.93 && mid > 20) {
      return "factory";
    }
    if (pick > 0.86 && mid < 40) {
      return "shop";
    }
    if (pick > 0.83 && mid < 16) {
      return "vending";
    }
    if (pick < 0.03 && mid > 30) {
      return "shrine";
    }
    return "house";
  }
  t -= wBuilt;
  if (t < wPine) {
    return "pine";
  }
  t -= wPine;
  if (t < wForest) {
    if (pick < 0.45) {
      return "cedar";
    }
    if (pick < 0.58 && mid < 150) {
      return "bamboo";
    }
    if (pick < 0.66 && houses > 0.05) {
      return "sakura";
    }
    return "broadleaf";
  }
  // Out in the fields.
  if (dryingRacks > 0.2 && pick < 0.45 * dryingRacks && mid < 100) {
    return "dryingRack";
  }
  if (pick < 0.12) {
    return "greenhouse";
  }
  if (pick < 0.22) {
    return "barn";
  }
  if (pick < 0.3) {
    return "sakura";
  }
  return pick < 0.55 ? "broadleaf" : null;
}

/** Physical footprint half-depth (m) used for clearance checks. */
function depthOf(kind: SceneryKind): number {
  switch (kind) {
    case "apartment":
    case "factory":
      return 8;
    case "house":
    case "shop":
    case "barn":
    case "greenhouse":
      return 5;
    case "highrise":
    case "cluster":
      return 30;
    default:
      return 2;
  }
}

function fits(
  kind: SceneryKind,
  along: number,
  lateral: number,
  table: TerrainTable,
  o: Obstacles,
): boolean {
  const depth = depthOf(kind);
  if (lateral + depth > table.at(table.shore, along) - 8) {
    return false;
  }
  const road = table.at(table.road, along);
  if (Math.abs(lateral - road) < 5 + depth) {
    return false;
  }
  for (const w of o.waters) {
    if (along > w.water.start - 12 - depth && along < w.water.end + 12 + depth) {
      return false;
    }
  }
  if (lateral < 60) {
    for (const s of o.stations) {
      if (along > s.start - 25 && along < s.end + 25) {
        return false;
      }
    }
  }
  if (lateral < 420) {
    for (const c of o.crossings) {
      if (Math.abs(along - c.at) < 6 + depth) {
        return false;
      }
    }
  }
  if (lateral < 95 && !TREES.has(kind)) {
    for (const t of o.tunnels) {
      if (along > t.start - 220 && along < t.end + 220) {
        return false;
      }
    }
  }
  return true;
}

function placeRoadside(
  out: Scenery[],
  cam: Camera,
  table: TerrainTable,
  o: Obstacles,
  seed: number,
): void {
  const [r0, r1] = cam.alongRange(400, 40);
  // One extra pole on each side so wires reach the screen edges.
  const a0 = r0 - POLE_SPACING;
  const a1 = r1 + POLE_SPACING;
  const pole = (c: number) => {
    const along = c * POLE_SPACING;
    const lateral = table.at(table.road, along) - 4.4;
    return lateral > 7 && lateral < 400 && fitsRoadside(along, lateral, table, o)
      ? { along, lateral }
      : null;
  };
  for (let c = Math.floor(a0 / POLE_SPACING); c <= Math.ceil(a1 / POLE_SPACING); c++) {
    const here = pole(c);
    if (here) {
      out.push({
        kind: "roadPole",
        along: here.along,
        lateral: here.lateral,
        seed: hashU32(c ^ seed),
        next: pole(c + 1) ?? undefined,
      });
    }
  }
  for (let c = Math.floor(a0 / LAMP_SPACING); c <= Math.ceil(a1 / LAMP_SPACING); c++) {
    const along = c * LAMP_SPACING + 11;
    const road = table.at(table.road, along);
    const lateral = road + 4.2;
    const built = table.at(table.houses, along) + table.at(table.apartments, along);
    if (built > 0.3 && lateral < 300 && fitsRoadside(along, lateral, table, o)) {
      out.push({ kind: "streetLamp", along, lateral, seed: hashU32((c * 31) ^ seed) });
    }
  }
}

function fitsRoadside(along: number, lateral: number, table: TerrainTable, o: Obstacles): boolean {
  if (lateral > table.at(table.shore, along) - 6) {
    return false;
  }
  for (const w of o.waters) {
    if (along > w.water.start - 6 && along < w.water.end + 6) {
      return false;
    }
  }
  for (const c of o.crossings) {
    if (Math.abs(along - c.at) < 5) {
      return false;
    }
  }
  return true;
}

function placePylons(
  out: Scenery[],
  cam: Camera,
  table: TerrainTable,
  o: Obstacles,
  seed: number,
): void {
  const [a0, a1] = cam.alongRange(460, PYLON_SPACING);
  for (let block = Math.floor(a0 / PYLON_BLOCK); block <= Math.floor(a1 / PYLON_BLOCK); block++) {
    const center = (block + 0.5) * PYLON_BLOCK;
    const rural = table.at(table.fields, center) + table.at(table.forest, center);
    if (hash3(block, 5, seed) > 0.55 * Math.min(1, rural)) {
      continue;
    }
    const lateral = 170 + hash3(block, 6, seed) * 270;
    const lo = Math.max(a0, block * PYLON_BLOCK);
    const hi = Math.min(a1, (block + 1) * PYLON_BLOCK);
    const stands = (along: number) =>
      lateral < table.at(table.shore, along) - 20 &&
      !o.waters.some((w) => along > w.water.start && along < w.water.end);
    for (let c = Math.ceil(lo / PYLON_SPACING); c * PYLON_SPACING < hi; c++) {
      const along = c * PYLON_SPACING;
      if (stands(along)) {
        const next = (c + 1) * PYLON_SPACING;
        out.push({
          kind: "pylon",
          along,
          lateral,
          seed: hashU32(block * 17 + seed),
          next:
            next < (block + 1) * PYLON_BLOCK && stands(next) ? { along: next, lateral } : undefined,
        });
      }
    }
  }
}

function placeSea(out: Scenery[], cam: Camera, table: TerrainTable, seed: number): void {
  const [b0, b1] = cam.alongRange(6000, 20);
  for (let c = Math.floor(b0 / 420); c <= Math.ceil(b1 / 420); c++) {
    const along = (c + hash3(c, 41, seed)) * 420;
    const lateral = 700 + hash3(c, 42, seed) * 5000;
    const shore = table.at(table.shore, along);
    if (shore < 1e8 && lateral > shore + 150 && hash3(c, 43, seed) < 0.35) {
      out.push({ kind: "boat", along, lateral, seed: hashU32(c * 13 + seed) });
    }
  }
  const [i0, i1] = cam.alongRange(14000, 60);
  for (let c = Math.floor(i0 / 7000); c <= Math.ceil(i1 / 7000); c++) {
    const along = (c + hash3(c, 51, seed)) * 7000;
    const lateral = 9000 + hash3(c, 52, seed) * 6000;
    const shore = table.at(table.shore, along);
    if (shore < 1e8 && lateral > shore + 3000 && hash3(c, 53, seed) < 0.4) {
      out.push({ kind: "island", along, lateral, seed: hashU32(c * 19 + seed) });
    }
  }
  const [l0, l1] = cam.alongRange(600, 30);
  for (let c = Math.floor(l0 / 2600); c <= Math.ceil(l1 / 2600); c++) {
    const along = (c + 0.5) * 2600;
    const shore = table.at(table.shore, along);
    if (shore < 400 && hash3(c, 61, seed) < 0.6) {
      out.push({
        kind: "lighthouse",
        along,
        lateral: shore + 160 + hash3(c, 62, seed) * 120,
        seed: hashU32(c * 23 + seed),
      });
    }
  }
}
