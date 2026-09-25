import { hex, mix, type RGB } from "../../core/color.ts";
import { clamp01, mod } from "../../core/math.ts";
import { hash3 } from "../../core/random.ts";
import type { Painter } from "../painter.ts";

/**
 * Building parts shared by houses, apartments and shops. Every function works
 * in meters relative to a building (so textures stay put while it scrolls) and
 * degrades gracefully as the building gets smaller on screen.
 */

export type WallKind = "siding" | "stucco" | "boards" | "tile" | "concrete";
export type RoofKind = "kawara" | "metal" | "slate";

export const SNOW: RGB = [238, 242, 250];
const FRAME_SILVER: RGB = hex("#c3c7cb");
const FRAME_BRONZE: RGB = hex("#5e5044");
const CURTAINS: readonly RGB[] = [
  "#e8dcc0",
  "#c9d6e0",
  "#e6c9c4",
  "#d8e2c8",
  "#efe8d8",
  "#b8a58c",
].map(hex);
const WARM: RGB = [255, 212, 150];
const COOL: RGB = [226, 238, 255];
const TV: RGB = [150, 180, 255];

/** A building placed on screen: its center, ground line and scale. */
export interface Frame {
  p: Painter;
  /** Screen x of the building's center. */
  cx: number;
  /** Art pixels per meter. */
  s: number;
  seed: number;
}

export function px(f: Frame, meters: number): number {
  return f.cx + meters * f.s;
}

export function py(f: Frame, height: number): number {
  return f.p.y(height);
}

function shadeRGB(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Wall texture color at a point (meters from the wall's left edge and from the ground). */
function wallTexel(kind: WallKind, base: RGB, u: number, v: number, s: number, seed: number): RGB {
  const onePx = 1 / s;
  switch (kind) {
    case "siding": {
      // Lap siding: a shadow line under each board.
      const line = s >= 3 && mod(v, 0.3) < onePx ? 0.9 : 1;
      return shadeRGB(base, line);
    }
    case "stucco": {
      const n = s >= 3 ? 0.97 + hash3(Math.floor(u * 6), Math.floor(v * 6), seed) * 0.05 : 1;
      return shadeRGB(base, n);
    }
    case "boards": {
      // Old weatherboards: each board a slightly different tone.
      const row = Math.floor(v / 0.22);
      const tone = 0.9 + hash3(row, Math.floor(u / 1.8 + row * 0.37), seed) * 0.16;
      const gap = s >= 3 && mod(v, 0.22) < onePx ? 0.72 : 1;
      return shadeRGB(base, tone * gap);
    }
    case "tile": {
      const row = Math.floor(v / 0.25);
      const col = Math.floor(u / 0.5 + (row % 2) * 0.5);
      const joint =
        s >= 4 && (mod(v, 0.25) < onePx || mod(u + (row % 2) * 0.25, 0.5) < onePx) ? 0.85 : 1;
      return shadeRGB(base, joint * (0.95 + hash3(row, col, seed) * 0.08));
    }
    case "concrete": {
      const panel = s >= 3 && (mod(u, 1.8) < onePx || mod(v, 0.9) < onePx * 0.6) ? 0.93 : 1;
      return shadeRGB(base, panel);
    }
  }
}

/** Fills a wall between x0..x1 meters (relative to center) and heights h0..h1. */
export function wall(
  f: Frame,
  x0: number,
  x1: number,
  h0: number,
  h1: number,
  kind: WallKind,
  color: RGB,
): void {
  const { p, s } = f;
  const sx0 = Math.round(px(f, x0));
  const sx1 = Math.round(px(f, x1));
  const sy0 = Math.round(py(f, h1));
  const sy1 = Math.round(py(f, h0));
  if (s < 2.5) {
    p.rect(sx0, sy0, sx1, sy1, color);
    return;
  }
  for (let y = sy0; y < sy1; y++) {
    const v = (sy1 - y - 0.5) / s + h0;
    for (let x = sx0; x < sx1; x++) {
      const u = (x + 0.5 - sx0) / s;
      let c = wallTexel(kind, color, u, v, s, f.seed);
      // Corner trim.
      if (x === sx0 || x === sx1 - 1) {
        c = shadeRGB(c, x === sx0 ? 1.06 : 0.86);
      }
      p.dot(x, y, c);
    }
  }
}

/**
 * A roof seen from the front with its ridge parallel to the track.
 * `taper` is how far (m) the ridge is pulled in from each end: 0 for a gable,
 * about the rise for a hip roof.
 */
export function roof(
  f: Frame,
  x0: number,
  x1: number,
  eave: number,
  ridge: number,
  taper: number,
  kind: RoofKind,
  color: RGB,
  options: { snow: number; solar?: boolean; ridgeCap?: boolean },
): void {
  const { p, s } = f;
  const top = Math.round(py(f, ridge));
  const bottom = Math.round(py(f, eave));
  const rows = Math.max(1, bottom - top);
  const snow = options.snow;
  for (let y = top; y < bottom; y++) {
    const t = (y - top + 0.5) / rows;
    const inset = taper * (1 - t);
    const a = Math.round(px(f, x0 + inset));
    const b = Math.round(px(f, x1 - inset));
    const v = (1 - t) * (ridge - eave);
    const litRow = 1.08 - t * 0.18;
    for (let x = a; x < b; x++) {
      const u = (x + 0.5 - px(f, x0)) / s;
      let k = litRow;
      if (s >= 3) {
        if (kind === "kawara") {
          // Tile courses and the rolls of each tile.
          const course = mod(v, 0.3) < 1 / s ? 0.78 : 1;
          const roll = 0.93 + 0.1 * Math.sin((u / 0.3) * Math.PI * 2);
          k *= course * roll;
        } else if (kind === "metal") {
          k *= mod(u, 0.45) < 1 / s ? 0.8 : 1;
        } else {
          k *=
            mod(v, 0.22) < 1 / s
              ? 0.85
              : 0.98 + hash3(Math.floor(u / 0.4), Math.floor(v / 0.22), f.seed) * 0.05;
        }
      }
      let c = shadeRGB(color, k);
      if (options.solar && t > 0.2 && t < 0.85 && u > (x1 - x0) * 0.3 && u < (x1 - x0) * 0.72) {
        const grid = s >= 3 && (mod(u, 1) < 1 / s || mod(v, 0.8) < 1 / s);
        c = grid ? [120, 130, 150] : [40, 56, 92];
      }
      if (snow > 0) {
        const cover = clamp01(snow * 1.4 - t * 0.5);
        c = mix(c, SNOW, cover);
      }
      p.dot(x, y, c);
    }
  }
  // Eave lip and the ridge cap.
  const lipA = Math.round(px(f, x0));
  const lipB = Math.round(px(f, x1));
  p.rect(lipA, bottom - 1, lipB, bottom, shadeRGB(color, snow > 0.5 ? 1.2 : 0.7));
  if (options.ridgeCap !== false && ridge - eave > 0.4) {
    const ra = Math.round(px(f, x0 + taper));
    const rb = Math.round(px(f, x1 - taper));
    const capH = Math.max(1, Math.round(0.22 * s));
    const cap = snow > 0.3 ? SNOW : shadeRGB(color, kind === "kawara" ? 0.75 : 0.9);
    p.rect(ra, top - capH + 1, rb, top + 1, cap);
    if (kind === "kawara" && s >= 3) {
      // Onigawara: the upturned end tiles.
      p.rect(ra - 1, top - capH - 1, ra + 1, top + 1, shadeRGB(color, 0.6));
      p.rect(rb - 1, top - capH - 1, rb + 1, top + 1, shadeRGB(color, 0.6));
    }
  }
}

/** Shadow cast by the eaves onto the wall below. */
export function eaveShadow(f: Frame, x0: number, x1: number, eave: number, depth: number): void {
  const y = Math.round(py(f, eave));
  const h = Math.max(1, Math.round(depth * f.s));
  f.p.rectAlpha(px(f, x0), y, px(f, x1), y + h, [20, 22, 30], 0.35);
}

export interface WindowOptions {
  /** Index for the lit/unlit state. */
  index: number;
  frame?: "silver" | "bronze";
  /** Two sliding sashes (a center mullion). */
  sliding?: boolean;
  /** Frosted glass (bathroom): glows but shows nothing. */
  frosted?: boolean;
  /** Night shutters (amado) are closed. */
  shuttered?: boolean;
  /** Protective lattice over small windows. */
  lattice?: boolean;
}

/**
 * A window: aluminum frame, sky-tinted glass by day; by night warm light with
 * curtains, sometimes the flicker of a television.
 */
export function windowUnit(
  f: Frame,
  x0: number,
  x1: number,
  h0: number,
  h1: number,
  o: WindowOptions,
): void {
  const { p, s, seed } = f;
  const a = Math.round(px(f, x0));
  const b = Math.max(a + 1, Math.round(px(f, x1)));
  const top = Math.round(py(f, h1));
  const bottom = Math.max(top + 1, Math.round(py(f, h0)));
  const frame = o.frame === "bronze" ? FRAME_BRONZE : FRAME_SILVER;
  const lit = p.windowLit(seed, o.index);
  if (o.shuttered) {
    p.rect(a, top, b, bottom, [150, 146, 136]);
    if (s >= 3) {
      for (let x = a + 1; x < b; x += Math.max(2, Math.round(0.25 * s))) {
        p.rect(x, top, x + 1, bottom, [120, 116, 108]);
      }
    }
    if (lit && s >= 2) {
      // Light leaking round the edges of the shutters.
      p.lightRect(a, bottom - 1, b, bottom, WARM, 0.35);
    }
    return;
  }
  if (s < 2.5) {
    if (lit) {
      p.lightRect(a, top, b, bottom, p.windowColor(seed, o.index), 0.9);
    } else {
      p.rect(a, top, b, bottom, glassColor(p, 0.5));
    }
    return;
  }
  // Frame.
  p.rect(a - 1, top - 1, b + 1, bottom + 1, frame);
  const w = b - a;
  const h = bottom - top;
  if (lit) {
    const warm = hash3(seed, o.index, 11) < 0.72;
    const light = warm ? WARM : COOL;
    if (o.frosted) {
      p.lightRect(a, top, b, bottom, mix(light, [255, 255, 255], 0.3), 0.75);
    } else {
      const curtain = CURTAINS[Math.floor(hash3(seed, o.index, 12) * CURTAINS.length)];
      // How far the curtains are drawn, from open to nearly closed.
      const drawn = 0.15 + hash3(seed, o.index, 13) * 0.75;
      const opening = Math.max(1, Math.round(w * (1 - drawn)));
      const left = a + Math.round((w - opening) * hash3(seed, o.index, 14));
      for (let x = a; x < b; x++) {
        const open = x >= left && x < left + opening;
        if (open) {
          p.lightRect(x, top, x + 1, bottom, light, 0.95);
        } else {
          // Curtains glow with the light behind them; folds as faint stripes.
          const fold = (x - a) % 2 === 0 ? 1 : 0.85;
          p.lightRect(x, top, x + 1, bottom, shadeRGB(mix(curtain, light, 0.35), fold * 0.8), 0.9);
        }
      }
      if (hash3(seed, o.index, 15) < 0.18) {
        // Television flicker.
        const flick = 0.35 + 0.35 * Math.sin(p.time * 7 + o.index) * Math.sin(p.time * 2.3 + seed);
        p.lightRect(left, top + Math.round(h * 0.3), left + opening, bottom, TV, clamp01(flick));
      }
    }
    if (w >= 3) {
      p.glow((a + b) / 2, (top + bottom) / 2, Math.max(3, w * 0.9), light, 0.07);
    }
  } else {
    // Glass reflecting the sky, with a diagonal glint.
    for (let y = top; y < bottom; y++) {
      const t = (y - top) / Math.max(1, h);
      p.rect(a, y, b, y + 1, glassColor(p, t));
    }
    if (!o.frosted && w >= 4 && h >= 4) {
      for (let k = 0; k < Math.min(w, h) - 1; k++) {
        p.rectAlpha(
          a + Math.round(w * 0.2) + k,
          bottom - 2 - k,
          a + Math.round(w * 0.2) + k + 1,
          bottom - 1 - k,
          [230, 240, 250],
          0.18,
        );
      }
    }
    if (o.frosted) {
      p.rectAlpha(a, top, b, bottom, [220, 224, 226], 0.7);
    }
  }
  if (o.sliding && w >= 4) {
    const mid = Math.round((a + b) / 2);
    p.rect(mid, top, mid + 1, bottom, frame);
  }
  if (o.lattice && s >= 3) {
    for (let x = a; x < b; x += 2) {
      p.rect(x, top, x + 1, bottom, frame);
    }
  }
  // Sill.
  p.rect(a - 1, bottom, b + 1, bottom + 1, shadeRGB(frame, 0.85));
}

/** Day glass color: sky above, darker room below. */
function glassColor(p: Painter, t: number): RGB {
  const sky = mix(p.light.zenith, p.light.horizon, 0.5);
  const dark: RGB = [40, 46, 56];
  // Unlit glass shows the sky by day and is near-black at night.
  const k = p.light.daylight;
  return mix(dark, mix(sky, dark, 0.35 + t * 0.4), k * 0.8);
}

/** A railing: vertical bars when close, a translucent band when far. */
export function railing(
  f: Frame,
  x0: number,
  x1: number,
  h0: number,
  h1: number,
  color: RGB,
  solid: boolean,
): void {
  const { p, s } = f;
  const a = Math.round(px(f, x0));
  const b = Math.round(px(f, x1));
  const top = Math.round(py(f, h1));
  const bottom = Math.round(py(f, h0));
  p.rect(a, top, b, top + 1, color);
  if (solid) {
    p.rect(a, top + 1, b, bottom, shadeRGB(color, 0.94));
    return;
  }
  if (s >= 4) {
    const step = Math.max(2, Math.round(0.14 * s));
    for (let x = a; x < b; x += step) {
      p.rect(x, top, x + 1, bottom, color);
    }
    p.rect(a, bottom - 1, b, bottom, color);
  } else {
    p.rectAlpha(a, top, b, bottom, color, 0.55);
  }
}

const LAUNDRY: readonly RGB[] = [
  "#f2f2ee",
  "#8fb4d8",
  "#e8c46a",
  "#d98a8a",
  "#9ac49a",
  "#ffffff",
  "#50607a",
].map(hex);

/** Washing on a pole, and sometimes a futon over the railing, on fine days. */
export function laundry(f: Frame, x0: number, x1: number, floor: number, index: number): void {
  const { p, s, seed } = f;
  const hour = p.world.clock.hour;
  const w = p.world.weather.state;
  if (
    hour < 8 ||
    hour > 16.5 ||
    w.rain > 0.05 ||
    w.snow > 0.05 ||
    hash3(seed, index, 21) > 0.55 ||
    s < 2
  ) {
    return;
  }
  const poleY = Math.round(py(f, floor + 1.9));
  p.rect(px(f, x0), poleY, px(f, x1), poleY + 1, [180, 184, 188]);
  let x = x0 + 0.15;
  let k = 0;
  while (x < x1 - 0.4) {
    const width = 0.35 + hash3(seed, index, 30 + k) * 0.35;
    const drop = 0.35 + hash3(seed, index, 40 + k) * 0.55;
    const c = LAUNDRY[Math.floor(hash3(seed, index, 50 + k) * LAUNDRY.length)];
    // A gentle sway in the breeze.
    const sway = Math.round(Math.sin(p.time * 1.7 + k + index) * 0.6 * w.wind * s * 0.3);
    p.rect(px(f, x) + sway, poleY + 1, px(f, x + width) + sway, py(f, floor + 1.9 - drop), c);
    x += width + 0.12 + hash3(seed, index, 60 + k) * 0.3;
    k++;
  }
  if (hash3(seed, index, 22) < 0.35 && hour < 14) {
    const fx = x0 + (x1 - x0) * 0.1;
    p.rect(
      px(f, fx),
      py(f, floor + 1.15),
      px(f, fx + 1.5),
      py(f, floor + 0.55),
      LAUNDRY[Math.floor(hash3(seed, index, 23) * 5)],
    );
  }
}

/** Outdoor unit of an air conditioner. */
export function acUnit(f: Frame, x: number, h: number): void {
  const { p, s } = f;
  const a = px(f, x);
  const top = py(f, h + 0.55);
  const bottom = py(f, h);
  p.rect(a, top, a + 0.8 * s, bottom, [214, 214, 208]);
  if (s >= 5) {
    const cx = a + 0.5 * s;
    const cy = (top + bottom) / 2;
    const r = 0.2 * s;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        if (Math.hypot(xx + 0.5 - cx, y + 0.5 - cy) <= r) {
          p.dot(xx, y, [110, 112, 112]);
        }
      }
    }
  }
}

/** A downpipe from the gutter to the ground. */
export function downpipe(f: Frame, x: number, top: number): void {
  const a = Math.round(px(f, x));
  f.p.rect(a, py(f, top), a + 1, py(f, 0), [150, 150, 148]);
}

/** Front wall of concrete blocks, or a clipped hedge. */
export function frontFence(
  f: Frame,
  x0: number,
  x1: number,
  kind: "block" | "hedge" | "none",
): void {
  const { p, s, seed } = f;
  if (kind === "none") {
    return;
  }
  const a = Math.round(px(f, x0));
  const b = Math.round(px(f, x1));
  const bottom = Math.round(py(f, 0));
  if (kind === "block") {
    const top = Math.round(py(f, 1.2));
    for (let y = top; y < bottom; y++) {
      const v = (bottom - y - 0.5) / s;
      const row = Math.floor(v / 0.2);
      for (let x = a; x < b; x++) {
        const u = (x + 0.5 - a) / s;
        const joint = s >= 4 && (mod(v, 0.2) < 1 / s || mod(u + (row % 2) * 0.2, 0.4) < 1 / s);
        p.dot(x, y, joint ? [140, 138, 132] : [176, 172, 164]);
      }
    }
    p.rect(a, top - 1, b, top, [196, 192, 184]);
    return;
  }
  const green = mix(p.world.season.evergreen, [70, 110, 60], 0.3);
  const top = py(f, 1.1);
  for (let x = a; x < b; x++) {
    const bump = hash3(seed, x - a, 71) * 0.15 * s;
    for (let y = Math.round(top - bump); y < bottom; y++) {
      const n = hash3(seed, x - a, y - bottom);
      p.dot(x, y, shadeRGB(green, 0.85 + n * 0.25 - ((y - top) / Math.max(1, bottom - top)) * 0.2));
    }
  }
}

/** A small lamp by the front door, lit in the evening. */
export function porchLight(f: Frame, x: number, h: number): void {
  const { p, s } = f;
  const lx = px(f, x);
  const ly = py(f, h);
  if (p.light.lamps > 0.15) {
    p.lightRect(lx, ly, lx + Math.max(1, 0.15 * s), ly + Math.max(1, 0.2 * s), [255, 222, 160], 1);
    p.glow(lx + 0.5, ly + 1, Math.max(3, 1.2 * s), [255, 200, 130], 0.3 * p.light.lamps);
  } else {
    p.rect(lx, ly, lx + Math.max(1, 0.15 * s), ly + Math.max(1, 0.2 * s), [230, 226, 214]);
  }
}

/** A TV antenna on the roof of older houses. */
export function antenna(f: Frame, x: number, base: number): void {
  const { p, s } = f;
  if (s < 3) {
    return;
  }
  const a = Math.round(px(f, x));
  const top = py(f, base + 2.2);
  p.rect(a, top, a + 1, py(f, base), [90, 92, 96]);
  for (const [h, w] of [
    [2.1, 0.7],
    [1.8, 0.5],
    [1.5, 0.35],
  ] as const) {
    const y = Math.round(py(f, base + h));
    p.rect(a - w * s, y, a + w * s + 1, y + 1, [90, 92, 96]);
  }
}

export const DRINK_COLORS: readonly RGB[] = [
  "#d33b2f",
  "#2f6db5",
  "#f0c43c",
  "#3b9a55",
  "#f2f2f0",
  "#7a4b2c",
  "#e37a2e",
  "#9a3a8a",
].map(hex);

/**
 * A Japanese drinks vending machine: a lit window of sample cans with blue
 * (cold) and red (hot) labels, buttons, a coin panel and the take-out slot.
 * `floor` is the height (m above ground, or above rails when `rail`) it stands on.
 */
export function vendingMachine(
  p: Painter,
  along: number,
  lateral: number,
  floor: number,
  seed: number,
  rail: boolean,
): void {
  p.at(lateral);
  const s = p.s;
  const y = (h: number) => (rail ? p.cam.yRail(lateral, floor + h) : p.y(floor + h));
  const bodies: readonly RGB[] = ["#ececea", "#c8352e", "#2d63ad", "#2f7a4a", "#2a2a2e"].map(hex);
  const body = bodies[Math.floor(hash3(seed, 1, 1) * bodies.length)];
  const cx = p.x(along);
  const w = 1.0 * s;
  const x0 = Math.round(cx - w / 2);
  const x1 = Math.round(cx + w / 2);
  const top = Math.round(y(1.83));
  const bottom = Math.round(y(0));
  const lamps = p.light.lamps;
  // Lit, but not a floodlight: a soft panel glow that barely spills.
  const glowOn = 0.55 + 0.4 * lamps;
  const panel: RGB = [214, 226, 234];
  // Body with a darker side edge.
  p.rect(x0, top, x1, bottom, body);
  p.rect(x1 - Math.max(1, Math.round(0.08 * s)), top, x1, bottom, shadeRGB(body, 0.78));
  if (s < 4) {
    p.lightRect(x0 + 1, y(1.6), x1 - 1, y(1.0), panel, glowOn);
    p.glow(cx, (top + bottom) / 2, Math.max(2, 1.1 * s), [190, 210, 240], 0.1 * lamps);
    return;
  }
  // Header panel.
  const header = Math.round(y(1.66));
  p.lightRect(x0 + 1, top + 1, x1 - 1, header, shadeRGB(body, 1.15), 0.5 + 0.5 * lamps);
  // The display window: three shelves of sample drinks behind glass.
  const winTop = header + 1;
  const winBottom = Math.round(y(0.98));
  p.lightRect(x0 + 1, winTop, x1 - 2, winBottom, panel, glowOn);
  const rows = 3;
  const inner = x1 - 2 - (x0 + 1);
  for (let row = 0; row < rows; row++) {
    const rt = winTop + Math.round(((winBottom - winTop) * row) / rows);
    const rb = winTop + Math.round(((winBottom - winTop) * (row + 1)) / rows);
    const canH = Math.max(1, Math.round((rb - rt) * 0.6));
    const cans = Math.max(2, Math.floor(inner / 2));
    for (let i = 0; i < cans; i++) {
      const c = DRINK_COLORS[Math.floor(hash3(seed, row, i) * DRINK_COLORS.length)];
      const xx = x0 + 1 + Math.round(((i + 0.5) * inner) / cans);
      p.lightRect(xx, rb - 1 - canH, xx + 1, rb - 1, c, 0.95);
    }
    // Price labels: blue for cold, red for hot (mostly red in winter).
    const hot = hash3(seed, row, 99) < 0.2 + (1 - p.world.season.warmth) * 0.5;
    p.lightRect(x0 + 1, rb - 1, x1 - 2, rb, hot ? [230, 70, 60] : [70, 130, 230], 0.9);
  }
  // Coin panel and bill slot on the right, an advert on the left.
  const panelTop = winBottom + 1;
  const panelBottom = Math.round(y(0.42));
  p.rect(x0 + 1, panelTop, x1 - 2, panelBottom, shadeRGB(body, 0.92));
  const adv = DRINK_COLORS[Math.floor(hash3(seed, 7, 7) * DRINK_COLORS.length)];
  p.lightRect(
    x0 + 1,
    panelTop + 1,
    x0 + 1 + Math.round(inner * 0.55),
    panelBottom - 1,
    adv,
    0.35 + 0.4 * lamps,
  );
  const coin = x0 + 1 + Math.round(inner * 0.7);
  p.rect(coin, panelTop + 1, x1 - 2, panelBottom - 1, [60, 62, 66]);
  p.lightDot(coin + 1, panelTop + 2, [120, 255, 140], 0.9);
  // Take-out slot.
  const slotTop = Math.round(y(0.34));
  const slotBottom = Math.round(y(0.12));
  p.rect(x0 + 2, slotTop, x1 - 3, Math.max(slotTop + 1, slotBottom), [26, 26, 30]);
  // Light spills onto the ground in front at night.
  if (lamps > 0.1) {
    p.glow(cx, bottom, Math.max(3, 1.3 * s), [180, 200, 235], 0.09 * lamps);
    p.glow(cx, (winTop + winBottom) / 2, Math.max(3, 1.1 * s), [190, 210, 240], 0.06 * lamps);
  }
  // A recycling bin for empties beside it.
  if (hash3(seed, 3, 3) < 0.7) {
    const bx0 = x1 + Math.max(1, Math.round(0.08 * s));
    const bx1 = bx0 + Math.round(0.45 * s);
    const bt = Math.round(y(0.9));
    p.rect(bx0, bt, bx1, bottom, [236, 236, 232]);
    p.rect(bx0, bt, bx1, bt + Math.max(1, Math.round(0.15 * s)), [60, 110, 180]);
    p.rect(
      bx0 + Math.round(0.12 * s),
      bt + Math.round(0.25 * s),
      bx1 - Math.round(0.12 * s),
      bt + Math.round(0.25 * s) + 1,
      [40, 40, 44],
    );
  }
}
