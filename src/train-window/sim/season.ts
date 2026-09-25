import { hex, ramp, type RGB } from "../../shared/core/color.ts";
import { cyclicBump } from "../../shared/core/math.ts";
import { computeSeason, type SeasonState } from "../../shared/env/season.ts";

/** The year as seen along the line: the shared seasons plus the farmland and festivals. */
export interface RouteSeason extends SeasonState {
  /** Canola (nanohana) flowers along fields and embankments. */
  canola: number;
  /** Rice paddy surface color when not flooded. */
  paddy: RGB;
  /** Paddies are flooded and mirror the sky. */
  paddyFlooded: number;
  /** Harvested rice hung on drying racks (hasa-gake). */
  dryingRacks: number;
  /** Pampas grass (susuki) plumes. */
  pampas: number;
  fireworks: number;
}

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

export function computeRouteSeason(yearFraction: number): RouteSeason {
  const f = yearFraction;
  return {
    ...computeSeason(f),
    canola: cyclicBump(f, 0.09, 0.09, 0.04, 1),
    paddy: ramp(PADDY, f),
    paddyFlooded: cyclicBump(f, 0.21, 0.06, 0.03, 1),
    dryingRacks: cyclicBump(f, 0.6, 0.05, 0.02, 1),
    pampas: cyclicBump(f, 0.64, 0.12, 0.04, 1),
    fireworks: cyclicBump(f, 0.41, 0.1, 0.02, 1),
  };
}
