import { pack } from "../../shared/core/color.ts";
import { Surface } from "../../shared/core/surface.ts";

/** Side (px) of the tiles `anyBehind` tests. */
const TILE = 8;

/**
 * A framebuffer with a depth per pixel: the distance (m, along the view) of
 * the nearest surface drawn there. Drawing through the ordinary `Surface`
 * methods writes a pixel only where the current depth `z` is nearer, so
 * sprites and trees drawn after the scene sort behind whatever stands in
 * front of them. The scene itself sets the depths with `setDepth`.
 */
export class DepthSurface extends Surface {
  readonly depth: Float32Array<ArrayBuffer>;
  /** Depth (m) of what is being drawn now. */
  z = 0;
  /** Farthest depth in each tile of TILE × TILE pixels, for skipping hidden things. */
  private readonly tiles: Float32Array;
  private readonly tileCols: number;
  private readonly tileRows: number;

  constructor(width: number, height: number) {
    super(width, height);
    this.depth = new Float32Array(width * height);
    this.tileCols = Math.ceil(width / TILE);
    this.tileRows = Math.ceil(height / TILE);
    this.tiles = new Float32Array(this.tileCols * this.tileRows);
  }

  /** Records the farthest depth of every tile; call once the depths are set. */
  summarize(): void {
    this.tiles.fill(0);
    const w = this.width;
    for (let y = 0; y < this.height; y++) {
      const row = y * w;
      const tileRow = ((y / TILE) | 0) * this.tileCols;
      for (let x = 0; x < w; x++) {
        const d = this.depth[row + x];
        const t = tileRow + ((x / TILE) | 0);
        if (d > this.tiles[t]) {
          this.tiles[t] = d;
        }
      }
    }
  }

  /**
   * Whether anything at depth `z` inside the screen box could show: some
   * pixel there is farther away than `z`, as of the last `summarize`.
   */
  anyBehind(x0: number, y0: number, x1: number, y1: number, z: number): boolean {
    const c0 = Math.max(0, Math.floor(x0 / TILE));
    const c1 = Math.min(this.tileCols - 1, Math.floor(x1 / TILE));
    const r0 = Math.max(0, Math.floor(y0 / TILE));
    const r1 = Math.min(this.tileRows - 1, Math.floor(y1 / TILE));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (this.tiles[r * this.tileCols + c] > z) {
          return true;
        }
      }
    }
    return false;
  }

  clearDepth(): void {
    this.depth.fill(Infinity);
  }

  /** Whether something drawn at the current depth shows at pixel index `i`. */
  visible(i: number): boolean {
    return this.depth[i] > this.z;
  }

  /** Writes a pixel and its depth without testing, as the scene does. */
  setDepth(i: number, color: number, z: number): void {
    this.data[i] = color;
    this.depth[i] = z;
  }

  override set(x: number, y: number, color: number): void {
    x |= 0;
    y |= 0;
    if (this.inBounds(x, y)) {
      const i = y * this.width + x;
      if (this.depth[i] > this.z) {
        this.data[i] = color;
      }
    }
  }

  override blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    x |= 0;
    y |= 0;
    if (a <= 0 || !this.inBounds(x, y)) {
      return;
    }
    const i = y * this.width + x;
    if (this.depth[i] <= this.z) {
      return;
    }
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

  override add(x: number, y: number, r: number, g: number, b: number): void {
    x |= 0;
    y |= 0;
    if (!this.inBounds(x, y)) {
      return;
    }
    const i = y * this.width + x;
    if (this.depth[i] <= this.z) {
      return;
    }
    const c = this.data[i];
    this.data[i] = pack((c & 255) + r, ((c >>> 8) & 255) + g, ((c >>> 16) & 255) + b);
  }

  override fillRect(x: number, y: number, w: number, h: number, color: number): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    const z = this.z;
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * this.width;
      for (let xx = x0; xx < x1; xx++) {
        if (this.depth[row + xx] > z) {
          this.data[row + xx] = color;
        }
      }
    }
  }
}
