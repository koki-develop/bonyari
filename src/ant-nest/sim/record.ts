import {
  asRecord,
  isCount,
  isFiniteNumber,
  isOneOf,
  isUint32,
} from "../../shared/core/validate.ts";
import { type EnvironmentSnapshot, readEnvironmentSnapshot } from "../../shared/env/environment.ts";
import { Climate } from "./climate.ts";
import type {
  BroodCaste,
  Cargo,
  Caste,
  ColonyStage,
  ColonyState,
  ItemKind,
  Stage,
} from "./colony.ts";
import { GRID_SIZE, type Loc } from "./geometry.ts";

export interface AntRecord {
  id: number;
  caste: Caste;
  size: number;
  born: number;
  loc: Loc;
  heading: number;
  crop: number;
  winged: boolean;
  cargo: Pick<Cargo, "kind" | "id" | "amount"> | null;
}

export interface BroodRecord {
  id: number;
  stage: Stage;
  caste: BroodCaste;
  progress: number;
  fed: number;
  loc: Loc;
}

export interface ItemRecord {
  id: number;
  kind: ItemKind;
  loc: Loc;
  amount: number;
  size: number;
  variant: number;
  since: number;
  soggy: number;
}

/** The colony as left, enough to come back to it: see `World.snapshot` and `World.restore`. */
export interface ColonyRecord {
  seed: number;
  env: EnvironmentSnapshot;
  time: number;
  rng: number;
  nextId: number;
  colony: ColonyState;
  temperature: number[];
  moisture: number[];
  /** The cells dug out, in grid order. */
  open: number[];
  plugs: number[];
  heap: number[];
  ants: AntRecord[];
  brood: BroodRecord[];
  items: ItemRecord[];
}

/**
 * Version of the encoded form; records of any other version are not read.
 * The nest's plan is generated from the seed, so a change to how it is laid
 * out also needs a new version.
 */
const FORMAT = 1;

const CASTES: readonly Caste[] = ["queen", "worker", "gyne", "male"];
const BROOD_CASTES: readonly BroodCaste[] = ["worker", "gyne", "male"];
const STAGES: readonly Stage[] = ["egg", "larva", "pupa"];
const COLONY_STAGES: readonly ColonyStage[] = ["arrival", "founding", "claustral", "colony"];
const ITEM_KINDS: readonly ItemKind[] = ["crumb", "insect", "store", "husk", "scrap", "wing"];
const CARGO_KINDS: readonly Cargo["kind"][] = ["soil", "brood", "food", "husk", "scrap"];

export function encodeRecord(record: ColonyRecord): string {
  const { open, heap, temperature, moisture, ...rest } = record;
  return JSON.stringify({
    format: FORMAT,
    record: {
      ...rest,
      open: encodeRuns(open),
      // A tenth of a millimeter is fine enough for the heap, a hundredth of a degree for the soil.
      heap: heap.map((h) => Math.round(h * 10)),
      temperature: temperature.map((t) => Math.round(t * 100) / 100),
      moisture: moisture.map((m) => Math.round(m * 1000) / 1000),
    },
  });
}

/** The record in `text`, or null unless it is a well-formed record of the current format. */
export function decodeRecord(text: string): ColonyRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const o = asRecord(data);
  return o?.format === FORMAT ? readRecord(o.record) : null;
}

function readRecord(value: unknown): ColonyRecord | null {
  const o = asRecord(value);
  if (
    !o ||
    !isUint32(o.seed) ||
    !isFiniteNumber(o.time) ||
    !isUint32(o.rng) ||
    !isCount(o.nextId) ||
    typeof o.open !== "string"
  ) {
    return null;
  }
  const env = readEnvironmentSnapshot(o.env);
  const colony = readColony(o.colony);
  const temperature = readNumbers(o.temperature, Climate.nodes);
  const moisture = readNumbers(o.moisture, Climate.nodes);
  const open = decodeRuns(o.open);
  const plugs = readList(o.plugs, (v) => (isCount(v) ? v : null));
  const heap = readList(o.heap, (v) => (isFiniteNumber(v) && v >= 0 ? v / 10 : null));
  const ants = readList(o.ants, readAnt);
  const brood = readList(o.brood, readBrood);
  const items = readList(o.items, readItem);
  if (
    !env ||
    !colony ||
    !temperature ||
    !moisture ||
    !open ||
    !plugs ||
    !heap ||
    !ants ||
    !brood ||
    !items
  ) {
    return null;
  }
  return {
    seed: o.seed,
    env,
    time: o.time,
    rng: o.rng,
    nextId: o.nextId,
    colony,
    temperature,
    moisture,
    open,
    plugs,
    heap,
    ants,
    brood,
    items,
  };
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

function readNumbers(value: unknown, length: number): number[] | null {
  const list = readList(value, (v) => (isFiniteNumber(v) ? v : null));
  return list && list.length === length ? list : null;
}

function readLoc(value: unknown): Loc | null {
  const o = asRecord(value);
  if (!o || !Number.isInteger(o.f) || !isFiniteNumber(o.s) || !isFiniteNumber(o.u)) {
    return null;
  }
  return { f: o.f as number, s: o.s, u: o.u };
}

function readColony(value: unknown): ColonyState | null {
  const o = asRecord(value);
  if (
    !o ||
    !isOneOf(o.stage, COLONY_STAGES) ||
    !isFiniteNumber(o.foundedAt) ||
    !isFiniteNumber(o.reserve) ||
    !isFiniteNumber(o.honey) ||
    !isFiniteNumber(o.dormancy) ||
    typeof o.closed !== "boolean" ||
    !Number.isInteger(o.broodChamber) ||
    !Number.isInteger(o.foodChamber) ||
    !isFiniteNumber(o.eggsDue) ||
    !Number.isInteger(o.flownYear)
  ) {
    return null;
  }
  const known = readList(o.known, (v) => (isCount(v) ? v : null));
  if (!known) {
    return null;
  }
  return {
    stage: o.stage,
    foundedAt: o.foundedAt,
    reserve: Math.max(0, o.reserve),
    honey: Math.max(0, o.honey),
    dormancy: Math.min(1, Math.max(0, o.dormancy)),
    closed: o.closed,
    broodChamber: o.broodChamber as number,
    foodChamber: o.foodChamber as number,
    eggsDue: Math.max(0, o.eggsDue),
    known,
    flownYear: o.flownYear as number,
  };
}

function readAnt(value: unknown): AntRecord | null {
  const o = asRecord(value);
  const loc = readLoc(o?.loc);
  if (
    !o ||
    !loc ||
    !isCount(o.id) ||
    !isOneOf(o.caste, CASTES) ||
    !isFiniteNumber(o.size) ||
    o.size < 2 ||
    o.size > 25 ||
    !isFiniteNumber(o.born) ||
    !isFiniteNumber(o.heading) ||
    !isFiniteNumber(o.crop) ||
    typeof o.winged !== "boolean"
  ) {
    return null;
  }
  let cargo: AntRecord["cargo"] = null;
  if (o.cargo !== null) {
    const c = asRecord(o.cargo);
    if (
      !c ||
      !isOneOf(c.kind, CARGO_KINDS) ||
      !Number.isInteger(c.id) ||
      !isFiniteNumber(c.amount)
    ) {
      return null;
    }
    cargo = { kind: c.kind, id: c.id as number, amount: c.amount };
  }
  return {
    id: o.id,
    caste: o.caste,
    size: o.size,
    born: o.born,
    loc,
    heading: o.heading,
    crop: Math.min(1, Math.max(0, o.crop)),
    winged: o.winged,
    cargo,
  };
}

function readBrood(value: unknown): BroodRecord | null {
  const o = asRecord(value);
  const loc = readLoc(o?.loc);
  if (
    !o ||
    !loc ||
    !isCount(o.id) ||
    !isOneOf(o.stage, STAGES) ||
    !isOneOf(o.caste, BROOD_CASTES) ||
    !isFiniteNumber(o.progress) ||
    !isFiniteNumber(o.fed)
  ) {
    return null;
  }
  return {
    id: o.id,
    stage: o.stage,
    caste: o.caste,
    progress: Math.min(1.05, Math.max(0, o.progress)),
    fed: Math.max(0, o.fed),
    loc,
  };
}

function readItem(value: unknown): ItemRecord | null {
  const o = asRecord(value);
  const loc = readLoc(o?.loc);
  if (
    !o ||
    !loc ||
    !isCount(o.id) ||
    !isOneOf(o.kind, ITEM_KINDS) ||
    !isFiniteNumber(o.amount) ||
    !isFiniteNumber(o.size) ||
    o.size <= 0 ||
    !isCount(o.variant) ||
    !isFiniteNumber(o.since) ||
    !isFiniteNumber(o.soggy)
  ) {
    return null;
  }
  return {
    id: o.id,
    kind: o.kind,
    loc,
    amount: Math.max(0, o.amount),
    size: o.size,
    variant: o.variant,
    since: o.since,
    soggy: Math.min(1, Math.max(0, o.soggy)),
  };
}

/**
 * Sorted cell indices as runs: alternately the gap to the next open run and
 * its length, each as a base-36 number, comma separated.
 */
export function encodeRuns(cells: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  let end = 0;
  while (i < cells.length) {
    const start = cells[i];
    let j = i + 1;
    while (j < cells.length && cells[j] === cells[j - 1] + 1) {
      j++;
    }
    parts.push((start - end).toString(36), (j - i).toString(36));
    end = start + (j - i);
    i = j;
  }
  return parts.join(",");
}

/** The cells of `encodeRuns`, or null if the text is not such runs within the grid. */
export function decodeRuns(text: string): number[] | null {
  if (text === "") {
    return [];
  }
  const parts = text.split(",");
  if (parts.length % 2 !== 0) {
    return null;
  }
  const cells: number[] = [];
  let end = 0;
  for (let k = 0; k < parts.length; k += 2) {
    const gap = Number.parseInt(parts[k], 36);
    const length = Number.parseInt(parts[k + 1], 36);
    if (!Number.isSafeInteger(gap) || !Number.isSafeInteger(length) || gap < 0 || length < 1) {
      return null;
    }
    const start = end + gap;
    if (start + length > GRID_SIZE) {
      return null;
    }
    for (let c = start; c < start + length; c++) {
      cells.push(c);
    }
    end = start + length;
  }
  return cells;
}
