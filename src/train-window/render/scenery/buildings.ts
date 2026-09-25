import { hex, mix, type RGB } from "../../../shared/core/color.ts";
import { mod } from "../../../shared/core/math.ts";
import { hash3, Rng } from "../../../shared/core/random.ts";
import type { Painter } from "../../../shared/render/painter.ts";
import type { Camera } from "../camera.ts";
import {
  acUnit,
  antenna,
  downpipe,
  eaveShadow,
  type Frame,
  frontFence,
  laundry,
  porchLight,
  px,
  py,
  railing,
  roof,
  type RoofKind,
  SNOW,
  vendingMachine,
  wall,
  type WallKind,
  windowUnit,
} from "./facade.ts";
import type { Scenery } from "./placement.ts";

const SIDING: readonly RGB[] = [
  "#e6e0d4",
  "#d8cfbe",
  "#cdd2d3",
  "#e2d5ba",
  "#bcc2be",
  "#d9c7b0",
].map(hex);
const STUCCO: readonly RGB[] = ["#eee8db", "#e0d4bd", "#d4c9b4", "#f0ebe1", "#e4dccd"].map(hex);
const BOARDS: readonly RGB[] = ["#6b4e3d", "#5a4436", "#76593f"].map(hex);
const TILE_WALL: readonly RGB[] = ["#b9a58a", "#a69a8b", "#908b86"].map(hex);
const KAWARA: readonly RGB[] = ["#4b5059", "#3e434b", "#575c63", "#3b4a5e"].map(hex);
const METAL: readonly RGB[] = ["#3f4a43", "#5b3a32", "#3d4452", "#66686b", "#2f3a4a"].map(hex);
const SLATE: readonly RGB[] = ["#4a4e55", "#55493f", "#39414a"].map(hex);
const DOORS: readonly RGB[] = ["#6a4a34", "#4c3a2e", "#8a6a4a", "#3a3c40", "#b8b2a4"].map(hex);
const CONCRETE: readonly RGB[] = ["#d8d4cc", "#cbc2b1", "#e1dacd", "#bfc2c2", "#d4cdbf"].map(hex);
const SIGNS: readonly RGB[] = ["#2f9a5a", "#2f6fc0", "#e0862a", "#d8423a", "#f0c534"].map(hex);
const AWNINGS: readonly RGB[] = ["#b8322c", "#2e5e9e", "#2f7a4a", "#c8862a"].map(hex);

function shadeRGB(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

type HouseStyle = "modern" | "traditional" | "old" | "cube";
type Opening = "sliding" | "window" | "door" | "small";

/** Evenly spaced bays across a wall, each with an opening (or blank wall). */
function bays(r: Rng, width: number, ground: boolean, style: HouseStyle): Opening[] {
  const n = Math.max(2, Math.floor(width / 1.9));
  const out: Opening[] = [];
  const doorAt = ground ? r.int(0, n - 1) : -1;
  for (let i = 0; i < n; i++) {
    if (i === doorAt) {
      out.push("door");
    } else if (ground) {
      out.push(r.weighted<Opening>({ sliding: style === "cube" ? 1 : 3, window: 2, small: 1.2 }));
    } else {
      out.push(r.weighted<Opening>({ window: 4, small: 1, sliding: 0.6 }));
    }
  }
  return out;
}

/** A front door standing on `base` (m), with a small hood and optionally a lamp. */
function door(f: Frame, x: number, color: RGB, lamp: boolean, base: number): void {
  const { p, s } = f;
  const a = Math.round(px(f, x - 0.45));
  const b = Math.round(px(f, x + 0.45));
  const top = Math.round(py(f, base + 1.95));
  const bottom = Math.round(py(f, base));
  p.rect(a - 1, top - 1, b + 1, bottom, [150, 146, 140]);
  p.rect(a, top, b, bottom, color);
  if (s >= 4) {
    // Glass strip and handle.
    p.rect(
      a + 1,
      top + 1,
      a + Math.max(2, Math.round(0.18 * s)),
      bottom - 1,
      shadeRGB(color, 1.35),
    );
    const hy = Math.round((top + bottom) / 2);
    p.rect(
      b - Math.max(2, Math.round(0.18 * s)),
      hy,
      b - Math.max(1, Math.round(0.1 * s)),
      hy + 1,
      [200, 196, 180],
    );
  }
  // Hood.
  p.rect(px(f, x - 0.75), py(f, base + 2.15), px(f, x + 0.75), py(f, base + 2.0), [120, 118, 116]);
  if (base > 0.2 && base < 1) {
    // Step up from the ground.
    p.rect(px(f, x - 0.7), py(f, base), px(f, x + 0.7), py(f, base - 0.25), [168, 164, 156]);
  }
  if (lamp) {
    porchLight(f, x + 0.7, base + 1.7);
  }
}

/** A shutter box (tobukuro) beside a sliding window. */
function shutterBox(f: Frame, x0: number, x1: number, h0: number, h1: number, color: RGB): void {
  f.p.rect(px(f, x0), py(f, h1), px(f, x1), py(f, h0), color);
}

export function drawHouse(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const style = r.weighted<HouseStyle>({ modern: 5, traditional: 2.5, old: 1.5, cube: 1.2 });
  const floors =
    style === "old"
      ? 1
      : style === "traditional"
        ? r.chance(0.7)
          ? 2
          : 1
        : r.chance(0.88)
          ? 2
          : 1;
  const W = r.range(7.5, 10.5);
  const fh = 2.8;
  const plinth = 0.45;
  const wallTop = floors * fh + plinth;
  const snow = p.env.weather.state.snowCover;
  const f: Frame = { p, cx: p.x(o.along), s, seed: o.seed };
  const half = W / 2;

  const wallKind: WallKind =
    style === "old"
      ? "boards"
      : style === "cube"
        ? r.pick<WallKind>(["stucco", "concrete"])
        : style === "traditional"
          ? r.pick<WallKind>(["stucco", "boards"])
          : r.pick<WallKind>(["siding", "siding", "tile", "stucco"]);
  const wallColor =
    wallKind === "boards"
      ? r.pick(BOARDS)
      : wallKind === "tile"
        ? r.pick(TILE_WALL)
        : wallKind === "siding"
          ? r.pick(SIDING)
          : r.pick(STUCCO);
  const roofKind: RoofKind =
    style === "traditional" || style === "old"
      ? "kawara"
      : r.pick<RoofKind>(["metal", "slate", "kawara"]);
  const roofColor =
    roofKind === "kawara" ? r.pick(KAWARA) : roofKind === "metal" ? r.pick(METAL) : r.pick(SLATE);
  const eave = style === "cube" ? 0.15 : 0.5;
  const rise = style === "cube" ? 0.35 : r.range(1.7, 2.5);

  // Far away: a block with a roof and a light or two.
  if (W * s < 5) {
    const x0 = Math.round(px(f, -half));
    const x1 = Math.max(x0 + 1, Math.round(px(f, half)));
    p.rect(x0, py(f, wallTop), x1, py(f, 0), wallColor);
    p.rect(x0, py(f, wallTop + rise), x1, py(f, wallTop), snow > 0.5 ? SNOW : roofColor);
    if (p.windowLit(o.seed, 0)) {
      p.lightDot(f.cx, py(f, wallTop * 0.5), p.windowColor(o.seed, 0), 0.9);
    }
    return;
  }

  // Walls, plinth and the drip line.
  wall(f, -half, half, plinth, wallTop, wallKind, wallColor);
  p.rect(px(f, -half), py(f, plinth), px(f, half), py(f, 0), [128, 126, 120]);
  if (s >= 4) {
    for (let x = -half + 1; x < half - 0.5; x += 1.8) {
      p.rect(px(f, x), py(f, 0.3), px(f, x + 0.3), py(f, 0.2), [70, 70, 70]);
    }
  }
  if (floors === 2 && s >= 3 && wallKind !== "boards") {
    // A band between floors.
    p.rect(
      px(f, -half),
      py(f, fh + plinth + 0.12),
      px(f, half),
      py(f, fh + plinth),
      shadeRGB(wallColor, 0.88),
    );
  }

  // Openings, floor by floor.
  const frame = r.chance(0.6) ? "silver" : "bronze";
  const nightShutters =
    hash3(o.seed, 5, 5) < 0.55 && (p.env.clock.hour > 22 || p.env.clock.hour < 5.5);
  let index = 0;
  let doorX = 0;
  for (let floor = 0; floor < floors; floor++) {
    const f0 = floor * fh + plinth;
    const list = bays(r, W, floor === 0, style);
    const bayW = (W - 0.8) / list.length;
    list.forEach((kind, i) => {
      const cx = -half + 0.4 + bayW * (i + 0.5);
      index++;
      switch (kind) {
        case "door":
          doorX = cx;
          door(f, cx, r.pick(DOORS), true, plinth);
          break;
        case "sliding": {
          const w = Math.min(bayW - 0.25, 1.75);
          windowUnit(f, cx - w / 2, cx + w / 2, f0 + 0.05, f0 + 2.0, {
            index,
            frame,
            sliding: true,
            shuttered: floor === 0 && nightShutters,
          });
          if (style === "traditional" || style === "old") {
            shutterBox(
              f,
              cx + w / 2 + 0.05,
              cx + w / 2 + 0.35,
              f0 + 0.05,
              f0 + 2.05,
              shadeRGB(wallColor, 0.8),
            );
          }
          break;
        }
        case "window": {
          const w = Math.min(bayW - 0.35, 1.5);
          windowUnit(f, cx - w / 2, cx + w / 2, f0 + 0.95, f0 + 2.05, {
            index,
            frame,
            sliding: true,
          });
          break;
        }
        case "small": {
          windowUnit(f, cx - 0.3, cx + 0.3, f0 + 1.55, f0 + 2.05, {
            index,
            frame,
            frosted: true,
            lattice: true,
          });
          break;
        }
      }
    });
  }

  // A balcony across part of the upper floor, with the washing out.
  if (floors === 2 && style !== "old" && r.chance(0.6)) {
    const bx0 = -half + W * r.range(0.05, 0.3);
    const bx1 = bx0 + W * r.range(0.4, 0.6);
    const floorH = fh + plinth;
    p.rect(px(f, bx0), py(f, floorH), px(f, bx1), py(f, floorH - 0.15), shadeRGB(wallColor, 0.8));
    laundry(f, bx0, bx1, floorH, 1);
    railing(
      f,
      bx0,
      bx1,
      floorH,
      floorH + 1.1,
      style === "cube" ? shadeRGB(wallColor, 0.95) : [196, 200, 204],
      style === "cube",
    );
  } else if (floors === 2 && style !== "cube" && r.chance(0.6)) {
    // A lean-to roof (geya) over part of the ground floor.
    const gx0 = -half - 0.2 + W * r.range(0, 0.3);
    const gx1 = Math.min(half + 0.2, gx0 + W * r.range(0.4, 0.7));
    roof(f, gx0, gx1, fh + plinth - 0.05, fh + plinth + 0.55, 0, roofKind, roofColor, {
      snow,
      ridgeCap: false,
    });
  }

  // The main roof.
  const rx0 = -half - eave;
  const rx1 = half + eave;
  if (style === "cube") {
    p.rect(px(f, rx0), py(f, wallTop + 0.4), px(f, rx1), py(f, wallTop), shadeRGB(wallColor, 0.92));
    p.rect(
      px(f, rx0),
      py(f, wallTop + 0.4),
      px(f, rx1),
      py(f, wallTop + 0.4) + 1,
      snow > 0.3 ? SNOW : shadeRGB(wallColor, 1.08),
    );
  } else {
    const hip = style === "traditional" ? 0.5 : r.chance(0.55) ? 1 : 0;
    const taper = hip * rise * 1.1;
    if (style === "traditional" && hip > 0) {
      // Irimoya: a hipped skirt with a gable on top.
      const mid = wallTop + rise * 0.55;
      roof(f, rx0, rx1, wallTop, mid, rise * 0.6, roofKind, roofColor, { snow, ridgeCap: false });
      roof(
        f,
        rx0 + rise * 0.75,
        rx1 - rise * 0.75,
        mid - 0.08,
        wallTop + rise,
        0.1,
        roofKind,
        roofColor,
        { snow },
      );
    } else {
      roof(f, rx0, rx1, wallTop, wallTop + rise, taper, roofKind, roofColor, {
        snow,
        solar: style === "modern" && hip > 0 && hash3(o.seed, 9, 9) < 0.3,
      });
    }
    eaveShadow(f, -half, half, wallTop, 0.25);
    if ((style === "old" || style === "traditional") && hash3(o.seed, 8, 8) < 0.5) {
      antenna(f, half * 0.4, wallTop + rise);
    }
  }
  downpipe(f, r.chance(0.5) ? -half + 0.1 : half - 0.2, wallTop);
  if (s >= 3 && r.chance(0.7)) {
    acUnit(f, doorX > 0 ? -half + 0.5 : half - 1.4, 0);
  }
  frontFence(
    f,
    -half - 0.6,
    half + 0.6,
    r.weighted<"block" | "hedge" | "none">({ block: 4, hedge: 3, none: 2.5 }),
  );
}

export function drawApartment(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  if (r.chance(0.4)) {
    drawWoodenApartment(p, o, r);
  } else {
    drawMansion(p, o, r);
  }
}

/** A two-storey wooden "apaato" seen from its open walkway side, with steel stairs. */
function drawWoodenApartment(p: Painter<Camera>, o: Scenery, r: Rng): void {
  const s = p.s;
  const f: Frame = { p, cx: p.x(o.along), s, seed: o.seed };
  const W = r.range(14, 22);
  const half = W / 2;
  const fh = 2.8;
  const units = Math.max(3, Math.floor(W / 4.6));
  const color = r.pick(SIDING);
  const snow = p.env.weather.state.snowCover;
  const top = 2 * fh + 0.3;
  if (W * s < 6) {
    p.rect(px(f, -half), py(f, top), px(f, half), py(f, 0), color);
    return;
  }
  wall(f, -half, half, 0, top, "siding", color);
  const unitW = (W - 3) / units;
  const lamps = p.light.lamps;
  let index = 0;
  for (let floor = 0; floor < 2; floor++) {
    const f0 = floor * fh + 0.3;
    for (let u = 0; u < units; u++) {
      const x = -half + 0.4 + unitW * u;
      index++;
      door(f, x + 0.6, r.pick(DOORS), false, f0);
      windowUnit(f, x + 1.4, x + 2.4, f0 + 1.3, f0 + 2.1, { index, frosted: true, lattice: true });
      windowUnit(f, x + 2.8, x + unitW - 0.4, f0 + 1.3, f0 + 2.1, {
        index: index + 50,
        lattice: true,
        sliding: true,
      });
      // Walkway light by each door.
      const lx = px(f, x + 1.1);
      const ly = py(f, f0 + 2.5);
      if (lamps > 0.1) {
        p.lightRect(lx, ly, lx + Math.max(1, 0.3 * s), ly + 1, [228, 240, 255], lamps);
        p.glow(lx, ly + 1, Math.max(3, 1.3 * s), [200, 220, 255], 0.3 * lamps);
      } else {
        p.rect(lx, ly, lx + Math.max(1, 0.3 * s), ly + 1, [230, 232, 230]);
      }
    }
  }
  // Upper walkway: slab and a solid parapet.
  const walkX1 = half - 2.6;
  p.rect(px(f, -half), py(f, fh + 0.3), px(f, walkX1), py(f, fh + 0.05), [150, 150, 146]);
  railing(
    f,
    -half,
    walkX1,
    fh + 0.3,
    fh + 1.35,
    r.pick(["#c9cfd4", "#e0dcd0", "#9aa4ac"].map(hex)),
    true,
  );
  // Steel stairs climbing at the end.
  const sx0 = walkX1;
  const sx1 = half;
  const stairColor: RGB = r.pick(["#6e7780", "#8a5a3c", "#4f5a52"].map(hex));
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const x = sx1 - (sx1 - sx0) * t0;
    const h = fh * t0 + 0.3;
    p.rect(px(f, x - (sx1 - sx0) / steps), py(f, h + fh / steps), px(f, x), py(f, h), stairColor);
  }
  const railTopA = py(f, 1.1);
  const railTopB = py(f, fh + 1.3);
  const steps2 = Math.max(4, Math.round((sx1 - sx0) * s));
  for (let k = 0; k <= steps2; k++) {
    const t = k / steps2;
    p.dot(px(f, sx1) - t * (sx1 - sx0) * s, railTopA + (railTopB - railTopA) * t, stairColor);
  }
  // A low metal roof.
  roof(f, -half - 0.4, half + 0.4, top, top + 0.8, 0, "metal", r.pick(METAL), {
    snow,
    ridgeCap: false,
  });
  eaveShadow(f, -half, half, top, 0.2);
}

/** A reinforced-concrete block of flats, balcony side. */
function drawMansion(p: Painter<Camera>, o: Scenery, r: Rng): void {
  const s = p.s;
  const f: Frame = { p, cx: p.x(o.along), s, seed: o.seed };
  const floors = r.int(3, 7);
  const fh = 2.9;
  const W = r.range(18, 34);
  const half = W / 2;
  const H = floors * fh + 0.8;
  const color = r.pick(CONCRETE);
  const unitW = r.range(3.8, 4.8);
  const units = Math.max(2, Math.round(W / unitW));
  const uw = W / units;
  const glassRail = r.chance(0.5);
  const snow = p.env.weather.state.snowCover;
  if (W * s < 6) {
    p.rect(px(f, -half), py(f, H), px(f, half), py(f, 0), color);
    for (let fl = 0; fl < floors; fl++) {
      for (let u = 0; u < units; u++) {
        if (p.windowLit(o.seed, fl * 50 + u)) {
          p.lightDot(
            px(f, -half + uw * (u + 0.5)),
            py(f, fl * fh + 1.5),
            p.windowColor(o.seed, fl * 50 + u),
            0.85,
          );
        }
      }
    }
    return;
  }
  wall(f, -half, half, 0, H, "concrete", color);
  for (let fl = 0; fl < floors; fl++) {
    const f0 = fl * fh + 0.5;
    for (let u = 0; u < units; u++) {
      const x0 = -half + uw * u;
      const index = fl * 50 + u;
      // Sliding doors onto the balcony, deep in shadow.
      p.rectAlpha(
        px(f, x0 + 0.15),
        py(f, f0 + 2.55),
        px(f, x0 + uw - 0.15),
        py(f, f0),
        [30, 34, 40],
        0.25,
      );
      windowUnit(f, x0 + 0.5, x0 + uw - 0.9, f0 + 0.1, f0 + 2.1, { index, sliding: true });
      if (s >= 3 && hash3(o.seed, index, 3) < 0.5) {
        acUnit(f, x0 + uw - 0.95, f0);
      }
      laundry(f, x0 + 0.3, x0 + uw - 0.3, f0, index);
      // Partition between balconies.
      p.rect(
        px(f, x0 + uw - 0.08),
        py(f, f0 + 2.4),
        px(f, x0 + uw + 0.02),
        py(f, f0),
        shadeRGB(color, 1.08),
      );
      if (p.light.lamps > 0.2 && hash3(o.seed, index, 4) < 0.25) {
        // A balcony light left on.
        p.lightDot(px(f, x0 + 0.4), py(f, f0 + 2.3), [255, 226, 180], 0.9);
      }
    }
    // Slab edge and the railing in front.
    p.rect(px(f, -half), py(f, f0 + 0.05), px(f, half), py(f, f0 - 0.2), shadeRGB(color, 1.1));
    if (glassRail) {
      p.rectAlpha(
        px(f, -half),
        py(f, f0 + 1.1),
        px(f, half),
        py(f, f0 + 0.05),
        [180, 196, 206],
        0.55,
      );
      p.rect(px(f, -half), py(f, f0 + 1.1), px(f, half), py(f, f0 + 1.1) + 1, [200, 204, 208]);
    } else {
      railing(f, -half, half, f0 + 0.05, f0 + 1.1, shadeRGB(color, 0.97), true);
    }
  }
  // Parapet, lift housing and water tank.
  p.rect(px(f, -half), py(f, H + 0.6), px(f, half), py(f, H), shadeRGB(color, 0.95));
  p.rect(
    px(f, -half),
    py(f, H + 0.6),
    px(f, half),
    py(f, H + 0.6) + 1,
    snow > 0.3 ? SNOW : shadeRGB(color, 1.1),
  );
  const lx = -half + W * r.range(0.15, 0.6);
  p.rect(px(f, lx), py(f, H + 3.2), px(f, lx + 3), py(f, H + 0.6), shadeRGB(color, 0.9));
  p.rect(px(f, lx + 3.5), py(f, H + 2.4), px(f, lx + 5.5), py(f, H + 0.6), [196, 200, 204]);
  if (p.light.lamps > 0.2 && floors >= 6) {
    const blink = 0.5 + 0.5 * Math.sin(p.time * 2.6 + o.seed);
    p.lightDot(px(f, lx + 1.5), py(f, H + 3.4), [255, 50, 40], blink);
  }
}

export function drawShop(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  if (r.chance(0.55)) {
    drawConvenienceStore(p, o, r);
  } else {
    drawCornerShop(p, o, r);
  }
}

/** A convenience store: a lit glass front with shelves inside and a sign on a pole. */
function drawConvenienceStore(p: Painter<Camera>, o: Scenery, r: Rng): void {
  const s = p.s;
  const f: Frame = { p, cx: p.x(o.along), s, seed: o.seed };
  const W = r.range(12, 15);
  const half = W / 2;
  const H = 4.4;
  const stripes = [r.pick(SIGNS), r.pick(SIGNS), r.pick(SIGNS)];
  const lamps = p.light.lamps;
  const open = 0.45 + 0.55 * lamps;
  wall(f, -half, half, 0, H, "concrete", [232, 232, 228]);
  // Fascia with three stripes, lit after dark.
  for (let i = 0; i < 3; i++) {
    const h1 = H - 0.12 - i * 0.25;
    p.rect(px(f, -half), py(f, h1), px(f, half), py(f, h1 - 0.25), stripes[i]);
    if (lamps > 0.1) {
      p.lightRect(px(f, -half), py(f, h1), px(f, half), py(f, h1 - 0.25), stripes[i], lamps * 0.8);
    }
  }
  // The shop floor seen through the glass.
  const g0 = 0.15;
  const g1 = 2.8;
  const a = Math.round(px(f, -half + 0.3));
  const b = Math.round(px(f, half - 0.3));
  const top = Math.round(py(f, g1));
  const bottom = Math.round(py(f, g0));
  p.lightRect(a, top, b, bottom, [240, 246, 250], open);
  if (s >= 2.5) {
    // Shelves of goods.
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = Math.round(py(f, 0.5 + shelf * 0.42));
      for (let x = a; x < b; x++) {
        if ((x - a) % Math.max(4, Math.round(3 * s)) < 1) {
          continue;
        }
        const c = SIGNS[Math.floor(hash3(o.seed, x - a, shelf) * SIGNS.length)];
        p.lightDot(x, y, mix(c, [255, 255, 255], 0.3), open * 0.8);
      }
    }
    // Ceiling lights.
    for (let x = -half + 1; x < half - 1; x += 2.2) {
      p.lightRect(
        px(f, x),
        py(f, g1 - 0.15),
        px(f, x + 1.2),
        py(f, g1 - 0.15) + 1,
        [255, 255, 255],
        open,
      );
    }
    // Mullions and the automatic door.
    for (let x = -half + 0.3; x <= half - 0.3; x += 2.4) {
      p.rect(px(f, x), top, px(f, x) + 1, bottom, [150, 154, 158]);
    }
    const dx = r.range(-half + 2, half - 3);
    p.rect(px(f, dx), top, px(f, dx + 1.8), top + 1, [150, 154, 158]);
    p.rect(px(f, dx + 0.9), top, px(f, dx + 0.9) + 1, bottom, [150, 154, 158]);
  }
  if (lamps > 0.1) {
    p.glow(f.cx, bottom, W * s * 0.7, [200, 220, 255], 0.3 * lamps);
  }
  // Pole sign.
  const sx = r.chance(0.5) ? -half - 1.5 : half + 1.5;
  p.rect(
    px(f, sx),
    py(f, 6.3),
    px(f, sx) + Math.max(1, Math.round(0.2 * s)),
    py(f, 0),
    [150, 152, 150],
  );
  p.rect(px(f, sx - 0.9), py(f, 7.5), px(f, sx + 1.1), py(f, 6.2), [240, 240, 236]);
  p.rect(px(f, sx - 0.9), py(f, 7.1), px(f, sx + 1.1), py(f, 6.8), stripes[0]);
  if (lamps > 0.1) {
    p.lightRect(
      px(f, sx - 0.9),
      py(f, 7.5),
      px(f, sx + 1.1),
      py(f, 6.2),
      [245, 248, 250],
      lamps * 0.7,
    );
    p.lightRect(px(f, sx - 0.9), py(f, 7.1), px(f, sx + 1.1), py(f, 6.8), stripes[0], lamps * 0.8);
  }
}

/** A family shop: shutters down at night, an awning and goods out by day, home upstairs. */
function drawCornerShop(p: Painter<Camera>, o: Scenery, r: Rng): void {
  const s = p.s;
  const f: Frame = { p, cx: p.x(o.along), s, seed: o.seed };
  const W = r.range(6.5, 9);
  const half = W / 2;
  const fh = 3.1;
  const H = 2 * fh + 0.3;
  const wallColor = r.pick(STUCCO);
  const snow = p.env.weather.state.snowCover;
  const hour = p.env.clock.hour;
  const open = hour > 9 && hour < 19.5;
  wall(f, -half, half, 0, H, r.pick<WallKind>(["stucco", "tile"]), wallColor);
  const a = Math.round(px(f, -half + 0.3));
  const b = Math.round(px(f, half - 0.3));
  const top = Math.round(py(f, 2.6));
  const bottom = Math.round(py(f, 0.05));
  if (open) {
    p.lightRect(a, top, b, bottom, [236, 230, 214], 0.55 + 0.4 * p.light.lamps);
    if (s >= 3) {
      for (let row = 0; row < 3; row++) {
        const y = Math.round(py(f, 0.5 + row * 0.6));
        for (let x = a + 1; x < b - 1; x++) {
          p.dot(x, y, SIGNS[Math.floor(hash3(o.seed, x - a, row) * SIGNS.length)]);
        }
      }
    }
  } else {
    // Rolled-down shutter.
    for (let y = top; y < bottom; y++) {
      p.rect(a, y, b, y + 1, (y - top) % 2 === 0 ? [170, 170, 166] : [146, 146, 142]);
    }
  }
  // Signboard and a striped awning.
  const sign = r.pick(SIGNS);
  p.rect(px(f, -half), py(f, fh + 0.2), px(f, half), py(f, 2.75), sign);
  if (s >= 3) {
    for (let i = 0; i < 4; i++) {
      const gx = -half + 1 + i * (W - 2) * 0.25;
      p.rect(px(f, gx), py(f, fh + 0.05), px(f, gx + 0.8), py(f, 2.9), [245, 245, 240]);
    }
  }
  const awning = r.pick(AWNINGS);
  for (let x = Math.round(px(f, -half - 0.2)); x < Math.round(px(f, half + 0.2)); x++) {
    const stripe = Math.floor((x - px(f, -half)) / Math.max(1, 0.5 * s)) % 2 === 0;
    p.rect(x, py(f, 2.75), x + 1, py(f, 2.35), stripe ? awning : [240, 238, 232]);
  }
  // Home upstairs.
  windowUnit(f, -half + 0.8, -half + 2.6, fh + 1.0, fh + 2.2, { index: 1, sliding: true });
  windowUnit(f, half - 2.6, half - 0.8, fh + 1.0, fh + 2.2, { index: 2, sliding: true });
  roof(f, -half - 0.3, half + 0.3, H, H + 1.2, 0.6, "kawara", r.pick(KAWARA), { snow });
  eaveShadow(f, -half, half, H, 0.2);
  if (s >= 3) {
    vendingMachine(p, o.along + half + 0.8, o.lateral, 0, o.seed, false);
  }
}

export function drawFactory(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const f: Frame = { p, cx: p.x(o.along), s, seed: o.seed };
  const W = r.range(26, 42);
  const half = W / 2;
  const H = r.range(7, 11);
  const wallColor = r.pick(["#9aa2a8", "#b4ada0", "#8f9aa0", "#c4c0b4"].map(hex));
  const snow = p.env.weather.state.snowCover;
  // Corrugated siding.
  const a = Math.round(px(f, -half));
  const b = Math.round(px(f, half));
  const top = Math.round(py(f, H));
  const bottom = Math.round(py(f, 0));
  for (let x = a; x < b; x++) {
    const u = (x - a) / s;
    const rib = s >= 2 && mod(u, 0.6) < 1 / s ? 0.84 : 1;
    // Rust streaks below the eaves.
    const rust = hash3(o.seed, Math.floor(u / 1.3), 5) < 0.2 ? 1 : 0;
    for (let y = top; y < bottom; y++) {
      const t = (y - top) / Math.max(1, bottom - top);
      let c = shadeRGB(wallColor, rib * (1.02 - t * 0.08));
      if (rust && t < 0.35) {
        c = mix(c, [140, 90, 60], (0.35 - t) * 0.8);
      }
      p.dot(x, y, c);
    }
  }
  // Clerestory windows; a few glow where the night shift is working.
  const shift = p.windowLit(o.seed, 1);
  let k = 0;
  for (let x = -half + 1; x < half - 2; x += 3, k++) {
    const wa = px(f, x);
    const wb = px(f, x + 2.2);
    if (shift && hash3(o.seed, k, 17) < 0.45) {
      p.lightRect(wa, py(f, H - 1.2), wb, py(f, H - 2.2), [240, 236, 214], 0.55);
    } else {
      p.rect(wa, py(f, H - 1.2), wb, py(f, H - 2.2), [70, 80, 92]);
    }
  }
  // Roller doors.
  const doors = Math.max(1, Math.floor(W / 12));
  for (let d = 0; d < doors; d++) {
    const dx = -half + ((d + 0.5) * W) / doors - 2;
    const dt = Math.round(py(f, 4.5));
    for (let y = dt; y < bottom; y++) {
      p.rect(
        px(f, dx),
        y,
        px(f, dx + 4),
        y + 1,
        (y - dt) % 2 === 0 ? [176, 178, 176] : [150, 152, 150],
      );
    }
  }
  // Sawtooth roof.
  const teeth = Math.max(2, Math.round(W / 7));
  for (let i = 0; i < teeth; i++) {
    const t0 = -half + (i * W) / teeth;
    roof(f, t0, t0 + W / teeth, H, H + 1.6, 0, "metal", shadeRGB(wallColor, 0.7), {
      snow,
      ridgeCap: false,
    });
  }
  // Company lettering.
  if (s >= 2) {
    for (let i = 0; i < 6; i++) {
      p.rect(
        px(f, -half + 2 + i * 1.3),
        py(f, H - 3.2),
        px(f, -half + 3 + i * 1.3),
        py(f, H - 4.2),
        [52, 66, 110],
      );
    }
  }
  if (r.chance(0.6)) {
    const chimneyX = px(f, -half + W * r.range(0.6, 0.85));
    const ch = r.range(24, 38);
    const cTop = Math.round(py(f, ch));
    const cw = Math.max(1, Math.round(1.6 * s));
    for (let y = cTop; y < top; y++) {
      const band = Math.floor((y - cTop) / Math.max(2, 2.5 * s)) % 2 === 0 && y - cTop < 6 * s;
      p.rect(chimneyX, y, chimneyX + cw, y + 1, band ? [196, 72, 60] : [200, 200, 196]);
    }
    const blink = 0.5 + 0.5 * Math.sin(p.time * 3 + o.seed);
    if (p.light.lamps > 0.2) {
      p.lightDot(chimneyX, cTop - 1, [255, 60, 50], blink * p.light.lamps);
      p.glow(chimneyX + 0.5, cTop - 0.5, 3, [255, 60, 50], 0.4 * blink * p.light.lamps);
    }
    for (let i = 0; i < 6; i++) {
      const age = (p.time * 0.25 + i / 6) % 1;
      const sx = chimneyX + cw / 2 + age * 10 * s + Math.sin(age * 5 + i) * s;
      const sy = cTop - 2 - age * 8 * s;
      p.discAlpha(sx, sy, (1 + age * 3) * Math.max(1, s * 0.8), [205, 205, 210], 0.22 * (1 - age));
    }
  }
}

export function drawBarn(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const f: Frame = { p, cx: p.x(o.along), s, seed: o.seed };
  const W = r.range(5, 9);
  const half = W / 2;
  const snow = p.env.weather.state.snowCover;
  wall(f, -half, half, 0, 2.8, "boards", r.pick(BOARDS));
  // An open bay, dark inside, with a glimpse of tools and straw.
  const bx = r.range(-half + 0.4, half - 2.4);
  p.rect(px(f, bx), py(f, 2.3), px(f, bx + 2), py(f, 0), [34, 30, 26]);
  if (s >= 3) {
    p.rect(px(f, bx + 0.2), py(f, 0.8), px(f, bx + 1.3), py(f, 0), [170, 140, 80]);
  }
  const tin = r.pick(["#8a4a36", "#4f6a86", "#6f6f68", "#6a4030"].map(hex));
  roof(f, -half - 0.4, half + 0.4, 2.8, 4.2, 0.2, "metal", tin, { snow, ridgeCap: false });
  // Rust.
  if (s >= 2) {
    for (let i = 0; i < 4; i++) {
      const x = -half + W * hash3(o.seed, i, 7);
      p.rectAlpha(px(f, x), py(f, 4.0), px(f, x + 0.5), py(f, 2.9), [120, 70, 40], 0.4);
    }
  }
}

export function drawVending(p: Painter<Camera>, o: Scenery): void {
  vendingMachine(p, o.along, o.lateral, 0, o.seed, false);
}

export function drawHighrise(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const f: Frame = { p, cx: p.x(o.along), s, seed: o.seed };
  const W = r.range(18, 50);
  const H = r.range(40, 150);
  const half = W / 2;
  const body = r.pick(["#7d8894", "#9aa3aa", "#b7b5ad", "#6e7a86", "#c9c6bd"].map(hex));
  const floorH = 3.8;
  const bay = r.range(1.6, 3);
  const a = Math.round(px(f, -half));
  const b = Math.max(a + 1, Math.round(px(f, half)));
  const top = Math.round(py(f, H));
  const bottom = Math.round(py(f, 0));
  const prob = p.light.lamps * 0.6;
  for (let y = top; y < bottom; y++) {
    // Height (m) of this pixel row; lit cells are whole windows, fixed to the building.
    const v = ((bottom - y - 0.5) / Math.max(1, bottom - top)) * H;
    const floor = Math.floor(v / floorH);
    const inFloor = mod(v, floorH) / floorH;
    const glassBand = inFloor > 0.25 && inFloor < 0.9;
    for (let x = a; x < b; x++) {
      const u = ((x + 0.5 - a) / Math.max(1, b - a)) * W;
      const cell = Math.floor(u / bay);
      const side = 1 - ((x - a) / Math.max(1, b - a)) * 0.15;
      let c = shadeRGB(body, side * (glassBand ? 0.72 : 1));
      if (glassBand && p.light.daylight > 0.2) {
        c = mix(c, mix(p.light.zenith, p.light.horizon, 0.6), 0.25 * p.light.daylight);
      }
      p.dot(x, y, c);
      if (glassBand && prob > 0.02 && hash3(o.seed, floor, cell) < prob) {
        const warm = hash3(o.seed, floor, cell + 999) < 0.5;
        p.lightDot(x, y, warm ? [255, 214, 150] : [220, 234, 255], 0.8);
      }
    }
  }
  // Crown.
  p.rect(a, top - 1, b, top, shadeRGB(body, 1.15));
  if (p.light.lamps > 0.2 && H > 60) {
    const blink = 0.5 + 0.5 * Math.sin(p.time * 2.6 + o.seed);
    p.lightDot(a, top - 2, [255, 50, 40], blink);
    p.lightDot(b - 1, top - 2, [255, 50, 40], blink);
  }
}

export function drawCluster(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const count = r.int(3, 9);
  const base = Math.round(p.y(0));
  const snow = p.env.weather.state.snowCover;
  for (let i = 0; i < count; i++) {
    const a = o.along + r.range(-35, 35);
    const w = Math.max(2, Math.round(r.range(6, 12) * s));
    const hgt = Math.max(1, Math.round(r.range(4, 8) * s));
    const x0 = Math.round(p.x(a));
    const wallC = r.pick(STUCCO);
    p.rect(x0, base - hgt, x0 + w, base, shadeRGB(wallC, 0.9));
    // A roof pitched to a point or a ridge.
    const rh = Math.max(1, Math.round(1.8 * s));
    const roofC = snow > 0.5 ? SNOW : r.pick(KAWARA);
    for (let k = 0; k < rh; k++) {
      const inset = Math.round((k / rh) * w * 0.3);
      p.rect(
        x0 + inset - (k === 0 ? 1 : 0),
        base - hgt - k - 1,
        x0 + w - inset + (k === 0 ? 1 : 0),
        base - hgt - k,
        roofC,
      );
    }
    if (p.windowLit(o.seed, i)) {
      p.lightDot(
        x0 + r.int(0, w - 1),
        base - 1 - r.int(0, Math.max(0, hgt - 2)),
        p.windowColor(o.seed, i),
        0.9,
      );
    }
  }
}

export function drawGreenhouse(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const len = r.range(16, 26);
  const h = 3.1;
  const cx = p.x(o.along);
  const xl = Math.round(cx - (len / 2) * s);
  const xr = Math.round(cx + (len / 2) * s);
  const base = Math.round(p.y(0));
  const top = Math.round(p.y(h));
  const lit = p.light.lamps > 0.3 && r.chance(0.1);
  for (let x = xl; x < xr; x++) {
    const t = (x + 0.5 - xl) / (xr - xl);
    // Rounded ends of the arched tunnel.
    const end = Math.min(t, 1 - t) * len;
    const k = end < 1.4 ? Math.sqrt(Math.max(0, 1 - ((1.4 - end) / 1.4) ** 2)) : 1;
    const colTop = Math.round(base - (base - top) * k);
    for (let y = colTop; y < base; y++) {
      if (lit) {
        p.lightRect(x, y, x + 1, y + 1, [255, 214, 150], 0.3);
      } else {
        p.rectAlpha(
          x,
          y,
          x + 1,
          y + 1,
          y === colTop ? [240, 244, 246] : [206, 214, 214],
          y === colTop ? 0.9 : 0.55,
        );
      }
    }
  }
  for (let x = xl; x < xr; x += Math.max(2, Math.round(1.3 * s))) {
    p.rectAlpha(x, top + 1, x + 1, base, [240, 240, 240], 0.35);
  }
}

export function drawShrine(p: Painter<Camera>, o: Scenery): void {
  p.at(o.lateral);
  const s = p.s;
  const cx = p.x(o.along);
  const vermilion: RGB = [206, 64, 40];
  const half = 2 * s;
  const base = Math.round(p.y(0));
  const top = Math.round(p.y(3.6));
  const post = Math.max(1, Math.round(0.35 * s));
  p.rect(cx - half, top, cx - half + post, base, vermilion);
  p.rect(cx + half - post, top, cx + half, base, vermilion);
  const beam = Math.round(p.y(3.0));
  p.rect(
    cx - half - 0.3 * s,
    beam,
    cx + half + 0.3 * s,
    beam + Math.max(1, Math.round(0.3 * s)),
    vermilion,
  );
  // The top beam (kasagi), black on top with upturned ends.
  p.rect(
    cx - half - 0.8 * s,
    top - Math.max(1, Math.round(0.35 * s)),
    cx + half + 0.8 * s,
    top,
    vermilion,
  );
  p.rect(
    cx - half - 0.9 * s,
    top - Math.max(1, Math.round(0.55 * s)),
    cx + half + 0.9 * s,
    top - Math.max(1, Math.round(0.35 * s)),
    [40, 36, 36],
  );
}

export function drawDryingRack(p: Painter<Camera>, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const len = r.range(8, 14);
  const cx = p.x(o.along);
  const xl = Math.round(cx - (len / 2) * s);
  const xr = Math.round(cx + (len / 2) * s);
  const base = Math.round(p.y(0));
  const tiers = r.int(2, 3);
  const straw: RGB = [206, 170, 92];
  for (let x = xl; x <= xr; x += Math.max(2, Math.round(2 * s))) {
    p.rect(x, Math.round(p.y(2.4)), x + 1, base, [96, 74, 52]);
  }
  for (let t = 0; t < tiers; t++) {
    const y0 = Math.round(p.y(2.2 - t * 0.7));
    const y1 = Math.round(p.y(1.6 - t * 0.7));
    for (let x = xl; x < xr; x++) {
      const v = hash3(o.seed, x - xl, t) * 0.2 + 0.9;
      p.rect(x, y0, x + 1, Math.max(y0 + 1, y1), [straw[0] * v, straw[1] * v, straw[2] * v]);
    }
  }
}
