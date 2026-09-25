import type { Pinhole } from "../../shared/render/pinhole.ts";
import { EYE } from "../sim/dojo.ts";
import { Box, Disc, type Prim, Quad } from "../sim/geometry.ts";

/** Nearest depth (m) drawn. */
export const NEAR = 0.05;

type Point = [number, number, number];

/** One flat face of a part: its plane (n · p = d), outline, and how to read coordinates on it. */
export interface Face {
  /** Index of the part it belongs to. */
  prim: number;
  nx: number;
  ny: number;
  nz: number;
  d: number;
  polygon: readonly Point[];
  /** For a box, which axis the face is across (0 x, 1 y, 2 z); -1 otherwise. */
  axis: number;
  /** A disc is only the round part of its square outline. */
  disc: Disc | null;
  /** Box faces show only from outside; flat parts from either side. */
  oneSided: boolean;
}

function plane(
  prim: number,
  polygon: Point[],
  nx: number,
  ny: number,
  nz: number,
  axis: number,
  disc: Disc | null,
  oneSided: boolean,
): Face {
  const [x, y, z] = polygon[0];
  return { prim, nx, ny, nz, d: nx * x + ny * y + nz * z, polygon, axis, disc, oneSided };
}

/** The faces of every part. */
export function facesOf(prims: readonly Prim[]): Face[] {
  const faces: Face[] = [];
  prims.forEach((p, k) => {
    if (p instanceof Quad) {
      const at = (a: number, b: number): Point => [
        p.ox + p.ux * a + p.vx * b,
        p.oy + p.uy * a + p.vy * b,
        p.oz + p.uz * a + p.vz * b,
      ];
      faces.push(
        plane(
          k,
          [at(0, 0), at(p.lu, 0), at(p.lu, p.lv), at(0, p.lv)],
          p.nx,
          p.ny,
          p.nz,
          -1,
          null,
          false,
        ),
      );
    } else if (p instanceof Box) {
      const { x0, y0, z0, x1, y1, z1 } = p;
      faces.push(
        plane(
          k,
          [
            [x0, y0, z0],
            [x0, y1, z0],
            [x0, y1, z1],
            [x0, y0, z1],
          ],
          -1,
          0,
          0,
          0,
          null,
          true,
        ),
      );
      faces.push(
        plane(
          k,
          [
            [x1, y0, z0],
            [x1, y1, z0],
            [x1, y1, z1],
            [x1, y0, z1],
          ],
          1,
          0,
          0,
          0,
          null,
          true,
        ),
      );
      faces.push(
        plane(
          k,
          [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y0, z1],
            [x0, y0, z1],
          ],
          0,
          -1,
          0,
          1,
          null,
          true,
        ),
      );
      faces.push(
        plane(
          k,
          [
            [x0, y1, z0],
            [x1, y1, z0],
            [x1, y1, z1],
            [x0, y1, z1],
          ],
          0,
          1,
          0,
          1,
          null,
          true,
        ),
      );
      faces.push(
        plane(
          k,
          [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y1, z0],
            [x0, y1, z0],
          ],
          0,
          0,
          -1,
          2,
          null,
          true,
        ),
      );
      faces.push(
        plane(
          k,
          [
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1],
          ],
          0,
          0,
          1,
          2,
          null,
          true,
        ),
      );
    } else if (p instanceof Disc) {
      const r = p.radius;
      const at = (a: number, b: number): Point => [
        p.cx + p.rx * a + p.upx * b,
        p.cy + p.ry * a + p.upy * b,
        p.cz + p.rz * a + p.upz * b,
      ];
      faces.push(
        plane(k, [at(-r, -r), at(r, -r), at(r, r), at(-r, r)], p.nx, p.ny, p.nz, -1, p, false),
      );
    }
  });
  return faces;
}

/** The part of a convex polygon in front of the eye (z ≥ NEAR). */
function clipToFront(polygon: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const aIn = a[2] >= NEAR;
    const bIn = b[2] >= NEAR;
    if (aIn) {
      out.push(a);
    }
    if (aIn !== bIn) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  }
  return out;
}

/**
 * Draws faces into a depth buffer: which face is nearest at each pixel, and
 * its depth. A pixel belongs to a face when the ray through the pixel's center
 * meets it, as a ray tracer would decide; the depth on a plane follows from
 * the plane, so each pixel costs one division. Faces marked in `skip` are
 * left out.
 */
export function rasterize(
  cam: Pinhole,
  faces: readonly Face[],
  face: Int16Array,
  depth: Float32Array,
  width: number,
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  skip: Uint8Array | null = null,
): void {
  for (let y = ry0; y < ry1; y++) {
    const row = y * width;
    face.fill(-1, row + rx0, row + rx1);
    depth.fill(Infinity, row + rx0, row + rx1);
  }
  const f = cam.focal;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let fi = 0; fi < faces.length; fi++) {
    if (skip && skip[fi]) {
      continue;
    }
    const fc = faces[fi];
    // Seen from behind (the eye on the inner side of its plane): hidden by the box's other faces.
    if (fc.oneSided && fc.ny * EYE - fc.d <= 0) {
      continue;
    }
    const poly = clipToFront(fc.polygon);
    if (poly.length < 3) {
      continue;
    }
    xs.length = 0;
    ys.length = 0;
    let top = Infinity;
    let bottom = -Infinity;
    for (const [x, py, z] of poly) {
      const sx = cam.x(x, z);
      const sy = cam.y(z, py);
      xs.push(sx);
      ys.push(sy);
      top = Math.min(top, sy);
      bottom = Math.max(bottom, sy);
    }
    // Rows whose pixel centers the outline spans.
    const yStart = Math.max(ry0, Math.ceil(top - 0.5));
    const yEnd = Math.min(ry1 - 1, Math.floor(bottom - 0.5));
    // Depth on the plane: t = (d − n·eye) / (n · dir), dir = ((x+½−cx)/f, (horizon−y−½)/f, 1).
    const num = fc.d - fc.ny * EYE;
    const disc = fc.disc;
    for (let y = yStart; y <= yEnd; y++) {
      const cy = y + 0.5;
      // Where the row crosses the outline (convex: an interval).
      let left = Infinity;
      let right = -Infinity;
      const n = xs.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ya = ys[i];
        const yb = ys[j];
        if ((ya <= cy && yb > cy) || (yb <= cy && ya > cy)) {
          const x = xs[i] + ((cy - ya) / (yb - ya)) * (xs[j] - xs[i]);
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
      if (left > right) {
        continue;
      }
      const xStart = Math.max(rx0, Math.ceil(left - 0.5));
      const xEnd = Math.min(rx1 - 1, Math.floor(right - 0.5));
      const dy = (cam.horizon - cy) / f;
      const rowDen = fc.ny * dy + fc.nz;
      const row = y * width;
      for (let x = xStart; x <= xEnd; x++) {
        const dx = (x + 0.5 - cam.cx) / f;
        const den = fc.nx * dx + rowDen;
        if (den === 0) {
          continue;
        }
        const t = num / den;
        const i = row + x;
        if (t < NEAR || t >= depth[i]) {
          continue;
        }
        if (disc) {
          const px = dx * t - disc.cx;
          const py = EYE + dy * t - disc.cy;
          const pz = t - disc.cz;
          const u = px * disc.rx + py * disc.ry + pz * disc.rz;
          const v = px * disc.upx + py * disc.upy + pz * disc.upz;
          if (u * u + v * v > disc.radius * disc.radius) {
            continue;
          }
        }
        depth[i] = t;
        face[i] = fi;
      }
    }
  }
}

/**
 * Local coordinates on part `p` at world point (x, y, z) of face `fc`, as the
 * part's own intersection reports them.
 */
export function coordinates(
  p: Prim,
  fc: Face,
  x: number,
  y: number,
  z: number,
  out: [number, number],
): void {
  if (p instanceof Quad) {
    const qx = x - p.ox;
    const qy = y - p.oy;
    const qz = z - p.oz;
    out[0] = qx * p.ux + qy * p.uy + qz * p.uz;
    out[1] = qx * p.vx + qy * p.vy + qz * p.vz;
  } else if (p instanceof Box) {
    if (fc.axis === 0) {
      out[0] = z - p.z0;
      out[1] = y - p.y0;
    } else if (fc.axis === 1) {
      out[0] = x - p.x0;
      out[1] = z - p.z0;
    } else {
      out[0] = x - p.x0;
      out[1] = y - p.y0;
    }
  } else if (p instanceof Disc) {
    const qx = x - p.cx;
    const qy = y - p.cy;
    const qz = z - p.cz;
    out[0] = qx * p.rx + qy * p.ry + qz * p.rz;
    out[1] = qx * p.upx + qy * p.upy + qz * p.upz;
  }
}
