import { approach, bump, clamp01, smoothstep } from "../core/math.ts";
import { hash, Rng } from "../core/random.ts";
import { asRecord, isFiniteNumber, isOneOf, isUint32 } from "../core/validate.ts";
import type { SeasonState } from "./season.ts";

export type WeatherKind = "clear" | "cloudy" | "rain" | "storm" | "snow";

export const WEATHER_KINDS: readonly WeatherKind[] = ["clear", "cloudy", "rain", "storm", "snow"];

export interface LightningStrike {
  /** Flash strength 0..1. */
  intensity: number;
  /** Horizontal direction of the strike relative to the view center, in [-1, 1]. */
  direction: number;
  /** Distance in meters; sets the thunder delay and loudness. */
  distance: number;
  /** Whether a visible bolt is drawn (close strikes). */
  bolt: boolean;
  seed: number;
}

/** Weather as seen by the renderer and the audio engine; every field changes smoothly. */
export interface WeatherState {
  kind: WeatherKind;
  cloudCover: number;
  rain: number;
  snow: number;
  /** Thunderstorm activity. */
  storm: number;
  wind: number;
  /** Morning mist near the ground. */
  mist: number;
  /** Visibility distance in meters. */
  visibility: number;
  /** Snow lying on the ground and roofs. */
  snowCover: number;
  /** Wet ground after rain. */
  wetness: number;
  /** Current lightning flash brightness (decays quickly). */
  flash: number;
}

/** Everything that carries the weather on from one moment to the next. */
export interface WeatherSnapshot {
  /** Position of the weather's random sequence. */
  rng: number;
  remainingDays: number;
  targetCloud: number;
  targetPrecip: number;
  /** The current conditions; a lightning flash is momentary and not kept. */
  state: Omit<WeatherState, "flash">;
}

const TARGET_RATE = 1 / 25;
/** Visibility (m) of clear winter air. */
const CLEAR_VISIBILITY = 32000;

export class Weather {
  private readonly rng: Rng;
  private readonly seed: number;
  private remainingDays = 0;
  private targetCloud = 0;
  private targetPrecip = 0;
  readonly state: WeatherState;
  /** Strikes that happened during the last update. */
  readonly strikes: LightningStrike[] = [];
  /** The most recent strike and a count of all strikes, for renderers that may skip frames. */
  lastStrike: LightningStrike | null = null;
  strikeCount = 0;

  private constructor(seed: number, rng: Rng) {
    this.seed = seed;
    this.rng = rng;
    this.state = {
      kind: "clear",
      cloudCover: 0,
      rain: 0,
      snow: 0,
      storm: 0,
      wind: 0,
      mist: 0,
      visibility: CLEAR_VISIBILITY,
      snowCover: 0,
      wetness: 0,
      flash: 0,
    };
  }

  /** Weather settled into `initial`, or into a kind picked for the season. */
  static create(seed: number, season: SeasonState, initial?: WeatherKind): Weather {
    const weather = new Weather(seed, new Rng(seed ^ 0x77e7));
    weather.setKind(initial ?? weather.chooseKind(season), season);
    weather.snapToTargets(season);
    return weather;
  }

  static restore(seed: number, snapshot: WeatherSnapshot): Weather {
    const weather = new Weather(seed, new Rng(snapshot.rng));
    weather.remainingDays = snapshot.remainingDays;
    weather.targetCloud = snapshot.targetCloud;
    weather.targetPrecip = snapshot.targetPrecip;
    Object.assign(weather.state, snapshot.state);
    return weather;
  }

  snapshot(): WeatherSnapshot {
    const { flash: _flash, ...state } = this.state;
    return {
      rng: this.rng.state,
      remainingDays: this.remainingDays,
      targetCloud: this.targetCloud,
      targetPrecip: this.targetPrecip,
      state,
    };
  }

  /** Forces a weather kind (used on start and by the dev tools). */
  setKind(kind: WeatherKind, season: SeasonState): void {
    this.state.kind = kind;
    this.remainingDays = this.rng.range(0.5, 1.6);
    const r = this.rng;
    switch (kind) {
      case "clear":
        this.targetCloud = r.range(0.0, 0.3) + season.thunderheads * 0.15;
        this.targetPrecip = 0;
        break;
      case "cloudy":
        this.targetCloud = r.range(0.6, 0.85);
        this.targetPrecip = 0;
        break;
      case "rain":
        this.targetCloud = r.range(0.9, 1);
        this.targetPrecip = r.range(0.35, 1);
        break;
      case "storm":
        this.targetCloud = 1;
        this.targetPrecip = 1;
        this.remainingDays = r.range(0.2, 0.5);
        break;
      case "snow":
        this.targetCloud = r.range(0.85, 1);
        this.targetPrecip = r.range(0.35, 1);
        break;
    }
  }

  private chooseKind(season: SeasonState): WeatherKind {
    const w = season.warmth;
    const cold = 1 - smoothstep(0.12, 0.3, w);
    const rainySeason = bump(season.yearFraction, 0.3, 0.06, 0.03);
    return this.rng.weighted<WeatherKind>({
      clear: 4.5,
      cloudy: 2.2,
      rain: (1.6 + 5 * rainySeason) * (1 - cold * 0.85),
      storm: 1.6 * season.thunderheads,
      snow: 3.2 * cold,
    });
  }

  private snapToTargets(season: SeasonState): void {
    const t = this.targets(season, 0, 0);
    Object.assign(this.state, t);
    this.state.snowCover =
      this.state.kind === "snow" ? 0.8 : smoothstep(0.15, 0.03, season.warmth) * 0.5;
    this.state.wetness = this.state.rain > 0 ? 1 : 0;
  }

  private targets(season: SeasonState, days: number, hour: number) {
    const kind = this.state.kind;
    const precip = this.targetPrecip;
    // Morning mist: calm, humid mornings in spring and autumn; some days only.
    const humidity =
      0.35 +
      0.5 *
        (bump(season.yearFraction, 0.12, 0.12, 0.06) + bump(season.yearFraction, 0.6, 0.12, 0.06));
    const mistyDay = hash(Math.floor(days), this.seed, 7) < humidity ? 1 : 0;
    const calm = kind === "clear" || kind === "cloudy" ? 1 : 0.3;
    const mist = bump(hour, 5.8, 2.2, 1.6) * mistyDay * calm;
    const rain = kind === "rain" || kind === "storm" ? precip : 0;
    const snow = kind === "snow" ? precip : 0;
    const storm = kind === "storm" ? 1 : 0;
    const wind =
      kind === "storm" ? 0.9 : kind === "rain" ? 0.35 + precip * 0.2 : kind === "snow" ? 0.25 : 0.1;
    // Winter air is the clearest; summer haze softens the distance.
    const clear = CLEAR_VISIBILITY * (1 - 0.45 * season.warmth);
    const visibility = Math.min(
      clear * (1 - 0.9 * rain) * (1 - 0.3 * storm),
      clear * (1 - 0.96 * snow),
      clear * (1 - 0.97 * mist),
    );
    return { cloudCover: this.targetCloud, rain, snow, storm, wind, mist, visibility };
  }

  update(realDt: number, worldDt: number, days: number, hour: number, season: SeasonState): void {
    this.strikes.length = 0;
    this.remainingDays -= worldDt;
    if (this.remainingDays <= 0) {
      this.setKind(this.chooseKind(season), season);
    }
    const s = this.state;
    const t = this.targets(season, days, hour);
    s.cloudCover = approach(s.cloudCover, t.cloudCover, TARGET_RATE, realDt);
    s.rain = approach(s.rain, t.rain, TARGET_RATE, realDt);
    s.snow = approach(s.snow, t.snow, TARGET_RATE, realDt);
    s.storm = approach(s.storm, t.storm, TARGET_RATE, realDt);
    s.wind = approach(s.wind, t.wind, TARGET_RATE, realDt);
    s.mist = approach(s.mist, t.mist, 1 / 15, realDt);
    s.visibility = approach(s.visibility, t.visibility, TARGET_RATE, realDt);

    // Snow accumulates while it snows and melts faster when warm.
    const melt = (0.25 + 2.5 * smoothstep(0.15, 0.45, season.warmth)) * (1 - s.snow);
    s.snowCover = clamp01(s.snowCover + worldDt * (s.snow * 2.2 - melt * 0.8));
    s.wetness = clamp01(s.wetness + worldDt * (s.rain > 0.05 ? 6 : -1.6));

    s.flash = Math.max(0, s.flash - realDt * 6);
    if (s.storm > 0.3 && this.rng.chance(realDt * 0.12 * s.storm)) {
      const distance = this.rng.range(1200, 9000);
      const strike: LightningStrike = {
        intensity: clamp01(1.3 - distance / 9000) * s.storm,
        direction: this.rng.range(-1, 1),
        distance,
        bolt: distance < 5000,
        seed: this.rng.int(0, 1 << 30),
      };
      s.flash = Math.max(s.flash, strike.intensity);
      this.strikes.push(strike);
      this.lastStrike = strike;
      this.strikeCount++;
    }
  }
}

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

/** The snapshot in `value`, or null unless it is well formed. */
export function readWeatherSnapshot(value: unknown): WeatherSnapshot | null {
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
