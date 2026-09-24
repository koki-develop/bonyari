import { hex, mix, type RGB } from "../../core/color.ts";
import { clamp01, intervalCoverage, pulseCoverage, smoothstep } from "../../core/math.ts";
import { hash3, Rng } from "../../core/random.ts";
import type { Surface } from "../../core/surface.ts";
import type { Station } from "../../sim/route.ts";
import type { Train } from "../../sim/train.ts";
import { EYE_ABOVE_RAIL, type Camera } from "../camera.ts";
import type { Painter } from "../painter.ts";
import { vendingMachine } from "../scenery/facade.ts";
import type { Shade } from "../shade.ts";

export const PLATFORM_EDGE = 1.65;
export const PLATFORM_HEIGHT = 1.1;
export const PLATFORM_BACK = 7.6;
const CANOPY_HEIGHT = 4.3;
const CANOPY_BACK = 7.2;
const PILLAR_LATERAL = 5.2;
const PILLAR_SPACING = 12;
const TUBE: RGB = [236, 244, 255];
const CANOPY: RGB = [196, 194, 186];
const SURFACE: RGB = [176, 172, 164];
const TACTILE: RGB = [226, 186, 42];
const STATION_COLORS: readonly RGB[] = ["#2e7d5b", "#2f63a8", "#b44a3a", "#6a5a9a"].map(hex);

/** Hour-of-day crowd factor for platforms. */
function crowd(hour: number): number {
  const rush = Math.max(1 - Math.abs(hour - 8) / 2, 1 - Math.abs(hour - 18) / 2.5, 0);
  const day = hour > 6 && hour < 22 ? 0.35 : 0.08;
  return clamp01(day + rush * 0.65);
}

export function stationColor(station: Station): RGB {
  return STATION_COLORS[station.seed % STATION_COLORS.length];
}

/**
 * Platform surface, its edge face and the canopy overhead, cast per pixel
 * like the ground. Drawn before the things standing on the platform.
 */
export function drawPlatform(
  view: Surface,
  cam: Camera,
  shade: Shade,
  station: Station,
  lamps: number,
): void {
  const F = cam.focal;
  const eyeOverPlatform = EYE_ABOVE_RAIL - PLATFORM_HEIGHT;
  const eyeUnderCanopy = CANOPY_HEIGHT - EYE_ABOVE_RAIL;
  const band = stationColor(station);
  for (let y = 0; y < view.height; y++) {
    const dy = y + 0.5 - cam.horizon;
    for (let x = 0; x < view.width; x++) {
      const dx = x + 0.5 - cam.cx;
      if (dy > 0) {
        const z = (eyeOverPlatform * F) / dy;
        if (z >= PLATFORM_EDGE && z <= PLATFORM_BACK) {
          const along = cam.pos + (dx * z) / F;
          const foot = z / F + Math.abs(cam.travel);
          const cov = intervalCoverage(along, station.start, station.end, foot);
          if (cov > 0) {
            shade.at(z);
            const rowFoot = (z * z) / (eyeOverPlatform * F);
            let r = SURFACE[0];
            let g = SURFACE[1];
            let b = SURFACE[2];
            const tile = pulseCoverage(along, 0.9, 0.05, foot) * 0.25;
            r *= 1 - tile;
            g *= 1 - tile;
            b *= 1 - tile;
            const tactile = intervalCoverage(z, 2.45, 2.75, rowFoot);
            r += (TACTILE[0] - r) * tactile;
            g += (TACTILE[1] - g) * tactile;
            b += (TACTILE[2] - b) * tactile;
            const edge = intervalCoverage(z, PLATFORM_EDGE, 1.9, rowFoot);
            r += (214 - r) * edge;
            g += (212 - g) * edge;
            b += (204 - b) * edge;
            view.blend(x, y, shade.litR(r), shade.litG(g), shade.litB(b), cov);
          }
          continue;
        }
        if (z < PLATFORM_EDGE) {
          // Looking down at the platform's edge face.
          const h = EYE_ABOVE_RAIL - (dy * PLATFORM_EDGE) / F;
          if (h >= -0.2 && h <= PLATFORM_HEIGHT) {
            const along = cam.pos + (dx * PLATFORM_EDGE) / F;
            const cov = intervalCoverage(
              along,
              station.start,
              station.end,
              PLATFORM_EDGE / F + Math.abs(cam.travel),
            );
            if (cov > 0) {
              shade.at(PLATFORM_EDGE);
              const lip = h > PLATFORM_HEIGHT - 0.12 ? 1.5 : h > PLATFORM_HEIGHT - 0.3 ? 0.55 : 0.8;
              view.blend(
                x,
                y,
                shade.litR(92 * lip),
                shade.litG(90 * lip),
                shade.litB(86 * lip),
                cov,
              );
            }
          }
        }
        continue;
      }
      // Canopy underside above the platform.
      const up = -dy;
      if (up <= 0) {
        continue;
      }
      const z = (eyeUnderCanopy * F) / up;
      if (z < PLATFORM_EDGE - 0.3) {
        // The canopy's front fascia.
        const h = EYE_ABOVE_RAIL + (up * (PLATFORM_EDGE - 0.3)) / F;
        if (h >= CANOPY_HEIGHT && h <= CANOPY_HEIGHT + 0.55) {
          const along = cam.pos + (dx * (PLATFORM_EDGE - 0.3)) / F;
          const cov = intervalCoverage(
            along,
            station.start + 8,
            station.end - 8,
            (PLATFORM_EDGE - 0.3) / F + Math.abs(cam.travel),
          );
          if (cov > 0) {
            shade.at(PLATFORM_EDGE);
            const c = h > CANOPY_HEIGHT + 0.4 ? [210, 210, 206] : band;
            view.blend(x, y, shade.litR(c[0]), shade.litG(c[1]), shade.litB(c[2]), cov);
          }
        }
        continue;
      }
      if (z > CANOPY_BACK) {
        continue;
      }
      const along = cam.pos + (dx * z) / F;
      const foot = z / F + Math.abs(cam.travel);
      const cov = intervalCoverage(along, station.start + 8, station.end - 8, foot);
      if (cov <= 0) {
        continue;
      }
      shade.at(z);
      const rowFoot = (z * z) / (eyeUnderCanopy * F);
      const beam = pulseCoverage(along, 6, 0.25, foot) * 0.3;
      let r = shade.litR(CANOPY[0] * (1 - beam));
      let g = shade.litG(CANOPY[1] * (1 - beam));
      let b = shade.litB(CANOPY[2] * (1 - beam));
      const tube =
        (intervalCoverage(z, 3.0, 3.18, rowFoot) + intervalCoverage(z, 5.6, 5.78, rowFoot)) *
        pulseCoverage(along, 5, 1.25, foot) *
        (0.35 + 0.65 * lamps);
      r += (TUBE[0] - r) * tube;
      g += (TUBE[1] - g) * tube;
      b += (TUBE[2] - b) * tube;
      view.blend(x, y, r, g, b, cov);
    }
  }
  // Soft glow from the tubes onto the platform at night.
  if (lamps > 0.2) {
    for (let along = Math.ceil((station.start + 8) / 5) * 5; along < station.end - 8; along += 5) {
      for (const lat of [3.1, 5.7]) {
        const gx = cam.x(along + 0.6, lat);
        if (gx < -20 || gx > view.width + 20) {
          continue;
        }
        view.glow(
          gx,
          cam.yRail(lat, CANOPY_HEIGHT),
          6 * cam.scale(lat) * 0.2 + 3,
          [200, 214, 235],
          0.28 * lamps,
        );
      }
    }
  }
}

export function drawPillars(view: Surface, cam: Camera, shade: Shade, station: Station): void {
  const lateral = PILLAR_LATERAL;
  shade.at(lateral);
  const footprint = cam.footprint(lateral);
  const top = cam.yRail(lateral, CANOPY_HEIGHT);
  const bottom = cam.yRail(lateral, PLATFORM_HEIGHT);
  const r = shade.litR(186);
  const g = shade.litG(184);
  const b = shade.litB(178);
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral);
    const cov =
      pulseCoverage(along - station.start - 6, PILLAR_SPACING, 0.34, footprint) *
      intervalCoverage(along, station.start + 8, station.end - 8, footprint);
    if (cov <= 0.01) {
      continue;
    }
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(view.height, Math.ceil(bottom)); y++) {
      view.blend(x, y, r, g, b, cov);
    }
  }
}

/** The fence at the back of the platform. */
export function drawPlatformBack(view: Surface, cam: Camera, shade: Shade, station: Station): void {
  const lateral = PLATFORM_BACK;
  shade.at(lateral);
  const footprint = cam.footprint(lateral);
  const top = cam.yRail(lateral, PLATFORM_HEIGHT + 1.2);
  const bottom = cam.yRail(lateral, PLATFORM_HEIGHT);
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral);
    const inside = intervalCoverage(along, station.start, station.end, footprint);
    if (inside <= 0) {
      continue;
    }
    const post = pulseCoverage(along, 2.2, 0.12, footprint);
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(view.height, Math.ceil(bottom)); y++) {
      const rail = y === Math.floor(top) || y === Math.floor((top + bottom) / 2) ? 1 : post;
      const mesh = 0.3 + 0.7 * rail;
      view.blend(x, y, shade.litR(120), shade.litG(126), shade.litB(130), inside * mesh);
    }
  }
}

export type PlatformItemKind =
  | "bench"
  | "vending"
  | "sign"
  | "bin"
  | "clock"
  | "person"
  | "building";

export interface PlatformItem {
  kind: PlatformItemKind;
  station: Station;
  along: number;
  lateral: number;
  seed: number;
  /** For people: whether they board our train when the doors open. */
  boards: boolean;
  /** For people: walking speed along the platform (m/s), 0 = standing. */
  walk: number;
}

/** Furniture, the station building and people for a station. */
export function platformItems(station: Station, hour: number): PlatformItem[] {
  const r = new Rng(station.seed);
  const items: PlatformItem[] = [];
  const add = (kind: PlatformItemKind, along: number, lateral: number, boards = false, walk = 0) =>
    items.push({ kind, station, along, lateral, seed: r.int(0, 1 << 30), boards, walk });
  const len = station.end - station.start;
  add("building", station.start + len * r.range(0.3, 0.7), 16 + station.size * 6);
  add("sign", station.stop + r.range(12, 25) * (r.chance(0.5) ? 1 : -1), 6.1);
  for (let a = station.start + 14; a < station.end - 14; a += r.range(16, 30)) {
    const roll = r.next();
    if (roll < 0.45) {
      add("bench", a, 6.6);
    } else if (roll < 0.62) {
      add("vending", a, 7.0);
    } else if (roll < 0.8) {
      add("bin", a, 6.8);
    }
  }
  add("clock", station.stop + r.range(-30, 30), 3.4);
  const people = Math.round((2 + station.size * 10) * crowd(hour) * r.range(0.6, 1.2));
  for (let i = 0; i < people; i++) {
    const boards = r.chance(0.45);
    const walk = !boards && r.chance(0.25) ? r.range(-1.2, 1.2) : 0;
    add("person", station.stop + r.range(-45, 45), r.range(3.2, 6.2), boards, walk);
  }
  return items;
}

const CLOTHES: readonly RGB[] = [
  "#2d3340",
  "#5a4636",
  "#7b2f35",
  "#39527a",
  "#d8d2c4",
  "#4d6048",
  "#9a8a70",
  "#1f1f24",
].map(hex);
const HAIR: readonly RGB[] = ["#1c1a1a", "#2e2420", "#4a3a2e", "#8a8680"].map(hex);
const SKIN: RGB = [226, 190, 160];
/** Sorted-waste bins: cans, bottles, burnables. */
const BINS: readonly RGB[] = [
  [64, 110, 170],
  [60, 140, 90],
  [200, 80, 60],
];

/**
 * Where a person is now. Boarding passengers walk to the nearest door once
 * the doors open and are gone after we leave.
 */
function personPosition(
  item: PlatformItem,
  train: Train,
  time: number,
): { along: number; lateral: number; visible: boolean; moving: boolean } {
  const atThisStation =
    train.station === item.station ||
    (train.phase === "stopped" && Math.abs(train.pos - item.station.stop) < 1);
  let along = item.along + item.walk * time;
  // Walkers pace back and forth within the platform.
  if (item.walk !== 0) {
    const span = item.station.end - item.station.start - 30;
    const u = (((along - item.station.start - 15) % (2 * span)) + 2 * span) % (2 * span);
    along = item.station.start + 15 + (u < span ? u : 2 * span - u);
  }
  if (!item.boards) {
    return { along, lateral: item.lateral, visible: true, moving: item.walk !== 0 };
  }
  const passed = train.pos > item.station.stop + 1 && !atThisStation;
  if (passed) {
    return { along, lateral: item.lateral, visible: false, moving: false };
  }
  if (train.phase === "stopped" && atThisStation && train.dwell > 2.5) {
    // Head for the door of the car nearest to them (doors every 20 m, ours at +6 m).
    const door = train.pos + 6 + Math.round((item.along - train.pos - 6) / 20) * 20;
    const t = clamp01((train.dwell - 2.5 - hash3(item.seed, 1, 1) * 6) / 6);
    const a = item.along + (door - item.along) * smoothstep(0, 0.6, t);
    const lat = item.lateral + (PLATFORM_EDGE + 0.2 - item.lateral) * smoothstep(0.5, 1, t);
    return { along: a, lateral: lat, visible: t < 1, moving: t > 0 && t < 1 };
  }
  return { along, lateral: item.lateral, visible: true, moving: false };
}

export function itemLateral(item: PlatformItem, train: Train, time: number): number {
  return item.kind === "person" ? personPosition(item, train, time).lateral : item.lateral;
}

export function drawPlatformItem(p: Painter, item: PlatformItem, train: Train, time: number): void {
  const r = new Rng(item.seed);
  const lamps = p.light.lamps;
  switch (item.kind) {
    case "person": {
      const pos = personPosition(item, train, time);
      if (!pos.visible) {
        return;
      }
      p.at(pos.lateral);
      const s = p.s;
      const cx = p.x(pos.along);
      const h = r.range(1.55, 1.8);
      const coat = r.pick(CLOTHES);
      const legs = r.pick(CLOTHES);
      const hair = r.pick(HAIR);
      const floor = p.cam.yRail(pos.lateral, PLATFORM_HEIGHT);
      const w = Math.max(1, Math.round(0.42 * s));
      const step = pos.moving ? Math.round(Math.sin(time * 7 + item.seed) * 0.12 * s) : 0;
      const hip = p.cam.yRail(pos.lateral, PLATFORM_HEIGHT + h * 0.47);
      const shoulder = p.cam.yRail(pos.lateral, PLATFORM_HEIGHT + h * 0.82);
      const headTop = p.cam.yRail(pos.lateral, PLATFORM_HEIGHT + h);
      const x0 = Math.round(cx - w / 2);
      // Legs.
      p.rect(x0 + step, hip, x0 + Math.max(1, w / 2) + step, floor, legs);
      p.rect(x0 + w / 2 - step, hip, x0 + w - step, floor, mix(legs, [0, 0, 0], 0.15));
      // Coat.
      p.rect(
        x0 - (s > 6 ? 1 : 0),
        shoulder,
        x0 + w + (s > 6 ? 1 : 0),
        hip + Math.max(1, 0.1 * s),
        coat,
      );
      // Head.
      const hw = Math.max(1, Math.round(0.2 * s));
      p.rect(cx - hw / 2, headTop, cx + hw / 2, shoulder, SKIN);
      p.rect(
        cx - hw / 2,
        headTop,
        cx + hw / 2,
        headTop + Math.max(1, (shoulder - headTop) * 0.45),
        hair,
      );
      if (lamps > 0.3 && r.chance(0.4) && !pos.moving) {
        // Looking at a phone.
        p.lightDot(cx + hw / 2, (shoulder + hip) / 2 - 1, [200, 225, 255], 0.9);
      }
      return;
    }
    case "bench": {
      p.at(item.lateral);
      const s = p.s;
      const cx = p.x(item.along);
      const seat = p.cam.yRail(item.lateral, PLATFORM_HEIGHT + 0.45);
      const back = p.cam.yRail(item.lateral, PLATFORM_HEIGHT + 0.85);
      const floor = p.cam.yRail(item.lateral, PLATFORM_HEIGHT);
      const w = 1.8 * s;
      const color = r.pick(["#c85a3a", "#3a78b8", "#e0c040"].map(hex));
      p.rect(cx - w / 2, back, cx + w / 2, back + Math.max(1, 0.2 * s), color);
      p.rect(cx - w / 2, seat, cx + w / 2, seat + Math.max(1, 0.12 * s), color);
      p.rect(cx - w / 2 + 1, seat, cx - w / 2 + 2, floor, [90, 90, 94]);
      p.rect(cx + w / 2 - 2, seat, cx + w / 2 - 1, floor, [90, 90, 94]);
      return;
    }
    case "vending":
      vendingMachine(p, item.along, item.lateral, PLATFORM_HEIGHT, item.seed, true);
      return;
    case "bin": {
      p.at(item.lateral);
      const s = p.s;
      const cx = p.x(item.along);
      const top = p.cam.yRail(item.lateral, PLATFORM_HEIGHT + 0.9);
      const floor = p.cam.yRail(item.lateral, PLATFORM_HEIGHT);
      for (let i = 0; i < 3; i++) {
        const x0 = cx + (i - 1.5) * 0.5 * s;
        p.rect(x0, top, x0 + 0.45 * s, floor, BINS[i]);
      }
      return;
    }
    case "clock": {
      p.at(item.lateral);
      const s = p.s;
      const cx = p.x(item.along);
      const cy = p.cam.yRail(item.lateral, 3.4);
      const rad = Math.max(2, 0.3 * s);
      p.rect(cx - 0.5, p.cam.yRail(item.lateral, 4.3), cx + 0.5, cy - rad, [90, 90, 94]);
      for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
        for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (d <= rad) {
            p.dot(x, y, d > rad - 1 ? [70, 70, 74] : [242, 242, 236]);
          }
        }
      }
      // Hands show the in-world time.
      const hour = p.world.clock.hour;
      const hands: [number, number][] = [
        [(hour % 12) / 12, 0.5],
        [(hour % 1) / 1, 0.8],
      ];
      for (const [f, len] of hands) {
        const a = f * Math.PI * 2;
        for (let k = 0; k <= rad * len; k += 0.5) {
          p.dot(cx + Math.sin(a) * k, cy - Math.cos(a) * k, [30, 30, 34]);
        }
      }
      return;
    }
    case "sign": {
      p.at(item.lateral);
      const s = p.s;
      const cx = p.x(item.along);
      const top = p.cam.yRail(item.lateral, PLATFORM_HEIGHT + 2.3);
      const bottom = p.cam.yRail(item.lateral, PLATFORM_HEIGHT + 1.35);
      const floor = p.cam.yRail(item.lateral, PLATFORM_HEIGHT);
      const w = 2.4 * s;
      p.rect(cx - w / 2 + 1, bottom, cx - w / 2 + 2, floor, [110, 110, 114]);
      p.rect(cx + w / 2 - 2, bottom, cx + w / 2 - 1, floor, [110, 110, 114]);
      p.rect(cx - w / 2, top, cx + w / 2, bottom, [244, 244, 240]);
      if (lamps > 0.2) {
        p.lightRect(cx - w / 2, top, cx + w / 2, bottom, [250, 250, 246], 0.6 * lamps);
      }
      const band = stationColor(item.station);
      const bandY = top + (bottom - top) * 0.72;
      p.rect(cx - w / 2, bandY, cx + w / 2, bandY + Math.max(1, 0.12 * s), band);
      // The station name, as seen from a moving train: bold strokes.
      const glyphs = 3 + (item.station.seed % 3);
      const gw = Math.max(1, Math.round(0.36 * s));
      const gy0 = Math.round(top + (bottom - top) * 0.18);
      const gy1 = Math.round(top + (bottom - top) * 0.6);
      for (let i = 0; i < glyphs; i++) {
        const gx = Math.round(cx - (glyphs * gw * 1.3) / 2 + i * gw * 1.3);
        for (let y = gy0; y < gy1; y++) {
          for (let x = gx; x < gx + gw; x++) {
            if (hash3(item.station.seed + i, x - gx, y - gy0) < 0.55) {
              p.dot(x, y, [30, 34, 40]);
            }
          }
        }
      }
      return;
    }
    case "building": {
      p.at(item.lateral);
      const s = p.s;
      const cx = p.x(item.along);
      const big = item.station.size > 0.6;
      const w = (big ? 40 : 14) * s;
      const h = big ? 9 : 4.5;
      const base = p.y(0);
      const top = p.y(h);
      const wall: RGB = big ? [206, 204, 198] : [176, 150, 118];
      p.rect(cx - w / 2, top, cx + w / 2, base, wall);
      const roofTop = p.y(h + (big ? 0.6 : 1.8));
      p.rect(
        cx - w / 2 - s * 0.5,
        roofTop,
        cx + w / 2 + s * 0.5,
        top,
        big ? [120, 124, 130] : [70, 74, 84],
      );
      const windows = Math.max(2, Math.floor(w / (2.4 * s)));
      for (let i = 0; i < windows; i++) {
        const wx = cx - w / 2 + ((i + 0.5) / windows) * w;
        const y0 = p.y(h * 0.7);
        const y1 = p.y(h * 0.3);
        if (lamps > 0.2) {
          p.lightRect(wx - s * 0.6, y0, wx + s * 0.6, y1, [255, 232, 190], 0.9 * lamps);
        } else {
          p.rect(wx - s * 0.6, y0, wx + s * 0.6, y1, [70, 80, 92]);
        }
      }
      return;
    }
  }
}
