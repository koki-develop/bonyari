/** Side of a tile in art pixels. */
export const TILE = 64;
export const TILE_SHIFT = 6;
export const TILE_PIXELS = TILE * TILE;
/** Height stored where nothing was drawn: the sky shows there. */
export const NOTHING = -1e9;

/**
 * What the world looks like over one square of art pixels, drawn once and
 * kept: at each pixel, the material, a brightness for its texture, the
 * surface's facing, what it belongs to (a building, a field), and its height,
 * which is also its nearness (see `projection.ts`). `lit` is the pixel's
 * color under the light it was last shaded in.
 */
export class Tile {
  readonly tx: number;
  readonly ty: number;
  readonly mat = new Uint8Array(TILE_PIXELS);
  readonly detail = new Uint8Array(TILE_PIXELS);
  /** Unit normal, scaled to ±127. */
  readonly nx = new Int8Array(TILE_PIXELS);
  readonly ny = new Int8Array(TILE_PIXELS);
  readonly nz = new Int8Array(TILE_PIXELS);
  readonly owner = new Uint16Array(TILE_PIXELS);
  readonly z = new Float32Array(TILE_PIXELS).fill(NOTHING);
  readonly lit = new Uint32Array(TILE_PIXELS);
  /** Pixels of water, shaded afresh every frame. */
  water = new Uint16Array(0);
  /** Whether any pixel shows the sky. */
  open = true;
  /** Whether what is drawn is out of date, and whether anything has been drawn at all. */
  stale = true;
  drawn = false;
  /** Lighting epoch the colors were shaded in; -1 before the first shading. */
  litEpoch = -1;
  /** Frame the tile was last needed in, for eviction. */
  used = 0;

  constructor(tx: number, ty: number) {
    this.tx = tx;
    this.ty = ty;
  }

  /** Forgets everything drawn, before drawing afresh. */
  clear(): void {
    this.mat.fill(0);
    this.detail.fill(0);
    this.nx.fill(0);
    this.ny.fill(0);
    this.nz.fill(0);
    this.owner.fill(0);
    this.z.fill(NOTHING);
  }

  /** Notes the water pixels and whether the sky shows, once drawing is done. */
  finish(water: number): void {
    let count = 0;
    let open = false;
    for (let i = 0; i < TILE_PIXELS; i++) {
      if (this.mat[i] === water) {
        count++;
      } else if (this.mat[i] === 0) {
        open = true;
      }
    }
    const list = new Uint16Array(count);
    let k = 0;
    for (let i = 0; i < TILE_PIXELS; i++) {
      if (this.mat[i] === water) {
        list[k++] = i;
      }
    }
    this.water = list;
    this.open = open;
    this.stale = false;
    this.drawn = true;
  }
}

/** Keys tiles by their column and row, which may be negative. */
function key(tx: number, ty: number): number {
  return (ty + 4096) * 8192 + (tx + 4096);
}

/**
 * The tiles made so far. Tiles are made when first seen and dropped, least
 * recently used first, when too many are kept.
 */
export class TileStore {
  private readonly tiles = new Map<number, Tile>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get size(): number {
    return this.tiles.size;
  }

  /** The tile at (tx, ty), made (stale) if it wasn't kept. */
  get(tx: number, ty: number): Tile {
    const k = key(tx, ty);
    let tile = this.tiles.get(k);
    if (!tile) {
      tile = new Tile(tx, ty);
      this.tiles.set(k, tile);
    }
    return tile;
  }

  /** The tile at (tx, ty) if it is kept. */
  peek(tx: number, ty: number): Tile | undefined {
    return this.tiles.get(key(tx, ty));
  }

  /** Marks every kept tile touching the art pixel box [gx0, gx1) × [gy0, gy1) as out of date. */
  invalidate(gx0: number, gy0: number, gx1: number, gy1: number): void {
    const tx0 = Math.floor(gx0) >> TILE_SHIFT;
    const tx1 = (Math.ceil(gx1) - 1) >> TILE_SHIFT;
    const ty0 = Math.floor(gy0) >> TILE_SHIFT;
    const ty1 = (Math.ceil(gy1) - 1) >> TILE_SHIFT;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = this.tiles.get(key(tx, ty));
        if (tile) {
          tile.stale = true;
        }
      }
    }
  }

  /** Marks every tile as needing its colors shaded afresh. */
  unlightAll(): void {
    for (const tile of this.tiles.values()) {
      tile.litEpoch = -1;
    }
  }

  /** Marks every tile as out of date. */
  invalidateAll(): void {
    for (const tile of this.tiles.values()) {
      tile.stale = true;
    }
  }

  /** Drops the least recently used tiles not used since `frame` until within the limit. */
  evict(frame: number): void {
    if (this.tiles.size <= this.limit) {
      return;
    }
    const old = [...this.tiles.entries()]
      .filter(([, t]) => t.used < frame)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [k] of old) {
      if (this.tiles.size <= this.limit) {
        break;
      }
      this.tiles.delete(k);
    }
  }

  values(): IterableIterator<Tile> {
    return this.tiles.values();
  }
}
