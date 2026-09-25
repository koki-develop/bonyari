import { cyclicBump } from "../../shared/core/math.ts";
import { computeSeason, type SeasonState } from "../../shared/env/season.ts";

/** The year as seen at the foot of the grass: the shared seasons plus what lies on the ground. */
export interface NestSeason extends SeasonState {
  /** Fireflies over the grass on early summer nights. */
  fireflies: number;
  /** Fallen leaves blown onto the ground in late autumn. */
  fallenLeaves: number;
  /** How withered the grass is: straw colored and lying down. */
  withered: number;
}

export function computeNestSeason(yearFraction: number): NestSeason {
  const f = yearFraction;
  return {
    ...computeSeason(f),
    fireflies: cyclicBump(f, 0.29, 0.06, 0.03, 1),
    fallenLeaves: cyclicBump(f, 0.77, 0.14, 0.05, 1),
    // From the end of autumn until the new green comes through in spring.
    withered: cyclicBump(f, 0.9, 0.34, 0.08, 1),
  };
}
