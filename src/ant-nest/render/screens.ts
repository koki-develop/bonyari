import { computeLayout, type Layout } from "./layout.ts";

/** Screens the layout tests size the view for, as (CSS width, CSS height, device pixel ratio). */
export const SCREENS: readonly [number, number, number][] = [
  [390, 844, 3],
  [320, 568, 2],
  [412, 915, 2.625],
  [1024, 1366, 2],
  [844, 390, 3],
  [1440, 900, 2],
  [1920, 1080, 1],
  [3440, 1440, 1],
];

/** The layout of one of `SCREENS`. */
export function layoutOf([w, h, dpr]: readonly [number, number, number]): Layout {
  return computeLayout(Math.round(w * dpr), Math.round(h * dpr), w);
}
