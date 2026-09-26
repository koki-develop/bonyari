import { newAnimal } from "./animals.ts";
import { hide, isMarketDay } from "./jobs.ts";
import { makePerson } from "./life.ts";
import type { Plan } from "./plan.ts";
import { runTask, type Step, type Task, task } from "./tasks.ts";
import type { Point } from "./terrain.ts";
import type { World } from "./world.ts";

/** Stalls round the square on market days. */
export const STALLS = 4;
/** Hours the market keeps: the stalls stand, the traders come before and are gone after. */
export const MARKET_OPENS = 7.5;
export const MARKET_CLOSES = 15.5;
/** Hour the traders set out up the road, to be at their stalls by the opening. */
const TRADERS_SET_OUT = 5;
/** How far (m) from the square they come into sight, out of the woods. */
const TRADERS_FROM = 70;
/** Sacks on a trader's cart coming, set out on the stall, and going home again. */
const SACKS_COMING = 6;
const SACKS_SET_OUT = 2;
const SACKS_GOING = 4;

/** Where stall `k` stands on the square. */
export function stallSpot(plan: Plan, k: number): Point {
  const sq = plan.square;
  const a = 0.6 + k * 1.3;
  return { x: sq.x + Math.cos(a) * (sq.radius - 3.2), y: sq.y + Math.sin(a) * (sq.radius - 3.2) };
}

/**
 * Traders on market days: up the roads at dawn with an ox cart of sacks,
 * a day at a stall on the square, home again in the afternoon. Under a roof
 * while raiders are about, then off home.
 */
export function updateTraders(world: World, dt: number): void {
  const h = world.env.clock.hour;
  const today = Math.floor(world.env.clock.days);
  if (
    isMarketDay(world) &&
    h >= TRADERS_SET_OUT &&
    h < MARKET_OPENS &&
    world.council.marketDay !== today &&
    !world.raids.alarm
  ) {
    world.council.marketDay = today;
    const pop = world.people.length;
    const count = 1 + (pop >= 70 ? 1 : 0) + (world.council.era >= 2 ? 1 : 0);
    for (let k = 0; k < count; k++) {
      comeToMarket(world, k);
    }
  }
  // A copy: those who have gone home are taken off the list as it is gone through.
  for (const p of world.traders.slice()) {
    const hiding = p.task?.steps.slice(p.task.i).some((s) => s.t === "hide");
    if (world.raids.alarm && p.task?.kind === "trade" && !hiding) {
      p.task = shelter(world, p, afterRaid(p.task));
      p.path = [];
      p.step = 0;
    }
    if (!runTask(world, p, dt)) {
      // Done, or the way was lost: gone down the road.
      world.remove(p);
    }
  }
}

/** A trader and their cart, coming out of the woods up one of the roads for stall `k`. */
function comeToMarket(world: World, k: number): void {
  const r = world.rng;
  const plan = world.plan;
  const road = plan.nodes[r.pick(plan.exits)];
  const stall = stallSpot(plan, k);
  const way = world.nav.path(road.x, road.y, stall.x, stall.y);
  const c = plan.center;
  const from = way.find((q) => Math.hypot(q.x - c.x, q.y - c.y) < TRADERS_FROM) ?? road;
  const p = makePerson(world, -1, r.range(24, 55), from.x, from.y);
  p.trader = true;
  p.militia = false;
  world.addPerson(p);
  const ox = newAnimal(world, "ox", from.x, from.y, { type: "person", id: p.id });
  ox.cargo = "sacks";
  ox.load = SACKS_COMING;
  // Stand in front of the stall, on the square's side.
  const toward = Math.atan2(c.y - stall.y, c.x - stall.x);
  const spot = { x: stall.x + Math.cos(toward) * 1.3, y: stall.y + Math.sin(toward) * 1.3 };
  const close = Math.floor(world.env.clock.days) + (MARKET_CLOSES - r.range(0.2, 0.6)) / 24;
  p.task = task("trade", [
    { t: "go", x: spot.x, y: spot.y },
    { t: "do", effect: { kind: "sacks", count: SACKS_SET_OUT } },
    { t: "stay", until: close },
    { t: "do", effect: { kind: "sacks", count: SACKS_GOING } },
    ...homeward(from),
  ]);
}

/** Back down the road the way they came, and gone. */
function homeward(to: Point): Step[] {
  return [
    { t: "go", x: to.x, y: to.y },
    { t: "do", effect: { kind: "gone" } },
  ];
}

/**
 * What a trader goes on with once the raiders have gone: back to the stall
 * if the market is still to keep, else on with packing up and going home.
 */
function afterRaid(trade: Task): Step[] {
  const rest = trade.steps.slice(trade.i);
  const stall = trade.steps[0];
  // Still to keep the stall (the day's `stay` not yet over): back to it first.
  const keeping = rest.some((s) => s.t === "stay");
  return keeping && stall.t === "go" ? [stall, ...rest.filter((s) => s !== stall)] : rest;
}

/** Into the nearest roof while the raiders are about, then on with `then`. */
function shelter(world: World, p: Point, then: Step[]): Task {
  const b = world.council.shelterNear(world, p.x, p.y);
  if (!b) {
    return task("trade", [hide(world), ...then]);
  }
  const d = world.door(b);
  return task("trade", [{ t: "go", x: d.x, y: d.y, run: true, enter: b.id }, hide(world), ...then]);
}
