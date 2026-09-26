import { mix, pack, type RGB } from "../../shared/core/color.ts";
import { clamp01 } from "../../shared/core/math.ts";
import { tileNoise } from "../../shared/core/random.ts";
import type { Surface } from "../../shared/core/surface.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import { TILE, type Tile } from "./gbuffer.ts";
import { COS_E, S, SIN_E } from "./projection.ts";

/** How fast (m/s) the ripples drift downstream, toward the viewer. */
const FLOW = 0.8;

/**
 * The river's surface, shaded afresh every frame: the sky mirrored in it,
 * broken by ripples drifting downstream, the depth showing through, and
 * glints where the sun catches the ripples. The rain roughens it.
 */
export class WaterShader {
  private reflect: RGB = [0, 0, 0];
  private deep: RGB = [0, 0, 0];
  private glint: RGB = [0, 0, 0];
  private glintAmount = 0;
  private rain = 0;

  /** Takes this frame's light: the sky it mirrors and where the sun is. */
  update(light: Lighting, sunY: number, sunZ: number, rain: number): void {
    // Seen from above, the water mirrors the sky well up from the horizon, dimmed.
    const sky = mix(light.zenith, light.horizon, 0.3);
    this.reflect = [sky[0] * 0.82, sky[1] * 0.86, sky[2] * 0.9];
    const a = light.ambient;
    this.deep = [36 * a[0] + 4, 64 * a[1] + 6, 72 * a[2] + 10];
    // The sun's mirror image: the view reflected off level water points up and away.
    const align = clamp01(COS_E * sunY + SIN_E * sunZ);
    this.glintAmount = light.direct * Math.pow(align, 12);
    this.glint = light.sunDisc;
    this.rain = rain;
  }

  /** Shades the water pixels of `tile` into `view`, whose top left is global art pixel (fx, fy). */
  shade(tile: Tile, view: Surface, fx: number, fy: number, time: number): void {
    const list = tile.water;
    const gx0 = tile.tx * TILE;
    const gy0 = tile.ty * TILE;
    const [rr, rg, rb] = this.reflect;
    const [dr, dg, db] = this.deep;
    const [gr, gg, gb] = this.glint;
    const glint = this.glintAmount;
    const rough = 1 + this.rain * 1.5;
    const data = view.data;
    const w = view.width;
    const h = view.height;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const px = i & (TILE - 1);
      const py = i >> 6;
      const sx = gx0 + px - fx;
      const sy = gy0 + py - fy;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
        continue;
      }
      const z = tile.z[i];
      const x = (gx0 + px + 0.5) * S;
      const y = (-(gy0 + py + 0.5) * S - z * COS_E) / SIN_E;
      const flow = y + time * FLOW;
      const a = tileNoise(x * 0.9, flow * 1.6);
      const b = tileNoise(x * 2.3 + 17, flow * 3.1 - time * 0.4);
      const ripple = (a * 0.6 + b * 0.4 - 0.5) * rough;
      const m = 0.42 + ripple * 0.5;
      let r = dr + (rr - dr) * m;
      let g = dg + (rg - dg) * m;
      let bl = db + (rb - db) * m;
      const d = tile.detail[i] / 128;
      r *= d;
      g *= d;
      bl *= d;
      if (glint > 0.01 && ripple > 0.12) {
        const s = glint * (ripple - 0.12) * 3.2;
        r += gr * s;
        g += gg * s;
        bl += gb * s;
      }
      data[sy * w + sx] = pack(r, g, bl);
    }
  }
}
