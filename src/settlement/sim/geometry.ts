import type { Point } from "./terrain.ts";

/**
 * A rectangle on the ground: its middle, the way its front faces (radians,
 * 0 = toward -y, the viewer; counterclockwise seen from above), its width
 * across the front and its depth back from it.
 */
export interface Rect {
  x: number;
  y: number;
  angle: number;
  width: number;
  depth: number;
}

/** Unit vector the front of a rect with `angle` faces. */
export function facing(angle: number): Point {
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}

/** A point `across` (m, to the right seen from the front) and `back` (m, behind the middle) in a rect. */
export function rectPoint(r: Rect, across: number, back: number): Point {
  const f = facing(r.angle);
  // Right, seen from in front looking at the rect, is the front direction turned clockwise.
  const rx = -f.y;
  const ry = f.x;
  return { x: r.x + rx * across - f.x * back, y: r.y + ry * across - f.y * back };
}

/** The corners of a rect, counterclockwise from the front left. */
export function rectCorners(r: Rect, margin = 0): Point[] {
  const w = r.width / 2 + margin;
  const d = r.depth / 2 + margin;
  return [rectPoint(r, -w, -d), rectPoint(r, w, -d), rectPoint(r, w, d), rectPoint(r, -w, d)];
}

/** Whether (x, y) lies within `r` grown by `margin`. */
export function inRect(r: Rect, x: number, y: number, margin = 0): boolean {
  const dx = x - r.x;
  const dy = y - r.y;
  // Far outside, whichever way the rect is turned: no need to turn the point into its frame.
  const reach = (r.width + r.depth) / 2 + margin;
  if (Math.abs(dx) > reach || Math.abs(dy) > reach) {
    return false;
  }
  const f = facing(r.angle);
  // Components along the front direction and across it.
  const along = dx * f.x + dy * f.y;
  const across = dx * -f.y + dy * f.x;
  return Math.abs(across) <= r.width / 2 + margin && Math.abs(along) <= r.depth / 2 + margin;
}

/** Whether two rects, each grown by `margin`, overlap (separating axis test). */
export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  const ca = rectCorners(a, margin / 2);
  const cb = rectCorners(b, margin / 2);
  for (const r of [a, b]) {
    const f = facing(r.angle);
    for (const axis of [f, { x: -f.y, y: f.x }]) {
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const p of ca) {
        const v = p.x * axis.x + p.y * axis.y;
        aMin = Math.min(aMin, v);
        aMax = Math.max(aMax, v);
      }
      for (const p of cb) {
        const v = p.x * axis.x + p.y * axis.y;
        bMin = Math.min(bMin, v);
        bMax = Math.max(bMax, v);
      }
      if (aMax < bMin || bMax < aMin) {
        return false;
      }
    }
  }
  return true;
}

/** Distance from (x, y) to the segment a–b, and how far along it (0..1) the nearest point is. */
export function segmentDistance(
  x: number,
  y: number,
  a: Point,
  b: Point,
): { distance: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
  return { distance: Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)), t };
}

/** Distance from (x, y) to a polyline, with the index of the nearest segment and how far along it. */
export function polylineDistance(
  x: number,
  y: number,
  points: readonly Point[],
): { distance: number; segment: number; t: number } {
  let best = { distance: Infinity, segment: 0, t: 0 };
  for (let i = 0; i + 1 < points.length; i++) {
    const d = segmentDistance(x, y, points[i], points[i + 1]);
    if (d.distance < best.distance) {
      best = { distance: d.distance, segment: i, t: d.t };
    }
  }
  return best;
}

/** Whether a rect, grown by `margin`, comes within `half` of a polyline. */
export function rectNearPolyline(
  r: Rect,
  points: readonly Point[],
  half: number,
  margin = 0,
): boolean {
  const reach = Math.hypot(r.width, r.depth) / 2 + margin + half;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (segmentDistance(r.x, r.y, a, b).distance > reach) {
      continue;
    }
    // Sample the segment finely against the rect.
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 0.5));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (inRect(r, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, margin + half)) {
        return true;
      }
    }
  }
  return false;
}

/** How far along a polyline (m from its start) its point nearest (x, y) lies. */
export function stationOf(x: number, y: number, points: readonly Point[]): number {
  const near = polylineDistance(x, y, points);
  let s = 0;
  for (let i = 0; i < near.segment; i++) {
    s += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  const a = points[near.segment];
  const b = points[Math.min(points.length - 1, near.segment + 1)];
  return s + Math.hypot(b.x - a.x, b.y - a.y) * near.t;
}

/** Length of a polyline. */
export function polylineLength(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    sum += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return sum;
}

/** The point and unit direction `s` meters along a polyline (clamped to its ends). */
export function alongPolyline(
  points: readonly Point[],
  s: number,
): { x: number; y: number; dx: number; dy: number } {
  let left = Math.max(0, s);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len || i + 2 === points.length) {
      const t = len > 0 ? Math.min(1, left / len) : 0;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        dx: len > 0 ? (b.x - a.x) / len : 1,
        dy: len > 0 ? (b.y - a.y) / len : 0,
      };
    }
    left -= len;
  }
  const p = points[0];
  return { x: p.x, y: p.y, dx: 1, dy: 0 };
}

/**
 * A smooth curve through `controls` (centripetal-free Catmull–Rom), sampled
 * about every `step` meters.
 */
export function spline(controls: readonly Point[], step: number): Point[] {
  const out: Point[] = [];
  const n = controls.length;
  for (let i = 0; i + 1 < n; i++) {
    const p0 = controls[Math.max(0, i - 1)];
    const p1 = controls[i];
    const p2 = controls[i + 1];
    const p3 = controls[Math.min(n - 1, i + 2)];
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push({ ...controls[n - 1] });
  return out;
}

/** Whether (x, y) is inside a closed polygon (even–odd rule). */
export function inPolygon(x: number, y: number, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance from (x, y) to the edge of a closed polygon. */
export function polygonEdgeDistance(x: number, y: number, poly: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, segmentDistance(x, y, poly[i], poly[(i + 1) % poly.length]).distance);
  }
  return best;
}

/** Where segment a–b crosses segment c–d, or null. */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) {
    return null;
  }
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + r.x * t, y: a.y + r.y * t } : null;
}
