import type { World } from "../sim/world.ts";
import { M } from "./materials.ts";
import { TILE_SHIFT, type Tile } from "./gbuffer.ts";
import { GroundPainter } from "./ground.ts";
import { TileRaster } from "./raster.ts";
import { followsFoliage, TreePainter, treeBounds } from "./trees.ts";

/** Keys a tile by its column and row. */
function key(tx: number, ty: number): number {
  return (ty + 4096) * 8192 + (tx + 4096);
}

/** Something drawn into the world that can change: a building, a fence, a bridge. */
export interface Structure {
  /** Screen box (art pixels) it covers. */
  gx0: number;
  gy0: number;
  gx1: number;
  gy1: number;
  draw(r: TileRaster): void;
}

/**
 * Everything drawn into the world's tiles, sorted by the tiles it touches:
 * the ground, the trees, and the structures the town raises. A tile is
 * drawn from scratch whenever something on it changes.
 */
export class Scene {
  private readonly world: World;
  private readonly raster = new TileRaster();
  private readonly ground: GroundPainter;
  readonly trees = new TreePainter();
  private readonly treeBins = new Map<number, number[]>();
  private readonly structureBins = new Map<number, Set<Structure>>();

  constructor(world: World) {
    this.world = world;
    this.ground = new GroundPainter(world);
    for (const tree of world.forest.trees) {
      const b = treeBounds(tree);
      for (let ty = b.gy0 >> TILE_SHIFT; ty <= b.gy1 >> TILE_SHIFT; ty++) {
        for (let tx = b.gx0 >> TILE_SHIFT; tx <= b.gx1 >> TILE_SHIFT; tx++) {
          const k = key(tx, ty);
          let bin = this.treeBins.get(k);
          if (!bin) {
            bin = [];
            this.treeBins.set(k, bin);
          }
          bin.push(tree.id);
        }
      }
    }
  }

  /** Adds a structure to the tiles it touches. */
  add(s: Structure): void {
    for (let ty = s.gy0 >> TILE_SHIFT; ty <= s.gy1 >> TILE_SHIFT; ty++) {
      for (let tx = s.gx0 >> TILE_SHIFT; tx <= s.gx1 >> TILE_SHIFT; tx++) {
        const k = key(tx, ty);
        let bin = this.structureBins.get(k);
        if (!bin) {
          bin = new Set();
          this.structureBins.set(k, bin);
        }
        bin.add(s);
      }
    }
  }

  remove(s: Structure): void {
    for (let ty = s.gy0 >> TILE_SHIFT; ty <= s.gy1 >> TILE_SHIFT; ty++) {
      for (let tx = s.gx0 >> TILE_SHIFT; tx <= s.gx1 >> TILE_SHIFT; tx++) {
        this.structureBins.get(key(tx, ty))?.delete(s);
      }
    }
  }

  /** Whether the tile holds broadleaf trees, whose look follows the year's foliage. */
  hasFoliage(tile: Tile): boolean {
    const bin = this.treeBins.get(key(tile.tx, tile.ty));
    return !!bin && bin.some((id) => followsFoliage(this.world.forest.trees[id]));
  }

  /** Draws a tile afresh. */
  draw(tile: Tile): void {
    const r = this.raster;
    r.begin(tile);
    this.ground.draw(r);
    this.ground.drawWater(r);
    const forest = this.world.forest;
    const bin = this.treeBins.get(key(tile.tx, tile.ty));
    if (bin) {
      for (const id of bin) {
        const state = forest.state[id];
        if (state !== 0) {
          this.trees.draw(r, forest.trees[id], state);
        }
      }
    }
    const structures = this.structureBins.get(key(tile.tx, tile.ty));
    if (structures) {
      for (const s of structures) {
        s.draw(r);
      }
    }
    tile.finish(M.WATER);
  }
}
