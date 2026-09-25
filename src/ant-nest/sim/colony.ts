import { clamp } from "../../shared/core/math.ts";
import type { Loc } from "./geometry.ts";
import type { Waypoint } from "./nest.ts";

/**
 * What an adult is: the queen, a worker, or one of the winged young that
 * leave to found colonies of their own, a new queen (gyne) or a male.
 */
export type Caste = "queen" | "worker" | "gyne" | "male";
/** What a brood item will become. */
export type BroodCaste = "worker" | "gyne" | "male";
export type Stage = "egg" | "larva" | "pupa";

/** What an ant is doing, for drawing it and for the sound of it. */
export type Pose =
  | "walk"
  | "still"
  | "dig"
  | "groom"
  | "tend"
  | "feed"
  | "antennate"
  | "lay"
  | "fly"
  | "shed";

/** What an ant carries in its jaws. */
export interface Cargo {
  kind: "soil" | "brood" | "food" | "husk" | "scrap";
  /** The brood item or the item carried, for brood and items; -1 for soil and food. */
  id: number;
  /** Food units, or cells of soil. */
  amount: number;
  /** Where the soil came from, which sets its color. */
  x: number;
  y: number;
  /** What the food was torn from. */
  from: "crumb" | "insect" | "store" | null;
}

/**
 * What an ant is set on, and how far through it it is (`step`); each kind
 * keeps what it needs as plain data.
 */
export type Task =
  /** Stays a while in a chamber. */
  | { kind: "rest"; step: number; chamber: number }
  /** Digs at the face of feature `f` and carries the soil out. */
  | { kind: "dig"; step: number; f: number; trips: number; tries: number }
  /** Packs soil into an entrance, or takes it out again. */
  | { kind: "pack"; step: number; portal: number }
  | { kind: "unpack"; step: number; portal: number }
  /** Goes out for food, following word of a find (`item`) or searching. */
  | { kind: "forage"; step: number; item: number; looks: number }
  /** Tends the aphids on a plant for their honeydew. */
  | { kind: "aphids"; step: number; stem: number }
  /** Looks after the brood: gathers it, feeds the larvae, keeps it tidy. */
  | { kind: "nurse"; step: number; brood: number; item: number; spots: number }
  /** Takes a husk or scrap out of the nest. */
  | { kind: "haul"; step: number; item: number }
  | { kind: "guard"; step: number; portal: number }
  /** Keeps the queen company. */
  | { kind: "attend"; step: number }
  /** Rests with the others through the cold. */
  | { kind: "winter"; step: number }
  /** The queen's life among her brood; while she raises the first brood alone, she nurses it too. */
  | { kind: "queen"; step: number; rounds: number; brood: number }
  /** The founding queen, landed: sheds her wings and looks for where to dig. */
  | { kind: "found"; step: number; x: number; hops: number }
  /** The founding queen shuts herself in. */
  | { kind: "seal"; step: number }
  /** A winged young one climbs a plant and flies. */
  | { kind: "fly"; step: number; stem: number };

export interface Ant {
  id: number;
  caste: Caste;
  /** Body length (mm). */
  size: number;
  /** World day it came out of its cocoon; young adults are pale. */
  born: number;
  loc: Loc;
  /** Position (mm) in the section, kept up by the world after every move. */
  x: number;
  y: number;
  /** Direction it faces (radians, 0 = right, counterclockwise). */
  heading: number;
  way: Waypoint[] | null;
  wayAt: number;
  /** Offset (mm) to settle at when the way ends, or NaN to keep to the lane. */
  goalU: number;
  /** Seconds left to stay put. */
  wait: number;
  pose: Pose;
  /** Millimeters walked, which sets the legs. */
  gait: number;
  cargo: Cargo | null;
  /** How full its crop is with liquid food (0..1); its gaster swells. */
  crop: number;
  task: Task | null;
  /** Still has its wings: the young winged adults, and the founding queen before she sheds them. */
  winged: boolean;
  /** Velocity (mm/s) while flying. */
  vx: number;
  vy: number;
  /** A small per-ant bias to its lane and its manner, -1..1. */
  quirk: number;
  /** When (s of world time) it last stopped to touch antennae with another. */
  met: number;
  /** Seconds since it turned to walk off into the grass for good; -1 while it stays. */
  leaving: number;
}

export interface Brood {
  id: number;
  stage: Stage;
  caste: BroodCaste;
  /** Through the current stage, 0..1. */
  progress: number;
  /** Food (units) a larva has eaten. */
  fed: number;
  loc: Loc;
  carried: boolean;
}

/**
 * Things lying about that are not brood: food on the ground or stored in the
 * nest, the husks of cocoons, scraps, and the wings the queen shed.
 */
export type ItemKind = "crumb" | "insect" | "store" | "husk" | "scrap" | "wing";

export interface Item {
  id: number;
  kind: ItemKind;
  loc: Loc;
  /** Food units left in it (for food), or 1. */
  amount: number;
  /** Size (mm) as it was when it came. */
  size: number;
  /** Which look it has among its kind. */
  variant: number;
  /** World day it came. */
  since: number;
  carried: boolean;
  /** Height (mm) above where it lies while it is still falling, and its fall speed (mm/s). */
  drop: number;
  fall: number;
  /** 0..1 soaked by rain. */
  soggy: number;
}

/** How the colony stands: arriving, digging in, raising the first brood alone, or grown. */
export type ColonyStage = "arrival" | "founding" | "claustral" | "colony";

export interface ColonyState {
  stage: ColonyStage;
  /** World day the queen landed. */
  foundedAt: number;
  /** Food (units) the founding queen has in her body to raise her first brood on. */
  reserve: number;
  /** Liquid food (units) the workers pass between them. */
  honey: number;
  /** 0 active .. 1 deep in winter rest. */
  dormancy: number;
  /** Whether the colony wants its entrances plugged. */
  closed: boolean;
  /** The chamber where the brood (and the queen) is kept, and the one the food is stored in; -1 if none yet. */
  broodChamber: number;
  foodChamber: number;
  /** Eggs the queen is ready to lay. */
  eggsDue: number;
  /** Food on the surface a forager found and told the others about (item ids). */
  known: number[];
  /** In-world year of the last flight of the winged young (-1 for none yet). */
  flownYear: number;
}

/** Days each stage lasts at the best temperature. */
export const STAGE_DAYS: Record<Stage, number> = { egg: 0.3, larva: 0.6, pupa: 0.45 };
/** Days a young winged adult's larva and pupa take longer. */
export const ALATE_SLOWER = 1.6;
/** Food (units) a larva must eat to pupate. */
export const LARVA_FOOD: Record<BroodCaste, number> = { worker: 0.8, gyne: 2.6, male: 1.3 };
/** Days a young worker stays pale. */
export const CALLOW_DAYS = 1.4;
/** In-world days the shortest-lived worker lives; each lives up to three times as long. */
export const WORKER_LIFE = 20;
/** Most workers the section holds. */
export const WORKER_CAP = 190;
/** Food (units) the founding queen carries in her body. */
export const QUEEN_RESERVE = 12;
/** Eggs the founding queen lays for her first brood. */
export const FIRST_BROOD = 12;

/** Body length (mm) of each caste; workers vary. */
export const SIZE: Record<Exclude<Caste, "worker">, number> = { queen: 17, gyne: 16, male: 11 };

/**
 * How lively an insect is at `celsius`: nearly still in the cold, at its
 * quickest in summer warmth, slowing again in great heat.
 */
export function vigor(celsius: number): number {
  const warm = clamp((celsius - 3) / 22, 0.03, 1);
  const hot = clamp(1 - (celsius - 36) / 12, 0.4, 1);
  return warm * hot;
}

/** How fast brood grows at `celsius` (1 at its best); nothing below 10 °C. */
export function growth(celsius: number): number {
  return clamp((celsius - 10) / 12, 0, 1.1) * clamp(1 - (celsius - 34) / 8, 0, 1);
}

/** 0..1 how far a young adult is from pale to its full color, `age` days after it came out. */
export function maturity(age: number): number {
  return clamp(age / CALLOW_DAYS, 0, 1);
}

/** Radius (mm) a brood item takes up in a heap. */
export function broodRadius(b: Brood): number {
  const alate = b.caste !== "worker";
  switch (b.stage) {
    case "egg":
      return 0.55;
    case "larva":
      return (0.6 + 1.5 * Math.min(1, b.fed / LARVA_FOOD[b.caste])) * (alate ? 1.35 : 1);
    case "pupa":
      return alate ? 3.3 : 2.3;
  }
}
