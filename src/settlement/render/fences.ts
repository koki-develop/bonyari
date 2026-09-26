import { alongFence, fenceBuilt, type FenceRun, fenceRun } from "../sim/fence.ts";
import type { World } from "../sim/world.ts";
import { M } from "./materials.ts";
import { PASTURE_OWNER } from "./owners.ts";
import { COS_E, S, SIN_E } from "./projection.ts";
import type { Face, TileRaster } from "./raster.ts";
import type { Structure } from "./scene.ts";

/** Meters between fence posts. */
const POST_STEP = 2.2;
/** Heights (m) of the post tops and of the two rails. */
const POST = 1.15;
const RAILS = [0.45, 0.9];
/** Steps a fence going up is drawn in. */
const STEPS = 40;

/**
 * A pasture's split-rail fence as the renderer draws it into the world: posts
 * and two rails round the pasture, with a gap and taller posts at the gate,
 * going up post by post from the gate while it is being built.
 */
export class FenceStructure implements Structure {
  gx0 = 0;
  gy0 = 0;
  gx1 = 0;
  gy1 = 0;
  readonly pasture: number;
  /** What it looked like when last drawn (see `look`), to see when it must be drawn again. */
  drawnLook = -1;
  private readonly world: World;
  private readonly run: FenceRun;
  private readonly face: Face;

  constructor(world: World, pasture: number) {
    this.world = world;
    this.pasture = pasture;
    this.run = fenceRun(world.plan, world.plan.pastures[pasture]);
    this.face = { mat: M.FENCE, owner: PASTURE_OWNER + pasture, paint: null, twoSided: true };
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of this.run.points) {
      const z = world.terrain.height(p.x, p.y);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    this.gx0 = Math.floor(x0 / S) - 2;
    this.gx1 = Math.ceil(x1 / S) + 2;
    this.gy0 = Math.floor(-(y1 * SIN_E + (z1 + POST + 0.5) * COS_E) / S) - 2;
    this.gy1 = Math.ceil(-(y0 * SIN_E + (z0 - 1) * COS_E) / S) + 2;
  }

  /** How far round it stands, in drawing steps. */
  look(): number {
    return Math.round(fenceBuilt(this.world, this.pasture) * STEPS);
  }

  draw(r: TileRaster): void {
    const built = this.look() / STEPS;
    if (built <= 0) {
      return;
    }
    const run = this.run;
    const t = this.world.terrain;
    const reach = built * run.length;
    // Posts at the corners and evenly between, so each side comes out even.
    const stations: number[] = [];
    for (let k = 1; k < run.points.length; k++) {
      const a = run.at[k - 1];
      const b = run.at[k];
      const n = Math.max(1, Math.round((b - a) / POST_STEP));
      for (let i = k === 1 ? 0 : 1; i <= n; i++) {
        stations.push(a + ((b - a) * i) / n);
      }
    }
    let last: { x: number; y: number; z: number } | null = null;
    for (const s of stations) {
      if (s > reach + 1e-6) {
        break;
      }
      const p = alongFence(run, s);
      const z = t.height(p.x, p.y);
      r.line(p.x, p.y, z - 0.1, p.x, p.y, z + POST, 2, this.face);
      if (last) {
        for (const h of RAILS) {
          r.line(last.x, last.y, last.z + h, p.x, p.y, z + h, 1, this.face);
        }
      }
      last = { x: p.x, y: p.y, z };
    }
    // Taller posts either side of the gate, once the fence is done.
    if (built >= 1) {
      for (const g of run.gate) {
        const z = t.height(g.x, g.y);
        r.line(g.x, g.y, z - 0.1, g.x, g.y, z + POST + 0.35, 2, this.face);
      }
    }
  }
}
