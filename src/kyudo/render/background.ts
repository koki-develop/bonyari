import { mix, type RGB } from "../../shared/core/color.ts";
import { fbm1, Rng } from "../../shared/core/random.ts";
import { bayer } from "../../shared/core/surface.ts";
import type { Environment } from "../../shared/env/environment.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import type { Painter } from "../../shared/render/painter.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import {
  type Crown,
  crownOf,
  drawBroadleaf,
  drawCedar,
  drawMaple,
  drawPine,
  drawSakura,
  type TreeKind,
} from "../../shared/render/trees.ts";
import type { DepthSurface } from "./depth.ts";

/** A tree around the dojo: x (m, right), z (m, ahead), its shape's seed and its crown. */
export interface Tree {
  kind: TreeKind;
  x: number;
  z: number;
  seed: number;
  crown: Crown;
}

/** Where trees may stand, and which kinds, with weights. */
interface Grove {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  count: readonly [number, number];
  kinds: Readonly<Partial<Record<TreeKind, number>>>;
}

const GROVES: readonly Grove[] = [
  // The wood behind the target house, cedars mostly, thinning to the right.
  { x0: -18, x1: -2, z0: 33, z1: 42, count: [5, 7], kinds: { cedar: 5, broadleaf: 1 } },
  { x0: 1, x1: 16, z0: 34, z1: 44, count: [2, 3], kinds: { broadleaf: 3, cedar: 1 } },
  // A cherry and a maple at the corners of the target house.
  { x0: -8.5, x1: -7, z0: 24, z1: 29, count: [1, 1], kinds: { sakura: 1 } },
  { x0: 8, x1: 9.5, z0: 24, z1: 30, count: [1, 1], kinds: { maple: 1 } },
  // Along the fences.
  { x0: -9.5, x1: -6.5, z0: 6, z1: 22, count: [3, 4], kinds: { sakura: 2, broadleaf: 3 } },
  { x0: 7.8, x1: 10.5, z0: 4, z1: 22, count: [3, 4], kinds: { broadleaf: 3, pine: 1, maple: 1 } },
  // Woods farther off.
  { x0: -60, x1: 60, z0: 60, z1: 110, count: [16, 22], kinds: { broadleaf: 3, cedar: 3 } },
];

/** The trees around the dojo, the same for a seed; sorted far to near for drawing. */
export function plantTrees(seed: number): Tree[] {
  const r = new Rng(seed ^ 0x7ee5);
  const trees: Tree[] = [];
  for (const g of GROVES) {
    const count = r.int(g.count[0], g.count[1]);
    for (let i = 0; i < count; i++) {
      const kind = r.weighted<TreeKind>(g.kinds);
      const treeSeed = r.int(0, 1 << 30);
      trees.push({
        kind,
        x: r.range(g.x0, g.x1),
        z: r.range(g.z0, g.z1),
        seed: treeSeed,
        crown: crownOf(kind, treeSeed),
      });
    }
  }
  return trees.sort((a, b) => b.z - a.z);
}

const DRAW: Record<
  TreeKind,
  (p: Painter, o: { along: number; lateral: number; seed: number }) => void
> = {
  broadleaf: drawBroadleaf,
  sakura: drawSakura,
  maple: drawMaple,
  cedar: drawCedar,
  pine: drawPine,
};

/**
 * Draws the trees, each hidden where the dojo stands in front of it; trees
 * entirely hidden are skipped. The depths must be summarized first.
 */
export function drawTrees(p: Painter<Pinhole>, view: DepthSurface, trees: readonly Tree[]): void {
  const cam = p.cam;
  for (const t of trees) {
    // Generously around the crown: branches and ragged leaves reach past it.
    const c = t.crown;
    const reach = Math.max(c.rx, c.height * 0.2) * 1.4;
    const x0 = cam.x(t.x - reach, t.z);
    const x1 = cam.x(t.x + reach, t.z);
    const y0 = cam.y(t.z, Math.max(c.height, c.center + c.ry) + 0.5);
    const y1 = cam.y(t.z, 0);
    if (x1 < 0 || x0 >= view.width || y1 < 0 || y0 >= view.height) {
      continue;
    }
    if (!view.anyBehind(x0, y0, x1, y1, t.z)) {
      continue;
    }
    view.z = t.z;
    p.base = 0;
    DRAW[t.kind](p, { along: t.x, lateral: t.z, seed: t.seed });
  }
}

/**
 * How much sunlight gets through the tree crowns to the ground at (x, z),
 * with the sun in direction (lx, ly, lz): 1 in the open, less in dappled shade.
 */
export function canopyLight(
  trees: readonly Tree[],
  x: number,
  z: number,
  lx: number,
  ly: number,
  lz: number,
  leafiness: number,
): number {
  let light = 1;
  for (const t of trees) {
    const c = t.crown;
    // Ray from the ground point toward the sun against the crown ellipsoid.
    const ox = (x - t.x) / c.rx;
    const oy = (0 - c.center) / c.ry;
    const oz = (z - t.z) / c.rx;
    const dx = lx / c.rx;
    const dy = ly / c.ry;
    const dz = lz / c.rx;
    const a = dx * dx + dy * dy + dz * dz;
    const b = ox * dx + oy * dy + oz * dz;
    const cc = ox * ox + oy * oy + oz * oz - 1;
    const disc = b * b - a * cc;
    if (disc <= 0 || b > 0) {
      continue;
    }
    // The longer the path through the crown, the deeper the shade.
    const chord = (2 * Math.sqrt(disc)) / a;
    light *= 1 - leafiness * Math.min(0.85, chord * 0.35 + 0.35);
  }
  return light;
}

/** Distant ridges: the far range and a nearer line of hills, faded into the haze. */
export function drawRidges(
  view: DepthSurface,
  cam: Pinhole,
  env: Environment,
  light: Lighting,
  seed: number,
): void {
  const layers = [
    { distance: 9000, rise: 0.035, amp: 0.045, freq: 1.4, tint: 0.78 },
    { distance: 2600, rise: 0.012, amp: 0.028, freq: 3.1, tint: 0.55 },
  ];
  const visibility = env.weather.state.visibility;
  const heading = cam.heading;
  for (const layer of layers) {
    // Hidden by haze beyond the visibility.
    const haze = 1 - Math.exp(-layer.distance / (visibility * 0.55));
    if (haze > 0.97) {
      continue;
    }
    const land: RGB = [62, 84, 70];
    const lit: RGB = [
      land[0] * light.ambient[0],
      land[1] * light.ambient[1],
      land[2] * light.ambient[2],
    ];
    const color = mix(lit, light.fog, Math.min(1, haze + layer.tint * 0.35));
    view.z = layer.distance;
    for (let x = 0; x < view.width; x++) {
      const az = heading + Math.atan((x + 0.5 - cam.cx) / cam.focal);
      const h = layer.rise + layer.amp * fbm1(az * layer.freq * 6, seed + layer.distance, 4);
      const top = cam.horizon - cam.focal * Math.tan(h);
      const y0 = Math.max(0, Math.floor(top));
      const y1 = Math.min(view.height, Math.ceil(cam.horizon + 2));
      for (let y = y0; y < y1; y++) {
        const i = y * view.width + x;
        if (view.depth[i] <= layer.distance) {
          continue;
        }
        // The ridge line is soft at the top pixel.
        const d = (bayer(x, y) - 0.5) * 6;
        const edge = y === y0 ? top - y0 : 0;
        const k = 1 - edge;
        const c = view.data[i];
        const r = (c & 255) + (color[0] + d - (c & 255)) * k;
        const g = ((c >>> 8) & 255) + (color[1] + d - ((c >>> 8) & 255)) * k;
        const b = ((c >>> 16) & 255) + (color[2] + d - ((c >>> 16) & 255)) * k;
        view.blend(x, y, r, g, b, 1);
        view.depth[i] = layer.distance;
      }
    }
  }
}
