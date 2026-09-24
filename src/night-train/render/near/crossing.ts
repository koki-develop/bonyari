import { hex, type RGB } from "../../core/color.ts";
import { Rng } from "../../core/random.ts";
import { crossingActive, crossingClosure } from "../../sim/crossing.ts";
import type { Crossing } from "../../sim/route.ts";
import type { Painter } from "../painter.ts";

const YELLOW: RGB = [236, 196, 40];
const BLACK: RGB = [34, 32, 32];
const LAMP_RED: RGB = [255, 50, 36];
const HEADLIGHT: RGB = [255, 250, 230];
const CAR_COLORS: readonly RGB[] = ["#e8e8e6", "#2a2c32", "#9a2c2a", "#3a5a8a", "#b8bcc0"].map(hex);

/** Striped segment between two screen points. */
function stripedLine(
  p: Painter,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  stripe: number,
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len * 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const c = Math.floor((t * len) / stripe) % 2 === 0 ? YELLOW : BLACK;
    p.rect(x, y, x + thickness, y + thickness, c);
  }
}

function warningPost(p: Painter, along: number, active: boolean, time: number): void {
  const s = p.s;
  const cx = p.x(along);
  const base = p.cam.yRail(p.lateral, -0.3);
  const top = p.cam.yRail(p.lateral, 4.3);
  const w = Math.max(1, Math.round(0.14 * s));
  p.rect(cx - w / 2, top, cx + w / 2, base, [150, 150, 146]);
  // Crossbuck.
  const cy = p.cam.yRail(p.lateral, 3.85);
  const arm = 0.55 * s;
  const t = Math.max(1, Math.round(0.14 * s));
  stripedLine(p, cx - arm, cy - arm * 0.45, cx + arm, cy + arm * 0.45, t, 0.25 * s);
  stripedLine(p, cx - arm, cy + arm * 0.45, cx + arm, cy - arm * 0.45, t, 0.25 * s);
  // Twin red lamps, flashing alternately.
  const ly = p.cam.yRail(p.lateral, 2.85);
  const lr = Math.max(1, 0.16 * s);
  const phase = Math.floor(time * 1.8) % 2;
  for (const side of [-1, 1] as const) {
    const lx = cx + side * 0.36 * s;
    p.rect(lx - lr - 1, ly - lr - 1, lx + lr + 1, ly + lr + 1, BLACK);
    const on = active && (side === -1 ? phase === 0 : phase === 1);
    if (on) {
      p.lightRect(lx - lr, ly - lr, lx + lr, ly + lr, LAMP_RED, 1);
      p.glow(lx, ly, Math.max(4, 1.3 * s), LAMP_RED, 0.55);
    } else {
      p.rect(lx - lr, ly - lr, lx + lr, ly + lr, [90, 30, 26]);
    }
  }
}

export function drawCrossing(
  p: Painter,
  crossing: Crossing,
  lateral: number,
  pos: number,
  time: number,
): void {
  p.at(lateral);
  const closure = crossingClosure(crossing, pos);
  const active = crossingActive(crossing, pos);
  warningPost(p, crossing.at - 3.8, active, time);
  warningPost(p, crossing.at + 3.8, active, time + 0.28);
  // Gate machine and its striped arm.
  const s = p.s;
  const mx = p.x(crossing.at - 3.4);
  const mTop = p.cam.yRail(lateral, 1.2);
  const mBase = p.cam.yRail(lateral, -0.3);
  p.rect(mx - 0.25 * s, mTop, mx + 0.25 * s, mBase, YELLOW);
  p.rect(mx - 0.25 * s, mTop, mx + 0.25 * s, mTop + Math.max(1, 0.2 * s), BLACK);
  const angle = (1 - closure) * (Math.PI / 2 - 0.08) + 0.02;
  const len = 6.4;
  const pivotY = p.cam.yRail(lateral, 1.0);
  const ex = mx + Math.cos(angle) * len * s;
  const ey = pivotY - Math.sin(angle) * len * s;
  stripedLine(p, mx, pivotY, ex, ey, Math.max(1, Math.round(0.12 * s)), 0.5 * s);
}

/** A car waiting at the barrier, facing the track; its headlights shine at us at night. */
export function drawWaitingCar(p: Painter, crossing: Crossing, lateral: number, pos: number): void {
  const closure = crossingClosure(crossing, pos);
  if (closure < 0.3) {
    return;
  }
  const r = new Rng(crossing.seed);
  p.at(lateral);
  const s = p.s;
  const cx = p.x(crossing.at - 1.5);
  const base = p.y(0);
  const w = 1.7 * s;
  const body = r.pick(CAR_COLORS);
  const roof = p.y(1.45);
  const hood = p.y(0.95);
  p.rect(cx - w / 2, hood, cx + w / 2, base - 0.15 * s, body);
  p.rect(cx - w * 0.4, roof, cx + w * 0.4, hood, [50, 60, 72]);
  p.rect(cx - w * 0.4, roof, cx + w * 0.4, roof + Math.max(1, 0.1 * s), body);
  p.rect(cx - w / 2, base - 0.15 * s, cx - w / 2 + 0.3 * s, base, BLACK);
  p.rect(cx + w / 2 - 0.3 * s, base - 0.15 * s, cx + w / 2, base, BLACK);
  const lampY = p.y(0.7);
  const lamps = p.light.lamps;
  for (const side of [-1, 1] as const) {
    const lx = cx + side * w * 0.36;
    if (lamps > 0.1) {
      p.lightRect(lx - 0.15 * s, lampY - 0.08 * s, lx + 0.15 * s, lampY + 0.1 * s, HEADLIGHT, 1);
      p.glow(lx, lampY, Math.max(5, 1.6 * s), HEADLIGHT, 0.6 * lamps);
    } else {
      p.rect(lx - 0.15 * s, lampY - 0.08 * s, lx + 0.15 * s, lampY + 0.1 * s, [220, 224, 228]);
    }
  }
}
