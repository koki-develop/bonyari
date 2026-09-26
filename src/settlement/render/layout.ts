/** CSS pixels an art pixel takes in the view a screen opens on: phones, and wider screens. */
const HOME_CSS_PER_ART = 2;
const WIDE_HOME_CSS_PER_ART = 2.5;
/** CSS width from which a screen counts as wide. */
const WIDE = 760;
/** Fewest CSS pixels an art pixel may take zoomed out, and most zoomed in. */
const LEAST_CSS_PER_ART = 1;
const ZOOM_CSS_PER_ART = 6;
/** Most art pixels the view may show at once: every frame shades them all. */
const MOST_ART_PIXELS = 360_000;

/** A rectangle of global art pixels: columns to the right, rows down. */
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
  /** Device pixels per art pixel: whole numbers from `minScale` to `maxScale`, opening at `homeScale`. */
  minScale: number;
  homeScale: number;
  maxScale: number;
  /** The part of the world the view may show. */
  extent: Extent;
}

/**
 * Sizes the view: art pixels scaled up by a whole number, opening at about
 * two CSS pixels an art pixel so people keep their size from phone to
 * desktop; zooming out to one CSS pixel (or as far as keeps the number of
 * art pixels shown within what a frame can shade), and in to six.
 * @param cssWidth the width of the view in CSS pixels
 */
export function computeLayout(
  deviceWidth: number,
  deviceHeight: number,
  cssWidth: number,
  extent: Extent,
): Layout {
  const dpr = deviceWidth / Math.max(1, cssWidth);
  const budget = Math.ceil(Math.sqrt((deviceWidth * deviceHeight) / MOST_ART_PIXELS));
  // Never so far out that the view is wider or taller than the world.
  const fit = Math.ceil(
    Math.max(
      deviceWidth / (extent.right - extent.left),
      deviceHeight / (extent.bottom - extent.top),
    ),
  );
  const minScale = Math.max(1, Math.ceil(LEAST_CSS_PER_ART * dpr - 0.01), budget, fit);
  const maxScale = Math.max(minScale, Math.floor(ZOOM_CSS_PER_ART * dpr));
  const home = cssWidth >= WIDE ? WIDE_HOME_CSS_PER_ART : HOME_CSS_PER_ART;
  const homeScale = Math.min(maxScale, Math.max(minScale, Math.round(home * dpr)));
  return { deviceWidth, deviceHeight, dpr, minScale, homeScale, maxScale, extent };
}
