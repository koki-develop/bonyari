import type { RGB } from "../../shared/core/color.ts";
import { clamp01, mod, smoothstep, TAU } from "../../shared/core/math.ts";
import { hash2, hash3 } from "../../shared/core/random.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import { EAVE_Y, EAVE_Z, FENCE_X, RANGE_EAVE_Y, RANGE_EAVE_Z, RANGE_HALF } from "../sim/dojo.ts";
import type { World } from "../sim/world.ts";
import type { DepthSurface } from "./depth.ts";
import { rod, spot } from "./draw3d.ts";
import type { Illuminator } from "./illum.ts";

/** Depths (m) of the layers of falling rain, from just past the eaves to the bank. */
const LAYERS = [3.3, 4.6, 6.5, 9, 12.5, 17, 23] as const;
/** Raindrops per layer at the heaviest rain. */
const PER_LAYER = 190;
/** How high (m) the falling volume reaches, and how far to either side. */
const TOP = 7;
const SPAN = 9;
const RAIN_FALL = 7.5;
/** Seconds of exposure of a raindrop's streak. */
const EXPOSURE = 1 / 35;

const RAIN: RGB = [190, 200, 214];
/** Size (m) of a falling leaf. */
const LEAF_SIZE = 0.02;
const LEAVES: readonly RGB[] = [
  [206, 70, 40],
  [222, 146, 48],
  [150, 98, 58],
];
const DUST: RGB = [196, 174, 132];

/**
 * What moves in the air: rain, drips from the hall's eaves, falling leaves,
 * and the puff of sand where an arrow goes in. Every particle's place is a function of the time and its
 * index, so nothing is lost when frames are skipped.
 */
export class Particles {
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  render(view: DepthSurface, cam: Pinhole, world: World, illum: Illuminator, time: number): void {
    const env = world.env;
    const w = env.weather.state;
    const season = env.season;
    const wind = w.wind;
    this.rain(view, cam, illum, w.rain, wind, time);
    if (w.rain > 0.05) {
      this.eaveDrips(view, cam, illum, w.rain, time);
    }
    if (season.leafFall > 0.02) {
      this.leaves(view, cam, illum, season.leafFall * 26, wind, time);
    }
    this.dust(view, cam, illum, world);
  }

  /** Rain streaks through the air between the hall and the bank. */
  private rain(
    view: DepthSurface,
    cam: Pinhole,
    illum: Illuminator,
    rain: number,
    wind: number,
    time: number,
  ): void {
    if (rain < 0.02) {
      return;
    }
    const fall = RAIN_FALL;
    const drift = wind * 2.5;
    const count = Math.round(PER_LAYER * rain);
    const rgb: [number, number, number] = [0, 0, 0];
    const tint = (_t: number, out: [number, number, number]) => {
      out[0] = rgb[0];
      out[1] = rgb[1];
      out[2] = rgb[2];
    };
    const margin = 4;
    for (let l = 0; l < LAYERS.length; l++) {
      const zBase = LAYERS[l];
      // One light for the whole layer: the drops are too small to show more.
      illum.at(0, 1.5, zBase, 0.6);
      rgb[0] = illum.r(RAIN[0]);
      rgb[1] = illum.g(RAIN[1]);
      rgb[2] = illum.b(RAIN[2]);
      for (let i = 0; i < count; i++) {
        const h0 = hash3(i, l, this.seed);
        const h1 = hash3(i, l, this.seed + 1);
        const h2 = hash3(i, l, this.seed + 2);
        const z = zBase + (h2 - 0.5) * 1.2;
        // Each falls from the top of the volume to the ground, lies there a
        // moment (where rain splashes), then starts again.
        const cycle = TOP / fall + 0.08;
        const t = mod(time + h0 * cycle, cycle);
        const y = TOP - t * fall;
        const x = mod(h1 * SPAN * 2 + drift * t + SPAN, SPAN * 2) - SPAN;
        // Nothing falls under the target house's roof.
        const underRoof =
          z > RANGE_EAVE_Z && Math.abs(x) < RANGE_HALF + 0.3 && y < RANGE_EAVE_Y + 0.9;
        if (underRoof) {
          continue;
        }
        // Off the screen: nothing to draw.
        const sx = cam.x(x, z);
        const sy = cam.y(z, Math.max(0, y));
        if (
          sx < -margin ||
          sx > view.width + margin ||
          sy < -margin * 4 ||
          sy > view.height + margin
        ) {
          continue;
        }
        if (y < 0) {
          // Just landed: a raindrop splashes on the ground for a moment.
          const since = -y / fall;
          if (since < 0.06) {
            spot(
              view,
              cam,
              x,
              0.015,
              z,
              0.012 + since * 0.3,
              rgb[0],
              rgb[1],
              rgb[2],
              0.7 * (1 - since / 0.06),
            );
          }
          continue;
        }
        const len = fall * EXPOSURE;
        rod(view, cam, x - drift * EXPOSURE, y + len, z, x, y, z, 0.002, 0.8, tint);
      }
    }
  }

  /** Drops falling from the tip of the hall's eaves in a steady rhythm. */
  private eaveDrips(
    view: DepthSurface,
    cam: Pinhole,
    illum: Illuminator,
    rain: number,
    time: number,
  ): void {
    const z = EAVE_Z + 0.02;
    const [x0, x1] = cam.alongRange(z, 4);
    const spacing = 0.14;
    for (let k = Math.floor(x0 / spacing); k <= Math.ceil(x1 / spacing); k++) {
      const x = k * spacing + (hash2(k, this.seed) - 0.5) * 0.1;
      // Each drip point keeps its own beat, quicker in heavier rain.
      const period = (0.5 + hash2(k, this.seed + 3) * 1.4) / (0.4 + rain);
      const t = mod(time + hash2(k, this.seed + 5) * period, period);
      const y = EAVE_Y - 0.05 - 0.5 * 9.8 * t * t;
      if (y < 0) {
        continue;
      }
      // A falling drop streaks over the eye's longer glimpse of it, this close.
      const v = 9.8 * t;
      const len = Math.max(0.03, v / 20);
      illum.at(x, y, z, 0.4);
      rod(view, cam, x, y + len, z, x, y, z, 0.0022, 0.7, (_t, out) => {
        out[0] = illum.r(RAIN[0]);
        out[1] = illum.g(RAIN[1]);
        out[2] = illum.b(RAIN[2]);
      });
    }
  }

  /** Leaves drifting down across the range, turning as they fall. */
  private leaves(
    view: DepthSurface,
    cam: Pinhole,
    illum: Illuminator,
    count: number,
    wind: number,
    time: number,
  ): void {
    const top = 6;
    const fall = 0.9;
    const flutter = 1.4;
    const seed = 13;
    for (let i = 0; i < Math.round(count); i++) {
      const h0 = hash3(i, seed, this.seed);
      const h1 = hash3(i, seed + 1, this.seed);
      const h2 = hash3(i, seed + 2, this.seed);
      const speed = fall * (0.7 + h2 * 0.6);
      const cycle = top / speed;
      const t = mod(time + h0 * cycle, cycle);
      const y = top - t * speed;
      const z = 3.5 + h2 * 22;
      const x =
        FENCE_X -
        2 +
        mod(h1 * 12 + (0.3 + wind * 1.5) * t, 12) +
        Math.sin(time * flutter + h0 * TAU) * 0.3;
      if (y < 0) {
        continue;
      }
      const c = LEAVES[Math.floor(h0 * LEAVES.length)];
      // Turning over: flashing light and dark.
      const turn = 0.6 + 0.4 * Math.abs(Math.sin(time * flutter * 3 + h1 * TAU));
      illum.at(x, y, z, 0.5);
      spot(
        view,
        cam,
        x,
        y,
        z,
        LEAF_SIZE,
        illum.r(c[0] * turn),
        illum.g(c[1] * turn),
        illum.b(c[2] * turn),
        1,
      );
    }
  }

  /** A puff of sand or soil where an arrow has just gone in. */
  private dust(view: DepthSurface, cam: Pinhole, illum: Illuminator, world: World): void {
    for (const a of world.arrows) {
      const age = world.time - a.landedAt;
      if (
        a.rest !== "stuck" ||
        age < 0 ||
        age > 0.6 ||
        a.material === "wood" ||
        a.material === "hedge"
      ) {
        continue;
      }
      const grow = smoothstep(0, 0.25, age);
      const fade = 1 - smoothstep(0.1, 0.6, age);
      // Where the shaft enters: a little back along it from the buried point.
      const depth = a.material === "target" ? 0.16 : 0.18;
      const x0 = a.x - a.dx * depth;
      const y0 = a.y - a.dy * depth;
      const z0 = a.z - a.dz * depth;
      illum.at(x0, y0, z0, 0.6);
      for (let k = 0; k < 7; k++) {
        const ang = hash2(a.id, k) * TAU;
        const r = (0.02 + 0.06 * hash2(a.id, k + 9)) * grow;
        const x = x0 + Math.cos(ang) * r;
        const y = y0 + Math.abs(Math.sin(ang)) * r * 0.8 + grow * 0.02;
        spot(
          view,
          cam,
          x,
          y,
          z0 - 0.05,
          0.012 + 0.02 * grow,
          illum.r(DUST[0]),
          illum.g(DUST[1]),
          illum.b(DUST[2]),
          0.5 * fade * clamp01(1 - k * 0.08),
        );
      }
    }
  }
}
