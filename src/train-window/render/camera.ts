import type { HorizonVector } from "../sim/astro.ts";

/** Eye height (m) above the rails for a seated passenger. */
export const EYE_ABOVE_RAIL = 2.3;

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Pinhole camera looking out of the window, perpendicular to the track. The
 * sky is placed by the view heading (south when 0); screen right is the
 * direction of travel.
 * Positions are along-track (m, increasing to the right), lateral distance
 * from the track (m) and height above the surrounding ground (m).
 */
export class Camera {
  width = 1;
  height = 1;
  cx = 0.5;
  horizon = 0;
  focal = 1;
  /** Along-track position of the eye. */
  pos = 0;
  /** Eye height above the surrounding ground. */
  eye = EYE_ABOVE_RAIL;
  /** Rail height above the surrounding ground. */
  rail = 0;
  /** Distance (m) the eye moved during the displayed frame; spreads fast things into motion blur. */
  travel = 0;
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

  /** Screen y of a point at `height` above the rails (for trackside structures). */
  yRail(lateral: number, height: number): number {
    return this.horizon + ((EYE_ABOVE_RAIL - height) * this.focal) / lateral;
  }

  /** Height above the rails seen through the center of row `y` at a lateral distance. */
  railHeightAt(y: number, lateral: number): number {
    return EYE_ABOVE_RAIL - ((y + 0.5 - this.horizon) * lateral) / this.focal;
  }

  /** Art pixels per meter at a lateral distance. */
  scale(lateral: number): number {
    return this.focal / lateral;
  }

  /** Along-track position seen through the center of column `x` at a lateral distance. */
  alongAt(x: number, lateral: number): number {
    return this.pos + ((x + 0.5 - this.cx) * lateral) / this.focal;
  }

  /** Visible along-track range at a lateral distance, with a margin in pixels. */
  alongRange(lateral: number, marginPx: number): [number, number] {
    return [this.alongAt(-marginPx, lateral), this.alongAt(this.width + marginPx, lateral)];
  }

  /**
   * Blur footprint (m, along-track) of one pixel at a lateral distance: the
   * pixel's own width plus the distance traveled during the frame.
   */
  footprint(lateral: number, relativeTravel = this.travel): number {
    return lateral / this.focal + Math.abs(relativeTravel);
  }

  /** Heading of the view as an azimuth from south (radians, west positive). */
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
   * `up`, and `forward` out of the window.
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
