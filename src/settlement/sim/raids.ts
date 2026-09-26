import { clamp, clamp01 } from "../../shared/core/math.ts";
import { type BuildingKind, KINDS } from "./buildings.ts";
import { ignite } from "./fire.ts";
import { STANDING } from "./forest.ts";
import { inRect, rectCorners } from "./geometry.ts";
import { yearOf } from "./farming.ts";
import type { Point } from "./terrain.ts";
import { WORLD } from "./terrain.ts";
import type { World } from "./world.ts";

/**
 * How often raiders come, in in-world days between one and the next: small
 * ones (a few wolves, goblins after the crops) about every other day, a band
 * with torches every three days or so, and a dragon or a horde once the
 * settlement is a town, about once a year. The first comes only once there
 * are houses to come to. A band or worse waits until the last one's damage
 * has been built again.
 */
export const RAIDS = {
  small: { every: 2, spread: 0.5, after: 1.4 },
  medium: { every: 3, spread: 0.7, after: 3.5 },
  large: { every: 12, spread: 2 },
} as const;

/** Every kind of raid. */
export const RAID_KINDS = ["wolves", "thieves", "band", "horde", "dragon"] as const;
export type RaidKind = (typeof RAID_KINDS)[number];
export type MonsterKind = "wolf" | "goblin" | "ogre";

export interface Monster {
  id: number;
  kind: MonsterKind;
  x: number;
  y: number;
  z: number;
  heading: number;
  state: "lurk" | "charge" | "attack" | "flee";
  /** Where it is going, and what it is after. */
  tx: number;
  ty: number;
  target: number;
  /** How much fight is left in it (0..1); it runs when this is gone. */
  spirit: number;
  torch: boolean;
  pose: "walk" | "run" | "attack" | "stand" | "hurt";
  poseTime: number;
  /** Seconds till it may strike or throw again. */
  cooldown: number;
  /** Seconds it has been in the raid, and hiding at the edge of the woods. */
  age: number;
  /** Where it came from and will run back to, and seconds it has been running. */
  home: Point;
  fled: number;
  /** The way it is following, how far along, and seconds till it looks for the way again. */
  path: Point[];
  step: number;
  repath: number;
}

export interface Dragon {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Speed (m/s) over the ground, rate of turn (rad/s, heading growing), and climb (m/s). */
  speed: number;
  turn: number;
  climb: number;
  /** How far (radians) it leans into its turn, the wing on the inside of it down. */
  bank: number;
  phase: "come" | "circle" | "turn" | "pass" | "leave";
  /** Seconds in the phase and in the raid, and passes made. */
  t: number;
  age: number;
  passes: number;
  /** The line of the pass being made: from, to; while it turns for one, (bx, by) is the place it will cross. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Which way round it wheels: 1 with its heading growing, -1 the other way. */
  wheel: number;
  breathing: boolean;
  spirit: number;
  /** Wingbeat phase. */
  flap: number;
  /** Fire on its way down: where it comes down, when (seconds of `age`), and for how long it burns there. */
  burns: { x: number; y: number; at: number; dose: number }[];
  /** Height (m) it must fly over, cell by cell (`SKY_CELL`): the ground, the treetops, the roofs and spires. */
  sky: Float32Array;
}

export interface Missile {
  id: number;
  kind: "arrow" | "bolt" | "torch" | "rock";
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  /** Building it was thrown at (torches), or -1. */
  at: number;
}

export interface Raid {
  kind: RaidKind;
  /** In-world day it began. */
  began: number;
  /** Where the raiders come out of the woods. */
  from: Point;
  /** Where they are after: the middle of it. */
  toward: Point;
  /** Whether the settlement has seen them yet, and when the alarm was rung (real seconds). */
  seen: boolean;
  /** Real seconds since everything left, before the all-clear. */
  quiet: number;
}

/** Real seconds after the last raider has gone before the bell rings the all-clear. */
const ALL_CLEAR = 8;
/** Distance (m) at which someone out of doors sees raiders coming. */
const SIGHT = 42;
/** Seconds wolves and goblins wait at the edge of the woods before they come on. */
const LURK = 7;
/** How far (m, nearest and farthest) from what they make for raiders come out of the woods. */
const RAID_FROM = [34, 55] as const;
/** Seconds after which raiders give up and go, beaten or not. */
const GIVE_UP = 100;
/** Seconds a raider runs before it is gone from sight. */
export const FLEE_TIME = 30;

/**
 * Brings the raids: decides when the next comes and what, sets the raiders
 * loose, rings the alarm when they are seen and the all-clear when they
 * have gone. The raiders themselves live in `World.monsters` and
 * `World.dragon`.
 */
export class RaidDirector {
  /** In-world days the next raid of each size is due. */
  nextSmall = Infinity;
  nextMedium = Infinity;
  nextLarge = Infinity;
  /** The raid under way. */
  active: Raid | null = null;
  /** Counts of raids so far, which also decide what comes next. */
  count = 0;
  /** Who went out against the raid under way (by person id); everyone else shelters. */
  readonly defenders = new Set<number>();
  larges = 0;

  /** Whether people should be under a roof. */
  get alarm(): boolean {
    return this.active !== null && this.active.seen;
  }

  /** Sets the first raids due, some days after the settlers came. */
  begin(world: World): void {
    const r = world.rng;
    this.nextSmall = world.founded + RAIDS.small.after + r.range(0, RAIDS.small.spread);
    this.nextMedium = world.founded + RAIDS.medium.after + r.range(0, RAIDS.medium.spread);
  }

  update(world: World, dt: number, _days: number): void {
    const now = world.env.clock.days;
    if (this.active) {
      this.run(world, dt);
      return;
    }
    const houses = world.town.buildings.filter(
      (b) => b.phase === "standing" && KINDS[b.kind].housing > 0 && b.kind !== "camp",
    ).length;
    // What the last raid brought down must stand again before a worse one comes.
    const ruins = world.town.buildings.some((b) => b.phase === "ruin" || b.rebuilding);
    const town = world.council.era >= 2;
    if (town && this.nextLarge === Infinity) {
      this.nextLarge = now + RAIDS.large.every * 0.5 + world.rng.range(0, RAIDS.large.spread);
    }
    if (now >= this.nextLarge && !ruins) {
      this.start(world, this.larges % 2 === 0 ? "dragon" : "horde");
      this.larges++;
      this.nextLarge =
        now + RAIDS.large.every + world.rng.range(-RAIDS.large.spread, RAIDS.large.spread);
      this.nextMedium = Math.max(this.nextMedium, now + 1);
      return;
    }
    if (now >= this.nextMedium && houses >= 5 && !ruins) {
      this.start(world, "band");
      this.nextMedium =
        now + RAIDS.medium.every + world.rng.range(-RAIDS.medium.spread, RAIDS.medium.spread);
      this.nextSmall = Math.max(this.nextSmall, now + 0.7);
      return;
    }
    if (now >= this.nextSmall && houses >= 2) {
      const night = world.env.darkness > 0.5;
      const fields = world.town.fields.some(
        (f) => f.cleared && f.sownYear === yearOf(world) && f.reapedYear < yearOf(world),
      );
      const flock = world.animals.some((a) => a.kind === "sheep");
      this.start(world, (night || !fields) && flock ? "wolves" : fields ? "thieves" : "wolves");
      this.nextSmall =
        now + RAIDS.small.every + world.rng.range(-RAIDS.small.spread, RAIDS.small.spread);
    }
  }

  /** Sets a raid of `kind` loose (the scheduler's choice, or asked for when looking over the work). */
  start(world: World, kind: RaidKind): void {
    // One raid at a time: any under way gives way to this one.
    this.defenders.clear();
    world.monsters.length = 0;
    world.missiles.length = 0;
    world.dragon = null;
    const toward = this.aim(world, kind);
    const from = kind === "dragon" ? lairDirection(world) : this.edgeOfWoods(world, toward);
    this.active = { kind, began: world.env.clock.days, from, toward, seen: false, quiet: 0 };
    // Bands come for one house: the one they aimed at.
    const aimed = world.town.buildings.find(
      (b) => Math.hypot(b.rect.x - toward.x, b.rect.y - toward.y) < 0.5 && b.phase === "standing",
    );
    this.count++;
    const r = world.rng;
    const spawn = (mk: MonsterKind, torch: boolean) => {
      const a = r.range(0, Math.PI * 2);
      const d = r.range(0, 4);
      const x = from.x + Math.cos(a) * d;
      const y = from.y + Math.sin(a) * d;
      world.monsters.push({
        id: world.nextId++,
        kind: mk,
        x,
        y,
        z: world.groundAt(x, y),
        heading: 0,
        state: "lurk",
        tx: toward.x,
        ty: toward.y,
        target: aimed ? aimed.id : -1,
        spirit: mk === "ogre" ? 1 : mk === "wolf" ? 0.6 : 0.7,
        torch,
        pose: "stand",
        poseTime: r.range(0, 1),
        cooldown: r.range(0.5, 2),
        age: r.range(-2, 0),
        home: { x: from.x, y: from.y },
        fled: 0,
        path: [],
        step: 0,
        repath: 0,
      });
    };
    switch (kind) {
      case "wolves":
        for (let k = r.int(5, 7); k > 0; k--) {
          spawn("wolf", false);
        }
        world.sound("howl", from.x, from.y, world.groundAt(from.x, from.y) + 1);
        break;
      case "thieves":
        for (let k = r.int(5, 7); k > 0; k--) {
          spawn("goblin", false);
        }
        world.sound("drum", from.x, from.y, world.groundAt(from.x, from.y) + 1);
        break;
      case "band":
        // A few torches among them: they come to burn one house.
        for (let k = r.int(10, 13); k > 0; k--) {
          spawn("goblin", k % 3 === 0);
        }
        if (world.council.era >= 1) {
          spawn("ogre", false);
        }
        if (world.council.era >= 2) {
          spawn("ogre", false);
        }
        break;
      case "horde":
        for (let k = r.int(18, 24); k > 0; k--) {
          spawn("goblin", k % 2 === 0);
        }
        spawn("ogre", false);
        spawn("ogre", false);
        spawn("ogre", false);
        break;
      case "dragon": {
        const d = newDragon(world, from, toward);
        world.dragon = d;
        world.sound("roar", d.x, d.y, d.z);
        break;
      }
    }
  }

  /** What a raid of `kind` goes for: the flock, the crops, the nearest houses, or the heart of the town. */
  private aim(world: World, kind: RaidKind): Point {
    const plan = world.plan;
    const r = world.rng;
    if (kind === "wolves") {
      const sheep = world.animals.filter((a) => a.kind === "sheep" || a.kind === "chicken");
      if (sheep.length > 0) {
        const s = watched(world, sheep);
        return { x: s.x, y: s.y };
      }
    }
    if (kind === "thieves" || kind === "wolves") {
      const year = yearOf(world);
      const fields = plan.fields.filter(
        (f) => world.town.fields[f.id].cleared && world.town.fields[f.id].sownYear === year,
      );
      if (fields.length > 0) {
        return watched(
          world,
          fields.map((f) => ({ x: f.rect.x, y: f.rect.y })),
        );
      }
    }
    if (kind === "dragon") {
      const standing = world.town.buildings.filter(
        (b) => b.phase === "standing" && KINDS[b.kind].housing > 0,
      );
      return standing.length > 0
        ? watched(
            world,
            standing.map((b) => ({ x: b.rect.x, y: b.rect.y })),
          )
        : { x: plan.center.x, y: plan.center.y };
    }
    // Bands go for the houses furthest out, nearest the woods; once the town is walled, those left outside it.
    const walled = world.town.buildings.some(
      (b) => (b.kind === "palisade" || b.kind === "wall") && b.phase === "standing",
    );
    const outer = world.town.buildings.filter(
      (b) =>
        b.phase === "standing" &&
        b.kind !== "camp" &&
        KINDS[b.kind].flammable > 0.3 &&
        b.site.type === "lot" &&
        (!walled || plan.lots[b.site.lot].zone === "outer"),
    );
    if (outer.length === 0) {
      // Nothing left outside the wall to burn: they come at the wall and its gates, where the town is watched.
      const ring = world.town.buildings.filter(
        (b) =>
          b.phase === "standing" &&
          (b.site.type === "wall" || b.site.type === "gate" || b.site.type === "tower"),
      );
      return ring.length > 0
        ? watched(
            world,
            ring.map((b) => ({ x: b.rect.x, y: b.rect.y })),
          )
        : { x: plan.center.x, y: plan.center.y };
    }
    if (!world.attention) {
      // Unwatched, the houses furthest out.
      outer.sort(
        (a, b) =>
          Math.hypot(b.rect.x - plan.center.x, b.rect.y - plan.center.y) -
          Math.hypot(a.rect.x - plan.center.x, a.rect.y - plan.center.y),
      );
      const pick = outer[r.int(0, Math.min(3, outer.length - 1))];
      return { x: pick.rect.x, y: pick.rect.y };
    }
    return watched(
      world,
      outer.map((b) => ({ x: b.rect.x, y: b.rect.y })),
    );
  }

  /** A place in the woods some way out from `toward`, away from the town, for raiders to come out of. */
  private edgeOfWoods(world: World, toward: Point): Point {
    const c = world.plan.center;
    const r = world.rng;
    const away = Math.atan2(toward.y - c.y, toward.x - c.x);
    const forest = world.forest;
    for (let tries = 0; tries < 60; tries++) {
      const a = away + r.range(-0.9, 0.9);
      const d = r.range(RAID_FROM[0], RAID_FROM[1]);
      const x = clamp(toward.x + Math.cos(a) * d, WORLD.x0 + 8, WORLD.x1 - 8);
      const y = clamp(toward.y + Math.sin(a) * d, WORLD.y0 + 8, WORLD.y1 - 50);
      if (world.nav.region(x, y) !== world.nav.region(toward.x, toward.y)) {
        continue;
      }
      let trees = 0;
      forest.near(x, y, 6, (t) => {
        if (forest.state[t.id] === STANDING) {
          trees++;
        }
      });
      if (trees >= 2) {
        return { x, y };
      }
    }
    const a = away;
    return {
      x: clamp(toward.x + Math.cos(a) * RAID_FROM[1], WORLD.x0 + 8, WORLD.x1 - 8),
      y: clamp(toward.y + Math.sin(a) * RAID_FROM[1], WORLD.y0 + 8, WORLD.y1 - 50),
    };
  }

  /** The raid under way: raiders move and fight, the alarm is rung when they are seen, the all-clear when they are gone. */
  private run(world: World, dt: number): void {
    const raid = this.active;
    if (!raid) {
      return;
    }
    for (const m of world.monsters.slice()) {
      moveMonster(world, m, dt);
    }
    if (world.dragon) {
      moveDragon(world, world.dragon, dt);
    }
    moveMissiles(world, dt);
    if (!raid.seen && this.spotted(world)) {
      raid.seen = true;
      world.council.alarm(world);
    }
    if (world.monsters.length === 0 && !world.dragon) {
      raid.quiet += dt;
      if (raid.quiet > ALL_CLEAR || !raid.seen) {
        this.active = null;
        if (raid.seen) {
          world.council.allClear(world);
        }
      }
    }
  }

  /** Whether anyone out of doors, or on a watchtower or the wall, has seen the raiders. */
  private spotted(world: World): boolean {
    if (world.dragon && world.dragon.phase !== "come") {
      return true;
    }
    if (world.dragon) {
      const c = world.plan.center;
      return Math.hypot(world.dragon.x - c.x, world.dragon.y - c.y) < 160;
    }
    const lookouts = world.town.buildings.filter(
      (b) =>
        b.phase === "standing" &&
        (b.kind === "watchtower" || b.kind === "tower" || b.kind === "gatehouse"),
    );
    for (const m of world.monsters) {
      if (m.state !== "lurk") {
        for (const p of world.people) {
          if (p.inside < 0 && Math.hypot(p.x - m.x, p.y - m.y) < SIGHT) {
            return true;
          }
        }
      }
      for (const b of lookouts) {
        if (Math.hypot(b.rect.x - m.x, b.rect.y - m.y) < SIGHT * 2) {
          return true;
        }
      }
      if (m.state === "attack") {
        return true;
      }
    }
    return false;
  }
}

/**
 * One of `places` for a raid to make for: of the few nearest where the town
 * is being watched, so that it is seen; any of them when no one watches.
 */
function watched(world: World, places: readonly Point[]): Point {
  const r = world.rng;
  const at = world.attention;
  if (!at) {
    return r.pick(places);
  }
  const near = places
    .map((p) => ({ p, d: Math.hypot(p.x - at.x, p.y - at.y) }))
    .sort((a, b) => a.d - b.d);
  return near[r.int(0, Math.min(2, near.length - 1))].p;
}

/** Where, far over the hills, the dragon comes from: its mountain beyond the ridge. */
function lairDirection(world: World): Point {
  return { x: world.plan.center.x + 60, y: WORLD.y1 + 40 };
}

/** How fast (m/s) a raider goes as it is now. */
function speedOf(m: Monster): number {
  return m.kind === "wolf"
    ? m.state === "charge" || m.state === "flee"
      ? 5.2
      : 1.6
    : m.kind === "ogre"
      ? 1.6
      : m.state === "flee"
        ? 3.6
        : 2.4;
}

/** A raider's velocity (m/s): along its heading while it charges or runs, still while it lurks or fights. */
export function velocityOf(m: Monster): Point {
  if (m.state !== "charge" && m.state !== "flee") {
    return { x: 0, y: 0 };
  }
  const v = speedOf(m);
  return { x: Math.sin(m.heading) * v, y: -Math.cos(m.heading) * v };
}

/** Moves a raider for dt seconds: out of the woods, at its target, and away again when beaten. */
function moveMonster(world: World, m: Monster, dt: number): void {
  m.age += dt;
  m.poseTime += dt;
  m.cooldown -= dt;
  const speed = speedOf(m);
  if (m.state !== "lurk") {
    keepApart(world, m, dt);
  }
  // Beaten raiders run; so do those who have been at it long enough (shut out by the wall, say).
  if (m.age > GIVE_UP) {
    m.spirit = Math.min(m.spirit, 0);
  }
  if (m.spirit <= 0 && m.state !== "flee") {
    m.state = "flee";
    m.target = -1;
    if (m.torch && world.rng.chance(0.5)) {
      m.torch = false;
    }
  }
  // The flock and the herd shy from goblins and ogres coming through (wolves harry them in `attack`).
  if (m.kind !== "wolf" && m.state !== "lurk" && world.rng.chance(dt * 3)) {
    for (const a of world.animals) {
      if (
        (a.kind === "sheep" || a.kind === "cow" || a.kind === "chicken") &&
        Math.abs(a.x - m.x) < SHY &&
        Math.abs(a.y - m.y) < SHY &&
        Math.hypot(a.x - m.x, a.y - m.y) < SHY
      ) {
        a.fear = Math.max(a.fear, 3);
        a.fx = m.x;
        a.fy = m.y;
      }
    }
  }
  switch (m.state) {
    case "lurk": {
      m.pose = "stand";
      if (m.age > LURK) {
        m.state = "charge";
        world.sound(m.kind === "wolf" ? "growl" : "drum", m.x, m.y, m.z + 1);
      }
      return;
    }
    case "charge": {
      // Someone with a spear at it is fought off where it stands; then on to what it came for.
      const foe = nearestDefender(world, m, BRAWL_HEED);
      if (foe) {
        const d = Math.hypot(foe.x - m.x, foe.y - m.y);
        if (d < BRAWL_REACH) {
          m.pose = "attack";
          m.heading = Math.atan2(foe.x - m.x, -(foe.y - m.y));
          return;
        }
        step(world, m, foe.x, foe.y, speed, dt);
        m.pose = speed > 2.5 ? "run" : "walk";
        return;
      }
      const t = chooseTarget(world, m);
      const d = Math.hypot(t.x - m.x, t.y - m.y);
      if (d < (m.kind === "goblin" && m.torch ? TORCH_THROW : 1.4)) {
        m.state = "attack";
        m.pose = "attack";
        m.poseTime = 0;
        return;
      }
      step(world, m, t.x, t.y, speed, dt);
      m.pose = speed > 2.5 ? "run" : "walk";
      return;
    }
    case "attack": {
      attack(world, m, dt);
      return;
    }
    case "flee": {
      const home = m.home;
      const d = Math.hypot(home.x - m.x, home.y - m.y);
      m.fled += dt;
      // Back into the woods they came from, or lost among the trees if that way is shut.
      if (d < 2 || m.fled > FLEE_TIME) {
        world.monsters.splice(world.monsters.indexOf(m), 1);
        return;
      }
      step(world, m, home.x, home.y, speed, dt);
      m.pose = "run";
      return;
    }
  }
}

/**
 * Moves a raider toward (tx, ty) along a way found as people find theirs:
 * straight over open ground, by the roads and the ford when the river or
 * the wall is in between. The way is looked for again every few seconds, as
 * what it is after moves.
 */
function step(world: World, m: Monster, tx: number, ty: number, speed: number, dt: number): void {
  m.repath -= dt;
  const end = m.path[m.path.length - 1];
  if (m.repath <= 0 || !end || Math.hypot(end.x - tx, end.y - ty) > 3) {
    m.path = world.nav.path(m.x, m.y, tx, ty);
    m.step = 0;
    m.repath = 3;
    // Each keeps to a lane of its own along the way, so a band comes on abreast and not in one file.
    const lane = LANE * ((((m.id * 7919) % 1000) / 1000) * 2 - 1);
    let fromX = m.x;
    let fromY = m.y;
    for (let k = 0; k < m.path.length - 1; k++) {
      const q = m.path[k];
      const dx = q.x - fromX;
      const dy = q.y - fromY;
      const dl = Math.sqrt(dx * dx + dy * dy) || 1;
      fromX = q.x;
      fromY = q.y;
      const x = q.x - (dy / dl) * lane;
      const y = q.y + (dx / dl) * lane;
      if (world.nav.standable(x, y)) {
        m.path[k] = { x, y };
      }
    }
  }
  let left = speed * dt;
  while (left > 0 && m.step < m.path.length) {
    const p = m.path[m.step];
    const dx = p.x - m.x;
    const dy = p.y - m.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) {
      m.heading = Math.atan2(dx, -dy);
    }
    // Slower through the water of the ford.
    const wade = world.nav.wading(m.x, m.y, p.x, p.y) ? 0.45 : 1;
    const move = left * wade;
    if (move >= d) {
      m.x = p.x;
      m.y = p.y;
      left -= d / wade;
      m.step++;
    } else {
      m.x += (dx / d) * move;
      m.y += (dy / d) * move;
      left = 0;
    }
  }
  m.z = world.groundAt(m.x, m.y);
}

/** Elbow room: a raider out of the woods edges away from any fellow too close, moving or fighting, rather than all make one heap. */
function keepApart(world: World, m: Monster, dt: number): void {
  for (const o of world.monsters) {
    const ox = m.x - o.x;
    const oy = m.y - o.y;
    if (o === m || o.state === "lurk" || Math.abs(ox) > ELBOW_ROOM || Math.abs(oy) > ELBOW_ROOM) {
      continue;
    }
    const d = Math.sqrt(ox * ox + oy * oy);
    if (d < ELBOW_ROOM) {
      // Two on one spot part on a way of their own.
      const ux = d > 1e-6 ? ox / d : Math.cos(m.id);
      const uy = d > 1e-6 ? oy / d : Math.sin(m.id);
      const push = Math.min((ELBOW_ROOM - d) * 0.5, ELBOW_SPEED * dt);
      const nx = m.x + ux * push;
      const ny = m.y + uy * push;
      if (world.nav.standable(nx, ny)) {
        m.x = nx;
        m.y = ny;
      }
    }
  }
}

/** Meters within which livestock shy from a goblin or an ogre. */
const SHY = 7;
/** Meters within which a raider turns on someone come out against it, and within which it fights them. */
const BRAWL_HEED = 5;
const BRAWL_REACH = 1.5;
/** Meters from the house it came to burn that a torch-bearer throws from. */
const TORCH_THROW = 7;
/** Meters from its fellows a raider keeps, and how fast (m/s) it edges aside for one. */
const ELBOW_ROOM = 1.5;
const ELBOW_SPEED = 1.2;
/** Meters either side of the way a raider keeps to its lane. */
const LANE = 1.6;
/** How far (m) round the place they make for each raider stands. */
const SPREAD_AROUND = 4;

/** The nearest person out against the raiders within `reach` of `m`, if any. */
function nearestDefender(world: World, m: Monster, reach: number): Point | null {
  let near: Point | null = null;
  let nearD = reach;
  for (const p of world.people) {
    if (p.inside < 0 && p.task?.kind === "defend" && (p.carry === "spear" || p.carry === "torch")) {
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < nearD) {
        nearD = d;
        near = p;
      }
    }
  }
  return near;
}

/** Where round a place a raider stands, the same for it each time: so a band spreads over a yard, not onto one spot. */
function aroundFor(m: Monster, x: number, y: number, reach: number): Point {
  const a = (((m.id * 2654435761) % 4096) / 4096) * Math.PI * 2;
  const d = reach * (0.35 + 0.65 * (((m.id * 40503) % 997) / 997));
  return { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d };
}

/** What a raider goes for now: a sheep, a field, a house. */
function chooseTarget(world: World, m: Monster): Point {
  if (m.kind === "wolf") {
    let best: Point | null = null;
    let bestD = 60;
    for (const a of world.animals) {
      if (a.kind !== "sheep" && a.kind !== "chicken") {
        continue;
      }
      const d = Math.hypot(a.x - m.x, a.y - m.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    if (best) {
      return aroundFor(m, best.x, best.y, 1.5);
    }
  }
  if (m.kind === "goblin" && m.torch) {
    // The house they came for; if that is well alight already, its nearest neighbor.
    const target = world.building(m.target);
    if (!target || target.phase !== "standing" || target.fire > 0.6) {
      const around = target ?? { rect: { x: m.tx, y: m.ty } };
      let best = -1;
      let bestD = 18;
      for (const b of world.town.buildings) {
        if (
          b === target ||
          b.phase !== "standing" ||
          KINDS[b.kind].flammable < 0.3 ||
          b.fire > 0.3 ||
          b.site.type !== "lot"
        ) {
          continue;
        }
        const d = Math.hypot(b.rect.x - around.rect.x, b.rect.y - around.rect.y);
        if (d < bestD) {
          bestD = d;
          best = b.id;
        }
      }
      m.target = best;
    }
    const b = world.building(m.target);
    if (b) {
      return { x: b.rect.x, y: b.rect.y };
    }
  }
  const spot = aroundFor(m, m.tx, m.ty, SPREAD_AROUND);
  return world.nav.standable(spot.x, spot.y) ? spot : { x: m.tx, y: m.ty };
}

/** A raider at its target: wolves scatter the flock, goblins trample and burn. */
function attack(world: World, m: Monster, dt: number): void {
  const r = world.rng;
  m.pose = "attack";
  if (m.kind === "wolf") {
    // Scatter the sheep and harry them; then on to the next.
    for (const a of world.animals) {
      if ((a.kind === "sheep" || a.kind === "chicken") && Math.hypot(a.x - m.x, a.y - m.y) < 8) {
        a.fear = Math.max(a.fear, 6);
        a.fx = m.x;
        a.fy = m.y;
      }
    }
    if (m.cooldown <= 0) {
      m.cooldown = r.range(1.5, 3);
      world.sound("growl", m.x, m.y, m.z + 0.6);
    }
    if (m.poseTime > 3) {
      m.state = "charge";
      for (let tries = 0; tries < 6; tries++) {
        const x = m.x + r.range(-15, 15);
        const y = m.y + r.range(-15, 15);
        if (world.nav.standable(x, y)) {
          m.tx = x;
          m.ty = y;
          break;
        }
      }
      // Harrying the flock tires them too.
      m.spirit -= 0.12;
    }
    return;
  }
  // Goblins trample what grows under their feet.
  for (const f of world.plan.fields) {
    if (inRect(f.rect, m.x, m.y)) {
      const s = world.town.fields[f.id];
      s.spoiled = clamp01(s.spoiled + dt * (m.torch ? 0.02 : 0.012));
    }
  }
  const target = world.building(m.target);
  if (m.torch && target && target.phase === "standing") {
    if (Math.hypot(target.rect.x - m.x, target.rect.y - m.y) > TORCH_THROW + 1) {
      // The house it came for is out of reach from here (its aim moved on to a neighbor): closer first.
      m.state = "charge";
      return;
    }
    if (m.cooldown <= 0) {
      // Throw the torch onto the roof: then it is gone, and so is some of the nerve.
      m.cooldown = r.range(2.5, 4);
      m.torch = false;
      m.spirit -= 0.25;
      const dx = target.rect.x - m.x;
      const dy = target.rect.y - m.y;
      const flight = 0.9;
      world.missiles.push({
        id: world.nextId++,
        kind: "torch",
        x: m.x,
        y: m.y,
        z: m.z + 1.4,
        vx: dx / flight,
        vy: dy / flight,
        vz: (target.base + 4 - m.z - 1.4) / flight + 4.9 * flight,
        age: 0,
        at: target.id,
      });
      m.heading = Math.atan2(dx, -dy);
      world.sound("sweep", m.x, m.y, m.z + 1);
    }
    return;
  }
  // Without a torch: smash about the yards and trample the fields a while, losing heart as they go.
  m.spirit -= dt * 0.025;
  if (m.poseTime > 4) {
    m.state = "charge";
    m.torch = false;
    // On to another yard about the place the raid came for (on dry land).
    const aim = world.raids.active?.toward ?? m;
    for (let tries = 0; tries < 6; tries++) {
      const x = aim.x + r.range(-14, 14);
      const y = aim.y + r.range(-14, 14);
      if (world.nav.standable(x, y)) {
        m.tx = x;
        m.ty = y;
        break;
      }
    }
    m.spirit -= 0.08;
  }
}

/** Arrows, bolts and thrown torches in flight. */
function moveMissiles(world: World, dt: number): void {
  for (const s of world.missiles.slice()) {
    s.age += dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.z += s.vz * dt;
    if (s.kind !== "bolt") {
      s.vz -= 9.8 * dt;
    }
    let hit = false;
    if (s.kind === "torch") {
      const b = world.building(s.at);
      if (b && inRect(b.rect, s.x, s.y, 0.5) && s.z < b.base + 7) {
        ignite(world, b, 0.35);
        hit = true;
      }
    } else {
      for (const m of world.monsters) {
        if (
          Math.hypot(m.x - s.x, m.y - s.y) < (m.kind === "ogre" ? 1.2 : 0.8) &&
          Math.abs(s.z - (m.z + 0.8)) < 1.3
        ) {
          m.spirit -= s.kind === "bolt" ? 0.5 : 0.22;
          m.pose = "hurt";
          m.poseTime = 0;
          world.sound("hit", m.x, m.y, m.z + 1);
          hit = true;
          break;
        }
      }
      const d = world.dragon;
      if (!hit && d && strikesDragon(d, s, dt)) {
        d.spirit -= s.kind === "bolt" ? 0.12 : 0.03;
        world.sound("hit", d.x, d.y, d.z);
        hit = true;
      }
    }
    if (hit || s.z < world.groundAt(s.x, s.y) - 0.2 || s.age > 5) {
      world.missiles.splice(world.missiles.indexOf(s), 1);
    }
  }
}

/** Speed (m/s) of the dragon about the town, on a pass, and making for home. */
const DRAGON_SPEED = 17;
const PASS_SPEED = 18.7;
const HOMEWARD_SPEED = 20.4;
/**
 * Radius (m) of its tightest turn, and how quickly (rad/s²) it rolls into
 * and out of one; and how far (m) below it the inner wing reaches, were it
 * to lean right over. It flies higher as it leans, and leans only as far as
 * there is room below.
 */
const TURN_RADIUS = 45;
const ROLL_RATE = 0.45;
const LEAN_LIFT = 16;
/** Fastest (m/s) it climbs and sinks, and how quickly (m/s²) it changes between them. */
const CLIMB = 9;
const SINK = 5;
const CLIMB_EASE = 7;
/**
 * Seconds ahead along its way it looks for what it must fly over, and how
 * steeply (m/s) it reckons on climbing to it, so it rises to a hill or a
 * spire in good time and not all at once.
 */
const LOOK_AHEAD = 8;
const CLIMB_CREDIT = 4;
/** Meters it keeps over the roofs, treetops and hills in each part of its flight: lowest making its pass. */
const CLEARANCE: Record<Dragon["phase"], number> = {
  come: 30,
  circle: 22,
  turn: 14,
  pass: 8,
  leave: 30,
};
/**
 * Radius (m) of its circle round the town; how far (m) from what it came
 * for it flies out before it wheels round for a pass, and how far past it
 * the pass runs.
 */
const CIRCLE = 55;
const OUT = 95;
const REACH = 60;
/** Meters ahead along the line of a pass it steers for, easing onto it. */
const LINE_LEAD = 45;
/** How far (m, before and after) either side of what it came for it lets its fire come down. */
const FIRE_SPAN = [30, 22] as const;
const PASSES = 3;
/** Seconds after which it turns for home, whatever it has done. */
const DRAGON_STAY = 240;

/** Meters between the samples of its skyline, and samples each way a sample takes in (its body and wings). */
const SKY_CELL = 4;
const SKY_SPREAD = 3;
const SKY_W = Math.ceil((WORLD.x1 - WORLD.x0) / SKY_CELL) + 1;
const SKY_H = Math.ceil((WORLD.y1 - WORLD.y0) / SKY_CELL) + 1;
/** Meters over bare ground it counts as in its way, so it never skims the grass. */
const SKY_FLOOR = 5;
/** Height (m) of the buildings that stand above the rest, and of the tallest of the rest. */
const SPIRES: Partial<Record<BuildingKind, number>> = {
  church: 27,
  wizard: 25,
  townhall: 15,
  tower: 13,
  tavern: 12.5,
  townhouse: 12,
  stonehouse: 12,
  chapel: 12,
  gatehouse: 12,
  windmill: 11,
  watchtower: 11,
};
const ROOFS = 9;

/**
 * How its fire leaves its jaws: meters ahead of and above its middle,
 * speed (m/s) forward (on top of its own) and down, and how fast (m/s²) it
 * falls. The fire drawn and the fire that sets the town alight both go by it.
 */
export const BREATH = { ahead: 12.5, up: 1.8, speed: 7, drop: 11, fall: 5 } as const;

/** A dragon in from its mountain at `from`, flying for `toward`, high over whatever is in its way. */
function newDragon(world: World, from: Point, toward: Point): Dragon {
  const d: Dragon = {
    x: from.x,
    y: from.y,
    z: 0,
    heading: Math.atan2(toward.x - from.x, -(toward.y - from.y)),
    speed: DRAGON_SPEED,
    turn: 0,
    climb: 0,
    bank: 0,
    phase: "come",
    t: 0,
    age: 0,
    passes: 0,
    ax: 0,
    ay: 0,
    bx: 0,
    by: 0,
    wheel: 1,
    breathing: false,
    spirit: 1,
    flap: 0,
    burns: [],
    sky: skyline(world),
  };
  d.z = altitude(d, CLEARANCE.come);
  return d;
}

/**
 * Where the dragon will be `seconds` from now if it flies on as it flies
 * now: at its speed, round the turn it is making, climbing or sinking as it
 * is. For aiming at it: a shot that takes `t` seconds to arrive should be
 * aimed at `dragonAt(world, t)`, reckoned again with the flight time to that
 * point. Null when there is no dragon.
 */
export function dragonAt(
  world: World,
  seconds: number,
): { x: number; y: number; z: number } | null {
  const d = world.dragon;
  return d ? flownOn(d, seconds, d.turn) : null;
}

/** Where `d` is `seconds` on, flying at its speed and climb and turning at `turn` (rad/s). */
function flownOn(d: Dragon, seconds: number, turn: number): { x: number; y: number; z: number } {
  const h = d.heading;
  const z = d.z + d.climb * seconds;
  if (Math.abs(turn) < 1e-4) {
    return {
      x: d.x + Math.sin(h) * d.speed * seconds,
      y: d.y - Math.cos(h) * d.speed * seconds,
      z,
    };
  }
  const r = d.speed / turn;
  const h2 = h + turn * seconds;
  return {
    x: d.x - r * (Math.cos(h2) - Math.cos(h)),
    y: d.y - r * (Math.sin(h2) - Math.sin(h)),
    z,
  };
}

/** Whether a missile `s`, in the last `dt` seconds of its flight, struck the dragon's body or a wing. */
function strikesDragon(d: Dragon, s: Missile, dt: number): boolean {
  const hx = Math.sin(d.heading);
  const hy = -Math.cos(d.heading);
  const cb = Math.cos(d.bank);
  const sb = Math.sin(d.bank);
  // Along the way it came this step, so a fast shot does not pass clean through.
  for (let k = 0; k < 4; k++) {
    const back = (dt * k) / 4;
    const dx = s.x - s.vx * back - d.x;
    const dy = s.y - s.vy * back - d.y;
    const dz = s.z - s.vz * back - d.z;
    const along = dx * hx + dy * hy;
    const side = -dx * hy + dy * hx;
    // Into its own frame, leaning as it leans.
    const across = side * cb - dz * sb;
    const up = dz * cb + side * sb;
    const body = along > -18 && along < 13 && Math.abs(across) < 2 && up > -2 && up < 4;
    const wing = along > -9.5 && along < 2 && Math.abs(across) < 16 && Math.abs(up) < 4;
    if (body || wing) {
      return true;
    }
  }
  return false;
}

/**
 * Where fire breathed now comes down, flying on with the dragon's own
 * speed as well as its own, and seconds till it does.
 */
export function breathLanding(world: World, d: Dragon): { x: number; y: number; t: number } {
  const hx = Math.sin(d.heading);
  const hy = -Math.cos(d.heading);
  const x0 = d.x + hx * BREATH.ahead;
  const y0 = d.y + hy * BREATH.ahead;
  const z0 = d.z + BREATH.up;
  const speed = d.speed + BREATH.speed;
  const down = BREATH.drop - d.climb;
  let x = x0;
  let y = y0;
  let t = 0;
  // The ground where it comes down decides how long it falls, and so where it comes down.
  for (let k = 0; k < 3; k++) {
    const fall = Math.max(0, z0 - world.groundAt(x, y));
    t = (-down + Math.sqrt(down * down + 2 * BREATH.fall * fall)) / BREATH.fall;
    x = x0 + hx * speed * t;
    y = y0 + hy * speed * t;
  }
  return { x, y, t };
}

/**
 * The height (m) the dragon must clear, over a grid of `SKY_CELL` over the
 * world: the ground (and a little over it), the treetops, the roofs and
 * spires. Each sample takes in its neighbors, for the width of its wings.
 */
function skyline(world: World): Float32Array {
  const raw = new Float32Array(SKY_W * SKY_H);
  const half = SKY_CELL / 2;
  for (let j = 0; j < SKY_H; j++) {
    for (let i = 0; i < SKY_W; i++) {
      const x = WORLD.x0 + i * SKY_CELL;
      const y = WORLD.y0 + j * SKY_CELL;
      let top = -Infinity;
      for (const [ox, oy] of [
        [0, 0],
        [-half, -half],
        [half, -half],
        [-half, half],
        [half, half],
      ]) {
        top = Math.max(top, world.terrain.height(x + ox, y + oy));
      }
      raw[j * SKY_W + i] = top + SKY_FLOOR;
    }
  }
  const raise = (x: number, y: number, top: number) => {
    const k = skyCell(x, y);
    raw[k] = Math.max(raw[k], top);
  };
  const forest = world.forest;
  for (const t of forest.trees) {
    if (forest.state[t.id] === STANDING) {
      raise(t.x, t.y, t.z + t.height);
    }
  }
  for (const b of world.town.buildings) {
    const top = b.base + (SPIRES[b.kind] ?? ROOFS);
    raise(b.rect.x, b.rect.y, top);
    for (const p of rectCorners(b.rect)) {
      raise(p.x, p.y, top);
    }
  }
  // Each sample the highest of those round it: along the rows, then down the columns.
  const rows = new Float32Array(raw.length);
  for (let j = 0; j < SKY_H; j++) {
    for (let i = 0; i < SKY_W; i++) {
      let top = -Infinity;
      for (let k = Math.max(0, i - SKY_SPREAD); k <= Math.min(SKY_W - 1, i + SKY_SPREAD); k++) {
        top = Math.max(top, raw[j * SKY_W + k]);
      }
      rows[j * SKY_W + i] = top;
    }
  }
  for (let j = 0; j < SKY_H; j++) {
    for (let i = 0; i < SKY_W; i++) {
      let top = -Infinity;
      for (let k = Math.max(0, j - SKY_SPREAD); k <= Math.min(SKY_H - 1, j + SKY_SPREAD); k++) {
        top = Math.max(top, rows[k * SKY_W + i]);
      }
      raw[j * SKY_W + i] = top;
    }
  }
  return raw;
}

/** The skyline's sample nearest (x, y); past the edge of the world, the one at the edge. */
function skyCell(x: number, y: number): number {
  const i = clamp(Math.round((x - WORLD.x0) / SKY_CELL), 0, SKY_W - 1);
  const j = clamp(Math.round((y - WORLD.y0) / SKY_CELL), 0, SKY_H - 1);
  return j * SKY_W + i;
}

/**
 * How high the dragon should be now to keep `clearance` over what lies
 * ahead: both round the turn it is making and straight on, reckoning on a
 * steady climb to what is further off.
 */
function altitude(d: Dragon, clearance: number): number {
  let need = -Infinity;
  for (let k = 0; k <= LOOK_AHEAD * 4; k++) {
    const t = k / 4;
    const round = flownOn(d, t, d.turn);
    const straight = flownOn(d, t, 0);
    const top = Math.max(d.sky[skyCell(round.x, round.y)], d.sky[skyCell(straight.x, straight.y)]);
    need = Math.max(need, top - t * CLIMB_CREDIT);
  }
  return need + clearance;
}

/** Wraps an angle into -π..π. */
function wrap(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

/** The heading from the dragon to (x, y). */
function bearing(d: Dragon, x: number, y: number): number {
  return Math.atan2(x - d.x, -(y - d.y));
}

/**
 * Flies the dragon on for dt seconds, making for `heading` at `speed`: it
 * rolls into a turn and out of it, no tighter than `TURN_RADIUS`, leaning
 * as it turns, and climbs and sinks smoothly to keep its clearance over
 * what lies ahead.
 */
function steer(d: Dragon, heading: number, speed: number, dt: number): void {
  d.speed += clamp(speed - d.speed, -3 * dt, 3 * dt);
  // Room below for the inner wing, at the bottom of its beat.
  const room = (d.z - d.sky[skyCell(d.x, d.y)] - 4) / LEAN_LIFT;
  const lean = Math.asin(clamp(room, 0.2, 0.99));
  const most = Math.min(d.speed / TURN_RADIUS, (Math.tan(lean) * 9.8) / d.speed);
  const want = clamp(wrap(heading - d.heading) * 0.9, -most, most);
  d.turn += clamp(want - d.turn, -ROLL_RATE * dt, ROLL_RATE * dt);
  d.bank = Math.atan((d.speed * d.turn) / 9.8);
  const next = flownOn(d, dt, d.turn);
  d.x = next.x;
  d.y = next.y;
  d.heading = wrap(d.heading + d.turn * dt);
  const clearance = CLEARANCE[d.phase] + LEAN_LIFT * Math.abs(Math.sin(d.bank));
  const rise = clamp((altitude(d, clearance) - d.z) * 0.8, -SINK, CLIMB);
  d.climb += clamp(rise - d.climb, -CLIMB_EASE * dt, CLIMB_EASE * dt);
  d.z += d.climb * dt;
}

/** The heading that keeps the dragon wheeling round `c` at `CIRCLE`, easing in or out onto the circle. */
function circling(d: Dragon, c: Point): number {
  const dx = d.x - c.x;
  const dy = d.y - c.y;
  const r = Math.hypot(dx, dy) || 1;
  const ux = dx / r;
  const uy = dy / r;
  // Round with its heading growing is counterclockwise seen from above.
  const inward = clamp((r - CIRCLE) / 25, -1.5, 1.5);
  const vx = -uy * d.wheel - ux * inward;
  const vy = ux * d.wheel - uy * inward;
  return Math.atan2(vx, -vy);
}

/** Where the dragon is against the line of its pass: meters along it from its start, and its direction. */
function onLine(d: Dragon): { along: number; ux: number; uy: number } {
  const len = Math.hypot(d.bx - d.ax, d.by - d.ay) || 1;
  const ux = (d.bx - d.ax) / len;
  const uy = (d.by - d.ay) / len;
  return { along: (d.x - d.ax) * ux + (d.y - d.ay) * uy, ux, uy };
}

/** The heading that brings the dragon onto the line of its pass and along it. */
function following(d: Dragon): number {
  const { along, ux, uy } = onLine(d);
  const lead = Math.max(along, 0) + LINE_LEAD;
  return bearing(d, d.ax + ux * lead, d.ay + uy * lead);
}

/** The dragon: in from the mountains, round the town, sweeping passes low with its fire, and away. */
function moveDragon(world: World, d: Dragon, dt: number): void {
  const raid = world.raids.active;
  const c = raid ? raid.toward : world.plan.center;
  d.t += dt;
  d.age += dt;
  const beat = d.phase === "pass" ? 1.2 : 1.8;
  d.flap += dt * beat;
  if (Math.floor(d.flap) !== Math.floor(d.flap - dt * beat)) {
    world.sound("flap", d.x, d.y, d.z);
  }
  kindle(world, d);
  if (d.phase !== "leave" && d.age > DRAGON_STAY) {
    leave(d);
  }
  switch (d.phase) {
    case "come": {
      steer(d, bearing(d, c.x, c.y), DRAGON_SPEED, dt);
      if (Math.hypot(d.x - c.x, d.y - c.y) < CIRCLE + 20 || d.t > 40) {
        d.phase = "circle";
        d.t = 0;
        // Round whichever way it is already bending.
        const cross = (d.x - c.x) * -Math.cos(d.heading) - (d.y - c.y) * Math.sin(d.heading);
        d.wheel = cross >= 0 ? 1 : -1;
        world.sound("roar", d.x, d.y, d.z);
      }
      return;
    }
    case "circle": {
      steer(d, circling(d, c), DRAGON_SPEED, dt);
      if (d.t > 16) {
        beginTurn(world, d, c);
      }
      return;
    }
    case "turn": {
      // Out from the town, then round in a wide banked sweep, the way it wheels, till it faces it again.
      const dx = d.x - d.bx;
      const dy = d.y - d.by;
      const outward =
        (dx * Math.sin(d.heading) - dy * Math.cos(d.heading)) / (Math.hypot(dx, dy) || 1);
      if (Math.hypot(dx, dy) < OUT && outward > -0.3) {
        steer(d, d.heading, DRAGON_SPEED, dt);
        return;
      }
      let err = wrap(bearing(d, d.bx, d.by) - d.heading);
      if (Math.abs(err) > 0.6 && Math.sign(err) !== d.wheel) {
        err += d.wheel * Math.PI * 2;
      }
      steer(d, d.heading + err, DRAGON_SPEED, dt);
      const aim = bearing(d, d.bx, d.by);
      if ((Math.abs(wrap(aim - d.heading)) < 0.12 && Math.abs(d.turn) < 0.15) || d.t > 30) {
        // Lined up: the pass runs from here over the place and on past it.
        const along = Math.hypot(d.bx - d.x, d.by - d.y) + REACH;
        d.ax = d.x;
        d.ay = d.y;
        d.bx = d.x + Math.sin(aim) * along;
        d.by = d.y - Math.cos(aim) * along;
        d.phase = "pass";
        d.t = 0;
      }
      return;
    }
    case "pass": {
      steer(d, following(d), PASS_SPEED, dt);
      breathe(world, d, c, dt);
      if (onLine(d).along >= Math.hypot(d.bx - d.ax, d.by - d.ay) || d.t > 20) {
        d.passes++;
        d.breathing = false;
        world.sound("roar", d.x, d.y, d.z);
        if (d.passes >= PASSES || d.spirit <= 0.2) {
          leave(d);
        } else {
          beginTurn(world, d, c);
        }
      }
      return;
    }
    case "leave": {
      const home = lairDirection(world);
      steer(d, bearing(d, home.x, home.y), HOMEWARD_SPEED, dt);
      if (Math.hypot(home.x - d.x, home.y - d.y) < 10 || d.t > 30) {
        world.dragon = null;
      }
      return;
    }
  }
}

/** Off home, its fire out. */
function leave(d: Dragon): void {
  d.phase = "leave";
  d.t = 0;
  d.breathing = false;
}

/** Sends the dragon round for another pass, over a place a little to one side or the other of what it came for. */
function beginTurn(world: World, d: Dragon, c: Point): void {
  const a = world.rng.range(0, Math.PI * 2);
  const off = world.rng.range(0, 8);
  d.bx = c.x + Math.cos(a) * off;
  d.by = c.y + Math.sin(a) * off;
  d.phase = "turn";
  d.t = 0;
}

/** On a pass, fire while it would come down over what the dragon came for. */
function breathe(world: World, d: Dragon, c: Point, dt: number): void {
  const land = breathLanding(world, d);
  const { ux, uy } = onLine(d);
  const at = (land.x - c.x) * ux + (land.y - c.y) * uy;
  d.breathing = d.spirit > 0.2 && at > -FIRE_SPAN[0] && at < FIRE_SPAN[1];
  if (!d.breathing) {
    return;
  }
  if (world.rng.chance(dt * 3)) {
    world.sound("breath", d.x, d.y, d.z);
  }
  d.burns.push({ x: land.x, y: land.y, at: d.age + land.t, dose: dt });
}

/** Fire that has come down: what lies there catches, and the crops under it are spoiled. */
function kindle(world: World, d: Dragon): void {
  for (let i = d.burns.length - 1; i >= 0; i--) {
    const f = d.burns[i];
    if (f.at > d.age) {
      continue;
    }
    d.burns.splice(i, 1);
    for (const b of world.town.buildings) {
      if (b.phase !== "ruin" && inRect(b.rect, f.x, f.y, 3)) {
        ignite(world, b, f.dose * 0.9);
      }
    }
    for (const field of world.plan.fields) {
      if (inRect(field.rect, f.x, f.y, 2)) {
        const s = world.town.fields[field.id];
        s.spoiled = clamp01(s.spoiled + f.dose * 0.3);
      }
    }
  }
}
