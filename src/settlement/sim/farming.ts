import { YEAR } from "./people.ts";
import type { FieldState } from "./town.ts";
import type { World } from "./world.ts";

/** Seconds of work (one farmer) to break a new field, to plow and sow one, and to reap one. */
const BREAK_WORK = 110;
const SOW_WORK = 70;
const REAP_WORK = 60;
/** Food a good harvest of one field brings in. */
export const HARVEST = 110;
const CROPS: FieldState["crop"][] = ["wheat", "barley", "oats", "flax"];

/** The in-world year it is (0 the first). */
export function yearOf(world: World): number {
  return Math.floor(world.env.clock.days / YEAR);
}

/** What a field wants done now: broken, plowed and sown, reaped, or nothing. */
export function fieldNeeds(world: World, id: number): "break" | "sow" | "reap" | null {
  const f = world.town.fields[id];
  const year = yearOf(world);
  if (!f.cleared) {
    return world.council.openFields.has(id) && world.council.fieldClear(world, id) ? "break" : null;
  }
  const phase = world.season.farming;
  if (phase === "sow" && f.sownYear < year) {
    return "sow";
  }
  if ((phase === "reap" || phase === "rest") && f.sownYear === year && f.reapedYear < year) {
    // Late crops are still brought in, into the first snows if need be.
    return world.season.yearFraction < 0.95 ? "reap" : null;
  }
  return null;
}

/** Breaking or plowing and sowing a field; false once there is nothing left to do. */
export function plowField(world: World, id: number, dt: number): boolean {
  const need = fieldNeeds(world, id);
  const f = world.town.fields[id];
  if (need === "break") {
    f.work += dt / BREAK_WORK;
    if (f.work >= 1) {
      f.work = 0;
      f.cleared = true;
      const r = world.plan.fields[id].rect;
      world.groundChanged(r.x, r.y, Math.hypot(r.width, r.depth) / 2 + 1);
    }
    return true;
  }
  if (need !== "sow") {
    return false;
  }
  f.work += dt / SOW_WORK;
  if (f.work >= 1) {
    f.work = 0;
    f.sownYear = yearOf(world);
    f.spoiled = 0;
    // Crops go round the fields from year to year.
    f.crop = CROPS[(id + f.sownYear) % CROPS.length];
  }
  return true;
}

/** Reaping a field; the harvest goes into the barns. False once it is all in. */
export function reapField(world: World, id: number, dt: number): boolean {
  if (fieldNeeds(world, id) !== "reap") {
    return false;
  }
  const f = world.town.fields[id];
  f.work += dt / REAP_WORK;
  if (f.work >= 1) {
    f.work = 0;
    f.reapedYear = yearOf(world);
    world.stock.food += HARVEST * (1 - f.spoiled * 0.7);
  }
  return true;
}

/** How a field's crop stands now, for drawing: bare soil, growing, ripe, stubble, or fallow. */
export function fieldLook(
  world: World,
  id: number,
): {
  state: "soil" | "growing" | "stubble" | "fallow";
  crop: FieldState["crop"];
  spoiled: number;
  work: number;
} {
  const f = world.town.fields[id];
  const year = yearOf(world);
  const phase = world.season.farming;
  let state: "soil" | "growing" | "stubble" | "fallow";
  if (f.sownYear === year) {
    state = f.reapedYear === year ? "stubble" : "growing";
  } else if (f.reapedYear === year - 1 && phase === "sow") {
    state = "stubble";
  } else {
    state = phase === "sow" ? "soil" : "fallow";
  }
  return { state, crop: f.crop, spoiled: f.spoiled, work: f.work };
}
