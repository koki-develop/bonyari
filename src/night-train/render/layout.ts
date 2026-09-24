export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  /** Framebuffer size in art pixels. */
  width: number;
  height: number;
  /** Device pixels per art pixel. */
  scale: number;
  portrait: boolean;
  /** The glass opening; the outside view is rendered at exactly this size. */
  window: Rect;
  /** Horizon row inside the window. */
  horizon: number;
  /** Focal length in art pixels. */
  focal: number;
  /** Dot-matrix clock panel above the window. */
  clock: Rect;
  /** Reading lamp beside the window: the interior light switch. */
  lamp: Rect;
  /** Table top under the window. */
  table: Rect;
  /** Width of each side curtain overlapping the glass. */
  curtain: number;
}

/** Target size of the shorter screen side in art pixels. */
const SHORT_SIDE = 190;

export function computeLayout(deviceWidth: number, deviceHeight: number): Layout {
  const scale = Math.max(1, Math.round(Math.min(deviceWidth, deviceHeight) / SHORT_SIDE));
  const width = Math.ceil(deviceWidth / scale);
  const height = Math.ceil(deviceHeight / scale);
  const portrait = height > width;

  const side = Math.max(16, Math.round(width * (portrait ? 0.09 : 0.075)));
  const top = Math.max(22, Math.round(height * (portrait ? 0.12 : 0.15)));
  const bottom = Math.max(30, Math.round(height * (portrait ? 0.16 : 0.21)));
  const window: Rect = {
    x: side,
    y: top,
    w: Math.max(1, width - side * 2),
    h: Math.max(1, height - top - bottom),
  };

  const clockW = 33;
  const clockH = 11;
  const clock: Rect = {
    x: Math.round(width / 2 - clockW / 2),
    y: Math.max(2, Math.round(top / 2 - clockH / 2) - 1),
    w: clockW,
    h: clockH,
  };
  // A small sconce on the wall above the window's left corner.
  const lamp: Rect = { x: side + 10, y: top - 17, w: 9, h: 12 };
  const tableDepth = Math.max(8, Math.round(bottom * 0.42));
  const table: Rect = { x: side - 6, y: window.y + window.h + 3, w: window.w + 12, h: tableDepth };

  return {
    width,
    height,
    scale,
    portrait,
    window,
    // Tall windows show more sky.
    horizon: Math.round(window.h * (portrait ? 0.64 : 0.56)),
    focal: 0.42 * Math.sqrt(window.w * window.h),
    clock,
    lamp,
    table,
    curtain: Math.max(5, Math.round(window.w * 0.035)),
  };
}
