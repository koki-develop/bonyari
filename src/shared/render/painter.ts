import type { RGB } from "../core/color.ts";
import { bump, clamp01 } from "../core/math.ts";
import { hash3 } from "../core/random.ts";
import type { Surface } from "../core/surface.ts";
import type { Environment } from "../env/environment.ts";
import type { Cover } from "./cover.ts";
import type { Lighting } from "./lighting.ts";
import type { Pinhole } from "./pinhole.ts";
import type { Shade } from "./shade.ts";

const WARM: RGB = [255, 206, 136];
const COOL: RGB = [222, 236, 255];

/** Share of homes with lights on by hour, before the lamps factor. */
function occupancy(hour: number): number {
  return (
    0.1 +
    0.7 * bump(hour, 20, 6, 1.5) +
    0.25 * bump(hour, 6.8, 1.6, 0.8) -
    0.06 * bump(hour, 3, 3, 1)
  );
}

/**
 * Drawing helpers for scenery at a given distance: colors are lit by the scene
 * and faded by aerial perspective; lights are emissive.
 */
export class Painter<C extends Pinhole = Pinhole> {
  view!: Surface;
  cam!: C;
  shade!: Shade;
  light!: Lighting;
  env!: Environment;
  /** Pixels that nearer layers will paint over later this frame. */
  cover!: Cover;
  time = 0;
  /** Art pixels per meter at the current distance. */
  s = 1;
  lateral = 1;
  /** Height (m) of the ground under what is being drawn, above the surrounding land. */
  base = 0;
  /**
   * Direction toward the sun in view terms: `right` along screen x, `up`, and
   * `back` toward the viewer (so a surface facing us is lit when it is positive).
   */
  readonly sun = { right: 0, up: 1, back: 0 };
  /** Strength (0..1) of direct sunlight. */
  direct = 0;
  private windowProbability = 0;
  private hourBucket = 0;

  begin(
    view: Surface,
    cam: C,
    shade: Shade,
    light: Lighting,
    env: Environment,
    time: number,
    cover: Cover,
  ): void {
    this.view = view;
    this.cover = cover;
    this.cam = cam;
    this.shade = shade;
    this.light = light;
    this.env = env;
    this.time = time;
    const hour = env.clock.hour;
    this.windowProbability = light.lamps * occupancy(hour);
    this.hourBucket = env.clock.days * 8;
    const sun = cam.toCamera(env.sky.sun);
    this.sun.right = sun.right;
    this.sun.up = sun.up;
    this.sun.back = -sun.forward;
    this.direct = light.direct;
  }

  /**
   * Relative brightness of a surface facing (nx, ny up, nz toward the viewer):
   * light from the sky above, plus the sun on the faces turned to it.
   */
  surfaceLight(nx: number, ny: number, nz: number): number {
    const sun = this.sun;
    const direct = this.direct;
    const sky = 0.5 + 0.5 * ny;
    const diffuse = Math.max(0, nx * sun.right + ny * sun.up + nz * sun.back);
    return (1 - direct) * (0.72 + 0.36 * sky) + direct * (0.48 + 0.2 * sky + 0.78 * diffuse);
  }

  at(lateral: number): this {
    this.lateral = lateral;
    this.s = this.cam.scale(lateral);
    this.shade.at(lateral);
    return this;
  }

  /** Screen x (unrounded) of an along position at the current distance. */
  x(along: number): number {
    return this.cam.x(along, this.lateral);
  }

  /** Screen y (unrounded) of a height (m) at the current distance. */
  y(height: number): number {
    return this.cam.y(this.lateral, height + this.base);
  }

  /** Fills [x0, x1) × [y0, y1) with a lit color. */
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const color = this.shade.rgb(c);
    this.view.fillRect(
      Math.round(x0),
      Math.round(y0),
      Math.round(x1) - Math.round(x0),
      Math.round(y1) - Math.round(y0),
      color,
    );
  }

  /** Fills a rect with a lit color at partial opacity. */
  rectAlpha(x0: number, y0: number, x1: number, y1: number, c: RGB, a: number): void {
    const sh = this.shade;
    const r = sh.litR(c[0]);
    const g = sh.litG(c[1]);
    const b = sh.litB(c[2]);
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        this.view.blend(x, y, r, g, b, a);
      }
    }
  }

  /** A soft-edged translucent disc of a lit color (smoke, mist). */
  discAlpha(cx: number, cy: number, radius: number, c: RGB, a: number): void {
    const sh = this.shade;
    const r = sh.litR(c[0]);
    const g = sh.litG(c[1]);
    const b = sh.litB(c[2]);
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius;
        if (d < 1) {
          this.view.blend(x, y, r, g, b, a * (1 - d * d));
        }
      }
    }
  }

  /** Sets one pixel to a lit color. */
  dot(x: number, y: number, c: RGB): void {
    this.view.set(Math.round(x), Math.round(y), this.shade.rgb(c));
  }

  /** Sets one pixel to a lit color scaled by `k`. */
  dotK(x: number, y: number, c: RGB, k: number): void {
    this.view.set(Math.round(x), Math.round(y), this.shade.color(c[0] * k, c[1] * k, c[2] * k));
  }

  /**
   * A filled disc of a lit color; with `dome`, shaded as a rounded surface
   * lit from the sun's side, otherwise as a flat face toward the viewer.
   */
  disc(cx: number, cy: number, radius: number, c: RGB, dome = false): void {
    const flat = this.surfaceLight(0, 0, 1);
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const dx = (x + 0.5 - cx) / radius;
        const dy = (y + 0.5 - cy) / radius;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1) {
          continue;
        }
        const k = dome ? this.surfaceLight(dx, -dy, Math.sqrt(1 - d2)) : flat;
        this.view.set(x, y, this.shade.color(c[0] * k, c[1] * k, c[2] * k));
      }
    }
  }

  /** An emissive disc: a lamp lens, brightest at its center. */
  lightDisc(cx: number, cy: number, radius: number, c: RGB): void {
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius;
        if (d <= 1) {
          this.lightDot(x, y, c, 1 - d * d * 0.35);
        }
      }
    }
  }

  /** A vertical round post or pipe, shaded across its width. */
  cylinder(cx: number, top: number, bottom: number, width: number, c: RGB): void {
    const half = Math.max(0.5, width / 2);
    for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
      const u = Math.max(-1, Math.min(1, (x + 0.5 - cx) / half)) * 0.9;
      const k = this.surfaceLight(u, 0, Math.sqrt(1 - u * u));
      const color = this.shade.color(c[0] * k, c[1] * k, c[2] * k);
      this.view.fillRect(x, Math.round(top), 1, Math.round(bottom) - Math.round(top), color);
    }
  }

  /** Fills a rect with an emissive color (blended by `a`). */
  lightRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
    const k = this.shade.lightStrength();
    const f = this.shade.f * 0.75;
    const fog = this.light.fog;
    const r = c[0] * (1 - f) + fog[0] * f;
    const g = c[1] * (1 - f) + fog[1] * f;
    const b = c[2] * (1 - f) + fog[2] * f;
    const alpha = clamp01(a * (0.3 + 0.7 * k));
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        this.view.blend(x, y, r, g, b, alpha);
      }
    }
  }

  lightDot(x: number, y: number, c: RGB, a = 1): void {
    this.lightRect(x, y, x + 1, y + 1, c, a);
  }

  glow(x: number, y: number, radius: number, c: RGB, intensity: number): void {
    this.view.glow(x, y, radius, c, intensity * this.shade.lightStrength());
  }

  /** Whether a window is lit now; each window keeps its state for a while. */
  windowLit(seed: number, index: number): boolean {
    if (this.windowProbability <= 0.01) {
      return false;
    }
    const offset = hash3(seed, index, 3);
    const bucket = Math.floor(this.hourBucket + offset);
    return hash3(seed, index, bucket) < this.windowProbability;
  }

  windowColor(seed: number, index: number): RGB {
    return hash3(seed, index, 11) < 0.7 ? WARM : COOL;
  }
}
