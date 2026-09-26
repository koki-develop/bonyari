import type { RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../shared/core/math.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import { BAYER4 } from "../../shared/core/surface.ts";
import { WORLD } from "../sim/terrain.ts";
import type { World } from "../sim/world.ts";
import { TILE, type Tile } from "./gbuffer.ts";
import {
  EMISSIVE,
  fillPalette,
  M,
  SLUSH,
  SNOW,
  SNOW_HOLD,
  TRODDEN,
  WET_DARKEN,
} from "./materials.ts";
import { BUILDING_OWNER, FIELD_OWNER, OWNERS } from "./owners.ts";
import { COS_E, S, SIN_E, toWorld } from "./projection.ts";
import { CELL, PENUMBRA, SHADOW_H, SHADOW_W, type ShadowMap } from "./shadow.ts";

/** Meters between the cells of the grid lamplight is gathered on. */
export const LAMP_CELL = 1;
const LAMP_W = Math.round((WORLD.x1 - WORLD.x0) / LAMP_CELL);
const LAMP_H = Math.round((WORLD.y1 - WORLD.y0) / LAMP_CELL);
/** Color of candle and hearth light through a window. */
export const LAMP: RGB = [255, 178, 96];
/** The least sky light there is at night: the eye grown used to the dark. */
const NIGHT: RGB = [0.27, 0.3, 0.43];
/** Charred wood and plaster after a fire. */
const CHAR: RGB = [34, 28, 24];
/** How far up the far hills haze begins (y, m), and the distance it deepens over. */
const HAZE_FROM = 150;

/**
 * Turns what was drawn into colors: each material's color for the time of
 * year, darkened by rain and whitened by snow; lit by the sky and by the sun
 * where the shadow map lets it through; blackened by fire; warmed by the
 * lamplight of windows nearby; hazed with distance up the hills. Colors are
 * kept per tile and redone a few rows at a time as the light moves.
 */
export class Shader {
  /** Material colors for the time of year. */
  readonly palette = new Float32Array(256 * 3);
  /** Per owner: how charred (0..1), how bright its windows (0..1), and a color override for fields. */
  readonly char = new Float32Array(OWNERS);
  readonly lamps = new Float32Array(OWNERS);
  readonly ownerColor = new Float32Array(OWNERS * 3);
  readonly hasColor = new Uint8Array(OWNERS);
  /** Lamplight gathered over the ground (r, g, b per cell). */
  readonly lampGrid = new Float32Array(LAMP_W * LAMP_H * 3);
  private readonly shadow: ShadowMap;
  // This epoch's light.
  private sky: RGB = [0, 0, 0];
  private sun: RGB = [0, 0, 0];
  private sunX = 0;
  private sunY = 0;
  private sunZ = 1;
  private readonly flat = { x: 0, y: 0 };
  private snow = 0;
  private wet = 0;
  private fog: RGB = [0, 0, 0];
  private visibility = 20000;
  /** Counts changes of the light: tiles shaded in an older epoch are redone. */
  epoch = 0;
  private key = "";

  constructor(shadow: ShadowMap) {
    this.shadow = shadow;
  }

  /**
   * Takes this moment's light. The epoch moves on only when it has changed
   * enough to see, so the colors are not redone every frame for nothing.
   */
  update(world: World, lighting: Lighting, shadowVersion: number, ownersVersion: number): void {
    const env = world.env;
    const w = env.weather.state;
    const sunH = env.sky.sun;
    const sun = toWorld(sunH.e, sunH.n, sunH.u, { x: 0, y: 0, z: 0 });
    const a = lighting.ambient;
    const q = (v: number, step: number) => Math.round(v / step);
    const key = [
      q(a[0], 0.006),
      q(a[1], 0.006),
      q(a[2], 0.006),
      q(lighting.direct, 0.01),
      q(w.snowCover, 0.02),
      q(w.wetness, 0.03),
      q(env.season.yearFraction, 0.004),
      q(w.visibility, 400),
      q(w.mist, 0.03),
      shadowVersion,
      ownersVersion,
    ].join(" ");
    if (key === this.key) {
      return;
    }
    this.key = key;
    this.epoch++;
    fillPalette(env.season, this.palette);
    // Sky light from above, and the sun's, tinted as it sinks. Clouds that hide
    // the sun spread much of its light about, so a grey day is dull, not dark.
    const hidden = Math.max(0, lighting.daylight - lighting.direct);
    const diffuse = 1 + hidden * 0.9;
    this.sky = [
      Math.max(NIGHT[0], a[0] * 0.5 * diffuse),
      Math.max(NIGHT[1], a[1] * 0.52 * diffuse),
      Math.max(NIGHT[2], a[2] * 0.56 * diffuse),
    ];
    const disc = lighting.sunDisc;
    const dl = (disc[0] + disc[1] + disc[2]) / 3 || 1;
    const k = lighting.direct * 0.7;
    this.sun = [a[0] * k * (disc[0] / dl), a[1] * k * (disc[1] / dl), a[2] * k * (disc[2] / dl)];
    this.sunX = sun.x;
    this.sunY = sun.y;
    this.sunZ = sun.z;
    const flat = Math.hypot(sun.x, sun.y) || 1;
    this.flat.x = sun.x / flat;
    this.flat.y = sun.y / flat;
    this.snow = w.snowCover;
    this.wet = w.wetness;
    this.fog = lighting.fog;
    this.visibility = w.visibility;
  }

  /** Shades rows [row0, row1) of a tile. */
  shade(tile: Tile, row0: number, row1: number): void {
    const pal = this.palette;
    const shadow = this.shadow;
    const shadeMap = shadow.shade;
    const sunUp = shadow.up;
    const lampGrid = this.lampGrid;
    const charOf = this.char;
    const lampsOf = this.lamps;
    const hasColor = this.hasColor;
    const ownerColor = this.ownerColor;
    const mats = tile.mat;
    const zs = tile.z;
    const nxs = tile.nx;
    const nys = tile.ny;
    const nzs = tile.nz;
    const details = tile.detail;
    const owners = tile.owner;
    const lit = tile.lit;
    const gx0 = tile.tx * TILE;
    const gy0 = tile.ty * TILE;
    const skyR = this.sky[0];
    const skyG = this.sky[1];
    const skyB = this.sky[2];
    const sunR = this.sun[0];
    const sunG = this.sun[1];
    const sunB = this.sun[2];
    const sunLit = sunUp && sunR + sunG + sunB > 0.002;
    const lx = this.sunX;
    const ly = this.sunY;
    const lz = this.sunZ;
    const snow = this.snow;
    const wet = this.wet;
    const fogR = this.fog[0];
    const fogG = this.fog[1];
    const fogB = this.fog[2];
    const hazeRange = this.visibility * 0.5;
    for (let py = row0; py < row1; py++) {
      const gy = gy0 + py + 0.5;
      const yRow = (-gy * S) / SIN_E;
      const brow = (py & 3) << 2;
      for (let px = 0; px < TILE; px++) {
        const i = py * TILE + px;
        const mat = mats[i];
        if (mat === M.EMPTY) {
          lit[i] = 0;
          continue;
        }
        const z = zs[i];
        const x = (gx0 + px + 0.5) * S;
        const y = yRow - (z * COS_E) / SIN_E;
        const nx = nxs[i] / 127;
        const ny = nys[i] / 127;
        const nz = nzs[i] / 127;
        const d = details[i] / 128;
        const owner = owners[i];
        let r: number;
        let g: number;
        let b: number;
        if (owner !== 0 && hasColor[owner] === 1) {
          r = ownerColor[owner * 3];
          g = ownerColor[owner * 3 + 1];
          b = ownerColor[owner * 3 + 2];
        } else {
          r = pal[mat * 3];
          g = pal[mat * 3 + 1];
          b = pal[mat * 3 + 2];
        }
        r *= d;
        g *= d;
        b *= d;
        let glowR = 0;
        let glowG = 0;
        let glowB = 0;
        if (owner >= BUILDING_OWNER && owner < FIELD_OWNER) {
          const c = charOf[owner];
          if (c > 0) {
            const k = c * (mat === M.STONE || mat === M.STONE_ROUGH ? 0.6 : 0.92);
            r += (CHAR[0] * d - r) * k;
            g += (CHAR[1] * d - g) * k;
            b += (CHAR[2] * d - b) * k;
          }
          if (mat === M.WINDOW) {
            const l = lampsOf[owner];
            glowR = LAMP[0] * l * d;
            glowG = LAMP[1] * l * d;
            glowB = LAMP[2] * l * d;
          }
        }
        if (EMISSIVE[mat] === 1) {
          glowR = r;
          glowG = g;
          glowB = b;
        }
        // Snow settles on what faces up, patchily at first.
        const hold = SNOW_HOLD[mat];
        if (snow > 0.01 && hold > 0 && nz > 0.3) {
          const cover = clamp01(snow * 1.6 * hold * smoothstep(0.3, 0.7, nz) - (1 - d) * 0.8);
          if (TRODDEN[mat] === 1) {
            r += (SLUSH[0] * d - r) * cover;
            g += (SLUSH[1] * d - g) * cover;
            b += (SLUSH[2] * d - b) * cover;
          } else {
            r += (SNOW[0] - r) * cover;
            g += (SNOW[1] - g) * cover;
            b += (SNOW[2] - b) * cover;
          }
        }
        if (wet > 0.01) {
          const k = 1 - wet * WET_DARKEN[mat] * clamp01(nz + 0.3);
          r *= k;
          g *= k;
          b *= k;
        }
        const dither = BAYER4[brow | (px & 3)] - 0.5;
        // Light: the sky from above, the sun where it reaches.
        const hemi = 0.64 + 0.36 * nz;
        let lr = skyR * hemi;
        let lg = skyG * hemi;
        let lb = skyB * hemi;
        const ndl = nx * lx + ny * ly + nz * lz;
        if (ndl > 0 && sunLit) {
          // Look for the shadow a little out from the surface, off its own cell of the grid; out
          // past the eaves for walls, which the grid would otherwise see as solid down to the ground.
          const flat = Math.sqrt(nx * nx + ny * ny);
          const off = flat > 0.05 ? (nz < 0.35 ? 1.2 : 0.62) / flat : 0;
          // Looked up a dithered half cell about, so the grid's steps break up along the shadow's edge.
          const jitter = dither * CELL;
          // As `ShadowMap.light`, written out here: this runs for every pixel shaded.
          const sgx = (x + nx * off + jitter - WORLD.x0) / CELL - 0.5;
          const sgy = (y + ny * off - jitter - WORLD.y0) / CELL - 0.5;
          const si = Math.floor(sgx);
          const sj = Math.floor(sgy);
          let vis = 1;
          if (si >= 0 && sj >= 0 && si < SHADOW_W - 1 && sj < SHADOW_H - 1) {
            const fx = sgx - si;
            const fy = sgy - sj;
            const k = sj * SHADOW_W + si;
            const top = shadeMap[k] + (shadeMap[k + 1] - shadeMap[k]) * fx;
            const bottom =
              shadeMap[k + SHADOW_W] + (shadeMap[k + SHADOW_W + 1] - shadeMap[k + SHADOW_W]) * fx;
            const dd = z + 0.22 - (top + (bottom - top) * fy);
            vis = dd >= PENUMBRA ? 1 : dd <= -PENUMBRA ? 0 : (dd + PENUMBRA) / (2 * PENUMBRA);
          }
          if (vis > 0) {
            lr += sunR * ndl * vis;
            lg += sunG * ndl * vis;
            lb += sunB * ndl * vis;
          }
        }
        // Lamplight from windows nearby. Every lamp has some red, so cells dark in red are dark.
        const cx = (x - WORLD.x0) / LAMP_CELL - 0.5;
        const cy = (y - WORLD.y0) / LAMP_CELL - 0.5;
        const ci = Math.floor(cx);
        const cj = Math.floor(cy);
        if (ci >= 0 && cj >= 0 && ci < LAMP_W - 1 && cj < LAMP_H - 1) {
          const k00 = (cj * LAMP_W + ci) * 3;
          const k01 = k00 + LAMP_W * 3;
          if (lampGrid[k00] + lampGrid[k00 + 3] + lampGrid[k01] + lampGrid[k01 + 3] > 0) {
            const fx = cx - ci;
            const fy = cy - cj;
            const k10 = k00 + 3;
            const k11 = k01 + 3;
            const w00 = (1 - fx) * (1 - fy);
            const w10 = fx * (1 - fy);
            const w01 = (1 - fx) * fy;
            const w11 = fx * fy;
            const facing = 0.55 + 0.45 * nz;
            lr +=
              (lampGrid[k00] * w00 +
                lampGrid[k10] * w10 +
                lampGrid[k01] * w01 +
                lampGrid[k11] * w11) *
              facing;
            lg +=
              (lampGrid[k00 + 1] * w00 +
                lampGrid[k10 + 1] * w10 +
                lampGrid[k01 + 1] * w01 +
                lampGrid[k11 + 1] * w11) *
              facing;
            lb +=
              (lampGrid[k00 + 2] * w00 +
                lampGrid[k10 + 2] * w10 +
                lampGrid[k01 + 2] * w01 +
                lampGrid[k11 + 2] * w11) *
              facing;
          }
        }
        r = r * lr + glowR;
        g = g * lg + glowG;
        b = b * lb + glowB;
        // Haze up the far hills.
        if (y > HAZE_FROM) {
          const f = (1 - Math.exp(-((y - HAZE_FROM) * 6) / hazeRange)) * 0.85;
          r += (fogR - r) * f;
          g += (fogG - g) * f;
          b += (fogB - b) * f;
        }
        // A gentle dither keeps gradients from banding.
        const dz = dither * 3;
        r += dz;
        g += dz;
        b += dz;
        const ri = r <= 0 ? 0 : r >= 255 ? 255 : r | 0;
        const gi = g <= 0 ? 0 : g >= 255 ? 255 : g | 0;
        const bi = b <= 0 ? 0 : b >= 255 ? 255 : b | 0;
        lit[i] = 0xff000000 | (bi << 16) | (gi << 8) | ri;
      }
    }
  }

  /**
   * The light (channel multipliers) on an upright figure standing at (x, y,
   * z): the sky, the sun if it reaches, and lamplight from windows nearby.
   */
  lightAt(x: number, y: number, z: number, out: number[]): number[] {
    const vis = this.sunZ > 0 ? this.shadow.light(x, y, z + 0.9) : 0;
    const k = 0.55 * vis;
    out[0] = this.sky[0] * 0.95 + this.sun[0] * k;
    out[1] = this.sky[1] * 0.95 + this.sun[1] * k;
    out[2] = this.sky[2] * 0.95 + this.sun[2] * k;
    const cx = (x - WORLD.x0) / LAMP_CELL - 0.5;
    const cy = (y - WORLD.y0) / LAMP_CELL - 0.5;
    const ci = Math.floor(cx);
    const cj = Math.floor(cy);
    if (ci >= 0 && cj >= 0 && ci < LAMP_W && cj < LAMP_H) {
      const g = this.lampGrid;
      const i = (cj * LAMP_W + ci) * 3;
      out[0] += g[i];
      out[1] += g[i + 1];
      out[2] += g[i + 2];
    }
    return out;
  }

  /** Whether the sun is up and lighting things, for the shadows figures cast. */
  get sunUp(): boolean {
    return this.sunZ > 0.05 && this.sun[0] + this.sun[1] + this.sun[2] > 0.05;
  }

  /** How high the sun stands: meters of rise per meter across the ground toward it. */
  get sunSlope(): number {
    return this.sunZ / (Math.hypot(this.sunX, this.sunY) || 1e-6);
  }

  /** Horizontal direction the sun lies in (unit), for which way shadows fall. */
  get sunFlat(): { readonly x: number; readonly y: number } {
    return this.flat;
  }

  /** Sets the look of a field owner: a crop color, or its plain material when null. */
  setOwnerColor(owner: number, c: RGB | null): void {
    if (!c) {
      this.hasColor[owner] = 0;
      return;
    }
    this.hasColor[owner] = 1;
    this.ownerColor[owner * 3] = c[0];
    this.ownerColor[owner * 3 + 1] = c[1];
    this.ownerColor[owner * 3 + 2] = c[2];
  }
}
