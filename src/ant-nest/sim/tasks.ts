import { clamp } from "../../shared/core/math.ts";
import {
  type Ant,
  type Brood,
  broodRadius,
  type Item,
  LARVA_FOOD,
  maturity,
  type Task,
} from "./colony.ts";
import {
  AIR,
  AIR_LOC,
  cellIndex,
  cellX,
  cellY,
  type Loc,
  OPEN,
  STEM,
  SURFACE,
  SURFACE_X0,
  SURFACE_X1,
} from "./geometry.ts";
import type { Waypoint } from "./nest.ts";
import type { World } from "./world.ts";

/** Scratch list for dug cells. */
const DUG: number[] = [];

/**
 * Carries on with the ant's task: sets it walking or standing for its next
 * step. False when the task is over (or can't go on), so another is chosen.
 */
export function runTask(world: World, ant: Ant): boolean {
  const task = ant.task;
  if (!task) {
    return false;
  }
  switch (task.kind) {
    case "rest":
      return rest(world, ant, task);
    case "dig":
      return dig(world, ant, task);
    case "pack":
      return pack(world, ant, task);
    case "unpack":
      return unpack(world, ant, task);
    case "forage":
      return forage(world, ant, task);
    case "aphids":
      return aphids(world, ant, task);
    case "nurse":
      return nurse(world, ant, task);
    case "haul":
      return haul(world, ant, task);
    case "guard":
      return guard(world, ant, task);
    case "attend":
      return attend(world, ant, task);
    case "winter":
      return winter(world, ant, task);
    case "queen":
      return queen(world, ant, task);
    case "found":
      return found(world, ant, task);
    case "seal":
      return seal(world, ant, task);
    case "fly":
      return fly(world, ant, task);
  }
}

// ─── Choosing ──────────────────────────────────────────────────────────────

/** What an ant takes up next, by what it is, how old, and what the colony needs. */
export function chooseTask(world: World, ant: Ant): Task | null {
  const c = world.colony;
  if (ant.caste === "queen") {
    return chooseForQueen(world, ant);
  }
  if (ant.caste !== "worker") {
    if (ant.winged && world.flightDue()) {
      return { kind: "fly", step: 0, stem: tallestStem(world) };
    }
    return { kind: "rest", step: 0, chamber: c.broodChamber };
  }
  if (c.stage !== "colony") {
    return { kind: "rest", step: 0, chamber: c.broodChamber };
  }
  if (c.dormancy > 0.5) {
    // Shutting the doors for the winter comes before sleeping.
    const plug = closingPortal(world);
    if (plug >= 0 && world.count("pack") < 2) {
      world.note("pack");
      return { kind: "pack", step: 0, portal: plug };
    }
    return { kind: "winter", step: 0 };
  }
  const r = world.rng;
  const young = maturity(world.day - ant.born) < 1;
  const options: [Task, number][] = [];
  // Doors first: plug them against rain and cold, open them after.
  if (c.closed) {
    const p = closingPortal(world);
    if (p >= 0 && world.count("pack") < 2) {
      options.push([{ kind: "pack", step: 0, portal: p }, 60]);
    }
  } else {
    const p = world.plan.portals.findIndex(
      (_, i) => world.nest.plugged(i) && world.nest.portalDug(i),
    );
    if (p >= 0 && world.count("unpack") < 3) {
      options.push([{ kind: "unpack", step: 0, portal: p }, 60]);
    }
  }
  // Digging, while the nest is small for the colony and the soil can be taken out.
  if (world.canDump && world.nest.openCells < world.wantedRoom()) {
    const f = world.digFront.find((g) => world.count(`dig:${g}`) < digCapacity(world, g));
    if (f !== undefined && world.count("dig") < Math.max(2, world.workers * 0.3)) {
      options.push([{ kind: "dig", step: 0, f, trips: 0, tries: 0 }, young ? 1.5 : 5]);
    }
  }
  // The brood.
  if (world.brood.length > 0 && c.broodChamber >= 0) {
    const need = 1 + (world.brood.length / (1 + world.count("nurse"))) * 0.8;
    options.push([
      { kind: "nurse", step: 0, brood: -1, item: -1, spots: 0 },
      need * (young ? 3 : 1),
    ]);
  }
  // Food.
  if (world.canLeave) {
    const foragers = world.count("forage");
    if (foragers < Math.max(2, world.workers * 0.4)) {
      const hungry = world.brood.filter((b) => b.stage === "larva").length / (4 + world.workers);
      // With the store full, fewer go out; the old go out most.
      const plenty = world.storedFood() + c.honey > 4 + world.workers * 0.4 ? 0.3 : 1;
      const weight =
        (1.2 + 2.2 * c.known.length + 3 * hungry) *
        plenty *
        (young ? 0.15 : world.worn(ant) ? 4 : 1);
      options.push([{ kind: "forage", step: 0, item: -1, looks: 0 }, weight]);
    }
    const stem = aphidStem(world);
    if (stem >= 0 && world.count("aphids") < 5) {
      options.push([{ kind: "aphids", step: 0, stem }, young ? 0.3 : 1.6]);
    }
    // Husks and scraps go out to the midden: more hands the more there is.
    const refuse = world.items.filter(
      (i) => (i.kind === "husk" || i.kind === "scrap") && !i.carried && i.loc.f >= 0,
    );
    if (refuse.length > 0 && world.count("haul") < Math.min(6, 1 + refuse.length / 4)) {
      const item = refuse[r.int(0, refuse.length - 1)];
      options.push([{ kind: "haul", step: 0, item: item.id }, 1.5 + 0.3 * refuse.length]);
    }
  }
  // Watch at the door, company for the queen, and rest.
  const doors = world.plan.portals.filter((_, i) => world.nest.portalDug(i)).length;
  if (world.count("guard") < doors && world.workers > 4) {
    options.push([{ kind: "guard", step: 0, portal: -1 }, 1.2]);
  }
  if (world.queen && world.count("attend") < 3 && world.workers > 6) {
    options.push([{ kind: "attend", step: 0 }, 0.8]);
  }
  options.push([{ kind: "rest", step: 0, chamber: -1 }, 4]);
  let total = 0;
  for (const [, w] of options) {
    total += w;
  }
  let pick = r.next() * total;
  for (const [task, w] of options) {
    pick -= w;
    if (pick < 0) {
      world.note(task.kind);
      if (task.kind === "dig") {
        world.note(`dig:${task.f}`);
      }
      return task;
    }
  }
  return options[options.length - 1][0];
}

function chooseForQueen(world: World, ant: Ant): Task | null {
  const c = world.colony;
  switch (c.stage) {
    case "arrival":
      // Restored after landing: carry on from the ground.
      return { kind: "found", step: ant.winged ? 1 : 3, x: world.plan.portals[0].x, hops: 0 };
    case "founding": {
      for (const f of [0, 1]) {
        if (!world.nest.complete(f)) {
          return { kind: "dig", step: 0, f, trips: 0, tries: 0 };
        }
      }
      const plug = world.plan.portals[0].plug.length;
      if (world.nest.plugs[0] < plug) {
        return { kind: "seal", step: 0 };
      }
      c.stage = "claustral";
      c.closed = true;
      c.broodChamber = 1;
      c.foodChamber = 1;
      return { kind: "queen", step: 0, rounds: 0, brood: -1 };
    }
    default:
      return { kind: "queen", step: 0, rounds: 0, brood: -1 };
  }
}

/**
 * How many may work at the face of `f` at once: a few in a tunnel, taking
 * turns at the face while the others carry soil out, more in a chamber.
 */
function digCapacity(world: World, f: number): number {
  return world.plan.features[f].kind === "chamber" ? 5 : 3;
}

/** A dug entrance the colony wants shut and that isn't yet, or -1. */
function closingPortal(world: World): number {
  const portals = world.plan.portals;
  for (let p = 0; p < portals.length; p++) {
    if (world.nest.portalDug(p) && world.nest.plugs[p] < portals[p].plug.length) {
      return p;
    }
  }
  return -1;
}

function aphidStem(world: World): number {
  const f = world.season.yearFraction;
  const stems = world.surface.stems;
  for (let k = 0; k < stems.length; k++) {
    if (world.surface.aphids(k, f) > 0.2) {
      return k;
    }
  }
  return -1;
}

function tallestStem(world: World): number {
  const f = world.season.yearFraction;
  let best = 0;
  for (let k = 1; k < world.surface.stems.length; k++) {
    if (world.surface.stemHeight(k, f) > world.surface.stemHeight(best, f)) {
      best = k;
    }
  }
  return best;
}

// ─── Places ────────────────────────────────────────────────────────────────

/** The nearest entrance (a portal index) that leads out now, or -1. */
function nearestExit(world: World, ant: Ant): number {
  let best = -1;
  let bestCost = Infinity;
  const portals = world.plan.portals;
  for (let p = 0; p < portals.length; p++) {
    if (!world.nest.portalOpen(p)) {
      continue;
    }
    const portal = portals[p];
    let cost: number;
    if (ant.loc.f < 0) {
      cost = Math.abs(ant.x - portal.x);
    } else {
      const way = world.nest.route(ant.loc, { f: portal.feature, s: portal.s, u: 0 });
      cost = way ? wayLength(way) : Infinity;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }
  return best;
}

function wayLength(way: readonly Waypoint[]): number {
  let sum = 0;
  for (let i = 1; i < way.length; i++) {
    if (way[i].f === way[i - 1].f) {
      sum += Math.abs(way[i].s - way[i - 1].s);
    }
  }
  return sum;
}

/** Just inside portal `p`'s plug, where an ant stands to pack it or dig it out. */
function insidePlug(world: World, p: number, deeper = 0): Loc {
  const portal = world.plan.portals[p];
  const s = portal.s === 0 ? portal.plugS1 + 2.2 + deeper : portal.plugS0 - 2.2 - deeper;
  return { f: portal.feature, s, u: 0 };
}

/** Where on the surface soil from portal `p` is dropped: around it, mostly close by. */
function dumpX(world: World, p: number, near: number, far: number): number {
  const r = world.rng;
  const x = world.plan.portals[p].x;
  const side = r.chance(0.5) ? 1 : -1;
  return clamp(
    x + side * (near + (far - near) * Math.pow(r.next(), 1.4)),
    SURFACE_X0 + 4,
    SURFACE_X1 - 4,
  );
}

/**
 * A place inside to bring something home to: in chamber `f` (on its `heap`,
 * if one is named), else in any chamber there is room in, else at the foot
 * of the entrance.
 */
function homeSpot(world: World, f: number, heap: "store" | "husk" | null): Loc | null {
  const chambers = world.usableChambers();
  const order = f >= 0 && chambers.includes(f) ? [f, ...chambers.filter((g) => g !== f)] : chambers;
  for (const g of order) {
    const spot = heap ? world.pileSpot(g, heap, 1.2) : world.nest.spot(g, world.rng, 1.4);
    if (spot) {
      return spot;
    }
  }
  const reach = world.nest.reachOf(0);
  return reach > 6 ? { f: 0, s: reach - 2, u: 0 } : null;
}

/** Turns an ant to face a point. */
function face(ant: Ant, x: number, y: number): void {
  ant.heading = Math.atan2(y - ant.y, x - ant.x);
}

/** A place beside a point inside feature `f`, for tending something there. */
function beside(world: World, loc: Loc, reach: number): Loc {
  const r = world.rng;
  return { f: loc.f, s: loc.s + r.range(-1, 1) * reach, u: loc.u + r.range(-1, 1) * reach * 0.6 };
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

function rest(world: World, ant: Ant, t: Extract<Task, { kind: "rest" }>): boolean {
  const c = world.colony;
  switch (t.step) {
    case 0: {
      let f = t.chamber;
      if (f < 0 || !world.reachable(f)) {
        const chambers = world.usableChambers();
        if (chambers.length === 0) {
          f = ant.loc.f >= 0 ? ant.loc.f : c.broodChamber;
        } else {
          // Anywhere there is room, a little more often near the brood.
          const r = world.rng.next();
          f =
            r < 0.15 && c.broodChamber >= 0
              ? c.broodChamber
              : chambers[world.rng.int(0, chambers.length - 1)];
        }
      }
      if (f < 0) {
        return false;
      }
      const spot = world.freeSpot(f, ant, 1.4, ant.size * 0.8);
      if (!spot || !world.go(ant, spot, spot.u)) {
        return false;
      }
      t.step = 1;
      return true;
    }
    case 1:
      world.stand(ant, world.rng.range(6, 24), world.rng.chance(0.3) ? "groom" : "still");
      t.step = 2;
      return true;
    default:
      return false;
  }
}

function dig(world: World, ant: Ant, t: Extract<Task, { kind: "dig" }>): boolean {
  const nest = world.nest;
  const feature = world.plan.features[t.f];
  const queen = ant.caste === "queen";
  switch (t.step) {
    case 0: {
      const k = nest.faceIndex(t.f);
      if (k >= feature.dig.length || t.tries > 4) {
        return false;
      }
      // Stand with the head at the face.
      const s = clamp(feature.digS[k] - ant.size * 0.45, 0.3, Math.max(0.3, nest.reachOf(t.f)));
      const u = nest.clampU(t.f, s, feature.digU[k] * 0.7, 1.2);
      if (!world.go(ant, { f: t.f, s, u }, u)) {
        return false;
      }
      t.step = 1;
      return true;
    }
    case 1: {
      const k = nest.faceIndex(t.f);
      if (k >= feature.dig.length) {
        return false;
      }
      // Someone else dug on meanwhile: move up to the new face.
      if (Math.abs(feature.digS[k] - ant.size * 0.45 - ant.loc.s) > ant.size * 0.7 + 2) {
        t.tries++;
        t.step = 0;
        return dig(world, ant, t);
      }
      const cell = feature.dig[k];
      face(ant, cellX(cell), cellY(cell));
      const hardness = world.soil.hardness(cellX(cell), cellY(cell));
      world.stand(ant, (queen ? 0.8 : 1.4) * hardness * world.rng.range(0.8, 1.2), "dig");
      t.step = 2;
      return true;
    }
    case 2: {
      DUG.length = 0;
      const pellet = queen ? 14 : Math.max(2, Math.round(ant.size * 0.46));
      if (nest.dig(t.f, pellet, DUG) === 0) {
        return false;
      }
      const x = cellX(DUG[0]);
      const y = cellY(DUG[0]);
      world.events.push({ kind: "bite", x, y, hardness: world.soil.hardness(x, y) });
      ant.cargo = { kind: "soil", id: -1, amount: DUG.length, x, y, from: null };
      const p = nearestExit(world, ant);
      const out = queen || world.canDump;
      if (
        p < 0 ||
        !out ||
        !world.go(ant, { f: SURFACE, s: dumpX(world, p, queen ? 3 : 5, queen ? 11 : 32), u: 0 })
      ) {
        // No way out: press it into the wall.
        world.stand(ant, 0.6, "dig");
        ant.cargo = null;
        t.step = 0;
        return true;
      }
      t.step = 3;
      return true;
    }
    case 3:
      world.stand(ant, 0.35, "still");
      ant.heading = ant.heading > Math.PI / 2 || ant.heading < -Math.PI / 2 ? Math.PI : 0;
      t.step = 4;
      return true;
    case 4: {
      if (ant.cargo) {
        world.surface.deposit(ant.x, ant.cargo.amount);
        world.events.push({ kind: "dump", x: ant.x, y: ant.y });
        ant.cargo = null;
      }
      t.trips++;
      const more =
        queen || (t.trips < 5 && world.nest.openCells < world.wantedRoom() && world.canDump);
      if (!more) {
        return false;
      }
      t.step = 0;
      t.tries = 0;
      return dig(world, ant, t);
    }
    default:
      return false;
  }
}

/** Scrapes soil off the tunnel wall just inside a plug and presses it into the plug. */
function packInto(world: World, ant: Ant, t: { step: number }, p: number, pellet: number): boolean {
  const nest = world.nest;
  const plug = world.plan.portals[p].plug.length;
  switch (t.step) {
    case 0:
      if (nest.plugs[p] >= plug) {
        return false;
      }
      if (!world.go(ant, insidePlug(world, p, 4 + world.rng.range(0, 3)))) {
        return false;
      }
      t.step = 1;
      return true;
    case 1:
      world.stand(ant, world.rng.range(0.9, 1.4), "dig");
      t.step = 2;
      return true;
    case 2:
      ant.cargo = { kind: "soil", id: -1, amount: pellet, x: ant.x, y: ant.y, from: null };
      if (!world.go(ant, insidePlug(world, p))) {
        ant.cargo = null;
        return false;
      }
      t.step = 3;
      return true;
    case 3: {
      // The last of the hole is closed only once everyone is in, and no one stands in it.
      if (
        nest.plugs[p] + pellet >= world.plan.portals[p].shut &&
        (world.anyoneOutside() || world.anyoneInPlug(p, ant))
      ) {
        world.stand(ant, world.rng.range(1.5, 3), "still");
        return true;
      }
      const portal = world.plan.portals[p];
      const line = world.plan.features[portal.feature].line;
      const toward = portal.s === 0 ? portal.plugS1 : portal.plugS0;
      face(ant, line.x(toward), line.y(toward));
      world.stand(ant, world.rng.range(0.7, 1.1), "dig");
      t.step = 4;
      return true;
    }
    case 4:
      nest.packPlug(p, pellet);
      world.events.push({ kind: "pack", x: ant.x, y: ant.y });
      ant.cargo = null;
      t.step = 0;
      return packInto(world, ant, t, p, pellet);
    default:
      return false;
  }
}

function seal(world: World, ant: Ant, t: Extract<Task, { kind: "seal" }>): boolean {
  return packInto(world, ant, t, 0, 6);
}

function pack(world: World, ant: Ant, t: Extract<Task, { kind: "pack" }>): boolean {
  if (!world.colony.closed && world.colony.dormancy < 0.5) {
    return false;
  }
  return packInto(world, ant, t, t.portal, Math.max(2, Math.round(ant.size * 0.46)));
}

function unpack(world: World, ant: Ant, t: Extract<Task, { kind: "unpack" }>): boolean {
  const nest = world.nest;
  const p = t.portal;
  switch (t.step) {
    case 0:
      if (world.colony.closed || !nest.plugged(p) || !world.go(ant, insidePlug(world, p))) {
        return false;
      }
      t.step = 1;
      return true;
    case 1: {
      const portal = world.plan.portals[p];
      const line = world.plan.features[portal.feature].line;
      const toward = portal.s === 0 ? portal.plugS1 : portal.plugS0;
      face(ant, line.x(toward), line.y(toward));
      world.stand(ant, world.rng.range(1, 1.5), "dig");
      t.step = 2;
      return true;
    }
    case 2: {
      const cells = nest.clearPlug(p, Math.max(2, Math.round(ant.size * 0.46)));
      if (cells === 0) {
        return false;
      }
      world.events.push({ kind: "bite", x: ant.x, y: ant.y, hardness: 0.7 });
      ant.cargo = { kind: "soil", id: -1, amount: cells, x: ant.x, y: ant.y + 3, from: null };
      if (nest.portalOpen(p) && world.go(ant, { f: SURFACE, s: dumpX(world, p, 4, 18), u: 0 })) {
        t.step = 3;
        return true;
      }
      // Not through yet: the soil is pressed into the wall below.
      world.stand(ant, 0.6, "dig");
      ant.cargo = null;
      t.step = 0;
      return true;
    }
    case 3:
      world.stand(ant, 0.35, "still");
      t.step = 4;
      return true;
    case 4:
      if (ant.cargo) {
        world.surface.deposit(ant.x, ant.cargo.amount);
        world.events.push({ kind: "dump", x: ant.x, y: ant.y });
        ant.cargo = null;
      }
      return false;
    default:
      return false;
  }
}

/**
 * A forager out searching stops when it comes upon food, as it walks past;
 * true if it did (its task then goes for the food).
 */
export function noticeFood(world: World, ant: Ant): boolean {
  const t = ant.task;
  if (
    !t ||
    t.kind !== "forage" ||
    t.step !== 1 ||
    t.item >= 0 ||
    ant.loc.f !== SURFACE ||
    ant.cargo
  ) {
    return false;
  }
  return foodNear(world, ant.x, 5) !== null;
}

/** Food lying on the ground within `reach` (mm) of x that an ant could take from. */
function foodNear(world: World, x: number, reach: number): Item | null {
  let best: Item | null = null;
  let bestD = reach;
  for (const it of world.items) {
    if (
      (it.kind !== "crumb" && it.kind !== "insect") ||
      it.carried ||
      it.drop > 0 ||
      it.amount < 0.05
    ) {
      continue;
    }
    if (it.loc.f !== SURFACE) {
      continue;
    }
    const d = Math.abs(it.loc.s - x);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

function forage(world: World, ant: Ant, t: Extract<Task, { kind: "forage" }>): boolean {
  const r = world.rng;
  const c = world.colony;
  switch (t.step) {
    case 0: {
      const p = nearestExit(world, ant);
      if (p < 0 || !world.canLeave) {
        return false;
      }
      let x: number;
      const known = c.known.map((id) => world.itemOf(id)).filter((i): i is Item => i !== undefined);
      if (known.length > 0 && r.chance(0.85)) {
        // Word of a find: straight there.
        const item = known[r.int(0, known.length - 1)];
        t.item = item.id;
        x = item.loc.s + r.range(-1.5, 1.5);
      } else {
        t.item = -1;
        const side = r.chance(0.5) ? 1 : -1;
        x = world.plan.portals[p].x + side * (16 + 110 * Math.pow(r.next(), 1.3));
      }
      if (world.worn(ant)) {
        // An old forager's last trip: out among the grass, away from the nest.
        const side = r.chance(0.5) ? 1 : -1;
        x = world.plan.portals[p].x + side * r.range(50, 110);
        t.item = -1;
      }
      if (!world.go(ant, { f: SURFACE, s: x, u: 0 })) {
        return false;
      }
      t.step = 1;
      return true;
    }
    case 1: {
      // Looking about on the ground, unless it is time to go in.
      if (!world.canLeave) {
        t.step = 5;
        return forage(world, ant, t);
      }
      if (world.worn(ant) && ant.loc.f === SURFACE) {
        world.leave(ant);
        return true;
      }
      const target = t.item >= 0 ? world.itemOf(t.item) : undefined;
      const item =
        target && target.amount > 0.05 && Math.abs(target.loc.s - ant.x) < 30
          ? target
          : foodNear(world, ant.x, 16);
      if (item) {
        t.item = item.id;
        if (Math.abs(item.loc.s - ant.x) < 2.5) {
          t.step = 2;
          return forage(world, ant, t);
        }
        if (
          !world.go(ant, { f: SURFACE, s: item.loc.s + (ant.x < item.loc.s ? -1.2 : 1.2), u: 0 })
        ) {
          return false;
        }
        return true;
      }
      t.looks++;
      if (t.looks > 7) {
        t.step = 5;
        return forage(world, ant, t);
      }
      // Antennae to the ground, then on a little way.
      if (t.looks % 2 === 1) {
        world.stand(ant, r.range(0.6, 1.8), "groom");
        return true;
      }
      const side = r.chance(0.5) ? 1 : -1;
      const x = clamp(ant.x + side * r.range(8, 34), SURFACE_X0 + 4, SURFACE_X1 - 4);
      if (!world.go(ant, { f: SURFACE, s: x, u: 0 })) {
        return false;
      }
      return true;
    }
    case 2: {
      const item = world.itemOf(t.item);
      if (!item || item.amount < 0.05 || item.carried) {
        t.step = 1;
        t.item = -1;
        return forage(world, ant, t);
      }
      face(ant, item.loc.s, ant.y);
      world.stand(ant, r.range(1.1, 1.8) + item.size * 0.05, "dig");
      t.step = 3;
      return true;
    }
    case 3: {
      const item = world.itemOf(t.item);
      if (item && item.amount > 0.05) {
        const take = Math.min(1, item.amount);
        item.amount -= take;
        ant.cargo = {
          kind: "food",
          id: -1,
          amount: take,
          x: 0,
          y: 0,
          from: item.kind === "insect" ? "insect" : "crumb",
        };
        if (item.amount < 0.05) {
          world.removeItem(item);
        } else if (!c.known.includes(item.id)) {
          c.known.push(item.id);
        }
      }
      t.step = 5;
      return forage(world, ant, t);
    }
    case 5: {
      // Home, to the food store.
      const f = c.foodChamber >= 0 ? c.foodChamber : c.broodChamber;
      const spot = homeSpot(world, f, "store");
      if (!spot || !world.go(ant, spot, spot.u)) {
        // No way in yet: wait by the door.
        const p = world.plan.portals[0];
        if (ant.loc.f === SURFACE && Math.abs(ant.x - p.x) > 6) {
          return world.go(ant, { f: SURFACE, s: p.x + r.range(-5, 5), u: 0 });
        }
        world.stand(ant, r.range(1.5, 3), "groom");
        return true;
      }
      t.step = 6;
      return true;
    }
    case 6:
      if (ant.cargo?.kind === "food") {
        store(world, ant);
      }
      return false;
    default:
      return false;
  }
}

/** Puts the food an ant brought home onto the store heap where it stands. */
function store(world: World, ant: Ant): void {
  const cargo = ant.cargo;
  if (!cargo) {
    return;
  }
  ant.cargo = null;
  // Onto a piece nearby if there is one with room.
  for (const it of world.items) {
    if (it.kind === "store" && it.loc.f === ant.loc.f && !it.carried && it.amount < 2.6) {
      if (Math.abs(it.loc.s - ant.loc.s) < 3 && Math.abs(it.loc.u - ant.loc.u) < 3) {
        it.amount += cargo.amount;
        return;
      }
    }
  }
  world.addItem({
    id: world.nextId++,
    kind: "store",
    loc: { ...ant.loc },
    amount: cargo.amount,
    size: 2,
    variant: cargo.from === "insect" ? 1 : 0,
    since: world.day,
    carried: false,
    drop: 0,
    fall: 0,
    soggy: 0,
  });
}

function aphids(world: World, ant: Ant, t: Extract<Task, { kind: "aphids" }>): boolean {
  const r = world.rng;
  const c = world.colony;
  const f = world.season.yearFraction;
  switch (t.step) {
    case 0: {
      if (!world.canLeave || nearestExit(world, ant) < 0) {
        return false;
      }
      const h = world.surface.stemHeight(t.stem, f);
      if (h < 20 || !world.go(ant, { f: STEM - t.stem, s: h * r.range(0.62, 0.9), u: 0 })) {
        return false;
      }
      t.step = 1;
      return true;
    }
    case 1:
      world.stand(ant, r.range(7, 16), "tend");
      t.step = 2;
      return true;
    case 2: {
      ant.crop = world.canLeave ? 1 : 0.4;
      const spot = homeSpot(world, c.broodChamber, null);
      if (!spot || !world.go(ant, spot, spot.u)) {
        // Can't get home yet: wait on the plant.
        world.stand(ant, r.range(2, 4), "tend");
        return true;
      }
      t.step = 3;
      return true;
    }
    case 3: {
      // Mouth to mouth: the honeydew goes to a nestmate.
      const mate = world.ants.find(
        (a) =>
          a !== ant &&
          a.caste === "worker" &&
          a.loc.f === ant.loc.f &&
          !a.way &&
          a.wait < 1 &&
          Math.hypot(a.x - ant.x, a.y - ant.y) < 14,
      );
      if (mate) {
        face(ant, mate.x, mate.y);
        face(mate, ant.x, ant.y);
        world.stand(mate, 2.4, "feed");
      }
      world.stand(ant, 2.4, "feed");
      c.honey += 0.7 * ant.crop;
      ant.crop = 0;
      t.step = 4;
      return true;
    }
    default:
      return false;
  }
}

/** Whether a larva wants feeding now. */
function hungry(b: Brood): boolean {
  return (
    b.stage === "larva" && !b.carried && b.fed < LARVA_FOOD[b.caste] * Math.min(1, b.progress + 0.4)
  );
}

function nurse(world: World, ant: Ant, t: Extract<Task, { kind: "nurse" }>): boolean {
  const r = world.rng;
  const c = world.colony;
  const home = c.broodChamber;
  if (home < 0) {
    return false;
  }
  switch (t.step) {
    case 0: {
      if (t.spots >= 5) {
        return false;
      }
      // Brood lying anywhere but the brood chamber is gathered in, and brood
      // out of its heap is moved to the heap of its stage.
      let stray: Brood | null = null;
      let strayD = Infinity;
      for (const b of world.brood) {
        if (b.carried || (b.loc.f === home && !world.outOfHeap(b, home))) {
          continue;
        }
        const d = Math.abs(world.locateY(b.loc) - ant.y);
        if (d < strayD && world.count("gather") < 12) {
          strayD = d;
          stray = b;
        }
      }
      if (stray) {
        t.brood = stray.id;
        world.note("gather");
        if (!world.go(ant, stray.loc, stray.loc.u)) {
          return false;
        }
        t.step = 10;
        return true;
      }
      // A hungry larva, fed from the crop if there is honey, else from the store.
      const larvae = world.brood.filter((b) => b.loc.f === home && hungry(b));
      if (larvae.length > 0) {
        const larva = larvae[r.int(0, larvae.length - 1)];
        t.brood = larva.id;
        if (c.honey >= 0.25) {
          c.honey -= 0.25;
          ant.crop = Math.min(1, ant.crop + 0.5);
          if (!world.go(ant, beside(world, larva.loc, 1.5))) {
            return false;
          }
          t.step = 20;
          return true;
        }
        const stash = world.items.find((i) => i.kind === "store" && !i.carried && i.amount > 0.05);
        if (stash) {
          t.item = stash.id;
          if (!world.go(ant, beside(world, stash.loc, 1.2))) {
            return false;
          }
          t.step = 25;
          return true;
        }
      }
      // Otherwise tend the brood: lick it, turn it, keep it company.
      const here = world.brood.filter((b) => b.loc.f === home && !b.carried);
      if (here.length === 0) {
        return false;
      }
      const b = here[r.int(0, here.length - 1)];
      t.brood = b.id;
      if (!world.go(ant, beside(world, b.loc, 2))) {
        return false;
      }
      t.step = 30;
      return true;
    }
    case 10: {
      const b = world.broodOf(t.brood);
      if (!b || b.carried) {
        t.step = 0;
        t.spots++;
        return nurse(world, ant, t);
      }
      world.stand(ant, 0.7, "dig");
      t.step = 11;
      return true;
    }
    case 11: {
      const b = world.broodOf(t.brood);
      if (!b || b.carried) {
        t.step = 0;
        return nurse(world, ant, t);
      }
      const spot = world.pileSpot(home, b.stage, broodRadius(b));
      if (!spot) {
        return false;
      }
      b.carried = true;
      ant.cargo = { kind: "brood", id: b.id, amount: 0, x: 0, y: 0, from: null };
      if (!world.go(ant, spot, spot.u)) {
        b.carried = false;
        ant.cargo = null;
        return false;
      }
      t.step = 12;
      return true;
    }
    case 12:
      world.stand(ant, 0.5, "still");
      t.step = 13;
      return true;
    case 13: {
      const b = world.broodOf(t.brood);
      if (b) {
        b.loc = { ...ant.loc };
        b.carried = false;
        placeAtMouth(world, ant, b.loc);
      }
      ant.cargo = null;
      t.spots++;
      t.step = 0;
      return nurse(world, ant, t);
    }
    case 20: {
      const b = world.broodOf(t.brood);
      if (b) {
        face(ant, world.locateX(b.loc), world.locateY(b.loc));
      }
      world.stand(ant, r.range(1.6, 2.6), "feed");
      t.step = 21;
      return true;
    }
    case 21: {
      const b = world.broodOf(t.brood);
      if (b && b.stage === "larva") {
        b.fed += 0.25;
      }
      ant.crop = Math.max(0, ant.crop - 0.5);
      t.spots++;
      t.step = 0;
      return nurse(world, ant, t);
    }
    case 25: {
      const stash = world.itemOf(t.item);
      if (!stash || stash.amount < 0.05) {
        t.step = 0;
        t.spots++;
        return nurse(world, ant, t);
      }
      face(ant, world.locateX(stash.loc), world.locateY(stash.loc));
      world.stand(ant, r.range(1, 1.5), "dig");
      t.step = 26;
      return true;
    }
    case 26: {
      const stash = world.itemOf(t.item);
      const b = world.broodOf(t.brood);
      if (!stash || !b) {
        t.step = 0;
        t.spots++;
        return nurse(world, ant, t);
      }
      const take = Math.min(0.25, stash.amount);
      stash.amount -= take;
      if (stash.amount < 0.05) {
        world.useUp(stash);
      }
      ant.cargo = { kind: "food", id: -1, amount: take, x: 0, y: 0, from: "store" };
      if (!world.go(ant, beside(world, b.loc, 1.5))) {
        world.colony.honey += take;
        ant.cargo = null;
        return false;
      }
      t.step = 27;
      return true;
    }
    case 27: {
      const b = world.broodOf(t.brood);
      if (b) {
        face(ant, world.locateX(b.loc), world.locateY(b.loc));
      }
      world.stand(ant, r.range(1.6, 2.6), "feed");
      t.step = 28;
      return true;
    }
    case 28: {
      const b = world.broodOf(t.brood);
      const food = ant.cargo?.kind === "food" ? ant.cargo.amount : 0;
      if (b && b.stage === "larva") {
        b.fed += food;
      } else {
        world.colony.honey += food;
      }
      ant.cargo = null;
      t.spots++;
      t.step = 0;
      return nurse(world, ant, t);
    }
    case 30: {
      const b = world.broodOf(t.brood);
      if (b) {
        face(ant, world.locateX(b.loc), world.locateY(b.loc));
      }
      world.stand(ant, r.range(2.5, 6), "tend");
      t.spots++;
      t.step = 0;
      return true;
    }
    default:
      return false;
  }
}

/** Sets `loc` to just in front of the ant's head, where it lets go of what it carried. */
function placeAtMouth(world: World, ant: Ant, loc: Loc): void {
  if (ant.loc.f < 0) {
    return;
  }
  const reach = ant.size * 0.55;
  const x = ant.x + Math.cos(ant.heading) * reach;
  const y = ant.y + Math.sin(ant.heading) * reach;
  const feature = world.plan.features[ant.loc.f];
  if (feature.kind !== "chamber") {
    return;
  }
  const line = feature.line;
  const dir = Math.sign(line.x(line.length) - line.x(0)) || 1;
  const s = clamp((x - line.x(0)) * dir, 0.5, Math.max(0.5, world.nest.reachOf(ant.loc.f) - 0.5));
  const u = world.nest.clampU(ant.loc.f, s, (y - line.y(0)) * dir, 0.8);
  // Only where there is room: at the ragged edge of a chamber still being dug, it stays underfoot.
  const at = world.locate({ f: ant.loc.f, s, u }, { x: 0, y: 0 });
  const m = world.nest.material[cellIndex(at.x, at.y)];
  if (m === OPEN || m === AIR) {
    loc.s = s;
    loc.u = u;
  }
}

function haul(world: World, ant: Ant, t: Extract<Task, { kind: "haul" }>): boolean {
  const r = world.rng;
  const item = world.itemOf(t.item);
  switch (t.step) {
    case 0:
      if (!item || item.carried || !world.go(ant, beside(world, item.loc, 1))) {
        return false;
      }
      t.step = 1;
      return true;
    case 1:
      if (!item || item.carried) {
        return false;
      }
      world.stand(ant, 0.6, "dig");
      t.step = 2;
      return true;
    case 2: {
      if (!item || item.carried) {
        return false;
      }
      const p = nearestExit(world, ant);
      if (p < 0 || !world.canLeave) {
        return false;
      }
      // Out onto the midden, a little way from the door.
      const x = dumpX(world, p, 26, 46);
      item.carried = true;
      ant.cargo = {
        kind: item.kind === "husk" ? "husk" : "scrap",
        id: item.id,
        amount: 1,
        x: 0,
        y: 0,
        from: null,
      };
      if (!world.go(ant, { f: SURFACE, s: x, u: 0 })) {
        item.carried = false;
        ant.cargo = null;
        return false;
      }
      t.step = 3;
      return true;
    }
    case 3:
      world.stand(ant, r.range(0.3, 0.6), "still");
      t.step = 4;
      return true;
    case 4:
      if (item) {
        item.loc = { f: SURFACE, s: ant.x + Math.cos(ant.heading) * ant.size * 0.5, u: 0 };
        item.since = world.day;
        item.carried = false;
      }
      ant.cargo = null;
      return false;
    default:
      return false;
  }
}

function guard(world: World, ant: Ant, t: Extract<Task, { kind: "guard" }>): boolean {
  switch (t.step) {
    case 0: {
      const portals = world.plan.portals;
      const dug = portals.map((_, i) => i).filter((i) => world.nest.portalDug(i));
      if (dug.length === 0) {
        return false;
      }
      const p = dug[world.rng.int(0, dug.length - 1)];
      t.portal = p;
      // Just below where a plug would go, so a door shut for the rain never shuts a guard in.
      const spot = insidePlug(world, p);
      if (!world.go(ant, spot)) {
        return false;
      }
      t.step = 1;
      return true;
    }
    case 1: {
      const portal = world.plan.portals[t.portal];
      const line = world.plan.features[portal.feature].line;
      face(ant, line.x(portal.s), line.y(portal.s));
      world.stand(ant, world.rng.range(10, 30), "still");
      t.step = 2;
      return true;
    }
    default:
      return false;
  }
}

function attend(world: World, ant: Ant, t: Extract<Task, { kind: "attend" }>): boolean {
  const q = world.queen;
  if (!q || q.loc.f < 0) {
    return false;
  }
  switch (t.step) {
    case 0: {
      const r = world.rng;
      const side = r.chance(0.5) ? 1 : -1;
      const spot = {
        f: q.loc.f,
        s: q.loc.s + side * r.range(5, 9),
        u: q.loc.u + r.range(-2.5, 2.5),
      };
      if (!world.go(ant, spot, spot.u)) {
        return false;
      }
      t.step = 1;
      return true;
    }
    case 1:
      face(ant, q.x, q.y);
      world.stand(ant, world.rng.range(5, 14), "antennate");
      t.step = 2;
      return true;
    default:
      return false;
  }
}

function winter(world: World, ant: Ant, t: Extract<Task, { kind: "winter" }>): boolean {
  const c = world.colony;
  switch (t.step) {
    case 0: {
      if (c.dormancy < 0.5 || c.broodChamber < 0) {
        return false;
      }
      // Huddled together with the queen and the brood.
      const spot = world.pileSpot(c.broodChamber, "larva", 2.2);
      if (!spot || !world.go(ant, spot, spot.u)) {
        world.stand(ant, 20, "still");
        t.step = 2;
        return true;
      }
      t.step = 1;
      return true;
    }
    case 1:
      world.stand(ant, world.rng.range(25, 70), world.rng.chance(0.15) ? "groom" : "still");
      t.step = 2;
      return true;
    default:
      return false;
  }
}

function queen(world: World, ant: Ant, t: Extract<Task, { kind: "queen" }>): boolean {
  const c = world.colony;
  const r = world.rng;
  const home = c.broodChamber;
  switch (t.step) {
    case 0: {
      if (home >= 0 && (ant.loc.f !== home || t.rounds === 0)) {
        const spot = world.pileSpot(home, "egg", 3);
        if (spot && world.go(ant, spot, spot.u)) {
          t.step = 1;
          return true;
        }
      }
      t.step = 1;
      return queen(world, ant, t);
    }
    case 1: {
      t.rounds++;
      if (t.rounds > 8) {
        return false;
      }
      if (c.eggsDue >= 1 && c.dormancy < 0.5 && ant.loc.f === home) {
        world.stand(ant, r.range(1.8, 3), "lay");
        t.step = 2;
        return true;
      }
      // Raising the first brood alone, she feeds and tends it herself.
      if (c.stage === "claustral") {
        const larvae = world.brood.filter(hungry);
        if (larvae.length > 0 && c.reserve > 0.05) {
          const b = larvae[r.int(0, larvae.length - 1)];
          t.brood = b.id;
          if (world.go(ant, beside(world, b.loc, 2.5))) {
            t.step = 10;
            return true;
          }
        }
        if (world.brood.length > 0 && r.chance(0.6)) {
          const b = world.brood[r.int(0, world.brood.length - 1)];
          t.brood = b.id;
          if (world.go(ant, beside(world, b.loc, 3))) {
            t.step = 12;
            return true;
          }
        }
      }
      world.stand(ant, r.range(4, 12), r.chance(0.25) ? "groom" : "still");
      t.step = r.chance(0.2) ? 0 : 1;
      return true;
    }
    case 2:
      world.layEgg(ant);
      t.step = 1;
      return queen(world, ant, t);
    case 10: {
      const b = world.broodOf(t.brood);
      if (b) {
        face(ant, world.locateX(b.loc), world.locateY(b.loc));
      }
      world.stand(ant, r.range(2, 3), "feed");
      t.step = 11;
      return true;
    }
    case 11: {
      const b = world.broodOf(t.brood);
      if (b && b.stage === "larva") {
        const give = Math.min(0.4, c.reserve);
        b.fed += give;
        c.reserve -= give;
      }
      t.step = 1;
      return queen(world, ant, t);
    }
    case 12: {
      const b = world.broodOf(t.brood);
      if (b) {
        face(ant, world.locateX(b.loc), world.locateY(b.loc));
      }
      world.stand(ant, r.range(3, 7), "tend");
      t.step = 1;
      return true;
    }
    default:
      return false;
  }
}

function found(world: World, ant: Ant, t: Extract<Task, { kind: "found" }>): boolean {
  const r = world.rng;
  const entrance = world.plan.portals[0].x;
  if (ant.loc.f === AIR_LOC) {
    // Still coming down; flight carries her.
    return true;
  }
  switch (t.step) {
    case 0:
      world.stand(ant, r.range(1.2, 2), "still");
      t.step = 1;
      return true;
    case 1:
      // Legs to the wing bases, and off they come.
      world.stand(ant, r.range(1.8, 2.6), "shed");
      t.step = 2;
      return true;
    case 2:
      if (ant.winged) {
        ant.winged = false;
        world.events.push({ kind: "shed", x: ant.x, y: ant.y });
        for (const side of [-1, 1]) {
          world.addItem({
            id: world.nextId++,
            kind: "wing",
            loc: { f: SURFACE, s: ant.x + side * r.range(2, 5), u: 0 },
            amount: 1,
            size: 11,
            variant: r.int(0, 1 << 16),
            since: world.day,
            carried: false,
            drop: r.range(3, 8),
            fall: 0,
            soggy: 0,
          });
        }
      }
      world.stand(ant, r.range(0.8, 1.4), "groom");
      t.step = 3;
      return true;
    case 3: {
      // A few stops to feel the ground, the last where she digs.
      t.hops++;
      const x = t.hops >= 3 ? entrance : entrance + r.range(-14, 14);
      if (!world.go(ant, { f: SURFACE, s: x, u: 0 })) {
        return false;
      }
      t.step = 4;
      return true;
    }
    case 4:
      world.stand(ant, r.range(0.8, 2.2), "groom");
      t.step = t.hops >= 3 ? 5 : 3;
      return true;
    case 5:
      world.colony.stage = "founding";
      return false;
    default:
      return false;
  }
}

function fly(world: World, ant: Ant, t: Extract<Task, { kind: "fly" }>): boolean {
  const r = world.rng;
  const f = world.season.yearFraction;
  switch (t.step) {
    case 0: {
      if (!world.flightDue() || nearestExit(world, ant) < 0) {
        return false;
      }
      const h = world.surface.stemHeight(t.stem, f);
      const top = { f: STEM - t.stem, s: Math.max(4, h - 3), u: 0 };
      const target = h > 20 ? top : { f: SURFACE, s: ant.x + r.range(-20, 20), u: 0 };
      if (!world.go(ant, target)) {
        return false;
      }
      t.step = 1;
      return true;
    }
    case 1:
      world.stand(ant, r.range(1.5, 6), "still");
      t.step = 2;
      return true;
    case 2: {
      // The afternoon passed while it waited, or the weather turned: back down and in.
      if (!world.flightDue()) {
        return false;
      }
      // Away.
      ant.loc = { f: AIR_LOC, s: ant.x, u: ant.y };
      const side = r.chance(0.5) ? 1 : -1;
      ant.vx = side * r.range(12, 40);
      ant.vy = r.range(26, 50);
      ant.heading = Math.atan2(ant.vy, ant.vx);
      ant.task = null;
      world.events.push({ kind: "takeoff", x: ant.x, y: ant.y });
      const left = world.ants.some(
        (a) => a !== ant && a.winged && a.caste !== "queen" && a.loc.f !== AIR_LOC,
      );
      if (!left) {
        world.colony.flownYear = world.year;
      }
      return true;
    }
    default:
      return false;
  }
}
