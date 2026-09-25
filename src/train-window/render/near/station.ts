import { hex, mix, type RGB, scale } from "../../../shared/core/color.ts";
import { clamp01, intervalCoverage, pulseCoverage } from "../../../shared/core/math.ts";
import { hash3, Rng } from "../../../shared/core/random.ts";
import type { Surface } from "../../../shared/core/surface.ts";
import type { Station } from "../../sim/route.ts";
import { EYE_ABOVE_RAIL, type Camera } from "../camera.ts";
import type { Cover } from "../../../shared/render/cover.ts";
import type { Painter } from "../../../shared/render/painter.ts";
import { vendingMachine } from "../scenery/facade.ts";
import { drawPerson } from "./people.ts";
import type { Shade } from "../../../shared/render/shade.ts";

export const PLATFORM_EDGE = 1.65;
export const PLATFORM_HEIGHT = 1.1;
export const PLATFORM_BACK = 7.6;
export const CANOPY_HEIGHT = 4.3;
const CANOPY_BACK = 7.2;
const PILLAR_LATERAL = 5.2;
const PILLAR_SPACING = 12;
const TUBE: RGB = [236, 244, 255];
const CANOPY: RGB = [196, 194, 186];
const SURFACE: RGB = [176, 172, 164];
const TACTILE: RGB = [226, 186, 42];
const STATION_COLORS: readonly RGB[] = ["#2e7d5b", "#2f63a8", "#b44a3a", "#6a5a9a"].map(hex);

/** Rows of glyph-like strokes: text too small to read from a moving train. */
function pseudoText(
  p: Painter<Camera>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: RGB,
  seed: number,
): void {
  const a = Math.round(x0);
  const b = Math.round(x1);
  const top = Math.round(y0);
  const bottom = Math.max(top + 1, Math.round(y1));
  for (let x = a; x < b; x++) {
    // Gaps between characters.
    if ((x - a) % 4 === 3) {
      continue;
    }
    for (let y = top; y < bottom; y++) {
      if (hash3(seed, x - a, y - top) < 0.5) {
        p.dot(x, y, ink);
      }
    }
  }
}

/** Like `pseudoText`, in emissive LED dots. */
function pseudoTextLit(
  p: Painter<Camera>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: RGB,
  seed: number,
): void {
  const a = Math.round(x0);
  const b = Math.round(x1);
  const top = Math.round(y0);
  const bottom = Math.max(top + 1, Math.round(y1));
  for (let x = a; x < b; x++) {
    if ((x - a) % 4 === 3) {
      continue;
    }
    for (let y = top; y < bottom; y++) {
      if (hash3(seed, x - a, y - top) < 0.55) {
        p.lightDot(x, y, ink, 1);
      }
    }
  }
}

/** Hour-of-day crowd factor for platforms. */
function crowd(hour: number): number {
  const rush = Math.max(1 - Math.abs(hour - 8) / 2, 1 - Math.abs(hour - 18) / 2.5, 0);
  const day = hour > 6 && hour < 22 ? 0.35 : 0.08;
  return clamp01(day + rush * 0.65);
}

export function stationColor(station: Station): RGB {
  return STATION_COLORS[station.seed % STATION_COLORS.length];
}

/** What a pixel's ray meets at a platform. */
type PlatformPart = "none" | "floor" | "edgeFace" | "fascia" | "canopy";

/** The part of the platform a pixel's ray meets, with where and how fully. */
interface PlatformHit {
  part: PlatformPart;
  /** Coverage of the pixel along the track. */
  cov: number;
  /** Lateral distance (m) and along-track position of the hit. */
  z: number;
  along: number;
  /** Blur footprint (m) along the track at the hit. */
  foot: number;
  /** Height (m above the rails) of the hit on a vertical face. */
  h: number;
}

const HIT: PlatformHit = { part: "none", cov: 0, z: 0, along: 0, foot: 0, h: 0 };

/**
 * Casts pixel (x, y) at the platform surface, its edge face, the canopy's
 * fascia and its underside. Shared by the drawing and the occlusion so both
 * agree on every pixel.
 */
function platformHit(
  cam: Camera,
  station: Station,
  x: number,
  y: number,
  out: PlatformHit,
): PlatformHit {
  const F = cam.focal;
  const dy = y + 0.5 - cam.horizon;
  const dx = x + 0.5 - cam.cx;
  out.part = "none";
  out.cov = 0;
  if (dy > 0) {
    const z = ((EYE_ABOVE_RAIL - PLATFORM_HEIGHT) * F) / dy;
    if (z >= PLATFORM_EDGE && z <= PLATFORM_BACK) {
      const along = cam.pos + (dx * z) / F;
      const foot = z / F + Math.abs(cam.travel);
      out.part = "floor";
      out.cov = intervalCoverage(along, station.start, station.end, foot);
      out.z = z;
      out.along = along;
      out.foot = foot;
      return out;
    }
    if (z < PLATFORM_EDGE) {
      // Looking down at the platform's edge face.
      const h = EYE_ABOVE_RAIL - (dy * PLATFORM_EDGE) / F;
      if (h >= -0.2 && h <= PLATFORM_HEIGHT) {
        const along = cam.pos + (dx * PLATFORM_EDGE) / F;
        out.part = "edgeFace";
        out.cov = intervalCoverage(
          along,
          station.start,
          station.end,
          PLATFORM_EDGE / F + Math.abs(cam.travel),
        );
        out.h = h;
        out.along = along;
      }
    }
    return out;
  }
  const up = -dy;
  if (up <= 0) {
    return out;
  }
  const z = ((CANOPY_HEIGHT - EYE_ABOVE_RAIL) * F) / up;
  if (z < PLATFORM_EDGE - 0.3) {
    // The canopy's front fascia.
    const h = EYE_ABOVE_RAIL + (up * (PLATFORM_EDGE - 0.3)) / F;
    if (h >= CANOPY_HEIGHT && h <= CANOPY_HEIGHT + 0.55) {
      const along = cam.pos + (dx * (PLATFORM_EDGE - 0.3)) / F;
      out.part = "fascia";
      out.cov = intervalCoverage(
        along,
        station.start + 8,
        station.end - 8,
        (PLATFORM_EDGE - 0.3) / F + Math.abs(cam.travel),
      );
      out.h = h;
      out.along = along;
    }
    return out;
  }
  if (z > CANOPY_BACK) {
    return out;
  }
  const along = cam.pos + (dx * z) / F;
  const foot = z / F + Math.abs(cam.travel);
  out.part = "canopy";
  out.cov = intervalCoverage(along, station.start + 8, station.end - 8, foot);
  out.z = z;
  out.along = along;
  out.foot = foot;
  return out;
}

/** Columns [from, to] of a row that can meet the platform; empty when from > to. */
const ROW_SPAN = { from: 0, to: -1 };

/**
 * Which columns of row `y` can meet the platform at all. The part a ray meets
 * depends on the row alone, and along the row the hit moves steadily along
 * the track, so only the columns over the station (plus a margin for the
 * blur and rounding) need casting.
 */
function platformRow(cam: Camera, station: Station, y: number, width: number): typeof ROW_SPAN {
  const hit = platformHit(cam, station, 0, y, HIT);
  ROW_SPAN.from = 0;
  ROW_SPAN.to = -1;
  if (hit.part === "none") {
    return ROW_SPAN;
  }
  // Lateral distance of the hit, and how far along the track one column moves it.
  const z =
    hit.part === "floor" || hit.part === "canopy"
      ? hit.z
      : hit.part === "edgeFace"
        ? PLATFORM_EDGE
        : PLATFORM_EDGE - 0.3;
  const perColumn = z / cam.focal;
  const margin = perColumn + Math.abs(cam.travel) + 1;
  const x0 = cam.cx - 0.5 + (station.start - margin - cam.pos) / perColumn;
  const x1 = cam.cx - 0.5 + (station.end + margin - cam.pos) / perColumn;
  ROW_SPAN.from = Math.max(0, Math.floor(x0) - 1);
  ROW_SPAN.to = Math.min(width - 1, Math.ceil(x1) + 1);
  return ROW_SPAN;
}

/** Marks the pixels a platform's surface, edge and canopy paint over opaquely. */
export function coverPlatform(cam: Camera, station: Station, cover: Cover): void {
  for (let y = 0; y < cover.height; y++) {
    const { from, to } = platformRow(cam, station, y, cover.width);
    for (let x = from; x <= to; x++) {
      if (platformHit(cam, station, x, y, HIT).cov >= 1) {
        cover.mark(x, y, PLATFORM_BACK);
      }
    }
  }
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
  const eyeOverPlatform = EYE_ABOVE_RAIL - PLATFORM_HEIGHT;
  const eyeUnderCanopy = CANOPY_HEIGHT - EYE_ABOVE_RAIL;
  const band = stationColor(station);
  for (let y = 0; y < view.height; y++) {
    const { from, to } = platformRow(cam, station, y, view.width);
    for (let x = from; x <= to; x++) {
      const hit = platformHit(cam, station, x, y, HIT);
      const cov = hit.cov;
      if (cov <= 0) {
        continue;
      }
      switch (hit.part) {
        case "floor": {
          const { z, along, foot } = hit;
          shade.at(z);
          const rowFoot = (z * z) / (eyeOverPlatform * cam.focal);
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
          break;
        }
        case "edgeFace": {
          shade.at(PLATFORM_EDGE);
          const h = hit.h;
          const lip = h > PLATFORM_HEIGHT - 0.12 ? 1.5 : h > PLATFORM_HEIGHT - 0.3 ? 0.55 : 0.8;
          view.blend(x, y, shade.litR(92 * lip), shade.litG(90 * lip), shade.litB(86 * lip), cov);
          break;
        }
        case "fascia": {
          shade.at(PLATFORM_EDGE);
          const c = hit.h > CANOPY_HEIGHT + 0.4 ? [210, 210, 206] : band;
          view.blend(x, y, shade.litR(c[0]), shade.litG(c[1]), shade.litB(c[2]), cov);
          break;
        }
        case "canopy": {
          const { z, along, foot } = hit;
          shade.at(z);
          const rowFoot = (z * z) / (eyeUnderCanopy * cam.focal);
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
          break;
        }
      }
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
  | "sitter"
  | "building"
  | "stairs"
  | "waitingRoom"
  | "departureBoard"
  | "hangingSign"
  | "adBoard"
  | "timetable"
  | "extinguisher"
  | "planter";

export interface PlatformItem {
  kind: PlatformItemKind;
  station: Station;
  along: number;
  lateral: number;
  seed: number;
  /** Along-track length (m) for structures that span a stretch of platform. */
  length: number;
}

/**
 * Everything on a platform: stairs, a waiting room, signs and boards under the
 * canopy, adverts on the fence, furniture and people. Larger stations get more.
 */
export function platformItems(station: Station, hour: number): PlatformItem[] {
  const r = new Rng(station.seed);
  const items: PlatformItem[] = [];
  const add = (kind: PlatformItemKind, along: number, lateral: number, length = 0) =>
    items.push({ kind, station, along, lateral, seed: r.int(0, 1 << 30), length });
  const start = station.start + 10;
  const end = station.end - 10;
  const len = end - start;
  const big = station.size > 0.5;
  // Stretches already taken on the back half of the platform.
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => taken.every(([x, y]) => b < x || a > y);
  const take = (a: number, b: number) => taken.push([a, b]);

  add(
    "building",
    station.start + (station.end - station.start) * r.range(0.3, 0.7),
    16 + station.size * 6,
  );

  // Stairs down to the underpass (or up to the footbridge), with exit signs above.
  const stairs = big ? 2 : 1;
  for (let i = 0; i < stairs; i++) {
    const at =
      start +
      len *
        (stairs === 1 ? r.range(0.35, 0.65) : i === 0 ? r.range(0.15, 0.35) : r.range(0.65, 0.85));
    const length = r.range(11, 14);
    add("stairs", at, 5.0, length);
    take(at - 2, at + length + 2);
    add("hangingSign", at - 1.5, 3.9, 0);
    if (big) {
      add("departureBoard", at + length * 0.5, 3.3);
    }
  }
  if (station.size > 0.2 && r.chance(big ? 0.9 : 0.5)) {
    const length = r.range(4.5, 6.5);
    for (let tries = 0; tries < 8; tries++) {
      const at = r.range(start, end - length);
      if (free(at - 1, at + length + 1)) {
        add("waitingRoom", at, 6.0, length);
        take(at - 1, at + length + 1);
        break;
      }
    }
  }
  const sign = station.stop + r.range(12, 25) * (r.chance(0.5) ? 1 : -1);
  add("sign", sign, 6.1);
  take(sign - 2, sign + 2);

  // Along the back of the platform: benches (often in pairs), vending machines,
  // bins, planters and a timetable; adverts on the fence behind them.
  for (let a = start; a < end - 2; a += r.range(4.5, 8)) {
    if (!free(a - 1.2, a + 1.2)) {
      continue;
    }
    const roll = r.next();
    if (roll < 0.34) {
      add("bench", a, 6.6);
      if (r.chance(0.35 * crowd(hour) + 0.08)) {
        add("sitter", a + r.range(-0.5, 0.5), 6.35);
      }
    } else if (roll < 0.46) {
      add("vending", a, 7.0);
      if (r.chance(0.4)) {
        add("vending", a + 1.15, 7.0);
        a += 1.2;
      }
    } else if (roll < 0.58) {
      add("bin", a, 6.8);
    } else if (roll < 0.66) {
      add(station.size < 0.4 ? "planter" : "timetable", a, 6.9);
    } else if (roll < 0.72 && station.size < 0.5) {
      add("planter", a, 7.0);
    }
    take(a - 1.2, a + 1.2);
  }
  for (let a = start + 3; a < end - 3; a += r.range(9, 16)) {
    if (r.chance(big ? 0.7 : 0.4)) {
      add("adBoard", a, 7.55);
    }
  }
  // Hanging signs under the canopy, and a fire extinguisher at some pillars.
  for (let a = start + 12; a < end - 12; a += r.range(24, 40)) {
    add("hangingSign", a, 3.9);
  }
  for (let pillar = station.start + 18; pillar < end - 6; pillar += 12) {
    if (r.chance(0.3)) {
      add("extinguisher", pillar + 0.4, 5.0);
    }
  }
  add("clock", station.stop + r.range(-30, 30), 3.4);

  const people = Math.round((3 + station.size * 14) * crowd(hour) * r.range(0.7, 1.2));
  for (let i = 0; i < people; i++) {
    add("person", station.stop + r.range(-45, 45), r.range(3.2, 6.2));
  }
  return items;
}

const STAINLESS: RGB = [176, 180, 182];
/** Sorted-waste bins: cans, bottles, burnables. */
const BINS: readonly RGB[] = [
  [64, 110, 170],
  [60, 140, 90],
  [200, 80, 60],
];

export function drawPlatformItem(p: Painter<Camera>, item: PlatformItem): void {
  const r = new Rng(item.seed);
  const lamps = p.light.lamps;
  switch (item.kind) {
    case "person":
      // People stand still where they wait.
      p.at(item.lateral);
      drawPerson(p, item.along, PLATFORM_HEIGHT, item.seed);
      return;
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
      // A stainless cabinet with three sorted openings, each under its colored label.
      p.at(item.lateral);
      const s = p.s;
      const cx = p.x(item.along);
      const Y = (h: number) => p.cam.yRail(item.lateral, PLATFORM_HEIGHT + h);
      const half = 0.7 * s;
      const face = p.surfaceLight(0, 0, 1);
      const cap = p.surfaceLight(0, 1, 0.3);
      p.rect(cx - half, Y(0.95), cx + half, Y(0), scale(STAINLESS, face));
      p.rect(cx - half - 1, Y(1.0), cx + half + 1, Y(0.93), scale(STAINLESS, cap * 1.1));
      p.rect(cx - half, Y(0.06), cx + half, Y(0), [60, 60, 62]);
      for (let i = 0; i < 3; i++) {
        const ox = cx + (i - 1) * 0.46 * s;
        const w = 0.17 * s;
        p.rect(ox - w, Y(0.88), ox + w, Y(0.78), BINS[i]);
        if (s > 5) {
          p.disc(ox, Y(0.66), Math.max(1, 0.09 * s), [24, 24, 26]);
        } else {
          p.rect(ox - w * 0.6, Y(0.72), ox + w * 0.6, Y(0.6), [24, 24, 26]);
        }
        if (i < 2) {
          p.rect(ox + 0.23 * s, Y(0.9), ox + 0.23 * s + 1, Y(0.08), scale(STAINLESS, face * 0.8));
        }
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
      const hour = p.env.clock.hour;
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
    case "sitter":
      p.at(item.lateral);
      drawPerson(p, item.along, PLATFORM_HEIGHT, item.seed, 0.45);
      return;
    case "stairs": {
      // Glazed walls round the stairwell; the cover steps down with the stairs.
      p.at(item.lateral);
      const lat = item.lateral;
      const view = p.view;
      const footprint = p.cam.footprint(lat);
      const glass: RGB = [186, 198, 206];
      for (let x = 0; x < view.width; x++) {
        const along = p.cam.alongAt(x, lat);
        const cov = intervalCoverage(along, item.along, item.along + item.length, footprint);
        if (cov <= 0) {
          continue;
        }
        const t = (along - item.along) / item.length;
        const top = p.cam.yRail(lat, PLATFORM_HEIGHT + 2.6 - 1.4 * Math.max(0, t - 0.15));
        const floor = p.cam.yRail(lat, PLATFORM_HEIGHT);
        const mullion = pulseCoverage(along - item.along, 1.4, 0.08, footprint);
        for (
          let y = Math.max(0, Math.floor(top));
          y < Math.min(view.height, Math.ceil(floor));
          y++
        ) {
          const h = p.cam.railHeightAt(y, lat) - PLATFORM_HEIGHT;
          let c: RGB = h < 0.2 ? [130, 132, 134] : h > 1.0 && h < 1.08 ? [150, 154, 158] : glass;
          if (y === Math.floor(top)) {
            c = [92, 96, 102];
          }
          const k = mullion > 0.3 ? 0.7 : 1;
          const sh = p.shade;
          view.blend(
            x,
            y,
            sh.litR(c[0] * k),
            sh.litG(c[1] * k),
            sh.litB(c[2] * k),
            cov * (c === glass ? 0.8 : 1),
          );
          if (lamps > 0.2 && c === glass) {
            view.add(x, y, 22 * lamps * cov, 24 * lamps * cov, 26 * lamps * cov);
          }
        }
      }
      return;
    }
    case "waitingRoom": {
      p.at(item.lateral);
      const s = p.s;
      const Y = (h: number) => p.cam.yRail(item.lateral, PLATFORM_HEIGHT + h);
      const x0 = p.x(item.along);
      const x1 = p.x(item.along + item.length);
      const frame: RGB = [120, 126, 132];
      if (lamps > 0.15) {
        p.lightRect(x0, Y(2.4), x1, Y(0.1), [255, 236, 200], 0.45 * lamps);
      } else {
        p.rectAlpha(x0, Y(2.4), x1, Y(0.1), [170, 190, 204], 0.35);
      }
      // A bench inside and someone waiting.
      p.rect(x0 + s * 0.4, Y(0.48), x1 - s * 0.4, Y(0.42), [110, 90, 70]);
      if (r.chance(0.5)) {
        const along = item.along + item.length * r.range(0.25, 0.75);
        drawPerson(p, along, PLATFORM_HEIGHT, item.seed ^ 0x9e37, 0.45);
      }
      // Frame, roof slab and a sliding door in the middle.
      for (
        let a = item.along;
        a <= item.along + item.length + 0.01;
        a += item.length / Math.max(2, Math.round(item.length / 1.4))
      ) {
        p.rect(p.x(a), Y(2.4), p.x(a) + 1, Y(0), frame);
      }
      p.rect(x0 - 0.15 * s, Y(2.6), x1 + 0.15 * s, Y(2.4), [150, 150, 146]);
      p.rect(x0, Y(0.1), x1, Y(0), frame);
      const dm = (x0 + x1) / 2;
      p.rect(dm - 0.45 * s, Y(2.1), dm + 0.45 * s, Y(2.1) + 1, frame);
      p.rect(dm + 0.3 * s, Y(1.1), dm + 0.36 * s, Y(0.95), [210, 210, 206]);
      // Its name plate.
      p.rect(dm - 0.5 * s, Y(2.38), dm + 0.5 * s, Y(2.2), [244, 244, 238]);
      pseudoText(p, dm - 0.4 * s, Y(2.35), dm + 0.4 * s, Y(2.23), [40, 44, 52], item.seed);
      return;
    }
    case "departureBoard": {
      p.at(item.lateral);
      const s = p.s;
      const Y = (h: number) => p.cam.yRail(item.lateral, PLATFORM_HEIGHT + h);
      const x0 = p.x(item.along - 1.2);
      const x1 = p.x(item.along + 1.2);
      // Hangers up to the canopy.
      p.rect(x0 + 0.2 * s, Y(3.2), x0 + 0.2 * s + 1, Y(2.95), [110, 110, 114]);
      p.rect(x1 - 0.2 * s, Y(3.2), x1 - 0.2 * s + 1, Y(2.95), [110, 110, 114]);
      p.rect(x0, Y(2.98), x1, Y(2.42), [52, 54, 58]);
      p.rect(x0 + 1, Y(2.92), x1 - 1, Y(2.48), [8, 8, 10]);
      // Two rows of amber, green and white LED text: departures.
      const rowH = (Y(2.48) - Y(2.92)) / 2;
      for (let row = 0; row < 2; row++) {
        const y0 = Y(2.92) + row * rowH + 1;
        const y1 = y0 + Math.max(1, rowH - 1);
        const cols: RGB[] = [
          [255, 160, 50],
          [120, 255, 140],
          [245, 245, 240],
        ];
        const w = x1 - x0 - 2;
        let x = x0 + 1;
        for (let seg = 0; seg < 3; seg++) {
          const segW = w * [0.25, 0.3, 0.45][seg];
          pseudoTextLit(p, x + 1, y0, x + segW - 1, y1, cols[seg], item.seed + row * 7 + seg);
          x += segW;
        }
      }
      return;
    }
    case "hangingSign": {
      p.at(item.lateral);
      const s = p.s;
      const Y = (h: number) => p.cam.yRail(item.lateral, PLATFORM_HEIGHT + h);
      const exit = hash3(item.seed, 1, 1) < 0.5;
      const x0 = p.x(item.along - 0.8);
      const x1 = p.x(item.along + 0.8);
      p.rect(x0 + 0.15 * s, Y(3.2), x0 + 0.15 * s + 1, Y(2.95), [110, 110, 114]);
      p.rect(x1 - 0.15 * s, Y(3.2), x1 - 0.15 * s + 1, Y(2.95), [110, 110, 114]);
      const bg: RGB = exit ? [240, 200, 40] : [246, 246, 242];
      const ink: RGB = exit ? [30, 30, 30] : [40, 70, 130];
      p.rect(x0, Y(2.98), x1, Y(2.58), bg);
      if (lamps > 0.15) {
        p.lightRect(x0, Y(2.98), x1, Y(2.58), bg, 0.6 * lamps);
      }
      // An arrow and a word or two.
      const ay = (Y(2.98) + Y(2.58)) / 2;
      const ax = x0 + 0.15 * s;
      const ah = Math.max(1, Math.round(0.1 * s));
      p.rect(ax, ay - ah / 2, ax + 0.3 * s, ay + ah / 2, ink);
      p.rect(ax - 1, ay - ah, ax, ay + ah, ink);
      pseudoText(p, ax + 0.45 * s, Y(2.92), x1 - 0.12 * s, Y(2.64), ink, item.seed);
      return;
    }
    case "adBoard": {
      p.at(item.lateral);
      const s = p.s;
      const Y = (h: number) => p.cam.yRail(item.lateral, PLATFORM_HEIGHT + h);
      const x0 = p.x(item.along - 1);
      const x1 = p.x(item.along + 1);
      const top = Y(1.55);
      const bottom = Y(0.45);
      p.rect(x0 - 1, top - 1, x1 + 1, bottom + 1, [96, 98, 102]);
      // A poster: a color field, a big shape and some lines of copy.
      const palette: RGB[] = [
        [232, 90, 70],
        [60, 120, 200],
        [250, 214, 80],
        [80, 170, 120],
        [240, 240, 236],
        [40, 44, 60],
      ];
      const bg = palette[Math.floor(hash3(item.seed, 2, 2) * palette.length)];
      const fg = palette[Math.floor(hash3(item.seed, 3, 3) * palette.length)];
      p.rect(x0, top, x1, bottom, bg);
      const cx = x0 + (x1 - x0) * (0.3 + 0.4 * hash3(item.seed, 4, 4));
      const cy = top + (bottom - top) * 0.4;
      const rad = Math.max(1, (bottom - top) * 0.28);
      for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
        for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
          if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= rad) {
            p.dot(x, y, fg);
          }
        }
      }
      pseudoText(
        p,
        x0 + 0.15 * s,
        bottom - (bottom - top) * 0.28,
        x1 - 0.15 * s,
        bottom - 2,
        fg === bg ? [30, 30, 30] : fg,
        item.seed,
      );
      if (lamps > 0.15) {
        // Backlit.
        p.lightRect(x0, top, x1, bottom, [255, 255, 250], 0.25 * lamps);
      }
      return;
    }
    case "timetable": {
      p.at(item.lateral);
      const s = p.s;
      const Y = (h: number) => p.cam.yRail(item.lateral, PLATFORM_HEIGHT + h);
      const x0 = p.x(item.along - 0.5);
      const x1 = p.x(item.along + 0.5);
      p.rect(p.x(item.along) - 0.5, Y(0.6), p.x(item.along) + 0.5, Y(0), [110, 110, 114]);
      p.rect(x0, Y(1.95), x1, Y(0.6), [246, 246, 242]);
      p.rect(x0, Y(1.95), x1, Y(1.8), stationColor(item.station));
      for (let y = Math.round(Y(1.72)); y < Y(0.7); y += Math.max(2, Math.round(0.12 * s))) {
        for (let x = Math.round(x0 + 1); x < x1 - 1; x++) {
          if (hash3(item.seed, x, y) < 0.45) {
            p.dot(x, y, [60, 64, 72]);
          }
        }
      }
      return;
    }
    case "extinguisher": {
      p.at(item.lateral);
      const s = p.s;
      const Y = (h: number) => p.cam.yRail(item.lateral, PLATFORM_HEIGHT + h);
      const x0 = p.x(item.along - 0.18);
      const x1 = p.x(item.along + 0.18);
      p.rect(x0, Y(0.95), x1, Y(0.25), [206, 46, 40]);
      p.rect(x0 + 1, Y(0.85), x1 - 1, Y(0.75), [246, 246, 240]);
      if (s > 8) {
        p.rect(x0, Y(0.95), x1, Y(0.95) + 1, [150, 30, 26]);
      }
      return;
    }
    case "planter": {
      p.at(item.lateral);
      const Y = (h: number) => p.cam.yRail(item.lateral, PLATFORM_HEIGHT + h);
      const x0 = p.x(item.along - 0.45);
      const x1 = p.x(item.along + 0.45);
      p.rect(x0, Y(0.45), x1, Y(0), [168, 110, 80]);
      const season = p.env.season;
      const flower: RGB =
        season.warmth > 0.3
          ? r.pick<RGB>([
              [230, 80, 90],
              [250, 210, 70],
              [240, 240, 240],
              [180, 110, 210],
            ])
          : [120, 140, 90];
      for (let x = Math.round(x0); x < x1; x++) {
        const hgt = 0.25 + hash3(item.seed, x, 1) * 0.3;
        for (let y = Math.round(Y(0.45 + hgt)); y < Y(0.45); y++) {
          p.dot(x, y, hash3(item.seed, x, y) < 0.3 ? flower : mix(season.grass, [40, 90, 40], 0.4));
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
