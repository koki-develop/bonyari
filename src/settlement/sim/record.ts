import {
  asRecord,
  isCount,
  isFiniteNumber,
  isOneOf,
  isUint32,
} from "../../shared/core/validate.ts";
import { type EnvironmentSnapshot, readEnvironmentSnapshot } from "../../shared/env/environment.ts";
import type { Animal, AnimalKind } from "./animals.ts";
import {
  type Building,
  type BuildingKind,
  type Job,
  KINDS,
  type Phase,
  type RoofStuff,
  type Site,
  type Trim,
  type WallStuff,
} from "./buildings.ts";
import type { Paving } from "./council.ts";
import type { Carry } from "./people.ts";
import { WORLD } from "./terrain.ts";
import type { FieldState } from "./town.ts";
import type { Pile } from "./world.ts";

/** A person as kept: who they are and where they were. What they were doing is chosen afresh. */
export interface PersonRecord {
  id: number;
  household: number;
  age: number;
  female: boolean;
  job: Job;
  look: number;
  x: number;
  y: number;
  inside: number;
  militia: boolean;
  leaving: boolean;
  arriving: boolean;
}

export interface AnimalRecord {
  id: number;
  kind: AnimalKind;
  x: number;
  y: number;
  home: { type: "pasture" | "lot" | "person" | "wild"; id: number };
  load: number;
  cargo: Animal["cargo"];
}

/** The settlement as left, enough to come back to it: see `World.snapshot` and `World.restore`. */
export interface SettlementRecord {
  seed: number;
  env: EnvironmentSnapshot;
  time: number;
  founded: number;
  rng: number;
  nextId: number;
  stock: { wood: number; stone: number; food: number };
  town: {
    streetGrade: number[];
    squareGrade: number;
    fields: FieldState[];
    fenced: boolean[];
    lotGround: number[];
    buildings: Building[];
    nextBuildingId: number;
  };
  /** Each tree's state, as runs of [state, count]. */
  forest: number[];
  council: {
    era: number;
    openFields: number[];
    opening: number[];
    paving: Paving | null;
    quarried: number;
    fencing: number;
    nextArrival: number;
    threat: number;
  };
  raids: {
    nextSmall: number;
    nextMedium: number;
    nextLarge: number;
    count: number;
    larges: number;
  };
  people: PersonRecord[];
  households: { id: number; home: number; lodging: number; members: number[] }[];
  animals: AnimalRecord[];
  piles: Pile[];
}

/** Version of the encoded form; records of any other version are not read. */
const FORMAT = 2;

const JOBS: readonly Job[] = [
  "builder",
  "woodcutter",
  "farmer",
  "hauler",
  "quarrier",
  "smith",
  "baker",
  "innkeeper",
  "miller",
  "priest",
  "guard",
  "shepherd",
  "wizard",
  "idle",
];
const PHASES: readonly Phase[] = ["clearing", "building", "standing", "demolish", "ruin"];
const WALLS: readonly WallStuff[] = [
  "log",
  "plank",
  "plaster",
  "plasterWarm",
  "plasterPink",
  "stone",
];
const ROOFS: readonly RoofStuff[] = ["bark", "thatch", "shingle", "tile", "slate"];
const TRIMS: readonly Trim[] = ["green", "brown", "blue", "red"];
const ANIMALS: readonly AnimalKind[] = ["sheep", "cow", "chicken", "dog", "crow", "duck", "ox"];
const CARGOES: readonly Animal["cargo"][] = ["logs", "stones", "sacks"];
const CROPS: readonly FieldState["crop"][] = ["wheat", "barley", "oats", "flax"];
const PILES: readonly Pile["kind"][] = ["logs", "stones", "brush"];
const KIND_NAMES = Object.keys(KINDS) as BuildingKind[];

export function encodeRecord(record: SettlementRecord): string {
  return JSON.stringify({ format: FORMAT, record });
}

/** The record in `text`, or null unless it is a well-formed record of the current format. */
export function decodeRecord(text: string): SettlementRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const o = asRecord(data);
  return o?.format === FORMAT ? readRecord(o.record) : null;
}

/** Runs of equal values, as [value, count] pairs. */
export function runs(values: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j < values.length && values[j] === values[i]) {
      j++;
    }
    out.push(values[i], j - i);
    i = j;
  }
  return out;
}

/** The values the runs spell out, `length` of them, or null if they do not add up. */
export function unrun(pairs: readonly number[], length: number): Uint8Array | null {
  const out = new Uint8Array(length);
  let k = 0;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const v = pairs[i];
    const n = pairs[i + 1];
    if (!isCount(v) || v > 2 || !isCount(n) || k + n > length) {
      return null;
    }
    out.fill(v, k, k + n);
    k += n;
  }
  return k === length ? out : null;
}

const num = isFiniteNumber;
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const nums = (v: unknown): v is number[] => Array.isArray(v) && v.every(num);

function readRecord(value: unknown): SettlementRecord | null {
  const o = asRecord(value);
  if (
    !o ||
    !isUint32(o.seed) ||
    !num(o.time) ||
    !num(o.founded) ||
    !isUint32(o.rng) ||
    !isCount(o.nextId)
  ) {
    return null;
  }
  const env = readEnvironmentSnapshot(o.env);
  const stock = asRecord(o.stock);
  const town = asRecord(o.town);
  const council = asRecord(o.council);
  const raids = asRecord(o.raids);
  if (!env || !stock || !town || !council || !raids || !nums(o.forest)) {
    return null;
  }
  if (!num(stock.wood) || !num(stock.stone) || !num(stock.food)) {
    return null;
  }
  const buildings = readList(town.buildings, readBuilding);
  const fields = readList(town.fields, readField);
  if (
    !buildings ||
    !fields ||
    !nums(town.streetGrade) ||
    !num(town.squareGrade) ||
    !Array.isArray(town.fenced) ||
    !town.fenced.every(bool) ||
    !nums(town.lotGround) ||
    !isCount(town.nextBuildingId)
  ) {
    return null;
  }
  const paving = council.paving === null ? null : readPaving(council.paving);
  if (
    !num(council.era) ||
    !nums(council.openFields) ||
    !nums(council.opening) ||
    paving === undefined ||
    !num(council.quarried) ||
    !num(council.fencing) ||
    !num(council.nextArrival) ||
    !num(council.threat)
  ) {
    return null;
  }
  // Raids not yet due are kept as null (Infinity does not survive JSON).
  const dueOrNull = (v: unknown) => num(v) || v === null;
  if (!dueOrNull(raids.nextSmall) || !dueOrNull(raids.nextMedium) || !dueOrNull(raids.nextLarge)) {
    return null;
  }
  const people = readList(o.people, readPerson);
  const households = readList(o.households, (v) => {
    const h = asRecord(v);
    return h && isCount(h.id) && num(h.home) && num(h.lodging) && nums(h.members)
      ? { id: h.id, home: h.home, lodging: h.lodging, members: h.members }
      : null;
  });
  const animals = readList(o.animals, readAnimal);
  const piles = readList(o.piles, readPile);
  if (!people || !households || !animals || !piles) {
    return null;
  }
  // Infinity does not survive JSON: a raid not yet due is kept as null.
  const due = (v: unknown) => (num(v) ? v : Infinity);
  return {
    seed: o.seed,
    env,
    time: o.time,
    founded: o.founded,
    rng: o.rng,
    nextId: o.nextId,
    stock: { wood: stock.wood, stone: stock.stone, food: stock.food },
    town: {
      streetGrade: town.streetGrade,
      squareGrade: town.squareGrade,
      fields,
      fenced: town.fenced as boolean[],
      lotGround: town.lotGround,
      buildings,
      nextBuildingId: town.nextBuildingId,
    },
    forest: o.forest,
    council: {
      era: council.era,
      openFields: council.openFields,
      opening: council.opening,
      paving,
      quarried: council.quarried,
      fencing: council.fencing,
      nextArrival: council.nextArrival,
      threat: council.threat,
    },
    raids: {
      nextSmall: due(raids.nextSmall),
      nextMedium: due(raids.nextMedium),
      nextLarge: due(raids.nextLarge),
      count: num(raids.count) ? raids.count : 0,
      larges: num(raids.larges) ? raids.larges : 0,
    },
    people,
    households,
    animals,
    piles,
  };
}

/** Every item of `value` read by `read`, or null if it is not a list or any item is malformed. */
/** Meters past the edge of the world that anything saved may stand (newcomers on the roads in). */
const OUTSKIRTS = 30;
/** Largest footprint (m) across of anything built. */
const WIDEST = 80;
/** Lowest and highest ground (m) a building may stand on. */
const BASE_RANGE = [-40, 200] as const;

/** Whether (x, y) lies in or near the world, so a save that has been tampered with can't send drawing off to astronomical sizes. */
function inWorld(x: number, y: number): boolean {
  return (
    x >= WORLD.x0 - OUTSKIRTS &&
    x <= WORLD.x1 + OUTSKIRTS &&
    y >= WORLD.y0 - OUTSKIRTS &&
    y <= WORLD.y1 + OUTSKIRTS
  );
}

function readList<T>(value: unknown, read: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: T[] = [];
  for (const v of value) {
    const item = read(v);
    if (item === null) {
      return null;
    }
    out.push(item);
  }
  return out;
}

function readSite(value: unknown): Site | null {
  const s = asRecord(value);
  if (!s) {
    return null;
  }
  switch (s.type) {
    case "lot":
      return isCount(s.lot) ? { type: "lot", lot: s.lot } : null;
    case "square":
      return { type: "square" };
    case "wall":
      return isCount(s.index) ? { type: "wall", index: s.index } : null;
    case "tower":
      return isCount(s.index) ? { type: "tower", index: s.index } : null;
    case "gate":
      return isCount(s.gate) ? { type: "gate", gate: s.gate } : null;
    case "ford":
      return { type: "ford" };
    default:
      return null;
  }
}

function readBuilding(value: unknown): Building | null {
  const b = asRecord(value);
  const rect = asRecord(b?.rect);
  const style = asRecord(b?.style);
  if (!b || !rect || !style) {
    return null;
  }
  const site = readSite(b.site);
  if (
    !site ||
    !isCount(b.id) ||
    !isOneOf(b.kind, KIND_NAMES) ||
    !num(rect.x) ||
    !num(rect.y) ||
    !num(rect.angle) ||
    !num(rect.width) ||
    !num(rect.depth) ||
    !num(b.base) ||
    !isUint32(b.variant) ||
    !isOneOf(style.wall, WALLS) ||
    !isOneOf(style.roof, ROOFS) ||
    !isOneOf(style.trim, TRIMS) ||
    !isOneOf(b.phase, PHASES) ||
    !num(b.progress) ||
    !num(b.wood) ||
    !num(b.stone) ||
    !nums(b.clearing) ||
    !num(b.damage) ||
    !num(b.char) ||
    !num(b.fire) ||
    !num(b.cleared) ||
    !inWorld(rect.x, rect.y) ||
    !(rect.width > 0 && rect.width <= WIDEST && rect.depth > 0 && rect.depth <= WIDEST) ||
    !(b.base >= BASE_RANGE[0] && b.base <= BASE_RANGE[1]) ||
    !(b.next === null || isOneOf(b.next, KIND_NAMES)) ||
    !bool(b.replacing) ||
    !bool(b.rebuilding) ||
    !num(b.lamps) ||
    !bool(b.shut)
  ) {
    return null;
  }
  return {
    id: b.id,
    kind: b.kind,
    site,
    rect: { x: rect.x, y: rect.y, angle: rect.angle, width: rect.width, depth: rect.depth },
    base: b.base,
    variant: b.variant,
    style: { wall: style.wall, roof: style.roof, trim: style.trim },
    phase: b.phase,
    progress: b.progress,
    wood: b.wood,
    stone: b.stone,
    clearing: b.clearing,
    damage: b.damage,
    char: b.char,
    fire: b.fire,
    cleared: b.cleared,
    next: b.next,
    replacing: b.replacing,
    rebuilding: b.rebuilding,
    lamps: b.lamps,
    shut: b.shut,
  };
}

function readField(value: unknown): FieldState | null {
  const f = asRecord(value);
  if (
    !f ||
    !bool(f.cleared) ||
    !num(f.sownYear) ||
    !num(f.reapedYear) ||
    !num(f.work) ||
    !isOneOf(f.crop, CROPS) ||
    !num(f.spoiled)
  ) {
    return null;
  }
  return {
    cleared: f.cleared,
    sownYear: f.sownYear,
    reapedYear: f.reapedYear,
    work: f.work,
    crop: f.crop,
    spoiled: f.spoiled,
  };
}

function readPaving(value: unknown): Paving | null | undefined {
  const p = asRecord(value);
  if (!p || !isCount(p.street) || !num(p.done) || !num(p.length) || !num(p.shown)) {
    return undefined;
  }
  return { street: p.street, done: p.done, length: p.length, shown: p.shown };
}

function readPerson(value: unknown): PersonRecord | null {
  const p = asRecord(value);
  if (
    !p ||
    !isCount(p.id) ||
    !isCount(p.household) ||
    !num(p.age) ||
    !bool(p.female) ||
    !isOneOf(p.job, JOBS) ||
    !isUint32(p.look) ||
    !num(p.x) ||
    !num(p.y) ||
    !num(p.inside) ||
    !bool(p.militia) ||
    !bool(p.leaving) ||
    !bool(p.arriving) ||
    !inWorld(p.x, p.y)
  ) {
    return null;
  }
  return {
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
  };
}

function readAnimal(value: unknown): AnimalRecord | null {
  const a = asRecord(value);
  const home = asRecord(a?.home);
  if (
    !a ||
    !home ||
    !isCount(a.id) ||
    !isOneOf(a.kind, ANIMALS) ||
    !num(a.x) ||
    !num(a.y) ||
    !isOneOf(home.type, ["pasture", "lot", "person", "wild"] as const) ||
    !num(home.id) ||
    !isCount(a.load) ||
    !isOneOf(a.cargo, CARGOES) ||
    !inWorld(a.x, a.y)
  ) {
    return null;
  }
  return {
    id: a.id,
    kind: a.kind,
    x: a.x,
    y: a.y,
    home: { type: home.type, id: home.id },
    load: a.load,
    cargo: a.cargo,
  };
}

function readPile(value: unknown): Pile | null {
  const q = asRecord(value);
  if (
    !q ||
    !isCount(q.id) ||
    !isOneOf(q.kind, PILES) ||
    !num(q.x) ||
    !num(q.y) ||
    !isCount(q.count) ||
    !num(q.angle) ||
    !num(q.burn) ||
    !inWorld(q.x, q.y)
  ) {
    return null;
  }
  return { id: q.id, kind: q.kind, x: q.x, y: q.y, count: q.count, angle: q.angle, burn: q.burn };
}

/** Carried loads that are kept by putting them down as piles where their carriers stood. */
export function isLoad(c: Carry | null): boolean {
  return c === "log" || c === "logs" || c === "stone";
}
