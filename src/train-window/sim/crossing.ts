import { smoothstep } from "../../shared/core/math.ts";
import type { Crossing } from "./route.ts";

/** Along-track distance before and after a crossing during which it is active. */
export const CROSSING_WARN_BEFORE = 420;
export const CROSSING_WARN_AFTER = 110;

/** 0 = idle, 1 = gates fully down; derived from our position so it tracks the train. */
export function crossingClosure(crossing: Crossing, pos: number): number {
  const lower = smoothstep(
    crossing.at - CROSSING_WARN_BEFORE,
    crossing.at - CROSSING_WARN_BEFORE + 110,
    pos,
  );
  const raise =
    1 - smoothstep(crossing.at + CROSSING_WARN_AFTER, crossing.at + CROSSING_WARN_AFTER + 60, pos);
  return Math.min(lower, raise);
}

/** Whether the warning lights flash and the bells ring. */
export function crossingActive(crossing: Crossing, pos: number): boolean {
  return pos > crossing.at - CROSSING_WARN_BEFORE && pos < crossing.at + CROSSING_WARN_AFTER + 20;
}
