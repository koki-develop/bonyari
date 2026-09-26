import { KINDS } from "../sim/buildings.ts";
import { rectPoint } from "../sim/geometry.ts";
import { WORLD } from "../sim/terrain.ts";
import type { World } from "../sim/world.ts";
import type { FrameInfo } from "./actors.ts";
import type { Light } from "./effects.ts";
import type { StreetLamp } from "./streetlamps.ts";
import { TILE, TILE_SHIFT, type Tile, type TileStore } from "./gbuffer.ts";
import { M } from "./materials.ts";
import { COS_E, gyOf, S, SIN_E } from "./projection.ts";
import { LAMP, LAMP_CELL, type Shader } from "./shading.ts";

const COT_E = COS_E / SIN_E;
const LAMP_W = Math.round((WORLD.x1 - WORLD.x0) / LAMP_CELL);
const LAMP_H = Math.round((WORLD.y1 - WORLD.y0) / LAMP_CELL);
/** Meters the light from a lit window (or a lamp by the way) reaches across the ground. */
const WINDOW_REACH = 6;
/** How strongly a torch on a pole and an iron lantern light the ground about them, and their color. */
const STREET_TORCH = 0.42;
const STREET_LANTERN = 0.36;
const TORCHLIGHT = [1, 0.66, 0.36] as const;

/**
 * Adds moving and flickering lights to the frame: each lights the surfaces
 * about it by their own color and by how they face it, fading with distance.
 */
export function applyLights(
  f: FrameInfo,
  lights: readonly Light[],
  store: TileStore,
  shader: Shader,
): void {
  const view = f.view;
  const data = view.data;
  const w = view.width;
  const h = view.height;
  const fz = f.z;
  const pal = shader.palette;
  const ownerColor = shader.ownerColor;
  const hasColor = shader.hasColor;
  for (const l of lights) {
    const reach = l.reach;
    const reach2 = reach * reach;
    const reachPx = reach / S;
    const cx = l.x / S - f.fx;
    const cy = gyOf(l.y, l.z) - f.fy;
    // A point within reach lies within reach/S rows of the light's own (sin E dy + cos E dz is at
    // most the distance), and on each row within the circle's chord across it.
    const y0 = Math.max(0, Math.floor(cy - reachPx));
    const y1 = Math.min(h - 1, Math.ceil(cy + reachPx));
    if (y0 > y1 || cx + reachPx < 0 || cx - reachPx >= w) {
      continue;
    }
    const lx = l.x;
    const ly = l.y;
    const lz = l.z;
    const lr = l.r;
    const lg = l.g;
    const lb = l.b;
    for (let sy = y0; sy <= y1; sy++) {
      const gy = f.fy + sy;
      const ty = gy >> TILE_SHIFT;
      const row = (gy - ty * TILE) * TILE;
      // Toward the light along y from what this row shows at height 0; each meter up adds cot E.
      const rowDy = ly + ((gy + 0.5) * S) / SIN_E;
      let tile: Tile | undefined;
      let tileX = 0x7fffffff;
      const drow = sy + 0.5 - cy;
      const chord2 = reachPx * reachPx - drow * drow;
      const chord = chord2 > 0 ? Math.sqrt(chord2) + 1 : 1;
      const x0 = Math.max(0, Math.floor(cx - chord));
      const x1 = Math.min(w - 1, Math.ceil(cx + chord));
      for (let sx = x0; sx <= x1; sx++) {
        const idx = sy * w + sx;
        const z = fz[idx];
        if (z < -1e8) {
          continue;
        }
        const gx = f.fx + sx;
        const dx = lx - (gx + 0.5) * S;
        const dy = rowDy + z * COT_E;
        const dz = lz - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= reach2) {
          continue;
        }
        const tx = gx >> TILE_SHIFT;
        if (tx !== tileX) {
          tileX = tx;
          tile = store.peek(tx, ty);
        }
        if (!tile) {
          continue;
        }
        const i = row + (gx - tx * TILE);
        const mat = tile.mat[i];
        if (mat === M.WATER) {
          continue;
        }
        const d = Math.sqrt(d2);
        let ndl = (tile.nx[i] * dx + tile.ny[i] * dy + tile.nz[i] * dz) / (127 * (d || 1));
        if (ndl < 0.15) {
          ndl = 0.15;
        }
        const q = 1 - d / reach;
        const fall = q * q * ndl * 1.5 * (tile.detail[i] / 128);
        const owner = tile.owner[i];
        let ar: number;
        let ag: number;
        let ab: number;
        if (owner !== 0 && hasColor[owner] === 1) {
          ar = ownerColor[owner * 3];
          ag = ownerColor[owner * 3 + 1];
          ab = ownerColor[owner * 3 + 2];
        } else {
          ar = pal[mat * 3];
          ag = pal[mat * 3 + 1];
          ab = pal[mat * 3 + 2];
        }
        const o = data[idx];
        let r = (o & 255) + ar * lr * fall;
        let g = ((o >>> 8) & 255) + ag * lg * fall;
        let b = ((o >>> 16) & 255) + ab * lb * fall;
        r = r > 255 ? 255 : r;
        g = g > 255 ? 255 : g;
        b = b > 255 ? 255 : b;
        data[idx] = 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
      }
    }
  }
}

/**
 * Gathers the steady light of lit windows onto the lamp grid: a warm pool
 * before each lit house, brighter the more its windows glow, and the glow
 * of the forge. Done when the lamps change.
 */
export function gatherLamps(
  world: World,
  shader: Shader,
  streetLamps: readonly StreetLamp[],
  lit: number,
): void {
  const grid = shader.lampGrid;
  grid.fill(0);
  const add = (x: number, y: number, k: number, r: number, g: number, b: number) => {
    const reach = WINDOW_REACH;
    const i0 = Math.max(0, Math.floor((x - reach - WORLD.x0) / LAMP_CELL));
    const i1 = Math.min(LAMP_W - 1, Math.ceil((x + reach - WORLD.x0) / LAMP_CELL));
    const j0 = Math.max(0, Math.floor((y - reach - WORLD.y0) / LAMP_CELL));
    const j1 = Math.min(LAMP_H - 1, Math.ceil((y + reach - WORLD.y0) / LAMP_CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = WORLD.x0 + (i + 0.5) * LAMP_CELL;
        const cy = WORLD.y0 + (j + 0.5) * LAMP_CELL;
        const d = Math.hypot(cx - x, cy - y);
        if (d >= reach) {
          continue;
        }
        const fall = (1 - d / reach) ** 2 * k;
        const q = (j * LAMP_W + i) * 3;
        grid[q] += r * fall;
        grid[q + 1] += g * fall;
        grid[q + 2] += b * fall;
      }
    }
  };
  for (const b of world.town.buildings) {
    if (b.phase !== "standing") {
      continue;
    }
    if (b.lamps > 0.03) {
      const front = rectPoint(b.rect, 0, -b.rect.depth / 2 - 1.2);
      const k = b.lamps * (b.kind === "tavern" ? 0.6 : 0.34);
      add(front.x, front.y, k, LAMP[0] / 255, LAMP[1] / 255, LAMP[2] / 255);
      if (KINDS[b.kind].housing > 0 || b.kind === "wizard") {
        const side = rectPoint(b.rect, b.rect.width / 2 + 1, 0);
        add(side.x, side.y, k * 0.5, LAMP[0] / 255, LAMP[1] / 255, LAMP[2] / 255);
      }
    }
    if (b.kind === "smithy") {
      const forge = rectPoint(b.rect, -b.rect.width / 2 + 1.3, -b.rect.depth / 2 + 1);
      add(forge.x, forge.y, 0.35 * world.env.darkness + 0.08, 1, 0.55, 0.25);
    }
  }
  if (lit > 0) {
    for (const lamp of streetLamps) {
      const k = lit * (lamp.iron ? STREET_LANTERN : STREET_TORCH);
      add(lamp.x, lamp.y, k, TORCHLIGHT[0], TORCHLIGHT[1], TORCHLIGHT[2]);
    }
  }
}
