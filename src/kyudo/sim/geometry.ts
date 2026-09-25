/**
 * Ray and segment intersection with the flat and boxy parts of the dojo.
 * Positions are meters: x to the right of the shooting line, y up from the
 * ground of the range, z forward toward the targets. Rays are `o + t·d` for
 * any direction `d` (not necessarily unit); `t` is in units of `d`.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalize(v: Vec3): Vec3 {
  const l = length(v) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export const MATERIALS = [
  "lawn",
  "gravel",
  "soil",
  "sand",
  "azuchi",
  "target",
  "cloth",
  "wood",
  "hedge",
  "floor",
  "ceiling",
  "roof",
] as const;

/** What a part of the dojo is made of: how it looks, sounds and takes an arrow. */
export type Material = (typeof MATERIALS)[number];

/** The result of an intersection; reused by the caller so hot loops allocate nothing. */
export interface Hit {
  t: number;
  /** The part that was hit; null until something is. */
  prim: Prim | null;
  /** Local coordinates on the part (meters from its origin along its axes). */
  u: number;
  v: number;
  /** Surface normal facing the ray. */
  nx: number;
  ny: number;
  nz: number;
}

export function makeHit(): Hit {
  return { t: Infinity, prim: null, u: 0, v: 0, nx: 0, ny: 1, nz: 0 };
}

let nextId = 0;

/** A part of the dojo. */
export abstract class Prim {
  readonly id: number;
  readonly material: Material;
  /** A name for the renderer to tell same-material parts apart. */
  readonly name: string;

  constructor(material: Material, name: string) {
    this.id = nextId++;
    this.material = material;
    this.name = name;
  }

  /**
   * Intersects `o + t·d` for t in (tMin, out.t); on a nearer hit fills `out`
   * and returns true.
   */
  abstract intersect(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    out: Hit,
  ): boolean;
}

/**
 * A rectangle: `origin + u·U + v·V` with u in [0, |U|] and v in [0, |V|]
 * (reported in meters). U and V must be perpendicular.
 */
export class Quad extends Prim {
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** Unit axes and their lengths. */
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly lu: number;
  readonly lv: number;
  /** Unit normal U × V. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;

  constructor(material: Material, name: string, origin: Vec3, u: Vec3, v: Vec3) {
    super(material, name);
    this.ox = origin.x;
    this.oy = origin.y;
    this.oz = origin.z;
    this.lu = length(u);
    this.lv = length(v);
    this.ux = u.x / this.lu;
    this.uy = u.y / this.lu;
    this.uz = u.z / this.lu;
    this.vx = v.x / this.lv;
    this.vy = v.y / this.lv;
    this.vz = v.z / this.lv;
    const n = normalize({
      x: this.uy * this.vz - this.uz * this.vy,
      y: this.uz * this.vx - this.ux * this.vz,
      z: this.ux * this.vy - this.uy * this.vx,
    });
    this.nx = n.x;
    this.ny = n.y;
    this.nz = n.z;
  }

  intersect(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    out: Hit,
  ): boolean {
    const den = dx * this.nx + dy * this.ny + dz * this.nz;
    if (den > -1e-12 && den < 1e-12) {
      return false;
    }
    const t =
      ((this.ox - ox) * this.nx + (this.oy - oy) * this.ny + (this.oz - oz) * this.nz) / den;
    if (t <= tMin || t >= out.t) {
      return false;
    }
    const px = ox + dx * t - this.ox;
    const py = oy + dy * t - this.oy;
    const pz = oz + dz * t - this.oz;
    const u = px * this.ux + py * this.uy + pz * this.uz;
    if (u < 0 || u > this.lu) {
      return false;
    }
    const v = px * this.vx + py * this.vy + pz * this.vz;
    if (v < 0 || v > this.lv) {
      return false;
    }
    out.t = t;
    out.prim = this;
    out.u = u;
    out.v = v;
    const s = den < 0 ? 1 : -1;
    out.nx = this.nx * s;
    out.ny = this.ny * s;
    out.nz = this.nz * s;
    return true;
  }
}

/**
 * An axis-aligned box. Its local coordinates are those of the face that was
 * hit: u along the face's first axis (x, or z on the x faces) and v along the
 * second (y, or z on the y faces), measured from the box's minimum corner.
 */
export class Box extends Prim {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;

  constructor(material: Material, name: string, min: Vec3, max: Vec3) {
    super(material, name);
    this.x0 = min.x;
    this.y0 = min.y;
    this.z0 = min.z;
    this.x1 = max.x;
    this.y1 = max.y;
    this.z1 = max.z;
  }

  intersect(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    out: Hit,
  ): boolean {
    let near = -Infinity;
    let far = Infinity;
    let axis = -1;
    let sign = 0;
    // x slab
    if (dx === 0) {
      if (ox < this.x0 || ox > this.x1) {
        return false;
      }
    } else {
      const a = (this.x0 - ox) / dx;
      const b = (this.x1 - ox) / dx;
      const lo = Math.min(a, b);
      if (lo > near) {
        near = lo;
        axis = 0;
        sign = dx > 0 ? -1 : 1;
      }
      far = Math.min(far, Math.max(a, b));
    }
    if (dy === 0) {
      if (oy < this.y0 || oy > this.y1) {
        return false;
      }
    } else {
      const a = (this.y0 - oy) / dy;
      const b = (this.y1 - oy) / dy;
      const lo = Math.min(a, b);
      if (lo > near) {
        near = lo;
        axis = 1;
        sign = dy > 0 ? -1 : 1;
      }
      far = Math.min(far, Math.max(a, b));
    }
    if (dz === 0) {
      if (oz < this.z0 || oz > this.z1) {
        return false;
      }
    } else {
      const a = (this.z0 - oz) / dz;
      const b = (this.z1 - oz) / dz;
      const lo = Math.min(a, b);
      if (lo > near) {
        near = lo;
        axis = 2;
        sign = dz > 0 ? -1 : 1;
      }
      far = Math.min(far, Math.max(a, b));
    }
    if (near > far || near <= tMin || near >= out.t || axis < 0) {
      return false;
    }
    const px = ox + dx * near;
    const py = oy + dy * near;
    const pz = oz + dz * near;
    out.t = near;
    out.prim = this;
    out.nx = axis === 0 ? sign : 0;
    out.ny = axis === 1 ? sign : 0;
    out.nz = axis === 2 ? sign : 0;
    if (axis === 0) {
      out.u = pz - this.z0;
      out.v = py - this.y0;
    } else if (axis === 1) {
      out.u = px - this.x0;
      out.v = pz - this.z0;
    } else {
      out.u = px - this.x0;
      out.v = py - this.y0;
    }
    return true;
  }
}

/**
 * A flat disc facing `normal`; local coordinates are meters from the center
 * along `right` and `up` (in the disc's plane).
 */
export class Disc extends Prim {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly radius: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  readonly upx: number;
  readonly upy: number;
  readonly upz: number;

  constructor(
    material: Material,
    name: string,
    center: Vec3,
    normal: Vec3,
    right: Vec3,
    radius: number,
  ) {
    super(material, name);
    this.cx = center.x;
    this.cy = center.y;
    this.cz = center.z;
    this.radius = radius;
    const n = normalize(normal);
    const r = normalize(right);
    this.nx = n.x;
    this.ny = n.y;
    this.nz = n.z;
    this.rx = r.x;
    this.ry = r.y;
    this.rz = r.z;
    // up = right × normal: for a disc facing the viewer, right and up as the viewer sees them.
    this.upx = r.y * n.z - r.z * n.y;
    this.upy = r.z * n.x - r.x * n.z;
    this.upz = r.x * n.y - r.y * n.x;
  }

  intersect(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    out: Hit,
  ): boolean {
    const den = dx * this.nx + dy * this.ny + dz * this.nz;
    if (den > -1e-12 && den < 1e-12) {
      return false;
    }
    const t =
      ((this.cx - ox) * this.nx + (this.cy - oy) * this.ny + (this.cz - oz) * this.nz) / den;
    if (t <= tMin || t >= out.t) {
      return false;
    }
    const px = ox + dx * t - this.cx;
    const py = oy + dy * t - this.cy;
    const pz = oz + dz * t - this.cz;
    const u = px * this.rx + py * this.ry + pz * this.rz;
    const v = px * this.upx + py * this.upy + pz * this.upz;
    if (u * u + v * v > this.radius * this.radius) {
      return false;
    }
    out.t = t;
    out.prim = this;
    out.u = u;
    out.v = v;
    const s = den < 0 ? 1 : -1;
    out.nx = this.nx * s;
    out.ny = this.ny * s;
    out.nz = this.nz * s;
    return true;
  }
}

/** The nearest hit of `o + t·d`, t in (tMin, tMax), among `prims`; null if none. */
export function castRay(
  prims: readonly Prim[],
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMin: number,
  tMax: number,
  out: Hit,
): Hit | null {
  out.t = tMax;
  let found = false;
  for (let i = 0; i < prims.length; i++) {
    if (prims[i].intersect(ox, oy, oz, dx, dy, dz, tMin, out)) {
      found = true;
    }
  }
  return found ? out : null;
}

/**
 * Closest distance between segments [p0, p1] and [q0, q1], and where along
 * each it is (0..1).
 */
export function segmentDistance(
  p0: Vec3,
  p1: Vec3,
  q0: Vec3,
  q1: Vec3,
): { distance: number; s: number; t: number } {
  const ux = p1.x - p0.x;
  const uy = p1.y - p0.y;
  const uz = p1.z - p0.z;
  const vx = q1.x - q0.x;
  const vy = q1.y - q0.y;
  const vz = q1.z - q0.z;
  const wx = p0.x - q0.x;
  const wy = p0.y - q0.y;
  const wz = p0.z - q0.z;
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const den = a * c - b * b;
  let s = den > 1e-12 ? (b * e - c * d) / den : 0;
  s = Math.max(0, Math.min(1, s));
  let t = c > 1e-12 ? (b * s + e) / c : 0;
  if (t < 0 || t > 1) {
    t = Math.max(0, Math.min(1, t));
    s = a > 1e-12 ? Math.max(0, Math.min(1, (b * t - d) / a)) : 0;
  }
  const dx = wx + ux * s - vx * t;
  const dy = wy + uy * s - vy * t;
  const dz = wz + uz * s - vz * t;
  return { distance: Math.hypot(dx, dy, dz), s, t };
}
