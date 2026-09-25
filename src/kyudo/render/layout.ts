import { pixelScale } from "../../shared/render/display.ts";

/**
 * CSS pixels per art pixel wanted, as on a phone: an art pixel looks the same
 * size on any screen, so a larger screen shows the range in finer pixels
 * instead of the same pixels blown up.
 */
const CSS_PER_ART = 2;
/** Fewest and most art pixels along the shorter screen side (the most bounds the cost). */
const MIN_SHORT_SIDE = 190;
const MAX_SHORT_SIDE = 300;

export interface Layout {
  /** Framebuffer size in art pixels. */
  width: number;
  height: number;
  /** Device pixels per art pixel. */
  scale: number;
  portrait: boolean;
  /** Focal length (art px) standing at rest, taking in the whole range. */
  restFocal: number;
  /** Focal length at full draw, when the eye has settled on the mark. */
  aimFocal: number;
  /**
   * Focal length for the archer's own bow and arrow: the eye's natural field
   * of view, wider than the view of the range, which the eye narrows on the mark.
   */
  bowFocal: number;
  /** Where on the screen the middle of the range sits at rest. */
  restAnchor: { x: number; y: number };
  /** Where on the screen the aim sits at full draw. */
  aimAnchor: { x: number; y: number };
}

/** @param cssShort the shorter side of the view in CSS pixels */
export function computeLayout(deviceWidth: number, deviceHeight: number, cssShort: number): Layout {
  const shortSide = Math.min(MAX_SHORT_SIDE, Math.max(MIN_SHORT_SIDE, cssShort / CSS_PER_ART));
  const scale = pixelScale(deviceWidth, deviceHeight, shortSide);
  const width = Math.ceil(deviceWidth / scale);
  const height = Math.ceil(deviceHeight / scale);
  const portrait = height > width;
  const short = Math.min(width, height);
  return {
    width,
    height,
    scale,
    portrait,
    // Tall screens frame the target house edge to edge; wide ones take in the fences too.
    restFocal: short * (portrait ? 2.7 : 2.1),
    aimFocal: short * 9.5,
    bowFocal: short * 1.35,
    restAnchor: { x: width / 2, y: height * (portrait ? 0.53 : 0.58) },
    aimAnchor: { x: width / 2, y: height * (portrait ? 0.44 : 0.46) },
  };
}
