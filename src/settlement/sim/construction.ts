import { GONE, STANDING, STUMP } from "./forest.ts";
import { type Building, KINDS } from "./buildings.ts";
import { plowField, reapField } from "./farming.ts";
import { FENCE_WORK } from "./fence.ts";
import { douse } from "./fire.ts";
import { TOIL } from "./pace.ts";
import type { Person } from "./people.ts";
import type { Act } from "./tasks.ts";
import type { World } from "./world.ts";

/** Seconds of quarrying for a block of stone. */
const QUARRY_BLOCK = 10;
/** Seconds of laying cobbles (before `TOIL`) per meter of street. */
const PAVE_RATE = 0.9;
/** How much of a building goes up before any materials arrive (setting out, digging footings). */
const BARE_WORK = 0.08;

/** Logs and stones a building still wants brought. */
export function wants(b: Building): { wood: number; stone: number } {
  if (b.phase !== "building" && b.phase !== "clearing") {
    return { wood: 0, stone: 0 };
  }
  const spec = KINDS[b.kind];
  return { wood: Math.max(0, spec.wood - b.wood), stone: Math.max(0, spec.stone - b.stone) };
}

/** How far a building may go up with the materials at hand. */
export function buildable(b: Building): number {
  const spec = KINDS[b.kind];
  const wood = spec.wood > 0 ? b.wood / spec.wood : 1;
  const stone = spec.stone > 0 ? b.stone / spec.stone : 1;
  return BARE_WORK + (1 - BARE_WORK) * Math.min(wood, stone);
}

/** Whether a builder can work on it now. */
export function workable(b: Building): boolean {
  if (b.phase !== "building") {
    return false;
  }
  const most = buildable(b);
  // With everything at hand, the last of the work can always be done.
  return most >= 1 ? b.progress < 1 : b.progress < most - 0.002;
}

/** A log or a stone brought to a building's site; false if it no longer wants it. */
export function deliver(world: World, id: number, stuff: "wood" | "stone"): boolean {
  const b = world.building(id);
  if (!b || wants(b)[stuff] <= 0) {
    // Nowhere to put it: back on the stock.
    world.stock[stuff] += 1;
    return true;
  }
  b[stuff] += 1;
  const d = world.door(b);
  world.sound(stuff === "wood" ? "logs" : "stones", d.x, d.y, b.base + 0.5);
  return true;
}

/**
 * Work that changes the world as it goes, `dt` real seconds of it; false
 * when it can no longer go on.
 */
export function applyWork(world: World, p: Person, act: Act, dt: number, done: boolean): boolean {
  // What `dt` seconds of building work get done.
  const work = dt / TOIL;
  switch (act.kind) {
    case "fell": {
      if (world.forest.state[act.tree] !== STANDING) {
        return false;
      }
      if (done) {
        const tree = world.forest.trees[act.tree];
        world.fell(act.tree);
        // Timber the settlement can use is logged; more than that is heaped as brush and burned.
        let lying = 0;
        for (const q of world.piles) {
          if (q.kind === "logs") {
            lying += q.count;
          }
        }
        const surplus = world.stock.wood + lying > world.council.woodWanted(world) * 1.2 + 10;
        world.piles.push({
          id: world.nextId++,
          kind: surplus ? "brush" : "logs",
          x: tree.x + Math.sin(p.heading) * 1.5,
          y: tree.y - Math.cos(p.heading) * 1.5,
          count: surplus ? 0 : Math.max(3, Math.round(tree.height / 2.4)),
          angle: p.heading,
          burn: surplus ? world.rng.range(50, 90) : 0,
        });
      }
      return true;
    }
    case "grub": {
      if (world.forest.state[act.tree] !== STUMP) {
        return false;
      }
      if (done) {
        world.grub(act.tree);
        noteCleared(world);
      }
      return true;
    }
    case "build": {
      const b = world.building(act.building);
      if (!b || !workable(b)) {
        return false;
      }
      const spec = KINDS[b.kind];
      b.progress = Math.min(buildable(b), b.progress + work / spec.labor);
      if (b.progress >= 1 - 1e-9) {
        complete(world, b);
        return false;
      }
      return true;
    }
    case "demolish": {
      const b = world.building(act.building);
      if (!b || b.phase !== "demolish") {
        return false;
      }
      b.progress -= work / (KINDS[b.kind].labor * 0.35);
      if (b.progress <= 0) {
        replace(world, b);
        return false;
      }
      return true;
    }
    case "clear": {
      const b = world.building(act.building);
      if (!b || b.phase !== "ruin" || b.fire > 0.02) {
        return false;
      }
      b.cleared = Math.min(1, b.cleared + work / (20 + KINDS[b.kind].labor * 0.25));
      if (b.cleared >= 1) {
        world.town.remove(b);
        world.council.ruinCleared(world, b);
        return false;
      }
      return true;
    }
    case "plow":
      return plowField(world, act.field, dt);
    case "reap":
      return reapField(world, act.field, dt);
    case "quarry": {
      world.council.quarried += dt;
      if (world.council.quarried >= QUARRY_BLOCK) {
        world.council.quarried -= QUARRY_BLOCK;
        world.stock.stone += 1;
      }
      return true;
    }
    case "douse":
      return douse(world, act.building, dt);
    case "pave": {
      const council = world.council;
      const paving = council.paving;
      if (!paving || paving.street !== act.street) {
        return false;
      }
      paving.done += work / PAVE_RATE;
      return true;
    }
    case "fence": {
      const state = world.town.pastures[act.pasture];
      if (state.fenced) {
        return false;
      }
      world.council.fencing += work;
      if (world.council.fencing >= FENCE_WORK) {
        world.council.fencing = 0;
        state.fenced = true;
        const r = world.plan.pastures[act.pasture].rect;
        world.groundChanged(r.x, r.y, Math.hypot(r.width, r.depth) / 2 + 1);
      }
      return true;
    }
    case "repair": {
      const b = world.building(act.building);
      if (!b || b.phase !== "standing" || b.fire > 0.02 || (b.damage <= 0 && b.char <= 0)) {
        return false;
      }
      const rate = work / (20 + KINDS[b.kind].labor * 0.3);
      b.damage = Math.max(0, b.damage - rate);
      b.char = Math.max(0, b.char - rate * 1.2);
      return true;
    }
    case "strike": {
      const m = world.monsters.find((q) => q.id === act.monster);
      if (!m || m.state === "flee" || Math.hypot(m.x - p.x, m.y - p.y) > 2.4) {
        return false;
      }
      if (done) {
        m.spirit -= m.kind === "ogre" ? 0.08 : 0.2;
        m.pose = "hurt";
        m.poseTime = 0;
        world.sound("hit", m.x, m.y, m.z + 0.8);
      }
      return true;
    }
    case "shoot": {
      if (done) {
        const dx = act.x - p.x;
        const dy = act.y - p.y;
        const dz = act.z - (p.z + 1.5);
        const d = Math.hypot(dx, dy, dz) || 1;
        const speed = act.bolt ? 26 : 30;
        const flight = d / speed;
        world.missiles.push({
          id: world.nextId++,
          kind: act.bolt ? "bolt" : "arrow",
          x: p.x,
          y: p.y,
          z: p.z + 1.5,
          vx: dx / flight,
          vy: dy / flight,
          vz: dz / flight + (act.bolt ? 0 : 4.9 * flight),
          age: 0,
          at: -1,
        });
        world.sound(act.bolt ? "magic" : "bow", p.x, p.y, p.z + 1.5);
      }
      return true;
    }
    case "grade":
    case "craft":
      return true;
  }
}

/** Moves buildings whose ground is clear from clearing on to building. */
export function noteCleared(world: World): void {
  const state = world.forest.state;
  for (const b of world.town.buildings) {
    if (b.phase !== "clearing") {
      continue;
    }
    b.clearing = b.clearing.filter((id) => state[id] !== GONE);
    if (b.clearing.length === 0) {
      b.phase = "building";
      b.progress = 0;
      world.town.touched();
    }
  }
}

/** A building finished: it stands, and the town takes note (new homes, new jobs, new yards). */
export function complete(world: World, b: Building): void {
  b.phase = "standing";
  b.progress = 1;
  b.wood = 0;
  b.stone = 0;
  b.replacing = false;
  b.rebuilding = false;
  const d = world.door(b);
  world.sound("hammer", d.x, d.y, b.base + 1);
  if (b.site.type === "lot") {
    const lot = world.plan.lots[b.site.lot];
    const spec = KINDS[b.kind];
    // Houses get a trodden yard and, out of town, a garden behind.
    const ground = spec.housing > 0 && lot.rect.depth - b.rect.depth > 5 ? 2 : 1;
    if (world.town.lotGround[lot.id] !== ground) {
      world.town.lotGround[lot.id] = ground;
      world.groundChanged(
        lot.rect.x,
        lot.rect.y,
        Math.hypot(lot.rect.width, lot.rect.depth) / 2 + 1,
      );
    }
  }
  if (b.kind === "bridge" || b.kind === "stonebridge") {
    world.nav.bridged = true;
  }
  world.council.built(world, b);
}

/**
 * An old building taken down: the one that replaces it is started on the
 * same site, with some of the old wood saved.
 */
function replace(world: World, old: Building): void {
  const town = world.town;
  const next = old.next;
  town.remove(old);
  world.stock.wood += Math.floor(KINDS[old.kind].wood * 0.3);
  if (next) {
    const b = world.found(next, old.site, world.council.era, "building");
    b.replacing = true;
    world.council.adopt(world, old, b);
  }
}
