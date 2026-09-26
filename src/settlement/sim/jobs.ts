import { mod } from "../../shared/core/math.ts";
import { type Building, buildStep, KINDS } from "./buildings.ts";
import { buildable, wants, workable } from "./construction.ts";
import { fieldNeeds } from "./farming.ts";
import { bonfireSpot, DANCE_RING, FESTIVAL_LATE, festivalDay, festive } from "./festival.ts";
import { alongFence, fenceBuilt, fenceRun } from "./fence.ts";
import { STANDING, STUMP } from "./forest.ts";
import { rectPoint } from "./geometry.ts";
import { TOIL } from "./pace.ts";
import { isChild, isOld, type Person, roofOf, RUN_SPEED, walkSpeed } from "./people.ts";
import { type Step, type Task, task } from "./tasks.ts";
import { dangerAt } from "./council.ts";
import { dragonAt, type Monster, velocityOf } from "./raids.ts";
import { type Point, WORLD } from "./terrain.ts";
import type { World } from "./world.ts";

/** Hours of the working day: when work begins and ends, and bedtimes. */
const WORK_END = 18;
const BEDTIME = 21.4;
const CHILD_BEDTIME = 20.2;
/** Most hours anyone sets out early to be home by bedtime. */
const WALK_HOME_MOST = 4;
/** Below this many people everyone does whatever most wants doing. */
const HAMLET = 18;
/** One day in six is a day of rest, and one in three a market day. */
const REST_EVERY = 6;
const MARKET_EVERY = 3;

/** What of the time of day everyone's choices look at, worked out once for each step of the world. */
interface DayClock {
  /** `World.time` it was worked out at. */
  time: number;
  hour: number;
  wake: number;
  festival: boolean;
}

/** The day clock last worked out, and for which world. */
let clockWorld: World | null = null;
const clock: DayClock = { time: -1, hour: 0, wake: 0, festival: false };

function dayClock(world: World): DayClock {
  if (clockWorld !== world || clock.time !== world.time) {
    clockWorld = world;
    clock.time = world.time;
    clock.hour = world.env.clock.hour;
    clock.wake = 5.4 + 1.3 * (1 - world.season.warmth);
    clock.festival = festivalDay(world);
  }
  return clock;
}

/** The hour of the day now. */
function hour(world: World): number {
  return dayClock(world).hour;
}

/** The clock reading (in-world days) at `h` o'clock today, or tomorrow if that has passed. */
function at(world: World, h: number): number {
  const days = world.env.clock.days;
  const today = Math.floor(days) + h / 24;
  return today > days ? today : today + 1;
}

/** When the town rises: later in the dark of winter. */
export function wakeHour(world: World): number {
  return dayClock(world).wake;
}

/** Hours either side of the town's rising that each person rises, early risers to late. */
const RISE_SPREAD = [-0.6, 1.1] as const;
/** The baker is up well before everyone for the morning's bread. */
const BAKER_EARLY = 1.2;
/** Children lie abed a little longer. */
const CHILD_LATE = 0.4;

/** When someone rises: the town's hour, early or late by their own habit. */
function riseOf(world: World, p: Person): number {
  // A habit of their own, the same every morning.
  const habit = ((p.look >>> 12) & 1023) / 1023;
  const spread = RISE_SPREAD[0] + (RISE_SPREAD[1] - RISE_SPREAD[0]) * habit;
  const trade = p.job === "baker" ? -BAKER_EARLY : isChild(p) ? CHILD_LATE : 0;
  return wakeHour(world) + spread + trade;
}

export function isRestDay(world: World): boolean {
  return mod(Math.floor(world.env.clock.days), REST_EVERY) === REST_EVERY - 1;
}

export function isMarketDay(world: World): boolean {
  return mod(Math.floor(world.env.clock.days), MARKET_EVERY) === 1 && world.council.market;
}

/**
 * Whether someone is due to make for bed: at bedtime, or earlier by as long
 * as the walk home will take them.
 */
function bedtime(world: World, p: Person): boolean {
  const clock = dayClock(world);
  const h = clock.hour;
  if (h < riseOf(world, p)) {
    return true;
  }
  const late =
    (isChild(p) ? CHILD_BEDTIME : isOld(p) ? BEDTIME - 1 : BEDTIME) +
    (clock.festival ? FESTIVAL_LATE : 0);
  if (h < late - WALK_HOME_MOST) {
    return false;
  }
  const home = homeOf(world, p);
  const far = home && p.inside !== home.id ? Math.hypot(home.rect.x - p.x, home.rect.y - p.y) : 0;
  const walk = Math.min(
    WALK_HOME_MOST,
    (far / walkSpeed(p)) * (24 / world.env.clock.timekeeping.secondsPerDay),
  );
  return h >= late - walk;
}

/**
 * Whether it is late enough in the day (or early enough in the morning) that
 * anyone at all may be due to make for bed: the longest walk home starts
 * `WALK_HOME_MOST` hours before the earliest bedtime.
 */
function bedtimeNear(world: World): boolean {
  const h = hour(world);
  return (
    h < wakeHour(world) + RISE_SPREAD[1] + CHILD_LATE || h >= CHILD_BEDTIME - 1 - WALK_HOME_MOST
  );
}

/** The building someone sleeps under now (their home, or where they lodge while it is down), if any. */
function homeOf(world: World, p: Person): Building | undefined {
  const h = world.household(p.household);
  return h ? world.building(roofOf(h)) : undefined;
}

/** Tries at finding open ground near a point before settling for the point itself. */
const NEAR_TRIES = 8;

/**
 * A point a little way from `c` on open ground (not in the river, not
 * inside a building), for standing about without all on one spot.
 */
function near(world: World, c: Point, r: number): Point {
  for (let k = 0; k < NEAR_TRIES; k++) {
    const a = world.rng.range(0, Math.PI * 2);
    const d = world.rng.range(r * 0.3, r);
    const x = c.x + Math.cos(a) * d;
    const y = c.y + Math.sin(a) * d;
    if (world.nav.standable(x, y)) {
      return { x, y };
    }
  }
  return { x: c.x, y: c.y };
}

/** How many are already at a task of this kind. */
function busy(world: World, kind: string): number {
  return world.council.tally.get(kind) ?? 0;
}

/** A spot to work at by a building: out in front of one of its sides. */
function besideBuilding(
  world: World,
  b: Building,
  lift = false,
): { x: number; y: number; lift: number } {
  const r = world.rng;
  const w = b.rect.width;
  const d = b.rect.depth;
  const side = r.int(0, 2);
  const p =
    side === 0
      ? rectPoint(b.rect, r.range(-w / 2, w / 2), -d / 2 - 0.9)
      : rectPoint(b.rect, (side === 1 ? 1 : -1) * (w / 2 + 0.9), r.range(-d / 2, d / 2));
  // Up on the scaffold at the front while the walls go up.
  const step = buildStep(b);
  const up =
    lift && side === 0 && step >= 2 && step <= 4 && r.chance(0.5) ? (step >= 3 ? 2.9 : 1.4) : 0;
  return { x: p.x, y: p.y, lift: up };
}

/**
 * What someone does next: running for cover or taking up arms when raiders
 * come, fighting a fire, going to bed, a day's work, an evening out.
 */
export function chooseTask(world: World, p: Person): Task {
  // Raiders: a few go out against them; everyone else runs from any that are near, and gets under a roof.
  const threat = nearestRaider(world, p);
  const near = threat !== null && threat.d < FLEE_NEAR;
  if (world.raids.alarm || near) {
    const grown = !isChild(p) && !isOld(p);
    if (world.raids.alarm && world.raids.defenders.has(p.id) && grown) {
      return defend(world, p);
    }
    if (near) {
      return flee(world, p);
    }
    // A fire the raiders have left behind them is fought even before the all-clear.
    const fire = grown ? fightFire(world, p) : null;
    return fire ?? shelter(world, p);
  }
  if (p.leaving) {
    return leave(world, p);
  }
  if (p.arriving) {
    return arrive(world, p);
  }
  const fire = !isChild(p) && !isOld(p) ? fightFire(world, p) : null;
  if (fire) {
    return fire;
  }
  if (bedtime(world, p)) {
    return sleep(world, p);
  }
  // The harvest home: all out round the fire, the old ones sitting by, the children in and out of the ring.
  if (festive(world) && world.rng.chance(isOld(p) ? 0.6 : 0.9)) {
    return festival(world, p);
  }
  if (isChild(p)) {
    return childTask(world, p);
  }
  if (isOld(p)) {
    return elderTask(world, p);
  }
  const h = hour(world);
  if (isRestDay(world) && h >= 8.6 && h < 11 && world.council.worship() !== null) {
    return worship(world, p);
  }
  const end = WORK_END - (1 - world.season.warmth) * 1.2;
  if (h < end && !isRestDay(world)) {
    // The day's trade, or with nothing of it to do, the round of chores about the house.
    return jobTask(world, p) ?? chore(world, p) ?? leisure(world, p);
  }
  return leisure(world, p);
}

/** Meters from home that the river is gone to for washing. */
const WASHING_REACH = 70;

/**
 * The work about a household that goes on when there is nothing of one's
 * trade to do: the garden, firewood split by the door, washing down at the
 * river, water from the well, a sack to or from the mill or the bakery.
 */
function chore(world: World, p: Person): Task | null {
  const r = world.rng;
  const home = homeOf(world, p);
  if (!home || home.phase !== "standing") {
    return null;
  }
  const door = world.door(home);
  const lot = home.site.type === "lot" ? world.plan.lots[home.site.lot] : null;
  // Each chore with how often it comes round.
  const choices: [number, () => Task | null][] = [];
  // The garden behind the house, while things grow.
  if (lot && world.town.lotGround[lot.id] === 2 && world.season.warmth > 0.3) {
    choices.push([
      3,
      () => {
        const q = rectPoint(
          lot.rect,
          r.range(-0.35, 0.35) * lot.rect.width,
          r.range(0.1, 0.4) * lot.rect.depth,
        );
        if (!world.nav.standable(q.x, q.y)) {
          return null;
        }
        return task("garden", [
          { t: "carry", item: null },
          { t: "go", x: q.x, y: q.y },
          {
            t: "work",
            pose: "hoe",
            seconds: r.range(20, 40),
            fx: q.x + 1,
            fy: q.y,
            sound: "hoe",
            every: 1.3,
          },
          { t: "work", pose: "sow", seconds: r.range(6, 12), fx: q.x - 1, fy: q.y },
        ]);
      },
    ]);
  }
  // Firewood split by the door.
  choices.push([
    2,
    () => {
      const q = near(world, door, 2.5);
      return task("firewood", [
        { t: "carry", item: "log" },
        { t: "go", x: q.x, y: q.y },
        { t: "carry", item: null },
        {
          t: "work",
          pose: "chop",
          seconds: r.range(15, 30),
          fx: q.x,
          fy: q.y - 0.8,
          sound: "chop",
          every: 1.5,
        },
        { t: "carry", item: "logs" },
        { t: "go", x: door.x, y: door.y },
        { t: "carry", item: null },
      ]);
    },
  ]);
  // Washing at the river, or a line in it, when it is not far.
  const side = world.terrain.riverOffset(door.x, door.y) > 0 ? 1 : -1;
  const bank = world.terrain.bankPoint(door.y + r.range(-8, 8), side, 0.8);
  if (Math.hypot(bank.x - door.x, bank.y - door.y) < WASHING_REACH && world.season.warmth > 0.2) {
    choices.push([
      1.5,
      () =>
        task("wash", [
          { t: "carry", item: "basket" },
          { t: "go", x: bank.x, y: bank.y },
          { t: "carry", item: null },
          {
            t: "work",
            pose: "dig",
            seconds: r.range(20, 40),
            fx: world.terrain.riverX(bank.y),
            fy: bank.y,
            sound: "bucket",
            every: 5,
          },
          { t: "carry", item: "basket" },
          { t: "go", x: door.x, y: door.y },
          { t: "carry", item: null },
        ]),
    ]);
    choices.push([
      1,
      () =>
        task("fish", [
          { t: "carry", item: "rod" },
          { t: "go", x: bank.x, y: bank.y },
          {
            t: "work",
            pose: "fish",
            seconds: r.range(40, 90),
            fx: world.terrain.riverX(bank.y),
            fy: bank.y,
          },
          { t: "go", x: door.x, y: door.y },
          { t: "carry", item: null },
        ]),
    ]);
  }
  // Water from the well.
  if (world.council.wells.length > 0) {
    choices.push([
      1,
      () => {
        const well = world.council.waterNear(world, door.x, door.y);
        return task("water", [
          { t: "carry", item: null },
          { t: "go", x: well.x, y: well.y },
          { t: "work", pose: "dig", seconds: 3, sound: "bucket", every: 3 },
          { t: "carry", item: "bucket" },
          { t: "go", x: door.x, y: door.y },
          { t: "carry", item: null },
        ]);
      },
    ]);
  }
  // Grain to the mill or bread from the bakery.
  const mill = world.council.place(world, "watermill") ?? world.council.place(world, "windmill");
  const bakery = world.council.place(world, "bakery");
  const errand = r.chance(0.5) ? mill : bakery;
  if (errand) {
    choices.push([
      1,
      () => {
        const d = near(world, world.door(errand), 2);
        const toMill = errand === mill;
        return task("errand", [
          { t: "carry", item: toMill ? "sack" : "basket" },
          { t: "go", x: d.x, y: d.y },
          { t: "wait", seconds: r.range(3, 8) },
          { t: "carry", item: toMill ? "sack" : "bread" },
          { t: "go", x: door.x, y: door.y },
          { t: "carry", item: null },
        ]);
      },
    ]);
  }
  let pick = r.range(
    0,
    choices.reduce((n, [w]) => n + w, 0),
  );
  for (const [w, make] of choices) {
    pick -= w;
    if (pick <= 0) {
      return make();
    }
  }
  return choices[choices.length - 1][1]();
}

/**
 * An evening at the harvest fire: round it in the ring dance, clapping the
 * time at the edge of the crowd, or sitting to watch.
 */
function festival(world: World, p: Person): Task {
  const r = world.rng;
  const fire = bonfireSpot(world.plan);
  const at = (a: number, d: number) => ({
    x: fire.x + Math.cos(a) * d,
    y: fire.y + Math.sin(a) * d,
  });
  const pick = r.next();
  if (!isOld(p) && pick < 0.5) {
    // The ring goes round one way; each joins it where they come to it.
    let a = Math.atan2(p.y - fire.y, p.x - fire.x);
    const start = at(a, DANCE_RING);
    const steps: Step[] = [
      { t: "carry", item: null },
      { t: "go", x: start.x, y: start.y },
    ];
    for (let k = r.int(8, 16); k > 0; k--) {
      a += Math.PI / 6;
      const q = at(a, DANCE_RING + r.range(-0.2, 0.2));
      steps.push({ t: "go", x: q.x, y: q.y, dance: true, direct: true });
    }
    steps.push({ t: "wait", seconds: r.range(2, 5), pose: "stand" });
    return task("dance", steps);
  }
  const a = r.range(0, Math.PI * 2);
  if (isOld(p) || pick > 0.85) {
    const q = at(a, r.range(7, 8.5));
    return task("feast", [
      { t: "carry", item: null },
      { t: "go", x: q.x, y: q.y },
      { t: "work", pose: "sit", seconds: r.range(25, 50), fx: fire.x, fy: fire.y },
    ]);
  }
  const q = at(a, r.range(5.8, 7.2));
  return task("feast", [
    { t: "carry", item: null },
    { t: "go", x: q.x, y: q.y },
    {
      t: "work",
      pose: "wave",
      seconds: r.range(12, 30),
      fx: fire.x,
      fy: fire.y,
      sound: "clap",
      every: r.range(1.5, 2.2),
    },
  ]);
}

/** What kind of task a task is, without the building or field it is at (`build-12` is `build`). */
function baseKind(kind: string): string {
  const dash = kind.indexOf("-");
  return dash < 0 ? kind : kind.slice(0, dash);
}

/** What goes on after bedtime: sleep itself, the watch, raids and fires, coming and going, the tavern. */
const LATE = new Set([
  "sleep",
  "shelter",
  "flee",
  "defend",
  "firefight",
  "watch",
  "patrol",
  "arrive",
  "leave",
  "tavern",
  "home",
  "bells",
  "wizard",
]);

/**
 * Whether someone is still about something that can wait till morning when
 * they are due in bed. What they carry they bring in first.
 */
export function keptUp(world: World, p: Person): boolean {
  if (!bedtimeNear(world)) {
    return false;
  }
  const t = p.task;
  if (!t || !bedtime(world, p) || LATE.has(baseKind(t.kind))) {
    return false;
  }
  return p.carry !== "log" && p.carry !== "logs" && p.carry !== "stone";
}

/** Bed: home (or any roof, while home is down or burning), and inside until their hour to rise. */
function sleep(world: World, p: Person): Task {
  const own = homeOf(world, p);
  const home =
    own && own.phase === "standing" && own.fire <= 0.05
      ? own
      : world.council.shelterNear(world, p.x, p.y);
  const rise = riseOf(world, p);
  // Before their hour this morning they sleep on till it; otherwise till it comes tomorrow.
  const wake = hour(world) < rise ? Math.floor(world.env.clock.days) + rise / 24 : at(world, rise);
  if (!home) {
    return task("sleep", [{ t: "wait", seconds: 20 }]);
  }
  const d = world.door(home);
  return task("sleep", [
    { t: "go", x: d.x, y: d.y, enter: home.id },
    { t: "stay", until: wake },
  ]);
}

/** Newcomers: up the road to the house that is to be theirs. */
function arrive(world: World, p: Person): Task {
  const home = homeOf(world, p);
  if (!home) {
    p.arriving = false;
    return leisure(world, p);
  }
  const d = world.door(home);
  return task("arrive", [
    { t: "go", x: d.x, y: d.y },
    { t: "do", effect: { kind: "arrived" } },
    { t: "carry", item: null },
    { t: "go", x: d.x, y: d.y, enter: home.id },
    { t: "stay", until: world.env.clock.days + 0.03 },
  ]);
}

/** Leaving for good: down the road and out of the valley. */
function leave(world: World, _p: Person): Task {
  const exits = world.plan.exits;
  const node = world.plan.nodes[world.rng.pick(exits)];
  return task("leave", [
    { t: "carry", item: "bundle" },
    { t: "go", x: node.x, y: node.y },
    { t: "do", effect: { kind: "gone" } },
  ]);
}

/** Meters from a raider within which someone not out to fight it runs, and how far they run. */
const FLEE_NEAR = 10;
const FLEE_RUN = 14;
/** Meters within which a raider sends even someone running for shelter off another way. */
const CUT_OFF = 6;
/** Meters within which a raider makes someone already running choose their way again. */
const CAUGHT_UP = 3;

/** The nearest raider not already running itself, and how far off it is. */
function nearestRaider(world: World, p: Person): { m: Monster; d: number } | null {
  let best: Monster | null = null;
  let bestD = Infinity;
  for (const m of world.monsters) {
    if (m.state === "flee" || m.state === "lurk") {
      continue;
    }
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best ? { m: best, d: bestD } : null;
}

/**
 * Whether someone out of doors must drop what they are about and run: a
 * raider close by, and they not out to fight it (or one right upon them on
 * their way to shelter, or catching them up as they run).
 */
export function inDanger(world: World, p: Person): boolean {
  const t = p.task;
  if (p.inside >= 0 || world.monsters.length === 0 || t?.kind === "defend") {
    return false;
  }
  const threat = nearestRaider(world, p);
  if (!threat) {
    return false;
  }
  const reach = t?.kind === "flee" ? CAUGHT_UP : t?.kind === "shelter" ? CUT_OFF : FLEE_NEAR;
  return threat.d < reach;
}

/** Seconds, one person to the next, that people stay in after the all-clear before coming out. */
const LINGER = [2, 30] as const;

/** Staying under cover till the all-clear, and a little while after. */
export function hide(world: World): Step {
  return { t: "hide", linger: world.rng.range(LINGER[0], LINGER[1]) };
}

/** Ways round the compass looked at for running from raiders. */
const FLEE_WAYS = 16;
/** Meters within which raiders are reckoned with in choosing which way to run. */
const FLEE_HEED = 24;
/** Seconds ahead that a run is foreseen, and in what steps. */
const FLEE_FORESEE = 4;
const FLEE_FORESEE_STEP = 0.5;

/**
 * Where to run from raiders: of the ways open over the ground (not into the
 * river or through a house), the one that keeps farthest from every raider
 * near, as each goes on the way it is going. Null if no way is open.
 */
function fleeTo(world: World, p: Person): Point | null {
  const near: { m: Monster; vx: number; vy: number }[] = [];
  for (const m of world.monsters) {
    if (m.state !== "lurk" && Math.hypot(m.x - p.x, m.y - p.y) < FLEE_HEED) {
      const v = velocityOf(m);
      near.push({ m, vx: v.x, vy: v.y });
    }
  }
  let best: Point | null = null;
  let bestScore = -Infinity;
  for (let k = 0; k < FLEE_WAYS; k++) {
    const a = (k / FLEE_WAYS) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const x = Math.max(WORLD.x0 + 4, Math.min(WORLD.x1 - 4, p.x + ux * FLEE_RUN));
    const y = Math.max(WORLD.y0 + 4, Math.min(WORLD.y1 - 4, p.y + uy * FLEE_RUN));
    if (!world.nav.standable(x, y) || !world.nav.clear(p.x, p.y, x, y)) {
      continue;
    }
    // The closest any raider comes to them as they run this way.
    let closest = Infinity;
    for (let t = FLEE_FORESEE_STEP; t <= FLEE_FORESEE; t += FLEE_FORESEE_STEP) {
      const run = Math.min(RUN_SPEED * t, FLEE_RUN);
      const px = p.x + ux * run;
      const py = p.y + uy * run;
      for (const q of near) {
        closest = Math.min(closest, Math.hypot(q.m.x + q.vx * t - px, q.m.y + q.vy * t - py));
      }
    }
    if (closest > bestScore) {
      bestScore = closest;
      best = { x, y };
    }
  }
  return best;
}

/** Running from raiders: the way that keeps clearest of them first, then to shelter by a way clear of them. */
function flee(world: World, p: Person): Task {
  const to = fleeTo(world, p);
  const away: Step[] = to ? [{ t: "go", x: to.x, y: to.y, run: true }] : [];
  const x = to?.x ?? p.x;
  const y = to?.y ?? p.y;
  const refuge = world.council.shelterNear(world, x, y);
  if (!refuge) {
    return task("flee", [{ t: "carry", item: null }, ...away, hide(world)]);
  }
  const door = world.door(refuge);
  return task("flee", [
    { t: "carry", item: null },
    ...away,
    { t: "go", x: door.x, y: door.y, run: true, enter: refuge.id },
    hide(world),
  ]);
}

/** Running indoors from raiders, and staying in till the all-clear. */
function shelter(world: World, p: Person): Task {
  const safe = (b: Building | undefined): b is Building =>
    b !== undefined &&
    b.phase === "standing" &&
    b.fire <= 0.05 &&
    KINDS[b.kind].shelter &&
    !dangerAt(world, b.rect.x, b.rect.y);
  // Those already under a safe roof stay under it.
  const inside = p.inside >= 0 ? world.building(p.inside) : undefined;
  const home = homeOf(world, p);
  const best = safe(inside)
    ? inside
    : // Home, if it is near and the raiders are not at its door.
      safe(home) && Math.hypot(home.rect.x - p.x, home.rect.y - p.y) < 50
      ? home
      : world.council.shelterNear(world, p.x, p.y);
  if (!best) {
    return task("shelter", [
      { t: "go", x: world.plan.center.x, y: world.plan.center.y, run: true },
      hide(world),
    ]);
  }
  const d = world.door(best);
  return task("shelter", [
    { t: "carry", item: null },
    { t: "go", x: d.x, y: d.y, run: true, enter: best.id },
    hide(world),
  ]);
}

/** Meters out from what a raid came for, toward where it came from, that those out against it wait for it. */
const POST_OUT = 8;
/** Meters within which the guards and the wizard shoot rather than close in, and nearer than which they close in. */
const SHOOT_REACH = [4, 40] as const;
/** Meters within which they shoot at the dragon. */
const DRAGON_REACH = 60;
/** Seconds a shot takes to wind up, and speeds (m/s) of arrows and bolts, to aim ahead of what moves. */
const SHOT_WINDUP = 1.3;
const ARROW_SPEED = 30;

/**
 * Taking up arms. Those called out wait at the edge of the town on the
 * side the raiders come from, and meet them there when they come out of
 * the woods: a spear (a torch by night) at the nearest; the guards and the
 * wizard shoot at what they cannot reach, and at the dragon from their post.
 */
function defend(world: World, p: Person): Task {
  const arm = world.env.darkness > 0.5 ? "torch" : "spear";
  const dragon = world.dragon;
  const archer = p.job === "guard" || p.job === "wizard";
  const shot = (x: number, y: number, z: number, seconds: number): Task =>
    task("defend", [
      { t: "carry", item: archer ? (p.job === "wizard" ? "staff" : "spear") : arm },
      {
        t: "work",
        pose: p.job === "wizard" ? "cast" : "throw",
        seconds,
        fx: x,
        fy: y,
        act: { kind: "shoot", x, y, z, bolt: p.job === "wizard" },
      },
    ]);
  if (archer && dragon && dragon.phase !== "leave") {
    const d = Math.hypot(dragon.x - p.x, dragon.y - p.y);
    if (d < DRAGON_REACH) {
      const lead = SHOT_WINDUP + Math.hypot(d, dragon.z - p.z) / ARROW_SPEED;
      const at = dragonAt(world, lead) ?? dragon;
      return shot(at.x, at.y, at.z, SHOT_WINDUP);
    }
  }
  // Raiders come out of the woods, on dry land.
  let target: Monster | null = null;
  let best = Infinity;
  for (const m of world.monsters) {
    if (m.state === "flee" || m.state === "lurk" || world.terrain.isWater(m.x, m.y)) {
      continue;
    }
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d < best) {
      best = d;
      target = m;
    }
  }
  if (!target) {
    if (dragon && !archer) {
      return shelter(world, p);
    }
    // Waiting for them where they will come, or (for the dragon) on the square under the sky.
    const raid = world.raids.active;
    let post: Point = world.plan.center;
    if (raid && !dragon) {
      const dx = raid.from.x - raid.toward.x;
      const dy = raid.from.y - raid.toward.y;
      const dl = Math.hypot(dx, dy) || 1;
      post = { x: raid.toward.x + (dx / dl) * POST_OUT, y: raid.toward.y + (dy / dl) * POST_OUT };
    }
    const q = near(world, post, 5);
    return task("defend", [
      { t: "carry", item: archer ? (p.job === "wizard" ? "staff" : "spear") : arm },
      { t: "go", x: q.x, y: q.y, run: true },
      { t: "wait", seconds: 2 },
    ]);
  }
  if (archer && best < SHOOT_REACH[1] && best > SHOOT_REACH[0]) {
    // Ahead of where it is going.
    const v = velocityOf(target);
    const lead = SHOT_WINDUP + best / ARROW_SPEED;
    return shot(target.x + v.x * lead, target.y + v.y * lead, target.z + 0.8, SHOT_WINDUP);
  }
  const steps: Step[] = [{ t: "carry", item: arm }];
  if (best > 1.6) {
    // Up to it, as near as the dry ground goes, and a stab or two.
    let stop = Math.max(0, best - 1.3);
    const ux = (target.x - p.x) / best;
    const uy = (target.y - p.y) / best;
    while (stop > 0 && !world.nav.standable(p.x + ux * stop, p.y + uy * stop)) {
      stop -= 1;
    }
    if (stop > 0) {
      steps.push({ t: "go", x: p.x + ux * stop, y: p.y + uy * stop, run: true, direct: true });
    }
  }
  steps.push({
    t: "work",
    pose: "thrust",
    seconds: 1.1,
    fx: target.x,
    fy: target.y,
    act: { kind: "strike", monster: target.id },
  });
  return task("defend", steps);
}

/** Most who throw buckets on one fire at a time. */
const FIREFIGHTERS = 8;
/** Meters the dragon must be from a fire before anyone goes out to it. */
const DRAGON_CLEAR = 40;

/** Buckets to a fire: from the nearest well or the river to the burning building, and again. */
function fightFire(world: World, p: Person): Task | null {
  let fire: Building | null = null;
  let best = 110;
  const dragon = world.dragon;
  for (const b of world.town.buildings) {
    if (b.fire <= 0.03 || b.phase === "ruin" || busy(world, `firefight-${b.id}`) >= FIREFIGHTERS) {
      continue;
    }
    // Not while raiders are still about it, nor with the dragon overhead.
    if (
      world.monsters.some(
        (m) => m.state !== "flee" && Math.hypot(m.x - b.rect.x, m.y - b.rect.y) < 14,
      ) ||
      (dragon && Math.hypot(dragon.x - b.rect.x, dragon.y - b.rect.y) < DRAGON_CLEAR)
    ) {
      continue;
    }
    const d = Math.hypot(b.rect.x - p.x, b.rect.y - p.y);
    if (d < best) {
      best = d;
      fire = b;
    }
  }
  if (!fire) {
    return null;
  }
  const water = world.council.waterNear(world, fire.rect.x, fire.rect.y);
  const spot = besideBuilding(world, fire);
  return task(`firefight-${fire.id}`, [
    { t: "carry", item: null },
    { t: "go", x: water.x, y: water.y, run: true },
    { t: "work", pose: "dig", seconds: 1.4, sound: "bucket", every: 5 },
    { t: "carry", item: "bucket" },
    { t: "go", x: spot.x, y: spot.y, run: true },
    {
      t: "work",
      pose: "throw",
      seconds: 1.2,
      fx: fire.rect.x,
      fy: fire.rect.y,
      act: { kind: "douse", building: fire.id },
      sound: "splash",
      every: 5,
    },
    {
      t: "work",
      pose: "throw",
      seconds: 3,
      fx: fire.rect.x,
      fy: fire.rect.y,
      act: { kind: "douse", building: fire.id },
    },
    { t: "carry", item: null },
  ]);
}

/** A rest-day service at the chapel or church. */
function worship(world: World, p: Person): Task {
  const church = world.council.worship();
  if (!church) {
    return leisure(world, p);
  }
  const d = world.door(church);
  return task("worship", [
    { t: "carry", item: null },
    { t: "go", x: d.x, y: d.y, enter: church.id },
    { t: "stay", until: at(world, 11 + world.rng.range(0, 0.3)) },
  ]);
}

/** Children: play about the square and the lanes, fetch water, run home when called. */
function childTask(world: World, p: Person): Task {
  const r = world.rng;
  const home = homeOf(world, p);
  const base = home ? world.door(home) : world.plan.center;
  if (r.chance(0.15) && world.council.wells.length > 0) {
    const well = world.council.waterNear(world, base.x, base.y);
    return task("water", [
      { t: "go", x: well.x, y: well.y },
      { t: "work", pose: "dig", seconds: 3, sound: "bucket", every: 3 },
      { t: "carry", item: "bucket" },
      { t: "go", x: base.x, y: base.y },
      { t: "carry", item: null },
    ]);
  }
  const hub = r.chance(0.5) ? world.plan.center : base;
  const steps: Step[] = [];
  for (let k = 0; k < 4; k++) {
    const q = near(world, hub, 9);
    steps.push({ t: "go", x: q.x, y: q.y, run: r.chance(0.6), direct: true });
    steps.push({ t: "wait", seconds: r.range(0.5, 3), pose: r.chance(0.3) ? "dance" : "stand" });
  }
  return task("play", steps);
}

/** The old: a seat in the sun by the door or on the square, a slow walk. */
function elderTask(world: World, p: Person): Task {
  const r = world.rng;
  const home = homeOf(world, p);
  const base = home ? world.door(home) : world.plan.center;
  if (r.chance(0.35)) {
    const q = near(world, world.plan.center, 10);
    return task("stroll", [
      { t: "go", x: q.x, y: q.y },
      { t: "wait", seconds: r.range(10, 30), pose: "stand" },
    ]);
  }
  const seat = near(world, base, 1.5);
  return task("rest", [
    { t: "go", x: seat.x, y: seat.y, direct: true },
    { t: "wait", seconds: r.range(30, 70), pose: "sit" },
  ]);
}

/**
 * An evening, or a day of rest: the tavern, the square on market days, a
 * word at a neighbor's, or home.
 */
function leisure(world: World, p: Person): Task {
  const r = world.rng;
  const h = hour(world);
  const tavern = world.council.tavern();
  if (tavern && h > 17.5 && r.chance(0.35)) {
    const d = world.door(tavern);
    return task("tavern", [
      { t: "carry", item: null },
      { t: "go", x: d.x, y: d.y, enter: tavern.id },
      {
        t: "stay",
        until: Math.min(at(world, BEDTIME), world.env.clock.days + r.range(0.04, 0.09)),
      },
    ]);
  }
  if ((isMarketDay(world) || isRestDay(world)) && h > 8 && h < 16 && r.chance(0.6)) {
    const q = near(world, world.plan.center, world.plan.square.radius - 1);
    return task("market", [
      { t: "carry", item: r.chance(0.3) ? "basket" : null },
      { t: "go", x: q.x, y: q.y },
      { t: "wait", seconds: r.range(15, 40) },
    ]);
  }
  const home = homeOf(world, p);
  // Once it is dark most are in by their hearths.
  if (home && r.chance(world.env.darkness > 0.3 ? 0.88 : 0.6)) {
    const d = world.door(home);
    return task("home", [
      { t: "carry", item: null },
      { t: "go", x: d.x, y: d.y, enter: home.id },
      { t: "stay", until: world.env.clock.days + r.range(0.02, 0.06) },
    ]);
  }
  const q = near(world, home ? world.door(home) : world.plan.center, 12);
  return task("idle", [
    { t: "go", x: q.x, y: q.y },
    { t: "wait", seconds: r.range(8, 25) },
  ]);
}

/** The day's work of someone's trade; null if there is none to do today. */
function jobTask(world: World, p: Person): Task | null {
  // Food first when the stores run low: into the woods for what grows there, or down to the river to fish.
  const gathering = busy(world, "forage") + busy(world, "fish");
  if (
    world.stock.food < world.people.length * 1.5 &&
    gathering < world.people.length * 0.15 &&
    (p.job === "hauler" || p.job === "idle" || p.job === "farmer")
  ) {
    const food = forage(world, p);
    if (food) {
      return food;
    }
  }
  // In a hamlet everyone turns their hand to whatever most wants doing.
  if (
    world.people.length < HAMLET &&
    (p.job === "hauler" || p.job === "builder" || p.job === "woodcutter" || p.job === "idle")
  ) {
    return (
      build(world, p) ??
      supply(world, p) ??
      clearGround(world, p) ??
      farm(world, p) ??
      tidy(world, p) ??
      cutWood(world, p)
    );
  }
  switch (p.job) {
    case "builder":
      return build(world, p) ?? supply(world, p) ?? clearGround(world, p) ?? tidy(world, p);
    case "woodcutter":
      return clearGround(world, p) ?? cutWood(world, p) ?? haul(world, p);
    case "farmer":
      return (
        farm(world, p) ??
        clearGround(world, p) ??
        haul(world, p) ??
        build(world, p) ??
        cutWood(world, p)
      );
    case "hauler":
      return haul(world, p) ?? clearGround(world, p) ?? build(world, p) ?? cutWood(world, p);
    case "quarrier":
      return quarry(world, p) ?? haul(world, p) ?? cutWood(world, p);
    case "smith":
      return atWork(world, "smithy", "hammer", "anvil", 0.75) ?? haul(world, p);
    case "baker":
      return bake(world) ?? haul(world, p);
    case "innkeeper":
      return atWork(world, "tavern", null, null, 0) ?? haul(world, p);
    case "miller":
      return (
        atWork(world, "watermill", null, null, 0) ??
        atWork(world, "windmill", null, null, 0) ??
        haul(world, p)
      );
    case "priest":
      return priest(world, p);
    case "guard":
      return guard(world);
    case "shepherd":
      return tendFlock(world) ?? haul(world, p);
    case "wizard":
      return wizard(world);
    case "idle":
      return supply(world, p) ?? clearGround(world, p) ?? tidy(world, p);
  }
}

/** Seconds of building a builder wants waiting at a site before walking there. */
const LEAST_WORK = 15;
/** More hands than usual that set to clearing, repairing and raising again what a raid or a fire brought down. */
const MENDING_HANDS = 6;

/** Builders: up the walls of whatever is going up; taking down, repairing, clearing ruins, paving. */
function build(world: World, p: Person): Task | null {
  const r = world.rng;
  let site: Building | null = null;
  let best = Infinity;
  for (const b of world.town.buildings) {
    const kind =
      b.phase === "building" && workable(b)
        ? "build"
        : b.phase === "demolish"
          ? "demolish"
          : b.phase === "ruin" && b.fire <= 0.02
            ? "clear"
            : b.phase === "standing" && b.fire <= 0.02 && (b.damage > 0.05 || b.char > 0.1)
              ? "repair"
              : null;
    if (!kind) {
      continue;
    }
    const crew = busy(world, `${kind}-${b.id}`);
    const mending = kind === "clear" || kind === "repair" || b.rebuilding;
    const room = 2 + Math.floor(KINDS[b.kind].labor / 120) + (mending ? MENDING_HANDS : 0);
    if (crew >= room) {
      continue;
    }
    // Not worth the walk for a moment's work before the materials run out, unless that finishes it.
    if (kind === "build") {
      const labor = KINDS[b.kind].labor;
      const share = ((buildable(b) - b.progress) * labor * TOIL) / (crew + 1);
      if (buildable(b) < 1 && share < LEAST_WORK) {
        continue;
      }
    }
    const d = Math.hypot(b.rect.x - p.x, b.rect.y - p.y) + crew * 20 + (mending ? -30 : 0);
    if (d < best) {
      best = d;
      site = b;
    }
  }
  if (site) {
    const kind =
      site.phase === "building"
        ? "build"
        : site.phase === "demolish"
          ? "demolish"
          : site.phase === "ruin"
            ? "clear"
            : "repair";
    const spot = besideBuilding(world, site, kind === "build");
    const stone = KINDS[site.kind].stone > KINDS[site.kind].wood;
    const pose = kind === "clear" ? "dig" : stone ? "chisel" : r.chance(0.3) ? "saw" : "hammer";
    const sound =
      pose === "dig" ? "dig" : pose === "chisel" ? "chisel" : pose === "saw" ? "saw" : "hammer";
    const act =
      kind === "build"
        ? { kind: "build" as const, building: site.id }
        : kind === "demolish"
          ? { kind: "demolish" as const, building: site.id }
          : kind === "clear"
            ? { kind: "clear" as const, building: site.id }
            : { kind: "repair" as const, building: site.id };
    const steps: Step[] = [
      { t: "carry", item: null },
      { t: "go", x: spot.x, y: spot.y },
    ];
    // A few bouts of work with a breather between, a stretch or a look at how it goes.
    const bouts = r.int(3, 5);
    for (let k = 0; k < bouts; k++) {
      if (k > 0) {
        steps.push({ t: "wait", seconds: r.range(2, 5) });
      }
      steps.push({
        t: "work",
        pose,
        seconds: r.range(9, 15),
        fx: site.rect.x,
        fy: site.rect.y,
        act,
        sound,
        every: pose === "saw" ? 1.1 : pose === "dig" ? 1.2 : pose === "chisel" ? 0.55 : 0.5,
        lift: spot.lift,
      });
    }
    return task(`${kind}-${site.id}`, steps);
  }
  const paving = world.council.paving;
  if (paving && busy(world, `pave-${paving.street}`) < 3) {
    const spot = world.council.paveSpot(world);
    if (spot) {
      return task(`pave-${paving.street}`, [
        { t: "go", x: spot.x, y: spot.y },
        {
          t: "work",
          pose: "dig",
          seconds: r.range(15, 25),
          act: { kind: "pave", street: paving.street },
          sound: "chisel",
          every: 0.9,
        },
      ]);
    }
  }
  const pasture = world.council.pastureToFence(world);
  if (pasture !== null && busy(world, `fence-${pasture}`) < 2) {
    // At the end of the fence as it goes up round the pasture from the gate.
    const run = fenceRun(world.plan, world.plan.pastures[pasture]);
    const front =
      fenceBuilt(world, pasture) * run.length + busy(world, `fence-${pasture}`) * 2.5 + 1;
    const post = alongFence(run, front);
    const next = alongFence(run, front + 1);
    return task(`fence-${pasture}`, [
      { t: "carry", item: "plank" },
      { t: "go", x: post.x, y: post.y },
      { t: "carry", item: null },
      {
        t: "work",
        pose: "hammer",
        seconds: r.range(40, 60),
        fx: next.x,
        fy: next.y,
        act: { kind: "fence", pasture },
        sound: "hammer",
        every: 0.7,
      },
    ]);
  }
  return null;
}

/** Logs or stones still free to take from a pile. */
function free(world: World, pile: { id: number; count: number }): number {
  return pile.count - (world.council.claims.get(pile.id) ?? 0);
}

/** Hauling: logs and stones out to where building goes on, felled logs in to the yard. */
function haul(world: World, p: Person): Task | null {
  if (world.cartOf(p)) {
    return cart(world, p);
  }
  // With logs lying all about, some go to tidying them into the yard first.
  if (world.piles.length > 8 && world.rng.chance(0.3)) {
    return tidy(world, p) ?? supply(world, p);
  }
  return supply(world, p) ?? tidy(world, p);
}

/** Logs or stones out to a building site that wants them, from where they lie nearest: a pile or the yard. */
function supply(world: World, p: Person): Task | null {
  if (world.cartOf(p)) {
    return cart(world, p);
  }
  const r = world.rng;
  let plan: {
    site: Building;
    stuff: "wood" | "stone";
    pile: number;
    x: number;
    y: number;
    two: boolean;
  } | null = null;
  let best = Infinity;
  for (const b of world.town.buildings) {
    if (b.phase !== "building" && b.phase !== "clearing") {
      continue;
    }
    const need = wants(b);
    for (const s of ["wood", "stone"] as const) {
      const coming =
        busy(world, `haul-${s}-${b.id}`) * (s === "wood" ? 2 : 1) +
        busy(world, `cart-${s}-${b.id}`) * CARTLOAD;
      const short = need[s] - coming;
      if (short <= 0) {
        continue;
      }
      const consider = (x: number, y: number, pile: number, available: number) => {
        const cost =
          Math.hypot(x - p.x, y - p.y) + Math.hypot(b.rect.x - x, b.rect.y - y) + coming * 12;
        if (cost < best) {
          best = cost;
          plan = {
            site: b,
            stuff: s,
            pile,
            x,
            y,
            two: s === "wood" && short >= 2 && available >= 2,
          };
        }
      };
      if (world.stock[s] >= 1) {
        const depot = world.depot(s);
        consider(depot.x, depot.y, -1, Math.floor(world.stock[s]));
      }
      for (const q of world.piles) {
        if ((q.kind === "logs") === (s === "wood") && free(world, q) >= 1) {
          consider(q.x, q.y, q.id, free(world, q));
        }
      }
    }
  }
  if (plan) {
    const { site, stuff, pile, x, y, two } = plan as {
      site: Building;
      stuff: "wood" | "stone";
      pile: number;
      x: number;
      y: number;
      two: boolean;
    };
    const spot = besideBuilding(world, site);
    const t = task(`haul-${stuff}-${site.id}`, [
      { t: "carry", item: null },
      { t: "go", x: x + r.range(-0.8, 0.8), y: y + r.range(-0.8, 0.8) },
      { t: "wait", seconds: 0.8, pose: "dig" },
      {
        t: "do",
        effect:
          pile >= 0
            ? { kind: "takePile", pile, count: two ? 2 : 1 }
            : { kind: "take", stuff, count: two ? 2 : 1 },
      },
      { t: "go", x: spot.x, y: spot.y },
      { t: "do", effect: { kind: "deliver", building: site.id, stuff } },
    ]);
    if (pile >= 0) {
      t.claim = pile;
    }
    return t;
  }
  return null;
}

/** Felled logs or quarried stones lying where they were left: in to the yard. */
function tidy(world: World, p: Person): Task | null {
  const r = world.rng;
  let pile = null;
  let best = Infinity;
  for (const q of world.piles) {
    if (free(world, q) < 1) {
      continue;
    }
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best) {
      best = d;
      pile = q;
    }
  }
  if (pile) {
    const wood = pile.kind === "logs";
    const depot = world.depot(wood ? "wood" : "stone");
    const t = task(`pile-${pile.id}`, [
      { t: "carry", item: null },
      { t: "go", x: pile.x + r.range(-0.6, 0.6), y: pile.y + r.range(-0.6, 0.6) },
      { t: "wait", seconds: 1, pose: "dig" },
      { t: "do", effect: { kind: "takePile", pile: pile.id, count: 2 } },
      { t: "go", x: depot.x + r.range(-1.2, 1.2), y: depot.y + r.range(-1, 1) },
      { t: "do", effect: { kind: "stock", stuff: wood ? "wood" : "stone", amount: 1 } },
    ]);
    t.claim = pile.id;
    return t;
  }
  return null;
}

/**
 * A carter: a cartload of logs or stones out to a building site, loaded at
 * the yard or where the trees were felled, the ox plodding alongside; with
 * nothing wanted, a heap of felled logs brought in to the yard.
 */
function cart(world: World, p: Person): Task | null {
  const r = world.rng;
  const ox = world.cartOf(p);
  // A load left on the cart (the alarm cut the last trip short) goes out first.
  const loaded =
    ox && ox.load > 0 && ox.cargo !== "sacks" ? (ox.cargo === "stones" ? "stone" : "wood") : null;
  // Where to load (a pile, or -1 for the yard) and where to take it, for the fewest steps per log.
  let plan: {
    site: Building | null;
    stuff: "wood" | "stone";
    pile: number;
    x: number;
    y: number;
    count: number;
  } | null = null;
  let best = Infinity;
  for (const b of world.town.buildings) {
    if (b.phase !== "building" && b.phase !== "clearing") {
      continue;
    }
    const need = wants(b);
    for (const s of ["wood", "stone"] as const) {
      if (loaded && s !== loaded) {
        continue;
      }
      const coming =
        busy(world, `haul-${s}-${b.id}`) * 2 + busy(world, `cart-${s}-${b.id}`) * CARTLOAD;
      const short = need[s] - coming;
      if (short < (loaded ? 1 : CART_LEAST)) {
        continue;
      }
      const consider = (x: number, y: number, pile: number, available: number) => {
        const count = Math.min(CARTLOAD, short, available);
        if (count < (loaded ? 1 : CART_LEAST)) {
          return;
        }
        const cost =
          (Math.hypot(x - p.x, y - p.y) + Math.hypot(b.rect.x - x, b.rect.y - y)) / count;
        if (cost < best) {
          best = cost;
          plan = { site: b, stuff: s, pile, x, y, count };
        }
      };
      if (loaded) {
        consider(p.x, p.y, -1, ox!.load);
        continue;
      }
      const depot = world.depot(s);
      consider(depot.x, depot.y, -1, Math.floor(world.stock[s]));
      for (const q of world.piles) {
        if ((q.kind === "logs") === (s === "wood") && q.kind !== "brush") {
          consider(q.x, q.y, q.id, free(world, q));
        }
      }
    }
  }
  // Nothing wanted out at the sites: felled logs in to the yard by the cartload, or what is left on the cart.
  if (!plan) {
    let most = loaded ? 0 : CART_LEAST - 1;
    for (const q of loaded ? [] : world.piles) {
      const n = Math.min(CARTLOAD, free(world, q));
      if (q.kind !== "brush" && n > most) {
        most = n;
        plan = {
          site: null,
          stuff: q.kind === "logs" ? "wood" : "stone",
          pile: q.id,
          x: q.x,
          y: q.y,
          count: n,
        };
      }
    }
    if (loaded) {
      plan = { site: null, stuff: loaded, pile: -1, x: p.x, y: p.y, count: 0 };
    }
  }
  if (!plan) {
    return null;
  }
  const { site, stuff, pile, x, y, count } = plan as {
    site: Building | null;
    stuff: "wood" | "stone";
    pile: number;
    x: number;
    y: number;
    count: number;
  };
  const steps: Step[] = [{ t: "carry", item: null }];
  if (!loaded) {
    const at = pile >= 0 ? { x, y } : { x: x + r.range(-1.5, 1.5), y: y - 2 };
    steps.push(
      { t: "go", x: at.x, y: at.y },
      { t: "wait", seconds: 3, pose: "dig" },
      {
        t: "do",
        effect:
          pile >= 0 ? { kind: "loadCart", stuff, count, pile } : { kind: "loadCart", stuff, count },
      },
    );
  }
  if (site) {
    // The rest of the load to sites close by that want the same.
    const drops: { b: Building; n: number }[] = [
      { b: site, n: Math.min(count, wants(site)[stuff]) },
    ];
    let left = count - drops[0].n;
    let room = loaded ? 0 : CARTLOAD - count;
    const available =
      pile >= 0
        ? free(
            world,
            world.piles.find((q) => q.id === pile)!,
          )
        : Math.floor(world.stock[stuff]);
    room = Math.min(room, available - count);
    let from = site;
    while (drops.length < 3 && (left > 0 || room > 0)) {
      let next: Building | null = null;
      let nearest = NEXT_DROP;
      for (const b of world.town.buildings) {
        if ((b.phase !== "building" && b.phase !== "clearing") || drops.some((d) => d.b === b)) {
          continue;
        }
        const short =
          wants(b)[stuff] -
          busy(world, `haul-${stuff}-${b.id}`) -
          busy(world, `cart-${stuff}-${b.id}`) * CARTLOAD;
        const d = Math.hypot(b.rect.x - from.rect.x, b.rect.y - from.rect.y);
        if (short > 0 && d < nearest) {
          nearest = d;
          next = b;
        }
      }
      if (!next) {
        break;
      }
      const short = wants(next)[stuff] - busy(world, `haul-${stuff}-${next.id}`);
      const n = Math.min(short, left + room);
      drops.push({ b: next, n });
      const fromLoad = Math.min(left, n);
      left -= fromLoad;
      room -= n - fromLoad;
      from = next;
    }
    if (!loaded) {
      const total = drops.reduce((s, d) => s + d.n, 0);
      const load = steps[steps.length - 1];
      if (load.t === "do" && load.effect.kind === "loadCart") {
        load.effect.count = Math.max(load.effect.count, Math.min(CARTLOAD, total));
      }
    }
    for (const [i, { b, n }] of drops.entries()) {
      const spot = besideBuilding(world, b);
      steps.push(
        { t: "go", x: spot.x, y: spot.y },
        { t: "wait", seconds: 3, pose: "dig" },
        {
          t: "do",
          effect: {
            kind: "unloadCart",
            building: b.id,
            count: i === drops.length - 1 ? undefined : n,
          },
        },
      );
    }
  } else {
    const depot = world.depot(stuff);
    steps.push(
      { t: "go", x: depot.x + r.range(-1.5, 1.5), y: depot.y - 2 },
      { t: "wait", seconds: 3, pose: "dig" },
      { t: "do", effect: { kind: "unloadCart", building: -1 } },
    );
  }
  const t = task(site ? `cart-${stuff}-${site.id}` : "cart-home", steps);
  if (pile >= 0) {
    const load = steps.find((s) => s.t === "do" && s.effect.kind === "loadCart");
    t.claim = pile;
    t.claimCount = load?.t === "do" && load.effect.kind === "loadCart" ? load.effect.count : count;
  }
  return t;
}

/** Farthest (m) a cart goes on from one site to the next to drop the rest of its load. */
const NEXT_DROP = 30;

/** Fewest logs or stones worth a trip with the cart. */
const CART_LEAST = 2;

/** Logs or stones a cart carries. */
const CARTLOAD = 6;

/** Clearing ground for what is to be built or sown: felling the trees on it, grubbing the stumps. */
function clearGround(world: World, p: Person): Task | null {
  const r = world.rng;
  const forest = world.forest;
  const wanted = world.council.treesToClear(world);
  let tree = null;
  let best = Infinity;
  for (const id of wanted) {
    const t = forest.trees[id];
    const state = forest.state[id];
    if (state !== STANDING && state !== STUMP) {
      continue;
    }
    if (busy(world, `tree-${id}`) > 0) {
      continue;
    }
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d < best) {
      best = d;
      tree = t;
    }
  }
  if (!tree) {
    return null;
  }
  const first = fellOrGrub(world, tree.id, false);
  // And on to the next ones close by, while here.
  const around = wanted.filter((id) => {
    const t = forest.trees[id];
    const state = forest.state[id];
    return (
      id !== tree.id &&
      (state === STANDING || state === STUMP) &&
      busy(world, `tree-${id}`) === 0 &&
      Math.hypot(t.x - tree.x, t.y - tree.y) < 9
    );
  });
  let last = tree.id;
  for (const id of around.slice(0, 2)) {
    first.steps.push(...fellOrGrub(world, id, false).steps.slice(1));
    last = id;
  }
  // Sometimes a log back to the yard at the end of it.
  if (forest.state[last] === STANDING && r.chance(0.5)) {
    first.steps.push(...fellOrGrub(world, last, true).steps.slice(-4));
  }
  return first;
}

/** Felling one tree (and carrying a log home), or grubbing up its stump. */
function fellOrGrub(world: World, id: number, carryHome: boolean): Task {
  const r = world.rng;
  const t = world.forest.trees[id];
  const c = world.plan.center;
  // Stand on the town side of the trunk.
  const a = Math.atan2(c.y - t.y, c.x - t.x) + r.range(-0.6, 0.6);
  const spot = { x: t.x + Math.cos(a) * 1.1, y: t.y + Math.sin(a) * 1.1 };
  if (world.forest.state[id] === STUMP) {
    return task(`tree-${id}`, [
      { t: "carry", item: null },
      { t: "go", x: spot.x, y: spot.y },
      {
        t: "work",
        pose: "dig",
        seconds: r.range(6, 9),
        fx: t.x,
        fy: t.y,
        act: { kind: "grub", tree: id },
        sound: "dig",
        every: 1.1,
      },
    ]);
  }
  const depot = world.depot("wood");
  const steps: Step[] = [
    { t: "carry", item: null },
    { t: "go", x: spot.x, y: spot.y },
    {
      t: "work",
      pose: "chop",
      seconds: r.range(9, 13),
      fx: t.x,
      fy: t.y,
      act: { kind: "fell", tree: id },
      sound: "chop",
      every: 0.62,
    },
    { t: "wait", seconds: 1.5 },
  ];
  if (carryHome) {
    steps.push(
      { t: "work", pose: "chop", seconds: 4, fx: t.x, fy: t.y, sound: "chop", every: 0.62 },
      { t: "do", effect: { kind: "takeNear", x: t.x, y: t.y } },
      { t: "go", x: depot.x + r.range(-1, 1), y: depot.y + r.range(-1, 1) },
      { t: "do", effect: { kind: "stock", stuff: "wood", amount: 1 } },
    );
  }
  return task(`tree-${id}`, steps);
}

/** Cutting wood for the stock when there is none to clear: at the edge of the woods near the yard. */
function cutWood(world: World, p: Person): Task | null {
  // Logs lying where trees fell count as wood at hand.
  let lying = 0;
  for (const q of world.piles) {
    if (q.kind === "logs") {
      lying += q.count;
    }
  }
  // No more felling while plenty lies waiting to be carried.
  if (lying >= 16 || world.stock.wood + lying > world.council.woodWanted(world)) {
    return null;
  }
  const id = world.council.loggingTree(world, p);
  return id === null ? null : fellOrGrub(world, id, true);
}

/** Farm work by the season: breaking new ground, plowing and sowing, reaping and bringing in. */
function farm(world: World, p: Person): Task | null {
  const r = world.rng;
  let field = -1;
  let best = Infinity;
  for (const id of world.council.openFields) {
    const need = fieldNeeds(world, id);
    if (!need) {
      continue;
    }
    const crew = busy(world, `field-${id}`);
    if (crew >= 3) {
      continue;
    }
    const f = world.plan.fields[id].rect;
    const d = Math.hypot(f.x - p.x, f.y - p.y) + crew * 25;
    if (d < best) {
      best = d;
      field = id;
    }
  }
  if (field < 0) {
    return null;
  }
  const need = fieldNeeds(world, field);
  const rect = world.plan.fields[field].rect;
  const steps: Step[] = [{ t: "carry", item: null }];
  // Work along a strip of the field, a few steps at a time.
  const across = r.range(-0.42, 0.42) * rect.width;
  let back = r.range(-0.45, 0.2) * rect.depth;
  for (let k = 0; k < 6; k++) {
    const q = rectPoint(rect, across, back);
    back = Math.min(rect.depth * 0.45, back + r.range(2, 4));
    const ahead = rectPoint(rect, across, back);
    steps.push({ t: "go", x: q.x, y: q.y, direct: k > 0 });
    if (need === "reap") {
      steps.push({
        t: "work",
        pose: "reap",
        seconds: r.range(5, 8),
        fx: ahead.x,
        fy: ahead.y,
        act: { kind: "reap", field },
        sound: "reap",
        every: 1.1,
      });
    } else {
      const sow = need === "sow" && k % 2 === 1;
      steps.push({
        t: "work",
        pose: sow ? "sow" : "hoe",
        seconds: r.range(5, 8),
        fx: ahead.x,
        fy: ahead.y,
        act: { kind: "plow", field },
        sound: sow ? undefined : "hoe",
        every: 0.95,
      });
    }
  }
  if (need === "reap") {
    // A sheaf in to the barn, or the yard.
    const barn = world.town.buildings.find((b) => b.kind === "barn" && b.phase === "standing");
    const to = barn ? world.door(barn) : world.depot("wood");
    steps.push(
      { t: "carry", item: "sheaf" },
      { t: "go", x: to.x, y: to.y },
      { t: "do", effect: { kind: "sheaves", field } },
    );
  }
  return task(`field-${field}`, steps);
}

/**
 * Food from the land: berries, nuts and mushrooms gathered at the edge of the
 * woods, or fish from the river.
 */
function forage(world: World, p: Person): Task | null {
  const r = world.rng;
  const store = world.depot("wood");
  if (r.chance(0.5)) {
    const bank = world.council.riverbank(world, p);
    return task("fish", [
      { t: "carry", item: "rod" },
      { t: "go", x: bank.x, y: bank.y },
      {
        t: "work",
        pose: "fish",
        seconds: r.range(25, 45),
        fx: world.terrain.riverX(bank.y),
        fy: bank.y,
      },
      { t: "carry", item: "basket" },
      { t: "go", x: store.x, y: store.y },
      { t: "do", effect: { kind: "stock", stuff: "food", amount: 3 } },
    ]);
  }
  const edge = world.council.woodsEdge(world, p);
  if (!edge) {
    return null;
  }
  return task("forage", [
    { t: "carry", item: "basket" },
    { t: "go", x: edge.x, y: edge.y },
    { t: "work", pose: "dig", seconds: r.range(15, 25) },
    { t: "go", x: edge.x + r.range(-6, 6), y: edge.y + r.range(-6, 6), direct: true },
    { t: "work", pose: "dig", seconds: r.range(10, 20) },
    { t: "go", x: store.x, y: store.y },
    { t: "do", effect: { kind: "stock", stuff: "food", amount: 3 } },
  ]);
}

/** Out to the pasture with the flock, a staff in hand, and a while watching over them. */
function tendFlock(world: World): Task | null {
  const pastures = world.plan.pastures.filter((q) => world.town.pastures[q.id].fenced);
  if (pastures.length === 0) {
    return null;
  }
  const r = world.rng;
  const q = r.pick(pastures).rect;
  const spot = rectPoint(q, r.range(-0.4, 0.4) * q.width, r.range(-0.4, 0.4) * q.depth);
  return task("flock", [
    { t: "carry", item: "staff" },
    { t: "go", x: spot.x, y: spot.y },
    { t: "wait", seconds: r.range(25, 50) },
    { t: "carry", item: null },
  ]);
}

/** Stones kept in the yard beyond what is wanted, once there is a quarry to cut them. */
const STONE_RESERVE = 40;

/** Quarrying at the quarry; before there is one, picking stones off the river's banks. */
function quarry(world: World, p: Person): Task | null {
  const r = world.rng;
  const q = world.town.buildings.find((b) => b.kind === "quarry" && b.phase === "standing");
  if (q && world.stock.stone >= world.council.stoneWanted(world) + STONE_RESERVE) {
    return null;
  }
  if (q) {
    const spot = rectPoint(
      q.rect,
      r.range(-0.38, 0.38) * q.rect.width,
      q.rect.depth * 0.5 - r.range(3, 4.4),
    );
    return task("quarry", [
      { t: "carry", item: null },
      { t: "go", x: spot.x, y: spot.y },
      {
        t: "work",
        pose: "chisel",
        seconds: r.range(45, 70),
        fx: spot.x,
        fy: spot.y + 2,
        act: { kind: "quarry" },
        sound: "chisel",
        every: 0.5,
      },
    ]);
  }
  if (world.stock.stone >= world.council.stoneWanted(world)) {
    return null;
  }
  const bank = world.council.riverbank(world, p);
  const depot = world.depot("stone");
  return task("stones", [
    { t: "carry", item: null },
    { t: "go", x: bank.x, y: bank.y },
    { t: "work", pose: "dig", seconds: r.range(8, 14), sound: "stones", every: 3 },
    { t: "carry", item: "stone" },
    { t: "go", x: depot.x, y: depot.y },
    { t: "do", effect: { kind: "stock", stuff: "stone", amount: 2 } },
  ]);
}

/** A day at one's own workplace: working in front of it with its sound, or inside. */
function atWork(
  world: World,
  kind: Building["kind"],
  pose: "hammer" | null,
  sound: "anvil" | null,
  every: number,
): Task | null {
  const b = world.council.place(world, kind);
  if (!b) {
    return null;
  }
  const r = world.rng;
  const d = world.door(b);
  if (pose && sound && r.chance(0.7)) {
    const spot = rectPoint(b.rect, r.range(-0.2, 0.2) * b.rect.width, -b.rect.depth / 2 + 1.2);
    return task(`work-${b.id}`, [
      { t: "carry", item: null },
      { t: "go", x: d.x, y: d.y },
      { t: "go", x: spot.x, y: spot.y, direct: true },
      {
        t: "work",
        pose,
        seconds: r.range(20, 40),
        fx: b.rect.x,
        fy: b.rect.y,
        act: { kind: "craft" },
        sound,
        every,
      },
    ]);
  }
  return task(`work-${b.id}`, [
    { t: "carry", item: null },
    { t: "go", x: d.x, y: d.y, enter: b.id },
    { t: "stay", until: world.env.clock.days + r.range(0.04, 0.08) },
  ]);
}

/** The baker: at the ovens before dawn, then bread to the square. */
function bake(world: World): Task | null {
  const b = world.council.place(world, "bakery");
  if (!b) {
    return null;
  }
  const r = world.rng;
  if (hour(world) < 10 || r.chance(0.5)) {
    return atWork(world, "bakery", null, null, 0);
  }
  const q = near(world, world.plan.center, world.plan.square.radius - 2);
  const d = world.door(b);
  return task(`work-${b.id}`, [
    { t: "go", x: d.x, y: d.y },
    { t: "carry", item: "bread" },
    { t: "go", x: q.x, y: q.y },
    { t: "wait", seconds: r.range(30, 60) },
    { t: "carry", item: null },
  ]);
}

/** Hours the bells are rung at: morning, noon and evening. */
const BELL_HOURS = [7, 12, 18];
/** Hour the bell calls to the rest-day service. */
const SERVICE_BELL = 10.5;
/** Hours before a bell that the priest goes up to ring it. */
const BELL_AHEAD = 0.6;

/** The priest: the bells at morning, noon and evening, and for the service on a day of rest; otherwise inside. */
function priest(world: World, p: Person): Task {
  const church = world.council.worship();
  if (!church) {
    return haul(world, p) ?? leisure(world, p);
  }
  const d = world.door(church);
  const h = hour(world);
  const service = isRestDay(world) ? SERVICE_BELL : -1;
  const ahead = (b: number) => mod(b - h, 24);
  let bell = BELL_HOURS[0];
  for (const b of [...BELL_HOURS, service]) {
    if (b >= 0 && ahead(b) < ahead(bell)) {
      bell = b;
    }
  }
  if (ahead(bell) < BELL_AHEAD) {
    return task("bells", [
      { t: "go", x: d.x, y: d.y, enter: church.id },
      { t: "stay", until: at(world, bell) },
      { t: "do", effect: { kind: "bell", pattern: bell === service ? "service" : "hours" } },
      { t: "stay", until: world.env.clock.days + 0.01 },
    ]);
  }
  // Inside till it is time to go up for the next bell.
  return task("church", [
    { t: "go", x: d.x, y: d.y, enter: church.id },
    {
      t: "stay",
      until: Math.min(world.env.clock.days + 0.05, at(world, bell) - BELL_AHEAD / 2 / 24),
    },
  ]);
}

/** Guards: a watch on the tower by day, rounds with a torch along the lanes by night. */
function guard(world: World): Task {
  const r = world.rng;
  const towers = world.town.buildings.filter(
    (b) => b.kind === "watchtower" && b.phase === "standing",
  );
  if (world.env.darkness < 0.5 && towers.length > 0) {
    const t = r.pick(towers);
    const spot = rectPoint(t.rect, r.range(-0.6, 0.6), r.range(-0.6, 0.6));
    return task("watch", [
      { t: "carry", item: "spear" },
      { t: "go", x: spot.x, y: spot.y },
      {
        t: "work",
        pose: "stand",
        seconds: r.range(40, 80),
        fx: spot.x,
        fy: spot.y - 5,
        lift: 7.25,
      },
    ]);
  }
  const steps: Step[] = [{ t: "carry", item: world.env.darkness > 0.5 ? "torch" : "spear" }];
  const ring = world.council.patrolRoute(world);
  const start = r.int(0, ring.length - 1);
  for (let k = 0; k < 5; k++) {
    const q = ring[(start + k * 3) % ring.length];
    steps.push({ t: "go", x: q.x, y: q.y }, { t: "wait", seconds: r.range(2, 6) });
  }
  return task("patrol", steps);
}

/** The wizard: about the knoll and the tower, and something bright cast into the dusk. */
function wizard(world: World): Task {
  const r = world.rng;
  const tower = world.council.place(world, "wizard");
  const base = tower ? world.door(tower) : world.plan.center;
  const q = near(world, base, 14);
  const steps: Step[] = [
    { t: "carry", item: "staff" },
    { t: "go", x: q.x, y: q.y },
  ];
  const dusk = world.env.darkness > 0.2 && world.env.darkness < 0.9;
  steps.push(
    dusk || r.chance(0.2)
      ? { t: "work", pose: "cast", seconds: 3, fx: q.x, fy: q.y - 5, sound: "magic", every: 3 }
      : { t: "wait", seconds: r.range(15, 30) },
  );
  if (tower && r.chance(0.4)) {
    steps.push(
      { t: "go", x: base.x, y: base.y, enter: tower.id },
      { t: "stay", until: world.env.clock.days + 0.05 },
    );
  }
  return task("wizard", steps);
}
