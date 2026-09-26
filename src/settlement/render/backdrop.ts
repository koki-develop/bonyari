import { mix, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../shared/core/math.ts";
import { fbm1, hash2 } from "../../shared/core/random.ts";
import { bayer, type Surface } from "../../shared/core/surface.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import type { World } from "../sim/world.ts";

/** Focal length (art pixels) of the view over the ridge: the sky and the far mountains. */
export const BACKDROP_FOCAL = 420;
/** Azimuth (from the middle of the view, radians) of the dragon's mountain, and its height. */
const LAIR_AT = 0.16;
const LAIR_RISE = 0.2;

interface Range {
  /** Distance (m), for the haze. */
  distance: number;
  /** Mean rise above the horizon (radians) and how much it varies. */
  rise: number;
  amp: number;
  /** How often it peaks per radian, and how sharp the peaks are. */
  freq: number;
  sharp: number;
  land: RGB;
  /** Rise above which the peaks are white with snow all year. */
  snowline: number;
}

const RANGES: readonly Range[] = [
  {
    distance: 32000,
    rise: 0.1,
    amp: 0.1,
    freq: 2.2,
    sharp: 1.6,
    land: [96, 104, 122],
    snowline: 0.16,
  },
  {
    distance: 14000,
    rise: 0.065,
    amp: 0.05,
    freq: 4.5,
    sharp: 1.2,
    land: [70, 88, 84],
    snowline: 0.2,
  },
];

/**
 * What shows over the far ridge: the sky, drawn by the shared sky with a
 * camera looking out over the ridge, and the mountains far beyond it, the
 * nearest range wooded, the farthest snow-capped, one dark peak among them
 * with a thread of smoke going up from it.
 */
export function drawBackdrop(
  view: Surface,
  cam: Pinhole,
  world: World,
  light: Lighting,
  time: number,
): void {
  const env = world.env;
  const w = env.weather.state;
  const seed = world.seed;
  const rows = Math.min(view.height, Math.ceil(cam.horizon) + 1);
  if (rows <= 0) {
    return;
  }
  for (const range of RANGES) {
    const haze = clamp01(1 - Math.exp(-range.distance / (w.visibility * 0.6)) + 0.15);
    const lit: RGB = [
      range.land[0] * light.ambient[0],
      range.land[1] * light.ambient[1],
      range.land[2] * light.ambient[2],
    ];
    const snowLit: RGB = [232 * light.ambient[0], 236 * light.ambient[1], 246 * light.ambient[2]];
    const far = range === RANGES[0];
    for (let x = 0; x < view.width; x++) {
      const az = Math.atan((x + 0.5 - cam.cx) / cam.focal);
      const n = fbm1(az * range.freq * 6 + (far ? 0 : 40), seed + range.distance, 4);
      let h = range.rise + range.amp * (Math.pow(n, range.sharp) * 2 - 0.3);
      if (far) {
        // The dragon's mountain: a tall dark cone standing out of the range.
        const d = Math.abs(az - LAIR_AT);
        h = Math.max(h, LAIR_RISE - d * 1.9);
      }
      const top = cam.horizon - cam.focal * Math.tan(h);
      const y0 = Math.max(0, Math.floor(top));
      for (let y = y0; y < rows; y++) {
        const up = Math.atan((cam.horizon - (y + 0.5)) / cam.focal);
        const lair = far && Math.abs(az - LAIR_AT) < 0.11;
        let c = lair ? mix(lit, [40, 38, 44], 0.6) : lit;
        if (!lair && up > range.snowline - 0.02 * hash2(x, 7)) {
          c = snowLit;
        } else if (lair && up > LAIR_RISE - 0.03) {
          c = mix(c, [120, 60, 50], 0.4 * env.darkness);
        }
        // Lighter toward the peaks' sunward faces, darker in the folds.
        const fold = (fbm1(az * 60, seed + 3, 2) - 0.5) * 16;
        const hazed = mix(c, light.fog, haze);
        const d = (bayer(x, y) - 0.5) * 5 + fold * (1 - haze);
        const edge = y === y0 ? 1 - (top - y0) : 1;
        view.blend(x, y, hazed[0] + d, hazed[1] + d, hazed[2] + d, edge);
      }
    }
  }
  drawLairSmoke(view, cam, light, time, env.darkness);
}

/** A thin column of smoke leaning off the top of the dragon's mountain. */
function drawLairSmoke(
  view: Surface,
  cam: Pinhole,
  light: Lighting,
  time: number,
  dark: number,
): void {
  const baseX = cam.cx + cam.focal * Math.tan(LAIR_AT);
  const baseY = cam.horizon - cam.focal * Math.tan(LAIR_RISE);
  const smoke = mix([120, 118, 122], light.fog, 0.35);
  const lit: RGB = [
    smoke[0] * light.ambient[0] * 1.1,
    smoke[1] * light.ambient[1] * 1.1,
    smoke[2] * light.ambient[2] * 1.1,
  ];
  for (let k = 0; k < 40; k++) {
    const up = k * 1.2;
    const sway = Math.sin(time * 0.3 + k * 0.25) * (1 + up * 0.08) + up * 0.35;
    const r = 1 + up * 0.08;
    const a = 0.32 * (1 - k / 40) * smoothstep(0, 3, k);
    view.glow(baseX + sway, baseY - up, r * 2.2, lit, 0);
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy <= r * r) {
          view.blend(baseX + sway + dx, baseY - up + dy, lit[0], lit[1], lit[2], a);
        }
      }
    }
  }
  // Embers glow at the top by night.
  if (dark > 0.2) {
    view.glow(
      baseX,
      baseY + 1,
      5,
      [255, 110, 50],
      0.35 * dark * (0.8 + 0.2 * Math.sin(time * 1.7)),
    );
  }
}
