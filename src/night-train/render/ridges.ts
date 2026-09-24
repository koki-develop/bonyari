import { mix, type RGB } from "../core/color.ts";
import { clamp01, lerp, smoothstep } from "../core/math.ts";
import { fbm1, hash2 } from "../core/random.ts";
import { bayer, type Surface } from "../core/surface.ts";
import { makeTerrainScratch, type Route } from "../sim/route.ts";
import type { World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Lighting } from "./lighting.ts";
import type { Shade } from "./shade.ts";

interface Ridge {
  lateral: number;
  /** Width (m) of the terrain filter, so far ridges change gradually. */
  filter: number;
  height(route: Route, along: number, seed: number): number;
  /** Tree canopy bumps on the skyline (m). */
  trees: number;
}

const T = makeTerrainScratch();

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
    // The hillside a tunnel bores into.
    lateral: 75,
    filter: 0,
    height: (route, along, seed) =>
      route.portalHill(along) * (48 + 22 * fbm1(along / 90, seed + 5, 3)),
    trees: 9,
  },
];

/**
 * Mountain ranges and hills drawn as filled skylines, farthest first. Also
 * records, per column, the nearest ridge so the ground behind it is not drawn.
 */
export class RidgeRenderer {
  /** Lateral distance of the nearest ridge standing in each column. */
  groundLimit = new Float32Array(0);
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

  render(view: Surface, cam: Camera, world: World, light: Lighting, shade: Shade): void {
    if (this.groundLimit.length !== view.width) {
      this.groundLimit = new Float32Array(view.width);
    }
    this.groundLimit.fill(Infinity);
    const season = world.season;
    const snow = world.weather.state.snowCover;
    const snowline = lerp(650, 2800, smoothstep(0.05, 0.5, season.warmth));
    const route = world.route;
    const seed = world.seed;
    const forest = mix(season.evergreen, season.leaf, 0.35 * season.leafDensity);
    RIDGES.forEach((ridge, ri) => {
      const Z = ridge.lateral;
      const base = cam.y(Z, 0);
      const fogK = shade.fogAt(Z);
      const far = Z > 3000;
      const bodyNear: RGB = mix(forest, [70, 78, 82], far ? 0.5 : 0.1);
      for (let x = 0; x < view.width; x++) {
        const along = cam.alongAt(x, Z);
        const h = this.heightAt(ri, ridge, route, seed, along, cam.focal);
        if (h <= 0.5) {
          continue;
        }
        const top = cam.y(Z, h);
        if (top >= base) {
          continue;
        }
        this.groundLimit[x] = Math.min(this.groundLimit[x], Z);
        const y0 = Math.max(0, Math.floor(top));
        const y1 = Math.min(view.height - 1, Math.ceil(base));
        const colSeed = Math.floor(along / Math.max(1, Z / cam.focal) / 2);
        for (let y = y0; y <= y1; y++) {
          // Height above ground of this pixel on the ridge face.
          const hy = cam.eye + ((cam.horizon - (y + 0.5)) * Z) / cam.focal;
          let r = bodyNear[0];
          let g = bodyNear[1];
          let b = bodyNear[2];
          if (!far) {
            // Tree clumps.
            const v = hash2(colSeed, y) * 0.18 - 0.09;
            r *= 1 + v;
            g *= 1 + v;
            b *= 1 + v;
          }
          const snowy = far
            ? smoothstep(snowline - 100, snowline + 250, hy) *
              (0.45 + 0.55 * clamp01(1 - season.warmth * 2))
            : snow * (0.55 + 0.25 * hash2(colSeed + 7, y));
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
    });
  }
}
