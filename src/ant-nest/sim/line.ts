import type { Point } from "./geometry.ts";

/**
 * A curve sampled at even steps of at most 1 mm, walked by arc length `s`
 * from 0 to `length`. The left normal of its direction, (-ty, tx), is where
 * positive offsets `u` lie.
 */
export class Centerline {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly length: number;
  /** Arc length between samples. */
  readonly step: number;

  private constructor(xs: Float64Array, ys: Float64Array, length: number) {
    this.xs = xs;
    this.ys = ys;
    this.length = length;
    this.step = xs.length > 1 ? length / (xs.length - 1) : 1;
  }

  /** The curve through `points`, resampled evenly; the first and last points are kept exactly. */
  static through(points: readonly Point[]): Centerline {
    const n = points.length;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] =
        cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    const length = cum[n - 1];
    const count = Math.max(2, Math.ceil(length) + 1);
    const xs = new Float64Array(count);
    const ys = new Float64Array(count);
    let seg = 0;
    for (let k = 0; k < count; k++) {
      const s = (length * k) / (count - 1);
      while (seg < n - 2 && cum[seg + 1] < s) {
        seg++;
      }
      const span = cum[seg + 1] - cum[seg];
      const t = span > 0 ? Math.min(1, Math.max(0, (s - cum[seg]) / span)) : 0;
      xs[k] = points[seg].x + (points[seg + 1].x - points[seg].x) * t;
      ys[k] = points[seg].y + (points[seg + 1].y - points[seg].y) * t;
    }
    xs[0] = points[0].x;
    ys[0] = points[0].y;
    xs[count - 1] = points[n - 1].x;
    ys[count - 1] = points[n - 1].y;
    return new Centerline(xs, ys, length);
  }

  /** Index of the sample segment holding `s`, and how far along it (0..1). */
  private locate(s: number): number {
    const t = Math.min(Math.max(s, 0), this.length) / this.step;
    return Math.min(this.xs.length - 2, Math.floor(t));
  }

  x(s: number): number {
    const k = this.locate(s);
    const t = Math.min(1, Math.max(0, Math.min(Math.max(s, 0), this.length) / this.step - k));
    return this.xs[k] + (this.xs[k + 1] - this.xs[k]) * t;
  }

  y(s: number): number {
    const k = this.locate(s);
    const t = Math.min(1, Math.max(0, Math.min(Math.max(s, 0), this.length) / this.step - k));
    return this.ys[k] + (this.ys[k + 1] - this.ys[k]) * t;
  }

  /**
   * Unit direction at `s`, eased between the segments around it so that
   * something following the curve turns smoothly.
   */
  tangent(s: number, out: Point): Point {
    const t = Math.min(Math.max(s, 0), this.length) / this.step;
    const last = this.xs.length - 2;
    const k = Math.min(last, Math.floor(t));
    const f = t - k;
    // Blend the segment's direction with its neighbor's on the nearer side.
    const j = f < 0.5 ? Math.max(0, k - 1) : Math.min(last, k + 1);
    const w = f < 0.5 ? 0.5 - f : f - 0.5;
    const ax = this.xs[k + 1] - this.xs[k];
    const ay = this.ys[k + 1] - this.ys[k];
    const bx = this.xs[j + 1] - this.xs[j];
    const by = this.ys[j + 1] - this.ys[j];
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    const x = (ax / la) * (1 - w) + (bx / lb) * w;
    const y = (ay / la) * (1 - w) + (by / lb) * w;
    const l = Math.hypot(x, y) || 1;
    out.x = x / l;
    out.y = y / l;
    return out;
  }

  /** The point at `s`, offset by `u` to the left. */
  point(s: number, u: number, out: Point): Point {
    const x = this.x(s);
    const y = this.y(s);
    if (u === 0) {
      out.x = x;
      out.y = y;
      return out;
    }
    this.tangent(s, out);
    const tx = out.x;
    const ty = out.y;
    out.x = x - ty * u;
    out.y = y + tx * u;
    return out;
  }
}
