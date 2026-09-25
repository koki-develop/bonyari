import { pack, type RGB } from "./color.ts";

/** 4x4 ordered-dither thresholds in (0, 1). */
export const BAYER4 = new Float32Array(
  [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16),
);

export function bayer(x: number, y: number): number {
  return BAYER4[((y & 3) << 2) | (x & 3)];
}

/**
 * A software framebuffer. Every pixel is an opaque color packed as in `ImageData`
 * (see `pack`). All drawing is clipped to its bounds.
 */
export class Surface {
  readonly width: number;
  readonly height: number;
  readonly data: Uint32Array<ArrayBuffer>;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint32Array(width * height);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  fill(color: number): void {
    this.data.fill(color);
  }

  set(x: number, y: number, color: number): void {
    x |= 0;
    y |= 0;
    if (this.inBounds(x, y)) {
      this.data[y * this.width + x] = color;
    }
  }

  get(x: number, y: number): number {
    x = x < 0 ? 0 : x >= this.width ? this.width - 1 : x | 0;
    y = y < 0 ? 0 : y >= this.height ? this.height - 1 : y | 0;
    return this.data[y * this.width + x];
  }

  /** Alpha-blends an RGB color (0..255 channels) over the pixel. */
  blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    x |= 0;
    y |= 0;
    if (a <= 0 || !this.inBounds(x, y)) {
      return;
    }
    const i = y * this.width + x;
    if (a >= 1) {
      this.data[i] = pack(r, g, b);
      return;
    }
    const c = this.data[i];
    const cr = c & 255;
    const cg = (c >>> 8) & 255;
    const cb = (c >>> 16) & 255;
    this.data[i] = pack(cr + (r - cr) * a, cg + (g - cg) * a, cb + (b - cb) * a);
  }

  /** Adds light to the pixel. */
  add(x: number, y: number, r: number, g: number, b: number): void {
    x |= 0;
    y |= 0;
    if (!this.inBounds(x, y)) {
      return;
    }
    const i = y * this.width + x;
    const c = this.data[i];
    this.data[i] = pack((c & 255) + r, ((c >>> 8) & 255) + g, ((c >>> 16) & 255) + b);
  }

  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * this.width;
      this.data.fill(color, row + x0, row + Math.max(x0, x1));
    }
  }

  blendRect(x: number, y: number, w: number, h: number, c: RGB, a: number): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        this.blend(xx, yy, c[0], c[1], c[2], a);
      }
    }
  }

  /** Additive radial glow with a smooth falloff; `intensity` scales the center color. */
  glow(cx: number, cy: number, radius: number, c: RGB, intensity: number): void {
    if (intensity <= 0.002 || radius <= 0) {
      return;
    }
    const r2 = radius * radius;
    // Only the part inside the bounds can change.
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) {
          continue;
        }
        const f = 1 - d2 / r2;
        const k = f * f * intensity;
        this.add(x, y, c[0] * k, c[1] * k, c[2] * k);
      }
    }
  }

  /** Copies `src` onto this surface at (dx, dy), clipped to the bounds. */
  blit(src: Surface, dx: number, dy: number): void {
    const x0 = Math.max(0, dx);
    const y0 = Math.max(0, dy);
    const x1 = Math.min(this.width, dx + src.width);
    const y1 = Math.min(this.height, dy + src.height);
    for (let y = y0; y < y1; y++) {
      const s = (y - dy) * src.width + (x0 - dx);
      this.data.set(src.data.subarray(s, s + (x1 - x0)), y * this.width + x0);
    }
  }
}
