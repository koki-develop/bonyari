import { mod } from "../../shared/core/math.ts";
import { DAYS_PER_YEAR } from "../../shared/env/clock.ts";
import type { Plan } from "./plan.ts";
import type { Point } from "./terrain.ts";
import type { World } from "./world.ts";

/** Day of the year of the harvest home, when the reaping is done. */
export const FESTIVAL_DAY = 8;
/** Hours the fire burns and the dancing goes on. */
export const FESTIVAL_FROM = 17;
export const FESTIVAL_TO = 23.3;
/** Hour the garlands go up round the square. */
export const GARLANDS_FROM = 12;
/** Hours later than usual everyone goes to bed that night. */
export const FESTIVAL_LATE = 1.8;
/** Fewest people who hold a harvest home. */
const FESTIVAL_POP = 20;
/** Radius (m) of the ring the dancers go round the fire in. */
export const DANCE_RING = 4.2;

/** Whether today is the harvest home. */
export function festivalDay(world: World): boolean {
  return (
    mod(Math.floor(world.env.clock.days), DAYS_PER_YEAR) === FESTIVAL_DAY &&
    world.people.length >= FESTIVAL_POP
  );
}

/** Whether the fire is lit and the dancing on now: the evening of the day, and no raid or downpour. */
export function festive(world: World): boolean {
  const h = world.env.clock.hour;
  return (
    festivalDay(world) &&
    h >= FESTIVAL_FROM &&
    h < FESTIVAL_TO &&
    !world.raids.alarm &&
    world.env.weather.state.rain < 0.35
  );
}

/** Whether the garlands are up round the square. */
export function garlandsUp(world: World): boolean {
  const h = world.env.clock.hour;
  return festivalDay(world) && h >= GARLANDS_FROM && h < FESTIVAL_TO + 0.5;
}

/** Where the fire is built: on the square, across it from the well. */
export function bonfireSpot(plan: Plan): Point {
  return { x: plan.square.x - 3, y: plan.square.y - 3.5 };
}
