import { mix, pack } from "../core/color.ts";
import { clamp01, lerp, smoothstep } from "../core/math.ts";
import { fbm1, hash, hash2, noise2, Rng } from "../core/random.ts";
import { bayer, type Surface } from "../core/surface.ts";
import { LATITUDE, type HorizonVector } from "../sim/astro.ts";
import { makeTerrainScratch } from "../sim/route.ts";
import type { LightningStrike } from "../sim/weather.ts";
import type { World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Lighting } from "./lighting.ts";

const CLOUD_TEX = 128;
/** Meters covered by one repetition of the cloud texture. */
const CLOUD_TILE = 7000;
/** Cloud base height (m). */
const CLOUD_HEIGHT = 1800;
/** Color quantization step of the sky gradient; dithered for the pixel-art look. */
const SKY_STEP = 7;

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

export class SkyRenderer {
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

  render(view: Surface, cam: Camera, world: World, light: Lighting, time: number): void {
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
    for (let y = 0; y < rows; y++) {
      const el = Math.atan2(cam.horizon - y - 0.5, cam.focal);
      const g = Math.pow(clamp01(el / (Math.PI / 2)), 0.42);
      const br = lerp(horizon[0], zenith[0], g);
      const bg = lerp(horizon[1], zenith[1], g);
      const bb = lerp(horizon[2], zenith[2], g);
      const nearHorizon = 1 - g;
      for (let x = 0; x < view.width; x++) {
        const d = cam.direction(x, y);
        const c = d.e * sun.e + d.n * sun.n + d.u * sun.u;
        const dh = Math.hypot(d.e, d.n) || 1;
        const cAz = (d.e * sun.e + d.n * sun.n) / (dh * sunHoriz);
        let k = 0;
        if (c > 0) {
          const c2 = c * c;
          const c4 = c2 * c2;
          k = (0.35 * c4 * c4 + 0.9 * Math.pow(c, 60)) * (0.35 + 0.65 * low);
        }
        // The twilight band hugs the horizon toward the sun.
        k += Math.max(0, cAz) * Math.max(0, cAz) * nearHorizon * nearHorizon * 0.55 * low;
        k *= sunUp;
        const dz = bayer(x, y);
        data[y * view.width + x] = pack(
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
        if (d2 > 1) {
          continue;
        }
        const dz = Math.sqrt(1 - d2);
        // Surface normal in camera space against the sun's direction.
        const lit = dx * sunCam.right + dy * sunCam.up - dz * sunCam.forward;
        const k = smoothstep(-0.06, 0.1, lit);
        // Maria: fixed darker patches.
        const mare = noise2(dx * 2.2 + 3, dy * 2.2 + 5, 91) > 0.62 ? 0.82 : 1;
        const cr = lerp(26, 238 * mare, k);
        const cg = lerp(30, 234 * mare, k);
        const cb = lerp(44, 214 * mare, k);
        view.blend(x, y, cr, cg, cb, alpha * (k > 0.02 ? 1 : 0.55) * (0.4 + 0.6 * through));
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
    const sunSide = cam.toCamera(world.sky.sun).right >= 0 ? 1 : -1;
    const fog = 0.45;
    for (let i = Math.floor(a0 / spacing); i <= Math.ceil(a1 / spacing); i++) {
      if (hash(i, this.seed, 71) > amount * 0.55) {
        continue;
      }
      const along = (i + 0.5 + (hash(i, this.seed, 72) - 0.5) * 0.7) * spacing;
      const cx = cam.x(along, lateral);
      const scale = cam.scale(lateral);
      // Mature storms grow an anvil; younger towers are lumpier and lower.
      const mature = hash(i, this.seed, 75) < 0.45;
      const width = (2500 + 5000 * hash(i, this.seed, 73)) * scale;
      const height =
        (mature ? 9000 + 5000 * hash(i, this.seed, 74) : 4500 + 4000 * hash(i, this.seed, 74)) *
        scale *
        (0.6 + 0.4 * amount);
      const shape = 1.4 + 1.8 * hash(i, this.seed, 76);
      const lumpiness = mature ? 0.22 : 0.4;
      const lumpScale = 0.1 + 0.12 * hash(i, this.seed, 77);
      const base = cam.y(lateral, 1500);
      for (let x = Math.floor(cx - width); x <= Math.ceil(cx + width); x++) {
        if (x < 0 || x >= view.width) {
          continue;
        }
        const t = (x + 0.5 - cx) / width;
        const lumps = fbm1((x - cx) / Math.max(1.5, width * lumpScale) + i * 13, this.seed + 5, 3);
        const lit = clamp01(0.5 + t * sunSide * 0.9);
        // A cauliflower tower...
        const column =
          Math.sqrt(Math.max(0, 1 - Math.abs(t / 0.55) ** shape)) *
          (1 - lumpiness + lumpiness * 1.4 * lumps);
        this.cloudSpan(view, cam, light, x, base - height * column, base, base, height, lit, fog);
        // ...spreading into an anvil at the top.
        if (mature && Math.abs(t) < 1) {
          const anvilTop = base - height * (1.02 - 0.1 * Math.abs(t) + 0.04 * lumps);
          const anvilBottom = base - height * (0.84 + 0.1 * Math.abs(t));
          this.cloudSpan(view, cam, light, x, anvilTop, anvilBottom, base, height, lit, fog);
        }
      }
    }
  }

  private cloudSpan(
    view: Surface,
    cam: Camera,
    light: Lighting,
    x: number,
    top: number,
    bottom: number,
    base: number,
    height: number,
    lit: number,
    fog: number,
  ): void {
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(bottom, cam.horizon); y++) {
      const vh = (base - y) / height;
      const shade = clamp01(lit * 0.7 + vh * 0.5);
      const c = mix(mix(light.cloudShade, light.cloudLit, shade), light.horizon, fog);
      view.blend(x, y, c[0], c[1], c[2], 0.92 * smoothstep(0, 0.04, vh));
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
        const dir = cam.direction(x, y);
        const c = dir.e * sun.e + dir.n * sun.n + dir.u * sun.u;
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
  const n = CLOUD_TEX;
  const fu = u - Math.floor(u);
  const fv = v - Math.floor(v);
  const x0 = ((Math.floor(u) % n) + n) % n;
  const y0 = ((Math.floor(v) % n) + n) % n;
  const x1 = (x0 + 1) % n;
  const y1 = (y0 + 1) % n;
  const a = tex[y0 * n + x0];
  const b = tex[y0 * n + x1];
  const c = tex[y1 * n + x0];
  const d = tex[y1 * n + x1];
  return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
}

/** Direction for an azimuth measured from south (west positive) and an altitude. */
export function skyDirection(az: number, alt: number): HorizonVector {
  const h = Math.cos(alt);
  return { e: -Math.sin(az) * h, n: -Math.cos(az) * h, u: Math.sin(alt) };
}
