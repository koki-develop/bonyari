import { FRAME } from "../sim/geometry.ts";

/** Fewest and most CSS pixels an art pixel (one millimeter) may take. */
const MIN_CSS_PER_ART = 1.5;
const MAX_CSS_PER_ART = 2.5;
/** Share of the rows left over, beyond the frame, that go to the sky rather than the soil. */
const SKY_SHARE = 0.65;
/** Least share of a screen too short for the frame that is left to the sky. */
const SHORT_SKY = 0.22;

export interface Layout {
  /** Framebuffer size in art pixels, one per millimeter of the section. */
  width: number;
  height: number;
  /** Device pixels per art pixel. */
  scale: number;
  /** Screen column of x = 0. */
  cx: number;
  /** Screen row of the ground level (y = 0) when the view is not dragged. */
  ground: number;
  /** How far (rows) the view may be dragged up and down from there; 0 when the frame fits. */
  panUp: number;
  panDown: number;
}

/**
 * Sizes the view so the whole nest and some sky fit on the screen, one art
 * pixel to the millimeter, scaled up by a whole number. The pixels stay
 * between 1.5 and 2.5 CSS pixels so an ant keeps its size from phone to
 * desktop; a screen too short for the frame at that size shows part of it,
 * and the view can be dragged.
 * @param cssWidth the width of the view in CSS pixels
 */
export function computeLayout(deviceWidth: number, deviceHeight: number, cssWidth: number): Layout {
  const dpr = deviceWidth / Math.max(1, cssWidth);
  const frameW = FRAME.x1 - FRAME.x0;
  const frameH = FRAME.top - FRAME.bottom;
  const fit = Math.floor(Math.min(deviceWidth / frameW, deviceHeight / frameH));
  const least = Math.max(1, Math.ceil(MIN_CSS_PER_ART * dpr - 0.01));
  const most = Math.max(least, Math.floor(MAX_CSS_PER_ART * dpr));
  const scale = Math.min(most, Math.max(least, fit));
  const width = Math.ceil(deviceWidth / scale);
  const height = Math.ceil(deviceHeight / scale);
  const cx = Math.round(width / 2 - (FRAME.x0 + FRAME.x1) / 2);
  if (height >= frameH) {
    const extra = height - frameH;
    return {
      width,
      height,
      scale,
      cx,
      ground: FRAME.top + Math.round(extra * SKY_SHARE),
      panUp: 0,
      panDown: 0,
    };
  }
  // Too short: as much of the nest as fits under some sky, and room to drag to either end of the frame.
  const ground = Math.max(Math.round(height * SHORT_SKY), height - 1 + FRAME.bottom);
  return {
    width,
    height,
    scale,
    cx,
    ground,
    panUp: Math.max(0, FRAME.top - ground),
    panDown: Math.max(0, ground - FRAME.bottom - height + 1),
  };
}
