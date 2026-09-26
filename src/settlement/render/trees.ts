import { hash2, hash3, Rng, tileNoise } from "../../shared/core/random.ts";
import { STUMP, type Tree } from "../sim/forest.ts";
import { M } from "./materials.ts";
import { COS_E, S, SIN_E } from "./projection.ts";
import { type Face, packed, type TileRaster } from "./raster.ts";

/** Screen box (art pixels) a tree may cover, for sorting trees into tiles. */
export function treeBounds(tree: Tree): { gx0: number; gy0: number; gx1: number; gy1: number } {
  const r = tree.radius + 0.6;
  return {
    gx0: Math.floor((tree.x - r) / S) - 1,
    gx1: Math.ceil((tree.x + r) / S) + 1,
    gy0: Math.floor(-((tree.y + r) * SIN_E + (tree.z + tree.height + 0.5) * COS_E) / S) - 1,
    gy1: Math.ceil(-((tree.y - r) * SIN_E + (tree.z - 0.5) * COS_E) / S) + 1,
  };
}

/** Kinds that drop their leaves in winter. */
function deciduous(tree: Tree): boolean {
  return tree.kind === "oak" || tree.kind === "birch" || tree.kind === "willow";
}

const LOBES = new Float64Array(4 * 24);

/**
 * Draws trees into tiles: a trunk and a crown of rounded lobes for the
 * broadleaves, stacked cones for the spruces, a tall bare trunk under a
 * flat crown for the pines. `foliage` (0..1) is how much of a broadleaf's
 * crown is in leaf; below it branches show through.
 */
export class TreePainter {
  foliage = 1;
  private readonly trunk: Face = { mat: M.TRUNK, owner: 0, paint: null };
  private readonly stump: Face = { mat: M.STUMP, owner: 0, paint: null };

  draw(r: TileRaster, tree: Tree, state: number): void {
    if (state === STUMP) {
      this.stump.paint = (u, v) =>
        packed(M.STUMP, 130 + (v > 0.3 ? 20 : 0) + hash2(Math.floor(u * 9), 3) * 20);
      r.cylinder(tree.x, tree.y, 0.28, tree.z - 0.2, tree.z + 0.32, this.stump, {
        mat: M.STUMP,
        owner: 0,
        paint: (u, v) => {
          const ring = Math.hypot(u, v);
          return packed(M.STUMP, 150 + (Math.floor(ring / 0.07) % 2 === 0 ? 18 : 0));
        },
      });
      return;
    }
    switch (tree.kind) {
      case "spruce":
        this.spruce(r, tree);
        break;
      case "pine":
        this.pine(r, tree);
        break;
      default:
        this.broadleaf(r, tree);
    }
  }

  /** A textured trunk from the ground up to `top`. */
  private drawTrunk(r: TileRaster, tree: Tree, radius: number, top: number, mat: number): void {
    const seed = tree.seed;
    this.trunk.mat = mat;
    this.trunk.paint =
      mat === M.TRUNK_BIRCH
        ? (u, v) =>
            packed(
              hash2(Math.floor(v / 0.25), seed) > 0.72 && hash2(Math.floor(u / 0.1), seed + 1) > 0.4
                ? M.TIMBER
                : M.TRUNK_BIRCH,
              126 + hash2(Math.floor(u / 0.1), Math.floor(v / 0.2)) * 18,
            )
        : (u, v) =>
            packed(mat, 116 + hash2(Math.floor(u / 0.08), Math.floor(v / 0.35) + seed) * 30);
    r.cylinder(tree.x, tree.y, radius, tree.z - 0.3, tree.z + top, this.trunk, null);
  }

  private broadleaf(r: TileRaster, tree: Tree): void {
    const rng = new Rng(tree.seed);
    const willow = tree.kind === "willow";
    const birch = tree.kind === "birch";
    const R = tree.radius;
    const crownMid = tree.z + tree.height - R * (birch ? 1.25 : 1.0);
    const trunkTop = crownMid + R * 0.2;
    this.drawTrunk(
      r,
      tree,
      birch ? 0.16 : willow ? 0.3 : 0.26,
      trunkTop - tree.z,
      birch ? M.TRUNK_BIRCH : M.TRUNK,
    );
    const leaf = birch ? M.LEAF_BIRCH : willow ? M.LEAF_WILLOW : M.LEAF_OAK;
    // The crown: lobes around a middle, flattened for the oak, tall and slim for the birch.
    const count = birch ? 9 : willow ? 11 : 10;
    const squash = birch ? 1.4 : willow ? 0.85 : 0.9;
    let n = 0;
    LOBES[n++] = tree.x;
    LOBES[n++] = tree.y;
    LOBES[n++] = crownMid;
    LOBES[n++] = R * 0.72;
    for (let k = 1; k < count; k++) {
      const a = rng.range(0, Math.PI * 2);
      const up = rng.range(-0.55, 0.85);
      const out = R * rng.range(0.35, 0.62);
      LOBES[n++] = tree.x + Math.cos(a) * out;
      LOBES[n++] = tree.y + Math.sin(a) * out;
      LOBES[n++] = crownMid + up * R * 0.55 * squash;
      LOBES[n++] = R * rng.range(0.42, 0.58) * (birch ? 0.8 : 1);
    }
    const foliage = this.foliage;
    const seed = tree.seed;
    if (foliage < 0.98) {
      this.branches(r, tree, crownMid, R, willow);
    }
    if (foliage < 0.08) {
      return;
    }
    r.lobes(
      LOBES,
      count,
      {
        mat: leaf,
        owner: 0,
        paint: (lobe, v, x, y, z) => {
          // Leafy clumps: coarse noise over the crown, a speckle of single leaves.
          const clump = tileNoise(x * 1.7 + seed * 0.001, (y + z) * 1.7);
          const speck = hash3(Math.floor(x / S), Math.floor(z / 0.17), seed);
          if (foliage < 1 && clump * 0.8 + speck * 0.2 > foliage) {
            return -1;
          }
          // Willows hang in streaks.
          const streak = willow ? (hash2(Math.floor(x / S), seed) > 0.5 ? 10 : -10) : 0;
          const edge = speck > 0.85 ? 26 : speck < 0.12 ? -26 : 0;
          return packed(leaf, 116 + clump * 30 + edge + streak + v * 16 + (lobe % 3) * 3);
        },
      },
      tree.x,
      tree.y,
      crownMid,
      R,
      0.55,
    );
  }

  /** Bare branches reaching up and out through a thin crown. */
  private branches(r: TileRaster, tree: Tree, mid: number, R: number, willow: boolean): void {
    const rng = new Rng(tree.seed ^ 0xb7a);
    const face: Face = { mat: M.BRANCH, owner: 0, paint: null };
    const base = mid - R * 0.35;
    for (let k = 0; k < 7; k++) {
      const a = rng.range(0, Math.PI * 2);
      const reach = R * rng.range(0.6, 0.95);
      const rise = R * (willow ? rng.range(0, 0.3) : rng.range(0.35, 0.8));
      const ex = tree.x + Math.cos(a) * reach;
      const ey = tree.y + Math.sin(a) * reach;
      const ez = base + rise;
      r.line(tree.x, tree.y, base, ex, ey, ez, 1, face);
      // A fork near the end.
      const b = a + rng.range(-0.8, 0.8);
      r.line(
        tree.x + Math.cos(a) * reach * 0.6,
        tree.y + Math.sin(a) * reach * 0.6,
        base + rise * 0.6,
        ex + Math.cos(b) * R * 0.25,
        ey + Math.sin(b) * R * 0.25,
        ez + (willow ? -R * 0.4 : R * 0.2),
        1,
        face,
      );
    }
  }

  private spruce(r: TileRaster, tree: Tree): void {
    const seed = tree.seed;
    this.drawTrunk(r, tree, 0.22, 1.6, M.TRUNK);
    const tiers = 4;
    const h = tree.height;
    const face: Face = {
      mat: M.NEEDLE_SPRUCE,
      owner: 0,
      paint: (u, v, x, y, z) => {
        // Drooping boughs: bands down the slope, broken by the needles.
        const bough = Math.floor(v / 0.45 + hash2(Math.floor(u / 0.6), seed) * 0.6);
        const band = v / 0.45 + hash2(Math.floor(u / 0.6), seed) * 0.6 - bough < 0.35 ? -20 : 8;
        const speck = hash3(Math.floor(x / S), Math.floor((y + z) / 0.2), seed) > 0.86 ? 18 : 0;
        return packed(M.NEEDLE_SPRUCE, 118 + band + speck);
      },
    };
    for (let t = 0; t < tiers; t++) {
      const f0 = 0.14 + t * 0.2;
      const f1 = f0 + 0.42;
      const rad = tree.radius * (1 - t * 0.2);
      r.cone(
        tree.x,
        tree.y,
        rad,
        tree.z + h * f0,
        tree.z + Math.min(h, h * f1 + (t === tiers - 1 ? h * 0.1 : 0)),
        face,
      );
    }
  }

  private pine(r: TileRaster, tree: Tree): void {
    const rng = new Rng(tree.seed);
    const R = tree.radius;
    const mid = tree.z + tree.height - R * 0.55;
    this.drawTrunk(r, tree, 0.22, mid - tree.z, M.TRUNK);
    let n = 0;
    const count = 7;
    for (let k = 0; k < count; k++) {
      const a = rng.range(0, Math.PI * 2);
      const out = k === 0 ? 0 : R * rng.range(0.35, 0.65);
      LOBES[n++] = tree.x + Math.cos(a) * out;
      LOBES[n++] = tree.y + Math.sin(a) * out;
      LOBES[n++] = mid + rng.range(-0.3, 0.4) * R * 0.5;
      LOBES[n++] = R * rng.range(0.38, 0.52);
    }
    const seed = tree.seed;
    r.lobes(
      LOBES,
      count,
      {
        mat: M.NEEDLE_PINE,
        owner: 0,
        paint: (lobe, v, x, y, z) => {
          const clump = tileNoise(x * 2.1 + seed * 0.001, (y + z) * 2.1);
          const speck = hash3(Math.floor(x / S), Math.floor(z / 0.17), seed);
          return packed(M.NEEDLE_PINE, 112 + clump * 34 + (speck > 0.85 ? 22 : 0) + v * 12 + lobe);
        },
      },
      tree.x,
      tree.y,
      mid,
      R,
      0.6,
    );
  }
}

/** Whether a tree's look depends on how much of the year's foliage is out. */
export function followsFoliage(tree: Tree): boolean {
  return deciduous(tree);
}
