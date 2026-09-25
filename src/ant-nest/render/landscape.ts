import { hex, mix, pack, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../shared/core/math.ts";
import { fbm1, hash3, Rng } from "../../shared/core/random.ts";
import { bayer, type Surface } from "../../shared/core/surface.ts";
import type { Environment } from "../../shared/env/environment.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import type { Painter } from "../../shared/render/painter.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import type { Shade } from "../../shared/render/shade.ts";
import { drawBroadleaf, drawCedar, drawSakura, type Planting } from "../../shared/render/trees.ts";
import type { World } from "../sim/world.ts";

/** Straw of withered grass, and the bare earth between tufts. */
const STRAW: RGB = hex("#b39a66");
const EARTH: RGB = hex("#6e5a44");
const SNOW: RGB = [238, 242, 248];
const LEAVES: readonly RGB[] = [hex("#b8452a"), hex("#c9862e"), hex("#8a5a34"), hex("#d6a93a")];

type TreeKind = "broadleaf" | "cedar" | "sakura";

interface Tree extends Planting {
  kind: TreeKind;
}

const DRAW: Record<TreeKind, (p: Painter, o: Planting) => void> = {
  broadleaf: drawBroadleaf,
  cedar: drawCedar,
  sakura: drawSakura,
};

/**
 * The land beyond the grass, far off: two lines of hills in the haze, and the
 * edge of a wood across the field, with a cherry and a lone tree nearer. Laid out once from the seed, sorted far to near.
 */
export function plantLand(seed: number): Tree[] {
  const r = new Rng(seed ^ 0x1a4d);
  const trees: Tree[] = [];
  // The wood's edge, broadleaves and cedars, thinning in places.
  for (let along = -420; along < 420; along += r.range(5, 11)) {
    if (fbm1(along / 90, seed ^ 0x77, 2) < 0.34) {
      continue;
    }
    const kind: TreeKind = r.chance(0.42) ? "cedar" : "broadleaf";
    trees.push({ kind, along, lateral: r.range(70, 140), seed: r.int(0, 1 << 30) });
  }
  // A few nearer: a cherry and a lone broadleaf.
  trees.push({
    kind: "sakura",
    along: r.range(-40, 40),
    lateral: r.range(34, 46),
    seed: r.int(0, 1 << 30),
  });
  trees.push({
    kind: "broadleaf",
    along: r.range(50, 120) * (r.chance(0.5) ? 1 : -1),
    lateral: r.range(28, 38),
    seed: r.int(0, 1 << 30),
  });
  return trees.sort((a, b) => b.lateral - a.lateral);
}

/** The far hills: a range in the haze and a nearer, darker line. */
export function drawHills(
  view: Surface,
  cam: Pinhole,
  env: Environment,
  light: Lighting,
  seed: number,
): void {
  const layers = [
    { distance: 7000, rise: 0.028, amp: 0.035, freq: 1.3, tint: 0.8 },
    { distance: 1800, rise: 0.012, amp: 0.02, freq: 3.4, tint: 0.52 },
  ];
  const visibility = env.weather.state.visibility;
  const snow = env.weather.state.snowCover;
  for (const layer of layers) {
    const haze = 1 - Math.exp(-layer.distance / (visibility * 0.55));
    if (haze > 0.97) {
      continue;
    }
    const land = mix([62, 84, 70], [180, 186, 196], snow * 0.4);
    const lit: RGB = [
      land[0] * light.ambient[0],
      land[1] * light.ambient[1],
      land[2] * light.ambient[2],
    ];
    const color = mix(lit, light.fog, Math.min(1, haze + layer.tint * 0.35));
    for (let x = 0; x < view.width; x++) {
      const az = cam.heading + Math.atan((x + 0.5 - cam.cx) / cam.focal);
      const h = layer.rise + layer.amp * fbm1(az * layer.freq * 6, seed + layer.distance, 4);
      const top = cam.horizon - cam.focal * Math.tan(h);
      const y0 = Math.max(0, Math.floor(top));
      const y1 = Math.min(view.height, Math.ceil(cam.horizon + 1));
      for (let y = y0; y < y1; y++) {
        const d = (bayer(x, y) - 0.5) * 5;
        const edge = y === y0 ? 1 - (top - y0) : 1;
        view.blend(x, y, color[0] + d, color[1] + d, color[2] + d, edge);
      }
    }
  }
}

/** Draws the trees that show in the view. */
export function drawLand(p: Painter, trees: readonly Tree[]): void {
  const cam = p.cam;
  const view = p.view;
  for (const t of trees) {
    const reach = 12;
    const x0 = cam.x(t.along - reach, t.lateral);
    const x1 = cam.x(t.along + reach, t.lateral);
    if (x1 < 0 || x0 >= view.width) {
      continue;
    }
    p.base = 0;
    DRAW[t.kind](p, t);
  }
}

/** The lateral distances (m) the grass is drawn in, from far to near. */
const SLICES: number[] = (() => {
  const list: number[] = [];
  for (let z = 1.6; z > 0.255; z /= 1.07) {
    list.push(z);
  }
  list.push(0.256);
  return list;
})();

/**
 * The grass behind the cut, from the edge to the horizon: the ground's color
 * and texture, tufts of blades nearer, flowers in spring, fallen leaves in
 * autumn, snow and frost in winter, dew in the early sun. It changes slowly
 * (the light, a breeze in the blades), so it is drawn into its own layer a
 * few times a second and laid over each frame.
 */
export class Meadow {
  private color = new Uint32Array(0);
  private alpha = new Float32Array(0);
  private width = 0;
  private height = 0;
  private sinceDrawn = Infinity;
  private key = "";

  /** Brings the layer up to date (every `interval` seconds, or at once after a change of view). */
  update(
    world: World,
    cam: Pinhole,
    shade: Shade,
    light: Lighting,
    ground: number,
    view: Surface,
    dt: number,
    time: number,
  ): void {
    const key = `${view.width}x${view.height}@${cam.cx},${ground}`;
    this.sinceDrawn += dt;
    if (key === this.key && this.sinceDrawn < 0.12) {
      return;
    }
    if (view.width !== this.width || view.height !== this.height) {
      this.width = view.width;
      this.height = view.height;
      this.color = new Uint32Array(view.width * view.height);
      this.alpha = new Float32Array(view.width * view.height);
    }
    this.key = key;
    this.sinceDrawn = 0;
    this.alpha.fill(0);
    this.paint(world, cam, shade, light, ground, time);
  }

  /** Lays the layer over the view. */
  draw(view: Surface): void {
    const data = view.data;
    const color = this.color;
    const alpha = this.alpha;
    for (let i = 0; i < alpha.length; i++) {
      const a = alpha[i];
      if (a <= 0.01) {
        continue;
      }
      if (a >= 0.99) {
        data[i] = color[i];
        continue;
      }
      const c = color[i];
      const d = data[i];
      const dr = d & 255;
      const dg = (d >>> 8) & 255;
      const db = (d >>> 16) & 255;
      data[i] = pack(
        dr + ((c & 255) - dr) * a,
        dg + (((c >>> 8) & 255) - dg) * a,
        db + (((c >>> 16) & 255) - db) * a,
      );
    }
  }

  private put(x: number, y: number, r: number, g: number, b: number, a: number): void {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) {
      return;
    }
    const i = y * this.width + x;
    const old = this.alpha[i];
    if (old <= 0 || a >= 1) {
      this.color[i] = pack(r, g, b);
      this.alpha[i] = Math.min(1, a);
      return;
    }
    const c = this.color[i];
    const k = a;
    this.color[i] = pack(
      (c & 255) + (r - (c & 255)) * k,
      ((c >>> 8) & 255) + (g - ((c >>> 8) & 255)) * k,
      ((c >>> 16) & 255) + (b - ((c >>> 16) & 255)) * k,
    );
    this.alpha[i] = Math.min(1, old + a * (1 - old));
  }

  private paint(
    world: World,
    cam: Pinhole,
    shade: Shade,
    light: Lighting,
    ground: number,
    time: number,
  ): void {
    const env = world.env;
    const season = env.season;
    const w = env.weather.state;
    const seed = world.seed;
    const withered = season.withered;
    const snow = smoothstep(0.05, 0.5, w.snowCover);
    const frost = clamp01(-world.climate.surface / 3) * (1 - snow);
    const turf = mix(season.grass, STRAW, withered * 0.8);
    // The ground between the tufts, row by row out to the horizon.
    const top = Math.max(0, Math.floor(cam.horizon));
    for (let y = top; y < Math.min(this.height, ground + 1); y++) {
      const depth = y + 0.5 - cam.horizon;
      if (depth <= 0.05) {
        continue;
      }
      const lateral = (cam.eye * cam.focal) / depth;
      shade.at(lateral);
      for (let x = 0; x < this.width; x++) {
        const along = cam.alongAt(x, lateral);
        const n = hash3(Math.floor(along * 180), Math.floor(lateral * 90), seed);
        const bare = n < 0.18 ? 1 : 0;
        let c = mix(turf, EARTH, bare * 0.6);
        c = mix(c, SNOW, snow * (0.85 + 0.15 * n));
        const k = 0.8 + 0.3 * n;
        this.put(x, y, shade.litR(c[0] * k), shade.litG(c[1] * k), shade.litB(c[2] * k), 1);
      }
    }
    // Tufts of blades, far to near.
    const wind = w.wind;
    // A mown lawn: short turf, a little longer in summer.
    const tall = (7 + 9 * (1 - withered) * (0.5 + 0.5 * season.warmth)) * (1 - 0.7 * snow);
    const flowers = season.wildflowers;
    const leaves = season.fallenLeaves;
    const sunLow = light.direct * smoothstep(20, 2, env.sky.sunAltitude) * (1 - withered);
    const dew = sunLow * smoothstep(8, 4, env.clock.hour) * smoothstep(4, 5.5, env.clock.hour);
    for (const lateral of SLICES) {
      const s = cam.scale(lateral);
      const spacing = Math.max(0.004, 4.5 / s);
      const [a0, a1] = cam.alongRange(lateral, 6);
      shade.at(lateral);
      const baseY = cam.y(lateral, 0);
      const row = Math.round(lateral * 1000);
      for (let k = Math.floor(a0 / spacing); k <= Math.ceil(a1 / spacing); k++) {
        const h0 = hash3(k, row, seed);
        const along = (k + h0) * spacing;
        // Buried under the heap by the entrance.
        if (lateral < 0.36 && world.surface.heapAt(along * 1000) > 1.2) {
          continue;
        }
        const x = cam.x(along, lateral);
        const h1 = hash3(k, row, seed + 1);
        const height = (tall * (0.55 + 0.7 * h1)) / 1000;
        const blades = 2 + Math.floor(h0 * 3);
        for (let b = 0; b < blades; b++) {
          const hb = hash3(k * 7 + b, row, seed + 2);
          const lean = (hb - 0.5) * 0.9 + (withered * 0.6 + snow * 0.4) * (hb > 0.5 ? 1 : -1);
          const sway = wind * Math.sin(time * (1.3 + hb) + along * 40) * 0.25;
          const bh = height * (0.6 + 0.5 * hb) * (1 - 0.35 * withered * hb);
          const tipX = x + (lean + sway) * bh * s;
          const tipY = baseY - bh * s * (1 - Math.abs(lean) * 0.3);
          const green = mix(turf, [turf[0] * 0.7, turf[1] * 0.85, turf[2] * 0.6], hb);
          let c = mix(green, SNOW, snow * 0.7);
          c = mix(c, [220, 230, 240], frost * 0.55);
          const lit = 0.8 + 0.35 * (1 - hb);
          this.blade(x + (b - blades / 2) * 0.6, baseY, tipX, tipY, shade, c, lit, lateral);
          if (dew > 0.05 && hb > 0.8) {
            this.put(Math.round(tipX), Math.round(tipY), 255, 255, 240, dew);
          }
        }
        // Clover heads and dandelions in spring.
        if (flowers > 0.05 && h1 > 1 - flowers * 0.035) {
          const yellow = h0 > 0.55;
          const fc: RGB = yellow ? [236, 196, 40] : [240, 238, 226];
          const fx = x + (h0 - 0.5) * 3;
          const fy = baseY - height * s * 0.75;
          // Clover heads and dandelions a centimeter across.
          const size = Math.max(0.5, 0.0045 * s);
          for (let dy = -size; dy <= size; dy++) {
            for (let dx = -size; dx <= size; dx++) {
              if (dx * dx + dy * dy <= size * size + 0.3) {
                this.put(
                  fx + dx,
                  fy + dy,
                  shade.litR(fc[0]),
                  shade.litG(fc[1]),
                  shade.litB(fc[2]),
                  1,
                );
              }
            }
          }
        }
        // Fallen leaves lying in the grass.
        if (leaves > 0.05 && hash3(k, row, seed + 5) < leaves * 0.025) {
          // A leaf lying flat, seen from just above the ground: a thin sliver.
          const lc = mix(LEAVES[Math.floor(hash3(k, row, seed + 6) * LEAVES.length)], STRAW, 0.25);
          const half = Math.max(0.8, 0.018 * s);
          const flat = Math.max(0.5, half * (cam.eye / lateral) * 1.6);
          const ang = (hash3(k, row, seed + 7) - 0.5) * 0.5;
          for (let dx = -half; dx <= half; dx++) {
            const w = flat * Math.sqrt(Math.max(0, 1 - (dx * dx) / (half * half)));
            for (let dy = -w; dy <= w; dy++) {
              this.put(
                x + dx,
                baseY - w + dy + dx * ang * 0.3,
                shade.litR(lc[0]),
                shade.litG(lc[1]),
                shade.litB(lc[2]),
                1,
              );
            }
          }
        }
      }
    }
  }

  /** A blade of grass from its foot to its tip, thinning; nearer blades are wider at the foot. */
  private blade(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    shade: Shade,
    c: RGB,
    lit: number,
    lateral: number,
  ): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const wide = lateral < 0.34 ? 1 : 0;
    const r = shade.litR(c[0] * lit);
    const g = shade.litG(c[1] * lit);
    const b = shade.litB(c[2] * lit);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // A blade curves: it rises straight, then bends toward its tip.
      const x = x0 + (x1 - x0) * t * t;
      const y = y0 + (y1 - y0) * t;
      const a = t > 0.85 ? 0.6 : 1;
      this.put(x, y, r, g, b, a);
      if (wide && t < 0.5) {
        this.put(x + 1, y, r * 0.85, g * 0.85, b * 0.85, 0.7);
      }
    }
  }
}
