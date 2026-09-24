import { hex, ramp, rampScalar, type RGB } from "../core/color.ts";
import { cyclicBump, TAU } from "../core/math.ts";

/**
 * Continuous seasonal state derived from the position in the year
 * (0 = Mar 1, 0.25 = Jun 1, 0.5 = Sep 1, 0.75 = Dec 1).
 */
export interface SeasonState {
  yearFraction: number;
  /** 0 = coldest, 1 = hottest. */
  warmth: number;
  /** Cherry blossom bloom. */
  blossom: number;
  /** Canola (nanohana) flowers along fields and embankments. */
  canola: number;
  /** Foliage color of deciduous trees. */
  leaf: RGB;
  /** How much of a deciduous crown is covered with leaves (bare branches otherwise). */
  leafDensity: number;
  /** Color of evergreen needles (cedar, pine). */
  evergreen: RGB;
  grass: RGB;
  /** Rice paddy surface color when not flooded. */
  paddy: RGB;
  /** Paddies are flooded and mirror the sky. */
  paddyFlooded: number;
  /** Harvested rice hung on drying racks (hasa-gake). */
  dryingRacks: number;
  /** Pampas grass (susuki) plumes. */
  pampas: number;
  /** Dandelions and clover flowering in the grass by the line. */
  wildflowers: number;
  /** Red spider lilies (higanbana) along the embankments around the equinox. */
  higanbana: number;
  cicadas: number;
  frogs: number;
  crickets: number;
  fireworks: number;
  /** Towering summer clouds. */
  thunderheads: number;
}

const LEAF: readonly (readonly [number, RGB])[] = [
  [0.0, hex("#7a6a52")],
  [0.07, hex("#8c8a5a")],
  [0.12, hex("#9cc262")],
  [0.2, hex("#6da84a")],
  [0.32, hex("#3f7f38")],
  [0.52, hex("#3e7434")],
  [0.58, hex("#8c8f30")],
  [0.63, hex("#d49a2a")],
  [0.68, hex("#c8502a")],
  [0.74, hex("#8a5a38")],
  [0.8, hex("#7a6a52")],
  [1.0, hex("#7a6a52")],
];

const EVERGREEN: readonly (readonly [number, RGB])[] = [
  [0.0, hex("#3e5a3c")],
  [0.2, hex("#3f6a3e")],
  [0.4, hex("#2f5a32")],
  [0.75, hex("#34543a")],
  [1.0, hex("#3e5a3c")],
];

const GRASS: readonly (readonly [number, RGB])[] = [
  [0.0, hex("#8c8458")],
  [0.08, hex("#8fa056")],
  [0.15, hex("#79b050")],
  [0.3, hex("#5a9a42")],
  [0.5, hex("#6a9a40")],
  [0.6, hex("#a8a052")],
  [0.7, hex("#b09a60")],
  [0.8, hex("#948760")],
  [1.0, hex("#8c8458")],
];

const PADDY: readonly (readonly [number, RGB])[] = [
  [0.0, hex("#7a6a50")],
  [0.14, hex("#806c52")],
  [0.2, hex("#6d6a4c")],
  [0.26, hex("#86b24e")],
  [0.36, hex("#4f9a3a")],
  [0.46, hex("#8aa83c")],
  [0.52, hex("#d0b048")],
  [0.57, hex("#c9a449")],
  [0.6, hex("#a08c5a")],
  [0.7, hex("#94805c")],
  [1.0, hex("#7a6a50")],
];

const LEAF_DENSITY: readonly (readonly [number, number])[] = [
  [0.0, 0.1],
  [0.07, 0.25],
  [0.14, 0.85],
  [0.2, 1],
  [0.64, 1],
  [0.72, 0.55],
  [0.78, 0.12],
  [1.0, 0.1],
];

export function computeSeason(yearFraction: number): SeasonState {
  const f = yearFraction;
  return {
    yearFraction: f,
    warmth: 0.5 - 0.5 * Math.cos(TAU * (f - 0.9)),
    blossom: cyclicBump(f, 0.1, 0.05, 0.035, 1),
    canola: cyclicBump(f, 0.09, 0.09, 0.04, 1),
    leaf: ramp(LEAF, f),
    leafDensity: rampScalar(LEAF_DENSITY, f),
    evergreen: ramp(EVERGREEN, f),
    grass: ramp(GRASS, f),
    paddy: ramp(PADDY, f),
    paddyFlooded: cyclicBump(f, 0.21, 0.06, 0.03, 1),
    dryingRacks: cyclicBump(f, 0.6, 0.05, 0.02, 1),
    pampas: cyclicBump(f, 0.64, 0.12, 0.04, 1),
    wildflowers: cyclicBump(f, 0.14, 0.1, 0.04, 1),
    higanbana: cyclicBump(f, 0.555, 0.022, 0.012, 1),
    cicadas: cyclicBump(f, 0.4, 0.13, 0.04, 1),
    frogs: cyclicBump(f, 0.26, 0.16, 0.04, 1),
    crickets: cyclicBump(f, 0.56, 0.18, 0.05, 1),
    fireworks: cyclicBump(f, 0.41, 0.1, 0.02, 1),
    thunderheads: cyclicBump(f, 0.4, 0.14, 0.05, 1),
  };
}
