import { describe, expect, it } from "vitest";
import { FRAME } from "../sim/geometry.ts";
import { computeLayout } from "./layout.ts";
import { layoutOf, SCREENS } from "./screens.ts";

describe("layout", () => {
  it("opens with an art pixel between 1.5 and 2.5 CSS pixels", () => {
    for (const screen of SCREENS) {
      const l = layoutOf(screen);
      const css = l.homeScale / l.dpr;
      expect(css).toBeGreaterThanOrEqual(1.5 - 1e-9);
      // A screen of one device pixel per CSS pixel can only go up in whole steps.
      expect(css).toBeLessThanOrEqual(Math.max(2.5, Math.ceil(1.5 * l.dpr) / l.dpr) + 1e-9);
    }
  });

  it("opens on the whole width of the nest", () => {
    for (const screen of SCREENS) {
      const l = layoutOf(screen);
      expect(l.home.left).toBeLessThanOrEqual(FRAME.x0);
      expect(l.home.left + l.deviceWidth / l.homeScale).toBeGreaterThanOrEqual(FRAME.x1);
    }
  });

  it("opens on the whole frame on a phone held upright", () => {
    const l = computeLayout(1170, 2532, 390);
    expect(l.home.top).toBeGreaterThanOrEqual(FRAME.top);
    expect(l.home.top - l.deviceHeight / l.homeScale).toBeLessThanOrEqual(FRAME.bottom);
  });

  it("zooms out until the whole frame fits, and in to 6 CSS pixels an art pixel", () => {
    for (const screen of SCREENS) {
      const l = layoutOf(screen);
      expect(l.minScale).toBeLessThanOrEqual(l.homeScale);
      expect(l.maxScale).toBeGreaterThan(l.homeScale);
      expect(l.deviceWidth / l.minScale).toBeGreaterThanOrEqual(FRAME.x1 - FRAME.x0);
      expect(l.deviceHeight / l.minScale).toBeGreaterThanOrEqual(FRAME.top - FRAME.bottom);
      expect(l.maxScale / l.dpr).toBeLessThanOrEqual(6);
      expect(l.maxScale / l.dpr).toBeGreaterThan(5);
    }
  });

  it("holds the frame and the opening view in the extent", () => {
    for (const screen of SCREENS) {
      const l = layoutOf(screen);
      const e = l.extent;
      expect(e.left).toBeLessThanOrEqual(FRAME.x0);
      expect(e.right).toBeGreaterThanOrEqual(FRAME.x1);
      expect(e.top).toBeGreaterThanOrEqual(FRAME.top);
      expect(e.bottom).toBeLessThanOrEqual(FRAME.bottom);
      expect(l.home.left).toBeGreaterThanOrEqual(e.left - 1e-9);
      expect(l.home.left + l.deviceWidth / l.homeScale).toBeLessThanOrEqual(e.right + 1e-9);
      expect(l.home.top).toBeLessThanOrEqual(e.top + 1e-9);
      expect(l.home.top - l.deviceHeight / l.homeScale).toBeGreaterThanOrEqual(e.bottom - 1e-9);
    }
  });
});
