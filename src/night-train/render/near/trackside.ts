import { hex, type RGB } from "../../core/color.ts";
import { clamp01, intervalCoverage, mod, pulseCoverage } from "../../core/math.ts";
import { hash2, hash3 } from "../../core/random.ts";
import type { Surface } from "../../core/surface.ts";
import type { Bridge, Span } from "../../sim/route.ts";
import { type Camera, EYE_ABOVE_RAIL } from "../camera.ts";
import { HALF_GAUGE, NEXT_TRACK } from "../ground.ts";
import type { Cover } from "../cover.ts";
import type { Painter } from "../painter.ts";
import { PORTAL_TOP, PORTAL_WALL_END, portalWallTop } from "./tunnel-hill.ts";
import type { Shade } from "../shade.ts";

/** Trackside pole spacing (m) and their lateral distances for single and double track. */
export const POLE_SPACING = 45;
const POLE_OFFSET = 7;
export const POLE_LATERAL_SINGLE = 3.2;
export const POLE_LATERAL_DOUBLE = 6.4;
export const BARRIER_LATERAL = 6.0;
/** Height (m above the rails) of the barrier's concrete parapet. */
const BARRIER_PARAPET = 0.75;
const BARRIER_POST_SPACING = 2;
/** Pitch (m) of the louvers in the absorbing panels. */
const BARRIER_RIB = 0.16;
/** Lateral distance (m) where the cable trough along the barrier's foot begins. */
const TROUGH_NEAR = 5.35;
/** Clear panels run in stretches of this length (m). */
const BARRIER_CLEAR_RUN = 60;
/** Spacing (m) of our car's windows, whose light falls on the barrier at night. */
const WINDOW_PITCH = 2.4;
export const TUNNEL_LATERAL = 2.5;
export const TRUSS_LATERAL_SINGLE = 2.7;
export const TRUSS_LATERAL_DOUBLE = 6.3;
const TRUSS_PANEL = 8;
const TRUSS_HEIGHT = 7.2;
export const TUNNEL_LAMP_SPACING = 50;
/** Height (m above the rails) of the tunnel lamps. */
export const TUNNEL_LAMP_HEIGHT = 3.6;
/** Length (m) of each cast ring of the tunnel lining. */
const LINING_RING = 10.5;
const NICHE_SPACING = 63;

const POLE: RGB = [132, 128, 122];
const WIRE: RGB = [34, 34, 38];
const CONCRETE: RGB = [150, 146, 138];
const PANEL: RGB = [168, 170, 162];
const CLEAR_PANEL: RGB = [196, 214, 220];
const STEEL: RGB = [104, 110, 108];
const TUNNEL_WALL: RGB = [70, 68, 64];
const MASONRY: RGB = [150, 140, 124];
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
/** Scratch: whether each pole in view stands. */
let STANDING = new Uint8Array(8);

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
  // Only a few poles fall in view: ask once for each.
  const first = Math.floor((cam.alongAt(0, lateral) - POLE_OFFSET) / POLE_SPACING) - 1;
  const last = Math.floor((cam.alongAt(view.width - 1, lateral) - POLE_OFFSET) / POLE_SPACING) + 2;
  const count = last - first + 1;
  if (STANDING.length < count) {
    STANDING = new Uint8Array(count * 2);
  }
  for (let n = 0; n < count; n++) {
    STANDING[n] = present(first + n) ? 1 : 0;
  }
  const stands = (n: number): boolean =>
    n >= first && n <= last ? STANDING[n - first] === 1 : present(n);
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral) - POLE_OFFSET;
    const i = Math.floor(along / POLE_SPACING + 0.5);
    const standing = stands(i);
    if (standing) {
      const cov = pulseCoverage(along + 0.18, POLE_SPACING, 0.36, footprint);
      column(view, x, top, view.height, pr, pg, pb, cov);
      const armCov = pulseCoverage(along + 0.8, POLE_SPACING, 1.6, footprint);
      column(view, x, arm, arm + Math.max(1, 0.2 * cam.scale(lateral)), pr, pg, pb, armCov);
    }
    // Wires hang between neighbouring poles that both stand.
    const k = Math.floor(along / POLE_SPACING);
    if (stands(k) && stands(k + 1)) {
      const t = mod(along, POLE_SPACING) / POLE_SPACING;
      const sag = 4 * t * (1 - t);
      for (const h of [8.25, 7.7]) {
        const y = cam.yRail(lateral, h - 0.55 * sag);
        view.blend(x, Math.floor(y), wr, wg, wb, 0.92);
      }
    }
  }
}

/** One column of the noise barrier: what the drawing and the occlusion both need. */
interface BarrierColumn {
  along: number;
  /** Height (m above the rails) of the panels. */
  h: number;
  /** Coverage left after the gaps at platforms. */
  cov: number;
  /** Screen y of the post tops and of the barrier's foot (clamped to the view). */
  top: number;
  foot: number;
  /** Coverage of a post. */
  post: number;
  /** Whether this stretch has clear panels. */
  clear: boolean;
}

const BARRIER_COLUMN: BarrierColumn = {
  along: 0,
  h: 0,
  cov: 0,
  top: 0,
  foot: 0,
  post: 0,
  clear: false,
};

/** Fills `out` for column `x`; false where no barrier stands. */
function barrierColumn(
  cam: Camera,
  x: number,
  viewHeight: number,
  height: (along: number) => number,
  gaps: readonly Span[],
  out: BarrierColumn,
): boolean {
  const lateral = BARRIER_LATERAL;
  const footprint = cam.footprint(lateral);
  const along = cam.alongAt(x, lateral);
  const h = height(along);
  if (h < 0.2) {
    return false;
  }
  let cov = 1;
  for (const gap of gaps) {
    cov -= intervalCoverage(along, gap.start, gap.end, footprint);
  }
  if (cov <= 0.01) {
    return false;
  }
  out.along = along;
  out.h = h;
  out.cov = cov;
  out.top = cam.yRail(lateral, h + 0.08);
  out.foot = Math.min(viewHeight, Math.ceil(cam.yRail(lateral, 0)));
  out.post = pulseCoverage(along + 0.08, BARRIER_POST_SPACING, 0.16, footprint);
  // Clear panels along some stretches, always from post to post.
  out.clear = hash2(Math.floor(along / BARRIER_CLEAR_RUN), 71) < 0.3;
  return true;
}

/**
 * Opacity of the barrier at `hy` (m above the rails) in a column, or -1 where
 * nothing is drawn (above the panels, between the posts).
 */
function barrierAlpha(c: BarrierColumn, hy: number): number {
  const postTop = hy > c.h;
  if (postTop && c.post <= 0.01) {
    return -1;
  }
  let alpha = c.cov;
  if (hy >= BARRIER_PARAPET && c.clear) {
    // Glazing: a solid frame at the top and bottom, a faint sheen between.
    const sheen = mod(c.along * 0.7 + hy * 1.6, 3.2) < 0.35 ? 1 : 0;
    alpha *= hy > c.h - 0.06 || hy < BARRIER_PARAPET + 0.05 ? 1 : 0.18 + sheen * 0.14;
  }
  if (c.post > 0.01) {
    alpha = postTop ? c.post * c.cov : Math.max(alpha, c.post * c.cov);
  }
  return alpha;
}

/** Marks the pixels the barrier and the deck at its foot paint over opaquely. */
export function coverBarrier(
  cam: Camera,
  height: (along: number) => number,
  gaps: readonly Span[],
  cover: Cover,
): void {
  const col = BARRIER_COLUMN;
  for (let x = 0; x < cover.width; x++) {
    if (!barrierColumn(cam, x, cover.height, height, gaps, col)) {
      continue;
    }
    let runStart = -1;
    for (let y = Math.max(0, Math.floor(col.top)); y < col.foot; y++) {
      const opaque = barrierAlpha(col, cam.railHeightAt(y, BARRIER_LATERAL)) >= 1;
      if (opaque && runStart < 0) {
        runStart = y;
      } else if (!opaque && runStart >= 0) {
        cover.markRun(x, runStart, y, BARRIER_LATERAL);
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      cover.markRun(x, runStart, col.foot, BARRIER_LATERAL);
    }
    if (col.cov >= 1) {
      cover.markRun(x, Math.max(0, col.foot), cover.height, BARRIER_LATERAL);
    }
  }
}

/**
 * Noise barrier along viaducts: a concrete parapet carrying louvered sound
 * absorbing panels between H-section posts, with clear panels along some
 * stretches so the town shows through. Rain has streaked it below the joints,
 * and at night the light from our own windows falls on it. It stops at `gaps`
 * (platforms), whose ends are box-filtered like everything else passing close by.
 * @param spill how strongly the lit car shines out onto nearby walls (0..1)
 */
export function drawBarrier(
  p: Painter,
  height: (along: number) => number,
  gaps: readonly Span[],
  spill: number,
): void {
  const { view, cam } = p;
  const lateral = BARRIER_LATERAL;
  p.at(lateral);
  const shade = p.shade;
  const face = p.surfaceLight(0, 0, 1);
  const sideA = p.surfaceLight(-1, 0, 0.3);
  const sideB = p.surfaceLight(1, 0, 0.3);
  // Our car's windows throw soft patches of light out onto the barrier.
  const night = spill * (1 - p.light.daylight);
  const col = BARRIER_COLUMN;
  for (let x = 0; x < view.width; x++) {
    if (!barrierColumn(cam, x, view.height, height, gaps, col)) {
      continue;
    }
    const { along, h, cov, post, clear, foot } = col;
    // The flange facing the sun is lit, the other in shade.
    const postK = mod(along + 0.08, BARRIER_POST_SPACING) < 0.08 ? sideA : sideB;
    // Rain streaks from the panel joints and the parapet top.
    const streakCell = Math.floor(along / 0.12);
    const streak = hash2(streakCell, 29);
    const streakLen = 0.15 + 0.5 * hash2(streakCell, 31);
    const glowX = (along - cam.pos) / WINDOW_PITCH;
    const windowGlow = night > 0 ? night * (0.5 + 0.5 * Math.cos(glowX * Math.PI * 2)) ** 2 : 0;
    for (let y = Math.max(0, Math.floor(col.top)); y < foot; y++) {
      const hy = cam.railHeightAt(y, lateral);
      const alpha = barrierAlpha(col, hy);
      if (alpha < 0) {
        continue;
      }
      const postTop = hy > h;
      let c: RGB;
      let k = face;
      if (hy < BARRIER_PARAPET) {
        // Cast concrete parapet with a drip groove under its coping.
        c = CONCRETE;
        const below = BARRIER_PARAPET - hy;
        if (below < 0.07) {
          k *= 1.12;
        } else if (below < 0.13) {
          k *= 0.78;
        } else if (streak > 0.75 && below < streakLen) {
          // Rain streaks fade out downward.
          k *= 1 - 0.16 * (1 - below / streakLen);
        }
        if (hy < 0.12) {
          // Grime splashed up from the deck.
          k *= 0.82 + hy * 1.5;
        }
      } else if (clear) {
        // Tinted glazing over what lies beyond.
        c = CLEAR_PANEL;
        k *= 1.1;
      } else {
        // Louvered absorbing panels: a shadowed slot under each rib, a capping rail on top.
        c = PANEL;
        const rib = mod(hy - BARRIER_PARAPET, BARRIER_RIB) / BARRIER_RIB;
        k *= rib < 0.3 ? 0.7 : rib > 0.8 ? 1.1 : 1;
        const below = h - hy;
        if (below < 0.05) {
          k *= 1.15;
        } else if (streak > 0.82 && below < streakLen * 0.6) {
          k *= 1 - 0.12 * (1 - below / (streakLen * 0.6));
        }
      }
      let r = c[0] * k;
      let g = c[1] * k;
      let b = c[2] * k;
      if (post > 0.01) {
        const a = postTop ? 1 : post;
        r += (STEEL[0] * postK - r) * a;
        g += (STEEL[1] * postK - g) * a;
        b += (STEEL[2] * postK - b) * a;
      }
      if (windowGlow > 0.01) {
        const v = windowGlow * Math.exp(-((hy - 1.0) ** 2) / 0.5) * 2.5;
        r *= 1 + v;
        g *= 1 + v * 0.9;
        b *= 1 + v * 0.7;
      }
      view.blend(x, y, shade.litR(r), shade.litG(g), shade.litB(b), alpha);
    }
    // Below the barrier's foot, the viaduct deck: a cable trough along the
    // barrier and the adjacent track on its ballast.
    const deckLight = p.surfaceLight(0, 1, 0.2);
    for (let y = Math.max(0, foot); y < view.height; y++) {
      const dy = y + 0.5 - cam.horizon;
      const z = (EYE_ABOVE_RAIL * cam.focal) / dy;
      const at = cam.pos + ((x + 0.5 - cam.cx) * z) / cam.focal;
      const rowFoot = (z * z) / (EYE_ABOVE_RAIL * cam.focal);
      const aFoot = z / cam.focal + Math.abs(cam.travel);
      shade.at(z);
      let r: number;
      let g: number;
      let b: number;
      if (z > TROUGH_NEAR) {
        // Concrete lids with joints.
        const joint = pulseCoverage(at, 1, 0.04, aFoot);
        const lip = intervalCoverage(z, TROUGH_NEAR, TROUGH_NEAR + 0.06, rowFoot);
        const k = (1 - joint * 0.3) * (1 + lip * 0.15);
        r = CONCRETE[0] * 0.92 * k;
        g = CONCRETE[1] * 0.92 * k;
        b = CONCRETE[2] * 0.92 * k;
      } else {
        const n = hash3(Math.floor(at * 5), Math.floor(z * 5), 9) * 26;
        r = 104 + n;
        g = 98 + n;
        b = 92 + n;
        if (z > NEXT_TRACK - 1.05 && z < NEXT_TRACK + 1.05) {
          const sleeper = pulseCoverage(at, 0.62, 0.22, aFoot) * 0.8;
          r += (124 - r) * sleeper;
          g += (118 - g) * sleeper;
          b += (110 - b) * sleeper;
        }
        const rail = Math.min(
          1,
          intervalCoverage(
            z,
            NEXT_TRACK - HALF_GAUGE - 0.04,
            NEXT_TRACK - HALF_GAUGE + 0.04,
            rowFoot,
          ) +
            intervalCoverage(
              z,
              NEXT_TRACK + HALF_GAUGE - 0.04,
              NEXT_TRACK + HALF_GAUGE + 0.04,
              rowFoot,
            ),
        );
        r += (196 - r) * rail;
        g += (196 - g) * rail;
        b += (204 - b) * rail;
      }
      let k = deckLight;
      if (night > 0) {
        const gx = (at - cam.pos) / WINDOW_PITCH;
        k +=
          night *
          (0.5 + 0.5 * Math.cos(gx * Math.PI * 2)) ** 2 *
          2.2 *
          Math.exp(-((z - 3.6) ** 2) / 3);
      }
      view.blend(x, y, shade.litR(r * k), shade.litG(g * k * 0.97), shade.litB(b * k * 0.92), cov);
    }
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
 * Whether the tunnel lining fills the whole view this frame: every column
 * lies fully inside one tunnel, so the lining overwrites every pixel and
 * nothing farther away can show.
 */
export function tunnelEncloses(cam: Camera, tunnels: readonly Span[]): boolean {
  const footprint = cam.footprint(TUNNEL_LATERAL);
  const first = cam.alongAt(0, TUNNEL_LATERAL);
  const last = cam.alongAt(cam.width - 1, TUNNEL_LATERAL);
  for (const t of tunnels) {
    if (
      intervalCoverage(first, t.start, t.end, footprint) === 1 &&
      intervalCoverage(last, t.start, t.end, footprint) === 1
    ) {
      return true;
    }
  }
  return false;
}

/** Marks the columns the tunnel lining fills from top to bottom. */
export function coverTunnel(cam: Camera, tunnels: readonly Span[], cover: Cover): void {
  const lateral = TUNNEL_LATERAL;
  const footprint = cam.footprint(lateral);
  for (let x = 0; x < cover.width; x++) {
    const along = cam.alongAt(x, lateral);
    let inside = 0;
    for (const t of tunnels) {
      inside = Math.max(inside, intervalCoverage(along, t.start, t.end, footprint));
    }
    if (inside >= 1) {
      cover.markRun(x, 0, cover.height, lateral);
    }
  }
}

/**
 * Tunnel lining and portals. Inside, the wall fills the window: concrete cast
 * in rings, stained by seeping water, with a cable trough along its foot and
 * a refuge niche now and then. Sodium lamps streak past and our own windows
 * light the wall faintly.
 */
export function drawTunnel(p: Painter, tunnels: readonly Span[], interiorSpill: number): void {
  const { view, cam } = p;
  const lateral = TUNNEL_LATERAL;
  const footprint = cam.footprint(lateral);
  const s = cam.scale(lateral);
  const lampY = cam.yRail(lateral, TUNNEL_LAMP_HEIGHT);
  const lampH = Math.max(1, 0.25 * s);
  const [ar, ag, ab] = p.light.ambient;
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral);
    let inside = 0;
    for (const t of tunnels) {
      inside = Math.max(inside, intervalCoverage(along, t.start, t.end, footprint));
    }
    if (inside <= 0) {
      continue;
    }
    // Deep inside there is no daylight, only lamps and our windows' glow.
    let depth = 1;
    for (const t of tunnels) {
      if (along >= t.start - 5 && along <= t.end + 5) {
        depth = clamp01(Math.min(along - t.start, t.end - along) / 60);
      }
    }
    const daylight = 1 - depth;
    const spill = interiorSpill * Math.exp(-(((x - cam.cx) / (cam.width * 0.45)) ** 2));
    // Construction joints between the cast rings.
    const joint = pulseCoverage(along, LINING_RING, 0.25, footprint);
    // Refuge niches, recessed and dark.
    const niche = pulseCoverage(along - LINING_RING * 0.5, NICHE_SPACING, 1.4, footprint);
    // Lime leaching from some joints and cracks.
    const ring = Math.floor(along / LINING_RING);
    const leach = hash2(ring, 17) < 0.35 ? pulseCoverage(along, LINING_RING, 0.9, footprint) : 0;
    const bracket = pulseCoverage(along, 1, 0.08, footprint);
    const mottle = hash2(Math.floor(along * 1.5), 23);
    const windows = (0.5 + 0.5 * Math.cos(((along - cam.pos) / WINDOW_PITCH) * Math.PI * 2)) ** 2;
    for (let y = 0; y < view.height; y++) {
      const hy = cam.railHeightAt(y, lateral);
      const vertical = Math.exp(-((hy - 1.8) ** 2) / 6);
      // Unlit wall tone, then light from the lamps' spill, our windows and the mouth.
      let k = 0.92 + 0.16 * mottle + 0.08 * hash2(Math.floor(hy * 2), ring);
      k *= 1 - joint * 0.35;
      if (leach > 0 && hy > 0.8) {
        k *= 1 + leach * 0.25 * hash2(Math.floor(along * 6), 41);
      }
      if (hy > 0.9 && hy < 1.25) {
        // Cable trough on brackets along the wall.
        k *= hy > 1.17 ? 1.15 : 0.62;
      } else if (hy > 0.6 && hy <= 0.9) {
        k *= 1 - bracket * 0.4;
      } else if (hy < 0.15) {
        // Side ditch at the foot.
        k *= 0.55;
      }
      if (niche > 0.01 && hy > 0 && hy < 2.1) {
        k *= 1 - niche * 0.7;
      }
      // Our windows throw a row of light pools onto the wall.
      const pool = spill * windows * Math.exp(-((hy - 1.9) ** 2) / 1.2);
      const lit = 0.08 + spill * 0.3 * vertical + pool * 0.9;
      const r = TUNNEL_WALL[0] * k * (lit + ar * daylight * 0.8);
      const g = TUNNEL_WALL[1] * k * (lit * 0.9 + ag * daylight * 0.8);
      const b = TUNNEL_WALL[2] * k * (lit * 0.76 + ab * daylight * 0.8) + TUNNEL_WALL[2] * 0.01;
      view.blend(x, y, r, g, b, inside);
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
  drawPortals(p, tunnels);
}

/**
 * The mouths of the tunnels, seen at a slant as we come up to them or leave:
 * a masonry or concrete headwall with its coping and name plate over the arch,
 * and wing walls stepping down on either side. Each ray is followed to where
 * it crosses the plane of the portal; the hill above is `drawTunnelHills`.
 */
function drawPortals(p: Painter, tunnels: readonly Span[]): void {
  const { view, cam, shade } = p;
  for (const t of tunnels) {
    const masonry = hash2(Math.floor(t.start), 13) < 0.4;
    const wall = masonry ? MASONRY : CONCRETE;
    for (const [face, dir] of [
      [t.start, 1],
      [t.end, -1],
    ] as const) {
      const ahead = face - cam.pos;
      // The entrance face looks back along the line; the exit face looks forward.
      if (ahead * dir <= 0) {
        continue;
      }
      // The face turns toward the train coming up to it.
      const faceLight = p.surfaceLight(-dir, 0, 0.15);
      const topLight = p.surfaceLight(-dir * 0.3, 0.95, 0.1);
      for (let x = 0; x < view.width; x++) {
        const dx = x + 0.5 - cam.cx;
        if (dx * ahead <= 0) {
          continue;
        }
        // Lateral distance at which this column's ray crosses the portal plane.
        const z = (ahead * cam.focal) / dx;
        if (z > PORTAL_WALL_END) {
          continue;
        }
        shade.at(Math.max(z, TUNNEL_LATERAL));
        const wallTop = portalWallTop(z);
        const yTop = Math.max(0, Math.floor(cam.yRail(z, wallTop)));
        const yBottom = Math.min(view.height, Math.ceil(cam.yRail(z, -0.6)));
        for (let y = yTop; y < yBottom; y++) {
          const hy = cam.railHeightAt(y, z);
          // The opening: the lining behind shows through.
          if (z < TUNNEL_LATERAL && hy < archHeight(z)) {
            continue;
          }
          let k = faceLight;
          const below = wallTop - hy;
          if (below < 0.35) {
            // Coping stone, catching the light on top, with a drip line under it.
            k = below < 0.08 ? topLight * 1.1 : faceLight * 1.08;
          } else if (below < 0.45) {
            k *= 0.7;
          } else if (masonry) {
            // Coursed stone blocks, offset course by course.
            const course = Math.floor(hy / 0.55);
            const u = z + (course % 2) * 0.45;
            const bed = mod(hy, 0.55) < 0.07;
            const head = mod(u, 0.9) < 0.07;
            k *= bed || head ? 0.72 : 0.9 + 0.2 * hash2(Math.floor(u / 0.9), course);
          } else {
            // Formwork panel lines.
            k *= mod(hy, 1.2) < 0.06 || mod(z, 2.4) < 0.05 ? 0.8 : 1;
          }
          // Water stains running down from the coping; damp low down.
          const streak = hash2(Math.floor(z * 4), 19);
          if (streak > 0.7 && below < 0.45 + streak * 3) {
            k *= 0.86;
          }
          if (hy < 1.2) {
            k *= 0.84 + hy * 0.13;
          }
          let r = wall[0] * k;
          let g = wall[1] * k;
          let b = wall[2] * k;
          // The name plate over the arch.
          if (z > 0.2 && z < 1.8 && hy > PORTAL_TOP - 2.1 && hy < PORTAL_TOP - 1.3) {
            const text =
              z > 0.4 &&
              z < 1.6 &&
              hy > PORTAL_TOP - 1.9 &&
              hy < PORTAL_TOP - 1.5 &&
              hash2(Math.floor(z * 6), Math.floor(hy * 8)) < 0.5;
            r = (text ? 190 : 52) * faceLight;
            g = (text ? 186 : 54) * faceLight;
            b = (text ? 170 : 56) * faceLight;
          }
          view.set(x, y, shade.color(r, g, b));
        }
      }
    }
  }
}

/** Height (m above the rails) of the tunnel's opening at a lateral offset. */
function archHeight(z: number): number {
  const spring = 4;
  const radius = TUNNEL_LATERAL + 0.2;
  return spring + Math.sqrt(Math.max(0, radius * radius - z * z));
}
