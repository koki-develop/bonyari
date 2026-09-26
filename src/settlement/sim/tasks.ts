import type { Carry, Person, Pose } from "./people.ts";
import { RUN_SPEED, walkSpeed } from "./people.ts";
import type { Point } from "./terrain.ts";
import type { SoundKind, World } from "./world.ts";

/**
 * Work that changes the world as it goes on (building goes up a little
 * every second) or when it is done (the tree falls).
 */
export type Act =
  | { kind: "fell"; tree: number }
  | { kind: "grub"; tree: number }
  | { kind: "build"; building: number }
  | { kind: "demolish"; building: number }
  | { kind: "clear"; building: number }
  | { kind: "plow"; field: number }
  | { kind: "reap"; field: number }
  | { kind: "quarry" }
  | { kind: "douse"; building: number }
  | { kind: "pave"; street: number }
  | { kind: "fence"; pasture: number }
  | { kind: "repair"; building: number }
  | { kind: "strike"; monster: number }
  | { kind: "shoot"; x: number; y: number; z: number; bolt: boolean }
  | { kind: "grade" }
  | { kind: "craft" };

/** Something done at once. */
export type Effect =
  | { kind: "take"; stuff: "wood" | "stone"; count: number }
  | { kind: "takePile"; pile: number; count: number }
  | { kind: "takeNear"; x: number; y: number }
  | { kind: "deliver"; building: number; stuff: "wood" | "stone" }
  /** A cartload taken from the stock onto the carter's cart, or unloaded at a site. */
  | { kind: "loadCart"; stuff: "wood" | "stone"; count: number; pile?: number }
  | { kind: "unloadCart"; building: number; count?: number }
  | { kind: "stock"; stuff: "wood" | "stone" | "food"; amount: number }
  /** A trader's sacks set out on the stall or loaded back: how many are left on the cart. */
  | { kind: "sacks"; count: number }
  | { kind: "sheaves"; field: number }
  | { kind: "arrived" }
  | { kind: "gone" }
  | { kind: "bell"; pattern: "hours" | "alarm" | "clear" | "service" }
  | { kind: "sound"; sound: SoundKind };

export type Step =
  /**
   * Walk (or run, or dance) to (x, y); `enter` goes into that building on
   * arrival. `direct` goes straight there without making for the streets,
   * where nothing is in the way.
   */
  | {
      t: "go";
      x: number;
      y: number;
      run?: boolean;
      dance?: boolean;
      enter?: number;
      direct?: boolean;
    }
  /** Come out of the building one is in. */
  | { t: "out" }
  /** Stay inside a building until the clock reads `until` (in-world days). */
  | { t: "stay"; until: number }
  /** Stay put while the alarm lasts, and `linger` seconds after the all-clear before going on. */
  | { t: "hide"; linger: number }
  /** Work in a pose for some seconds facing (fx, fy), making `sound` every `every` seconds. */
  | {
      t: "work";
      pose: Pose;
      seconds: number;
      fx?: number;
      fy?: number;
      act?: Act;
      sound?: SoundKind;
      every?: number;
      /** Height (m) above the ground to work at: up a scaffold or on a tower. */
      lift?: number;
    }
  | { t: "carry"; item: Carry | null }
  | { t: "do"; effect: Effect }
  | { t: "wait"; seconds: number; pose?: Pose };

/** What someone is doing: a named run of steps. */
export interface Task {
  /** What it is, for tallies and for choosing what comes next. */
  kind: string;
  /** A pile of logs or stones it will take from, and how many, so no two go for the same last log. */
  claim?: number;
  claimCount?: number;
  steps: Step[];
  /** Which step is under way, and seconds spent on it. */
  i: number;
  elapsed: number;
  /** Seconds till the next sound of the work under way. */
  beat: number;
}

/** Speed (m/s) of dancers going round in a ring. */
const DANCE_SPEED = 1.1;
/** Speed (m/s) of climbing up or down a ladder. */
const CLIMB_SPEED = 1.6;

export function task(kind: string, steps: Step[]): Task {
  return { kind, steps, i: 0, elapsed: 0, beat: 0 };
}

/** Angle (as `Rect.angle`) of facing along (dx, dy). */
export function headingOf(dx: number, dy: number): number {
  return Math.atan2(dx, -dy);
}

/**
 * Carries out a person's task for `dt` seconds. Returns false when the task
 * is over (done, or given up because the world changed under it).
 */
export function runTask(world: World, p: Person, dt: number): boolean {
  const t = p.task;
  if (!t) {
    return false;
  }
  let left = dt;
  // Steps done at once take no time; a few may follow each other in one tick.
  for (let guard = 0; t.i < t.steps.length && guard < 32; guard++) {
    const used = runStep(world, p, t, t.steps[t.i], left);
    if (used < 0) {
      return false;
    }
    left -= used;
    if (left <= 1e-9) {
      break;
    }
  }
  return t.i < t.steps.length;
}

/** Moves on to the next step. */
function next(t: Task): void {
  t.i++;
  t.elapsed = 0;
  t.beat = 0;
}

/**
 * Runs one step for up to `dt` seconds; returns the seconds it used (all of
 * them if it is still going on), or -1 to give up the task.
 */
function runStep(world: World, p: Person, t: Task, step: Step, dt: number): number {
  switch (step.t) {
    case "go":
      return walk(world, p, t, step, dt);
    case "out":
      if (p.inside >= 0) {
        world.leaveBuilding(p);
      }
      next(t);
      return 0;
    case "stay":
      p.pose = "stand";
      if (world.env.clock.days >= step.until) {
        next(t);
        return 0;
      }
      return dt;
    case "hide":
      p.pose = "stand";
      if (world.raids.alarm) {
        t.elapsed = 0;
        return dt;
      }
      t.elapsed += dt;
      if (t.elapsed >= step.linger) {
        next(t);
        return 0;
      }
      return dt;
    case "carry":
      p.carry = step.item;
      next(t);
      return 0;
    case "do":
      if (!world.apply(p, step.effect)) {
        return -1;
      }
      next(t);
      return 0;
    case "wait": {
      p.pose = step.pose ?? "stand";
      const need = step.seconds - t.elapsed;
      if (need <= dt) {
        next(t);
        return need;
      }
      t.elapsed += dt;
      p.poseTime += dt;
      return dt;
    }
    case "work": {
      // Up the ladder first, to work on a scaffold or at the top of a tower.
      const up = world.groundAt(p.x, p.y) + (step.lift ?? 0);
      if (p.z < up - 0.02) {
        p.z = Math.min(up, p.z + CLIMB_SPEED * dt);
        p.pose = "stand";
        return dt;
      }
      p.z = up;
      if (p.pose !== step.pose) {
        p.pose = step.pose;
        p.poseTime = 0;
      }
      if (step.fx !== undefined && step.fy !== undefined) {
        const dx = step.fx - p.x;
        const dy = step.fy - p.y;
        if (dx * dx + dy * dy > 0.01) {
          p.heading = headingOf(dx, dy);
        }
      }
      const use = Math.min(dt, step.seconds - t.elapsed);
      if (step.act && !world.work(p, step.act, use, t.elapsed + use >= step.seconds - 1e-9)) {
        return -1;
      }
      t.elapsed += use;
      p.poseTime += use;
      if (step.sound) {
        t.beat -= use;
        if (t.beat <= 0) {
          t.beat += step.every ?? 1;
          world.sound(step.sound, p.x, p.y, p.z + 0.8);
        }
      }
      if (t.elapsed >= step.seconds - 1e-9) {
        next(t);
      }
      return use;
    }
  }
}

/** Walks the step's way; returns seconds used. */
function walk(
  world: World,
  p: Person,
  t: Task,
  step: Extract<Step, { t: "go" }>,
  dt: number,
): number {
  if (step.enter !== undefined && step.enter >= 0 && p.inside === step.enter) {
    // Already in there.
    next(t);
    return 0;
  }
  // Down the ladder from a scaffold or a tower before setting off.
  const ground = world.groundAt(p.x, p.y);
  if (p.inside < 0 && p.z > ground + 0.02) {
    p.z = Math.max(ground, p.z - CLIMB_SPEED * dt);
    p.pose = "stand";
    return dt;
  }
  if (p.inside >= 0) {
    world.leaveBuilding(p);
  }
  if (t.elapsed === 0 && p.step === 0 && p.path.length === 0) {
    // The path starts where they stand, so the sides of its legs stay put as they walk.
    // Straight on only where nothing (the river, the wall, a house) is in the way.
    const way =
      step.direct && world.nav.clear(p.x, p.y, step.x, step.y)
        ? [{ x: step.x, y: step.y }]
        : world.nav.path(p.x, p.y, step.x, step.y);
    p.path = [{ x: p.x, y: p.y }, ...way];
    p.step = 1;
  }
  t.elapsed += 1e-6;
  const base = step.run ? RUN_SPEED : step.dance ? DANCE_SPEED : walkSpeed(p);
  let left = dt;
  while (left > 0 && p.step < p.path.length) {
    const target = p.path[p.step];
    // Walk to one side of the way, so people coming the other way pass.
    const last = p.step === p.path.length - 1;
    const prev: Point = p.path[p.step - 1];
    const sx = target.x - prev.x;
    const sy = target.y - prev.y;
    const sl = Math.sqrt(sx * sx + sy * sy) || 1;
    const off = last ? 0 : p.lane;
    const tx = target.x + (sy / sl) * off;
    const ty = target.y - (sx / sl) * off;
    const dx = tx - p.x;
    const dy = ty - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const wet = world.nav.wading(p.x, p.y, tx, ty);
    const speed =
      base * (wet ? 0.45 : 1) * (p.carry && p.carry !== "torch" && p.carry !== "spear" ? 0.85 : 1);
    if (d < 1e-6) {
      p.step++;
      continue;
    }
    p.heading = headingOf(dx, dy);
    const move = speed * left;
    if (move >= d) {
      p.x = tx;
      p.y = ty;
      left -= d / speed;
      p.step++;
    } else {
      p.x += (dx / d) * move;
      p.y += (dy / d) * move;
      left = 0;
    }
  }
  p.z = world.groundAt(p.x, p.y);
  const moving = p.step < p.path.length;
  const pose = step.run ? "run" : step.dance ? "dance" : "walk";
  if (p.pose !== pose) {
    p.pose = pose;
  }
  p.poseTime += dt - left;
  if (!moving) {
    p.path = [];
    p.step = 0;
    p.pose = "stand";
    if (step.enter !== undefined && step.enter >= 0) {
      if (!world.enterBuilding(p, step.enter)) {
        return -1;
      }
    }
    next(t);
  }
  return dt - left;
}
