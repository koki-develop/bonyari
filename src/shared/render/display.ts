import { Surface } from "../core/surface.ts";

/**
 * Shows a low-resolution framebuffer on a canvas sized in device pixels,
 * scaled up by a whole number so every art pixel stays crisp. The art is
 * centered; whatever does not divide evenly is cropped at the edges.
 */
export class PixelDisplay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly art: HTMLCanvasElement;
  private readonly artCtx: CanvasRenderingContext2D;
  private image!: ImageData;
  /** The framebuffer to draw into, in art pixels. */
  screen!: Surface;
  /** Device pixels per art pixel. */
  scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private deviceWidth = 0;
  private deviceHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    this.art = document.createElement("canvas");
    const artCtx = this.art.getContext("2d");
    if (!ctx || !artCtx) {
      throw new Error("Canvas 2D is not available");
    }
    this.ctx = ctx;
    this.artCtx = artCtx;
  }

  /** Whether the canvas is already `deviceWidth` × `deviceHeight` device pixels. */
  matches(deviceWidth: number, deviceHeight: number): boolean {
    return deviceWidth === this.deviceWidth && deviceHeight === this.deviceHeight;
  }

  /** Sizes the canvas in device pixels and the framebuffer to `width` × `height` art pixels. */
  resize(deviceWidth: number, deviceHeight: number, width: number, height: number, scale: number) {
    this.deviceWidth = deviceWidth;
    this.deviceHeight = deviceHeight;
    this.canvas.width = deviceWidth;
    this.canvas.height = deviceHeight;
    this.scale = scale;
    this.screen = new Surface(width, height);
    this.art.width = width;
    this.art.height = height;
    this.image = new ImageData(new Uint8ClampedArray(this.screen.data.buffer), width, height);
    this.offsetX = Math.floor((width * scale - deviceWidth) / 2);
    this.offsetY = Math.floor((height * scale - deviceHeight) / 2);
  }

  /** Converts a position in CSS pixels on the canvas to art pixels. */
  toArt(cssX: number, cssY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dx = (cssX / rect.width) * this.deviceWidth;
    const dy = (cssY / rect.height) * this.deviceHeight;
    return { x: (dx + this.offsetX) / this.scale, y: (dy + this.offsetY) / this.scale };
  }

  /** Shows the framebuffer. */
  present(): void {
    this.artCtx.putImageData(this.image, 0, 0);
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.art,
      -this.offsetX,
      -this.offsetY,
      this.screen.width * this.scale,
      this.screen.height * this.scale,
    );
  }
}

/** Whole-number upscale that makes the shorter screen side about `shortSide` art pixels. */
export function pixelScale(deviceWidth: number, deviceHeight: number, shortSide: number): number {
  return Math.max(1, Math.round(Math.min(deviceWidth, deviceHeight) / shortSide));
}
