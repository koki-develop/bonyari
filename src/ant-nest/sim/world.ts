import { clamp, clamp01, smoothstep, TAU } from "../../shared/core/math.ts";
import { hash2, Rng } from "../../shared/core/random.ts";
import { DAYS_PER_YEAR, type Timekeeping } from "../../shared/env/clock.ts";
import { Environment } from "../../shared/env/environment.ts";
import type { WeatherKind, WeatherTendency } from "../../shared/env/weather.ts";
import { Climate } from "./climate.ts";
import {
  ALATE_SLOWER,
  type Ant,
  type Brood,
  type BroodCaste,
  type Caste,
  type ColonyState,
  FIRST_BROOD,
  growth,
  type Item,
  type ItemKind,
  LARVA_FOOD,
  maturity,
  type Pose,
  QUEEN_RESERVE,
  SIZE,
  STAGE_DAYS,
  vigor,
  WORKER_CAP,
  WORKER_LIFE,
} from "./colony.ts";
import {
  AIR,
  AIR_LOC,
  cellIndex,
  FRAME,
  isStem,
  type Loc,
  OPEN,
  type Point,
  stemIndex,
  SURFACE,
  SURFACE_X0,
  SURFACE_X1,
} from "./geometry.ts";
import { Nest } from "./nest.ts";
import { generatePlan, type Plan } from "./plan.ts";
import type { ColonyRecord } from "./record.ts";
import { computeNestSeason, type NestSeason } from "./season.ts";
import { Soil } from "./soil.ts";
import { Surface } from "./surface.ts";
import { chooseTask, noticeFood, runTask } from "./tasks.ts";

/** A day lasts five real minutes; a year, an hour. */
export const TIMEKEEPING: Timekeeping = { secondsPerDay: 300, timeOfYear: null };
/**
 * Rain comes less often, and passes sooner, than elsewhere: in the rain the
 * colony shuts itself in and there is little to watch.
 */
export const WEATHER: WeatherTendency = { wet: 0.4 };
/** Longest single step (s); longer updates are split into steps this long. */
const MAX_STEP = 0.1;
/** Real seconds between the colony's looks at how it stands. */
const COLONY_TICK = 1;
/** Where a new colony's year starts: a warm afternoon in the middle of May, when queens fly. */
const FOUNDING_DAY = 2;
const FOUNDING_MINUTE = 14 * 60 + 20;
/** How things fall (mm/s², mm/s), and how they hop when they hit the ground. */
const GRAVITY = 2600;
const FALL_TERMINAL = 420;
const HOP = 0.28;
const HOP_SPEED = 70;
/**
 * The stretch of the year (fractions: mid-December to early February) the
 * colony rests through; outside it, cold only slows the ants down.
 */
const WINTER_REST = [0.79, 0.92] as const;
/** Seconds an old worker takes to walk off into the grass out of sight. */
export const LEAVE_TIME = 2.5;
/** Food (units) a worker eats in a day. */
const RATION = 0.008;

export interface WorldOptions {
  seed: number;
  /** In-world day of the year to start on (0 = Mar 1) and the minute of the day. */
  day?: number;
  minute?: number;
  weather?: WeatherKind;
}

export type WorldEvent =
  /** A bite of soil taken from a face. */
  | { kind: "bite"; x: number; y: number; hardness: number }
  /** A pellet dropped on the heap. */
  | { kind: "dump"; x: number; y: number }
  /** Soil pressed into a plug. */
  | { kind: "pack"; x: number; y: number }
  /** Something fell onto the ground: a crumb, an insect. */
  | { kind: "land"; x: number; y: number; size: number; item: ItemKind }
  /** The founding queen touched down, and shed her wings. */
  | { kind: "touchdown"; x: number; y: number }
  | { kind: "shed"; x: number; y: number }
  /** A winged ant took off. */
  | { kind: "takeoff"; x: number; y: number }
  /** A new adult came out of its cocoon. */
  | { kind: "eclose"; x: number; y: number }
  /** An egg was laid. */
  | { kind: "lay"; x: number; y: number };

/** Scratch point. */
const P: Point = { x: 0, y: 0 };

/**
 * The ground and the colony in it, advanced in real seconds: the soil and
 * the nest dug in it, the surface above with its heap and plants, and every
 * ant, brood item and crumb.
 */
export class World {
  readonly seed: number;
  readonly env: Environment<NestSeason>;
  readonly soil: Soil;
  readonly plan: Plan;
  readonly nest: Nest;
  readonly surface: Surface;
  readonly climate: Climate;
  readonly ants: Ant[];
  readonly brood: Brood[];
  readonly items: Item[];
  readonly colony: ColonyState;
  readonly rng: Rng;
  /** Events of the last update. */
  readonly events: WorldEvent[] = [];
  /** Real seconds simulated. */
  time = 0;
  nextId: number;
  /** Counts of what the ants are doing, refreshed on each colony tick. */
  readonly doing = new Map<string, number>();
  workers = 0;
  /** Features the colony may dig now, in the order it takes them. */
  digFront: number[] = [];
  private sinceTick = COLONY_TICK;
  private readonly broodById = new Map<number, Brood>();
  private readonly itemById = new Map<number, Item>();
  private readonly antById = new Map<number, Ant>();
  /** Chamber switch hysteresis: world day the brood chamber was last chosen. */
  private broodChosenAt = -Infinity;

  private constructor(
    seed: number,
    env: Environment<NestSeason>,
    climate: Climate,
    colony: ColonyState,
    rngState: number,
  ) {
    this.seed = seed;
    this.env = env;
    this.soil = new Soil(seed);
    this.plan = generatePlan(seed, this.soil);
    this.nest = new Nest(this.soil, this.plan);
    this.surface = new Surface(
      this.soil,
      this.plan.portals.map((p) => p.x),
    );
    this.climate = climate;
    this.colony = colony;
    this.ants = [];
    this.brood = [];
    this.items = [];
    this.rng = new Rng(rngState);
    this.nextId = 1;
  }

  /** A new colony: a queen coming down on a May afternoon, the ground untouched. */
  static create(options: WorldOptions): World {
    const days = (options.day ?? FOUNDING_DAY) + (options.minute ?? FOUNDING_MINUTE) / 1440;
    const env = Environment.create(
      options.seed,
      days,
      TIMEKEEPING,
      computeNestSeason,
      options.weather ?? "clear",
      WEATHER,
    );
    const colony: ColonyState = {
      stage: "arrival",
      foundedAt: days,
      reserve: QUEEN_RESERVE,
      honey: 0,
      dormancy: 0,
      closed: false,
      broodChamber: -1,
      foodChamber: -1,
      eggsDue: 0,
      known: [],
      flownYear: -1,
    };
    const world = new World(
      options.seed,
      env,
      Climate.create(days, TIMEKEEPING),
      colony,
      options.seed ^ 0xa27,
    );
    world.surface.setCraters(world.dugPortalXs());
    const entrance = world.plan.portals[0];
    const side = world.rng.chance(0.5) ? 1 : -1;
    const queen = world.newAnt("queen", SIZE.queen, days - 30, {
      f: AIR_LOC,
      s: entrance.x + side * 90,
      u: 190,
    });
    queen.winged = true;
    queen.vx = -side * 14;
    queen.vy = -22;
    queen.pose = "fly";
    queen.task = {
      kind: "found",
      step: 0,
      x: entrance.x + side * world.rng.range(14, 26),
      hops: 0,
    };
    return world;
  }

  /** The colony as it was recorded. */
  static restore(record: ColonyRecord): World {
    const env = Environment.restore(
      record.seed,
      record.env,
      TIMEKEEPING,
      computeNestSeason,
      WEATHER,
    );
    const climate = Climate.restore(record.temperature, record.moisture, TIMEKEEPING);
    const world = new World(record.seed, env, climate, structuredClone(record.colony), record.rng);
    // Chambers named in the record must be of this plan.
    const count = world.plan.features.length;
    const chamber = (f: number) =>
      f >= 0 && f < count && world.plan.features[f].kind === "chamber" ? f : -1;
    world.colony.broodChamber = chamber(world.colony.broodChamber);
    world.colony.foodChamber = chamber(world.colony.foodChamber);
    world.time = record.time;
    world.nest.restore(record.open, record.plugs);
    world.surface.heap.set(record.heap.slice(0, world.surface.heap.length));
    world.surface.setCraters(world.dugPortalXs());
    for (const a of record.ants) {
      const ant = world.newAnt(a.caste, a.size, a.born, world.validLoc(a.loc));
      ant.id = a.id;
      ant.crop = a.crop;
      ant.winged = a.winged;
      ant.heading = a.heading;
    }
    world.antById.clear();
    for (const ant of world.ants) {
      world.antById.set(ant.id, ant);
    }
    for (const b of record.brood) {
      world.addBrood({ ...b, loc: world.validLoc(b.loc), carried: false });
    }
    for (const it of record.items) {
      world.addItem({ ...it, loc: world.validLoc(it.loc), carried: false, drop: 0, fall: 0 });
    }
    // What was carried when the record was made is put down where its carrier stood.
    for (const a of record.ants) {
      if (a.cargo) {
        const ant = world.antById.get(a.id);
        if (ant) {
          world.putDown(ant, a.cargo.kind, a.cargo.id, a.cargo.amount);
        }
      }
    }
    world.nextId = Math.max(
      record.nextId,
      ...world.ants.map((a) => a.id + 1),
      ...world.brood.map((b) => b.id + 1),
      ...world.items.map((i) => i.id + 1),
    );
    for (const ant of world.ants) {
      world.settle(ant);
    }
    world.tick();
    return world;
  }

  /** Enough to restore the colony with `World.restore`. */
  snapshot(): ColonyRecord {
    return {
      seed: this.seed,
      env: this.env.snapshot(),
      time: this.time,
      rng: this.rng.state,
      nextId: this.nextId,
      colony: structuredClone(this.colony),
      temperature: Array.from(this.climate.temperature),
      moisture: Array.from(this.climate.moisture),
      open: this.nest.openList(),
      plugs: Array.from(this.nest.plugs),
      heap: Array.from(this.surface.heap),
      ants: this.ants
        .filter((a) => (a.loc.f !== AIR_LOC || a.caste === "queen") && a.leaving < 0)
        .map((a) => ({
          id: a.id,
          caste: a.caste,
          size: a.size,
          born: a.born,
          loc: this.restingLoc(a),
          heading: a.heading,
          crop: a.crop,
          winged: a.winged,
          cargo: a.cargo ? { kind: a.cargo.kind, id: a.cargo.id, amount: a.cargo.amount } : null,
        })),
      // What is being carried is kept where its carrier is; it is put down there on restore.
      brood: this.brood.map((b) => ({
        id: b.id,
        stage: b.stage,
        caste: b.caste,
        progress: b.progress,
        fed: b.fed,
        loc: b.carried ? this.carrierLoc("brood", b.id, b.loc) : { ...b.loc },
      })),
      items: this.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        loc: i.carried ? this.carrierLoc(i.kind, i.id, i.loc) : { ...i.loc },
        amount: i.amount,
        size: i.size,
        variant: i.variant,
        since: i.since,
        soggy: i.soggy,
      })),
    };
  }

  /**
   * A recorded place made good for this world: on a feature or plant that
   * exists, else on the ground over the entrance.
   */
  validLoc(loc: Loc): Loc {
    const f = loc.f;
    const known =
      (f >= 0 && f < this.plan.features.length) ||
      f === SURFACE ||
      (isStem(f) && stemIndex(f) < this.surface.stems.length);
    if (known) {
      return { ...loc };
    }
    return { f: SURFACE, s: this.plan.portals[0].x + 6, u: 0 };
  }

  /** Where whoever carries a thing is kept in a record; `fallback` if no one is found. */
  private carrierLoc(kind: string, id: number, fallback: Loc): Loc {
    const carrier = this.ants.find(
      (a) => a.cargo !== null && a.cargo.kind === kind && a.cargo.id === id,
    );
    return carrier ? this.restingLoc(carrier) : { ...fallback };
  }

  /**
   * Where an ant is kept in a record: where it stands, except that one in the
   * air or up a plant is put down on the ground below (the queen still
   * arriving lands there, wings and all).
   */
  private restingLoc(ant: Ant): Loc {
    if (ant.loc.f === AIR_LOC || isStem(ant.loc.f)) {
      return { f: SURFACE, s: clamp(ant.x, SURFACE_X0, SURFACE_X1), u: 0 };
    }
    return { ...ant.loc };
  }

  /** In-world days since the start of the first spring. */
  get day(): number {
    return this.env.clock.days;
  }

  get season(): NestSeason {
    return this.env.season;
  }

  /** In-world year (0 first). */
  get year(): number {
    return Math.floor(this.env.clock.days / DAYS_PER_YEAR);
  }

  get queen(): Ant | undefined {
    return this.ants.find((a) => a.caste === "queen");
  }

  broodOf(id: number): Brood | undefined {
    return this.broodById.get(id);
  }

  itemOf(id: number): Item | undefined {
    return this.itemById.get(id);
  }

  antOf(id: number): Ant | undefined {
    return this.antById.get(id);
  }

  /** The position (mm) of a place in the section. */
  locate(loc: Loc, out: Point): Point {
    if (loc.f >= 0) {
      return this.plan.features[loc.f].line.point(loc.s, loc.u, out);
    }
    if (loc.f === SURFACE) {
      out.x = loc.s;
      out.y = this.surface.height(loc.s);
      return out;
    }
    if (loc.f === AIR_LOC) {
      out.x = loc.s;
      out.y = loc.u;
      return out;
    }
    return this.surface.stemPoint(stemIndex(loc.f), loc.s, this.season.yearFraction, out);
  }

  locateX(loc: Loc): number {
    return this.locate(loc, P).x;
  }

  locateY(loc: Loc): number {
    return this.locate(loc, P).y;
  }

  /** Temperature (°C) at a place: in the soil by its depth, the surface's above it. */
  temperatureAt(loc: Loc): number {
    if (loc.f < 0) {
      return this.climate.surface;
    }
    this.locate(loc, P);
    return this.climate.temperatureAt(this.soil.ground(P.x) - P.y);
  }

  /** Whether an ant may go out to the surface now: not cold, dark, wet or snowed over. */
  get fairOutside(): boolean {
    const env = this.env;
    const w = env.weather.state;
    const t = this.climate.surface;
    const light = env.sky.sunAltitude > -3 || (t > 20 && this.season.warmth > 0.75);
    return (
      this.colony.stage === "colony" &&
      this.colony.dormancy < 0.3 &&
      light &&
      t > 11 &&
      t < 41 &&
      w.rain < 0.05 &&
      w.snowCover < 0.2 &&
      w.storm < 0.1
    );
  }

  /** Whether the way out is open and it is fair outside. */
  get canLeave(): boolean {
    return this.fairOutside && !this.colony.closed && this.anyPortalOpen();
  }

  /** Whether any entrance leads out now. */
  anyPortalOpen(): boolean {
    for (let p = 0; p < this.plan.portals.length; p++) {
      if (this.nest.portalOpen(p)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether soil can be taken out and dropped by the door: by day or night,
   * so long as it is not raining or cold and the way is open.
   */
  get canDump(): boolean {
    const c = this.colony;
    const w = this.env.weather.state;
    return (
      c.stage === "colony" &&
      !c.closed &&
      c.dormancy < 0.3 &&
      w.rain < 0.05 &&
      w.snowCover < 0.2 &&
      this.climate.surface > 6 &&
      this.anyPortalOpen()
    );
  }

  /** Where the entrances dug through to the surface are, open or plugged. */
  dugPortalXs(): number[] {
    const xs: number[] = [];
    this.plan.portals.forEach((p, i) => {
      if (this.nest.portalDug(i)) {
        xs.push(p.x);
      }
    });
    return xs;
  }

  /** Drops a crumb from height `y` over x; false if x is off the ground the ants walk. */
  dropCrumb(x: number, y: number): boolean {
    if (x < SURFACE_X0 + 5 || x > SURFACE_X1 - 5) {
      return false;
    }
    const size = this.rng.range(2.6, 4.6);
    const ground = this.surface.height(x);
    this.addItem({
      id: this.nextId++,
      kind: "crumb",
      loc: { f: SURFACE, s: x, u: 0 },
      amount: Math.round(size * size * 0.45),
      size,
      variant: this.rng.int(0, 1 << 16),
      since: this.day,
      carried: false,
      drop: Math.max(0, y - ground),
      fall: 0,
      soggy: 0,
    });
    return true;
  }

  /** Advances by `dt` real seconds, in steps no longer than `MAX_STEP`. */
  update(dt: number): void {
    this.events.length = 0;
    this.env.clearEvents();
    const steps = Math.ceil(dt / MAX_STEP);
    for (let i = 0; i < steps; i++) {
      this.step(dt / steps);
    }
  }

  /** Advances by `dt` real seconds in one step. */
  private step(dt: number): void {
    this.time += dt;
    const before = this.day;
    this.env.step(dt);
    const days = this.day - before;
    this.climate.step(this.env, dt);
    this.surface.update(days, this.env.weather.state.rain);
    this.sinceTick += dt;
    if (this.sinceTick >= COLONY_TICK) {
      this.sinceTick = 0;
      this.tick();
    }
    this.growBrood(days);
    this.layEggs(days);
    this.updateItems(dt, days);
    for (let i = 0; i < this.ants.length; i++) {
      this.stepAnt(this.ants[i], dt);
    }
    this.meetings();
    // The winged that flew out of sight are gone, and the old that walked off into the grass.
    for (let i = this.ants.length - 1; i >= 0; i--) {
      const a = this.ants[i];
      const flown =
        a.loc.f === AIR_LOC && a.caste !== "queen" && (a.y > 320 || Math.abs(a.x) > 520);
      if (flown || a.leaving >= LEAVE_TIME) {
        if (a.caste === "worker") {
          this.workers--;
        }
        this.ants.splice(i, 1);
        this.antById.delete(a.id);
      }
    }
  }

  // ─── Ants ──────────────────────────────────────────────────────────────

  newAnt(caste: Caste, size: number, born: number, loc: Loc): Ant {
    const ant: Ant = {
      id: this.nextId++,
      caste,
      size,
      born,
      loc,
      x: 0,
      y: 0,
      heading: this.rng.range(0, TAU),
      way: null,
      wayAt: 0,
      goalU: Number.NaN,
      wait: 0,
      pose: "still",
      gait: this.rng.range(0, 10),
      cargo: null,
      crop: 0,
      task: null,
      winged: caste === "gyne" || caste === "male",
      vx: 0,
      vy: 0,
      quirk: this.rng.range(-1, 1),
      met: -Infinity,
      leaving: -1,
    };
    this.locate(loc, P);
    ant.x = P.x;
    ant.y = P.y;
    this.ants.push(ant);
    this.antById.set(ant.id, ant);
    return ant;
  }

  /** How fast (mm/s) an ant walks now. */
  speedOf(ant: Ant): number {
    let v: number;
    switch (ant.caste) {
      case "queen":
        v = 12;
        break;
      case "worker":
        v = 15 + 2 * (ant.size - 7);
        break;
      default:
        v = 13;
    }
    if (ant.cargo) {
      v *= ant.cargo.kind === "soil" || ant.cargo.kind === "food" ? 0.82 : 0.9;
    }
    v *= 0.65 + 0.35 * maturity(this.day - ant.born);
    return v * this.liveliness(ant);
  }

  /** How lively (0..1) an ant is where it is: the warmth there, and the colony's winter rest. */
  liveliness(ant: Ant): number {
    return vigor(this.temperatureAt(ant.loc)) * (1 - 0.75 * this.colony.dormancy);
  }

  /** Stands still for `seconds` (longer when cold and sluggish). */
  stand(ant: Ant, seconds: number, pose: Pose): void {
    ant.wait = seconds / Math.max(0.15, this.liveliness(ant));
    ant.pose = pose;
  }

  /**
   * Sets off for `to`, settling at offset `goalU` there (NaN keeps to the
   * lane). False if there is no way; the ant then stays where it is.
   */
  go(ant: Ant, to: Loc, goalU = Number.NaN): boolean {
    const from = ant.loc;
    const target = this.clampLoc(to);
    let way: { f: number; s: number }[] | null;
    if (isStem(target.f) || isStem(from.f)) {
      way = this.stemWay(from, target);
    } else {
      way = this.nest.route(from, target);
    }
    if (!way) {
      return false;
    }
    ant.way = way;
    ant.wayAt = 1;
    ant.goalU = goalU;
    ant.pose = "walk";
    if (way.length <= 1) {
      ant.way = null;
    }
    return true;
  }

  /** The way up or down a plant's stem: over the surface to its foot, then along it. */
  private stemWay(from: Loc, to: Loc): { f: number; s: number }[] | null {
    const way: { f: number; s: number }[] = [{ f: from.f, s: from.s }];
    let at: Loc = from;
    if (isStem(from.f)) {
      if (from.f === to.f) {
        way.push({ f: to.f, s: to.s });
        return way;
      }
      const x = this.surface.stems[stemIndex(from.f)].x;
      way.push({ f: from.f, s: 0 }, { f: SURFACE, s: x });
      at = { f: SURFACE, s: x, u: 0 };
    }
    if (isStem(to.f)) {
      const x = this.surface.stems[stemIndex(to.f)].x;
      const toFoot = this.nest.route(at, { f: SURFACE, s: x, u: 0 });
      if (!toFoot) {
        return null;
      }
      way.push(...toFoot.slice(1), { f: to.f, s: 0 }, { f: to.f, s: to.s });
      return way;
    }
    const rest = this.nest.route(at, to);
    if (!rest) {
      return null;
    }
    way.push(...rest.slice(1));
    return way;
  }

  /** A place kept inside the room there is: on the surface within its span, inside the nest off the walls. */
  private clampLoc(loc: Loc): Loc {
    if (loc.f === SURFACE) {
      return { f: SURFACE, s: clamp(loc.s, SURFACE_X0 + 2, SURFACE_X1 - 2), u: 0 };
    }
    if (loc.f >= 0) {
      const s = clamp(loc.s, 0, this.standReach(loc.f));
      return { f: loc.f, s, u: this.nest.clampU(loc.f, s, loc.u, 1.2) };
    }
    return { ...loc };
  }

  private stepAnt(ant: Ant, dt: number): void {
    if (ant.leaving >= 0) {
      // Walking off into the grass behind the cut.
      ant.leaving += dt;
      ant.pose = "walk";
      ant.gait += 6 * dt;
      return;
    }
    if (ant.loc.f === AIR_LOC) {
      this.fly(ant, dt);
      return;
    }
    if (ant.wait > 0) {
      ant.wait -= dt;
      if (ant.wait > 0) {
        return;
      }
      ant.wait = 0;
      if (ant.way) {
        ant.pose = "walk";
      }
    }
    if (ant.way) {
      this.walk(ant, dt);
      return;
    }
    // Free to go on with what it is doing, or to take something up.
    for (let tries = 0; tries < 3; tries++) {
      if (!ant.task) {
        ant.task = chooseTask(this, ant);
      }
      if (runTask(this, ant)) {
        return;
      }
      ant.task = null;
    }
    // Nothing worked out: stay a moment before trying again.
    this.stand(ant, 1 + this.rng.next() * 2, "still");
  }

  /** Walks along the way for `dt` seconds. */
  private walk(ant: Ant, dt: number): void {
    const way = ant.way;
    if (!way) {
      return;
    }
    let left = this.speedOf(ant) * dt;
    const loc = ant.loc;
    const x0 = ant.x;
    const y0 = ant.y;
    while (left > 1e-9 && ant.way) {
      const wp = way[ant.wayAt];
      if (wp.f !== loc.f) {
        loc.f = wp.f;
        loc.s = wp.s;
        if (wp.f < 0) {
          loc.u = 0;
        }
        this.nextWaypoint(ant);
        continue;
      }
      const ds = wp.s - loc.s;
      const d = Math.abs(ds);
      if (d <= left) {
        loc.s = wp.s;
        left -= d;
        ant.gait += d;
        this.nextWaypoint(ant);
      } else {
        loc.s += Math.sign(ds) * left;
        ant.gait += left;
        left = 0;
      }
    }
    if (loc.f >= 0) {
      this.keepLane(ant, dt);
    }
    this.place(ant);
    if (ant.way && noticeFood(this, ant)) {
      ant.way = null;
    }
    const dx = ant.x - x0;
    const dy = ant.y - y0;
    if (dx * dx + dy * dy > 1e-4) {
      turnToward(ant, Math.atan2(dy, dx), dt * 12);
    }
    if (!ant.way && ant.pose === "walk") {
      ant.pose = "still";
    }
  }

  private nextWaypoint(ant: Ant): void {
    ant.wayAt++;
    if (ant.way && ant.wayAt >= ant.way.length) {
      ant.way = null;
    }
  }

  /**
   * Keeps to the right of the tunnel going one way and to the left coming
   * back, so ants pass each other; closes to the middle at junctions, and
   * settles at `goalU` at the end of the way.
   */
  private keepLane(ant: Ant, dt: number): void {
    const loc = ant.loc;
    const way = ant.way;
    let target = 0;
    if (way) {
      const wp = way[ant.wayAt];
      const left = Math.abs(wp.s - loc.s);
      const last = ant.wayAt === way.length - 1;
      const turning = !last && way[ant.wayAt + 1].f !== loc.f;
      if (last && !Number.isNaN(ant.goalU) && left < 9) {
        target = ant.goalU;
      } else if (!(turning && left < 3) && !(last && left < 2)) {
        const room = this.nest.across(loc.f, loc.s);
        const half = room ? (room.hi - room.lo) / 2 : 0;
        const lane = Math.min(1.4, Math.max(0, half - 1.6)) * (0.7 + 0.3 * ant.quirk);
        target = wp.s > loc.s ? -lane : lane;
      }
    } else if (!Number.isNaN(ant.goalU)) {
      target = ant.goalU;
    }
    const rate = 7 * dt;
    loc.u += clamp(target - loc.u, -rate, rate);
    loc.u = this.nest.clampU(loc.f, loc.s, loc.u, bodyHalf(ant));
  }

  /**
   * How far along feature `f` one may stand: its whole length when dug
   * through, else short of the face, whose soil is dug unevenly.
   */
  private standReach(f: number): number {
    const reach = this.nest.reachOf(f);
    const length = this.plan.features[f].line.length;
    return Math.max(0, reach >= length ? length : reach - 1.2);
  }

  /** Puts an ant where its place says, as it stands still (after a restore, or a move by hand). */
  settle(ant: Ant): void {
    if (ant.loc.f >= 0) {
      ant.loc.s = clamp(ant.loc.s, 0, this.standReach(ant.loc.f));
      ant.loc.u = this.nest.clampU(ant.loc.f, ant.loc.s, ant.loc.u, bodyHalf(ant));
    }
    this.place(ant);
  }

  /** Updates an ant's position from its place. */
  place(ant: Ant): void {
    this.locate(ant.loc, P);
    ant.x = P.x;
    ant.y = P.y;
  }

  /** Flight: the founding queen coming down, the winged young going up and away. */
  private fly(ant: Ant, dt: number): void {
    const r = this.rng;
    ant.pose = "fly";
    // Fluttering: the course wavers.
    ant.vx += r.range(-1, 1) * 90 * dt;
    ant.vy += r.range(-1, 1) * 60 * dt;
    if (ant.task?.kind === "found") {
      // Coming down toward where she will land.
      const tx = ant.task.x;
      const ty = this.surface.height(tx);
      const dx = tx - ant.x;
      const dy = ty - ant.y;
      const d = Math.hypot(dx, dy) || 1;
      const speed = Math.min(34, 8 + d * 0.4);
      ant.vx += ((dx / d) * speed - ant.vx) * Math.min(1, dt * 2.2);
      ant.vy += ((dy / d) * speed - ant.vy) * Math.min(1, dt * 2.2);
      if (d < 1.5 || ant.y <= this.surface.height(ant.x)) {
        ant.loc = { f: SURFACE, s: ant.x, u: 0 };
        ant.vx = 0;
        ant.vy = 0;
        this.place(ant);
        this.events.push({ kind: "touchdown", x: ant.x, y: ant.y });
        ant.pose = "still";
        return;
      }
    } else {
      // Up and away, drifting with the wind.
      const wind = this.env.weather.state.wind;
      ant.vx += (ant.vx > 0 ? 1 : -1) * 6 * dt + wind * 20 * dt;
      ant.vy += (48 - ant.vy) * Math.min(1, dt * 0.8);
    }
    ant.x += ant.vx * dt;
    ant.y += ant.vy * dt;
    ant.loc.s = ant.x;
    ant.loc.u = ant.y;
    ant.gait += Math.hypot(ant.vx, ant.vy) * dt;
    turnToward(ant, Math.atan2(ant.vy, ant.vx), dt * 6);
  }

  /** Ants that meet head-on in a tunnel stop a moment and touch antennae. */
  private meetings(): void {
    const now = this.time;
    const walking = this.ants.filter((a) => a.way !== null && a.loc.f >= 0 && a.wait <= 0);
    for (let i = 0; i < walking.length; i++) {
      const a = walking[i];
      if (now - a.met < 6) {
        continue;
      }
      for (let j = i + 1; j < walking.length; j++) {
        const b = walking[j];
        if (now - b.met < 6 || b.loc.f !== a.loc.f) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const reach = (a.size + b.size) * 0.4;
        if (dx * dx + dy * dy > reach * reach) {
          continue;
        }
        // Head to head: each facing the other.
        const facing =
          Math.cos(a.heading - Math.atan2(dy, dx)) > 0.5 &&
          Math.cos(b.heading - Math.atan2(-dy, -dx)) > 0.5;
        a.met = now;
        b.met = now;
        if (!facing || !this.rng.chance(0.45)) {
          continue;
        }
        const t = this.rng.range(0.35, 0.9);
        a.wait = t;
        b.wait = t;
        a.pose = "antennate";
        b.pose = "antennate";
        break;
      }
    }
  }

  /** Puts down what an ant carried, where it stands. */
  putDown(ant: Ant, kind: string, id: number, amount: number): void {
    const loc = ant.loc.f === AIR_LOC ? { f: SURFACE, s: ant.x, u: 0 } : { ...ant.loc };
    if (kind === "brood") {
      const b = this.broodOf(id);
      if (b) {
        b.loc = loc;
        b.carried = false;
      }
    } else if (kind === "husk" || kind === "scrap") {
      const it = this.itemOf(id);
      if (it) {
        it.loc = loc;
        it.carried = false;
      }
    } else if (kind === "food" && amount > 0) {
      this.colony.honey += amount;
    }
    ant.cargo = null;
  }

  // ─── Brood ─────────────────────────────────────────────────────────────

  addBrood(b: Brood): Brood {
    this.brood.push(b);
    this.broodById.set(b.id, b);
    return b;
  }

  private removeBrood(b: Brood): void {
    const i = this.brood.indexOf(b);
    if (i >= 0) {
      this.brood.splice(i, 1);
    }
    this.broodById.delete(b.id);
  }

  /** Where a brood item is: on the floor, or in the jaws of whoever carries it. */
  broodLoc(b: Brood): Loc {
    if (b.carried) {
      const carrier = this.ants.find((a) => a.cargo?.kind === "brood" && a.cargo.id === b.id);
      if (carrier) {
        return carrier.loc;
      }
    }
    return b.loc;
  }

  /** Eggs hatch, larvae grow as they are fed, pupae turn into adults; all by the warmth around them. */
  private growBrood(days: number): void {
    if (days <= 0) {
      return;
    }
    for (let i = this.brood.length - 1; i >= 0; i--) {
      const b = this.brood[i];
      const rate = growth(this.temperatureAt(this.broodLoc(b)));
      if (rate <= 0) {
        continue;
      }
      const slower = b.caste !== "worker" && b.stage !== "egg" ? ALATE_SLOWER : 1;
      let progress = b.progress + (rate * days) / (STAGE_DAYS[b.stage] * slower);
      if (b.stage === "larva") {
        // A larva grows only as far as it has been fed.
        progress = Math.min(progress, b.fed / LARVA_FOOD[b.caste] + 0.12);
      }
      b.progress = Math.min(1.05, progress);
      if (b.progress < 1 || b.carried) {
        continue;
      }
      if (b.stage === "egg") {
        b.stage = "larva";
        b.progress = 0;
        b.fed = 0;
      } else if (b.stage === "larva") {
        b.stage = "pupa";
        b.progress = 0;
      } else {
        this.eclose(b);
      }
    }
  }

  /** A pupa's adult comes out, leaving the husk of its cocoon. */
  private eclose(b: Brood): void {
    this.removeBrood(b);
    const r = this.rng;
    let size: number;
    let caste: Caste = b.caste;
    if (b.caste === "worker") {
      // The first workers are small; later, some are big-headed majors.
      if (this.workers < FIRST_BROOD) {
        size = r.range(6.2, 7.2);
      } else if (this.workers > 40 && r.chance(0.16)) {
        size = r.range(10.5, 12.5);
      } else {
        size = r.range(7.4, 9.6);
      }
    } else {
      caste = b.caste;
      size = SIZE[b.caste] * r.range(0.96, 1.04);
    }
    const ant = this.newAnt(caste, size, this.day, { ...b.loc });
    this.settle(ant);
    if (caste === "worker") {
      this.workers++;
    }
    this.events.push({ kind: "eclose", x: ant.x, y: ant.y });
    this.addItem({
      id: this.nextId++,
      kind: "husk",
      loc: { ...b.loc },
      amount: 1,
      size: b.caste === "worker" ? 5 : 8,
      variant: r.int(0, 1 << 16),
      since: this.day,
      carried: false,
      drop: 0,
      fall: 0,
      soggy: 0,
    });
  }

  /** The queen's eggs come due with the season, the warmth, the food and the room there is. */
  private layEggs(days: number): void {
    const c = this.colony;
    if (days <= 0 || !this.queen) {
      return;
    }
    if (c.stage === "claustral") {
      const laid = this.brood.length + this.workers;
      if (laid < FIRST_BROOD) {
        c.eggsDue += days * 30;
      }
      return;
    }
    if (c.stage !== "colony" || c.broodChamber < 0) {
      return;
    }
    const f = this.season.yearFraction;
    const season = smoothstep(0.03, 0.13, f) * (1 - smoothstep(0.56, 0.66, f));
    const warmth = growth(this.chamberTemperature(c.broodChamber));
    // Laying eases off as the colony fills the ground, never quite stopping, so the old are replaced.
    const room = clamp01(1.12 - (this.workers + this.brood.length * 0.6) / WORKER_CAP);
    const larvae = this.brood.filter((b) => b.stage === "larva").length;
    const food = clamp01(0.55 + (c.honey + this.storedFood()) / (larvae * 0.4 + 2));
    // No more young than the workers can feed.
    const care = clamp01(1.4 - larvae / (this.workers * 1.3 + 6));
    const rate =
      (10 + 0.6 * this.workers) * season * Math.min(1, warmth * 1.3) * room * food * care;
    c.eggsDue = Math.min(6, c.eggsDue + rate * days * (1 - c.dormancy));
  }

  /** Lays an egg where the queen is; what it will become depends on the colony and the season. */
  layEgg(queen: Ant): void {
    const c = this.colony;
    c.eggsDue = Math.max(0, c.eggsDue - 1);
    const f = this.season.yearFraction;
    let caste: BroodCaste = "worker";
    // A grown colony raises winged young through the summer.
    const age = this.day - c.foundedAt;
    if (
      this.workers >= 60 &&
      age > DAYS_PER_YEAR * 0.8 &&
      f > 0.3 &&
      f < 0.48 &&
      this.rng.chance(0.35)
    ) {
      caste = this.rng.chance(0.4) ? "gyne" : "male";
    }
    const loc = this.pileSpot(queen.loc.f >= 0 ? queen.loc.f : c.broodChamber, "egg", 0.6);
    this.addBrood({
      id: this.nextId++,
      stage: "egg",
      caste,
      progress: 0,
      fed: 0,
      loc: loc ?? { ...queen.loc },
      carried: false,
    });
    this.events.push({ kind: "lay", x: queen.x, y: queen.y });
  }

  // ─── Items ─────────────────────────────────────────────────────────────

  addItem(item: Item): Item {
    this.items.push(item);
    this.itemById.set(item.id, item);
    return item;
  }

  removeItem(item: Item): void {
    const i = this.items.indexOf(item);
    if (i >= 0) {
      this.items.splice(i, 1);
    }
    this.itemById.delete(item.id);
    const k = this.colony.known.indexOf(item.id);
    if (k >= 0) {
      this.colony.known.splice(k, 1);
    }
  }

  /**
   * A stored piece of food is eaten up: bits of insect leave their hard
   * remains behind, to be carried out.
   */
  useUp(item: Item): void {
    this.removeItem(item);
    if (item.kind === "store" && item.variant === 1) {
      this.addItem({
        id: this.nextId++,
        kind: "scrap",
        loc: { ...item.loc },
        amount: 1,
        size: 2,
        variant: this.rng.int(0, 1 << 16),
        since: this.day,
        carried: false,
        drop: 0,
        fall: 0,
        soggy: 0,
      });
    }
  }

  /**
   * Whether a worker has lived its span: out foraging, it will not come back.
   * Each worker's span is its own, from under two years to five.
   */
  worn(ant: Ant): boolean {
    return (
      ant.caste === "worker" && this.day - ant.born > WORKER_LIFE * (1 + 2 * hash2(ant.id, 0x11fe))
    );
  }

  /** An old worker out on the ground turns away from the cut and walks off into the grass. */
  leave(ant: Ant): void {
    if (ant.cargo) {
      this.putDown(ant, ant.cargo.kind, ant.cargo.id, ant.cargo.amount);
    }
    ant.way = null;
    ant.task = null;
    ant.leaving = 0;
  }

  /** The colony's adults eat `amount` units: from the shared honey first, then from the store. */
  private eat(amount: number): void {
    const c = this.colony;
    const fromHoney = Math.min(c.honey, amount);
    c.honey -= fromHoney;
    let left = amount - fromHoney;
    for (let i = this.items.length - 1; i >= 0 && left > 0; i--) {
      const it = this.items[i];
      if (it.kind !== "store" || it.carried) {
        continue;
      }
      const take = Math.min(it.amount, left);
      it.amount -= take;
      left -= take;
      if (it.amount < 0.05) {
        this.useUp(it);
      }
    }
  }

  /** Food (units) stored in the nest. */
  storedFood(): number {
    let sum = 0;
    for (const it of this.items) {
      if (it.kind === "store") {
        sum += it.amount;
      }
    }
    return sum;
  }

  /** Things fall and land, get soaked in the rain, and rot away or are cleared by the weather. */
  private updateItems(dt: number, days: number): void {
    const rain = this.env.weather.state.rain;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.drop > 0 || it.fall !== 0) {
        // Crumbs and insects fall, hit the ground, hop a little and settle.
        // A hop too small to outlast one step is no hop: it settles, however long the step.
        it.drop -= it.fall * dt;
        it.fall = Math.min(FALL_TERMINAL, it.fall + GRAVITY * dt);
        if (it.drop <= 0) {
          const hit = it.fall;
          it.drop = 0;
          const bounces = hit * HOP > Math.max(HOP_SPEED, GRAVITY * dt * 2);
          it.fall = bounces ? -hit * HOP : 0;
          if (hit > HOP_SPEED * 0.5) {
            this.events.push({
              kind: "land",
              x: it.loc.s,
              y: this.surface.height(it.loc.s),
              size: it.size,
              item: it.kind,
            });
          }
        }
        continue;
      }
      if (it.loc.f !== SURFACE || it.carried) {
        continue;
      }
      if (rain > 0.05) {
        it.soggy = Math.min(1, it.soggy + rain * days * 3);
      }
      const life = LIFETIME[it.kind] * (1 - 0.45 * it.soggy);
      if (this.day - it.since > life) {
        this.removeItem(it);
      }
    }
  }

  /** Dead insects fall to the ground now and then in the warm months, by day. */
  private spawnInsects(seconds: number): void {
    const season = this.season;
    const env = this.env;
    const day = smoothstep(-2, 10, env.sky.sunAltitude);
    const w = env.weather.state;
    const rate = 2.8 * smoothstep(0.35, 0.7, season.warmth) * (0.3 + 0.7 * day) * (1 - w.rain);
    if (!this.rng.chance((rate * seconds) / TIMEKEEPING.secondsPerDay)) {
      return;
    }
    const r = this.rng;
    const x = r.chance(0.8) ? r.range(FRAME.x0 + 6, FRAME.x1 - 6) : r.range(-220, 220);
    // A small fly or moth, a caterpillar, a young grasshopper.
    const variant = r.int(0, 3);
    const size = [3.5, 7, 9, 6][variant] * r.range(0.85, 1.15);
    this.addItem({
      id: this.nextId++,
      kind: "insect",
      loc: { f: SURFACE, s: x, u: 0 },
      amount: Math.round(size * 0.9),
      size,
      variant,
      since: this.day,
      carried: false,
      drop: r.range(40, 110),
      fall: 0,
      soggy: 0,
    });
  }

  // ─── The colony ────────────────────────────────────────────────────────

  /** The colony looks at how it stands: season, weather, chambers, and what needs doing. */
  private tick(): void {
    const c = this.colony;
    this.countDoing();
    this.surface.setCraters(this.dugPortalXs());
    // Winter rest keeps to the depth of winter: it begins once the ground a
    // hand's depth down is cold in midwinter, holds through mild spells, and
    // ends as midwinter passes; a cold spell after that only slows the ants.
    const deep = this.climate.temperatureAt(100);
    const f = this.season.yearFraction;
    const midwinter = f >= WINTER_REST[0] && f < WINTER_REST[1];
    const resting = c.dormancy > 0.5;
    const rest = midwinter && (resting || deep < 10);
    c.dormancy = clamp01(c.dormancy + ((rest ? 1 : 0) - c.dormancy) * 0.012 * COLONY_TICK);
    // The first workers are out of their cocoons: the colony opens up and goes to work.
    if (c.stage === "claustral" && this.workers > 0) {
      c.stage = "colony";
      c.closed = false;
    }
    if (c.stage === "colony") {
      this.chooseChambers();
      this.decideClosed();
      this.spawnInsects(COLONY_TICK);
      // The adults eat, less as the cold slows them.
      const days = COLONY_TICK / TIMEKEEPING.secondsPerDay;
      this.eat(this.workers * RATION * days * (1 - 0.8 * c.dormancy));
    }
    c.known = c.known.filter((id) => {
      const it = this.itemOf(id);
      return it !== undefined && it.amount > 0 && it.loc.f === SURFACE;
    });
    this.digFront = this.frontier();
  }

  private countDoing(): void {
    const doing = this.doing;
    doing.clear();
    let workers = 0;
    for (const a of this.ants) {
      if (a.caste === "worker") {
        workers++;
      }
      if (a.task) {
        const key = a.task.kind === "dig" ? `dig:${a.task.f}` : a.task.kind;
        doing.set(key, (doing.get(key) ?? 0) + 1);
        if (a.task.kind === "dig") {
          doing.set("dig", (doing.get("dig") ?? 0) + 1);
        }
      }
    }
    this.workers = workers;
  }

  /** Counts one more ant at `key` until the next tick recounts. */
  note(key: string): void {
    this.doing.set(key, (this.doing.get(key) ?? 0) + 1);
  }

  count(key: string): number {
    return this.doing.get(key) ?? 0;
  }

  /** Mean temperature (°C) of a chamber, by the depth of its middle. */
  chamberTemperature(f: number): number {
    const line = this.plan.features[f].line;
    const x = line.x(line.length / 2);
    return this.climate.temperatureAt(this.soil.ground(x) - line.y(line.length / 2));
  }

  /** Whether one can walk from the entrance to feature `f`. */
  reachable(f: number): boolean {
    let g = f;
    const features = this.plan.features;
    while (g >= 0) {
      const feature = features[g];
      if (feature.parent < 0) {
        return true;
      }
      if (!this.nest.passable(feature.parent, feature.attachS)) {
        return false;
      }
      g = feature.parent;
    }
    return true;
  }

  /** Chambers dug out enough to live in and reachable. */
  usableChambers(): number[] {
    const list: number[] = [];
    for (const f of this.plan.features) {
      if (
        f.kind === "chamber" &&
        this.reachable(f.index) &&
        this.nest.reachOf(f.index) >= Math.min(14, f.line.length * 0.6)
      ) {
        list.push(f.index);
      }
    }
    return list;
  }

  /**
   * Keeps the brood where the warmth suits it best (the deepest chamber in
   * winter), and the food in another chamber near the way in.
   */
  private chooseChambers(): void {
    const c = this.colony;
    const chambers = this.usableChambers();
    if (chambers.length === 0) {
      return;
    }
    const want = c.dormancy > 0.3 ? 40 : 27;
    const fit = (f: number) =>
      -Math.abs(this.chamberTemperature(f) - want) + this.nest.progress(f) * 1.5;
    let best = chambers[0];
    for (const f of chambers) {
      if (fit(f) > fit(best)) {
        best = f;
      }
    }
    const current = c.broodChamber;
    // The brood is moved only for a clear gain, and not again for a while; in the depth of winter, not at all.
    const settled = this.day - this.broodChosenAt > 0.8 && (c.dormancy < 0.5 || current < 0);
    if (current < 0 || !chambers.includes(current) || (settled && fit(best) > fit(current) + 4)) {
      if (best !== current) {
        c.broodChamber = best;
        this.broodChosenAt = this.day;
      }
    }
    const others = chambers.filter((f) => f !== c.broodChamber);
    if (others.length === 0) {
      c.foodChamber = c.broodChamber;
    } else if (!others.includes(c.foodChamber)) {
      // The shallowest other chamber: near the way in.
      c.foodChamber = others.reduce((a, b) =>
        this.plan.features[a].line.y(0) > this.plan.features[b].line.y(0) ? a : b,
      );
    }
  }

  /**
   * Plugs the entrances for rain and for winter, opens them after. The hole
   * in the middle of a plug is closed only once everyone is in.
   */
  private decideClosed(): void {
    const c = this.colony;
    const w = this.env.weather.state;
    const shut = c.dormancy > 0.35 || w.rain > 0.45 || w.storm > 0.1 || w.snowCover > 0.3;
    const open =
      c.dormancy < 0.2 && w.rain < 0.03 && w.wetness < 0.8 && w.storm < 0.05 && w.snowCover < 0.1;
    if (this.flightDue()) {
      c.closed = false;
    } else if (!c.closed && shut) {
      c.closed = true;
    } else if (c.closed && open) {
      c.closed = false;
    }
  }

  /** Whether any ant but `self` stands in portal `p`'s plug, or just beside it. */
  anyoneInPlug(p: number, self: Ant): boolean {
    const portal = this.plan.portals[p];
    return this.ants.some(
      (a) =>
        a !== self &&
        a.loc.f === portal.feature &&
        a.loc.s > portal.plugS0 - 1.5 &&
        a.loc.s < portal.plugS1 + 1.5,
    );
  }

  /** Whether any worker is out on the surface or up a plant. */
  anyoneOutside(): boolean {
    return this.ants.some((a) => a.caste === "worker" && a.loc.f < 0);
  }

  /**
   * Whether today the winged young fly: a warm, still afternoon in late
   * spring, once a year, when there are any.
   */
  flightDue(): boolean {
    const c = this.colony;
    if (c.flownYear >= this.year || c.dormancy > 0.2) {
      return false;
    }
    const f = this.season.yearFraction;
    const hour = this.env.clock.hour;
    const w = this.env.weather.state;
    const winged = this.ants.some((a) => a.winged && a.caste !== "queen");
    return (
      winged &&
      f > 0.14 &&
      f < 0.32 &&
      hour > 12.5 &&
      hour < 18 &&
      w.rain < 0.02 &&
      w.wind < 0.45 &&
      this.climate.surface > 16
    );
  }

  /** Features the colony may dig now: begun or ready to begin, and allowed by its size. */
  private frontier(): number[] {
    const list: number[] = [];
    const workers = this.workers;
    for (const f of this.plan.features) {
      if (f.minWorkers > workers || this.nest.complete(f.index)) {
        continue;
      }
      if (f.parent >= 0 && !this.nest.passable(f.parent, f.attachS)) {
        continue;
      }
      if (!this.reachable(f.index)) {
        continue;
      }
      list.push(f.index);
    }
    return list;
  }

  /** Cells (mm²) of nest the colony wants for its size. */
  wantedRoom(): number {
    return 420 + 34 * this.workers + 6 * this.brood.length;
  }

  // ─── Places ────────────────────────────────────────────────────────────

  /**
   * Whether a brood item lies away from the heap of its stage in chamber `f`:
   * a larva just hatched among the eggs, a cocoon just spun among the larvae.
   */
  outOfHeap(b: Brood, f: number): boolean {
    const feature = this.plan.features[f];
    if (feature.kind !== "chamber" || b.loc.f !== f) {
      return false;
    }
    const reach = Math.max(2, this.nest.reachOf(f));
    return Math.abs(b.loc.s - reach * HEAPS[b.stage]) > Math.max(5, reach * 0.16);
  }

  /**
   * A place to stand in feature `f` with no other ant standing within
   * `clearance` (mm), kept `margin` from the walls; the least crowded of a few
   * tries when every place is taken. Null if nothing there is open.
   */
  freeSpot(f: number, self: Ant, margin: number, clearance: number): Loc | null {
    let best: Loc | null = null;
    let bestD = -1;
    for (let tries = 0; tries < 10; tries++) {
      const spot = this.nest.spot(f, this.rng, margin);
      if (!spot) {
        continue;
      }
      const p = this.locate(spot, P);
      const px = p.x;
      const py = p.y;
      let nearest = Infinity;
      for (const a of this.ants) {
        if (a === self || a.loc.f !== f) {
          continue;
        }
        // Where an ant on its way will stand is not known; where it is now is near enough.
        nearest = Math.min(nearest, Math.hypot(a.x - px, a.y - py));
      }
      if (nearest >= clearance) {
        return spot;
      }
      if (nearest > bestD) {
        bestD = nearest;
        best = spot;
      }
    }
    return best;
  }

  /**
   * A free place in chamber `f` for something of radius `r` (mm): brood by
   * stage in heaps along the floor, food in a heap of its own, husks in a
   * corner. Null if the chamber has no room open yet.
   */
  pileSpot(f: number, heap: "egg" | "larva" | "pupa" | "store" | "husk", r: number): Loc | null {
    const feature = this.plan.features[f];
    if (feature.kind !== "chamber") {
      return this.nest.spot(f, this.rng, 1.2);
    }
    const reach = Math.max(2, this.nest.reachOf(f));
    const anchor = HEAPS[heap];
    const line = feature.line;
    const dir = Math.sign(line.x(line.length) - line.x(0)) || 1;
    const entryY = line.y(0);
    const others: Point[] = [];
    for (const b of this.brood) {
      if (!b.carried && b.loc.f === f) {
        const p = this.locate(b.loc, { x: 0, y: 0 });
        others.push(p);
      }
    }
    for (const it of this.items) {
      if (!it.carried && it.loc.f === f) {
        others.push(this.locate(it.loc, { x: 0, y: 0 }));
      }
    }
    const rr = this.rng;
    const sc = reach * anchor;
    for (let tries = 0; tries < 40; tries++) {
      // Spiral out from the heap's middle along the floor.
      const spread = 1 + tries * 0.55;
      const s = clamp(sc + rr.range(-1, 1) * spread * 1.6, 1.5, reach - 1.5);
      const room = this.nest.across(f, s);
      if (!room) {
        continue;
      }
      // World y is entryY + u * dir; the floor is the low side.
      const yFloor = entryY + (dir > 0 ? room.lo : -room.hi);
      const lift = Math.min(tries * 0.18, 3) * rr.next();
      const y = yFloor + r + 0.2 + lift;
      const u = (y - entryY) * dir;
      const loc = { f, s, u: this.nest.clampU(f, s, u, r * 0.8) };
      const p = this.locate(loc, { x: 0, y: 0 });
      // On open ground (the floor is uneven within a millimeter), clear of what lies there.
      const m = this.nest.material[cellIndex(p.x, p.y)];
      if (
        (m === OPEN || m === AIR) &&
        others.every((o) => Math.hypot(o.x - p.x, o.y - p.y) > r * 1.5)
      ) {
        return loc;
      }
    }
    return this.nest.spot(f, this.rng, r);
  }
}

/** Where along a chamber (share of its length dug) each heap is kept. */
const HEAPS = { egg: 0.34, larva: 0.58, pupa: 0.8, store: 0.5, husk: 0.92 } as const;

/** Days things lie on the ground before they rot, dry up or blow away. */
const LIFETIME: Record<ItemKind, number> = {
  crumb: 2.6,
  insect: 2.2,
  store: Infinity,
  husk: 3,
  scrap: 3,
  wing: 4,
};

/** Half the width (mm) of an ant's body, what it keeps from the walls. */
export function bodyHalf(ant: Ant): number {
  return ant.caste === "queen" ? 2.1 : ant.caste === "worker" ? 0.9 + 0.1 * ant.size : 1.6;
}

/** Turns an ant's heading toward `angle`, by at most the share `k` of the way. */
function turnToward(ant: Ant, angle: number, k: number): void {
  let d = angle - ant.heading;
  d -= Math.round(d / TAU) * TAU;
  ant.heading += d * Math.min(1, k);
}
