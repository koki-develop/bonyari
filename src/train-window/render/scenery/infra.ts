import type { RGB } from "../../../shared/core/color.ts";
import { Rng } from "../../../shared/core/random.ts";
import type { Painter } from "../../../shared/render/painter.ts";
import type { Camera } from "../camera.ts";
import type { Scenery } from "./placement.ts";

const CONCRETE_POLE: RGB = [150, 148, 142];
const WIRE: RGB = [40, 40, 44];
const STEEL: RGB = [158, 164, 170];
const LAMP_LIGHT: RGB = [255, 226, 176];

/** A sagging wire between two screen points; `sag` in pixels at the middle. */
function wire(
  p: Painter<Camera>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sag: number,
  alpha: number,
): void {
  const sh = p.shade;
  const r = sh.litR(WIRE[0]);
  const g = sh.litG(WIRE[1]);
  const b = sh.litB(WIRE[2]);
  const a = Math.min(x0, x1);
  const bnd = Math.max(x0, x1);
  const from = Math.max(Math.floor(a), -1);
  const to = Math.min(Math.ceil(bnd), p.view.width + 1);
  for (let x = from; x <= to; x++) {
    const t = (x + 0.5 - x0) / (x1 - x0);
    if (t < 0 || t > 1) {
      continue;
    }
    const y = y0 + (y1 - y0) * t + sag * 4 * t * (1 - t);
    p.view.blend(x, Math.floor(y), r, g, b, alpha);
  }
}

export function drawRoadPole(p: Painter<Camera>, o: Scenery): void {
  p.at(o.lateral);
  const s = p.s;
  const cx = p.x(o.along);
  const base = p.y(0);
  const top = p.y(10);
  const w = Math.max(1, Math.round(0.3 * s));
  p.rect(cx - w / 2, top, cx + w / 2, base, CONCRETE_POLE);
  const arm = p.y(9.3);
  p.rect(cx - 0.8 * s, arm, cx + 0.8 * s, arm + Math.max(1, 0.12 * s), [90, 90, 92]);
  // Transformer on some poles.
  if (o.seed % 5 === 0 && s > 1) {
    const ty = p.y(7.6);
    p.rect(cx + w / 2, ty, cx + w / 2 + 0.5 * s, ty + 0.9 * s, [120, 124, 126]);
  }
  if (o.next) {
    const nx = p.cam.x(o.next.along, o.next.lateral);
    // Distant wires thin out to almost nothing against the sky.
    const alpha = Math.max(0.08, Math.min(0.85, s * 0.45));
    for (const h of [9.35, 9.1, 7.2]) {
      wire(p, cx, p.y(h), nx, p.cam.y(o.next.lateral, h), 0.5 * s, alpha);
    }
  }
}

export function drawStreetLamp(p: Painter<Camera>, o: Scenery): void {
  p.at(o.lateral);
  const s = p.s;
  const cx = p.x(o.along);
  const base = p.y(0);
  const top = p.y(6.5);
  p.rect(cx, top, cx + Math.max(1, 0.18 * s), base, STEEL);
  // The arm reaches over the road, away from us.
  const headX = cx - 0.9 * s;
  p.rect(headX, top, cx + 1, top + Math.max(1, 0.15 * s), STEEL);
  const lamps = p.light.lamps;
  if (lamps > 0.05) {
    p.lightRect(headX, top + 1, headX + Math.max(1, 0.6 * s), top + 2, LAMP_LIGHT, lamps);
    p.glow(headX + 0.5, top + 1.5, Math.max(3, 2.5 * s), LAMP_LIGHT, 0.45 * lamps);
    // A pool of light on the road.
    p.glow(headX, base - 0.2 * s, Math.max(3, 3.5 * s), [150, 130, 100], 0.35 * lamps);
  } else {
    p.rect(headX, top + 1, headX + Math.max(1, 0.6 * s), top + 2, [220, 220, 210]);
  }
}

export function drawPylon(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const h = r.range(46, 60);
  const cx = p.x(o.along);
  const base = p.y(0);
  const top = p.y(h);
  const color: RGB = r.chance(0.3) ? [178, 120, 110] : [150, 156, 160];
  const rows = Math.max(1, base - top);
  // Tapered lattice: two legs with X bracing.
  let prevL = 0;
  let prevR = 0;
  for (let y = Math.floor(top); y < base; y++) {
    const t = (y - top) / rows;
    const half = (1 + 3.5 * t * t) * s;
    const l = cx - half;
    const rr = cx + half;
    p.dot(l, y, color);
    p.dot(rr, y, color);
    const bay = ((y - top) / Math.max(2, 6 * s)) % 1;
    if (half > 1.5) {
      p.dot(l + (rr - l) * bay, y, color);
      p.dot(rr - (rr - l) * bay, y, color);
    }
    prevL = l;
    prevR = rr;
  }
  p.rect(prevL, base - 1, prevR + 1, base, color);
  const alpha = Math.max(0.06, Math.min(0.6, s * 0.4));
  for (const k of [0.97, 0.82, 0.67]) {
    const y = top + (1 - k) * rows;
    p.rect(cx - 2.2 * s, y, cx + 2.2 * s + 1, y + 1, color);
    if (o.next) {
      wire(p, cx, y + 1, p.x(o.next.along), y + 1, 4 * s, alpha);
    }
  }
}
