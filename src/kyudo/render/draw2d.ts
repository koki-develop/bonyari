import { clamp01 } from "../../shared/core/math.ts";
import { bayer, type Surface } from "../../shared/core/surface.ts";

/** A point on the screen (art px). */
export interface P2 {
  x: number;
  y: number;
}

/**
 * Fills a tapered band from a to b with rounded ends, shading each pixel by
 * `shade(u)` where u runs -1..1 across it. Edges are smoothed by coverage;
 * `alpha` fades the whole band.
 */
export function capsule(
  view: Surface,
  a: P2,
  b: P2,
  ra: number,
  rb: number,
  shade: (u: number) => number,
  alpha = 1,
): void {
  const x0 = Math.floor(Math.min(a.x - ra, b.x - rb));
  const x1 = Math.ceil(Math.max(a.x + ra, b.x + rb));
  const y0 = Math.floor(Math.min(a.y - ra, b.y - rb));
  const y1 = Math.ceil(Math.max(a.y + ra, b.y + rb));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  for (let y = Math.max(0, y0); y <= Math.min(view.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(view.width - 1, x1); x++) {
      const qx = x + 0.5 - a.x;
      const qy = y + 0.5 - a.y;
      const t = len2 > 0 ? clamp01((qx * dx + qy * dy) / len2) : 0;
      const cx = qx - dx * t;
      const cy = qy - dy * t;
      const d = Math.hypot(cx, cy);
      const r = ra + (rb - ra) * t;
      const cover = clamp01(r + 0.5 - d);
      if (cover <= 0) {
        continue;
      }
      // Which side of the axis the pixel is on, for shading across the band.
      const sideSign = dx * cy - dy * cx >= 0 ? 1 : -1;
      const u = r > 0 ? clamp01(d / r) * sideSign : 0;
      const c = shade(u);
      const dz = (bayer(x, y) - 0.5) * 4;
      view.blend(
        x,
        y,
        (c & 255) + dz,
        ((c >>> 8) & 255) + dz,
        ((c >>> 16) & 255) + dz,
        cover * alpha,
      );
    }
  }
}
