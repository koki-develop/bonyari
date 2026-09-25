import { mix, type RGB } from "../../shared/core/color.ts";
import type { Surface } from "../../shared/core/surface.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import type { Extent } from "./layout.ts";
import { CLAY, LOAM, TOPSOIL } from "./palette.ts";

/** What every layer of a frame draws with. */
export interface Frame {
  view: Surface;
  /** Screen column of x = 0 and row of y = 0: one pixel to the millimeter. */
  cx: number;
  ground: number;
  /** All of the section the view can show, however it is zoomed and moved. */
  extent: Extent;
  /** Seconds of animation. */
  time: number;
  /** Channel multipliers for the light on what is drawn: the time of day above ground, steady below it. */
  light: RGB;
  lighting: Lighting;
  cam: Pinhole;
}

/** Screen x of a section x (mm). */
export function sx(f: Frame, x: number): number {
  return f.cx + x;
}

/** Screen y of a section y (mm). */
export function sy(f: Frame, y: number): number {
  return f.ground - y;
}

/** The unlit color of soil of a horizon (0 topsoil .. 2 clay). */
export function soilTone(layer: number): RGB {
  return layer < 1 ? mix(TOPSOIL, LOAM, layer) : mix(LOAM, CLAY, Math.min(1, layer - 1));
}

/**
 * Blends a soft-edged, shaded disc of `color` at (x, y) screen pixels,
 * `rx` by `ry` turned by `angle` (radians, screen y down): lit from the upper
 * left as a rounded thing.
 */
export function blob(
  view: Surface,
  x: number,
  y: number,
  rx: number,
  ry: number,
  angle: number,
  color: RGB,
  light: RGB,
  alpha = 1,
  shine = 0.35,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const reach = Math.max(rx, ry) + 1;
  for (let j = Math.floor(y - reach); j <= Math.ceil(y + reach); j++) {
    for (let i = Math.floor(x - reach); i <= Math.ceil(x + reach); i++) {
      // Coverage from four samples, for a smooth rim on tiny shapes.
      let cover = 0;
      let nxSum = 0;
      let nySum = 0;
      for (let s = 0; s < 4; s++) {
        const px = i + (s & 1 ? 0.75 : 0.25) - x;
        const py = j + (s & 2 ? 0.75 : 0.25) - y;
        const lx = (px * cos + py * sin) / rx;
        const ly = (-px * sin + py * cos) / ry;
        if (lx * lx + ly * ly <= 1) {
          cover++;
          nxSum += px / Math.max(rx, ry);
          nySum += py / Math.max(rx, ry);
        }
      }
      if (cover === 0) {
        continue;
      }
      const nx = nxSum / cover;
      const ny = nySum / cover;
      // Lighter toward the upper left.
      const k = 1 + shine * (-0.6 * nx - 0.8 * ny) - 0.12 * (nx * nx + ny * ny);
      view.blend(
        i,
        j,
        color[0] * k * light[0],
        color[1] * k * light[1],
        color[2] * k * light[2],
        (alpha * cover) / 4,
      );
    }
  }
}
