import { pack, type RGB } from "../core/color.ts";
import type { Lighting } from "./lighting.ts";

/**
 * Applies the scene lighting and aerial perspective to surface colors at a
 * given distance. Call `at(lateral)` before `color`/`light`.
 */
export class Shade {
  private ar = 1;
  private ag = 1;
  private ab = 1;
  private fr = 0;
  private fg = 0;
  private fb = 0;
  private visibility = 10000;
  /** Current fog amount 0..1. */
  f = 0;

  update(lighting: Lighting, visibility: number): void {
    [this.ar, this.ag, this.ab] = lighting.ambient;
    [this.fr, this.fg, this.fb] = lighting.fog;
    this.visibility = visibility;
  }

  fogAt(distance: number): number {
    return 1 - Math.exp(-distance / (this.visibility * 0.55));
  }

  at(distance: number): this {
    this.f = this.fogAt(distance);
    return this;
  }

  /** A lit surface color (0..255 channels), packed. */
  color(r: number, g: number, b: number): number {
    const f = this.f;
    const k = 1 - f;
    return pack(
      r * this.ar * k + this.fr * f,
      g * this.ag * k + this.fg * f,
      b * this.ab * k + this.fb * f,
    );
  }

  rgb(c: RGB): number {
    return this.color(c[0], c[1], c[2]);
  }

  /** Lit surface color as channels, for blending. */
  litR(r: number): number {
    return r * this.ar * (1 - this.f) + this.fr * this.f;
  }

  litG(g: number): number {
    return g * this.ag * (1 - this.f) + this.fg * this.f;
  }

  litB(b: number): number {
    return b * this.ab * (1 - this.f) + this.fb * this.f;
  }

  /** An emissive color: not darkened by the night, only softened by fog. */
  light(r: number, g: number, b: number): number {
    const f = this.f * 0.75;
    const k = 1 - f;
    return pack(r * k + this.fr * f, g * k + this.fg * f, b * k + this.fb * f);
  }

  /** Emissive strength after fog, for glows. */
  lightStrength(): number {
    return 1 - this.f * 0.85;
  }
}
