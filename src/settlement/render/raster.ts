import { NOTHING, TILE, type Tile } from "./gbuffer.ts";
import { COS_E, S, SIN_E } from "./projection.ts";

/**
 * Paints a surface at a point: gets the face coordinates (u across, v up or
 * down the face, meters) and the world position, and returns the material
 * and texture brightness packed as `(material << 8) | detail` (128 is the
 * material's own brightness).
 */
export type Paint = (u: number, v: number, x: number, y: number, z: number) => number;

/** What a drawn surface is and whom it belongs to. */
export interface Face {
  mat: number;
  /** Building or field it belongs to (0 for none). */
  owner: number;
  paint: Paint | null;
  /** Drawn from either side (cloth, fences, thin boards). */
  twoSided?: boolean;
}

/** Packs a material and detail brightness as a `Paint` returns them. */
export function packed(mat: number, detail = 128): number {
  return (mat << 8) | (detail < 0 ? 0 : detail > 255 ? 255 : detail | 0);
}

/** Direction the eye looks along (into the scene), in world axes. */
const VIEW_Y = COS_E;
const VIEW_Z = -SIN_E;

/**
 * Draws surfaces into one tile at a time. Every primitive is cast pixel by
 * pixel: the ray through a pixel's center meets the surface at some height,
 * and the surface is kept there if it is higher (nearer) than what is.
 *
 * Positions are world meters; `gx0`/`gy0` is the tile's first art pixel.
 */
export class TileRaster {
  tile!: Tile;
  gx0 = 0;
  gy0 = 0;
  /** Scratch: projected vertices of the polygon being drawn. */
  private sx = new Float64Array(16);
  private sy = new Float64Array(16);

  begin(tile: Tile): void {
    this.tile = tile;
    this.gx0 = tile.tx * TILE;
    this.gy0 = tile.ty * TILE;
    tile.clear();
  }

  /** Keeps a surface point at local pixel i if it is higher than what is there. */
  put(i: number, z: number, pack: number, nx: number, ny: number, nz: number, owner: number): void {
    const t = this.tile;
    if (z <= t.z[i]) {
      return;
    }
    t.z[i] = z;
    t.mat[i] = pack >>> 8;
    t.detail[i] = pack & 255;
    t.nx[i] = Math.round(nx * 127);
    t.ny[i] = Math.round(ny * 127);
    t.nz[i] = Math.round(nz * 127);
    t.owner[i] = owner;
  }

  /** Height already drawn at local pixel i. */
  heightAt(i: number): number {
    return this.tile.z[i];
  }

  /**
   * A flat convex polygon: `v` holds `count` world vertices as x, y, z
   * triples. Texture coordinates run from `o` along the unit vectors `u`
   * and `w` in the polygon's plane.
   */
  polygon(
    v: ArrayLike<number>,
    count: number,
    face: Face,
    ox = v[0],
    oy = v[1],
    oz = v[2],
    ux = 1,
    uy = 0,
    uz = 0,
    wx = 0,
    wy = 0,
    wz = 1,
  ): void {
    // Newell's normal.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const ax = v[i * 3];
      const ay = v[i * 3 + 1];
      const az = v[i * 3 + 2];
      const bx = v[j * 3];
      const by = v[j * 3 + 1];
      const bz = v[j * 3 + 2];
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) {
      return;
    }
    nx /= len;
    ny /= len;
    nz /= len;
    // The eye looks along (0, VIEW_Y, VIEW_Z): no part across.
    let facingEye = ny * VIEW_Y + nz * VIEW_Z;
    if (facingEye > -1e-4) {
      if (!face.twoSided || facingEye < 1e-4) {
        return;
      }
      nx = -nx;
      ny = -ny;
      nz = -nz;
      facingEye = -facingEye;
    }
    // Height at a pixel is linear in its column and row: z = A gx + B gy + C.
    const d = nx * v[0] + ny * v[1] + nz * v[2];
    const den = nz - (ny * COS_E) / SIN_E;
    const A = (-nx * S) / den;
    const B = (ny * S) / (SIN_E * den);
    const C = d / den;
    if (count > this.sx.length) {
      this.sx = new Float64Array(count * 2);
      this.sy = new Float64Array(count * 2);
    }
    const sx = this.sx;
    const sy = this.sy;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let area = 0;
    for (let i = 0; i < count; i++) {
      const x = v[i * 3] / S - this.gx0;
      const y = -(v[i * 3 + 1] * SIN_E + v[i * 3 + 2] * COS_E) / S - this.gy0;
      sx[i] = x;
      sy[i] = y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      area += sx[i] * sy[j] - sx[j] * sy[i];
    }
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(TILE - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(TILE - 1, Math.ceil(maxY));
    if (x0 > x1 || y0 > y1 || Math.abs(area) < 1e-9) {
      return;
    }
    const sign = area > 0 ? 1 : -1;
    const paint = face.paint;
    const base = (face.mat << 8) | 128;
    const tile = this.tile;
    for (let py = y0; py <= y1; py++) {
      const cy = py + 0.5;
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        let inside = true;
        for (let i = 0; i < count; i++) {
          const j = (i + 1) % count;
          const e = (sx[j] - sx[i]) * (cy - sy[i]) - (sy[j] - sy[i]) * (cx - sx[i]);
          if (e * sign < 0) {
            inside = false;
            break;
          }
        }
        if (!inside) {
          continue;
        }
        const gx = px + this.gx0 + 0.5;
        const gy = py + this.gy0 + 0.5;
        const z = A * gx + B * gy + C;
        const i = py * TILE + px;
        if (z <= tile.z[i]) {
          continue;
        }
        let pack = base;
        if (paint) {
          const x = gx * S;
          const y = (-gy * S - z * COS_E) / SIN_E;
          const dx = x - ox;
          const dy = y - oy;
          const dz = z - oz;
          pack = paint(dx * ux + dy * uy + dz * uz, dx * wx + dy * wy + dz * wz, x, y, z);
          if (pack < 0) {
            continue;
          }
        }
        this.put(i, z, pack, nx, ny, nz, face.owner);
      }
    }
  }

  /**
   * An upright cylinder standing on (cx, cy) from height z0 to z1, with a
   * flat top if `cap`. Its side is painted with u around it (m) and v up it.
   */
  cylinder(
    cx: number,
    cy: number,
    r: number,
    z0: number,
    z1: number,
    side: Face,
    cap: Face | null,
  ): void {
    const gxa = Math.floor((cx - r) / S) - this.gx0;
    const gxb = Math.ceil((cx + r) / S) - this.gx0;
    const gyTop = Math.floor(-((cy + r) * SIN_E + z1 * COS_E) / S) - this.gy0;
    const gyBottom = Math.ceil(-((cy - r) * SIN_E + z0 * COS_E) / S) - this.gy0;
    const x0 = Math.max(0, gxa);
    const x1 = Math.min(TILE - 1, gxb);
    const y0 = Math.max(0, gyTop);
    const y1 = Math.min(TILE - 1, gyBottom);
    const tile = this.tile;
    for (let px = x0; px <= x1; px++) {
      const x = (px + this.gx0 + 0.5) * S;
      const dx = x - cx;
      if (Math.abs(dx) > r) {
        continue;
      }
      const half = Math.sqrt(r * r - dx * dx);
      const yFront = cy - half;
      for (let py = y0; py <= y1; py++) {
        const gy = py + this.gy0 + 0.5;
        const i = py * TILE + px;
        // The flat top, if the ray comes down through it.
        if (cap) {
          const y = (-gy * S - z1 * COS_E) / SIN_E;
          if (dx * dx + (y - cy) * (y - cy) <= r * r) {
            if (z1 > tile.z[i]) {
              const pack = cap.paint ? cap.paint(dx, y - cy, x, y, z1) : (cap.mat << 8) | 128;
              if (pack >= 0) {
                this.put(i, z1, pack, 0, 0, 1, cap.owner);
              }
            }
            continue;
          }
        }
        const z = (-gy * S - yFront * SIN_E) / COS_E;
        if (z < z0 || z > z1 || z <= tile.z[i]) {
          continue;
        }
        const angle = Math.atan2(dx, -(yFront - cy));
        const pack = side.paint
          ? side.paint(angle * r, z - z0, x, yFront, z)
          : (side.mat << 8) | 128;
        if (pack >= 0) {
          this.put(i, z, pack, dx / r, (yFront - cy) / r, 0, side.owner);
        }
      }
    }
  }

  /**
   * An upright cone: base radius `r` at height z0 on (cx, cy), its tip at
   * z1. Painted with u around it (m at the base) and v down from the tip.
   */
  cone(cx: number, cy: number, r: number, z0: number, z1: number, face: Face): void {
    const h = z1 - z0;
    const k = r / h;
    const x0 = Math.max(0, Math.floor((cx - r) / S) - this.gx0);
    const x1 = Math.min(TILE - 1, Math.ceil((cx + r) / S) - this.gx0);
    const y0 = Math.max(0, Math.floor(-((cy + r) * SIN_E + z1 * COS_E) / S) - this.gy0);
    const y1 = Math.min(TILE - 1, Math.ceil(-((cy - r) * SIN_E + z0 * COS_E) / S) - this.gy0);
    const tile = this.tile;
    const k2 = k * k;
    const qa = COS_E * COS_E - k2 * SIN_E * SIN_E;
    for (let px = x0; px <= x1; px++) {
      const x = (px + this.gx0 + 0.5) * S;
      const dx = x - cx;
      if (Math.abs(dx) > r) {
        continue;
      }
      for (let py = y0; py <= y1; py++) {
        const gy = py + this.gy0 + 0.5;
        // The ray: y = yb + t cos E, z = zb - t sin E.
        const yb = -gy * S * SIN_E;
        const zb = -gy * S * COS_E;
        const Y0 = yb - cy;
        const Z0 = z1 - zb;
        const qb = 2 * (Y0 * COS_E - k2 * Z0 * SIN_E);
        const qc = dx * dx + Y0 * Y0 - k2 * Z0 * Z0;
        let t: number;
        if (Math.abs(qa) < 1e-9) {
          t = -qc / qb;
        } else {
          const disc = qb * qb - 4 * qa * qc;
          if (disc < 0) {
            continue;
          }
          const sq = Math.sqrt(disc);
          const ta = (-qb - sq) / (2 * qa);
          const tb = (-qb + sq) / (2 * qa);
          // The nearest crossing on the cone below its tip.
          const za = zb - ta * SIN_E;
          const zbb = zb - tb * SIN_E;
          const okA = za >= z0 && za <= z1;
          const okB = zbb >= z0 && zbb <= z1;
          if (okA && okB) {
            t = Math.min(ta, tb);
          } else if (okA) {
            t = ta;
          } else if (okB) {
            t = tb;
          } else {
            continue;
          }
        }
        const z = zb - t * SIN_E;
        const i = py * TILE + px;
        if (z < z0 || z > z1 || z <= tile.z[i]) {
          continue;
        }
        const y = yb + t * COS_E;
        const dy = y - cy;
        const rho = Math.max(1e-6, Math.hypot(dx, dy));
        let nx = dx / rho;
        let ny = dy / rho;
        let nz = k;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const pack = face.paint
          ? face.paint(Math.atan2(dx, -dy) * r, (z1 - z) / Math.cos(Math.atan(k)), x, y, z)
          : (face.mat << 8) | 128;
        if (pack >= 0) {
          this.put(i, z, pack, nx, ny, nz, face.owner);
        }
      }
    }
  }

  /**
   * A cluster of spheres (`lobes` as x, y, z, r quadruples), drawn as one
   * rounded mass: each pixel takes the nearest lobe, its facing blended with
   * that of the whole mass about (mx, my, mz) so the lobes read as bumps on
   * one surface. `paint` gets u = the lobe index, v = how far up the mass
   * (0..1), and may return -1 to leave a gap.
   */
  lobes(
    lobes: ArrayLike<number>,
    count: number,
    face: Face,
    mx: number,
    my: number,
    mz: number,
    mr: number,
    blend: number,
  ): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let l = 0; l < count; l++) {
      const x = lobes[l * 4];
      const y = lobes[l * 4 + 1];
      const z = lobes[l * 4 + 2];
      const r = lobes[l * 4 + 3];
      minX = Math.min(minX, (x - r) / S);
      maxX = Math.max(maxX, (x + r) / S);
      const top = -(y * SIN_E + z * COS_E) / S;
      minY = Math.min(minY, top - r / S);
      maxY = Math.max(maxY, top + r / S);
    }
    const x0 = Math.max(0, Math.floor(minX) - this.gx0);
    const x1 = Math.min(TILE - 1, Math.ceil(maxX) - this.gx0);
    const y0 = Math.max(0, Math.floor(minY) - this.gy0);
    const y1 = Math.min(TILE - 1, Math.ceil(maxY) - this.gy0);
    const tile = this.tile;
    const paint = face.paint;
    for (let py = y0; py <= y1; py++) {
      const gy = py + this.gy0 + 0.5;
      const yb = -gy * S * SIN_E;
      const zb = -gy * S * COS_E;
      for (let px = x0; px <= x1; px++) {
        const x = (px + this.gx0 + 0.5) * S;
        let bestZ = -Infinity;
        let best = -1;
        let bestY = 0;
        for (let l = 0; l < count; l++) {
          const cx = lobes[l * 4];
          const cy = lobes[l * 4 + 1];
          const cz = lobes[l * 4 + 2];
          const r = lobes[l * 4 + 3];
          const dx = x - cx;
          if (dx > r || dx < -r) {
            continue;
          }
          const a1 = yb - cy;
          const b1 = zb - cz;
          const b = a1 * COS_E - b1 * SIN_E;
          const c = dx * dx + a1 * a1 + b1 * b1 - r * r;
          const disc = b * b - c;
          if (disc < 0) {
            continue;
          }
          const t = -b - Math.sqrt(disc);
          const z = zb - t * SIN_E;
          if (z > bestZ) {
            bestZ = z;
            best = l;
            bestY = yb + t * COS_E;
          }
        }
        const i = py * TILE + px;
        if (best < 0 || bestZ <= tile.z[i]) {
          continue;
        }
        const r = lobes[best * 4 + 3];
        let nx = (x - lobes[best * 4]) / r;
        let ny = (bestY - lobes[best * 4 + 1]) / r;
        let nz = (bestZ - lobes[best * 4 + 2]) / r;
        const ox = (x - mx) / mr;
        const oy = (bestY - my) / mr;
        const oz = (bestZ - mz) / mr;
        const ol = Math.hypot(ox, oy, oz) || 1;
        nx = nx * (1 - blend) + (ox / ol) * blend;
        ny = ny * (1 - blend) + (oy / ol) * blend;
        nz = nz * (1 - blend) + (oz / ol) * blend;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const pack = paint
          ? paint(best, (bestZ - (mz - mr)) / (2 * mr), x, bestY, bestZ)
          : (face.mat << 8) | 128;
        if (pack < 0) {
          continue;
        }
        this.put(i, bestZ, pack, nx / nl, ny / nl, nz / nl, face.owner);
      }
    }
  }

  /**
   * A thin straight thing from a to b (a pole, a branch, a rope), `width`
   * pixels across, facing (nx, ny, nz).
   */
  line(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    width: number,
    face: Face,
    nx = 0,
    ny = -COS_E,
    nz = SIN_E,
  ): void {
    const pax = ax / S - this.gx0;
    const pay = -(ay * SIN_E + az * COS_E) / S - this.gy0;
    const pbx = bx / S - this.gx0;
    const pby = -(by * SIN_E + bz * COS_E) / S - this.gy0;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(pbx - pax), Math.abs(pby - pay)) * 1.5));
    const half = (width - 1) / 2;
    const tile = this.tile;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = pax + (pbx - pax) * t;
      const cy = pay + (pby - pay) * t;
      const z = az + (bz - az) * t;
      const wx = ax + (bx - ax) * t;
      const wy = ay + (by - ay) * t;
      for (let oy = -Math.ceil(half); oy <= Math.ceil(half); oy++) {
        for (let ox = -Math.ceil(half); ox <= Math.ceil(half); ox++) {
          if (Math.abs(ox) > half + 0.01 && Math.abs(oy) > half + 0.01) {
            continue;
          }
          const px = Math.floor(cx + ox);
          const py = Math.floor(cy + oy);
          if (px < 0 || py < 0 || px >= TILE || py >= TILE) {
            continue;
          }
          const i = py * TILE + px;
          // Nudged up a little so it stays in front of what it stands on.
          const zz = z + 0.02;
          if (zz <= tile.z[i]) {
            continue;
          }
          const pack = face.paint ? face.paint(t, 0, wx, wy, z) : (face.mat << 8) | 128;
          if (pack >= 0) {
            this.put(i, zz, pack, nx, ny, nz, face.owner);
          }
        }
      }
    }
  }

  /** Whether the tile has anything drawn at local pixel i. */
  drawn(i: number): boolean {
    return this.tile.z[i] > NOTHING;
  }
}
