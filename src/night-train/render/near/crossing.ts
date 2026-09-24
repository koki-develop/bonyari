import { hex, pack, type RGB } from "../../core/color.ts";
import { Rng } from "../../core/random.ts";
import { crossingActive, crossingClosure } from "../../sim/crossing.ts";
import type { Crossing } from "../../sim/route.ts";
import type { Painter } from "../painter.ts";

const YELLOW: RGB = [236, 196, 40];
const BLACK: RGB = [34, 32, 32];
const LAMP_RED: RGB = [255, 50, 36];
const HEADLIGHT: RGB = [255, 250, 230];
const ARROW: RGB = [255, 150, 40];
const POST: RGB = [168, 168, 164];
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

/** Which of the twin warning lamps (0 or 1) is lit at `time`. */
export function crossingLampPhase(time: number): number {
  return Math.floor(time * 1.8) % 2;
}

/**
 * A Japanese crossing signal: a post striped at its foot, the crossbuck and
 * bell on top, twin round lamps on black backplates under their visors, and
 * the arrow box showing which way the train comes from.
 */
function warningPost(p: Painter, along: number, active: boolean, time: number): void {
  const s = p.s;
  const cx = p.x(along);
  const Y = (h: number) => p.cam.yRail(p.lateral, h);
  const w = Math.max(1, 0.14 * s);
  p.cylinder(cx, Y(4.3), Y(-0.3), w, POST);
  // Yellow and black bands at the foot, to be seen by drivers.
  for (let k = 0; k < 5; k++) {
    const h0 = -0.3 + k * 0.28;
    p.cylinder(cx, Y(h0 + 0.28), Y(h0), w * 1.15, k % 2 === 0 ? YELLOW : BLACK);
  }
  // The bell housing on top.
  p.disc(cx, Y(4.42), Math.max(1, 0.16 * s), [70, 70, 72], true);
  // Crossbuck, outlined in black.
  const cy = Y(3.85);
  const arm = 0.55 * s;
  const t = Math.max(1, Math.round(0.14 * s));
  stripedLine(p, cx - arm, cy - arm * 0.45, cx + arm, cy + arm * 0.45, t, 0.25 * s);
  stripedLine(p, cx - arm, cy + arm * 0.45, cx + arm, cy - arm * 0.45, t, 0.25 * s);
  // Crossbar holding the lamps.
  const ly = Y(2.85);
  p.rect(
    cx - 0.42 * s,
    ly - Math.max(1, 0.04 * s),
    cx + 0.42 * s,
    ly + Math.max(1, 0.04 * s),
    BLACK,
  );
  const lr = Math.max(1, 0.15 * s);
  const phase = crossingLampPhase(time);
  for (const side of [-1, 1] as const) {
    const lx = cx + side * 0.4 * s;
    p.disc(lx, ly, lr * 1.9, BLACK);
    const on = active && (side === -1 ? phase === 0 : phase === 1);
    if (on) {
      p.lightDisc(lx, ly, lr, LAMP_RED);
      p.glow(lx, ly, Math.max(4, 1.3 * s), LAMP_RED, 0.55);
    } else {
      p.disc(lx, ly, lr, [96, 30, 26], true);
    }
    if (s > 6) {
      // The visor over the lens.
      p.rect(lx - lr * 1.2, ly - lr * 1.25, lx + lr * 1.2, ly - lr * 0.8, [52, 50, 50]);
    }
  }
  // Direction indicator: arrows light toward the approaching train.
  const by = Y(2.3);
  const bw = 0.34 * s;
  const bh = Math.max(2, 0.18 * s);
  p.rect(cx - bw, by - bh / 2, cx + bw, by + bh / 2, [28, 28, 30]);
  if (s > 5) {
    const arrow = (x0: number, dir: number, lit: boolean) => {
      const c: RGB = lit ? ARROW : [70, 50, 34];
      const len = Math.max(2, 0.18 * s);
      for (let i = 0; i < len; i++) {
        const x = x0 + dir * i;
        const spread = i < len * 0.4 ? Math.round((len * 0.4 - i) * 0.8) : 0;
        for (let dy = -spread; dy <= spread; dy++) {
          if (lit) {
            p.lightDot(x, by + dy, c, 1);
          } else {
            p.dot(x, by + dy, c);
          }
        }
      }
    };
    // Trains on our track come from the left of the crossing.
    arrow(cx - bw * 0.85, 1, active);
    arrow(cx + bw * 0.85, -1, false);
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
  // Gate machine: a yellow cabinet with a black cap, and its striped arm.
  const s = p.s;
  const mx = p.x(crossing.at - 3.4);
  const mTop = p.cam.yRail(lateral, 1.2);
  const mBase = p.cam.yRail(lateral, -0.3);
  const face = p.surfaceLight(0, 0, 1);
  const top = p.surfaceLight(0, 1, 0.3);
  for (let x = Math.floor(mx - 0.25 * s); x < Math.ceil(mx + 0.25 * s); x++) {
    const u = (x + 0.5 - mx) / (0.25 * s);
    const k = face * (u > 0.6 ? 0.85 : 1);
    p.rect(x, mTop, x + 1, mBase, [YELLOW[0] * k, YELLOW[1] * k, YELLOW[2] * k]);
  }
  p.rect(mx - 0.27 * s, mTop - Math.max(1, 0.08 * s), mx + 0.27 * s, mTop + Math.max(1, 0.18 * s), [
    BLACK[0] * top,
    BLACK[1] * top,
    BLACK[2] * top,
  ]);
  const angle = (1 - closure) * (Math.PI / 2 - 0.08) + 0.02;
  const len = 6.4;
  const pivotY = p.cam.yRail(lateral, 1.0);
  const ex = mx + Math.cos(angle) * len * s;
  const ey = pivotY - Math.sin(angle) * len * s;
  stripedLine(p, mx, pivotY, ex, ey, Math.max(1, Math.round(0.12 * s)), 0.5 * s);
  // The counterweight behind the pivot.
  p.disc(
    mx - Math.cos(angle) * 0.35 * s,
    pivotY + Math.sin(angle) * 0.35 * s,
    Math.max(1, 0.16 * s),
    [60, 60, 62],
    true,
  );
}

/**
 * A car waiting at the barrier, facing the track: bumper and number plate,
 * grille between the headlamps, the windshield reflecting the sky over the
 * dark cabin, tyres showing under the body. Its headlights shine at us at night.
 */
export function drawWaitingCar(p: Painter, crossing: Crossing, lateral: number, pos: number): void {
  const closure = crossingClosure(crossing, pos);
  if (closure < 0.3) {
    return;
  }
  const r = new Rng(crossing.seed);
  p.at(lateral);
  const s = p.s;
  const cx = p.x(crossing.at - 1.5);
  const ground = p.y(0);
  const kei = r.chance(0.4);
  const half = kei ? 0.74 : 0.85;
  const roof = kei ? 1.68 : 1.45;
  const bonnet = kei ? 1.0 : 0.88;
  const body = r.pick(CAR_COLORS);
  const [hr, hg, hb] = p.light.horizon;
  const face = p.surfaceLight(0, 0, 1);
  const top = p.surfaceLight(0, 0.9, 0.4);
  const lamps = p.light.lamps;
  for (let y = Math.floor(p.y(roof)); y < Math.ceil(ground); y++) {
    const h = (ground - (y + 0.5)) / s;
    for (let x = Math.floor(cx - half * s); x < Math.ceil(cx + half * s); x++) {
      const u = (x + 0.5 - cx) / s;
      const a = Math.abs(u);
      let c: RGB = body;
      let k = face;
      if (h < 0.28) {
        // Tyres at the corners, the dark underside between them.
        if (a > half - 0.28 || h > 0.2) {
          c = a > half - 0.28 && h < 0.24 ? [26, 26, 28] : [40, 40, 44];
        } else {
          continue;
        }
      } else if (h < bonnet) {
        if (h < 0.42) {
          // Bumper with the number plate.
          c = a < 0.18 && h > 0.3 && h < 0.4 ? (kei ? [232, 206, 60] : [230, 232, 226]) : body;
          k *= 0.9;
        } else if (h > 0.55 && h < 0.72 && a > half - 0.34 && a < half - 0.06) {
          c = lamps > 0.1 ? HEADLIGHT : [214, 218, 222];
          if (lamps > 0.1) {
            p.lightDot(x, y, HEADLIGHT, 1);
            continue;
          }
        } else if (h > 0.48 && h < 0.7 && a < half - 0.38) {
          c = [36, 38, 42];
        } else if (h > bonnet - 0.08) {
          k = top;
        }
      } else {
        // The cabin narrows toward the roof; the windshield fills most of it.
        const f = (h - bonnet) / (roof - bonnet);
        const cabin = half * (0.92 - 0.14 * f);
        if (a > cabin) {
          continue;
        }
        if (h < roof - 0.07 && a < cabin - 0.07) {
          const sky = 0.3 + 0.4 * f;
          const lr = p.shade.litR(34);
          const lg = p.shade.litG(40);
          const lb = p.shade.litB(50);
          p.view.set(x, y, pack(lr + (hr - lr) * sky, lg + (hg - lg) * sky, lb + (hb - lb) * sky));
          continue;
        }
        k = h > roof - 0.07 ? top : face * 0.95;
      }
      p.dotK(x, y, c, k);
    }
  }
  if (lamps > 0.1) {
    for (const side of [-1, 1] as const) {
      const lx = cx + side * (half - 0.2) * s;
      p.glow(lx, p.y(0.64), Math.max(5, 1.6 * s), HEADLIGHT, 0.6 * lamps);
    }
  }
}
