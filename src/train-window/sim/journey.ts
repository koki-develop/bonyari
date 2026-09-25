import { type RouteAnchor, SECTION_KINDS } from "./route.ts";
import { TRAIN_PHASES, type TrainState } from "./train.ts";
import { WEATHER_KINDS, type WeatherSnapshot } from "./weather.ts";

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

type Levels = Omit<WeatherSnapshot["state"], "kind">;

const WEATHER_LEVELS = [
  "cloudCover",
  "rain",
  "snow",
  "storm",
  "wind",
  "mist",
  "visibility",
  "snowCover",
  "wetness",
] as const satisfies readonly (keyof Levels)[];

// Fails to compile when a weather level is missing from WEATHER_LEVELS.
const LEVELS_COMPLETE: [Exclude<keyof Levels, (typeof WEATHER_LEVELS)[number]>] extends [never]
  ? true
  : never = true;
void LEVELS_COMPLETE;

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
  const weather = readWeather(o.weather);
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

function readWeather(value: unknown): WeatherSnapshot | null {
  const o = asRecord(value);
  const s = asRecord(o?.state);
  if (
    !o ||
    !s ||
    !isUint32(o.rng) ||
    !isFiniteNumber(o.remainingDays) ||
    !isFiniteNumber(o.targetCloud) ||
    !isFiniteNumber(o.targetPrecip) ||
    !isOneOf(s.kind, WEATHER_KINDS)
  ) {
    return null;
  }
  const levels = {} as Levels;
  for (const key of WEATHER_LEVELS) {
    const level = s[key];
    if (!isFiniteNumber(level)) {
      return null;
    }
    levels[key] = level;
  }
  return {
    rng: o.rng,
    remainingDays: o.remainingDays,
    targetCloud: o.targetCloud,
    targetPrecip: o.targetPrecip,
    state: { kind: s.kind, ...levels },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return (options as readonly unknown[]).includes(value);
}
