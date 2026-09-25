import { pack, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep, TAU } from "../../shared/core/math.ts";
import { hash2 } from "../../shared/core/random.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import type { RestingArrow } from "../sim/arrows.ts";
import { ARROW_LENGTH, positionAt, SHAFT_RADIUS, velocityAt } from "../sim/flight.ts";
import type { Vec3 } from "../sim/geometry.ts";
import { CLEAR_TIME, type Flight } from "../sim/world.ts";
import type { DepthSurface } from "./depth.ts";
import { capsule } from "./draw2d.ts";
import { rod, spot } from "./draw3d.ts";
import type { Illuminator } from "./illum.ts";

/** Where the fletching runs along the shaft, measured from the nock (m), and how tall it stands. */
const FLETCH_FROM = 0.03;
const FLETCH_TO = 0.18;
const FLETCH_HEIGHT = 0.016;
/** The nock at the very end. */
const NOCK_LENGTH = 0.014;
/** Bamboo nodes along the shaft, from the nock (m). */
const NODES = [0.24, 0.5, 0.76] as const;

const BAMBOO: RGB = [206, 176, 118];
const NODE: RGB = [140, 108, 64];
const NOCK: RGB = [40, 34, 30];
const FEATHER_DARK: RGB = [44, 38, 36];
const FEATHER_PALE: RGB = [226, 222, 212];
/** Pale bands across the dark feathers (kirifu), as fractions of the vane's length. */
const BANDS = [
  [0.12, 0.3],
  [0.45, 0.6],
  [0.78, 0.92],
] as const;

/** Least coverage of an arrow's thin parts: sharper than the eye would see them, never lost. */
const MIN_COVER = 0.55;
/** Seconds a stuck arrow quivers for, its rate (Hz) and how far its nock swings (m). */
const QUIVER_TIME = 0.9;
const QUIVER_RATE = 13;
const QUIVER_SWING = 0.022;

/**
 * One spoke of a vane from the shaft to the vane's edge, at least half a pixel
 * wide so the feathers of distant arrows still show.
 */
function vane(
  view: DepthSurface,
  cam: Pinhole,
  root: Vec3,
  edge: Vec3,
  alpha: number,
  color: (out: [number, number, number]) => void,
): void {
  if (root.z < 0.1 || edge.z < 0.1) {
    return;
  }
  const rgb: [number, number, number] = [0, 0, 0];
  color(rgb);
  const c = pack(rgb[0], rgb[1], rgb[2]);
  view.z = (root.z + edge.z) / 2;
  const a = { x: cam.x(root.x, root.z), y: cam.y(root.z, root.y) };
  const b = { x: cam.x(edge.x, edge.z), y: cam.y(edge.z, edge.y) };
  const r = Math.max(0.45, (0.0012 * cam.focal) / view.z);
  capsule(view, a, b, r, r, () => c, alpha);
}

/** Draws the arrows standing in and lying about the range, and those in the air. */
export class ArrowRenderer {
  private readonly nock: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly vel: Vec3 = { x: 0, y: 0, z: 0 };

  draw(
    view: DepthSurface,
    cam: Pinhole,
    light: Illuminator,
    arrows: readonly RestingArrow[],
    flights: readonly Flight[],
    time: number,
    frameDt: number,
    clearing: readonly RestingArrow[],
    clearedFor: number,
  ): void {
    for (const a of arrows) {
      this.resting(view, cam, light, a, time, 1);
    }
    // Just cleared: fading from the range.
    const fade = 1 - smoothstep(0, CLEAR_TIME, clearedFor);
    if (fade > 0) {
      for (const a of clearing) {
        this.resting(view, cam, light, a, time, fade);
      }
    }
    for (const f of flights) {
      this.flight(view, cam, light, f, frameDt);
    }
  }

  private resting(
    view: DepthSurface,
    cam: Pinhole,
    light: Illuminator,
    a: RestingArrow,
    time: number,
    alpha: number,
  ): void {
    const half = a.rest === "stuck" ? 0 : ARROW_LENGTH / 2;
    const tip = this.tip;
    tip.x = a.x + a.dx * half;
    tip.y = a.y + a.dy * half;
    tip.z = a.z + a.dz * half;
    const nock = this.nock;
    nock.x = tip.x - a.dx * ARROW_LENGTH;
    nock.y = tip.y - a.dy * ARROW_LENGTH;
    nock.z = tip.z - a.dz * ARROW_LENGTH;
    // A stuck arrow shivers for a moment, its nock swinging most.
    let swingX = 0;
    let swingY = 0;
    const age = time - a.landedAt;
    if (a.rest === "stuck" && age >= 0 && age < QUIVER_TIME) {
      const k = QUIVER_SWING * Math.exp(-age / 0.22) * Math.sin(TAU * QUIVER_RATE * age);
      swingX = k * 0.45;
      swingY = k;
    }
    const spin = hash2(a.id, 5) * TAU;
    this.arrow(view, cam, light, nock, tip, swingX, swingY, spin, a.pair, alpha);
  }

  private flight(
    view: DepthSurface,
    cam: Pinhole,
    light: Illuminator,
    f: Flight,
    frameDt: number,
  ): void {
    const impact = f.impact;
    const settled = f.settled;
    const tip = this.tip;
    const nock = this.nock;
    if (impact && settled && f.age >= impact.time) {
      // Knocked off and falling to where it will lie.
      if (settled.drop <= 0) {
        return;
      }
      const p = clamp01((f.age - impact.time) / settled.drop);
      const rest = settled.arrow;
      const endTip = {
        x: rest.x + rest.dx * (ARROW_LENGTH / 2),
        y: rest.y + rest.dy * (ARROW_LENGTH / 2),
        z: rest.z + rest.dz * (ARROW_LENGTH / 2),
      };
      const fall = p * p;
      const i = impact.point;
      const d = impact.dir;
      tip.x = i.x + (endTip.x - i.x) * p;
      tip.y = i.y + (endTip.y - i.y) * fall;
      tip.z = i.z + (endTip.z - i.z) * p;
      const startNock = {
        x: i.x - d.x * ARROW_LENGTH * 0.6,
        y: i.y - d.y * ARROW_LENGTH * 0.6,
        z: i.z - d.z * ARROW_LENGTH * 0.6,
      };
      const endNock = {
        x: endTip.x - rest.dx * ARROW_LENGTH,
        y: endTip.y - rest.dy * ARROW_LENGTH,
        z: endTip.z - rest.dz * ARROW_LENGTH,
      };
      nock.x = startNock.x + (endNock.x - startNock.x) * p;
      nock.y = startNock.y + (endNock.y - startNock.y) * fall;
      nock.z = startNock.z + (endNock.z - startNock.z) * p;
      this.arrow(view, cam, light, nock, tip, 0, 0, hash2(f.id, 5) * TAU, f.pair, 1);
      return;
    }
    // In the air: smeared over the time the frame shows, spinning and flexing.
    const samples = 5;
    const vel = this.vel;
    for (let s = 0; s < samples; s++) {
      const age = Math.max(0, f.age - frameDt * (1 - (s + 0.5) / samples));
      if (impact && age > impact.time) {
        continue;
      }
      positionAt(f.launch, age, tip);
      velocityAt(f.launch, age, vel);
      const speed = Math.hypot(vel.x, vel.y, vel.z);
      nock.x = tip.x - (vel.x / speed) * ARROW_LENGTH;
      nock.y = tip.y - (vel.y / speed) * ARROW_LENGTH;
      nock.z = tip.z - (vel.z / speed) * ARROW_LENGTH;
      // The archer's paradox: the shaft flexes as it leaves the bow, and settles.
      const flex = 0.014 * Math.exp(-age / 0.12) * Math.sin(TAU * 42 * age);
      const spin = hash2(f.id, 5) * TAU + age * TAU * 22 * (f.pair === 0 ? 1 : -1);
      this.arrow(view, cam, light, nock, tip, flex, 0, spin, f.pair, 1.6 / samples);
    }
  }

  /**
   * One arrow from nock to tip. The nock end is moved by (swingX, swingY),
   * bending the shaft; `spin` turns the fletching about the shaft.
   */
  private arrow(
    view: DepthSurface,
    cam: Pinhole,
    light: Illuminator,
    nock: Vec3,
    tip: Vec3,
    swingX: number,
    swingY: number,
    spin: number,
    pair: 0 | 1,
    alpha: number,
  ): void {
    const nx = nock.x + swingX;
    const ny = nock.y + swingY;
    const nz = nock.z;
    const mz = (nz + tip.z) / 2;
    // Off the screen altogether: nothing to draw.
    if (nz > 0.1 && tip.z > 0.1) {
      const ax = cam.x(nx, nz);
      const bx = cam.x(tip.x, tip.z);
      const ay = cam.y(nz, ny);
      const by = cam.y(tip.z, tip.y);
      const pad = 3;
      if (
        (ax < -pad && bx < -pad) ||
        (ax > view.width + pad && bx > view.width + pad) ||
        (ay < -pad && by < -pad) ||
        (ay > view.height + pad && by > view.height + pad)
      ) {
        return;
      }
    }
    light.at((nx + tip.x) / 2, (ny + tip.y) / 2, mz, 0.2);
    const lit = (c: RGB, k: number, out: [number, number, number]) => {
      out[0] = light.r(c[0] * k);
      out[1] = light.g(c[1] * k);
      out[2] = light.b(c[2] * k);
    };
    // The shaft, with darker bamboo nodes and the nock at its end. A
    // quivering arrow bends: its middle swings less than its nock.
    const shaftColor = (from: number) => (t: number, out: [number, number, number]) => {
      const s = (from + t * 0.5) * ARROW_LENGTH;
      if (s < NOCK_LENGTH) {
        lit(NOCK, 1, out);
        return;
      }
      let node = false;
      for (const n of NODES) {
        node ||= Math.abs(s - n) < 0.012;
      }
      lit(node ? NODE : BAMBOO, 1, out);
    };
    const bx = (nx + tip.x) / 2 - swingX * 0.2;
    const by = (ny + tip.y) / 2 - swingY * 0.2;
    rod(view, cam, nx, ny, nz, bx, by, mz, SHAFT_RADIUS, alpha, shaftColor(0), MIN_COVER);
    rod(
      view,
      cam,
      bx,
      by,
      mz,
      tip.x,
      tip.y,
      tip.z,
      SHAFT_RADIUS,
      alpha,
      shaftColor(0.5),
      MIN_COVER,
    );

    // Feathers under a pixel across show as one dark fleck at the nock end.
    const fletchPx = (FLETCH_HEIGHT * cam.focal) / Math.max(0.1, nz);
    if (fletchPx < 0.8) {
      const fx = nx + (tip.x - nx) * 0.08;
      const fy = ny + (tip.y - ny) * 0.08;
      const fz = nz + (tip.z - nz) * 0.08;
      spot(
        view,
        cam,
        fx,
        fy,
        fz,
        FLETCH_HEIGHT,
        light.r(FEATHER_DARK[0]),
        light.g(FEATHER_DARK[1]),
        light.b(FEATHER_DARK[2]),
        0.8 * alpha,
      );
      return;
    }
    // Three vanes around the shaft.
    const len = Math.hypot(tip.x - nx, tip.y - ny, tip.z - nz);
    const ex = (tip.x - nx) / len;
    const ey = (tip.y - ny) / len;
    const ez = (tip.z - nz) / len;
    // Two directions across the shaft.
    let px = -ez;
    const py = 0;
    let pz = ex;
    const pl = Math.hypot(px, pz) || 1;
    px /= pl;
    pz /= pl;
    const qx = ey * pz - ez * py;
    const qy = ez * px - ex * pz;
    const qz = ex * py - ey * px;
    const twist = pair === 0 ? 0.35 : -0.35;
    for (let v = 0; v < 3; v++) {
      const angle = spin + (v * TAU) / 3;
      const feather = (t: number, out: [number, number, number]) => {
        let pale = false;
        for (const [a, b] of BANDS) {
          pale ||= t >= a && t <= b;
        }
        lit(pale ? FEATHER_PALE : FEATHER_DARK, 0.95, out);
      };
      // The vane's outer edge, from its low front to its tall back, twisted a little.
      const at = (s: number, height: number) => {
        const a = angle + (twist * (s - FLETCH_FROM)) / (FLETCH_TO - FLETCH_FROM);
        const ca = Math.cos(a) * height;
        const sa = Math.sin(a) * height;
        return {
          x: nx + ex * s + px * ca + qx * sa,
          y: ny + ey * s + py * ca + qy * sa,
          z: nz + ez * s + pz * ca + qz * sa,
        };
      };
      // Each vane is a web from the shaft out to its edge: fill it with
      // spokes along its length, so it shows as a sliver from the side and
      // as a spoke of the feathered star seen end-on.
      // A few pixels across, one spoke at the tall back end says as much.
      const spokes = fletchPx < 2.5 ? 1 : 4;
      for (let k = 0; k < spokes; k++) {
        const f = spokes === 1 ? 0 : k / (spokes - 1);
        const s = FLETCH_FROM + (FLETCH_TO - FLETCH_FROM) * f;
        // Tall at the back, low at the front.
        const edge = at(s, FLETCH_HEIGHT * (1 - 0.55 * f));
        const root = at(s, 0);
        vane(view, cam, root, edge, alpha, (out) => feather(1 - f, out));
      }
    }
  }
}
