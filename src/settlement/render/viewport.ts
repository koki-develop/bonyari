import { clamp } from "../../shared/core/math.ts";
import type { Layout } from "./layout.ts";

/** How much one zoom step (a key press) enlarges the view, at least. */
const ZOOM_STEP = 1.25;

/** Where the art pixels of a frame fall on the canvas. */
export interface Placement {
  /** Framebuffer size in art pixels. */
  width: number;
  height: number;
  /** Device pixels per art pixel. */
  scale: number;
  /** Global art pixel at the framebuffer's top left corner. */
  gx: number;
  gy: number;
  /** Device pixels the framebuffer's top left corner lies up and left of the canvas's. */
  offsetX: number;
  offsetY: number;
}

/**
 * What part of the world the canvas shows, and how large: the scale is a
 * whole number of device pixels per art pixel so the pixels stay crisp, and
 * the view moves by device pixels so it glides even zoomed far in. The view
 * never leaves the layout's extent.
 *
 * Positions on the canvas are in CSS pixels from its top left corner; the
 * world is addressed in global art pixels (columns right, rows down).
 */
export class Viewport {
  private layout: Layout | null = null;
  /** Device pixels per art pixel now. */
  scale = 1;
  /** The scale asked for, between whole numbers while a pinch or the wheel is under way. */
  private asked = 1;
  /** Global art pixel at the canvas's top left corner. */
  private left = 0;
  private top = 0;
  /** Whether the view is still the one the screen opened on, untouched. */
  private atHome = true;
  /** Global art pixel the home view centers on. */
  private homeX = 0;
  private homeY = 0;

  /** Where the home view looks: set before the first layout, and whenever the town's middle moves. */
  setHome(gx: number, gy: number): void {
    this.homeX = gx;
    this.homeY = gy;
  }

  /**
   * Takes a new screen size. An untouched view opens on the home view; one
   * zoomed or moved keeps its middle where it was and its art pixels about as
   * many CSS pixels large.
   */
  setLayout(layout: Layout): void {
    const old = this.layout;
    if (!old || this.atHome) {
      this.layout = layout;
      this.home();
      return;
    }
    const middle = this.middle;
    this.layout = layout;
    this.asked = (this.scale / old.dpr) * layout.dpr;
    this.scale = this.levelScale();
    this.center(middle.x, middle.y);
  }

  /** Back to the view the screen opens on. */
  home(): void {
    const l = this.need();
    this.asked = l.homeScale;
    this.scale = l.homeScale;
    this.center(this.homeX, this.homeY);
    this.atHome = true;
  }

  /** How far zoomed in from the home view: 1 there, more closer in. */
  get zoom(): number {
    return this.scale / this.need().homeScale;
  }

  /** The global art pixel at the middle of the canvas. */
  get middle(): { x: number; y: number } {
    const l = this.need();
    return this.toArt(l.deviceWidth / l.dpr / 2, l.deviceHeight / l.dpr / 2);
  }

  /** The global art pixel under a point on the canvas. */
  toArt(cssX: number, cssY: number): { x: number; y: number } {
    const dpr = this.need().dpr;
    return { x: this.left + (cssX * dpr) / this.scale, y: this.top + (cssY * dpr) / this.scale };
  }

  /** Art pixels the view spans across and down. */
  get span(): { width: number; height: number } {
    const l = this.need();
    return { width: l.deviceWidth / this.scale, height: l.deviceHeight / this.scale };
  }

  /** Moves the view with a finger dragged by (dx, dy) CSS pixels. */
  panBy(dx: number, dy: number): void {
    const dpr = this.need().dpr;
    this.move(this.left - (dx * dpr) / this.scale, this.top - (dy * dpr) / this.scale);
  }

  /** Zooms by `factor`, keeping what is under (cssX, cssY) there. */
  zoomBy(factor: number, cssX: number, cssY: number): void {
    this.zoomTo(this.asked * factor, cssX, cssY);
  }

  /** One step in (`direction` 1) or out (-1), about (cssX, cssY). */
  step(direction: 1 | -1, cssX: number, cssY: number): void {
    const s = this.scale;
    const next =
      direction > 0
        ? Math.max(s + 1, Math.round(s * ZOOM_STEP))
        : Math.min(s - 1, Math.round(s / ZOOM_STEP));
    this.zoomTo(next, cssX, cssY);
  }

  /**
   * Zooms to the scale `level` and moves the view so the art pixel `at` is
   * under (cssX, cssY): a pinch holds what it started on under the fingers.
   */
  zoomTo(level: number, cssX: number, cssY: number, at = this.toArt(cssX, cssY)): void {
    const l = this.need();
    this.asked = clamp(level, l.minScale - 0.49, l.maxScale + 0.49);
    const scale = this.scale;
    this.scale = this.levelScale();
    this.move(at.x - (cssX * l.dpr) / this.scale, at.y - (cssY * l.dpr) / this.scale, scale);
  }

  /** The scale asked for: the scale now, or between whole numbers while a zoom is under way. */
  get level(): number {
    return this.asked;
  }

  /** Where the art pixels of a frame fall now. */
  placement(): Placement {
    const l = this.need();
    const s = this.scale;
    const col = Math.floor(this.left);
    const row = Math.floor(this.top);
    const offsetX = Math.round((this.left - col) * s);
    const offsetY = Math.round((this.top - row) * s);
    return {
      width: Math.ceil((l.deviceWidth + offsetX) / s),
      height: Math.ceil((l.deviceHeight + offsetY) / s),
      scale: s,
      gx: col,
      gy: row,
      offsetX,
      offsetY,
    };
  }

  private levelScale(): number {
    const l = this.need();
    return clamp(Math.round(this.asked), l.minScale, l.maxScale);
  }

  /** Moves the view's corner to (left, top), and notes whether that changed the view. */
  private move(left: number, top: number, scale = this.scale): void {
    const before = [this.left, this.top];
    this.left = left;
    this.top = top;
    this.settle();
    if (this.left !== before[0] || this.top !== before[1] || this.scale !== scale) {
      this.atHome = false;
    }
  }

  /** Puts the middle of the view on (x, y), as near as the extent allows. */
  private center(x: number, y: number): void {
    const l = this.need();
    this.left = x - l.deviceWidth / this.scale / 2;
    this.top = y - l.deviceHeight / this.scale / 2;
    this.settle();
  }

  /** Keeps the view in the extent, its corner on a device pixel. */
  private settle(): void {
    const l = this.need();
    const s = this.scale;
    const e = l.extent;
    this.left = fitSpan(Math.round(this.left * s) / s, e.left, e.right - l.deviceWidth / s);
    this.top = fitSpan(Math.round(this.top * s) / s, e.top, e.bottom - l.deviceHeight / s);
  }

  private need(): Layout {
    if (!this.layout) {
      throw new Error("the viewport has no layout yet");
    }
    return this.layout;
  }
}

/** `v` within [lo, hi]; midway if the span is empty (the view is wider than the extent). */
function fitSpan(v: number, lo: number, hi: number): number {
  return hi < lo ? (lo + hi) / 2 : clamp(v, lo, hi);
}
