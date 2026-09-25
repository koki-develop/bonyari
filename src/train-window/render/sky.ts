import { pack } from "../core/color.ts";
import { clamp01, lerp, smoothstep } from "../core/math.ts";
import { hash, hash2, hashU32, noise2, Rng } from "../core/random.ts";
import { bayer, type Surface } from "../core/surface.ts";
import { LATITUDE, type HorizonVector } from "../sim/astro.ts";
import { makeTerrainScratch } from "../sim/route.ts";
import type { LightningStrike } from "../sim/weather.ts";
import type { World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Cover } from "./cover.ts";
import type { Lighting } from "./lighting.ts";

const CLOUD_TEX = 128;
const TEX_MASK = CLOUD_TEX - 1;
/** Meters covered by one repetition of the cloud texture. */
const CLOUD_TILE = 7000;
/** Cloud base height (m). */
const CLOUD_HEIGHT = 1800;
/** Color quantization step of the sky gradient; dithered for the pixel-art look. */
const SKY_STEP = 7;
/** Scratch direction for per-pixel loops. */
const DIR: HorizonVector = { e: 0, n: 0, u: 0 };

function quantize(v: number, d: number): number {
  return Math.floor(v / SKY_STEP + d) * SKY_STEP;
}

function buildCloudTexture(seed: number): Float32Array {
  const tex = new Float32Array(CLOUD_TEX * CLOUD_TEX);
  for (let y = 0; y < CLOUD_TEX; y++) {
    for (let x = 0; x < CLOUD_TEX; x++) {
      let sum = 0;
      let amp = 0.5;
      let norm = 0;
      let period = 4;
      for (let o = 0; o < 5; o++) {
        const s = period / CLOUD_TEX;
        sum += noise2(x * s, y * s, seed + o * 17, period) * amp;
        norm += amp;
        amp *= 0.5;
        period *= 2;
      }
      tex[y * CLOUD_TEX + x] = sum / norm;
    }
  }
  // Stretch the contrast so coverage thresholds behave predictably.
  let min = Infinity;
  let max = -Infinity;
  for (const v of tex) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  for (let i = 0; i < tex.length; i++) {
    tex[i] = (tex[i] - min) / (max - min);
  }
  return tex;
}

/**
 * Unit view directions of the sky pixels, and the length of their horizontal
 * part. They depend only on the camera, so they are kept until it changes
 * (the heading turns only between sections).
 */
class SkyDirections {
  e = new Float64Array(0);
  n = new Float64Array(0);
  u = new Float64Array(0);
  horizontal = new Float64Array(0);
  private key = "";

  update(cam: Camera, width: number, rows: number): void {
    const key = `${width} ${rows} ${cam.cx} ${cam.focal} ${cam.horizon} ${cam.heading}`;
    if (key === this.key) {
      return;
    }
    this.key = key;
    const size = width * rows;
    if (this.e.length !== size) {
      this.e = new Float64Array(size);
      this.n = new Float64Array(size);
      this.u = new Float64Array(size);
      this.horizontal = new Float64Array(size);
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < width; x++) {
        const d = cam.direction(x, y, DIR);
        const i = y * width + x;
        this.e[i] = d.e;
        this.n[i] = d.n;
        this.u[i] = d.u;
        this.horizontal[i] = Math.hypot(d.e, d.n) || 1;
      }
    }
  }
}

/** A rounded lobe of a towering cloud, in screen pixels. */
interface Lobe {
  x: number;
  y: number;
  r: number;
  /** Vertical squash; below 1 flattens it. */
  squash: number;
  /** How far (px) it stands out toward the viewer. */
  z: number;
}

export class SkyRenderer {
  /** Scratch list for the lobes of the cloud being drawn. */
  private readonly lobes: Lobe[] = [];
  private readonly dirs = new SkyDirections();
  /** The four dithered colors of the gradient row being drawn. */
  private readonly plainRow = new Uint32Array(4);
  /** Scratch for the lobes crossing the row being drawn. */
  private activeLobes = new Int32Array(64);
  private lobeDy = new Float64Array(64);
  /** This frame's cover and the columns where covered sky may be skipped. */
  private cover!: Cover;
  private hidden!: Uint8Array;
  private readonly starX: Float32Array;
  private readonly starY: Float32Array;
  private readonly starZ: Float32Array;
  private readonly starBright: Float32Array;
  private readonly starColor: Uint8Array;
  private readonly starHaze: Uint8Array;
  private readonly cloudTex: Float32Array;
  private windX = 0;
  private windY = 0;
  private strike: LightningStrike | null = null;
  private strikeAge = 0;
  private strikesSeen = 0;
  private readonly seed: number;

  constructor(world: World) {
    this.seed = world.seed;
    const stars = world.stars;
    const n = stars.length;
    this.starX = new Float32Array(n);
    this.starY = new Float32Array(n);
    this.starZ = new Float32Array(n);
    this.starBright = new Float32Array(n);
    this.starColor = new Uint8Array(n * 3);
    this.starHaze = new Uint8Array(n);
    stars.forEach((s, i) => {
      this.starX[i] = Math.cos(s.dec) * Math.cos(s.ra);
      this.starY[i] = Math.cos(s.dec) * Math.sin(s.ra);
      this.starZ[i] = Math.sin(s.dec);
      // Milky Way haze is many faint points that together read as a soft band.
      this.starBright[i] = s.haze
        ? 0.16 * Math.pow(10, -0.4 * (s.mag - 6.4))
        : Math.pow(10, -0.4 * (s.mag - 2.6));
      this.starColor.set(
        s.color.map((c) => Math.round(c)),
        i * 3,
      );
      this.starHaze[i] = s.haze ? 1 : 0;
    });
    this.cloudTex = buildCloudTexture(world.seed ^ 0xc10d);
  }

  update(dt: number, world: World): void {
    const w = world.weather.state;
    const speed = 4 + w.wind * 14;
    this.windX += speed * 0.8 * dt;
    this.windY += speed * 0.35 * dt;
    if (world.weather.strikeCount !== this.strikesSeen) {
      this.strikesSeen = world.weather.strikeCount;
      this.strike = world.weather.lastStrike;
      this.strikeAge = 0;
    }
    this.strikeAge += dt;
  }

  /**
   * @param cover pixels near layers will paint over
   * @param hidden columns where covered sky may be skipped (no reflection reads it)
   */
  render(
    view: Surface,
    cam: Camera,
    world: World,
    light: Lighting,
    time: number,
    cover: Cover,
    hidden: Uint8Array,
  ): void {
    this.dirs.update(cam, view.width, Math.min(view.height, Math.ceil(cam.horizon) + 2));
    this.cover = cover;
    this.hidden = hidden;
    this.gradient(view, cam, world, light);
    this.stars(view, cam, world, light, time);
    this.airplanes(view, cam, world, light, time);
    this.shootingStars(view, cam, world, light);
    this.sun(view, cam, world, light);
    this.moon(view, cam, world, light);
    this.thunderheads(view, cam, world, light);
    this.clouds(view, cam, world, light);
    this.lightning(view, cam, world);
  }

  private gradient(view: Surface, cam: Camera, world: World, light: Lighting): void {
    const { zenith, horizon, sunGlow } = light;
    const sun = world.sky.sun;
    const sunUp = smoothstep(-12, -2, world.sky.sunAltitude);
    const low = 1 - smoothstep(4, 30, world.sky.sunAltitude);
    const sunHoriz = Math.hypot(sun.e, sun.n) || 1;
    const rows = Math.min(view.height, Math.ceil(cam.horizon) + 2);
    const data = view.data;
    const { e: dirE, n: dirN, u: dirU, horizontal: dirH } = this.dirs;
    const covered = this.cover.order;
    const hidden = this.hidden;
    for (let y = 0; y < rows; y++) {
      const el = Math.atan2(cam.horizon - y - 0.5, cam.focal);
      const g = Math.pow(clamp01(el / (Math.PI / 2)), 0.42);
      const br = lerp(horizon[0], zenith[0], g);
      const bg = lerp(horizon[1], zenith[1], g);
      const bb = lerp(horizon[2], zenith[2], g);
      const nearHorizon = 1 - g;
      const row = y * view.width;
      // Where the sun adds nothing, a pixel's color depends only on the row
      // and its place in the dither pattern.
      const plain = this.plainRow;
      for (let q = 0; q < 4; q++) {
        const dz = bayer(q, y);
        plain[q] = pack(quantize(br, dz), quantize(bg, dz), quantize(bb, dz));
      }
      for (let x = 0; x < view.width; x++) {
        const i = row + x;
        if (hidden[x] === 1 && covered[i] !== Infinity) {
          continue;
        }
        if (sunUp === 0) {
          data[i] = plain[x & 3];
          continue;
        }
        const de = dirE[i];
        const dn = dirN[i];
        const c = de * sun.e + dn * sun.n + dirU[i] * sun.u;
        const cAz = (de * sun.e + dn * sun.n) / (dirH[i] * sunHoriz);
        let k = 0;
        if (c > 0) {
          const c2 = c * c;
          const c4 = c2 * c2;
          k = (0.35 * c4 * c4 + 0.9 * Math.pow(c, 60)) * (0.35 + 0.65 * low);
        }
        // The twilight band hugs the horizon toward the sun.
        k += Math.max(0, cAz) * Math.max(0, cAz) * nearHorizon * nearHorizon * 0.55 * low;
        k *= sunUp;
        if (k === 0) {
          data[i] = plain[x & 3];
          continue;
        }
        const dz = bayer(x, y);
        data[i] = pack(
          quantize(br + sunGlow[0] * k, dz),
          quantize(bg + sunGlow[1] * k, dz),
          quantize(bb + sunGlow[2] * k, dz),
        );
      }
    }
  }

  private stars(view: Surface, cam: Camera, world: World, light: Lighting, time: number): void {
    const vis = light.starVisibility;
    if (vis <= 0.01) {
      return;
    }
    const lst = world.sky.sidereal;
    const cl = Math.cos(lst);
    const sl = Math.sin(lst);
    const sinLat = Math.sin(LATITUDE);
    const cosLat = Math.cos(LATITUDE);
    const sinH = Math.sin(cam.heading);
    const cosH = Math.cos(cam.heading);
    const n = this.starX.length;
    const limitY = cam.horizon;
    for (let i = 0; i < n; i++) {
      const X = this.starX[i];
      const Y = this.starY[i];
      const Z = this.starZ[i];
      const p = cl * X + sl * Y;
      const e = -(sl * X - cl * Y);
      const north = cosLat * Z - sinLat * p;
      const u = sinLat * Z + cosLat * p;
      const forward = -e * sinH - north * cosH;
      if (forward < 0.05 || u <= 0) {
        continue;
      }
      const right = -e * cosH + north * sinH;
      const sx = cam.cx + (cam.focal * right) / forward;
      const sy = cam.horizon - (cam.focal * u) / forward;
      if (sx < 0 || sx >= view.width || sy < 0 || sy >= limitY) {
        continue;
      }
      const extinction = smoothstep(0, 0.25, u);
      const haze = this.starHaze[i] === 1;
      let b = this.starBright[i] * vis * extinction;
      if (haze) {
        b = Math.min(b, 0.3) * 0.9;
      } else {
        // Twinkle, stronger low in the sky.
        b *= 1 - (0.35 - 0.25 * u) * (0.5 + 0.5 * Math.sin(time * (6 + (i % 7)) + i));
      }
      if (b < 0.02) {
        continue;
      }
      const r = this.starColor[i * 3];
      const g = this.starColor[i * 3 + 1];
      const bl = this.starColor[i * 3 + 2];
      const core = Math.min(1, b);
      view.add(sx, sy, r * core, g * core, bl * core);
      if (b > 1.1) {
        const arm = Math.min(0.55, (b - 1.1) * 0.3);
        view.add(sx - 1, sy, r * arm, g * arm, bl * arm);
        view.add(sx + 1, sy, r * arm, g * arm, bl * arm);
        view.add(sx, sy - 1, r * arm, g * arm, bl * arm);
        view.add(sx, sy + 1, r * arm, g * arm, bl * arm);
      }
    }
  }

  private sun(view: Surface, cam: Camera, world: World, light: Lighting): void {
    if (world.sky.sunAltitude < -1.5) {
      return;
    }
    const p = cam.projectDirection(world.sky.sun);
    if (!p) {
      return;
    }
    const r = Math.max(2.2, cam.focal * 0.034);
    const w = world.weather.state;
    const through = clamp01(1 - w.cloudCover * 0.9);
    view.glow(p.x, p.y, r * 7, light.sunGlow, 0.35 * through);
    const [cr, cg, cb] = light.sunDisc;
    for (let y = Math.floor(p.y - r); y <= Math.ceil(p.y + r); y++) {
      if (y >= cam.horizon) {
        continue;
      }
      for (let x = Math.floor(p.x - r); x <= Math.ceil(p.x + r); x++) {
        const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
        if (d <= r) {
          view.blend(x, y, cr, cg, cb, (0.35 + 0.65 * through) * clamp01(r + 0.5 - d));
        }
      }
    }
  }

  private moon(view: Surface, cam: Camera, world: World, light: Lighting): void {
    const sky = world.sky;
    if (sky.moonAltitude < -1) {
      return;
    }
    const p = cam.projectDirection(sky.moon);
    if (!p) {
      return;
    }
    const r = Math.max(3, Math.min(6, cam.focal * 0.045));
    const sunCam = cam.toCamera(sky.sun);
    const daylight = light.daylight;
    const alpha = 1 - daylight * 0.72;
    const w = world.weather.state;
    const through = clamp01(1 - w.cloudCover * 0.8);
    if (daylight < 0.6) {
      view.glow(
        p.x,
        p.y,
        r * 5,
        [120, 130, 150],
        0.25 * sky.moonIllumination * (1 - daylight) * through,
      );
    }
    for (let y = Math.floor(p.y - r); y <= Math.ceil(p.y + r); y++) {
      if (y >= cam.horizon) {
        continue;
      }
      for (let x = Math.floor(p.x - r); x <= Math.ceil(p.x + r); x++) {
        const dx = (x + 0.5 - p.x) / r;
        const dy = -(y + 0.5 - p.y) / r;
        const d2 = dx * dx + dy * dy;
        // Soft, pixel-wide limb.
        const edge = clamp01((1 - Math.sqrt(d2)) * r + 0.5);
        if (edge <= 0) {
          continue;
        }
        const dz = Math.sqrt(Math.max(0, 1 - d2));
        // Surface normal in camera space against the sun's direction.
        const lit = dx * sunCam.right + dy * sunCam.up - dz * sunCam.forward;
        const k = smoothstep(-0.06, 0.1, lit);
        // Maria: fixed darker patches.
        const mare = noise2(dx * 2.2 + 3, dy * 2.2 + 5, 91) > 0.62 ? 0.82 : 1;
        const cr = lerp(26, 238 * mare, k);
        const cg = lerp(30, 234 * mare, k);
        const cb = lerp(44, 214 * mare, k);
        // The unlit part only shows against a dark sky (earthshine); by day it
        // is lost in the blue.
        const dark = 0.55 * (1 - smoothstep(0.05, 0.4, daylight));
        const a = alpha * (k + (1 - k) * dark) * (0.4 + 0.6 * through) * edge;
        view.blend(x, y, cr, cg, cb, a);
      }
    }
  }

  private thunderheads(view: Surface, cam: Camera, world: World, light: Lighting): void {
    const w = world.weather.state;
    const hour = world.clock.hour;
    const amount =
      world.season.thunderheads *
      clamp01(1.2 - w.cloudCover) *
      smoothstep(11, 14, hour) *
      (1 - smoothstep(19.5, 21, hour));
    if (amount < 0.05) {
      return;
    }
    const lateral = 28000;
    const spacing = 16000;
    const [a0, a1] = cam.alongRange(lateral, 60);
    const sun = cam.toCamera(world.sky.sun);
    const sunLen = Math.hypot(sun.right, sun.up, sun.forward) || 1;
    const lx = sun.right / sunLen;
    const ly = sun.up / sunLen;
    // Toward the viewer: the sun behind us lights the faces we see.
    const lz = -sun.forward / sunLen;
    const scale = cam.scale(lateral);
    const base = cam.y(lateral, 1500);
    for (let i = Math.floor(a0 / spacing); i <= Math.ceil(a1 / spacing); i++) {
      if (hash(i, this.seed, 71) > amount * 0.55) {
        continue;
      }
      const along = (i + 0.5 + (hash(i, this.seed, 72) - 0.5) * 0.7) * spacing;
      const cx = cam.x(along, lateral);
      // Mature storms grow an anvil; younger towers are lumpier and lower.
      const mature = hash(i, this.seed, 75) < 0.45;
      const width =
        (mature ? 9000 + 7000 * hash(i, this.seed, 73) : 5000 + 5000 * hash(i, this.seed, 73)) *
        scale;
      const height =
        (mature ? 9000 + 5000 * hash(i, this.seed, 74) : 4500 + 4000 * hash(i, this.seed, 74)) *
        scale *
        (0.6 + 0.4 * amount);
      if (cx + width * 1.6 < 0 || cx - width * 1.6 > view.width) {
        continue;
      }
      this.cumulonimbus(
        view,
        light,
        cx,
        base,
        width,
        height,
        mature,
        hashU32(i * 7919 + this.seed),
        lx,
        ly,
        lz,
        cam.horizon,
      );
    }
  }

  /**
   * A towering cumulus built from rounded lobes: a broad, flat-based foot,
   * turrets stacked and narrowing upward, and on mature storms a wide anvil
   * sheared off to one side. Each lobe is shaded as a rounded mass lit from
   * the sun's side; the far haze softens it all.
   */
  private cumulonimbus(
    view: Surface,
    light: Lighting,
    cx: number,
    base: number,
    width: number,
    height: number,
    mature: boolean,
    seed: number,
    lx: number,
    ly: number,
    lz: number,
    horizon: number,
  ): void {
    const r = new Rng(seed);
    const lobes = this.lobes;
    lobes.length = 0;
    const tower = mature ? 0.9 : 1;
    const levels = 8;
    const step = height / levels;
    let drift = 0;
    for (let k = 0; k < levels; k++) {
      const v = (k + 0.5) / levels;
      // A broad foot; the mass narrows into turrets and leans a little as it rises.
      const half = (width / 2) * (1 - 0.6 * v * v) * r.range(0.85, 1.1);
      drift += r.range(-0.05, 0.05) * width;
      const count = Math.max(1, Math.round((half * 2) / (step * 1.1)) + r.int(0, 1));
      for (let j = 0; j < count; j++) {
        const t = count === 1 ? 0 : j / (count - 1) - 0.5;
        const rad = step * r.range(0.75, 1.1) * (1 + (1 - v) * 0.2);
        lobes.push({
          x: cx + drift * v + t * 2 * (half - rad * 0.4) + r.range(-0.2, 0.2) * rad,
          y: base - v * height * tower + r.range(-0.15, 0.15) * rad,
          r: rad,
          squash: 1,
          z: r.range(0, 1) * rad + (count === 1 ? rad * 0.5 : (0.5 - Math.abs(t)) * rad),
        });
      }
    }
    if (mature) {
      // The anvil: flattened, spread wide and blown to one side.
      const side = r.chance(0.5) ? 1 : -1;
      const top = base - height;
      const span = width * r.range(1.3, 1.8);
      for (let j = 0; j < 7; j++) {
        const t = j / 6 - 0.35;
        lobes.push({
          x: cx + drift + side * t * span,
          y: top + height * 0.06 + r.range(-0.02, 0.02) * height,
          r: span * r.range(0.2, 0.26) * (1 - Math.abs(t) * 0.5),
          squash: 0.28,
          z: height * 0.1,
        });
      }
    }
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    for (const l of lobes) {
      x0 = Math.min(x0, l.x - l.r);
      x1 = Math.max(x1, l.x + l.r);
      y0 = Math.min(y0, l.y - l.r * l.squash);
    }
    const massX = (x0 + x1) / 2;
    const massRx = Math.max(1, (x1 - x0) / 2);
    const massY = base - height * 0.45;
    const massRy = height * 0.6;
    const [sr, sg, sb] = light.cloudShade;
    const [cr, cg, cb] = light.cloudLit;
    const [hr, hg, hb] = light.horizon;
    const fog = 0.4;
    const yEnd = Math.min(Math.ceil(base), Math.floor(horizon), view.height);
    const active =
      this.activeLobes.length >= lobes.length ? this.activeLobes : new Int32Array(lobes.length * 2);
    this.activeLobes = active;
    const rowDy =
      this.lobeDy.length >= lobes.length ? this.lobeDy : new Float64Array(lobes.length * 2);
    this.lobeDy = rowDy;
    for (let y = Math.max(0, Math.floor(y0)); y < yEnd; y++) {
      // Only lobes the row passes through can cover its pixels.
      let count = 0;
      for (let i = 0; i < lobes.length; i++) {
        const l = lobes[i];
        const dy = (y + 0.5 - l.y) / (l.r * l.squash);
        if (dy * dy < 1) {
          rowDy[i] = dy;
          active[count++] = i;
        }
      }
      if (count === 0) {
        continue;
      }
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(view.width - 1, Math.ceil(x1)); x++) {
        let bestZ = -Infinity;
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let rim = 0;
        let covering = 0;
        for (let j = 0; j < count; j++) {
          const i = active[j];
          const l = lobes[i];
          const dx = (x + 0.5 - l.x) / l.r;
          const dy = rowDy[i];
          const d2 = dx * dx + dy * dy;
          if (d2 >= 1) {
            continue;
          }
          covering++;
          const z = l.z + l.r * l.squash * Math.sqrt(1 - d2);
          if (z > bestZ) {
            bestZ = z;
            nx = dx;
            ny = -dy;
            nz = Math.sqrt(1 - d2);
            rim = Math.sqrt(d2);
          }
        }
        if (bestZ === -Infinity) {
          continue;
        }
        // Shade the lobes as bumps on the rounded mass of the whole cloud, so
        // they read as its surface rather than as separate balls.
        const vx = (x + 0.5 - massX) / massRx;
        const vy = -(y + 0.5 - massY) / massRy;
        const vz = Math.sqrt(Math.max(0, 1 - vx * vx - vy * vy));
        nx = nx * 0.45 + vx * 0.55;
        ny = ny * 0.45 + vy * 0.55;
        nz = nz * 0.45 + vz * 0.55;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        // Bright on the sun's side, blue-grey in shade, darker toward the flat
        // base where little light reaches.
        const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
        const under = smoothstep(height * 0.35, 0, base - y);
        const k = clamp01(0.28 + 0.72 * diffuse + 0.15 * ny) * (1 - under * 0.45);
        const pr = sr + (cr - sr) * k;
        const pg = sg + (cg - sg) * k;
        const pb = sb + (cb - sb) * k;
        // Only the outline is soft; inside, lobes overlap opaquely.
        const alpha = covering === 1 ? 0.95 * (1 - smoothstep(0.82, 1, rim) * 0.6) : 0.95;
        view.blend(x, y, pr + (hr - pr) * fog, pg + (hg - pg) * fog, pb + (hb - pb) * fog, alpha);
      }
    }
  }

  private clouds(view: Surface, cam: Camera, world: World, light: Lighting): void {
    const w = world.weather.state;
    if (w.cloudCover < 0.02) {
      return;
    }
    const tex = this.cloudTex;
    const cover = w.cloudCover;
    const th = lerp(0.8, 0.12, cover);
    const soft = 0.12 + cover * 0.1;
    const sun = world.sky.sun;
    const sh = Math.hypot(sun.e, sun.n) || 1;
    const su = (-sun.e / sh) * 2.2;
    const sv = (-sun.n / sh) * 2.2;
    const lit = light.cloudLit;
    const shade = light.cloudShade;
    const glow = light.sunGlow;
    const pollution =
      world.route.terrain(world.train.pos, TERRAIN).lightPollution * (1 - light.daylight);
    const shadeR = shade[0] + pollution * 34;
    const shadeG = shade[1] + pollution * 22;
    const shadeB = shade[2] + pollution * 10;
    const texScale = CLOUD_TEX / CLOUD_TILE;
    const rows = Math.min(view.height, Math.ceil(cam.horizon));
    const pos = cam.pos;
    const data = view.data;
    const { e: dirE, n: dirN, u: dirU } = this.dirs;
    const covered = this.cover.order;
    const hidden = this.hidden;
    for (let y = 0; y < rows; y++) {
      const dy = cam.horizon - y - 0.5;
      if (dy <= 0.3) {
        continue;
      }
      const dist = (CLOUD_HEIGHT * cam.focal) / dy;
      const fade = 1 - smoothstep(18000, 60000, dist);
      if (fade <= 0) {
        continue;
      }
      const haze = smoothstep(4000, 40000, dist);
      const v = (dist + this.windY) * texScale;
      for (let x = 0; x < view.width; x++) {
        if (hidden[x] === 1 && covered[y * view.width + x] !== Infinity) {
          continue;
        }
        const lateral = ((x + 0.5 - cam.cx) * CLOUD_HEIGHT) / dy;
        const u = (pos + lateral + this.windX) * texScale;
        const d = sampleTex(tex, u, v);
        const a = smoothstep(th, th + soft, d) * fade;
        if (a <= 0.01) {
          continue;
        }
        const d2 = sampleTex(tex, u + su, v + sv);
        const l = clamp01(0.55 + (d - d2) * 3.5 - (d - th) * 0.8 * cover);
        let r = shadeR + (lit[0] - shadeR) * l;
        let g = shadeG + (lit[1] - shadeG) * l;
        let b = shadeB + (lit[2] - shadeB) * l;
        // Thin edges glow when backlit by the sun.
        const di = y * view.width + x;
        const c = dirE[di] * sun.e + dirN[di] * sun.n + dirU[di] * sun.u;
        if (c > 0.7) {
          const k = Math.pow((c - 0.7) / 0.3, 3) * (1 - a) * 1.6;
          r += glow[0] * k;
          g += glow[1] * k;
          b += glow[2] * k;
        }
        r = lerp(r, light.horizon[0], haze * 0.7);
        g = lerp(g, light.horizon[1], haze * 0.7);
        b = lerp(b, light.horizon[2], haze * 0.7);
        const alpha = a > 0.97 ? 1 : a + (bayer(x, y) - 0.5) * 0.18;
        if (alpha <= 0) {
          continue;
        }
        const i = y * view.width + x;
        const o = data[i];
        const k = Math.min(1, alpha);
        data[i] = pack(
          (o & 255) + (r - (o & 255)) * k,
          ((o >>> 8) & 255) + (g - ((o >>> 8) & 255)) * k,
          ((o >>> 16) & 255) + (b - ((o >>> 16) & 255)) * k,
        );
      }
    }
  }

  private airplanes(view: Surface, cam: Camera, world: World, light: Lighting, time: number): void {
    for (const p of world.spectacle.airplanes) {
      // Airplanes and meteors are placed relative to the view.
      const dir = skyDirection(p.az + cam.heading, p.alt);
      const s = cam.projectDirection(dir);
      if (!s || s.y >= cam.horizon || s.x < -20 || s.x > view.width + 20) {
        continue;
      }
      const fade = smoothstep(0, 3, p.age) * smoothstep(p.life, p.life - 3, p.age);
      if (light.daylight < 0.5) {
        const blink = Math.sin(time * 5.5 + p.seed) > 0.7 ? 1 : 0;
        const strobe = (time * 1.1 + p.seed * 0.1) % 1 < 0.06 ? 1 : 0;
        view.add(s.x, s.y, 255 * blink * fade, 60 * blink * fade, 50 * blink * fade);
        view.add(
          s.x + (p.dAz > 0 ? -1 : 1),
          s.y,
          230 * strobe * fade,
          235 * strobe * fade,
          255 * strobe * fade,
        );
      } else {
        // A tiny silver glint and its contrail.
        const trail = Math.round(12 + 10 * hash2(p.seed, 3));
        const back = p.dAz > 0 ? -1 : 1;
        for (let i = 1; i < trail; i++) {
          const a = (1 - i / trail) * 0.55 * fade * (1 - world.weather.state.cloudCover);
          view.blend(s.x + back * i, s.y + i * 0.04, 245, 245, 250, a);
        }
        view.blend(s.x, s.y, 235, 238, 245, fade);
      }
    }
  }

  private shootingStars(view: Surface, cam: Camera, world: World, light: Lighting): void {
    for (const s of world.spectacle.shootingStars) {
      const t = s.age / s.life;
      const at = (age: number) =>
        cam.projectDirection(skyDirection(cam.heading + s.az + s.dAz * age, s.alt + s.dAlt * age));
      const head = at(s.age);
      const tail = at(Math.max(0, s.age - 0.25));
      if (!head || !tail) {
        continue;
      }
      const steps = Math.ceil(Math.hypot(head.x - tail.x, head.y - tail.y));
      const b = s.brightness * Math.sin(Math.PI * t) * light.starVisibility;
      for (let i = 0; i <= steps; i++) {
        const k = steps === 0 ? 1 : i / steps;
        const x = lerp(tail.x, head.x, k);
        const y = lerp(tail.y, head.y, k);
        if (y < cam.horizon) {
          view.add(x, y, 240 * b * k, 240 * b * k, 255 * b * k);
        }
      }
    }
  }

  private lightning(view: Surface, cam: Camera, world: World): void {
    const s = this.strike;
    const flash = world.weather.state.flash;
    if (!s || !s.bolt || flash < 0.25 || this.strikeAge > 0.35) {
      return;
    }
    const rng = new Rng(s.seed);
    let x = cam.cx + s.direction * view.width * 0.45;
    const bottom = cam.horizon - 1;
    const topY = Math.max(0, cam.horizon - cam.focal * 0.9);
    for (let y = topY; y < bottom; y++) {
      x += rng.range(-1.2, 1.2) + (rng.chance(0.08) ? rng.range(-3, 3) : 0);
      view.blend(x, y, 240, 238, 255, flash);
      view.add(x - 1, y, 60 * flash, 60 * flash, 90 * flash);
      view.add(x + 1, y, 60 * flash, 60 * flash, 90 * flash);
    }
  }
}

const TERRAIN = makeTerrainScratch();

function sampleTex(tex: Float32Array, u: number, v: number): number {
  // The texture side is a power of two, so wrapping is a mask.
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const fu = u - iu;
  const fv = v - iv;
  const x0 = iu & TEX_MASK;
  const y0 = (iv & TEX_MASK) * CLOUD_TEX;
  const x1 = (x0 + 1) & TEX_MASK;
  const y1 = (((iv & TEX_MASK) + 1) & TEX_MASK) * CLOUD_TEX;
  const a = tex[y0 + x0];
  const b = tex[y0 + x1];
  const c = tex[y1 + x0];
  const d = tex[y1 + x1];
  return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
}

/** Direction for an azimuth measured from south (west positive) and an altitude. */
export function skyDirection(az: number, alt: number): HorizonVector {
  const h = Math.cos(alt);
  return { e: -Math.sin(az) * h, n: -Math.cos(az) * h, u: Math.sin(alt) };
}
