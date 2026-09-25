import {
  asRecord,
  isCount,
  isFiniteNumber,
  isOneOf,
  isUint32,
} from "../../shared/core/validate.ts";
import { readWeatherSnapshot, type WeatherSnapshot } from "../../shared/env/weather.ts";
import { type RouteAnchor, SECTION_KINDS } from "./route.ts";
import { TRAIN_PHASES, type TrainState } from "./train.ts";

/** A moment of a ride, enough to resume it there: see `World.snapshot` and `World.resume`. */
export interface Journey {
  seed: number;
  /** Clock reading in days (`Clock.days`). */
  days: number;
  route: RouteAnchor;
  train: TrainState;
  weather: WeatherSnapshot;
}

/** Version of the encoded form; records of any other version are not read. */
const FORMAT = 1;

export function encodeJourney(journey: Journey): string {
  return JSON.stringify({ format: FORMAT, journey });
}

/** The journey in `text`, or null unless it is a well-formed record of the current format. */
export function decodeJourney(text: string): Journey | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(data);
  return record?.format === FORMAT ? readJourney(record.journey) : null;
}

function readJourney(value: unknown): Journey | null {
  const o = asRecord(value);
  if (!o) {
    return null;
  }
  const route = readRoute(o.route);
  const train = readTrain(o.train);
  const weather = readWeatherSnapshot(o.weather);
  if (!isUint32(o.seed) || !isFiniteNumber(o.days) || !route || !train || !weather) {
    return null;
  }
  return { seed: o.seed, days: o.days, route, train, weather };
}

function readRoute(value: unknown): RouteAnchor | null {
  const o = asRecord(value);
  if (
    !o ||
    !isCount(o.index) ||
    !isOneOf(o.kind, SECTION_KINDS) ||
    !isFiniteNumber(o.start) ||
    !(o.forced === null || isOneOf(o.forced, SECTION_KINDS))
  ) {
    return null;
  }
  return { index: o.index, kind: o.kind, start: o.start, forced: o.forced };
}

function readTrain(value: unknown): TrainState | null {
  const o = asRecord(value);
  if (
    !o ||
    !isFiniteNumber(o.pos) ||
    !isFiniteNumber(o.speed) ||
    o.speed < 0 ||
    !isFiniteNumber(o.cruise) ||
    !isFiniteNumber(o.traction) ||
    !isOneOf(o.phase, TRAIN_PHASES) ||
    !isFiniteNumber(o.dwell) ||
    !isCount(o.stationsVisited)
  ) {
    return null;
  }
  return {
    pos: o.pos,
    speed: o.speed,
    cruise: o.cruise,
    traction: o.traction,
    phase: o.phase,
    dwell: o.dwell,
    stationsVisited: o.stationsVisited,
  };
}
