import { cyclicBump, smoothstep } from "../../shared/core/math.ts";
import { computeSeason, type SeasonState } from "../../shared/env/season.ts";

/** The year as the town lives it: the shared seasons, and the farming year. */
export interface TownSeason extends SeasonState {
  /** How green gardens and young crops are: 0 in winter, 1 through early summer. */
  growth: number;
  /** How ripe the grain stands: 0 green, 1 golden. */
  ripeness: number;
  /** Autumn colors, 0..1. */
  autumn: number;
  /** Fallen leaves on the woodland floor. */
  fallen: number;
  /** Fireflies over the meadows on early summer nights. */
  fireflies: number;
  /** Whether it is the time to plow and sow, to reap, or to rest the fields. */
  farming: "sow" | "tend" | "reap" | "rest";
}

/** Where in the year (fractions, 0 = Mar 1) the farming work begins. */
export const FARMING = { sow: 0.02, tend: 0.3, reap: 0.47, rest: 0.7 } as const;

export function computeTownSeason(yearFraction: number): TownSeason {
  const f = yearFraction;
  const farming =
    f >= FARMING.rest || f < FARMING.sow
      ? "rest"
      : f < FARMING.tend
        ? "sow"
        : f < FARMING.reap
          ? "tend"
          : "reap";
  return {
    ...computeSeason(f),
    growth: smoothstep(0.04, 0.18, f) * (1 - smoothstep(0.62, 0.78, f)),
    ripeness: smoothstep(0.3, 0.46, f) * (1 - smoothstep(0.62, 0.7, f)),
    autumn: cyclicBump(f, 0.66, 0.12, 0.05, 1),
    fallen: cyclicBump(f, 0.78, 0.2, 0.06, 1),
    fireflies: cyclicBump(f, 0.29, 0.06, 0.03, 1),
    farming,
  };
}
