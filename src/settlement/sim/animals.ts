import { clamp } from "../../shared/core/math.ts";
import { inRect, type Rect, rectPoint } from "./geometry.ts";
import { yearOf } from "./farming.ts";
import type { Point } from "./terrain.ts";
import type { World } from "./world.ts";

export type AnimalKind = "sheep" | "cow" | "chicken" | "dog" | "crow" | "duck" | "ox";

/**
 * An animal: where it belongs (a pasture, a yard, the person it follows,
 * the river, a field), where it is going, and how afraid it is.
 */
export interface Animal {
  id: number;
  kind: AnimalKind;
  x: number;
  y: number;
  z: number;
  heading: number;
  /** What it keeps to: a pasture or lot (by id), a person it follows, or nothing (the wild ones). */
  home: { type: "pasture" | "lot" | "person" | "wild"; id: number };
  tx: number;
  ty: number;
  /** Seconds till it moves on. */
  wait: number;
  pose: "stand" | "walk" | "run" | "graze" | "fly" | "sit" | "swim";
  poseTime: number;
  /** Seconds of fright left, and what it flees from. */
  fear: number;
  fx: number;
  fy: number;
  /** Height above the ground (m), for birds in flight. */
  lift: number;
  /** Seconds till its next call. */
  call: number;
  /** Whether it is indoors for the night (hens), out of sight. */
  hidden: boolean;
  /** An ox's cart and what is loaded on it: how many logs or stones, or sacks for a trader. */
  load: number;
  cargo: "logs" | "stones" | "sacks";
  /** The way it is being driven along to where it belongs, by street and ford. */
  way: Point[];
  /** Seconds till a wary bird looks round again. */
  look: number;
  /** Whether a wild bird is flying off for good. */
  leaving: boolean;
}

/** Seconds between a crow's looks round. */
const LOOK_EVERY = 0.3;
/** Most an ox goes (m/s), trotting to catch up with its carter. */
const OX_TROT = 2.2;
/** Meters across and back of the ground round the camp the first hens scratch about. */
const CAMP_YARD = { width: 14, depth: 10 } as const;

/** Speeds (m/s) walking, running. */
const SPEED: Record<AnimalKind, readonly [number, number]> = {
  sheep: [0.5, 2.8],
  cow: [0.45, 1.8],
  chicken: [0.5, 2.2],
  dog: [1.3, 3.6],
  crow: [0.6, 7],
  duck: [0.35, 1.2],
  ox: [1.15, 1.6],
};

export function newAnimal(
  world: World,
  kind: AnimalKind,
  x: number,
  y: number,
  home: Animal["home"],
): Animal {
  const a: Animal = {
    id: world.nextId++,
    kind,
    x,
    y,
    z: world.groundAt(x, y),
    heading: world.rng.range(-Math.PI, Math.PI),
    home,
    tx: x,
    ty: y,
    wait: world.rng.range(0, 4),
    pose: "stand",
    poseTime: world.rng.range(0, 2),
    fear: 0,
    fx: 0,
    fy: 0,
    lift: 0,
    call: world.rng.range(5, 40),
    hidden: false,
    load: 0,
    cargo: "logs",
    way: [],
    look: 0,
    leaving: false,
  };
  world.animals.push(a);
  return a;
}

/** The rect an animal keeps to, if it keeps to one. */
function range(world: World, a: Animal): Rect | null {
  if (a.home.type === "pasture") {
    return world.town.pastures[a.home.id]?.fenced ? world.plan.pastures[a.home.id].rect : null;
  }
  if (a.home.type === "lot") {
    return world.plan.lots[a.home.id]?.rect ?? null;
  }
  if (a.home.type === "wild" && a.kind === "chicken") {
    const c = world.plan.center;
    return { x: c.x, y: c.y, angle: 0, width: CAMP_YARD.width, depth: CAMP_YARD.depth };
  }
  if (a.home.type === "wild" && (a.kind === "sheep" || a.kind === "cow")) {
    // The first flock grazes the open meadow nearest the camp, where a pasture is to be fenced.
    const c = world.plan.center;
    let meadow: Rect | null = null;
    let best = Infinity;
    for (const q of world.plan.pastures) {
      const d = Math.hypot(q.rect.x - c.x, q.rect.y - c.y);
      if (d < best) {
        best = d;
        meadow = q.rect;
      }
    }
    return meadow;
  }
  return null;
}

export function updateAnimals(world: World, dt: number): void {
  // From the end, as an ox or a bird that has gone leaves the list as it goes.
  for (let i = world.animals.length - 1; i >= 0; i--) {
    const a = world.animals[i];
    a.poseTime += dt;
    switch (a.kind) {
      case "crow":
        crow(world, a, dt);
        break;
      case "duck":
        duck(world, a, dt);
        break;
      case "dog":
        dog(world, a, dt);
        break;
      case "ox":
        ox(world, a, dt);
        break;
      default:
        grazer(world, a, dt);
    }
    if (a.lift <= 0) {
      a.z = world.groundAt(a.x, a.y);
    }
  }
  wildlife(world);
}

/** Moves an animal toward (tx, ty) at `speed`; true once there. */
function toward(world: World, a: Animal, speed: number, dt: number, keepDry = true): boolean {
  const dx = a.tx - a.x;
  const dy = a.ty - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) {
    return true;
  }
  const move = Math.min(d, speed * dt);
  const nx = a.x + (dx / d) * move;
  const ny = a.y + (dy / d) * move;
  if (keepDry && world.terrain.isWater(nx, ny)) {
    a.tx = a.x;
    a.ty = a.y;
    return true;
  }
  a.x = nx;
  a.y = ny;
  a.heading = Math.atan2(dx, -dy);
  return move >= d - 1e-6;
}

/**
 * Walks an animal along the streets toward (x, y), fording the river where
 * people do; true once there.
 */
function travel(world: World, a: Animal, x: number, y: number, speed: number, dt: number): boolean {
  if (a.way.length === 0) {
    a.way = world.nav.path(a.x, a.y, x, y);
    if (a.way.length === 0) {
      return true;
    }
  }
  a.tx = a.way[0].x;
  a.ty = a.way[0].y;
  if (toward(world, a, speed, dt, false)) {
    a.way.shift();
  }
  a.pose = "walk";
  return a.way.length === 0;
}

/** Sheep, cows and hens: graze or peck about their pasture or yard, and scatter when frightened. */
function grazer(world: World, a: Animal, dt: number): void {
  const [walk, run] = SPEED[a.kind];
  const area = range(world, a);
  const night = world.env.darkness > 0.6;
  // Hens go in at dusk: back to the door of their house, and in.
  if (a.kind === "chicken") {
    if (!night || a.fear > 0) {
      a.hidden = false;
    } else if (!a.hidden) {
      const coop = a.home.type === "lot" ? world.plan.lots[a.home.id]?.door : null;
      if (!coop || Math.hypot(coop.x - a.x, coop.y - a.y) < 0.6) {
        a.hidden = true;
      } else {
        a.tx = coop.x;
        a.ty = coop.y;
        toward(world, a, walk * 1.4, dt);
        a.pose = "walk";
      }
      return;
    }
    if (a.hidden) {
      return;
    }
  }
  if (a.fear > 0) {
    a.fear -= dt;
    const dx = a.x - a.fx;
    const dy = a.y - a.fy;
    const d = Math.hypot(dx, dy) || 1;
    a.tx = a.x + (dx / d) * 4;
    a.ty = a.y + (dy / d) * 4;
    if (area) {
      const inside = inRect(area, a.tx, a.ty, -0.5);
      if (!inside) {
        // Along the fence, away from it.
        a.tx = a.x - (dy / d) * 3;
        a.ty = a.y + (dx / d) * 3;
      }
    }
    toward(world, a, run, dt);
    a.pose = "run";
    if (a.call <= 0) {
      a.call = 1.2;
      world.sound(
        a.kind === "sheep" ? "bleat" : a.kind === "cow" ? "moo" : "cluck",
        a.x,
        a.y,
        a.z + 0.6,
      );
    }
    a.call -= dt;
    return;
  }
  a.call -= dt;
  if (a.call <= 0) {
    a.call = world.rng.range(18, 70);
    if (!night) {
      world.sound(
        a.kind === "sheep" ? "bleat" : a.kind === "cow" ? "moo" : "cluck",
        a.x,
        a.y,
        a.z + 0.6,
      );
    }
  }
  // Strayed, or just come up the road with new settlers: back to its own ground by the ways people walk.
  if (area && (a.way.length > 0 || !inRect(area, a.x, a.y, 1.5))) {
    if (travel(world, a, area.x, area.y, walk * 1.5, dt)) {
      a.wait = 0;
      a.tx = a.x;
      a.ty = a.y;
    }
    return;
  }
  a.wait -= dt;
  if (a.wait > 0) {
    a.pose =
      a.kind === "chicken" ? (a.poseTime % 1.4 < 0.4 ? "graze" : "stand") : night ? "sit" : "graze";
    return;
  }
  if (toward(world, a, walk, dt)) {
    a.wait = world.rng.range(3, 12);
    a.pose = "graze";
    a.poseTime = 0;
    // Somewhere new to graze, inside its pasture or yard (or near where it stands).
    if (area) {
      const p = rectPoint(
        area,
        world.rng.range(-0.45, 0.45) * area.width,
        world.rng.range(-0.45, 0.45) * area.depth,
      );
      a.tx = p.x;
      a.ty = p.y;
    } else {
      a.tx = a.x + world.rng.range(-3, 3);
      a.ty = a.y + world.rng.range(-3, 3);
    }
  } else {
    a.pose = "walk";
  }
}

/** A dog: at its person's heels when they are out, lying by the door when not; barks at raiders. */
function dog(world: World, a: Animal, dt: number): void {
  const [walk, run] = SPEED.dog;
  const owner = world.person(a.home.id);
  a.call -= dt;
  for (const m of world.monsters) {
    if (Math.hypot(m.x - a.x, m.y - a.y) < 25) {
      a.fear = 2;
      a.fx = m.x;
      a.fy = m.y;
      if (a.call <= 0) {
        a.call = 0.8;
        world.sound("bark", a.x, a.y, a.z + 0.5);
      }
    }
  }
  if (!owner) {
    // Its person has gone down the road: it takes up with whoever is nearest.
    let best = Infinity;
    for (const p of world.people) {
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      if (!p.leaving && d < best) {
        best = d;
        a.home = { type: "person", id: p.id };
      }
    }
    return;
  }
  if (a.fear > 0) {
    a.fear -= dt;
    a.pose = "stand";
    a.heading = Math.atan2(a.fx - a.x, -(a.fy - a.y));
    return;
  }
  // Follow at a little distance.
  const ox = owner.x - Math.sin(owner.heading) * 1.4 + Math.cos(owner.heading) * 0.6;
  const oy = owner.y + Math.cos(owner.heading) * 1.4 + Math.sin(owner.heading) * 0.6;
  const far = Math.hypot(ox - a.x, oy - a.y);
  if (far > 1) {
    a.tx = ox;
    a.ty = oy;
    // Through the ford after them, as dogs do.
    toward(world, a, far > 6 ? run : walk * 1.3, dt, false);
    a.pose = far > 6 ? "run" : "walk";
  } else {
    a.pose = owner.inside >= 0 ? "sit" : "stand";
  }
  if (a.call <= 0) {
    a.call = world.rng.range(40, 120);
    if (owner.inside < 0 && world.env.darkness < 0.5) {
      world.sound("bark", a.x, a.y, a.z + 0.5);
    }
  }
}

/**
 * An ox and its cart: led by its carter, a few steps behind; standing in the
 * yard while the carter is indoors; gone with a trader who leaves.
 */
function ox(world: World, a: Animal, dt: number): void {
  const driver = world.person(a.home.id);
  const carter = a.cargo !== "sacks";
  if (!driver && !carter) {
    // Its trader has gone down the road, and the cart with them.
    world.animals.splice(world.animals.indexOf(a), 1);
    return;
  }
  if (!driver || (carter && driver.job !== "hauler")) {
    // Its carter gone to other work: the cart goes back to the yard, is unloaded and put up there.
    const yard = world.depot("wood");
    if (travel(world, a, yard.x, yard.y, SPEED.ox[0], dt)) {
      if (a.load > 0) {
        world.stock[a.cargo === "stones" ? "stone" : "wood"] += a.load;
      }
      world.animals.splice(world.animals.indexOf(a), 1);
    }
    return;
  }
  if (driver.inside >= 0) {
    a.pose = "stand";
    return;
  }
  // Beside the carter, who walks at its head holding the halter; the cart trails behind.
  const fx = Math.sin(driver.heading);
  const fy = -Math.cos(driver.heading);
  const tx = driver.x + fx * 0.2 - fy * 0.9;
  const ty = driver.y + fy * 0.2 + fx * 0.9;
  const d = Math.hypot(tx - a.x, ty - a.y);
  if (d > 0.08) {
    a.tx = tx;
    a.ty = ty;
    toward(world, a, Math.min(OX_TROT, Math.max(SPEED.ox[0], d * 3)), dt, false);
    a.pose = "walk";
    if (a.poseTime > 2.5 && world.rng.chance(dt * 0.4)) {
      a.poseTime = 0;
      world.sound("cart", a.x, a.y, a.z + 0.5);
    }
  } else {
    a.pose = "stand";
  }
}

/** Crows: flocking down onto the fields to pick at them, and up and away when someone comes near. */
function crow(world: World, a: Animal, dt: number): void {
  const [walk, fly] = SPEED.crow;
  if (a.leaving) {
    // Off over the woods, and gone.
    a.lift = Math.min(12, a.lift + dt * 4);
    a.z = world.groundAt(a.x, a.y) + a.lift;
    a.pose = "fly";
    if (toward(world, a, fly, dt, false)) {
      world.animals.splice(world.animals.indexOf(a), 1);
    }
    return;
  }
  // A look round for anyone coming near, a few times a second.
  let near = false;
  a.look -= dt;
  if (a.look <= 0 && a.lift <= 0) {
    a.look = LOOK_EVERY;
    for (const p of world.people) {
      if (
        p.inside < 0 &&
        Math.abs(p.x - a.x) < 6 &&
        Math.abs(p.y - a.y) < 6 &&
        Math.hypot(p.x - a.x, p.y - a.y) < 6
      ) {
        near = true;
        break;
      }
    }
  }
  if (a.lift > 0 || near) {
    if (near && a.lift <= 0) {
      // Up they go, off to another field.
      a.lift = 0.5;
      const fields = world.plan.fields.filter((f) => world.town.fields[f.id].cleared);
      const target = fields.length > 0 ? world.rng.pick(fields).rect : null;
      a.tx = target ? target.x + world.rng.range(-4, 4) : a.x + world.rng.range(-40, 40);
      a.ty = target ? target.y + world.rng.range(-8, 8) : a.y + world.rng.range(-40, 40);
      world.sound("takeoff", a.x, a.y, a.z + 1);
    }
    const there = toward(world, a, fly, dt, false);
    const d = Math.hypot(a.tx - a.x, a.ty - a.y);
    a.lift = there ? 0 : Math.min(9, 1 + d * 0.4);
    a.z = world.groundAt(a.x, a.y) + a.lift;
    a.pose = a.lift > 0 ? "fly" : "stand";
    return;
  }
  a.wait -= dt;
  if (a.wait <= 0) {
    a.wait = world.rng.range(1, 4);
    a.tx = a.x + world.rng.range(-1.5, 1.5);
    a.ty = a.y + world.rng.range(-1.5, 1.5);
  }
  a.pose = toward(world, a, walk, dt) ? (a.poseTime % 1 < 0.3 ? "graze" : "stand") : "walk";
  a.call -= dt;
  if (a.call <= 0) {
    a.call = world.rng.range(10, 40);
    world.sound("caw", a.x, a.y, a.z);
  }
}

/** Ducks: paddling about on the river, drifting a little with it. */
function duck(world: World, a: Animal, dt: number): void {
  const t = world.terrain;
  a.wait -= dt;
  if (a.wait <= 0) {
    a.wait = world.rng.range(3, 9);
    const y = clamp(a.y + world.rng.range(-6, 6), a.home.id - 30, a.home.id + 30);
    const half = t.riverHalfWidth(y) - 0.8;
    a.tx = t.riverX(y) + world.rng.range(-half, half);
    a.ty = y;
  }
  const dx = a.tx - a.x;
  const dy = a.ty - a.y;
  const d = Math.hypot(dx, dy);
  if (d > 0.05) {
    const move = Math.min(d, SPEED.duck[0] * dt);
    a.x += (dx / d) * move;
    a.y += (dy / d) * move - 0.05 * dt;
    a.heading = Math.atan2(dx, -dy);
  }
  a.lift = 0.01;
  a.z = t.waterLevel(a.y);
  a.pose = "swim";
  a.call -= dt;
  if (a.call <= 0) {
    a.call = world.rng.range(25, 90);
    if (world.env.darkness < 0.5) {
      world.sound("quack", a.x, a.y, a.z + 0.2);
    }
  }
}

/** Chance each step that the crows are counted and one flock more comes or one crow goes. */
const WILDLIFE_LOOK = 0.01;

/** The wild birds come and go: a few crows about the sown fields, a pair of ducks on the river. */
function wildlife(world: World): void {
  if (!world.animals.some((a) => a.kind === "duck")) {
    const y = world.plan.center.y + 40;
    const x = world.terrain.riverX(y);
    for (let k = 0; k < 2; k++) {
      newAnimal(world, "duck", x + k * 0.8, y + k, { type: "wild", id: Math.round(y) });
    }
  }
  if (!world.rng.chance(WILDLIFE_LOOK)) {
    return;
  }
  let crows = 0;
  for (const a of world.animals) {
    if (a.kind === "crow" && !a.leaving) {
      crows++;
    }
  }
  const year = yearOf(world);
  const sown = world.plan.fields.filter(
    (f) => world.town.fields[f.id].cleared && world.town.fields[f.id].sownYear === year,
  );
  const want = world.env.darkness > 0.5 ? 0 : Math.min(9, sown.length * 2);
  if (crows < want && world.rng.chance(0.4)) {
    const f = world.rng.pick(sown).rect;
    const flock = world.rng.int(2, 4);
    for (let k = 0; k < flock; k++) {
      const c = newAnimal(world, "crow", f.x + world.rng.range(-50, 50), f.y + 40, {
        type: "wild",
        id: -1,
      });
      c.lift = 8;
      c.tx = f.x + world.rng.range(-4, 4);
      c.ty = f.y + world.rng.range(-10, 10);
    }
  } else if (crows > want) {
    const c = world.animals.find((a) => a.kind === "crow" && !a.leaving);
    if (c) {
      c.leaving = true;
      c.tx = c.x + world.rng.range(-40, 40);
      c.ty = c.y + 70;
      world.sound("takeoff", c.x, c.y, c.z + 1);
    }
  }
}
