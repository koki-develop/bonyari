import { describe, expect, it } from "vitest";
import { FRAME } from "../sim/geometry.ts";
import { computeLayout } from "./layout.ts";

/** Screens as (CSS width, CSS height, device pixel ratio). */
const SCREENS: readonly [number, number, number][] = [
  [390, 844, 3],
  [320, 568, 2],
  [412, 915, 2.625],
  [1024, 1366, 2],
  [844, 390, 3],
  [1440, 900, 2],
  [1920, 1080, 1],
  [3440, 1440, 1],
];

describe("layout", () => {
  it("keeps an art pixel between 1.5 and 2.5 CSS pixels", () => {
    for (const [w, h, dpr] of SCREENS) {
      const l = computeLayout(Math.round(w * dpr), Math.round(h * dpr), w);
      const css = l.scale / dpr;
      expect(css).toBeGreaterThanOrEqual(1.5 - 1e-9);
      // A screen of one device pixel per CSS pixel can only go up in whole steps.
      expect(css).toBeLessThanOrEqual(Math.max(2.5, Math.ceil(1.5 * dpr) / dpr) + 1e-9);
    }
  });

  it("shows the whole width of the nest", () => {
    for (const [w, h, dpr] of SCREENS) {
      const l = computeLayout(Math.round(w * dpr), Math.round(h * dpr), w);
      expect(l.cx + FRAME.x0).toBeGreaterThanOrEqual(0);
      expect(l.cx + FRAME.x1).toBeLessThanOrEqual(l.width);
    }
  });

  it("shows the whole frame at once on a phone held upright", () => {
    const l = computeLayout(1170, 2532, 390);
    expect(l.panUp).toBe(0);
    expect(l.panDown).toBe(0);
    expect(l.ground - FRAME.top).toBeGreaterThanOrEqual(0);
    expect(l.ground - FRAME.bottom).toBeLessThan(l.height);
  });

  it("can be dragged to either end of the frame on a short screen", () => {
    for (const [w, h, dpr] of SCREENS) {
      const l = computeLayout(Math.round(w * dpr), Math.round(h * dpr), w);
      if (l.panUp === 0 && l.panDown === 0) {
        continue;
      }
      // Dragged fully down, the top of the frame is on screen; fully up, its bottom.
      expect(l.ground + l.panUp - FRAME.top).toBeGreaterThanOrEqual(0);
      expect(l.ground - l.panDown - FRAME.bottom).toBeLessThanOrEqual(l.height - 1);
    }
  });
});
