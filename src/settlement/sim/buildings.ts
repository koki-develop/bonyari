import type { Rect } from "./geometry.ts";

/** Every kind of thing the settlers raise. */
export type BuildingKind =
  | "camp"
  | "cabin"
  | "house"
  | "farmhouse"
  | "townhouse"
  | "stonehouse"
  | "barn"
  | "workshop"
  | "well"
  | "smithy"
  | "bakery"
  | "tavern"
  | "chapel"
  | "church"
  | "townhall"
  | "watermill"
  | "windmill"
  | "lumberyard"
  | "quarry"
  | "watchtower"
  | "wizard"
  | "palisade"
  | "wall"
  | "tower"
  | "woodgate"
  | "gatehouse"
  | "bridge"
  | "stonebridge";

/** The work a grown-up does. */
export type Job =
  | "builder"
  | "woodcutter"
  | "farmer"
  | "hauler"
  | "quarrier"
  | "smith"
  | "baker"
  | "innkeeper"
  | "miller"
  | "priest"
  | "guard"
  | "shepherd"
  | "wizard"
  | "idle";

export interface KindSpec {
  /** Footprint (m) across the front and back from it. */
  width: number;
  depth: number;
  /** Logs and stones it takes to build. */
  wood: number;
  stone: number;
  /** Builder-seconds of work (before `TOIL`), beside the hauling. */
  labor: number;
  /** People it houses. */
  housing: number;
  /** Jobs it gives. */
  jobs: Partial<Record<Job, number>>;
  /** How readily it catches fire and burns (0 stone .. 1 thatch). */
  flammable: number;
  /** Whether people shelter in it from a raid. */
  shelter: boolean;
}

export const KINDS: Record<BuildingKind, KindSpec> = {
  camp: {
    width: 7,
    depth: 6,
    wood: 0,
    stone: 0,
    labor: 12,
    housing: 6,
    jobs: {},
    flammable: 0.3,
    shelter: true,
  },
  cabin: {
    width: 5,
    depth: 4.4,
    wood: 5,
    stone: 0,
    labor: 40,
    housing: 5,
    jobs: {},
    flammable: 0.9,
    shelter: true,
  },
  house: {
    width: 6,
    depth: 7.5,
    wood: 8,
    stone: 0,
    labor: 60,
    housing: 6,
    jobs: {},
    flammable: 0.85,
    shelter: true,
  },
  farmhouse: {
    width: 8.5,
    depth: 11,
    wood: 10,
    stone: 0,
    labor: 70,
    housing: 7,
    jobs: { farmer: 2 },
    flammable: 0.85,
    shelter: true,
  },
  townhouse: {
    width: 6.2,
    depth: 8.5,
    wood: 10,
    stone: 4,
    labor: 90,
    housing: 8,
    jobs: {},
    flammable: 0.55,
    shelter: true,
  },
  stonehouse: {
    width: 6.6,
    depth: 8.5,
    wood: 6,
    stone: 12,
    labor: 110,
    housing: 8,
    jobs: {},
    flammable: 0.2,
    shelter: true,
  },
  barn: {
    width: 8,
    depth: 11,
    wood: 8,
    stone: 0,
    labor: 55,
    housing: 0,
    jobs: { farmer: 2 },
    flammable: 1,
    shelter: false,
  },
  workshop: {
    width: 6,
    depth: 7.5,
    wood: 8,
    stone: 0,
    labor: 60,
    housing: 2,
    jobs: { builder: 2 },
    flammable: 0.8,
    shelter: true,
  },
  well: {
    width: 2.2,
    depth: 2.2,
    wood: 1,
    stone: 2,
    labor: 30,
    housing: 0,
    jobs: {},
    flammable: 0,
    shelter: false,
  },
  smithy: {
    width: 6.5,
    depth: 7.5,
    wood: 6,
    stone: 4,
    labor: 80,
    housing: 2,
    jobs: { smith: 1 },
    flammable: 0.4,
    shelter: true,
  },
  bakery: {
    width: 6,
    depth: 7.5,
    wood: 6,
    stone: 3,
    labor: 70,
    housing: 3,
    jobs: { baker: 1 },
    flammable: 0.5,
    shelter: true,
  },
  tavern: {
    width: 10,
    depth: 11.5,
    wood: 12,
    stone: 4,
    labor: 120,
    housing: 3,
    jobs: { innkeeper: 2 },
    flammable: 0.6,
    shelter: true,
  },
  chapel: {
    width: 6,
    depth: 10.5,
    wood: 10,
    stone: 0,
    labor: 90,
    housing: 1,
    jobs: { priest: 1 },
    flammable: 0.7,
    shelter: true,
  },
  church: {
    width: 23,
    depth: 11.5,
    wood: 12,
    stone: 40,
    labor: 300,
    housing: 1,
    jobs: { priest: 1 },
    flammable: 0.15,
    shelter: true,
  },
  townhall: {
    width: 11,
    depth: 12.5,
    wood: 10,
    stone: 20,
    labor: 180,
    housing: 0,
    jobs: { guard: 2 },
    flammable: 0.3,
    shelter: true,
  },
  watermill: {
    width: 7,
    depth: 8.5,
    wood: 10,
    stone: 2,
    labor: 100,
    housing: 2,
    jobs: { miller: 1 },
    flammable: 0.6,
    shelter: true,
  },
  windmill: {
    width: 5,
    depth: 5,
    wood: 10,
    stone: 0,
    labor: 90,
    housing: 0,
    jobs: { miller: 1 },
    flammable: 0.7,
    shelter: false,
  },
  lumberyard: {
    width: 14,
    depth: 11,
    wood: 6,
    stone: 0,
    labor: 50,
    housing: 0,
    jobs: { woodcutter: 2 },
    flammable: 0.8,
    shelter: false,
  },
  quarry: {
    width: 16,
    depth: 12,
    wood: 4,
    stone: 0,
    labor: 50,
    housing: 0,
    jobs: { quarrier: 3 },
    flammable: 0,
    shelter: false,
  },
  watchtower: {
    width: 3.2,
    depth: 3.2,
    wood: 6,
    stone: 0,
    labor: 50,
    housing: 0,
    jobs: { guard: 1 },
    flammable: 0.7,
    shelter: false,
  },
  wizard: {
    width: 6.4,
    depth: 6.4,
    wood: 4,
    stone: 22,
    labor: 180,
    housing: 1,
    jobs: { wizard: 1 },
    flammable: 0,
    shelter: true,
  },
  palisade: {
    width: 0,
    depth: 1,
    wood: 2,
    stone: 0,
    labor: 14,
    housing: 0,
    jobs: {},
    flammable: 0.6,
    shelter: false,
  },
  wall: {
    width: 0,
    depth: 2,
    wood: 0,
    stone: 3,
    labor: 30,
    housing: 0,
    jobs: {},
    flammable: 0,
    shelter: false,
  },
  tower: {
    width: 6,
    depth: 6,
    wood: 1,
    stone: 4,
    labor: 50,
    housing: 0,
    jobs: {},
    flammable: 0.05,
    shelter: false,
  },
  woodgate: {
    width: 8,
    depth: 3.5,
    wood: 4,
    stone: 0,
    labor: 32,
    housing: 0,
    jobs: {},
    flammable: 0.6,
    shelter: false,
  },
  gatehouse: {
    width: 11,
    depth: 7,
    wood: 3,
    stone: 9,
    labor: 90,
    housing: 0,
    jobs: { guard: 1 },
    flammable: 0.05,
    shelter: false,
  },
  bridge: {
    width: 0,
    depth: 4,
    wood: 8,
    stone: 0,
    labor: 70,
    housing: 0,
    jobs: {},
    flammable: 0.5,
    shelter: false,
  },
  stonebridge: {
    width: 0,
    depth: 4.4,
    wood: 2,
    stone: 18,
    labor: 150,
    housing: 0,
    jobs: {},
    flammable: 0,
    shelter: false,
  },
};

/** Where a building stands: on a lot of the plan, on a piece of the wall ring, or over the ford. */
export type Site =
  | { type: "lot"; lot: number }
  | { type: "square" }
  | { type: "wall"; index: number }
  | { type: "tower"; index: number }
  | { type: "gate"; gate: number }
  | { type: "ford" };

/**
 * A building's life: its ground being cleared of trees, going up, standing,
 * or a ruin after fire or a raid; `demolish` is an old building being taken
 * down to make way for a better one.
 */
export type Phase = "clearing" | "building" | "standing" | "demolish" | "ruin";

/** What walls are made of. */
export type WallStuff = "log" | "plank" | "plaster" | "plasterWarm" | "plasterPink" | "stone";
/** What roofs are covered with. */
export type RoofStuff = "bark" | "thatch" | "shingle" | "tile" | "slate";
/** The color shutters and doors are painted. */
export type Trim = "green" | "brown" | "blue" | "red";

/** How a building looks, chosen when it is started. */
export interface Style {
  wall: WallStuff;
  roof: RoofStuff;
  trim: Trim;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  site: Site;
  /** Where it stands on the ground: its footprint. */
  rect: Rect;
  /** Height (m) of the ground it stands on. */
  base: number;
  variant: number;
  style: Style;
  phase: Phase;
  /** How far built (0..1), or how far taken down while demolished. */
  progress: number;
  /** Materials brought to the site so far, and what it still needs. */
  wood: number;
  stone: number;
  /** Trees still standing, or stumps, where it is to go. */
  clearing: number[];
  /** Damage from fire or raiders (0 whole .. 1 fallen). */
  damage: number;
  /** How blackened by fire, and how hard it burns now. */
  char: number;
  fire: number;
  /** How far a ruin has been cleared away (0..1). */
  cleared: number;
  /** What replaces it, once it has been taken down. */
  next: BuildingKind | null;
  /** Whether it is going up in place of an older building taken down for it. */
  replacing: boolean;
  /** Whether it is going up again after a raid or a fire brought it down. */
  rebuilding: boolean;
  /** How brightly its windows are lit (0..1). */
  lamps: number;
  /** Whether its doors and shutters are shut against a raid. */
  shut: boolean;
}

/**
 * How built a building looks, in steps: the stakes of its outline, the
 * footings, the frame, the walls, the roof going on, and finished. Its
 * drawing changes only when this changes.
 */
export function buildStep(b: Building): number {
  if (b.phase === "ruin") {
    return 6 + Math.min(2, Math.floor(b.cleared * 3));
  }
  if (b.phase === "standing") {
    return 5;
  }
  if (b.phase === "clearing") {
    return 0;
  }
  const p = b.progress;
  return p < 0.08 ? 0 : p < 0.25 ? 1 : p < 0.5 ? 2 : p < 0.8 ? 3 : p < 1 ? 4 : 5;
}

/** Whether a building can be in or stayed in: standing (or the camp, even as it is pitched) and not afire. */
export function roofHolds(b: Building | undefined): b is Building {
  return b !== undefined && (b.phase === "standing" || b.kind === "camp") && b.fire <= 0.05;
}
