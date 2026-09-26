import { DEG } from "../../shared/core/math.ts";

/**
 * The view is orthographic, looking down at the land from above and in
 * front at a fixed angle, so a building looks the same wherever it stands
 * and the whole world can be drawn once and kept.
 *
 * Art pixels are addressed globally: column `gx` and row `gy`, row numbers
 * growing down the screen. A world point (x, y, z) in meters lands at
 * gx = x / S and gy = -(y sin E + z cos E) / S.
 *
 * Along the ray through one pixel, a point higher up is nearer the eye, so
 * the nearest surface at a pixel is simply the highest one: depth tests
 * compare heights.
 */

/** Meters of the world per art pixel across the screen. */
export const S = 0.2;
/** How far the view looks down from level (the elevation of the eye above the land). */
export const ELEVATION = 35 * DEG;
export const SIN_E = Math.sin(ELEVATION);
export const COS_E = Math.cos(ELEVATION);
/**
 * Heading of the view for the sky: the azimuth it looks toward, measured from
 * south with west positive, as `Pinhole.heading`. It looks north-northwest,
 * so summer sunsets go down in view.
 */
export const HEADING = 160 * DEG;
/** Rows a thing moves up the screen per meter it rises. */
export const ROWS_PER_METER = COS_E / S;

/** Art pixel column of world x. */
export function gxOf(x: number): number {
  return x / S;
}

/** Art pixel row of the world point (y, z). */
export function gyOf(y: number, z: number): number {
  return -(y * SIN_E + z * COS_E) / S;
}

/** World y of the point seen at row `gy` that stands at height `z`. */
export function yAt(gy: number, z: number): number {
  return (-gy * S - z * COS_E) / SIN_E;
}

/** World x of column `gx`. */
export function xAt(gx: number): number {
  return gx * S;
}

/** A horizon-frame direction (east, north, up) in world axes (x right, y away, z up). */
export function toWorld(
  e: number,
  n: number,
  u: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const sinH = Math.sin(HEADING);
  const cosH = Math.cos(HEADING);
  // The view's right and forward directions, as in `Pinhole`.
  out.x = -e * cosH + n * sinH;
  out.y = -e * sinH - n * cosH;
  out.z = u;
  return out;
}
