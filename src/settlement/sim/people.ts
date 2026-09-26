import type { Job } from "./buildings.ts";
import type { Point } from "./terrain.ts";
import type { Task } from "./tasks.ts";

/** Days in an in-world year (the shared clock's). */
export const YEAR = 12;
/** Ages (years) at which a child is grown and at which a grown-up grows old. */
export const GROWN = 15;
export const OLD = 58;
/** Age (years) past which an old one may leave for a quieter place. */
export const LEAVING_AGE = 66;

/** What someone carries in their arms or on their shoulder. */
export type Carry =
  | "log"
  | "logs"
  | "stone"
  | "sack"
  | "bucket"
  | "sheaf"
  | "basket"
  | "bundle"
  | "rubble"
  | "plank"
  | "torch"
  | "spear"
  | "bread"
  | "staff"
  | "rod";

/** How someone stands or moves, for drawing and for sound. */
export type Pose =
  | "stand"
  | "walk"
  | "run"
  | "chop"
  | "hammer"
  | "saw"
  | "dig"
  | "hoe"
  | "reap"
  | "sow"
  | "chisel"
  | "throw"
  | "thrust"
  | "cast"
  | "sit"
  | "dance"
  | "pray"
  | "wave"
  | "fish";

export interface Person {
  id: number;
  household: number;
  /** Age in years, going on with the days. */
  age: number;
  female: boolean;
  job: Job;
  /** Seed of how they look: hair, clothes, a hat. */
  look: number;
  x: number;
  y: number;
  z: number;
  /** Way they face on the ground (radians, 0 = toward the viewer, as `Rect.angle`). */
  heading: number;
  /** The building they are inside, hidden from view, or -1. */
  inside: number;
  task: Task | null;
  /** The path being walked, and how far along it. */
  path: Point[];
  step: number;
  /** Sideways offset (m) from the middle of the way, so people pass each other. */
  lane: number;
  carry: Carry | null;
  pose: Pose;
  /** Seconds in the current pose, for animating it. */
  poseTime: number;
  /** Whether they take up arms when raiders come. */
  militia: boolean;
  /** Whether they are on their way out of the valley for good. */
  leaving: boolean;
  /** Whether they have just come, and are on their way to their new home. */
  arriving: boolean;
  /** A trader up the road for the market day, not one of the settlement. */
  trader: boolean;
}

export interface Household {
  id: number;
  /**
   * Their own home (a house, or the camp at first), kept through a fire or a
   * rebuilding: the building on its site once it stands again. -1 while they
   * have none.
   */
  home: number;
  /** Where they stay while their home is down (a neighbor's roof), or -1. */
  lodging: number;
  members: number[];
}

/** The building a household sleeps under now: where they lodge, or else their home. */
export function roofOf(h: Household): number {
  return h.lodging >= 0 ? h.lodging : h.home;
}

/** Life stage by age. */
export function isChild(p: Person): boolean {
  return p.age < GROWN;
}

export function isOld(p: Person): boolean {
  return p.age >= OLD;
}

/**
 * Walking speed (m/s) by age, and running: brisk, as a busy day of ten
 * minutes wants, though still a walk at the size people are seen at.
 */
export function walkSpeed(p: Person): number {
  return isChild(p) ? 1.8 : isOld(p) ? 1.2 : 1.75;
}

export const RUN_SPEED = 3.4;
