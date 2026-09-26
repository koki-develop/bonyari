import { Rng } from "../../shared/core/random.ts";
import type { Timekeeping } from "../../shared/env/clock.ts";
import { Environment } from "../../shared/env/environment.ts";
import type { SkyTraffic } from "../../shared/env/sky-events.ts";
import type { WeatherKind, WeatherTendency } from "../../shared/env/weather.ts";
import { type Animal, newAnimal, updateAnimals } from "./animals.ts";
import {
  type Building,
  type BuildingKind,
  KINDS,
  type Phase,
  roofHolds,
  type Site,
} from "./buildings.ts";
import { applyWork, deliver, wants } from "./construction.ts";
import { Council } from "./council.ts";
import { updateFires } from "./fire.ts";
import { Forest } from "./forest.ts";
import { inRect, rectPoint } from "./geometry.ts";
import { found as foundSettlement, updatePeople } from "./life.ts";
import { updateTraders } from "./market.ts";
import { Navigator } from "./nav.ts";
import type { Carry, Household, Person } from "./people.ts";
import { generatePlan, type Plan } from "./plan.ts";
import { type Dragon, type Missile, type Monster, RaidDirector } from "./raids.ts";
import { isLoad, runs, type SettlementRecord, unrun } from "./record.ts";
import { computeTownSeason, type TownSeason } from "./season.ts";
import { chooseStyle, placeOnSite } from "./sites.ts";
import type { Act, Effect } from "./tasks.ts";
import { type Point, Terrain } from "./terrain.ts";
import { Town } from "./town.ts";

/** Whether a building's site belongs to this plan. */
function siteFits(plan: Plan, site: Site): boolean {
  switch (site.type) {
    case "lot":
      return site.lot < plan.lots.length;
    case "wall":
    case "tower":
      return site.index < plan.wall.points.length;
    case "gate":
      return site.gate < plan.wall.gates.length;
    case "square":
    case "ford":
      return true;
  }
}

/** A day lasts ten real minutes; a year, two hours. */
export const TIMEKEEPING: Timekeeping = { secondsPerDay: 600, timeOfYear: null };
/** The usual weather of the valley. */
export const WEATHER: WeatherTendency = { wet: 0.8 };
/** Nothing flies over a valley of the old days but birds and dragons. */
export const SKY: SkyTraffic = { airplanes: false };
/** The ring of the bell for each thing it is rung for. */
const BELL_SOUNDS = {
  hours: "bell",
  alarm: "alarm",
  clear: "allclear",
  service: "service",
} as const satisfies Record<string, SoundKind>;
/** Longest single step (s); longer updates are split into steps this long. */
const MAX_STEP = 0.1;
/** Meters past either end of a bridge its deck comes down to the ground. */
const BRIDGE_END = 0.3;

/**
 * Height (m) of a bridge's deck `along` meters from its middle toward its
 * back end: level over the middle half, over the river, and sloping down
 * from there to the ground just past either end.
 */
export function bridgeDeck(terrain: Terrain, bridge: Building, along: number): number {
  const r = bridge.rect;
  const top = terrain.waterLevel(r.y) + (bridge.kind === "stonebridge" ? 1.9 : 1.1);
  const flat = r.depth / 4;
  const end = r.depth / 2 + BRIDGE_END;
  const s = (Math.abs(along) - flat) / (end - flat);
  if (s <= 0) {
    return top;
  }
  const out = along < 0 ? -end : end;
  const foot = Math.min(
    top,
    terrain.height(r.x - Math.sin(r.angle) * out, r.y + Math.cos(r.angle) * out),
  );
  return top + (foot - top) * Math.min(1, s);
}
/** Where a new settlement's story starts: an early spring morning. */
const FOUNDING_DAY = 0;
const FOUNDING_MINUTE = 7 * 60;

export interface WorldOptions {
  seed: number;
  day?: number;
  minute?: number;
  weather?: WeatherKind;
}

/** A box of the world (m) whose look changed, to be drawn again. */
export interface Change {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The highest (m) anything in it reaches, before or after the change. */
  top: number;
}

/** Sounds the world makes, for the ear. */
export type SoundKind =
  | "chop"
  | "treefall"
  | "hammer"
  | "saw"
  | "chisel"
  | "dig"
  | "hoe"
  | "reap"
  | "anvil"
  | "door"
  | "logs"
  | "stones"
  | "splash"
  | "bucket"
  | "hiss"
  | "collapse"
  | "ignite"
  | "howl"
  | "growl"
  | "drum"
  | "roar"
  | "flap"
  | "takeoff"
  | "breath"
  | "bow"
  | "hit"
  | "magic"
  | "bleat"
  | "moo"
  | "cluck"
  | "rooster"
  | "bark"
  | "cart"
  | "clap"
  | "bell"
  | "alarm"
  | "allclear"
  | "service"
  | "sweep"
  | "caw"
  | "quack";

export interface WorldEvent {
  kind: SoundKind;
  x: number;
  y: number;
  z: number;
}

/**
 * Logs or stones lying on the ground, waiting to be carried off; or brush
 * from cleared ground, burning.
 */
export interface Pile {
  id: number;
  kind: "logs" | "stones" | "brush";
  x: number;
  y: number;
  count: number;
  /** Way the logs lie (radians, as `Rect.angle`). */
  angle: number;
  /** Seconds a brush fire has left to burn. */
  burn: number;
}

/**
 * The valley and the settlement in it, advanced in real seconds: the land,
 * the woods, the plan the town grows along and what has been built of it;
 * the people and their animals; the raiders that come and the fires they
 * light.
 */
export class World {
  readonly seed: number;
  readonly env: Environment<TownSeason>;
  readonly terrain: Terrain;
  readonly plan: Plan;
  readonly forest: Forest;
  readonly town: Town;
  readonly nav: Navigator;
  readonly council: Council;
  readonly raids: RaidDirector;
  readonly people: Person[] = [];
  /** Traders up for the day on market days, with their carts. */
  readonly traders: Person[] = [];
  readonly households: Household[] = [];
  private readonly peopleById = new Map<number, Person>();
  private readonly householdsById = new Map<number, Household>();
  readonly animals: Animal[] = [];
  readonly monsters: Monster[] = [];
  readonly missiles: Missile[] = [];
  dragon: Dragon | null = null;
  readonly piles: Pile[] = [];
  /** What the town has laid by: logs and stones at the yard, food in the barns. */
  readonly stock = { wood: 0, stone: 0, food: 0 };
  /** What changed in the look of the world since the renderer last looked. */
  readonly changes: Change[] = [];
  /** Sounds of the last update. */
  readonly events: WorldEvent[] = [];
  /** Real seconds simulated. */
  time = 0;
  /** Seconds till the lamps in the windows are next looked to (see `updatePeople`). */
  lampsIn = 0;
  /** Where the town is being watched from (the middle of the view), if it is: raids come there. */
  attention: Point | null = null;
  /** In-world day the settlers came. */
  founded = 0;
  readonly rng: Rng;
  nextId = 1;

  private constructor(seed: number, env: Environment<TownSeason>, rngState: number) {
    this.seed = seed;
    this.env = env;
    this.rng = new Rng(rngState);
    this.terrain = new Terrain(seed);
    this.plan = generatePlan(seed, this.terrain);
    this.forest = new Forest(seed, this.terrain, this.plan);
    this.town = new Town(this.plan);
    this.nav = new Navigator(this.plan, this.terrain, this.town);
    this.council = new Council();
    this.raids = new RaidDirector();
  }

  /** A new settlement: a family coming up the old road into the meadow on a spring morning. */
  static create(options: WorldOptions): World {
    const days = (options.day ?? FOUNDING_DAY) + (options.minute ?? FOUNDING_MINUTE) / 1440;
    const env = Environment.create(
      options.seed,
      days,
      TIMEKEEPING,
      computeTownSeason,
      options.weather ?? "clear",
      WEATHER,
      SKY,
    );
    const world = new World(options.seed, env, options.seed ^ 0x5e77);
    world.founded = days;
    foundSettlement(world);
    return world;
  }

  /**
   * The settlement as it was recorded; null if the record does not fit this
   * seed's plan (it came from another version of the work).
   */
  static restore(record: SettlementRecord): World | null {
    const env = Environment.restore(
      record.seed,
      record.env,
      TIMEKEEPING,
      computeTownSeason,
      WEATHER,
      SKY,
    );
    const world = new World(record.seed, env, record.rng);
    const town = world.town;
    const plan = world.plan;
    const t = record.town;
    const trees = unrun(record.forest, world.forest.trees.length);
    if (
      !trees ||
      t.streetGrade.length !== plan.streets.length ||
      t.fields.length !== plan.fields.length ||
      t.fenced.length !== plan.pastures.length ||
      t.lotGround.length !== plan.lots.length ||
      t.buildings.some((b) => !siteFits(plan, b.site))
    ) {
      return null;
    }
    world.time = record.time;
    world.founded = record.founded;
    Object.assign(world.stock, record.stock);
    t.streetGrade.forEach(
      (g, i) => (town.streetGrade[i] = Math.max(0, Math.min(3, Math.round(g)))),
    );
    town.squareGrade = Math.max(0, Math.min(3, Math.round(t.squareGrade))) as Town["squareGrade"];
    t.fields.forEach((f, i) => Object.assign(town.fields[i], f));
    t.fenced.forEach((f, i) => (town.pastures[i].fenced = f));
    t.lotGround.forEach((g, i) => (town.lotGround[i] = Math.max(0, Math.min(2, Math.round(g)))));
    for (const b of t.buildings) {
      // No raid is kept, so none is on: the gates stand open.
      b.shut = false;
      town.add(b);
    }
    town.nextBuildingId = Math.max(t.nextBuildingId, ...t.buildings.map((b) => b.id + 1));
    world.forest.state.set(trees);
    const c = world.council;
    c.era = record.council.era;
    for (const id of record.council.openFields) {
      if (id >= 0 && id < plan.fields.length) {
        c.openFields.add(id);
      }
    }
    for (const id of record.council.opening) {
      if (id >= 0 && id < plan.streets.length) {
        c.opening.add(id);
      }
    }
    const paving = record.council.paving;
    c.paving = paving && paving.street < plan.streets.length ? { ...paving } : null;
    c.quarried = record.council.quarried;
    c.fencing = record.council.fencing;
    c.nextArrival = record.council.nextArrival;
    c.threat = record.council.threat;
    Object.assign(world.raids, record.raids);
    const standing = (id: number) => town.building(id)?.phase === "standing";
    for (const h of record.households) {
      world.addHousehold({
        id: h.id,
        home: town.building(h.home) ? h.home : -1,
        lodging: town.building(h.lodging) ? h.lodging : -1,
        members: [],
      });
    }
    for (const q of record.people) {
      const household = world.household(q.household);
      if (!household) {
        continue;
      }
      household.members.push(q.id);
      world.addPerson({
        ...q,
        z: world.groundAt(q.x, q.y),
        heading: 0,
        inside: standing(q.inside) ? q.inside : -1,
        task: null,
        path: [],
        step: 0,
        lane: world.rng.range(0.35, 0.8),
        carry: null,
        pose: "stand",
        poseTime: 0,
        trader: false,
      });
    }
    for (const h of world.households.slice()) {
      if (h.members.length === 0) {
        world.removeHousehold(h);
      }
    }
    for (const a of record.animals) {
      const animal = newAnimal(world, a.kind, a.x, a.y, a.home);
      animal.id = a.id;
      animal.load = a.load;
      animal.cargo = a.cargo;
    }
    world.piles.push(...record.piles);
    // Ids go on from where they stood (making the animals over above drew some).
    world.nextId = record.nextId;
    for (const q of [...record.households, ...record.people, ...record.animals, ...record.piles]) {
      world.nextId = Math.max(world.nextId, q.id + 1);
    }
    world.nav.bridged = town.buildings.some(
      (b) => b.site.type === "ford" && b.phase === "standing",
    );
    return world;
  }

  /** What to keep of the settlement to come back to it later (see `record.ts`). */
  snapshot(): SettlementRecord {
    const town = this.town;
    const piles = this.piles.map((q) => ({ ...q }));
    // Loads in hand are put down where their carriers stand.
    let nextId = this.nextId;
    for (const p of this.people) {
      if (isLoad(p.carry)) {
        piles.push({
          id: nextId++,
          kind: p.carry === "stone" ? "stones" : "logs",
          x: p.x,
          y: p.y,
          count: p.carry === "logs" ? 2 : 1,
          angle: p.heading,
          burn: 0,
        });
      }
    }
    return {
      seed: this.seed,
      env: this.env.snapshot(),
      time: this.time,
      founded: this.founded,
      rng: this.rng.state,
      nextId,
      stock: { ...this.stock },
      town: {
        streetGrade: [...town.streetGrade],
        squareGrade: town.squareGrade,
        fields: town.fields.map((f) => ({ ...f })),
        fenced: town.pastures.map((p) => p.fenced),
        lotGround: [...town.lotGround],
        buildings: town.buildings.map((b) => structuredClone(b)),
        nextBuildingId: town.nextBuildingId,
      },
      forest: runs(this.forest.state),
      council: {
        era: this.council.era,
        openFields: [...this.council.openFields],
        opening: [...this.council.opening],
        paving: this.council.paving ? { ...this.council.paving } : null,
        quarried: this.council.quarried,
        fencing: this.council.fencing,
        nextArrival: this.council.nextArrival,
        threat: this.council.threat,
      },
      raids: {
        nextSmall: this.raids.nextSmall,
        nextMedium: this.raids.nextMedium,
        nextLarge: this.raids.nextLarge,
        count: this.raids.count,
        larges: this.raids.larges,
      },
      people: this.people.map((p) => ({
        id: p.id,
        household: p.household,
        age: p.age,
        female: p.female,
        job: p.job,
        look: p.look,
        x: p.x,
        y: p.y,
        inside: p.inside,
        militia: p.militia,
        leaving: p.leaving,
        arriving: p.arriving,
      })),
      households: this.households.map((h) => ({
        id: h.id,
        home: h.home,
        lodging: h.lodging,
        members: [...h.members],
      })),
      animals: this.animals
        // The wild birds come again on their own, and the traders' oxen with the next market.
        .filter(
          (a) =>
            a.kind !== "crow" && a.kind !== "duck" && !(a.kind === "ox" && a.cargo === "sacks"),
        )
        .map((a) => ({
          id: a.id,
          kind: a.kind,
          x: a.x,
          y: a.y,
          home: { ...a.home },
          load: a.load,
          cargo: a.cargo,
        })),
      piles,
    };
  }

  get season(): TownSeason {
    return this.env.season;
  }

  /** In-world days since the settlers came. */
  get age(): number {
    return this.env.clock.days - this.founded;
  }

  /**
   * Advances by `dt` real seconds, in steps of at most `most` seconds: short
   * ones while it is watched, longer to live through days at a time.
   */
  update(dt: number, most = MAX_STEP): void {
    this.env.clearEvents();
    this.events.length = 0;
    let left = dt;
    while (left > 1e-9) {
      const step = Math.min(most, left);
      this.step(step);
      left -= step;
    }
  }

  private step(dt: number): void {
    const before = this.env.clock.days;
    this.env.step(dt);
    const days = this.env.clock.days - before;
    this.time += dt;
    this.council.update(this, dt, days);
    updatePeople(this, dt, days);
    updateTraders(this, dt);
    updateAnimals(this, dt);
    this.raids.update(this, dt, days);
    updateFires(this, dt, days);
    // Brush fires burn down and go out.
    for (let i = this.piles.length - 1; i >= 0; i--) {
      const q = this.piles[i];
      if (q.kind === "brush") {
        q.burn -= dt * (1 + this.env.weather.state.rain * 3);
        if (q.burn <= 0) {
          this.piles.splice(i, 1);
        }
      }
    }
  }

  // Places.

  /** Height (m) of what one stands on at (x, y): the ground, or a bridge's deck over the river. */
  groundAt(x: number, y: number): number {
    const ground = this.terrain.height(x, y);
    const bridge = this.town.bridge;
    if (bridge && bridge.phase === "standing" && inRect(bridge.rect, x, y, BRIDGE_END)) {
      const r = bridge.rect;
      const along = -((x - r.x) * Math.sin(r.angle) - (y - r.y) * Math.cos(r.angle));
      return Math.max(ground, bridgeDeck(this.terrain, bridge, along));
    }
    return ground;
  }

  /** The bridge over the ford, if one has been started. */
  get bridge(): Building | undefined {
    return this.town.bridge;
  }

  /** Where one comes to a building's door, a step out in front of it. */
  door(b: Building): Point {
    if (b.site.type === "lot") {
      const lot = this.plan.lots[b.site.lot];
      return { x: lot.door.x, y: lot.door.y };
    }
    return rectPoint(b.rect, 0, -b.rect.depth / 2 - 1);
  }

  /** Where logs and stones are kept: the yard once there is one, a pile by the square till then. */
  depot(stuff: "wood" | "stone"): Point {
    const kind = stuff === "wood" ? "lumberyard" : "quarry";
    const yard = this.town.buildings.find((b) => b.kind === kind && b.phase === "standing");
    if (yard) {
      return rectPoint(yard.rect, stuff === "wood" ? 2.5 : -3, 1);
    }
    const sq = this.plan.square;
    return { x: sq.x + (stuff === "wood" ? 7 : 4), y: sq.y - (stuff === "wood" ? 5 : 8) };
  }

  person(id: number): Person | undefined {
    return this.peopleById.get(id);
  }

  household(id: number): Household | undefined {
    return this.householdsById.get(id);
  }

  /** Someone new to the settlement, or (`trader`) up for the market day. */
  addPerson(p: Person): void {
    (p.trader ? this.traders : this.people).push(p);
    this.peopleById.set(p.id, p);
  }

  addHousehold(h: Household): void {
    this.households.push(h);
    this.householdsById.set(h.id, h);
  }

  private removeHousehold(h: Household): void {
    const i = this.households.indexOf(h);
    if (i >= 0) {
      this.households.splice(i, 1);
    }
    this.householdsById.delete(h.id);
  }

  building(id: number): Building | undefined {
    return this.town.building(id);
  }

  /** Takes someone into a building, out of sight; false if it cannot be entered now. */
  enterBuilding(p: Person, id: number): boolean {
    const b = this.building(id);
    if (!roofHolds(b)) {
      return false;
    }
    p.inside = id;
    p.pose = "stand";
    const d = this.door(b);
    p.x = d.x;
    p.y = d.y;
    if (KINDS[b.kind].shelter) {
      this.sound("door", d.x, d.y, this.groundAt(d.x, d.y) + 1);
    }
    return true;
  }

  /** Brings someone out of the building they are in, to its door. */
  leaveBuilding(p: Person): void {
    const b = this.building(p.inside);
    p.inside = -1;
    if (b) {
      const d = this.door(b);
      p.x = d.x + this.rng.range(-0.4, 0.4);
      p.y = d.y + this.rng.range(-0.2, 0.2);
      p.z = this.groundAt(p.x, p.y);
    }
  }

  // What people do to the world.

  /** Does something at once; false if it can no longer be done. */
  apply(p: Person, e: Effect): boolean {
    switch (e.kind) {
      case "take": {
        const n = Math.min(e.count, Math.floor(this.stock[e.stuff]));
        if (n < 1) {
          return false;
        }
        this.stock[e.stuff] -= n;
        p.carry = e.stuff === "wood" ? (n > 1 ? "logs" : "log") : "stone";
        return true;
      }
      case "takePile": {
        const pile = this.piles.find((q) => q.id === e.pile);
        if (!pile || pile.count <= 0) {
          return false;
        }
        const n = pile.kind === "logs" ? Math.min(e.count, pile.count) : 1;
        pile.count -= n;
        if (pile.count <= 0) {
          this.piles.splice(this.piles.indexOf(pile), 1);
        }
        p.carry = pile.kind === "logs" ? (n > 1 ? "logs" : "log") : "stone";
        return true;
      }
      case "takeNear": {
        let best: Pile | null = null;
        let bestD = 4;
        for (const q of this.piles) {
          const d = Math.hypot(q.x - e.x, q.y - e.y);
          if (q.kind === "logs" && d < bestD) {
            bestD = d;
            best = q;
          }
        }
        if (!best) {
          return false;
        }
        best.count--;
        if (best.count <= 0) {
          this.piles.splice(this.piles.indexOf(best), 1);
        }
        p.carry = "log";
        return true;
      }
      case "loadCart": {
        const cart = this.cartOf(p);
        if (!cart) {
          return false;
        }
        // Whatever is still on the cart goes back on the stock first.
        this.stock[cart.cargo === "stones" ? "stone" : "wood"] +=
          cart.cargo === "sacks" ? 0 : cart.load;
        cart.load = 0;
        // From a heap where the trees were felled, or from the yard.
        const pile = e.pile === undefined ? undefined : this.piles.find((q) => q.id === e.pile);
        if (e.pile !== undefined && !pile) {
          return false;
        }
        const n = Math.min(e.count, pile ? pile.count : Math.floor(this.stock[e.stuff]));
        if (n < 1) {
          // Only unloading back onto the stock is still a trip done.
          return e.count === 0;
        }
        if (pile) {
          pile.count -= n;
          if (pile.count <= 0) {
            this.piles.splice(this.piles.indexOf(pile), 1);
          }
        } else {
          this.stock[e.stuff] -= n;
        }
        cart.load = n;
        cart.cargo = e.stuff === "wood" ? "logs" : "stones";
        this.sound(e.stuff === "wood" ? "logs" : "stones", p.x, p.y, p.z);
        return true;
      }
      case "unloadCart": {
        const cart = this.cartOf(p);
        if (!cart || cart.cargo === "sacks") {
          return false;
        }
        const stuff = cart.cargo === "stones" ? "stone" : "wood";
        const b = this.building(e.building);
        if (!b) {
          // At the yard: all of it onto the stock.
          if (cart.load > 0) {
            this.sound(stuff === "wood" ? "logs" : "stones", p.x, p.y, p.z);
          }
          this.stock[stuff] += cart.load;
          cart.load = 0;
          return true;
        }
        // At a site: what it still wants (or the share meant for it), the rest kept for the next.
        const n = Math.max(0, Math.min(cart.load, wants(b)[stuff], e.count ?? Infinity));
        if (n > 0) {
          b[stuff] += n;
          cart.load -= n;
          const d = this.door(b);
          this.sound(stuff === "wood" ? "logs" : "stones", d.x, d.y, b.base + 0.5);
        }
        return true;
      }
      case "deliver": {
        const n = p.carry === "logs" ? 2 : 1;
        p.carry = null;
        for (let k = 0; k < n; k++) {
          deliver(this, e.building, e.stuff);
        }
        return true;
      }
      case "stock":
        this.stock[e.stuff] += e.stuff === "wood" && p.carry === "logs" ? 2 : e.amount;
        p.carry = null;
        if (e.stuff !== "food") {
          this.sound(e.stuff === "stone" ? "stones" : "logs", p.x, p.y, p.z);
        }
        return true;
      case "sacks": {
        const cart = this.cartOf(p);
        if (cart) {
          cart.cargo = "sacks";
          cart.load = e.count;
        }
        return true;
      }
      case "sheaves":
        p.carry = null;
        this.stock.food += 2;
        return true;
      case "arrived":
        p.arriving = false;
        return true;
      case "gone":
        this.remove(p);
        return true;
      case "bell":
        this.sound(BELL_SOUNDS[e.pattern], p.x, p.y, p.z + 12);
        return true;
      case "sound":
        this.sound(e.sound, p.x, p.y, p.z + 1);
        return true;
    }
  }

  /** Works at something for `dt` seconds; `done` is the last of it. False if it can no longer be done. */
  work(p: Person, act: Act, dt: number, done: boolean): boolean {
    return applyWork(this, p, act, dt, done);
  }

  /** The ox and cart someone leads, if they are a carter or a trader. */
  cartOf(p: Person): Animal | undefined {
    return this.animals.find(
      (a) => a.kind === "ox" && a.home.type === "person" && a.home.id === p.id,
    );
  }

  /** Makes a sound at a place. */
  sound(kind: SoundKind, x: number, y: number, z: number): void {
    this.events.push({ kind, x, y, z });
  }

  /** Takes someone out of the world (they have left the valley). */
  remove(p: Person): void {
    const i = this.people.indexOf(p);
    if (i >= 0) {
      this.people.splice(i, 1);
    }
    const t = this.traders.indexOf(p);
    if (t >= 0) {
      this.traders.splice(t, 1);
    }
    this.peopleById.delete(p.id);
    const h = this.household(p.household);
    if (h) {
      h.members = h.members.filter((m) => m !== p.id);
      if (h.members.length === 0) {
        this.removeHousehold(h);
      }
    }
  }

  /** Puts down what someone carries where they stand, as a pile to be fetched later. */
  drop(p: Person): void {
    const c: Carry | null = p.carry;
    p.carry = null;
    if (c === "log" || c === "logs" || c === "stone") {
      const kind = c === "stone" ? "stones" : "logs";
      const count = c === "logs" ? 2 : 1;
      // Onto a pile close by, if there is one.
      const near = this.piles.find((q) => q.kind === kind && Math.hypot(q.x - p.x, q.y - p.y) < 3);
      if (near) {
        near.count += count;
        return;
      }
      this.piles.push({
        id: this.nextId++,
        kind,
        x: p.x,
        y: p.y,
        count,
        angle: p.heading,
        burn: 0,
      });
    }
  }

  // Building.

  /**
   * Starts a building of `kind` on `site`: its footprint is laid out, and
   * the trees standing on it (and their stumps) are noted to be cleared
   * first. It starts in `phase` (clearing, unless told otherwise).
   */
  found(kind: BuildingKind, site: Site, era: number, phase: Phase = "clearing"): Building {
    const { rect, base } = placeOnSite(this.plan, this.terrain, kind, site);
    // The whole plot is cleared, and a margin round it, so the woods draw back from what is built.
    const ground = site.type === "lot" ? this.plan.lots[site.lot].rect : rect;
    const margin = site.type === "lot" ? 4 : 1.5;
    const clearing: number[] = [];
    const reach = Math.hypot(ground.width, ground.depth) / 2 + margin + 1;
    this.forest.near(ground.x, ground.y, reach, (tree) => {
      if (this.forest.state[tree.id] !== 0 && inRect(ground, tree.x, tree.y, margin)) {
        clearing.push(tree.id);
      }
    });
    const town = this.town;
    const b: Building = {
      id: town.nextBuildingId++,
      kind,
      site,
      rect,
      base,
      variant: this.rng.int(0, 0x7fffffff),
      style: chooseStyle(kind, era, this.rng),
      phase: phase === "clearing" && clearing.length === 0 ? "building" : phase,
      progress: phase === "standing" ? 1 : 0,
      wood: 0,
      stone: 0,
      clearing,
      damage: 0,
      char: 0,
      fire: 0,
      cleared: 0,
      next: null,
      replacing: false,
      rebuilding: false,
      lamps: 0,
      shut: false,
    };
    town.add(b);
    return b;
  }

  /** Fells a standing tree, leaving its stump and its logs. */
  fell(id: number): void {
    const tree = this.forest.trees[id];
    this.forest.fell(id);
    this.treeChanged(id);
    this.sound("treefall", tree.x, tree.y, tree.z + 1);
  }

  /** Grubs up a stump. */
  grub(id: number): void {
    this.forest.clearStump(id);
    this.treeChanged(id);
  }

  private treeChanged(id: number): void {
    const t = this.forest.trees[id];
    const r = t.radius + 1;
    this.changed(t.x - r, t.y - r, t.x + r, t.y + r, t.z + t.height + 1);
  }

  /** Notes that the look of a box of the world changed. */
  changed(x0: number, y0: number, x1: number, y1: number, top: number): void {
    this.changes.push({ x0, y0, x1, y1, top });
  }

  /** Notes that the ground round (x, y) changed its look. */
  groundChanged(x: number, y: number, reach: number): void {
    this.changed(x - reach, y - reach, x + reach, y + reach, this.terrain.height(x, y) + 1);
  }
}
