import { pack, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../shared/core/math.ts";
import type { Environment } from "../../shared/env/environment.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import type { Shade } from "../../shared/render/shade.ts";
import {
  EAVE_Z,
  FENCE_X,
  HALL_FRONT,
  HEDGE_X0,
  RANGE_EAVE_Y,
  RANGE_EAVE_Z,
  RANGE_HALF,
  SHADOW_CASTERS,
} from "../sim/dojo.ts";
import { makeHit } from "../sim/geometry.ts";
import type { Lamp } from "./lamps.ts";

const SHADOW_HIT = makeHit();

/** Whether a solid part of the dojo stands between the point and the sun in direction l. */
export function occluded(
  x: number,
  y: number,
  z: number,
  lx: number,
  ly: number,
  lz: number,
): boolean {
  for (let k = 0; k < SHADOW_CASTERS.length; k++) {
    SHADOW_HIT.t = 200;
    if (SHADOW_CASTERS[k].intersect(x, y, z, lx, ly, lz, 0.001, SHADOW_HIT)) {
      return true;
    }
  }
  return false;
}

/**
 * How much of the sky a point with upward normal component `ny` sees: less
 * in the target house the deeper under its roof, and near the foot of the
 * hall, the fences and the hedge.
 */
export function openAt(x: number, y: number, z: number, ny: number): number {
  if (z > RANGE_EAVE_Z - 0.05 && Math.abs(x) < RANGE_HALF + 0.3 && y < RANGE_EAVE_Y) {
    // The open front lets in the sky low over the range.
    return 0.3 + 0.35 * (1 - smoothstep(0, 1.6, z - RANGE_EAVE_Z));
  }
  if (z < EAVE_Z && y > 0.3) {
    return 0.3;
  }
  let open = ny > 0.9 ? 1 : 0.62;
  if (y < 1.2) {
    // Low down, the hall, the fences and the hedge hide part of the sky.
    const low = ny > 0.9 ? 1 : 0.5;
    open *= 1 - low * (0.4 - 0.4 * smoothstep(HALL_FRONT, EAVE_Z + 2.5, z));
    open *= 1 - low * (0.3 - 0.3 * smoothstep(FENCE_X, FENCE_X + 1.5, x));
    if (x < HEDGE_X0) {
      open *= 1 - low * (0.2 - 0.2 * smoothstep(HEDGE_X0, HEDGE_X0 - 1, x));
    }
    open *= 1 - low * (0.25 - 0.25 * smoothstep(RANGE_EAVE_Z + 0.2, RANGE_EAVE_Z - 1.5, z));
  }
  return open;
}

/**
 * Adds the lamps' light at a point into `out` (channels 0..~1 per unit
 * albedo). With a normal, faces turned away get none; without one (n = 0),
 * a thin or rounded thing gets about half.
 */
export function lampLight(
  lamps: readonly Lamp[],
  level: number,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  out: [number, number, number],
): void {
  if (level <= 0.001) {
    return;
  }
  const hasNormal = nx !== 0 || ny !== 0 || nz !== 0;
  for (const lamp of lamps) {
    const dx = lamp.x - x;
    const dy = lamp.y - y;
    const dz = lamp.z - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const d = Math.sqrt(d2);
    const cosN = hasNormal ? (nx * dx + ny * dy + nz * dz) / d : 0.5;
    if (cosN <= 0) {
      continue;
    }
    const cosA = -(lamp.ax * dx + lamp.ay * dy + lamp.az * dz) / d;
    const beam = smoothstep(lamp.cone - lamp.soft, lamp.cone + lamp.soft * 0.6, cosA);
    if (beam <= 0) {
      continue;
    }
    const e = (cosN * beam * level) / Math.max(0.35, d2);
    out[0] += lamp.r * e;
    out[1] += lamp.g * e;
    out[2] += lamp.b * e;
  }
}

/**
 * Lights small things in the dojo (arrows, people, birds) the way the scene
 * lights its surfaces: sky, sun unless something shades them, and lamps.
 */
export class Illuminator {
  private shade!: Shade;
  private lamps: readonly Lamp[] = [];
  private level = 0;
  private direct = 0;
  private lx = 0;
  private ly = 1;
  private lz = 0;
  private readonly lampRgb: [number, number, number] = [0, 0, 0];
  private bounce = 0;
  /** Sky and sun light at the last `at`, and the lamps' light (applied past the fog). */
  private k = 1;

  begin(
    env: Environment,
    cam: Pinhole,
    light: Lighting,
    shade: Shade,
    lamps: readonly Lamp[],
    level: number,
  ): void {
    this.shade = shade;
    this.lamps = lamps;
    this.level = level;
    const sun = cam.toCamera(env.sky.sun);
    this.lx = sun.right;
    this.ly = sun.up;
    this.lz = sun.forward;
    this.direct = sun.up > 0.005 ? light.direct : 0;
    this.bounce = 0.22 * light.daylight + 0.3 * this.direct;
  }

  /**
   * Prepares the light at a point for a surface whose normal leans up by `ny`
   * (-1..1). `open` overrides how much sky it sees.
   */
  at(x: number, y: number, z: number, ny = 0.3, open = openAt(x, y, z, ny)): this {
    const direct = this.direct;
    const hemi = 0.5 + 0.5 * ny;
    let k =
      ((1 - direct) * (0.72 + 0.36 * hemi) + direct * (0.48 + 0.2 * hemi)) * (0.3 + 0.7 * open) +
      // Light thrown back from the sunlit range onto things turned toward it.
      this.bounce * 0.35;
    if (direct > 0.01 && !occluded(x, y + 0.02, z, this.lx, this.ly, this.lz)) {
      // A rounded thing: about half its surface faces the sun.
      k += direct * 0.78 * 0.55 * clamp01(0.4 + 0.6 * this.ly);
    }
    this.k = k;
    this.shade.at(z);
    const rgb = this.lampRgb;
    rgb[0] = 0;
    rgb[1] = 0;
    rgb[2] = 0;
    lampLight(this.lamps, this.level, x, y, z, 0, 0, 0, rgb);
    const clear = 1 - this.shade.f;
    rgb[0] *= clear;
    rgb[1] *= clear;
    rgb[2] *= clear;
    return this;
  }

  /** A color lit at the prepared point, brightened by `k`, packed. */
  color(c: RGB, k = 1): number {
    return pack(this.r(c[0] * k), this.g(c[1] * k), this.b(c[2] * k));
  }

  r(v: number): number {
    return this.shade.litR(v * this.k) + v * this.lampRgb[0];
  }

  g(v: number): number {
    return this.shade.litG(v * this.k) + v * this.lampRgb[1];
  }

  b(v: number): number {
    return this.shade.litB(v * this.k) + v * this.lampRgb[2];
  }
}
