import { mix, type RGB } from "../../shared/core/color.ts";
import { clamp01, lerp, smoothstep } from "../../shared/core/math.ts";
import { fbm1, hash2, hashU32, tileNoise } from "../../shared/core/random.ts";
import { bayer, type Surface } from "../../shared/core/surface.ts";
import { makeTerrainScratch, type Route } from "../sim/route.ts";
import type { World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Cover } from "../../shared/render/cover.ts";
import type { Painter } from "../../shared/render/painter.ts";

interface Ridge {
  lateral: number;
  /** Width (m) of the terrain filter, so far ridges change gradually. */
  filter: number;
  height(route: Route, along: number, seed: number): number;
  /** Tree canopy bumps on the skyline (m). */
  trees: number;
}

const T = makeTerrainScratch();
const BARE: RGB = [112, 100, 88];

const RIDGES: readonly Ridge[] = [
  {
    lateral: 16000,
    filter: 7000,
    height: (route, along, seed) =>
      route.terrain(along, T, 7000).mountains * (0.3 + 0.95 * fbm1(along / 4500, seed + 1, 4)),
    trees: 0,
  },
  {
    lateral: 6000,
    filter: 3000,
    height: (route, along, seed) =>
      route.terrain(along, T, 3000).mountains * 0.5 * (0.2 + fbm1(along / 1900, seed + 2, 4)),
    trees: 0,
  },
  {
    lateral: 1700,
    filter: 900,
    height: (route, along, seed) => {
      const t = route.terrain(along, T, 900);
      return (t.hills * 1.4 + t.mountains * 0.07) * (0.25 + fbm1(along / 800, seed + 3, 4));
    },
    trees: 14,
  },
  {
    lateral: 480,
    filter: 350,
    height: (route, along, seed) =>
      route.terrain(along, T, 350).hills *
      0.85 *
      Math.max(0, fbm1(along / 300, seed + 4, 3) * 1.3 - 0.2),
    trees: 12,
  },
  {
    // The sides of the valley the line runs up, close in among the mountains.
    lateral: 150,
    filter: 120,
    height: (route, along, seed) => {
      const t = route.terrain(along, T, 120);
      // Only where the line winds through wooded mountains.
      const mountains = smoothstep(0.6, 0.85, t.forest);
      return (
        t.hills *
        0.45 *
        mountains *
        (0.25 + 0.75 * Math.max(0, fbm1(along / 240, seed + 5, 3) * 1.4 - 0.2))
      );
    },
    trees: 7,
  },
];

/** Lateral distances (m) of the ridges, farthest first. */
export const RIDGE_LATERALS: readonly number[] = RIDGES.map((r) => r.lateral);

/**
 * Mountain ranges and hills drawn as filled skylines. `prepare` works out
 * each ridge's skyline for the frame and records, per column, the nearest
 * ridge so the ground behind it is not drawn; each ridge is then painted in
 * its place among the scenery, so things in front of it cover it and things
 * behind it are hidden.
 */
export class RidgeRenderer {
  /** Lateral distance of the nearest ridge standing in each column. */
  groundLimit = new Float32Array(0);
  /** Skyline height (m) of each ridge in each column this frame. */
  private heights: Float32Array[] = [];
  /** Whether each ridge shows anywhere this frame. */
  readonly visible = RIDGES.map(() => false);
  /**
   * Skyline heights per ridge, keyed by world-anchored cells one pixel wide.
   * Heights are pure functions of position, so they are computed once as the
   * ridge scrolls into view.
   */
  private readonly caches = RIDGES.map(() => ({ step: 0, heights: new Map<number, number>() }));
  private heightAt(
    index: number,
    ridge: Ridge,
    route: Route,
    seed: number,
    along: number,
    focal: number,
  ): number {
    const cache = this.caches[index];
    const step = ridge.lateral / focal;
    if (cache.step !== step) {
      cache.step = step;
      cache.heights.clear();
    }
    const k = Math.floor(along / step);
    const known = cache.heights.get(k);
    if (known !== undefined) {
      return known;
    }
    const at = (k + 0.5) * step;
    let h = ridge.height(route, at, seed);
    // Ridges only stand on land.
    const shore = route.shoreAt(route.terrain(at, T, Math.max(ridge.filter, 300)), at);
    h *= smoothstep(ridge.lateral - 300, ridge.lateral + 600, shore);
    if (ridge.trees > 0 && h > 1) {
      const bumps = fbm1(at / (ridge.trees * 0.55), seed + 17, 2);
      h += ridge.trees * (bumps - 0.3) * clamp01(h / 20);
    }
    if (cache.heights.size > 4096) {
      // Forget cells far behind; the train never comes back.
      for (const key of cache.heights.keys()) {
        if (key < k - 1500) {
          cache.heights.delete(key);
        }
      }
    }
    cache.heights.set(k, h);
    return h;
  }

  /** Works out the skylines and marks in `cover` the pixels each ridge paints over opaquely. */
  prepare(view: Surface, cam: Camera, world: World, cover: Cover): void {
    if (this.groundLimit.length !== view.width) {
      this.groundLimit = new Float32Array(view.width);
      this.heights = RIDGES.map(() => new Float32Array(view.width));
    }
    this.groundLimit.fill(Infinity);
    const route = world.route;
    const seed = world.seed;
    RIDGES.forEach((ridge, ri) => {
      const Z = ridge.lateral;
      const base = cam.y(Z, 0);
      const heights = this.heights[ri];
      let any = false;
      for (let x = 0; x < view.width; x++) {
        const along = cam.alongAt(x, Z);
        const h = this.heightAt(ri, ridge, route, seed, along, cam.focal);
        heights[x] = h;
        const top = cam.y(Z, h);
        if (h > 0.5 && top < base) {
          any = true;
          this.groundLimit[x] = Math.min(this.groundLimit[x], Z);
          // Below its top row the ridge face is opaque down to its foot.
          const y0 = Math.max(0, Math.floor(top));
          const y1 = Math.min(view.height - 1, Math.ceil(base));
          cover.markRun(x, y0 + 1, y1 + 1, Z);
        }
      }
      this.visible[ri] = any;
    });
  }

  /**
   * Paints ridge `ri`. Near ridges are wooded: tree crowns in lumps lit from
   * the sun's side, stands of evergreens among deciduous trees that take on
   * the colors of the season. Far ranges fade into the haze, snow on their tops.
   */
  draw(ri: number, p: Painter<Camera>, cover: Cover): void {
    const { view, cam, env, light, shade } = p;
    const ridge = RIDGES[ri];
    const heights = this.heights[ri];
    const season = env.season;
    const snow = env.weather.state.snowCover;
    const snowline = lerp(650, 2800, smoothstep(0.05, 0.5, season.warmth));
    const evergreen = season.evergreen;
    const deciduous = mix(BARE, season.leaf, clamp01(season.leafDensity * 1.2));
    const Z = ridge.lateral;
    const base = cam.y(Z, 0);
    const fogK = shade.fogAt(Z);
    const covered = cover.order;
    const far = Z > 3000;
    const hazeBody: RGB = mix(
      mix(evergreen, season.leaf, 0.35 * season.leafDensity),
      [70, 78, 82],
      0.5,
    );
    // Tree crowns a few pixels across, whatever the distance.
    const lump = Math.max(5, (4.2 * Z) / cam.focal);
    const lit = p.surfaceLight(p.sun.right > 0 ? 0.6 : -0.6, 0.6, 0.5);
    const shadeSide = p.surfaceLight(p.sun.right > 0 ? -0.6 : 0.6, 0.3, 0.7);
    const sunSign = p.sun.right >= 0 ? 1 : -1;
    for (let x = 0; x < view.width; x++) {
      const h = heights[x];
      if (h <= 0.5) {
        continue;
      }
      const top = cam.y(Z, h);
      if (top >= base) {
        continue;
      }
      const along = cam.alongAt(x, Z);
      const y0 = Math.max(0, Math.floor(top));
      const y1 = Math.min(view.height - 1, Math.ceil(base));
      const col = along / lump;
      const ci = Math.floor(col);
      let lastRow = Number.NaN;
      let shift = 0;
      for (let y = y0; y <= y1; y++) {
        // Painted over later by a nearer layer.
        if (covered[y * view.width + x] < Z) {
          continue;
        }
        // Height above ground of this pixel on the ridge face.
        const hy = cam.eye + ((cam.horizon - (y + 0.5)) * Z) / cam.focal;
        let r: number;
        let g: number;
        let b: number;
        if (far) {
          r = hazeBody[0];
          g = hazeBody[1];
          b = hazeBody[2];
        } else {
          // Crowns: each cell holds one, jittered in place and size, lit on
          // the side toward the sun, with dark gaps between them.
          const row = hy / (lump * 0.8);
          const rj = Math.floor(row);
          if (rj !== lastRow) {
            lastRow = rj;
            shift = hash2(rj, 311) * 0.8;
          }
          const cj = Math.floor(col + shift);
          // One hash gives the crown's shade, offset and size.
          const hv = hashU32(Math.imul(cj, 0x9e3779b1) ^ Math.imul(rj, 0x85ebca77) ^ ri);
          const cell = (hv & 255) / 255;
          const jx = (((hv >>> 8) & 255) / 255 - 0.5) * 0.35;
          const jy = (((hv >>> 16) & 255) / 255 - 0.5) * 0.35;
          const radius = 0.48 + 0.24 * ((hv >>> 24) / 255);
          const fxs = col + shift - cj - 0.5 - jx;
          const fy = row - rj - 0.5 - jy;
          const d2 = (fxs * fxs + fy * fy) / (radius * radius);
          const sunny = fxs * sunSign - fy * 0.8;
          let k =
            d2 < 1
              ? (shadeSide + (lit - shadeSide) * clamp01(0.5 + sunny * 1.4)) * (1 - d2 * 0.1)
              : shadeSide * 0.86;
          k *= 0.9 + 0.18 * cell;
          const stand = tileNoise(along / (lump * 6) + ri * 37, hy / (lump * 3.5));
          const c = stand < 0.55 ? evergreen : deciduous;
          r = c[0] * k;
          g = c[1] * k;
          b = c[2] * k;
        }
        const snowy = far
          ? smoothstep(snowline - 100, snowline + 250, hy) *
            (0.45 + 0.55 * clamp01(1 - season.warmth * 2))
          : snow * (0.55 + 0.25 * hash2(ci + 7, y));
        if (snowy > 0) {
          r = lerp(r, 236, snowy);
          g = lerp(g, 240, snowy);
          b = lerp(b, 248, snowy);
        }
        // Lighter along the skyline, as haze gathers in valleys.
        const edge = 1 - clamp01((y - top) / 3);
        const f = clamp01(fogK + (far ? 0.12 * (1 - edge) : 0));
        const k = 1 - f;
        const cr = r * light.ambient[0] * k + light.fog[0] * f;
        const cg = g * light.ambient[1] * k + light.fog[1] * f;
        const cb = b * light.ambient[2] * k + light.fog[2] * f;
        const d = bayer(x, y) - 0.5;
        const a = y === y0 ? clamp01(y0 + 1 - top + d * 0.6) : 1;
        view.blend(x, y, cr + d * 4, cg + d * 4, cb + d * 4, a);
      }
    }
  }
}
