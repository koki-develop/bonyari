import type { Rect } from "../sim/geometry.ts";
import { M } from "./materials.ts";
import type { Face, Paint, TileRaster } from "./raster.ts";

/** Which way a wall faces, relative to its building: toward its street, away, or to either side. */
export type Side = "front" | "back" | "left" | "right";

/** The faces of a box to draw; any left out is not drawn. */
export interface BoxFaces {
  front?: Face;
  back?: Face;
  left?: Face;
  right?: Face;
  top?: Face;
}

/**
 * Draws a building in its own frame: `a` across its front (to the right, as
 * seen from the street), `b` back from the front, `h` up from the ground it
 * stands on, all in meters from the middle of its footprint. Wall textures
 * run u along the wall from its left end as seen from outside and v up
 * from the wall's foot; roofs run u along the ridge and v down from it.
 */
export class Builder {
  r!: TileRaster;
  private ox = 0;
  private oy = 0;
  private base = 0;
  /** Unit vectors across (right) and back, in world x and y. */
  private rx = 1;
  private ry = 0;
  private bx = 0;
  private by = 1;
  private readonly v = new Float64Array(3 * 8);

  /** Sets the frame to a footprint standing at height `base`. */
  at(r: TileRaster, rect: Rect, base: number): this {
    this.r = r;
    this.ox = rect.x;
    this.oy = rect.y;
    this.base = base;
    // The front faces (sin a, -cos a); right is that turned clockwise, back is its opposite.
    const fx = Math.sin(rect.angle);
    const fy = -Math.cos(rect.angle);
    this.rx = -fy;
    this.ry = fx;
    this.bx = -fx;
    this.by = -fy;
    return this;
  }

  /** World x, y and z of a point of the frame. */
  x(a: number, b: number): number {
    return this.ox + this.rx * a + this.bx * b;
  }

  y(a: number, b: number): number {
    return this.oy + this.ry * a + this.by * b;
  }

  z(h: number): number {
    return this.base + h;
  }

  /** Sets vertex k of the scratch polygon. */
  private vert(k: number, a: number, b: number, h: number): void {
    this.v[k * 3] = this.x(a, b);
    this.v[k * 3 + 1] = this.y(a, b);
    this.v[k * 3 + 2] = this.base + h;
  }

  /**
   * A flat polygon through frame points (a, b, h triples), textured from
   * `o` (a frame point) along the frame direction `u` (da, db, dh) and `w`.
   */
  poly(
    points: readonly number[],
    face: Face,
    o: readonly [number, number, number],
    u: readonly [number, number, number],
    w: readonly [number, number, number],
  ): void {
    const count = points.length / 3;
    for (let k = 0; k < count; k++) {
      this.vert(k, points[k * 3], points[k * 3 + 1], points[k * 3 + 2]);
    }
    const ul = Math.hypot(u[0], u[1], u[2]) || 1;
    const wl = Math.hypot(w[0], w[1], w[2]) || 1;
    this.r.polygon(
      this.v,
      count,
      face,
      this.x(o[0], o[1]),
      this.y(o[0], o[1]),
      this.base + o[2],
      (this.rx * u[0] + this.bx * u[1]) / ul,
      (this.ry * u[0] + this.by * u[1]) / ul,
      u[2] / ul,
      (this.rx * w[0] + this.bx * w[1]) / wl,
      (this.ry * w[0] + this.by * w[1]) / wl,
      w[2] / wl,
    );
  }

  /** An upright wall on one side of the box [a0, a1] × [b0, b1], from h0 to h1. */
  wall(
    side: Side,
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    h0: number,
    h1: number,
    face: Face,
  ): void {
    switch (side) {
      case "front":
        this.poly(
          [a0, b0, h0, a1, b0, h0, a1, b0, h1, a0, b0, h1],
          face,
          [a0, b0, h0],
          [1, 0, 0],
          [0, 0, 1],
        );
        break;
      case "back":
        this.poly(
          [a1, b1, h0, a0, b1, h0, a0, b1, h1, a1, b1, h1],
          face,
          [a1, b1, h0],
          [-1, 0, 0],
          [0, 0, 1],
        );
        break;
      case "left":
        this.poly(
          [a0, b1, h0, a0, b0, h0, a0, b0, h1, a0, b1, h1],
          face,
          [a0, b1, h0],
          [0, -1, 0],
          [0, 0, 1],
        );
        break;
      case "right":
        this.poly(
          [a1, b0, h0, a1, b1, h0, a1, b1, h1, a1, b0, h1],
          face,
          [a1, b0, h0],
          [0, 1, 0],
          [0, 0, 1],
        );
        break;
    }
  }

  /** A box: its walls and its top, as given. */
  box(
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    h0: number,
    h1: number,
    faces: BoxFaces,
  ): void {
    if (faces.front) {
      this.wall("front", a0, a1, b0, b1, h0, h1, faces.front);
    }
    if (faces.back) {
      this.wall("back", a0, a1, b0, b1, h0, h1, faces.back);
    }
    if (faces.left) {
      this.wall("left", a0, a1, b0, b1, h0, h1, faces.left);
    }
    if (faces.right) {
      this.wall("right", a0, a1, b0, b1, h0, h1, faces.right);
    }
    if (faces.top) {
      this.poly(
        [a0, b0, h1, a1, b0, h1, a1, b1, h1, a0, b1, h1],
        faces.top,
        [a0, b0, h1],
        [1, 0, 0],
        [0, 1, 0],
      );
    }
  }

  /**
   * A box over [a0, a1] × [b0, b1] whose bottom and top slope along b: from
   * `h0` up to `t0` at b0, and from `h1` up to `t1` at b1.
   */
  slopedBox(
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    h0: number,
    h1: number,
    t0: number,
    t1: number,
    faces: BoxFaces,
  ): void {
    if (faces.front) {
      this.wall("front", a0, a1, b0, b1, h0, t0, faces.front);
    }
    if (faces.back) {
      this.wall("back", a0, a1, b0, b1, h1, t1, faces.back);
    }
    if (faces.left) {
      this.poly(
        [a0, b1, h1, a0, b0, h0, a0, b0, t0, a0, b1, t1],
        faces.left,
        [a0, b1, Math.min(h0, h1)],
        [0, -1, 0],
        [0, 0, 1],
      );
    }
    if (faces.right) {
      this.poly(
        [a1, b0, h0, a1, b1, h1, a1, b1, t1, a1, b0, t0],
        faces.right,
        [a1, b0, Math.min(h0, h1)],
        [0, 1, 0],
        [0, 0, 1],
      );
    }
    if (faces.top) {
      this.poly(
        [a0, b0, t0, a1, b0, t0, a1, b1, t1, a0, b1, t1],
        faces.top,
        [a0, b0, t0],
        [1, 0, 0],
        [0, b1 - b0, t1 - t0],
      );
    }
  }

  /** A box with every side the same face. */
  solid(
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    h0: number,
    h1: number,
    face: Face,
    top: Face = face,
  ): void {
    this.box(a0, a1, b0, b1, h0, h1, { front: face, back: face, left: face, right: face, top });
  }

  /**
   * A gable roof over [a0, a1] × [b0, b1]: eaves at `eave`, ridge at
   * `ridge`, the ridge running along a (`alongA`) or along b; the roof
   * reaches `over` meters past the walls all round. The triangular gable
   * ends are drawn with `gable` (null leaves them open).
   */
  gable(
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    eave: number,
    ridge: number,
    alongA: boolean,
    over: number,
    roof: Face,
    gable: Face | null,
    fascia: Face | null = null,
  ): void {
    if (alongA) {
      const mid = (b0 + b1) / 2;
      const half = (b1 - b0) / 2;
      const rise = ridge - eave;
      const drop = (over * rise) / half;
      const slant = Math.hypot(half + over, rise + drop);
      const e = eave - drop;
      // Front slope, then back slope.
      this.poly(
        [
          a0 - over,
          b0 - over,
          e,
          a1 + over,
          b0 - over,
          e,
          a1 + over,
          mid,
          ridge,
          a0 - over,
          mid,
          ridge,
        ],
        roof,
        [a0 - over, mid, ridge],
        [1, 0, 0],
        [0, -(half + over) / slant, -(rise + drop) / slant],
      );
      this.poly(
        [
          a1 + over,
          b1 + over,
          e,
          a0 - over,
          b1 + over,
          e,
          a0 - over,
          mid,
          ridge,
          a1 + over,
          mid,
          ridge,
        ],
        roof,
        [a1 + over, mid, ridge],
        [-1, 0, 0],
        [0, (half + over) / slant, -(rise + drop) / slant],
      );
      if (gable) {
        this.poly(
          [a0, b1, eave, a0, b0, eave, a0, mid, ridge],
          gable,
          [a0, b1, 0],
          [0, -1, 0],
          [0, 0, 1],
        );
        this.poly(
          [a1, b0, eave, a1, b1, eave, a1, mid, ridge],
          gable,
          [a1, b0, 0],
          [0, 1, 0],
          [0, 0, 1],
        );
      }
      if (fascia) {
        const t = 0.16;
        this.poly(
          [
            a0 - over,
            b0 - over,
            e - t,
            a1 + over,
            b0 - over,
            e - t,
            a1 + over,
            b0 - over,
            e,
            a0 - over,
            b0 - over,
            e,
          ],
          fascia,
          [a0 - over, b0 - over, e - t],
          [1, 0, 0],
          [0, 0, 1],
        );
        // The barge boards: a thin board along each sloping edge at each gable.
        for (const [a, sign] of [
          [a0 - over, -1],
          [a1 + over, 1],
        ] as const) {
          for (const bEnd of [b0 - over, b1 + over]) {
            const pts =
              sign < 0 === bEnd < mid
                ? [a, mid, ridge - t, a, bEnd, e - t, a, bEnd, e, a, mid, ridge]
                : [a, bEnd, e - t, a, mid, ridge - t, a, mid, ridge, a, bEnd, e];
            this.poly(pts, { ...fascia, twoSided: true }, [a, bEnd, e - t], [0, 1, 0], [0, 0, 1]);
          }
        }
      }
    } else {
      const mid = (a0 + a1) / 2;
      const half = (a1 - a0) / 2;
      const rise = ridge - eave;
      const drop = (over * rise) / half;
      const slant = Math.hypot(half + over, rise + drop);
      const e = eave - drop;
      // Left slope, then right slope.
      this.poly(
        [
          a0 - over,
          b1 + over,
          e,
          a0 - over,
          b0 - over,
          e,
          mid,
          b0 - over,
          ridge,
          mid,
          b1 + over,
          ridge,
        ],
        roof,
        [mid, b1 + over, ridge],
        [0, -1, 0],
        [-(half + over) / slant, 0, -(rise + drop) / slant],
      );
      this.poly(
        [
          a1 + over,
          b0 - over,
          e,
          a1 + over,
          b1 + over,
          e,
          mid,
          b1 + over,
          ridge,
          mid,
          b0 - over,
          ridge,
        ],
        roof,
        [mid, b0 - over, ridge],
        [0, 1, 0],
        [(half + over) / slant, 0, -(rise + drop) / slant],
      );
      if (gable) {
        this.poly(
          [a0, b0, eave, a1, b0, eave, mid, b0, ridge],
          gable,
          [a0, b0, 0],
          [1, 0, 0],
          [0, 0, 1],
        );
        this.poly(
          [a1, b1, eave, a0, b1, eave, mid, b1, ridge],
          gable,
          [a1, b1, 0],
          [-1, 0, 0],
          [0, 0, 1],
        );
      }
      if (fascia) {
        // The barge boards: a thin board along each sloping edge at each gable.
        const t = 0.16;
        for (const b of [b0 - over, b1 + over]) {
          for (const aEnd of [a0 - over, a1 + over]) {
            const pts = [aEnd, b, e - t, mid, b, ridge - t, mid, b, ridge, aEnd, b, e];
            this.poly(pts, { ...fascia, twoSided: true }, [aEnd, b, e - t], [1, 0, 0], [0, 0, 1]);
          }
        }
      }
    }
  }

  /** A hip roof: sloping on all four sides up to a ridge along the longer side (or a point). */
  hip(
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    eave: number,
    ridge: number,
    over: number,
    roof: Face,
  ): void {
    const A0 = a0 - over;
    const A1 = a1 + over;
    const B0 = b0 - over;
    const B1 = b1 + over;
    const w = A1 - A0;
    const d = B1 - B0;
    const halfShort = Math.min(w, d) / 2;
    const rise = ridge - eave;
    const drop = (over * rise) / (halfShort - over);
    const e = eave - drop;
    const r = rise + drop;
    const midA = (A0 + A1) / 2;
    const midB = (B0 + B1) / 2;
    if (w >= d) {
      const ra0 = A0 + halfShort;
      const ra1 = A1 - halfShort;
      const slant = Math.hypot(halfShort, r);
      this.poly(
        [A0, B0, e, A1, B0, e, ra1, midB, ridge, ra0, midB, ridge],
        roof,
        [A0, midB, ridge],
        [1, 0, 0],
        [0, -halfShort / slant, -r / slant],
      );
      this.poly(
        [A1, B1, e, A0, B1, e, ra0, midB, ridge, ra1, midB, ridge],
        roof,
        [A1, midB, ridge],
        [-1, 0, 0],
        [0, halfShort / slant, -r / slant],
      );
      this.poly(
        [A0, B1, e, A0, B0, e, ra0, midB, ridge],
        roof,
        [ra0, B1, ridge],
        [0, -1, 0],
        [-halfShort / slant, 0, -r / slant],
      );
      this.poly(
        [A1, B0, e, A1, B1, e, ra1, midB, ridge],
        roof,
        [ra1, B0, ridge],
        [0, 1, 0],
        [halfShort / slant, 0, -r / slant],
      );
    } else {
      const rb0 = B0 + halfShort;
      const rb1 = B1 - halfShort;
      const slant = Math.hypot(halfShort, r);
      this.poly(
        [A0, B0, e, A1, B0, e, midA, rb0, ridge],
        roof,
        [midA, B0, ridge],
        [1, 0, 0],
        [0, -halfShort / slant, -r / slant],
      );
      this.poly(
        [A1, B1, e, A0, B1, e, midA, rb1, ridge],
        roof,
        [midA, B1, ridge],
        [-1, 0, 0],
        [0, halfShort / slant, -r / slant],
      );
      this.poly(
        [A0, B1, e, A0, B0, e, midA, rb0, ridge, midA, rb1, ridge],
        roof,
        [midA, B1, ridge],
        [0, -1, 0],
        [-halfShort / slant, 0, -r / slant],
      );
      this.poly(
        [A1, B0, e, A1, B1, e, midA, rb1, ridge, midA, rb0, ridge],
        roof,
        [midA, B0, ridge],
        [0, 1, 0],
        [halfShort / slant, 0, -r / slant],
      );
    }
  }

  /** A four-sided pyramid roof over a square, to a point at `apex`. */
  pyramid(
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    eave: number,
    apex: number,
    roof: Face,
  ): void {
    const ma = (a0 + a1) / 2;
    const mb = (b0 + b1) / 2;
    this.poly(
      [a0, b0, eave, a1, b0, eave, ma, mb, apex],
      roof,
      [ma, b0, apex],
      [1, 0, 0],
      [0, -1, -1],
    );
    this.poly(
      [a1, b1, eave, a0, b1, eave, ma, mb, apex],
      roof,
      [ma, b1, apex],
      [-1, 0, 0],
      [0, 1, -1],
    );
    this.poly(
      [a0, b1, eave, a0, b0, eave, ma, mb, apex],
      roof,
      [a0, mb, apex],
      [0, -1, 0],
      [-1, 0, -1],
    );
    this.poly(
      [a1, b0, eave, a1, b1, eave, ma, mb, apex],
      roof,
      [a1, mb, apex],
      [0, 1, 0],
      [1, 0, -1],
    );
  }

  /**
   * Something set into a wall: a window, a door, a sign. `at` is the middle
   * of its width along the wall (measured as the wall's u), `h` its foot;
   * it stands `out` meters proud of the wall.
   */
  opening(
    side: Side,
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    at: number,
    h: number,
    width: number,
    height: number,
    face: Face,
    out = 0.05,
  ): void {
    const u0 = at - width / 2;
    const u1 = at + width / 2;
    switch (side) {
      case "front":
        this.wall("front", a0 + u0, a0 + u1, b0 - out, b0, h, h + height, face);
        break;
      case "back":
        this.wall("back", a1 - u1, a1 - u0, b0, b1 + out, h, h + height, face);
        break;
      case "left":
        this.wall("left", a0 - out, a0, b1 - u1, b1 - u0, h, h + height, face);
        break;
      case "right":
        this.wall("right", a1, a1 + out, b0 + u0, b0 + u1, h, h + height, face);
        break;
    }
  }

  cylinder(
    a: number,
    b: number,
    radius: number,
    h0: number,
    h1: number,
    side: Face,
    cap: Face | null,
  ): void {
    this.r.cylinder(this.x(a, b), this.y(a, b), radius, this.base + h0, this.base + h1, side, cap);
  }

  cone(a: number, b: number, radius: number, h0: number, h1: number, face: Face): void {
    this.r.cone(this.x(a, b), this.y(a, b), radius, this.base + h0, this.base + h1, face);
  }

  line(
    a0: number,
    b0: number,
    h0: number,
    a1: number,
    b1: number,
    h1: number,
    width: number,
    face: Face,
  ): void {
    this.r.line(
      this.x(a0, b0),
      this.y(a0, b0),
      this.base + h0,
      this.x(a1, b1),
      this.y(a1, b1),
      this.base + h1,
      width,
      face,
    );
  }
}

/** A face of one material, textured by `paint` (or plain). */
export function face(
  mat: number,
  owner: number,
  paint: Paint | null = null,
  twoSided = false,
): Face {
  return { mat, owner, paint, twoSided };
}

/** A plain dark face for the insides of things seen through gaps: doorways, arches, open sheds. */
export function shadowFace(owner: number): Face {
  return { mat: M.TIMBER, owner, paint: () => (M.TIMBER << 8) | 52 };
}
