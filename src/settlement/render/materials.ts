import { hex, mix, type RGB } from "../../shared/core/color.ts";
import { clamp01 } from "../../shared/core/math.ts";
import type { TownSeason } from "../sim/season.ts";

/**
 * What each art pixel of the world is made of. The drawn world keeps a
 * material per pixel; its color is looked up afresh as the seasons turn, and
 * snow and rain settle on it by what it is.
 */
export const M = {
  EMPTY: 0,
  // The ground.
  GRASS: 1,
  MEADOW: 2,
  FOREST_FLOOR: 3,
  DIRT: 4,
  TRACK: 5,
  GRAVEL: 6,
  COBBLE: 7,
  FLAGSTONE: 8,
  MUD: 9,
  SAND: 10,
  PEBBLES: 11,
  ROCK: 12,
  RIVERBED: 13,
  WATER: 14,
  FIELD: 15,
  GARDEN: 16,
  YARD: 17,
  STUMP: 18,
  ASH_GROUND: 19,
  // What buildings are made of.
  LOG: 30,
  PLANK: 31,
  TIMBER: 32,
  PLASTER: 33,
  PLASTER_WARM: 34,
  STONE: 35,
  STONE_ROUGH: 36,
  THATCH: 37,
  SHINGLE: 38,
  TILE: 39,
  SLATE: 40,
  BARK: 41,
  DOOR: 42,
  WINDOW: 43,
  SHUTTER: 44,
  IRON: 45,
  CLOTH: 46,
  CLOTH_RED: 47,
  CLOTH_BLUE: 48,
  CHARRED: 49,
  RUBBLE: 50,
  HAY: 51,
  FENCE: 52,
  PALISADE: 53,
  COPPER: 54,
  GOLD: 55,
  MAGIC: 56,
  FORGE: 57,
  PLASTER_PINK: 58,
  SCAFFOLD: 59,
  // Growing things.
  LEAF_OAK: 70,
  LEAF_BIRCH: 71,
  LEAF_WILLOW: 72,
  NEEDLE_SPRUCE: 73,
  NEEDLE_PINE: 74,
  TRUNK: 75,
  TRUNK_BIRCH: 76,
  BRANCH: 77,
  BUSH: 78,
  REED: 79,
  VINE: 80,
} as const;

export type Material = (typeof M)[keyof typeof M];

/** How each material takes the weather. */
interface Kind {
  /** How readily snow settles on it (on level ground or a gentle roof). */
  snow: number;
  /** How much darker it goes wet. */
  wet: number;
  /** Mirror-like sheen when wet or polished, for the sun's glint. */
  shine: number;
}

const GROUND: Kind = { snow: 1, wet: 0.3, shine: 0.05 };
const ROOF: Kind = { snow: 1, wet: 0.2, shine: 0.1 };
const WALL: Kind = { snow: 0.3, wet: 0.12, shine: 0 };
const LEAF: Kind = { snow: 0.55, wet: 0.1, shine: 0 };

/** Material properties, indexed by material id. */
export const SNOW_HOLD = new Float32Array(256);
export const WET_DARKEN = new Float32Array(256);
export const SHINE = new Float32Array(256);
/** Materials that glow of themselves at night, by how much. */
export const EMISSIVE = new Uint8Array(256);

function kind(ids: readonly number[], k: Kind): void {
  for (const id of ids) {
    SNOW_HOLD[id] = k.snow;
    WET_DARKEN[id] = k.wet;
    SHINE[id] = k.shine;
  }
}
kind(
  [
    M.GRASS,
    M.MEADOW,
    M.FOREST_FLOOR,
    M.DIRT,
    M.TRACK,
    M.GRAVEL,
    M.MUD,
    M.SAND,
    M.PEBBLES,
    M.ROCK,
    M.FIELD,
    M.GARDEN,
    M.YARD,
    M.STUMP,
    M.ASH_GROUND,
  ],
  GROUND,
);
kind([M.COBBLE, M.FLAGSTONE], { snow: 1, wet: 0.35, shine: 0.25 });
/** Ground trodden every day, where snow lies as grey slush that keeps the ground's pattern. */
export const TRODDEN = new Uint8Array(256);
for (const id of [M.DIRT, M.TRACK, M.GRAVEL, M.COBBLE, M.FLAGSTONE]) {
  TRODDEN[id] = 1;
  SNOW_HOLD[id] = 0.6;
}
kind([M.THATCH, M.SHINGLE, M.BARK, M.HAY], ROOF);
kind([M.TILE, M.SLATE, M.COPPER], { snow: 1, wet: 0.22, shine: 0.3 });
kind(
  [
    M.LOG,
    M.PLANK,
    M.TIMBER,
    M.PLASTER,
    M.PLASTER_WARM,
    M.PLASTER_PINK,
    M.STONE,
    M.STONE_ROUGH,
    M.DOOR,
    M.SHUTTER,
    M.CLOTH,
    M.CLOTH_RED,
    M.CLOTH_BLUE,
    M.CHARRED,
    M.RUBBLE,
    M.FENCE,
    M.PALISADE,
    M.SCAFFOLD,
    M.TRUNK,
    M.TRUNK_BIRCH,
    M.BRANCH,
  ],
  WALL,
);
kind([M.WINDOW, M.IRON, M.GOLD], { snow: 0, wet: 0.05, shine: 0.6 });
kind([M.LEAF_OAK, M.LEAF_BIRCH, M.LEAF_WILLOW, M.BUSH, M.REED, M.VINE], LEAF);
kind([M.NEEDLE_SPRUCE, M.NEEDLE_PINE], { snow: 0.8, wet: 0.08, shine: 0 });
SNOW_HOLD[M.WATER] = 0;
SNOW_HOLD[M.FORGE] = 0;
SNOW_HOLD[M.MAGIC] = 0;
EMISSIVE[M.FORGE] = 1;
EMISSIVE[M.MAGIC] = 1;

/** Colors that do not change with the year. */
const FIXED: readonly (readonly [number, RGB])[] = [
  [M.DIRT, hex("#8a6c4c")],
  [M.TRACK, hex("#9c8462")],
  [M.GRAVEL, hex("#a09682")],
  [M.COBBLE, hex("#8e8a80")],
  [M.FLAGSTONE, hex("#aaa393")],
  [M.MUD, hex("#6a5238")],
  [M.SAND, hex("#c4b088")],
  [M.PEBBLES, hex("#9a948a")],
  [M.ROCK, hex("#766c5d")],
  [M.RIVERBED, hex("#5c6450")],
  [M.WATER, hex("#3a5a6e")],
  [M.YARD, hex("#937657")],
  [M.STUMP, hex("#8a6a48")],
  [M.ASH_GROUND, hex("#4e4844")],
  [M.LOG, hex("#7e5838")],
  [M.PLANK, hex("#94714a")],
  [M.TIMBER, hex("#4f3726")],
  [M.PLASTER, hex("#e8dfca")],
  [M.PLASTER_WARM, hex("#e3cb9c")],
  [M.PLASTER_PINK, hex("#dcb8a4")],
  [M.STONE, hex("#aca698")],
  [M.STONE_ROUGH, hex("#8f887b")],
  [M.THATCH, hex("#b39c62")],
  [M.SHINGLE, hex("#8c7a66")],
  [M.TILE, hex("#aa573a")],
  [M.SLATE, hex("#5b6169")],
  [M.BARK, hex("#76624e")],
  [M.DOOR, hex("#5c3d27")],
  [M.WINDOW, hex("#2c2c33")],
  [M.SHUTTER, hex("#4f6d58")],
  [M.IRON, hex("#3f3f46")],
  [M.CLOTH, hex("#dccfb2")],
  [M.CLOTH_RED, hex("#a8433a")],
  [M.CLOTH_BLUE, hex("#3d5b8c")],
  [M.CHARRED, hex("#2b2521")],
  [M.RUBBLE, hex("#7f776b")],
  [M.HAY, hex("#d6b75e")],
  [M.FENCE, hex("#7c6549")],
  [M.PALISADE, hex("#6f5a42")],
  [M.COPPER, hex("#5f8f7c")],
  [M.GOLD, hex("#d9b048")],
  [M.MAGIC, hex("#9b7cff")],
  [M.FORGE, hex("#ff8a33")],
  [M.SCAFFOLD, hex("#9d8260")],
  [M.TRUNK, hex("#5e4a3b")],
  [M.TRUNK_BIRCH, hex("#d9d3c5")],
  [M.BRANCH, hex("#6b5b4b")],
  [M.REED, hex("#a8a263")],
];

/** Plowed soil and the stubble left after harvest. */
export const SOIL: RGB = hex("#7a5e42");
export const STUBBLE: RGB = hex("#c2a864");
/** Fresh snow in shade-free daylight, and trodden slush. */
export const SNOW: RGB = [238, 242, 250];
export const SLUSH: RGB = [168, 166, 164];

/**
 * The color of every material at this time of year, written into `out` as
 * r, g, b triples by material id.
 */
export function fillPalette(season: TownSeason, out: Float32Array): void {
  for (const [id, c] of FIXED) {
    out[id * 3] = c[0];
    out[id * 3 + 1] = c[1];
    out[id * 3 + 2] = c[2];
  }
  const set = (id: number, c: RGB) => {
    out[id * 3] = c[0];
    out[id * 3 + 1] = c[1];
    out[id * 3 + 2] = c[2];
  };
  // The shared grass is tuned for views across the land; seen from above it wants to be earthier.
  const grass = mix(season.grass, hex("#6c7646"), 0.3);
  set(M.GRASS, grass);
  set(M.MEADOW, mix(grass, hex("#b8b86a"), 0.12 + 0.2 * season.wildflowers));
  set(M.FOREST_FLOOR, mix(mix(grass, hex("#5a5436"), 0.42), hex("#9a7446"), season.fallen * 0.45));
  set(M.GARDEN, mix(hex("#6a5a3c"), mix(grass, hex("#4f8a3a"), 0.4), season.growth * 0.8));
  set(M.FIELD, SOIL);
  set(M.LEAF_OAK, season.leaf);
  set(M.LEAF_BIRCH, mix(season.leaf, hex("#d8d268"), 0.3 + 0.4 * season.autumn));
  set(M.LEAF_WILLOW, mix(season.leaf, hex("#a8b870"), 0.35));
  set(M.NEEDLE_SPRUCE, mix(season.evergreen, hex("#24402c"), 0.35));
  set(M.NEEDLE_PINE, season.evergreen);
  set(M.BUSH, mix(season.leaf, hex("#3a5a2c"), 0.35));
  set(M.VINE, mix(season.leaf, hex("#4a6a30"), 0.3));
  set(M.REED, mix(hex("#8a9a52"), hex("#c8b27a"), clamp01(season.autumn + (1 - season.growth))));
}
