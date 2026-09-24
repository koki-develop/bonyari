import { hex, type RGB } from "../../core/color.ts";
import { clamp01, intervalCoverage, mod, pulseCoverage } from "../../core/math.ts";
import { hash2 } from "../../core/random.ts";
import type { Surface } from "../../core/surface.ts";
import type { Bridge, Span } from "../../sim/route.ts";
import type { Camera } from "../camera.ts";
import type { Lighting } from "../lighting.ts";
import type { Shade } from "../shade.ts";

/** Trackside pole spacing (m) and their lateral distances for single and double track. */
export const POLE_SPACING = 45;
const POLE_OFFSET = 7;
export const POLE_LATERAL_SINGLE = 3.2;
export const POLE_LATERAL_DOUBLE = 6.4;
export const BARRIER_LATERAL = 6.0;
export const TUNNEL_LATERAL = 2.5;
export const TRUSS_LATERAL_SINGLE = 2.7;
export const TRUSS_LATERAL_DOUBLE = 6.3;
const TRUSS_PANEL = 8;
const TRUSS_HEIGHT = 7.2;
export const TUNNEL_LAMP_SPACING = 50;
/** Height (m above the rails) of the tunnel lamps. */
export const TUNNEL_LAMP_HEIGHT = 3.6;

const POLE: RGB = [132, 128, 122];
const WIRE: RGB = [34, 34, 38];
const CONCRETE: RGB = [150, 146, 138];
const TUNNEL_WALL: RGB = [70, 68, 64];
const SODIUM: RGB = [255, 168, 80];
const BRIDGE_PAINT: readonly RGB[] = ["#a8483e", "#7d8f84", "#8aa6c0", "#b6b0a0"].map(hex);

/** Draws `color` (lit) into a column span with coverage `a`. */
function column(
  view: Surface,
  x: number,
  y0: number,
  y1: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  if (a <= 0.01) {
    return;
  }
  const from = Math.max(0, Math.floor(y0));
  const to = Math.min(view.height, Math.ceil(y1));
  for (let y = from; y < to; y++) {
    view.blend(x, y, r, g, b, a);
  }
}

/**
 * Trackside poles with the wires strung between them — the wires seem to rise
 * and fall as the poles flick past.
 * @param present whether pole number `i` stands (not in tunnels, stations, bridges)
 */
export function drawPolesAndWires(
  view: Surface,
  cam: Camera,
  shade: Shade,
  lateral: number,
  present: (i: number) => boolean,
): void {
  shade.at(lateral);
  const footprint = cam.footprint(lateral);
  const pr = shade.litR(POLE[0]);
  const pg = shade.litG(POLE[1]);
  const pb = shade.litB(POLE[2]);
  const wr = shade.litR(WIRE[0]);
  const wg = shade.litG(WIRE[1]);
  const wb = shade.litB(WIRE[2]);
  const top = cam.yRail(lateral, 9.2);
  const arm = cam.yRail(lateral, 8.4);
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral) - POLE_OFFSET;
    const i = Math.floor(along / POLE_SPACING + 0.5);
    const standing = present(i);
    if (standing) {
      const cov = pulseCoverage(along + 0.18, POLE_SPACING, 0.36, footprint);
      column(view, x, top, view.height, pr, pg, pb, cov);
      const armCov = pulseCoverage(along + 0.8, POLE_SPACING, 1.6, footprint);
      column(view, x, arm, arm + Math.max(1, 0.2 * cam.scale(lateral)), pr, pg, pb, armCov);
    }
    // Wires hang between neighbouring poles that both stand.
    const k = Math.floor(along / POLE_SPACING);
    if (present(k) && present(k + 1)) {
      const t = mod(along, POLE_SPACING) / POLE_SPACING;
      const sag = 4 * t * (1 - t);
      for (const h of [8.25, 7.7]) {
        const y = cam.yRail(lateral, h - 0.55 * sag);
        view.blend(x, Math.floor(y), wr, wg, wb, 0.92);
      }
    }
  }
}

/**
 * Concrete noise barrier along viaducts. It stops at `gaps` (platforms), whose
 * ends are box-filtered like everything else passing close by.
 */
export function drawBarrier(
  view: Surface,
  cam: Camera,
  shade: Shade,
  height: (along: number) => number,
  gaps: readonly Span[],
): void {
  const lateral = BARRIER_LATERAL;
  shade.at(lateral);
  const footprint = cam.footprint(lateral);
  const r = shade.litR(CONCRETE[0]);
  const g = shade.litG(CONCRETE[1]);
  const b = shade.litB(CONCRETE[2]);
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral);
    const h = height(along);
    if (h < 0.2) {
      continue;
    }
    let cov = 1;
    for (const gap of gaps) {
      cov -= intervalCoverage(along, gap.start, gap.end, footprint);
    }
    if (cov <= 0.01) {
      continue;
    }
    const top = cam.yRail(lateral, h);
    const seam = pulseCoverage(along, 2, 0.08, footprint) * 0.35;
    column(view, x, top, view.height, r * (1 - seam), g * (1 - seam), b * (1 - seam), cov);
    // Weathered cap.
    column(view, x, top, top + 1, r * 1.12, g * 1.12, b * 1.12, cov);
  }
}

/**
 * Warren truss with verticals. Members are box-filtered along the track, so at
 * speed the lattice smears the way it does to the eye.
 */
export function drawTruss(
  view: Surface,
  cam: Camera,
  shade: Shade,
  bridge: Bridge,
  lateral: number,
): void {
  shade.at(lateral);
  const paint = BRIDGE_PAINT[Math.floor(hash2(Math.floor(bridge.start), 3) * BRIDGE_PAINT.length)];
  const footprint = cam.footprint(lateral);
  const top = Math.max(0, Math.floor(cam.yRail(lateral, TRUSS_HEIGHT + 0.1)));
  const half = 0.2;
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral);
    const inside = intervalCoverage(along, bridge.start, bridge.end, footprint);
    if (inside <= 0) {
      continue;
    }
    const local = along - bridge.start;
    for (let y = top; y < view.height; y++) {
      const h = cam.railHeightAt(y, lateral);
      if (h > TRUSS_HEIGHT + 0.1 || h < -0.4) {
        continue;
      }
      let cov = 0;
      if (h >= TRUSS_HEIGHT - 0.35 || (h > -0.4 && h < 0.35)) {
        // Top and bottom chords.
        cov = 1;
      } else {
        const rise = (h / TRUSS_HEIGHT) * (TRUSS_PANEL / 2);
        cov = Math.max(
          pulseCoverage(local - rise + half, TRUSS_PANEL, half * 2, footprint),
          pulseCoverage(local + rise + half, TRUSS_PANEL, half * 2, footprint),
          pulseCoverage(local + half * 0.8 + TRUSS_PANEL / 2, TRUSS_PANEL, half * 1.6, footprint),
        );
      }
      cov *= inside;
      if (cov <= 0.02) {
        continue;
      }
      // Rivet-line shading: the top edge of each member catches the light.
      const edge = h >= TRUSS_HEIGHT - 0.1 ? 1.15 : 1;
      const rust = 0.92 + 0.12 * hash2(Math.floor(local * 2), y);
      view.blend(
        x,
        y,
        shade.litR(paint[0]) * edge * rust,
        shade.litG(paint[1]) * edge * rust,
        shade.litB(paint[2]) * edge * rust,
        cov,
      );
    }
  }
}

/** A plain handrail on small girder bridges. */
export function drawRailing(
  view: Surface,
  cam: Camera,
  shade: Shade,
  bridge: Bridge,
  lateral: number,
): void {
  shade.at(lateral);
  const footprint = cam.footprint(lateral);
  const r = shade.litR(170);
  const g = shade.litG(172);
  const b = shade.litB(168);
  const railY = cam.yRail(lateral, 1.1);
  const deckY = cam.yRail(lateral, 0);
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral);
    const inside = intervalCoverage(along, bridge.start, bridge.end, footprint);
    if (inside <= 0) {
      continue;
    }
    column(view, x, railY, railY + 1, r, g, b, inside);
    column(view, x, railY, deckY, r, g, b, inside * pulseCoverage(along, 2, 0.1, footprint));
    column(view, x, deckY, view.height, r * 0.6, g * 0.6, b * 0.6, inside);
  }
}

/**
 * Tunnel lining and portals. Inside, the wall fills the window; sodium lamps
 * streak past and our own windows light the wall faintly.
 */
export function drawTunnel(
  view: Surface,
  cam: Camera,
  shade: Shade,
  light: Lighting,
  tunnels: readonly Span[],
  interiorSpill: number,
): void {
  const lateral = TUNNEL_LATERAL;
  const footprint = cam.footprint(lateral);
  const s = cam.scale(lateral);
  const lampY = cam.yRail(lateral, TUNNEL_LAMP_HEIGHT);
  const lampH = Math.max(1, 0.25 * s);
  const ductY = cam.yRail(lateral, 1.3);
  const [ar, ag, ab] = light.ambient;
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral);
    let inside = 0;
    for (const t of tunnels) {
      inside = Math.max(inside, intervalCoverage(along, t.start, t.end, footprint));
    }
    if (inside > 0) {
      // Deep inside there is no daylight, only lamps and our windows' glow.
      let depth = 1;
      for (const t of tunnels) {
        if (along >= t.start - 5 && along <= t.end + 5) {
          depth = clamp01(Math.min(along - t.start, t.end - along) / 60);
        }
      }
      const daylight = 1 - depth;
      const spill = interiorSpill * Math.exp(-(((x - cam.cx) / (cam.width * 0.45)) ** 2));
      const joint = pulseCoverage(along, 10.5, 0.25, footprint);
      for (let y = 0; y < view.height; y++) {
        const hy = cam.railHeightAt(y, lateral);
        const vertical = Math.exp(-((hy - 1.8) ** 2) / 6);
        let base =
          TUNNEL_WALL[0] * (0.08 + spill * 0.5 * vertical) + TUNNEL_WALL[0] * ar * daylight * 0.8;
        let g =
          TUNNEL_WALL[1] * (0.08 + spill * 0.45 * vertical) + TUNNEL_WALL[1] * ag * daylight * 0.8;
        let b =
          TUNNEL_WALL[2] * (0.09 + spill * 0.38 * vertical) + TUNNEL_WALL[2] * ab * daylight * 0.8;
        const k = 1 - joint * 0.3;
        base *= k;
        g *= k;
        b *= k;
        if (Math.abs(y + 0.5 - ductY) < 0.8) {
          base *= 0.7;
          g *= 0.7;
          b *= 0.7;
        }
        view.blend(x, y, base, g, b, inside);
      }
      // Lamps streak by.
      const lamp = pulseCoverage(along, TUNNEL_LAMP_SPACING, 0.7, footprint) * inside;
      if (lamp > 0.01) {
        for (let y = Math.floor(lampY - 6); y < lampY + lampH + 6; y++) {
          const d = y < lampY ? lampY - y : y > lampY + lampH ? y - lampY - lampH : 0;
          const k = lamp * (d === 0 ? 1 : 0.35 * Math.exp(-d / 2.2));
          view.add(x, y, SODIUM[0] * k, SODIUM[1] * k, SODIUM[2] * k);
        }
      }
    }
  }
  drawPortals(view, cam, shade, tunnels);
}

/** The concrete face around each tunnel mouth. */
function drawPortals(view: Surface, cam: Camera, shade: Shade, tunnels: readonly Span[]): void {
  for (const t of tunnels) {
    for (const [face, dir] of [
      [t.start, 1],
      [t.end, -1],
    ] as const) {
      const ahead = face - cam.pos;
      // The entrance face looks back along the line; the exit face looks forward.
      if (ahead * dir <= 0) {
        continue;
      }
      for (let x = 0; x < view.width; x++) {
        const dx = x + 0.5 - cam.cx;
        if (dx * ahead <= 0) {
          continue;
        }
        const z = (ahead * cam.focal) / dx;
        if (z < TUNNEL_LATERAL || z > 14) {
          continue;
        }
        shade.at(z);
        const top = cam.yRail(z, 8.5 - (z - TUNNEL_LATERAL) * 0.25);
        const bottom = cam.yRail(z, -0.5);
        const moss = hash2(Math.floor(z * 2), 7) * 0.12;
        for (let y = Math.max(0, Math.floor(top)); y < Math.min(view.height, bottom); y++) {
          const edge = y === Math.floor(top) ? 1.18 : 1 - moss;
          view.blend(
            x,
            y,
            shade.litR(CONCRETE[0] * edge),
            shade.litG(CONCRETE[1] * edge),
            shade.litB(CONCRETE[2] * edge * 0.97),
            1,
          );
        }
      }
    }
  }
}
