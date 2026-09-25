import { Pinhole } from "../../shared/render/pinhole.ts";

/** Eye height (m) above the rails for a seated passenger. */
export const EYE_ABOVE_RAIL = 2.3;

/**
 * Pinhole camera looking out of the window, perpendicular to the track. The
 * sky is placed by the view heading (south when 0); screen right is the
 * direction of travel, so `along` is the position along the track.
 */
export class Camera extends Pinhole {
  /** Rail height above the surrounding ground. */
  rail = 0;
  /** Distance (m) the eye moved during the displayed frame; spreads fast things into motion blur. */
  travel = 0;

  constructor() {
    super();
    this.eye = EYE_ABOVE_RAIL;
  }

  /** Screen y of a point at `height` above the rails (for trackside structures). */
  yRail(lateral: number, height: number): number {
    return this.horizon + ((EYE_ABOVE_RAIL - height) * this.focal) / lateral;
  }

  /** Height above the rails seen through the center of row `y` at a lateral distance. */
  railHeightAt(y: number, lateral: number): number {
    return EYE_ABOVE_RAIL - ((y + 0.5 - this.horizon) * lateral) / this.focal;
  }

  /**
   * Blur footprint (m, along-track) of one pixel at a lateral distance: the
   * pixel's own width plus the distance traveled during the frame.
   */
  footprint(lateral: number, relativeTravel = this.travel): number {
    return lateral / this.focal + Math.abs(relativeTravel);
  }
}
