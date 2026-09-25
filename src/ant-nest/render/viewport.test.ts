import { describe, expect, it } from "vitest";
import { Rng } from "../../shared/core/random.ts";
import { computeLayout, type Layout } from "./layout.ts";
import { layoutOf, SCREENS } from "./screens.ts";
import { Viewport } from "./viewport.ts";

function open(layout: Layout): Viewport {
  const v = new Viewport();
  v.setLayout(layout);
  return v;
}

/** The canvas's size in CSS pixels. */
function css(l: Layout): { w: number; h: number } {
  return { w: l.deviceWidth / l.dpr, h: l.deviceHeight / l.dpr };
}

/** Checks the view lies in the extent and its art pixels cover the canvas. */
function expectSound(v: Viewport, l: Layout): void {
  const { w, h } = css(l);
  const corner = v.toWorld(0, 0);
  const far = v.toWorld(w, h);
  const e = l.extent;
  const slack = 1 / v.scale;
  expect(corner.x).toBeGreaterThanOrEqual(e.left - slack);
  expect(far.x).toBeLessThanOrEqual(e.right + slack);
  expect(corner.y).toBeLessThanOrEqual(e.top + slack);
  expect(far.y).toBeGreaterThanOrEqual(e.bottom - slack);
  expect(Number.isInteger(v.scale)).toBe(true);
  expect(v.scale).toBeGreaterThanOrEqual(l.minScale);
  expect(v.scale).toBeLessThanOrEqual(l.maxScale);
  const p = v.placement();
  expect(p.offsetX).toBeGreaterThanOrEqual(0);
  expect(p.offsetY).toBeGreaterThanOrEqual(0);
  expect(p.width * p.scale - p.offsetX).toBeGreaterThanOrEqual(l.deviceWidth);
  expect(p.height * p.scale - p.offsetY).toBeGreaterThanOrEqual(l.deviceHeight);
  // The art pixel drawn under a device pixel is the section position there.
  for (const [dx, dy] of [
    [0, 0],
    [l.deviceWidth - 1, l.deviceHeight - 1],
    [Math.floor(l.deviceWidth / 3), Math.floor(l.deviceHeight / 2)],
  ]) {
    const at = v.toWorld((dx + 0.5) / l.dpr, (dy + 0.5) / l.dpr);
    const col = Math.floor((dx + p.offsetX) / p.scale);
    const row = Math.floor((dy + p.offsetY) / p.scale);
    expect(Math.floor(at.x) + 0).toBe(col - p.cx + 0);
    expect(Math.ceil(at.y) + 0).toBe(p.ground - row + 0);
  }
}

describe("viewport", () => {
  it("opens on the layout's home view", () => {
    for (const screen of SCREENS) {
      const l = layoutOf(screen);
      const v = open(l);
      expect(v.scale).toBe(l.homeScale);
      expect(v.zoom).toBe(1);
      const corner = v.toWorld(0, 0);
      expect(corner.x).toBeCloseTo(l.home.left, 0);
      expect(corner.y).toBeCloseTo(l.home.top, 0);
      expectSound(v, l);
    }
  });

  it("keeps what is under the fingers there as it zooms", () => {
    const l = computeLayout(1170, 2532, 390);
    const v = open(l);
    const at = v.toWorld(200, 500);
    v.zoomTo(l.homeScale * 2, 200, 500);
    expect(v.scale).toBe(l.homeScale * 2);
    const now = v.toWorld(200, 500);
    expect(Math.abs(now.x - at.x)).toBeLessThan(1 / v.scale);
    expect(Math.abs(now.y - at.y)).toBeLessThan(1 / v.scale);
    expectSound(v, l);
  });

  it("adds up small zooms and steps a whole scale at least", () => {
    const l = computeLayout(1920, 1080, 1920);
    const v = open(l);
    const start = v.scale;
    for (let i = 0; i < 6; i++) {
      v.zoomBy(1.05, 960, 540);
    }
    expect(v.scale).toBeGreaterThan(start);
    const s = v.scale;
    v.step(1, 960, 540);
    expect(v.scale).toBeGreaterThanOrEqual(s + 1);
    v.step(-1, 960, 540);
    expect(v.scale).toBeLessThan(s + 1);
  });

  it("stays in the extent however it is zoomed and dragged", () => {
    const r = new Rng(42);
    for (const screen of SCREENS) {
      const l = layoutOf(screen);
      const v = open(l);
      const { w, h } = css(l);
      for (let i = 0; i < 300; i++) {
        if (r.chance(0.4)) {
          v.zoomBy(Math.exp(r.range(-0.8, 0.8)), r.range(0, w), r.range(0, h));
        } else {
          v.panBy(r.range(-w, w), r.range(-h, h));
        }
        expectSound(v, l);
      }
    }
  });

  it("keeps a zoomed view's middle and size through a resize, and an untouched one at home", () => {
    const portrait = computeLayout(1170, 2532, 390);
    const landscape = computeLayout(2532, 1170, 844);
    const untouched = open(portrait);
    untouched.setLayout(landscape);
    expect(untouched.scale).toBe(landscape.homeScale);
    expect(untouched.toWorld(0, 0).x).toBeCloseTo(landscape.home.left, 0);

    const zoomed = open(portrait);
    zoomed.zoomTo(15, 195, 500);
    const middle = zoomed.middle;
    zoomed.setLayout(landscape);
    expect(zoomed.scale).toBe(15);
    expect(Math.abs(zoomed.middle.x - middle.x)).toBeLessThan(0.5);
    expect(Math.abs(zoomed.middle.y - middle.y)).toBeLessThan(0.5);
    expectSound(zoomed, landscape);
  });
});
