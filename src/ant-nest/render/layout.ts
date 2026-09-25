import { FRAME } from "../sim/geometry.ts";

/** Fewest and most CSS pixels an art pixel (one millimeter) may take in the view a screen opens on. */
const MIN_CSS_PER_ART = 1.5;
const MAX_CSS_PER_ART = 2.5;
/** Most CSS pixels an art pixel may take zoomed in: closer, an ant of a few pixels is only blocks. */
const ZOOM_CSS_PER_ART = 6;
/** Share of the rows left over, beyond the frame, that go to the sky rather than the soil. */
const SKY_SHARE = 0.65;
/** Least share of a screen too short for the frame that is left to the sky. */
const SHORT_SKY = 0.22;

/** A rectangle of the section (mm): x to the right, y up. */
export interface Extent {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Layout {
  /** Canvas size in device pixels, and device pixels per CSS pixel. */
  deviceWidth: number;
  deviceHeight: number;
  dpr: number;
  /**
   * Device pixels per art pixel: the whole numbers from `minScale` (the
   * whole frame on the screen) to `maxScale`, opening at `homeScale`.
   */
  minScale: number;
  homeScale: number;
  maxScale: number;
  /** The part of the section the view may show: all the screen holds at `minScale`. */
  extent: Extent;
  /** The section position (mm) at the canvas's top left corner in the view the screen opens on. */
  home: { left: number; top: number };
}

/**
 * Sizes the view, one art pixel to the millimeter, scaled up by a whole
 * number. The view opens at the scale that fits the whole nest and some sky,
 * kept between 1.5 and 2.5 CSS pixels so an ant keeps its size from phone to
 * desktop; a screen too short for the frame at that size opens on the top of
 * it. From there it zooms out until the whole frame fits, and in until an
 * art pixel is 6 CSS pixels.
 * @param cssWidth the width of the view in CSS pixels
 */
export function computeLayout(deviceWidth: number, deviceHeight: number, cssWidth: number): Layout {
  const dpr = deviceWidth / Math.max(1, cssWidth);
  const frameW = FRAME.x1 - FRAME.x0;
  const frameH = FRAME.top - FRAME.bottom;
  const fit = Math.max(1, Math.floor(Math.min(deviceWidth / frameW, deviceHeight / frameH)));
  const least = Math.max(1, Math.ceil(MIN_CSS_PER_ART * dpr - 0.01));
  const most = Math.max(least, Math.floor(MAX_CSS_PER_ART * dpr));
  const homeScale = Math.min(most, Math.max(least, fit));
  const minScale = Math.min(homeScale, fit);
  const maxScale = Math.max(homeScale, Math.floor(ZOOM_CSS_PER_ART * dpr));
  const middle = (FRAME.x0 + FRAME.x1) / 2;

  const width = deviceWidth / minScale;
  const height = deviceHeight / minScale;
  const top = height >= frameH ? FRAME.top + (height - frameH) * SKY_SHARE : FRAME.top;
  const extent: Extent = {
    left: middle - width / 2,
    right: middle + width / 2,
    top,
    bottom: Math.min(FRAME.bottom, top - height),
  };

  const homeWidth = deviceWidth / homeScale;
  const homeHeight = deviceHeight / homeScale;
  // Too short for the frame: as much of the nest as fits under some sky.
  const homeTop =
    homeHeight >= frameH
      ? FRAME.top + (homeHeight - frameH) * SKY_SHARE
      : Math.max(homeHeight * SHORT_SKY, homeHeight + FRAME.bottom);
  return {
    deviceWidth,
    deviceHeight,
    dpr,
    minScale,
    homeScale,
    maxScale,
    extent,
    home: {
      left: middle - homeWidth / 2,
      top: Math.min(extent.top, Math.max(extent.bottom + homeHeight, homeTop)),
    },
  };
}
