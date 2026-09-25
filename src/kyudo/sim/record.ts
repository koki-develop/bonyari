import {
  asRecord,
  isCount,
  isFiniteNumber,
  isOneOf,
  isUint32,
} from "../../shared/core/validate.ts";
import { type EnvironmentSnapshot, readEnvironmentSnapshot } from "../../shared/env/environment.ts";
import type { Hole, Rest, RestingArrow } from "./arrows.ts";
import { AIM_LIMITS, TARGET_COUNT } from "./dojo.ts";
import { MATERIALS } from "./geometry.ts";

/** An arrow as kept in the record. */
export type ArrowRecord = Omit<RestingArrow, "id" | "landedAt">;

/** The dojo as left, enough to come back to it: see `World.snapshot` and `World.restore`. */
export interface DojoRecord {
  seed: number;
  env: EnvironmentSnapshot;
  arrows: ArrowRecord[];
  holes: Hole[];
  aim: { x: number; y: number };
}

/** Version of the encoded form; records of any other version are not read. */
const FORMAT = 1;
const RESTS: readonly Rest[] = ["stuck", "lying"];

export function encodeRecord(record: DojoRecord): string {
  return JSON.stringify({ format: FORMAT, record });
}

/** The record in `text`, or null unless it is a well-formed record of the current format. */
export function decodeRecord(text: string): DojoRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const o = asRecord(data);
  return o?.format === FORMAT ? readRecord(o.record) : null;
}

function readRecord(value: unknown): DojoRecord | null {
  const o = asRecord(value);
  if (!o || !isUint32(o.seed) || !Array.isArray(o.arrows) || !Array.isArray(o.holes)) {
    return null;
  }
  const env = readEnvironmentSnapshot(o.env);
  const aim = asRecord(o.aim);
  if (!env || !aim || !isFiniteNumber(aim.x) || !isFiniteNumber(aim.y)) {
    return null;
  }
  const arrows: ArrowRecord[] = [];
  for (const a of o.arrows) {
    const arrow = readArrow(a);
    if (!arrow) {
      return null;
    }
    arrows.push(arrow);
  }
  const holes: Hole[] = [];
  for (const h of o.holes) {
    const hole = readHole(h);
    if (!hole) {
      return null;
    }
    holes.push(hole);
  }
  return {
    seed: o.seed,
    env,
    arrows,
    holes,
    aim: {
      x: Math.min(AIM_LIMITS.x1, Math.max(AIM_LIMITS.x0, aim.x)),
      y: Math.min(AIM_LIMITS.y1, Math.max(AIM_LIMITS.y0, aim.y)),
    },
  };
}

function readArrow(value: unknown): ArrowRecord | null {
  const o = asRecord(value);
  if (!o) {
    return null;
  }
  const { rest, material, pair, target, x, y, z, dx, dy, dz } = o;
  if (
    !isOneOf(rest, RESTS) ||
    !isOneOf(material, MATERIALS) ||
    !(pair === 0 || pair === 1) ||
    !isFiniteNumber(target) ||
    !Number.isInteger(target) ||
    target < -1 ||
    target >= TARGET_COUNT ||
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(z) ||
    !isFiniteNumber(dx) ||
    !isFiniteNumber(dy) ||
    !isFiniteNumber(dz)
  ) {
    return null;
  }
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.5 || len > 1.5) {
    return null;
  }
  return { rest, x, y, z, dx: dx / len, dy: dy / len, dz: dz / len, material, target, pair };
}

function readHole(value: unknown): Hole | null {
  const o = asRecord(value);
  if (
    !o ||
    !isCount(o.target) ||
    o.target >= TARGET_COUNT ||
    !isFiniteNumber(o.u) ||
    !isFiniteNumber(o.v)
  ) {
    return null;
  }
  return { target: o.target, u: o.u, v: o.v };
}
