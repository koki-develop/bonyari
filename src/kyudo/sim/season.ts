import { cyclicBump } from "../../shared/core/math.ts";
import { computeSeason, type SeasonState } from "../../shared/env/season.ts";

/**
 * The one moment of the year the dojo keeps, day after day: early November,
 * the maples red, the first leaves coming down, the last insects singing at
 * night.
 */
export const TIME_OF_YEAR = 0.675;

/** The autumn as the dojo sees it: the shared seasons plus the leaves on its lawn. */
export interface DojoSeason extends SeasonState {
  /** Leaves drifting down. */
  leafFall: number;
  /** Leaves lying on the lawn. */
  fallenLeaves: number;
}

export function computeDojoSeason(yearFraction: number): DojoSeason {
  const f = yearFraction;
  return {
    ...computeSeason(f),
    leafFall: cyclicBump(f, 0.74, 0.08, 0.04, 1),
    fallenLeaves: cyclicBump(f, 0.76, 0.1, 0.05, 1),
  };
}
