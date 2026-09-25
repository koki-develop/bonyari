import { mix, type RGB } from "../../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../../shared/core/math.ts";
import { hash3, noise1, noise2 } from "../../../shared/core/random.ts";
import type { Span } from "../../sim/route.ts";
import { EYE_ABOVE_RAIL } from "../camera.ts";
import type { Painter } from "../../../shared/render/painter.ts";
import type { Camera } from "../camera.ts";

/** Height (m above the rails) of a portal's headwall. */
export const PORTAL_TOP = 8.6;
/** Lateral half width (m) of the headwall; the wing walls continue beyond it. */
export const PORTAL_HALF_WIDTH = 6.5;
/** Lateral length (m) of the wing walls, which step down to `WING_FOOT`. */
export const PORTAL_WING = 5;
const WING_FOOT = 1.5;
/** Rise of the hillside per meter into the hill. */
const HILL_SLOPE = 0.85;
/** Lateral distance (m) beyond which the hill falls away, and how steeply. */
const HILL_SHOULDER = 28;
const HILL_FALL = 0.7;
/** Farthest lateral distance (m) a ray is followed looking for the hill. */
const HILL_REACH = 160;

const BARE: RGB = [112, 100, 88];
const SNOW: RGB = [232, 236, 244];

/** Height (m above the rails) of the wall top along the portal's face at a lateral offset. */
export function portalWallTop(lateral: number): number {
  if (lateral < PORTAL_HALF_WIDTH) {
    return PORTAL_TOP;
  }
  const t = clamp01((lateral - PORTAL_HALF_WIDTH) / PORTAL_WING);
  return PORTAL_TOP + (WING_FOOT - PORTAL_TOP) * t;
}

/** Lateral offset (m) beyond which the portal has no wall, only the natural slope. */
export const PORTAL_WALL_END = PORTAL_HALF_WIDTH + PORTAL_WING;

/**
 * Height (m above the rails) of the ground of the hill a tunnel runs through:
 * slopes rising steeply from both portals to a wooded crest, falling away to
 * the side. Negative off the hill.
 */
export function tunnelHill(t: Span, along: number, lateral: number): number {
  const d = Math.min(along - t.start, t.end - along);
  if (d < 0) {
    return -1;
  }
  const seed = Math.floor(t.start);
  const crest = 18 + 14 * noise1(along * 0.012, seed) + 2.5 * noise1(along * 0.2, seed ^ 5);
  const rise = portalWallTop(lateral) + d * HILL_SLOPE;
  return Math.min(rise, crest) - Math.max(0, lateral - HILL_SHOULDER) * HILL_FALL;
}

/** Lateral distance (m) up to which the near slopes carry individual trees. */
export const HILL_TREES_REACH = 40;

/**
 * How wooded (0..1) the hill is at a point: bare on the cut slope just above
 * the portal, wooded beyond.
 */
export function hillWooded(t: Span, along: number, lateral: number): number {
  const d = Math.min(along - t.start, t.end - along);
  if (d < 0) {
    return 0;
  }
  return Math.max(smoothstep(3, 8, d), smoothstep(PORTAL_WALL_END, PORTAL_WALL_END + 4, lateral));
}

/** Whether the wood at a point is evergreen (planted cedar) rather than deciduous. */
export function hillEvergreen(along: number, lateral: number): boolean {
  return noise2(along * 0.06, lateral * 0.06, 72) < 0.62;
}

/**
 * Height (m) of the far tree canopy over the hill's ground. Nearer than
 * `HILL_TREES_REACH` the slope carries separately drawn trees instead.
 */
function canopy(t: Span, along: number, lateral: number): number {
  const amount =
    hillWooded(t, along, lateral) *
    smoothstep(HILL_TREES_REACH - 15, HILL_TREES_REACH + 10, lateral);
  if (amount <= 0) {
    return 0;
  }
  const crowns =
    0.65 * noise2(along / 3.2, lateral / 3.2, 81) + 0.35 * noise2(along / 1.3, lateral / 1.3, 82);
  return amount * (2 + 5 * crowns);
}

/**
 * The hillsides above and around the tunnel mouths, found by following each
 * pixel's ray until it meets the ground of the hill. Drawn early, so things
 * standing in front of the hill are painted over it.
 */
export function drawTunnelHills(p: Painter<Camera>, tunnels: readonly Span[]): void {
  const { view, cam, shade } = p;
  const F = cam.focal;
  const covered = p.cover.order;
  const season = p.env.season;
  const snow = p.env.weather.state.snowCover;
  // A mixed wood: stands of evergreens among deciduous trees that turn and go bare.
  const evergreen = season.evergreen;
  const deciduous = mix(BARE, season.leaf, clamp01(season.leafDensity * 1.2));
  const undergrowth = mix(season.evergreen, [70, 58, 44], 0.45);
  for (const t of tunnels) {
    const ahead = cam.pos < t.start ? t.start - cam.pos : cam.pos > t.end ? t.end - cam.pos : 0;
    if (ahead === 0) {
      continue;
    }
    const length = t.end - t.start;
    for (let x = 0; x < view.width; x++) {
      const dx = x + 0.5 - cam.cx;
      if (dx * ahead <= 0) {
        continue;
      }
      // Where the ray enters the hill (the portal's plane) and leaves it.
      const zIn = (ahead * F) / dx;
      const zOut = zIn + (length * F) / Math.abs(dx);
      if (zIn > HILL_REACH) {
        continue;
      }
      const zEnd = Math.min(zOut, HILL_REACH);
      let z = zIn;
      const wallTop = zIn < PORTAL_WALL_END ? portalWallTop(zIn) : 0;
      for (let y = view.height - 1; y >= 0; y--) {
        const dy = y + 0.5 - cam.horizon;
        // The portal's walls are drawn with the tunnel; below them lies the ground in front.
        if (EYE_ABOVE_RAIL - (dy * zIn) / F < wallTop) {
          continue;
        }
        // Painted over later by something nearer: the march resumes from here.
        if (covered[y * view.width + x] !== Infinity) {
          continue;
        }
        while (
          z < zEnd &&
          EYE_ABOVE_RAIL - (dy * z) / F >
            tunnelHill(t, cam.pos + (dx * z) / F, z) + canopy(t, cam.pos + (dx * z) / F, z)
        ) {
          z += Math.max(0.12, z * 0.02);
        }
        if (z >= zEnd) {
          break;
        }
        const along = cam.pos + (dx * z) / F;
        const ground = tunnelHill(t, along, z);
        const crown = canopy(t, along, z);
        shade.at(z);
        // Surface normal from the slope of the ground plus the lumps of the crowns.
        const e = 0.35;
        const gA =
          (tunnelHill(t, along + e, z) +
            canopy(t, along + e, z) -
            tunnelHill(t, along - e, z) -
            canopy(t, along - e, z)) /
          (2 * e);
        const gZ =
          (tunnelHill(t, along, z + e) +
            canopy(t, along, z + e) -
            tunnelHill(t, along, z - e) -
            canopy(t, along, z - e)) /
          (2 * e);
        const len = Math.hypot(gA, 1, gZ);
        let k = p.surfaceLight(-gA / len, 1 / len, gZ / len);
        const fine = hash3(
          Math.floor(along * 5),
          Math.floor(z * 5),
          Math.floor((ground + crown) * 5),
        );
        if (crown > 0.5) {
          // Deep between the crowns it is darker.
          k *= (0.62 + 0.38 * clamp01((crown - 2) / 5)) * (0.9 + 0.2 * fine);
        } else {
          k *= 0.92 + 0.14 * fine;
        }
        const wooded = hillWooded(t, along, z);
        // Under the near trees: undergrowth and fallen leaves; on the cut slope, grass.
        const base =
          crown > 0.5
            ? hillEvergreen(along, z)
              ? evergreen
              : deciduous
            : wooded > 0.5
              ? undergrowth
              : season.grass;
        let r = base[0] * k;
        let g = base[1] * k;
        let b = base[2] * k;
        if (snow > 0 && fine < 0.85 && (crown < 0.5 || fine < snow * 0.7)) {
          const lit = Math.min(1.1, k);
          r += (SNOW[0] * lit - r) * 0.85 * snow;
          g += (SNOW[1] * lit - g) * 0.85 * snow;
          b += (SNOW[2] * lit - b) * 0.85 * snow;
        }
        view.set(x, y, shade.color(r, g, b));
      }
    }
  }
}

/** Whether a point on the ground lies inside the hill of one of `tunnels`. */
export function insideTunnelHill(
  tunnels: readonly Span[],
  along: number,
  lateral: number,
): boolean {
  for (const t of tunnels) {
    if (tunnelHill(t, along, lateral) > 1.5) {
      return true;
    }
  }
  return false;
}
