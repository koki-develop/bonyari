import { clamp01 } from "../../shared/core/math.ts";
import { newAnimal } from "./animals.ts";
import { KINDS, roofHolds } from "./buildings.ts";
import { chooseTask, inDanger, keptUp } from "./jobs.ts";
import { GROWN, type Household, isChild, LEAVING_AGE, type Person, YEAR } from "./people.ts";
import { runTask, type Task } from "./tasks.ts";
import type { World } from "./world.ts";

/** One house in this many keeps a light burning late into the night. */
const LATE_LIGHT = 4;
/** Seconds between looks at who has a lamp lit. */
const LAMPS_EVERY = 0.25;
/** Food each person eats in a day. */
export const RATION = 0.5;
/** What the first settlers bring with them. */
const PROVISIONS = { wood: 0, stone: 4, food: 70 };

/**
 * Makes a new person of a household, standing at (x, y), `age` years old,
 * and adds them to the world.
 */
export function newPerson(
  world: World,
  household: Household,
  age: number,
  x: number,
  y: number,
): Person {
  const p = makePerson(world, household.id, age, x, y);
  world.addPerson(p);
  household.members.push(p.id);
  return p;
}

/** Someone new, not yet one of the settlement (see `newPerson`); a trader stays so. */
export function makePerson(
  world: World,
  household: number,
  age: number,
  x: number,
  y: number,
): Person {
  const r = world.rng;
  const p: Person = {
    id: world.nextId++,
    household,
    age,
    female: r.chance(0.5),
    job: "idle",
    look: r.int(0, 0x7fffffff),
    x,
    y,
    z: world.groundAt(x, y),
    heading: 0,
    inside: -1,
    task: null,
    path: [],
    step: 0,
    lane: r.range(0.35, 0.8),
    carry: null,
    pose: "stand",
    poseTime: r.range(0, 1),
    militia: false,
    leaving: false,
    arriving: false,
    trader: false,
  };
  p.militia = age >= 17 && age < 52 && (!p.female || r.chance(0.35));
  return p;
}

/** A household of `adults` grown-ups and `children`, standing at (x, y). */
export function newHousehold(
  world: World,
  adults: number,
  children: number,
  x: number,
  y: number,
): Household {
  const r = world.rng;
  const h: Household = { id: world.nextId++, home: -1, lodging: -1, members: [] };
  world.addHousehold(h);
  for (let k = 0; k < adults; k++) {
    const p = newPerson(
      world,
      h,
      k < 2 ? r.range(22, 42) : r.range(50, 64),
      x + r.range(-1.5, 1.5),
      y + r.range(-1, 1),
    );
    if (k < 2) {
      // A couple: one of each, mostly.
      p.female = k === 1 ? !world.person(h.members[0])?.female : p.female;
      p.militia = p.age < 52 && (!p.female || r.chance(0.35));
    }
  }
  for (let k = 0; k < children; k++) {
    newPerson(world, h, r.range(2, 13), x + r.range(-1.5, 1.5), y + r.range(-1, 1));
  }
  return h;
}

/**
 * The founding: a family up the old road from the west with their cart,
 * their sheep and their dog; they pitch camp by the ford, and the first
 * work is set out.
 */
export function found(world: World): void {
  const plan = world.plan;
  const r = world.rng;
  world.stock.wood = PROVISIONS.wood;
  world.stock.stone = PROVISIONS.stone;
  world.stock.food = PROVISIONS.food;
  const camp = world.found("camp", { type: "square" }, 0, "building");
  camp.progress = 0.2;
  // They come in along the trade road from the west, already near the meadow.
  const entry = plan.nodes[plan.exits[0]];
  const c = plan.center;
  const start = { x: entry.x + (c.x - entry.x) * 0.72, y: entry.y + (c.y - entry.y) * 0.72 };
  const family = newHousehold(world, 2, r.int(2, 3), start.x, start.y);
  family.home = camp.id;
  const second = newHousehold(world, 2, r.int(0, 1), start.x - 3, start.y - 1);
  second.home = camp.id;
  for (const p of world.people) {
    p.carry = r.pick(["bundle", "sack", null, "basket"] as const);
  }
  const dogOwner = world.people[0];
  newAnimal(world, "dog", dogOwner.x - 1, dogOwner.y, { type: "person", id: dogOwner.id });
  // The flock, to graze the meadow until there is a pasture.
  for (let k = 0; k < 5; k++) {
    newAnimal(world, "sheep", c.x + r.range(-12, -4), c.y + r.range(-10, -2), {
      type: "wild",
      id: -1,
    });
  }
  for (let k = 0; k < 4; k++) {
    newAnimal(world, "chicken", c.x + r.range(2, 6), c.y + r.range(3, 6), { type: "wild", id: -1 });
  }
  world.council.begin(world);
  world.raids.begin(world);
}

/** Everyone: their tasks, their years, and the lamps in their windows. */
export function updatePeople(world: World, dt: number, days: number): void {
  // The tally of tasks is kept as tasks begin and end; the claims on piles are counted afresh.
  const tally = world.council.tally;
  const claims = world.council.claims;
  claims.clear();
  const claim = (t: Task, k: number) => {
    if (t.claim === undefined) {
      return;
    }
    // A claim lasts until the pile has been taken from.
    for (let i = t.i; i < t.steps.length; i++) {
      const s = t.steps[i];
      if (s.t === "do" && (s.effect.kind === "takePile" || s.effect.kind === "loadCart")) {
        claims.set(t.claim, (claims.get(t.claim) ?? 0) + k * (t.claimCount ?? 2));
        return;
      }
    }
  };
  for (const p of world.people) {
    if (p.task) {
      claim(p.task, 1);
    }
  }
  // A copy: those who leave are taken off the list as it is gone through.
  for (const p of world.people.slice()) {
    p.age += days / YEAR;
    // No one stays in a building that is burning or has fallen in.
    if (p.inside >= 0 && !roofHolds(world.building(p.inside))) {
      world.leaveBuilding(p);
      if (p.task) {
        p.task.i = p.task.steps.length;
      }
    }
    // Those out against the raiders come home at the all-clear.
    const stoodDown = p.task?.kind === "defend" && !world.raids.alarm;
    if (p.task && (stoodDown || keptUp(world, p) || inDanger(world, p))) {
      p.task.i = p.task.steps.length;
    }
    if (!runTask(world, p, dt)) {
      if (p.task) {
        const left = (tally.get(p.task.kind) ?? 1) - 1;
        if (left > 0) {
          tally.set(p.task.kind, left);
        } else {
          tally.delete(p.task.kind);
        }
        claim(p.task, -1);
      }
      if (world.person(p.id) !== p) {
        continue;
      }
      // Whatever was in hand is put down where it will be found.
      if (p.carry === "log" || p.carry === "stone" || p.carry === "logs") {
        world.drop(p);
      }
      p.path = [];
      p.step = 0;
      p.task = chooseTask(world, p);
      tally.set(p.task.kind, (tally.get(p.task.kind) ?? 0) + 1);
      claim(p.task, 1);
    }
    // Grown up: a child becomes a worker (and may be called up in a raid).
    if (p.age >= GROWN && p.age - days / YEAR < GROWN) {
      p.militia = !p.female || world.rng.chance(0.35);
      world.council.assignJob(world, p);
    }
    if (p.age >= LEAVING_AGE && !p.leaving && world.rng.chance(days * 0.3)) {
      p.leaving = true;
    }
    if (p.militia && p.age >= 52) {
      p.militia = false;
    }
  }
  world.lampsIn -= dt;
  if (world.lampsIn <= 0) {
    // The lamps are looked to a few times a second: they come up and die down slowly anyway.
    lamps(world, LAMPS_EVERY - world.lampsIn);
    world.lampsIn = LAMPS_EVERY;
  }
}

/**
 * Lamps and hearths: a lit window wherever someone is at home after dark
 * (out at bedtime but for a few), the tavern bright into the night.
 */
function lamps(world: World, dt: number): void {
  const dark = world.env.darkness;
  const h = world.env.clock.hour;
  const inside = new Map<number, number>();
  for (const p of world.people) {
    if (p.inside >= 0) {
      inside.set(p.inside, (inside.get(p.inside) ?? 0) + (isChild(p) ? 0.3 : 1));
    }
  }
  const late = h >= 22.3 || h < 4.5;
  for (const b of world.town.buildings) {
    if (b.phase !== "standing") {
      b.lamps = 0;
      continue;
    }
    const people = inside.get(b.id) ?? 0;
    let want = 0;
    if (dark > 0.05 && people > 0) {
      want = late
        ? b.kind === "tavern"
          ? 0.6
          : b.variant % LATE_LIGHT === 0
            ? 0.35
            : 0
        : clamp01(0.55 + people * 0.15);
    }
    if (b.kind === "tavern" && dark > 0.1 && h > 16) {
      want = Math.max(want, 0.9);
    }
    if ((b.kind === "church" || b.kind === "chapel") && people > 2) {
      want = Math.max(want, 0.7 * dark);
    }
    if (b.kind === "wizard" && dark > 0.1) {
      want = Math.max(want, 0.8);
    }
    if (KINDS[b.kind].shelter || b.kind === "wizard") {
      b.lamps += (want * Math.max(dark, 0.25) - b.lamps) * Math.min(1, dt * 0.8);
    }
  }
}
