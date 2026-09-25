import type { Pinhole } from "../../shared/render/pinhole.ts";
import type { DepthSurface } from "./depth.ts";

/** Nearest depth (m) drawn; nearer points are behind the eye or too close to show. */
const NEAR = 0.1;

/** A point on the screen with its depth, or null when it is behind the eye. */
export interface Projected {
  x: number;
  y: number;
  z: number;
}

export function project(
  cam: Pinhole,
  x: number,
  y: number,
  z: number,
  out: Projected,
): Projected | null {
  if (z < NEAR) {
    return null;
  }
  out.x = cam.x(x, z);
  out.y = cam.y(z, y);
  out.z = z;
  return out;
}

/**
 * Paints a round rod from a to b (m), `radius` thick, with the color given per
 * point along it by `color(t, out)` as channels 0..255 in `out`. Rods thinner
 * than a pixel are drawn faint rather than wide, but no fainter than
 * `minCover`, so small things stay in sight. `alpha` fades the whole rod.
 */
export function rod(
  view: DepthSurface,
  cam: Pinhole,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  alpha: number,
  color: (t: number, out: [number, number, number]) => void,
  minCover = 0,
): void {
  // Clip to the near plane.
  if (az < NEAR && bz < NEAR) {
    return;
  }
  let t0 = 0;
  let t1 = 1;
  if (az < NEAR) {
    t0 = (NEAR - az) / (bz - az);
  } else if (bz < NEAR) {
    t1 = (NEAR - az) / (bz - az);
  }
  const za = az + (bz - az) * t0;
  const zb = az + (bz - az) * t1;
  const sx0 = cam.x(ax + (bx - ax) * t0, za);
  const sy0 = cam.y(za, ay + (by - ay) * t0);
  const sx1 = cam.x(ax + (bx - ax) * t1, zb);
  const sy1 = cam.y(zb, ay + (by - ay) * t1);
  // Only the stretch on the screen (with room for the rod's width) is drawn:
  // a rod passing close to the eye can reach far beyond it.
  const pad = (2 * radius * cam.focal) / Math.min(za, zb) + 2;
  const [k0, k1] = clipSegment(sx0, sy0, sx1, sy1, -pad, -pad, view.width + pad, view.height + pad);
  if (k0 > k1) {
    return;
  }
  const len = Math.hypot(sx1 - sx0, sy1 - sy0) * (k1 - k0);
  // Thin rods are stepped every two thirds of a pixel; thick ones by a share
  // of their width, their round stamps overlapping.
  const zNear = 1 / ((1 - k0) / za + k0 / zb);
  const zFar = 1 / ((1 - k1) / za + k1 / zb);
  const thinnest = (2 * radius * cam.focal) / Math.max(zNear, zFar);
  const steps = Math.max(1, Math.ceil(len / Math.max(0.66, thinnest * 0.35)));
  const rgb: [number, number, number] = [0, 0, 0];
  for (let s = 0; s <= steps; s++) {
    // Perspective-correct parameter along the rod for this screen step.
    const k = k0 + ((k1 - k0) * s) / steps;
    const zs = 1 / ((1 - k) / za + k / zb);
    const zt = Math.abs(bz - az) > 1e-9 ? (zs - az) / (bz - az) : t0 + (t1 - t0) * k;
    const t = Math.max(0, Math.min(1, zt));
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    const px = cam.x(x, z);
    const py = cam.y(z, y);
    const width = (2 * radius * cam.focal) / z;
    color(t, rgb);
    view.z = z;
    if (width <= 1) {
      // Thinner than a pixel: as much color as it covers, spread over two pixels;
      // each step stands for its share of the rod's length on the screen.
      const a = alpha * Math.max(minCover, width) * Math.min(1, Math.max(len, 1) / steps);
      const fx = px - 0.5;
      const ix = Math.floor(fx);
      const w = fx - ix;
      view.blend(ix, py, rgb[0], rgb[1], rgb[2], a * (1 - w));
      view.blend(ix + 1, py, rgb[0], rgb[1], rgb[2], a * w);
    } else {
      const half = width / 2;
      for (let yy = Math.floor(py - half); yy <= Math.floor(py + half); yy++) {
        for (let xx = Math.floor(px - half); xx <= Math.floor(px + half); xx++) {
          const d = Math.hypot(xx + 0.5 - px, yy + 0.5 - py);
          const cover = Math.max(0, Math.min(1, half + 0.5 - d));
          if (cover > 0) {
            view.blend(xx, yy, rgb[0], rgb[1], rgb[2], alpha * cover);
          }
        }
      }
    }
  }
}

/** A soft round spot of light or color at a point, `radius` m across its core. */
export function spot(
  view: DepthSurface,
  cam: Pinhole,
  x: number,
  y: number,
  z: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  if (z < NEAR) {
    return;
  }
  const px = cam.x(x, z);
  const py = cam.y(z, y);
  const rad = (radius * cam.focal) / z;
  view.z = z;
  if (rad < 0.7) {
    view.blend(px, py, r, g, b, alpha * Math.min(1, rad * rad * 2 + 0.25));
    return;
  }
  for (let yy = Math.floor(py - rad); yy <= Math.ceil(py + rad); yy++) {
    for (let xx = Math.floor(px - rad); xx <= Math.ceil(px + rad); xx++) {
      const d = Math.hypot(xx + 0.5 - px, yy + 0.5 - py);
      const cover = Math.max(0, Math.min(1, rad + 0.5 - d));
      if (cover > 0) {
        view.blend(xx, yy, r, g, b, alpha * cover);
      }
    }
  }
}

/**
 * The part [k0, k1] of the screen segment from (x0, y0) to (x1, y1) inside
 * the rectangle, as fractions of the segment; k0 > k1 when none of it is.
 */
function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): [number, number] {
  let k0 = 0;
  let k1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const edges: readonly (readonly [number, number])[] = [
    [-dx, x0 - left],
    [dx, right - x0],
    [-dy, y0 - top],
    [dy, bottom - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) {
        return [1, 0];
      }
      continue;
    }
    const r = q / p;
    if (p < 0) {
      k0 = Math.max(k0, r);
    } else {
      k1 = Math.min(k1, r);
    }
  }
  return [k0, k1];
}
