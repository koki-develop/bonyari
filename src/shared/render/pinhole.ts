import type { HorizonVector } from "../env/astro.ts";

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * An upright pinhole camera. Scene positions are `along` (m, to the right on
 * screen), `lateral` (m, distance straight ahead) and height (m, above the
 * surrounding ground). The optical axis stays level: looking up or down, or to
 * a side, shifts the principal point (`cx`, `horizon`) like a shift lens, so
 * verticals stay vertical. `heading` places the sky: it is the azimuth of the
 * view direction measured from south, west positive (0 looks south).
 */
export class Pinhole {
  width = 1;
  height = 1;
  /** Screen x of the optical axis. */
  cx = 0.5;
  /** Screen row of the horizon. */
  horizon = 0;
  /** Focal length in art pixels. */
  focal = 1;
  /** Along position of the eye. */
  pos = 0;
  /** Eye height above the surrounding ground. */
  eye = 0;
  private headingAngle = 0;
  private sinH = 0;
  private cosH = 1;

  configure(width: number, height: number, horizon: number, focal: number): void {
    this.width = width;
    this.height = height;
    this.cx = width / 2;
    this.horizon = horizon;
    this.focal = focal;
  }

  /** Screen x of a point. */
  x(along: number, lateral: number): number {
    return this.cx + ((along - this.pos) * this.focal) / lateral;
  }

  /** Screen y of a point at `height` above the ground. */
  y(lateral: number, height: number): number {
    return this.horizon + ((this.eye - height) * this.focal) / lateral;
  }

  /** Art pixels per meter at a lateral distance. */
  scale(lateral: number): number {
    return this.focal / lateral;
  }

  /** Along position seen through the center of column `x` at a lateral distance. */
  alongAt(x: number, lateral: number): number {
    return this.pos + ((x + 0.5 - this.cx) * lateral) / this.focal;
  }

  /** Visible along range at a lateral distance, with a margin in pixels. */
  alongRange(lateral: number, marginPx: number): [number, number] {
    return [this.alongAt(-marginPx, lateral), this.alongAt(this.width + marginPx, lateral)];
  }

  get heading(): number {
    return this.headingAngle;
  }

  set heading(value: number) {
    this.headingAngle = value;
    this.sinH = Math.sin(value);
    this.cosH = Math.cos(value);
  }

  /**
   * A horizon-frame direction in camera terms: `right` along the screen x axis,
   * `up`, and `forward` along the optical axis.
   */
  toCamera(v: HorizonVector): { right: number; up: number; forward: number } {
    return {
      right: -v.e * this.cosH + v.n * this.sinH,
      up: v.u,
      forward: -v.e * this.sinH - v.n * this.cosH,
    };
  }

  /** Projects a sky direction; null if it is behind the camera. */
  projectDirection(v: HorizonVector): ScreenPoint | null {
    const c = this.toCamera(v);
    if (c.forward < 0.05) {
      return null;
    }
    return {
      x: this.cx + (this.focal * c.right) / c.forward,
      y: this.horizon - (this.focal * c.up) / c.forward,
    };
  }

  /**
   * Unit direction (horizon frame) through the center of pixel (x, y), written
   * into `out` so per-pixel loops allocate nothing.
   */
  direction(x: number, y: number, out: HorizonVector): HorizonVector {
    const right = x + 0.5 - this.cx;
    const forward = this.focal;
    const up = this.horizon - (y + 0.5);
    const len = Math.hypot(right, forward, up);
    out.e = (-right * this.cosH - forward * this.sinH) / len;
    out.n = (right * this.sinH - forward * this.cosH) / len;
    out.u = up / len;
    return out;
  }
}
