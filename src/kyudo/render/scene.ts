import { mix, pack, type RGB } from "../../shared/core/color.ts";
import { clamp01, intervalCoverage, pulseCoverage, smoothstep } from "../../shared/core/math.ts";
import { hash2, hash3, tileNoise } from "../../shared/core/random.ts";
import { bayer } from "../../shared/core/surface.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import type { Shade } from "../../shared/render/shade.ts";
import type { Hole } from "../sim/arrows.ts";
import {
  AZUCHI_HEIGHT,
  EYE,
  HALL_PRIMS,
  MAKU_BOTTOM,
  OUTER_GROUND,
  RANGE_EAVE_Y,
  RANGE_PRIMS,
  TARGET_FACE,
  TARGETS,
  TILE_PITCH,
} from "../sim/dojo.ts";
import type { Prim } from "../sim/geometry.ts";
import type { DojoSeason } from "../sim/season.ts";
import type { Environment } from "../../shared/env/environment.ts";
import { LightAtlas } from "./atlas.ts";
import type { Tree } from "./background.ts";
import type { DepthSurface } from "./depth.ts";
import { lampLight, occluded, openAt } from "./illum.ts";
import { LAMPS } from "./lamps.ts";
import { coordinates, facesOf, rasterize } from "./raster.ts";

/** Everything the scene is traced against. */
const PRIMS: readonly Prim[] = [...RANGE_PRIMS, ...HALL_PRIMS, OUTER_GROUND];
const FACES = facesOf(PRIMS);

/** How each part is painted. */
const Look = {
  Lawn: 0,
  Gravel: 1,
  Sand: 2,
  Azuchi: 3,
  Target: 4,
  Maku: 5,
  Fence: 6,
  Timber: 7,
  Board: 8,
  Hedge: 9,
  Soil: 10,
  Floor: 11,
  Soffit: 12,
  Rafter: 13,
  Ceiling: 14,
  Roof: 15,
  EaveTiles: 16,
  Ridge: 17,
  Barge: 18,
  Outer: 19,
} as const;
type Look = (typeof Look)[keyof typeof Look];

function lookOf(p: Prim): Look {
  if (p.name.startsWith("target")) {
    return Look.Target;
  }
  if (p.name.startsWith("post")) {
    return Look.Timber;
  }
  if (p.name.startsWith("rafter")) {
    return Look.Rafter;
  }
  if (p.name.startsWith("barge")) {
    return Look.Barge;
  }
  switch (p.name) {
    case "lawn":
    case "lawnGap":
      return Look.Lawn;
    case "dripLine":
    case "path":
      return Look.Gravel;
    case "sand":
      return Look.Sand;
    case "azuchi":
    case "azuchiTop":
      return Look.Azuchi;
    case "maku":
      return Look.Maku;
    case "fence":
    case "outerFence":
      return Look.Fence;
    case "backBoard":
    case "rangeWallL":
    case "rangeWallR":
      return Look.Board;
    case "hedge":
      return Look.Hedge;
    case "hedgeBed":
      return Look.Soil;
    case "floor":
      return Look.Floor;
    case "soffit":
      return Look.Soffit;
    case "ceiling":
    case "rangeSoffit":
      return Look.Ceiling;
    case "rangeRoof":
      return Look.Roof;
    case "eaveTiles":
      return Look.EaveTiles;
    case "ridge":
      return Look.Ridge;
    case "outer":
      return Look.Outer;
    default:
      return Look.Timber;
  }
}

const LOOKS = PRIMS.map(lookOf);
const TARGET_OF = PRIMS.map((p) => TARGETS.findIndex((t) => t.disc === p));

/** Painted rings of the kasumi target, black from each start to end (m from the center). */
const BLACK_RINGS: readonly (readonly [number, number])[] = [
  [0.036, 0.072],
  [0.102, 0.117],
  [0.147, TARGET_FACE],
];

/**
 * Radius (pixels) of a target's face below which it is drawn as a sprite:
 * too small for its thin rings, traced it would average to a gray blot.
 */
const SPRITE_BELOW = 8;

const PAPER: RGB = [240, 236, 226];
const INK: RGB = [22, 21, 20];
const HOOP: RGB = [128, 98, 70];
const SAND: RGB = [200, 178, 134];
const AZUCHI: RGB = [164, 140, 106];
const GRAVEL: RGB = [150, 146, 138];
const SOIL: RGB = [92, 74, 58];
const CEDAR_BOARD: RGB = [120, 98, 76];
const TIMBER: RGB = [96, 76, 58];
const FLOOR_WOOD: RGB = [150, 118, 80];
const CEILING_WOOD: RGB = [150, 124, 92];
/** Smoked (ibushi) clay tiles: a dark, faintly silvery gray. */
const ROOF: RGB = [80, 84, 92];
const MAKU_PURPLE: RGB = [78, 44, 104];
const MAKU_WHITE: RGB = [232, 228, 218];

/** Width (m) of each stripe of the curtain. */
const MAKU_STRIPE = 0.45;

/** What the colors of the surfaces depend on besides where they are. */
interface Conditions {
  season: DojoSeason;
  wet: number;
  holes: readonly (readonly Hole[])[];
}

/** Rows of cached colors repainted per frame while the weather changes them. */
const REPAINT_ROWS = 24;

/**
 * The dojo itself, ray traced per pixel against the same shapes arrows strike.
 * What is seen at each pixel (the part, where, which way it faces, and its
 * color) is kept until the camera moves: a move by whole pixels at the same
 * focal length, as when aiming, only scrolls it and traces the new edges.
 * Colors are repainted a few rows at a time as the weather turns.
 * Every frame the kept view is lit: sky, sun and shadow, and the lamps.
 */
export class SceneRenderer {
  private width = 0;
  private height = 0;
  /** Index into FACES of the face seen at each pixel, or -1, and its part in PRIMS. */
  private face = new Int16Array(0);
  private prim = new Int16Array(0);
  private depth = new Float32Array(0);
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private pz = new Float32Array(0);
  private nx = new Float32Array(0);
  private ny = new Float32Array(0);
  private nz = new Float32Array(0);
  private u = new Float32Array(0);
  private v = new Float32Array(0);
  /** Size (m) of the pixel on the surface. */
  private foot = new Float32Array(0);
  /** How much of the sky the point sees, 0..1. */
  private open = new Float32Array(0);
  /** Unlit color of the surface at each pixel. */
  private albR = new Float32Array(0);
  private albG = new Float32Array(0);
  private albB = new Float32Array(0);
  /** The camera the kept view was traced with. */
  private cx = Number.NaN;
  private horizon = Number.NaN;
  private focal = Number.NaN;
  /** The conditions the colors were painted in, and how far a repaint has got. */
  private paintedFor = "";
  private repaintFor = "";
  private repaintRow = 0;
  private holesSeen = -1;
  /** Scratch albedo and lamp light. */
  private readonly albedo: [number, number, number] = [0, 0, 0];
  private readonly lampRgb: [number, number, number] = [0, 0, 0];
  private readonly uv: [number, number] = [0, 0];
  /** Faces left out of the trace: distant targets, which are drawn as sprites. */
  private readonly hidden = new Uint8Array(FACES.length);
  /** The frame's sun (toward it, in camera axes), its strength, and light bounced off the ground. */
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private direct = 0;
  private bounce = 0;
  /** Sunlight and lamplight on the flat surfaces, kept in the world. */
  private readonly atlas = new LightAtlas(PRIMS, LAMPS, (p) => p === OUTER_GROUND);

  /**
   * Brings the kept view up to the camera and the conditions: traced anew,
   * scrolled, or as it was, with colors repainted as the weather turns.
   */
  update(cam: Pinhole, env: Environment<DojoSeason>, holes: readonly Hole[]): void {
    const w = cam.width;
    const h = cam.height;
    const cond = conditions(env, holes);
    const key = conditionKey(cond);
    if (w !== this.width || h !== this.height) {
      this.allocate(w, h);
    }
    const shiftX = cam.cx - this.cx;
    const shiftY = cam.horizon - this.horizon;
    if (cam.focal === this.focal && shiftX === 0 && shiftY === 0) {
      // Where it was.
    } else if (
      cam.focal === this.focal &&
      Number.isInteger(shiftX) &&
      Number.isInteger(shiftY) &&
      Math.abs(shiftX) < w / 2 &&
      Math.abs(shiftY) < h / 2
    ) {
      this.scroll(shiftX, shiftY);
      // The strips that came into view.
      if (shiftY > 0) {
        this.traceRect(cam, cond, 0, 0, w, shiftY);
      } else if (shiftY < 0) {
        this.traceRect(cam, cond, 0, h + shiftY, w, h);
      }
      if (shiftX > 0) {
        this.traceRect(cam, cond, 0, 0, shiftX, h);
      } else if (shiftX < 0) {
        this.traceRect(cam, cond, w + shiftX, 0, w, h);
      }
    } else {
      this.traceRect(cam, cond, 0, 0, w, h);
      this.paintedFor = key;
      this.repaintFor = key;
    }
    this.cx = cam.cx;
    this.horizon = cam.horizon;
    this.focal = cam.focal;
    // Fresh holes in a target's paper show at once.
    if (holes.length !== this.holesSeen) {
      this.holesSeen = holes.length;
      this.repaintTargets(cond);
    }
    // The weather moves slowly: repaint a few rows at a time.
    if (key !== this.paintedFor) {
      if (key !== this.repaintFor) {
        this.repaintFor = key;
        this.repaintRow = 0;
      }
      const end = Math.min(h, this.repaintRow + REPAINT_ROWS);
      for (let y = this.repaintRow; y < end; y++) {
        for (let x = 0; x < w; x++) {
          this.paintPixel(y * w + x, cond);
        }
      }
      this.repaintRow = end;
      if (end >= h) {
        this.paintedFor = key;
      }
    }
  }

  private allocate(w: number, h: number): void {
    this.width = w;
    this.height = h;
    const n = w * h;
    this.face = new Int16Array(n);
    this.prim = new Int16Array(n);
    this.depth = new Float32Array(n);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.foot = new Float32Array(n);
    this.open = new Float32Array(n);
    this.albR = new Float32Array(n);
    this.albG = new Float32Array(n);
    this.albB = new Float32Array(n);
    this.cx = Number.NaN;
    this.horizon = Number.NaN;
    this.focal = Number.NaN;
  }

  /** Moves everything kept by (dx, dy) pixels, as a shift of the principal point does. */
  private scroll(dx: number, dy: number): void {
    const w = this.width;
    const h = this.height;
    const arrays = [
      this.face,
      this.prim,
      this.depth,
      this.px,
      this.py,
      this.pz,
      this.nx,
      this.ny,
      this.nz,
      this.u,
      this.v,
      this.foot,
      this.open,
      this.albR,
      this.albG,
      this.albB,
    ];
    for (const a of arrays) {
      if (dy > 0) {
        a.copyWithin(dy * w, 0, (h - dy) * w);
      } else if (dy < 0) {
        a.copyWithin(0, -dy * w, h * w);
      }
      if (dx !== 0) {
        for (let y = 0; y < h; y++) {
          const row = y * w;
          if (dx > 0) {
            a.copyWithin(row + dx, row, row + w - dx);
          } else {
            a.copyWithin(row, row - dx, row + w);
          }
        }
      }
    }
  }

  /** Traces and paints the pixels of [x0, x1) × [y0, y1). */
  private traceRect(
    cam: Pinhole,
    cond: Conditions,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void {
    const w = this.width;
    this.hideDistantTargets(cam);
    rasterize(cam, FACES, this.face, this.depth, w, x0, y0, x1, y1, this.hidden);
    const f = cam.focal;
    const uv = this.uv;
    for (let y = y0; y < y1; y++) {
      const dy = (cam.horizon - (y + 0.5)) / f;
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const fi = this.face[i];
        if (fi < 0) {
          this.prim[i] = -1;
          continue;
        }
        const fc = FACES[fi];
        const k = fc.prim;
        this.prim[i] = k;
        const dx = (x + 0.5 - cam.cx) / f;
        const t = this.depth[i];
        const wx = dx * t;
        const wy = EYE + dy * t;
        this.px[i] = wx;
        this.py[i] = wy;
        this.pz[i] = t;
        // The normal on the side the eye sees.
        const s = fc.nx * dx + fc.ny * dy + fc.nz < 0 ? 1 : -1;
        const nx = fc.nx * s;
        const ny = fc.ny * s;
        const nz = fc.nz * s;
        this.nx[i] = nx;
        this.ny[i] = ny;
        this.nz[i] = nz;
        coordinates(PRIMS[k], fc, wx, wy, t, uv);
        this.u[i] = uv[0];
        this.v[i] = uv[1];
        const len = Math.hypot(dx, dy, 1);
        const facing = Math.abs(nx * dx + ny * dy + nz) / len;
        this.foot[i] = (t * len) / f / Math.max(0.12, facing);
        this.open[i] = openness(LOOKS[k], wx, wy, t, ny);
        this.paintPixel(i, cond);
      }
    }
  }

  /** Marks the faces of targets too small at this focal length to be traced. */
  private hideDistantTargets(cam: Pinhole): void {
    for (let fi = 0; fi < FACES.length; fi++) {
      const t = TARGET_OF[FACES[fi].prim];
      this.hidden[fi] = t >= 0 && spriteRadius(cam, TARGETS[t]) > 0 ? 1 : 0;
    }
  }

  /** Paints the unlit color of the surface at pixel `i`. */
  private paintPixel(i: number, cond: Conditions): void {
    const k = this.prim[i];
    if (k < 0) {
      return;
    }
    const albedo = this.albedo;
    paint(
      LOOKS[k],
      TARGET_OF[k],
      this.px[i],
      this.py[i],
      this.pz[i],
      this.u[i],
      this.v[i],
      this.ny[i],
      this.foot[i],
      cond,
      albedo,
    );
    this.albR[i] = albedo[0];
    this.albG[i] = albedo[1];
    this.albB[i] = albedo[2];
  }

  /** Paints the targets again, for the holes in their paper. */
  private repaintTargets(cond: Conditions): void {
    for (let i = 0; i < this.prim.length; i++) {
      const k = this.prim[i];
      if (k >= 0 && LOOKS[k] === Look.Target) {
        this.paintPixel(i, cond);
      }
    }
  }

  /** Lights the kept view into `view`, setting the depth of every pixel the dojo covers. */
  shade(
    view: DepthSurface,
    cam: Pinhole,
    env: Environment<DojoSeason>,
    light: Lighting,
    shade: Shade,
    lampLevel: number,
    trees: readonly Tree[],
    time: number,
  ): void {
    const w = this.width;
    const h = this.height;
    const sunCam = cam.toCamera(env.sky.sun);
    const lx = sunCam.right;
    const ly = sunCam.up;
    const lz = sunCam.forward;
    const direct = ly > 0.005 ? light.direct : 0;
    this.lx = lx;
    this.ly = ly;
    this.lz = lz;
    this.direct = direct;
    const weather = env.weather.state;
    const leafiness = clamp01(env.season.leafDensity * 0.85 + 0.15);
    this.atlas.update(lx, ly, lz, direct > 0.01, trees, leafiness, time);
    const wind = weather.wind;
    // Light bounced up from the sunlit ground onto soffits and faces turned to us.
    const bounce = 0.22 * light.daylight + 0.3 * direct;
    this.bounce = bounce;
    const lampRgb = this.lampRgb;
    const lampOn = lampLevel > 0.001;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const k = this.prim[i];
        if (k < 0) {
          continue;
        }
        const nx = this.nx[i];
        const ny = this.ny[i];
        const nz = this.nz[i];
        const pz = this.pz[i];
        const grid = this.atlas.grid(k);
        // As `lightAt`, inline. Sky light, less where the sky is hidden; light bounced from the ground below.
        const hemi = 0.5 + 0.5 * ny;
        let lit =
          ((1 - direct) * (0.72 + 0.36 * hemi) + direct * (0.48 + 0.2 * hemi)) *
            (0.3 + 0.7 * this.open[i]) +
          bounce * (clamp01(-ny) * 0.3 + clamp01(-nz) * 0.45);
        // Direct sun on faces turned to it, where nothing stands in the way.
        if (direct > 0.01) {
          const facing = nx * lx + ny * ly + nz * lz;
          if (facing > 0) {
            const sun = grid
              ? grid.sunAt(this.u[i], this.v[i])
              : sunThrough(this.px[i], this.py[i], pz, nx, ny, nz, lx, ly, lz);
            lit += direct * 0.78 * facing * sun;
          }
        }
        if (LOOKS[k] === Look.Maku) {
          // Folds of the hanging cloth, stirring in the wind.
          lit *= makuFold(this.px[i], this.py[i], time, wind);
        }
        const ar = this.albR[i];
        const ag = this.albG[i];
        const ab = this.albB[i];
        shade.at(pz);
        let r = shade.litR(ar * lit);
        let g = shade.litG(ag * lit);
        let b = shade.litB(ab * lit);
        if (lampOn) {
          if (grid) {
            grid.lampAt(this.u[i], this.v[i], lampRgb);
          } else {
            lampRgb[0] = 0;
            lampRgb[1] = 0;
            lampRgb[2] = 0;
            lampLight(LAMPS, 1, this.px[i], this.py[i], pz, nx, ny, nz, lampRgb);
          }
          const f = (1 - shade.f) * lampLevel;
          r += ar * lampRgb[0] * f;
          g += ag * lampRgb[1] * f;
          b += ab * lampRgb[2] * f;
        }
        const dz = (bayer(x, y) - 0.5) * 5;
        view.setDepth(i, pack(r + dz, g + dz, b + dz), this.depth[i]);
      }
    }
    this.drawTargetSprites(view, cam, shade, lampLevel);
  }

  /**
   * Sky light (less where the sky is hidden), light bounced from the ground,
   * and direct sun where nothing stands in the way, on a point of the dojo
   * facing (nx, ny, nz): per unit of albedo. The same light as the main loop
   * of `shade`, which has it inline: a call per pixel costs a millisecond a frame.
   */
  private lightAt(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    open: number,
  ): number {
    const direct = this.direct;
    const hemi = 0.5 + 0.5 * ny;
    let lit =
      ((1 - direct) * (0.72 + 0.36 * hemi) + direct * (0.48 + 0.2 * hemi)) * (0.3 + 0.7 * open) +
      this.bounce * (clamp01(-ny) * 0.3 + clamp01(-nz) * 0.45);
    if (direct > 0.01) {
      const lx = this.lx;
      const ly = this.ly;
      const lz = this.lz;
      const facing = nx * lx + ny * ly + nz * lz;
      if (facing > 0) {
        lit += direct * 0.78 * facing * sunThrough(px, py, pz, nx, ny, nz, lx, ly, lz);
      }
    }
    return lit;
  }

  /**
   * Targets too far off for their rings, drawn as the eye picks them out:
   * rings of whole pixels around a white center, centered on a pixel so no
   * ring is smeared across two. Each pixel is lit where its ray meets the face.
   */
  private drawTargetSprites(
    view: DepthSurface,
    cam: Pinhole,
    shade: Shade,
    lampLevel: number,
  ): void {
    const w = this.width;
    const h = this.height;
    const f = cam.focal;
    const lampRgb = this.lampRgb;
    for (const t of TARGETS) {
      const size = spriteRadius(cam, t);
      if (size === 0) {
        continue;
      }
      const bands = SPRITE_BANDS[size];
      const reach = bands[bands.length - 1].edge;
      const span = Math.ceil(reach);
      const cx = Math.floor(cam.x(t.x, t.z));
      const cy = Math.floor(cam.y(t.z, t.y));
      const d = t.disc;
      const num = d.nx * d.cx + d.ny * (d.cy - EYE) + d.nz * d.cz;
      for (let sy = -span; sy <= span; sy++) {
        const y = cy + sy;
        if (y < 0 || y >= h) {
          continue;
        }
        const dy = (cam.horizon - (y + 0.5)) / f;
        for (let sx = -span; sx <= span; sx++) {
          const x = cx + sx;
          if (x < 0 || x >= w) {
            continue;
          }
          const r = Math.hypot(sx, sy);
          if (r > reach) {
            continue;
          }
          let band = 0;
          while (r > bands[band].edge) {
            band++;
          }
          // Where this pixel's ray meets the face, unless something nearer is in the way.
          const dx = (x + 0.5 - cam.cx) / f;
          const depth = num / (d.nx * dx + d.ny * dy + d.nz);
          const i = y * w + x;
          if (this.depth[i] < depth) {
            continue;
          }
          const px = dx * depth;
          const py = EYE + dy * depth;
          const c = bands[band].ink ? INK : PAPER;
          const lit = this.lightAt(px, py, depth, d.nx, d.ny, d.nz, openAt(px, py, depth, d.ny));
          shade.at(depth);
          let red = shade.litR(c[0] * lit);
          let green = shade.litG(c[1] * lit);
          let blue = shade.litB(c[2] * lit);
          if (lampLevel > 0.001) {
            lampRgb[0] = 0;
            lampRgb[1] = 0;
            lampRgb[2] = 0;
            lampLight(LAMPS, 1, px, py, depth, d.nx, d.ny, d.nz, lampRgb);
            const k = (1 - shade.f) * lampLevel;
            red += c[0] * lampRgb[0] * k;
            green += c[1] * lampRgb[1] * k;
            blue += c[2] * lampRgb[2] * k;
          }
          const dz = (bayer(x, y) - 0.5) * 5;
          view.setDepth(i, pack(red + dz, green + dz, blue + dz), depth);
        }
      }
    }
  }

  /** Depth at a pixel of the kept view (Infinity where only the sky is seen). */
  depthAt(i: number): number {
    return this.depth[i];
  }
}

/** 1 where the sun reaches a point on a face, 0 where something is in the way. */
function sunThrough(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  lx: number,
  ly: number,
  lz: number,
): number {
  return occluded(px + nx * 0.01, py + ny * 0.01, pz + nz * 0.01, lx, ly, lz) ? 0 : 1;
}

/** One ring of a target sprite: out to `edge` pixels from the center pixel, black or white. */
interface SpriteBand {
  edge: number;
  ink: boolean;
}

/**
 * The rings of a target sprite of each radius (pixels), 1 up to below
 * SPRITE_BELOW. Every ring is at least a pixel wide; the rings that cannot be
 * go, the thin middle ring first. The white center stays from 2 pixels up;
 * at 1 the face is only a dark spot on white.
 */
const SPRITE_BANDS: readonly (readonly SpriteBand[])[] = Array.from(
  { length: SPRITE_BELOW },
  (_, size) => {
    const outer = size + 0.35;
    if (size <= 1) {
      return [
        { edge: 0.5, ink: true },
        { edge: outer, ink: false },
      ];
    }
    if (size === 2) {
      return [
        { edge: 0.5, ink: false },
        { edge: 1.5, ink: true },
        { edge: outer, ink: false },
      ];
    }
    // The kasumi's proportions, from its white center out to its black band,
    // each edge put halfway between whole pixels so every ring is round
    // rather than a plus or a spiky star.
    const scale = size + 0.5;
    const snap = (edge: number) => Math.max(0.5, Math.round(edge - 0.5) + 0.5);
    const center = snap((BLACK_RINGS[0][0] / TARGET_FACE) * scale);
    const ring = Math.max(center + 1, snap((BLACK_RINGS[0][1] / TARGET_FACE) * scale));
    const band = Math.min(snap((BLACK_RINGS[2][0] / TARGET_FACE) * scale), outer - 1);
    return [
      { edge: center, ink: false },
      { edge: ring, ink: true },
      { edge: band, ink: false },
      { edge: outer, ink: true },
    ];
  },
);

/** The radius (whole pixels) a target is drawn as a sprite at, or 0 if it is traced. */
function spriteRadius(cam: Pinhole, t: { z: number }): number {
  const radius = (TARGET_FACE * cam.focal) / t.z;
  return radius < SPRITE_BELOW ? Math.min(SPRITE_BELOW - 1, Math.max(1, Math.round(radius))) : 0;
}

/** The conditions the surfaces are painted in now. */
function conditions(env: Environment<DojoSeason>, holes: readonly Hole[]): Conditions {
  const byTarget: Hole[][] = TARGETS.map(() => []);
  for (const hole of holes) {
    byTarget[hole.target].push(hole);
  }
  return { season: env.season, wet: env.weather.state.wetness, holes: byTarget };
}

/** Changes when the conditions have changed enough to show in the colors. */
function conditionKey(c: Conditions): string {
  return `${Math.round(c.wet * 24)}`;
}

/** How much of the sky a point sees; the hall's soffits and floor see little of it. */
function openness(look: Look, x: number, y: number, z: number, ny: number): number {
  if (
    look === Look.Soffit ||
    look === Look.Rafter ||
    look === Look.Ceiling ||
    look === Look.Floor
  ) {
    return 0.25;
  }
  return openAt(x, y, z, ny);
}

/** Brightness of the curtain's folds at a point, moving with the wind. */
function makuFold(x: number, y: number, time: number, wind: number): number {
  const drop = (RANGE_EAVE_Y - y) / (RANGE_EAVE_Y - MAKU_BOTTOM);
  const sway = 0.2 + wind * 0.8;
  const phase = x * 7.3 + Math.sin(time * 0.9 + x * 0.8) * sway * 2 * drop;
  return 0.84 + 0.16 * Math.sin(phase) * (0.5 + 0.5 * drop);
}

/** Writes the unlit color of the surface at a point into `out`. */
function paint(
  look: Look,
  target: number,
  x: number,
  y: number,
  z: number,
  u: number,
  v: number,
  ny: number,
  foot: number,
  c: Conditions,
  out: [number, number, number],
): void {
  switch (look) {
    case Look.Lawn:
    case Look.Outer:
      lawn(x, z, foot, c, out);
      break;
    case Look.Gravel: {
      const cell = hash2(Math.floor(x * 30), Math.floor(z * 30));
      const fine = foot < 0.05 ? (cell - 0.5) * 0.35 * (1 - foot / 0.05) : 0;
      const k = 0.9 + fine + (tileNoise(x * 3, z * 3) - 0.5) * 0.15;
      set(out, GRAVEL, k * (1 - c.wet * 0.3));
      break;
    }
    case Look.Sand: {
      const k = 0.94 + (tileNoise(x * 5, z * 5) - 0.5) * 0.1 + fineGrain(x, z, foot) * 0.08;
      set(out, SAND, k * (1 - c.wet * 0.25));
      scatterFallen(out, x, z, foot, c, 0.5);
      break;
    }
    case Look.Azuchi: {
      // Damp, smoothed sand, darker toward the foot where it is kept wet.
      const damp = 0.8 + 0.2 * clamp01(y / AZUCHI_HEIGHT);
      // Smoothed with a trowel in long strokes, pocked where arrows have gone in.
      const streak = (tileNoise(x * 7, y * 1.2) - 0.5) * 0.16;
      const patch = (tileNoise(x * 1.3 + 40, y * 2.5) - 0.5) * 0.12;
      const pock = speckle(x, y, 0.02, foot, 0.02, 23) * 0.12;
      set(out, AZUCHI, damp + streak + patch - pock + fineGrain(x, y, foot) * 0.12);
      break;
    }
    case Look.Target:
      targetFace(u, v, foot, c.holes[target] ?? [], out);
      break;
    case Look.Maku: {
      const stripe = pulseCoverage(x + 5 * MAKU_STRIPE, MAKU_STRIPE * 2, MAKU_STRIPE, foot);
      const base = mix(MAKU_WHITE, MAKU_PURPLE, stripe);
      set(out, base, 0.95 + (tileNoise(x * 12, y * 12) - 0.5) * 0.06);
      break;
    }
    case Look.Fence: {
      // Upright cedar boards with dark seams and a plain top rail.
      const along = z;
      const seam = 1 - 0.45 * pulseCoverage(along, 0.18, 0.012, foot);
      const board = 0.9 + 0.12 * (hash2(Math.floor(along / 0.18), 7) - 0.5);
      const grain =
        (tileNoise(along * 40, y * 2) - 0.5) * 0.12 * (1 - smoothstep(0.01, 0.04, foot));
      set(out, CEDAR_BOARD, (seam * board + grain) * (1 - c.wet * 0.3));
      break;
    }
    case Look.Board: {
      const seam = 1 - 0.35 * pulseCoverage(y, 0.24, 0.01, foot);
      set(out, CEDAR_BOARD, 0.86 * seam + (tileNoise(x * 30, y * 3) - 0.5) * 0.06);
      break;
    }
    case Look.Timber:
      set(out, TIMBER, 0.95 + (tileNoise(x * 20 + z * 20, y * 3) - 0.5) * 0.1);
      break;
    case Look.Hedge: {
      const leaf = tileNoise(x * 30 + z * 7, y * 30 + z * 23);
      const clump = tileNoise(x * 6 + z * 3, y * 6 + z * 1.3);
      const k = 0.7 + clump * 0.35 + (leaf - 0.5) * 0.3 * (1 - smoothstep(0.01, 0.05, foot));
      const green = mix(c.season.evergreen, [70, 120, 60], 0.35);
      set(out, green, k);
      break;
    }
    case Look.Soil:
      set(out, SOIL, 0.9 + (tileNoise(x * 8, z * 8) - 0.5) * 0.2);
      scatterFallen(out, x, z, foot, c, 1);
      break;
    case Look.Floor:
      set(out, FLOOR_WOOD, 1 - 0.3 * pulseCoverage(x, 0.15, 0.006, foot));
      break;
    case Look.Soffit: {
      // Boards laid across the rafters, their seams running along the eave.
      const seam = 1 - 0.28 * pulseCoverage(v, 0.21, 0.008, foot);
      const board = 0.92 + 0.08 * (hash2(Math.floor(v / 0.21), 11) - 0.5);
      const grain = (tileNoise(x * 3, v * 40) - 0.5) * 0.1 * (1 - smoothstep(0.01, 0.04, foot));
      set(out, CEILING_WOOD, (seam * board + grain) * 0.95);
      break;
    }
    case Look.Rafter: {
      const grain = (tileNoise(x * 60, v * 4) - 0.5) * 0.1 * (1 - smoothstep(0.005, 0.03, foot));
      set(out, CEILING_WOOD, 0.8 + grain);
      break;
    }
    case Look.Ceiling:
      set(out, CEILING_WOOD, 0.9 - 0.2 * pulseCoverage(x, 0.9, 0.02, foot));
      break;
    case Look.Roof:
      roofTiles(u, v, foot, c, out);
      break;
    case Look.EaveTiles:
      eaveTiles(u, v, ny, foot, c, out);
      break;
    case Look.Ridge:
      ridgeTiles(u, v, ny, foot, c, out);
      break;
    case Look.Barge: {
      // A dark board, with the edge tiles of the roof along its top.
      const edge = intervalCoverage(u, BARGE_TILE_FROM, 1, foot);
      const grain = (tileNoise(u * 20, v * 2) - 0.5) * 0.08;
      set(out, TIMBER, (0.82 + grain) * (1 - c.wet * 0.25));
      blendInto(out, ROOF, edge);
      break;
    }
  }
}

/** Length (m) of roof tile showing in each course down the slope. */
const TILE_COURSE = 0.23;
/** Where the edge tiles begin across the barge board (m from its lower edge). */
const BARGE_TILE_FROM = 0.36;

/**
 * The tiled roof, by its own coordinates (u across from the left end, v up
 * the slope from the eave). Each row of pan tiles swells into a roll and dips
 * into a channel; each course overlaps the one below with its lip, leaving a
 * shadowed step. Tiles differ a little in their smoke-darkened sheen, and rain
 * streaks run down the slope. Wet tiles darken and their rolls gleam.
 */
function roofTiles(
  u: number,
  v: number,
  foot: number,
  c: Conditions,
  out: [number, number, number],
): void {
  const detail = 1 - smoothstep(TILE_PITCH * 0.3, TILE_PITCH * 0.8, foot);
  const across = u / TILE_PITCH;
  const col = Math.floor(across);
  // The roll catches the sky; the channel beside it is in its shade.
  const wave = Math.cos(2 * Math.PI * (across - col - 0.25));
  const relief = wave * 0.14 * detail;
  // The lip of each course: a bright edge over a dark step.
  const lip = pulseCoverage(v + 0.03, TILE_COURSE, 0.018, foot);
  const step = pulseCoverage(v, TILE_COURSE, 0.03, foot);
  const row = Math.floor(v / TILE_COURSE);
  const tile = (hash2(col, row + 131) - 0.5) * 0.14 * detail;
  const streak = (tileNoise(u * 2.2, v * 0.35) - 0.5) * 0.12;
  const wet = c.wet;
  const k =
    (1 + relief + tile + streak + lip * 0.14 - step * 0.3) * (1 - wet * 0.3) +
    wet * 0.12 * Math.max(0, wave) * detail;
  set(out, ROOF, k);
}

/**
 * The end tiles along the eave, by the coordinates of the box's faces: round
 * ends capping each roll, over the flat ends of the pan tiles with their
 * scrolled lip; beneath, the shadowed underside.
 */
function eaveTiles(
  u: number,
  v: number,
  ny: number,
  foot: number,
  c: Conditions,
  out: [number, number, number],
): void {
  const damp = 1 - c.wet * 0.3;
  if (ny < -0.5) {
    set(out, ROOF, 0.55 * damp);
    return;
  }
  if (ny > 0.5) {
    set(out, ROOF, 0.95 * damp);
    return;
  }
  // The front: flat pan ends low down, and a round end over every roll.
  const rel = u / TILE_PITCH - Math.floor(u / TILE_PITCH) - 0.25;
  const du = rel * TILE_PITCH;
  const dv = v - 0.082;
  const r = Math.hypot(du, dv);
  const radius = 0.052;
  const disc = intervalCoverage(r, 0, radius, foot);
  const rim = intervalCoverage(r, radius - 0.012, radius, foot);
  const boss = intervalCoverage(r, 0, 0.016, foot);
  const pan = intervalCoverage(v, 0, 0.045, foot);
  const panLine = intervalCoverage(v, 0.028, 0.036, foot);
  // Between them, the gap under the rolls in shadow.
  let k = 0.5 + pan * (0.42 - panLine * 0.2);
  k += disc * (0.98 - k) + rim * 0.12 - boss * 0.12;
  set(out, ROOF, k * damp);
}

/**
 * The ridge, by the coordinates of its box's faces: courses of flat ridge
 * tiles, each with its shadowed seam and joints, under a rounded capping row.
 */
function ridgeTiles(
  u: number,
  v: number,
  ny: number,
  foot: number,
  c: Conditions,
  out: [number, number, number],
): void {
  const damp = 1 - c.wet * 0.3;
  if (Math.abs(ny) > 0.5) {
    set(out, ROOF, (ny > 0 ? 0.95 : 0.55) * damp);
    return;
  }
  const CAP = 0.17;
  if (v >= CAP) {
    // The rounded cap: a highlight along its crown.
    const crown = intervalCoverage(v, CAP + 0.035, CAP + 0.05, foot);
    const joint = pulseCoverage(u, 0.3, 0.012, foot);
    set(out, ROOF, (0.92 + crown * 0.2 - joint * 0.2) * damp);
    return;
  }
  const course = Math.floor(v / 0.057);
  const seam = pulseCoverage(v, 0.057, 0.012, foot);
  // Joints staggered course by course.
  const joint = pulseCoverage(u + (course % 2) * 0.15, 0.3, 0.01, foot);
  const tile = (hash2(Math.floor((u + (course % 2) * 0.15) / 0.3), course + 71) - 0.5) * 0.1;
  const capShadow = intervalCoverage(v, CAP - 0.025, CAP, foot);
  set(out, ROOF, (0.86 + tile - seam * 0.32 - joint * 0.22 - capShadow * 0.25) * damp);
}

function set(out: [number, number, number], c: RGB, k: number): void {
  out[0] = c[0] * k;
  out[1] = c[1] * k;
  out[2] = c[2] * k;
}

function blendInto(out: [number, number, number], c: RGB, a: number): void {
  if (a <= 0) {
    return;
  }
  out[0] += (c[0] - out[0]) * a;
  out[1] += (c[1] - out[1]) * a;
  out[2] += (c[2] - out[2]) * a;
}

/** Grain a few centimeters across, fading out where pixels are larger than the grain. */
function fineGrain(a: number, b: number, foot: number): number {
  const fade = 1 - smoothstep(0.004, 0.02, foot);
  return fade > 0 ? (hash2(Math.floor(a * 180), Math.floor(b * 180)) - 0.5) * fade : 0;
}

/** The mown lawn of the arrow path, with what the season scatters over it. */
function lawn(
  x: number,
  z: number,
  foot: number,
  c: Conditions,
  out: [number, number, number],
): void {
  const s = c.season;
  // Mowing stripes along the range, broad patches, and blades where the pixels are small enough.
  const stripe = pulseCoverage(x + 20, 1.8, 0.9, foot) * 0.06;
  const patch = (tileNoise(x * 0.9, z * 0.45) - 0.5) * 0.16;
  const blade = (tileNoise(x * 60, z * 60) - 0.5) * 0.22 * (1 - smoothstep(0.005, 0.03, foot));
  const tuft = (tileNoise(x * 9, z * 9) - 0.5) * 0.12 * (1 - smoothstep(0.03, 0.12, foot));
  // A kept lawn, deeper and duller than the wild grass along the line.
  const grass: RGB = [s.grass[0] * 0.74 + 8, s.grass[1] * 0.78 + 6, s.grass[2] * 0.66 + 6];
  set(out, grass, (0.95 + stripe + patch + blade + tuft) * (1 - c.wet * 0.18));
  scatterFallen(out, x, z, foot, c, 1);
}

/** Fallen leaves lying on the ground. */
function scatterFallen(
  out: [number, number, number],
  x: number,
  z: number,
  foot: number,
  c: Conditions,
  amount: number,
): void {
  const s = c.season;
  if (s.fallenLeaves > 0.02) {
    const tint = hash2(Math.floor(x * 12), Math.floor(z * 12));
    const leaf: RGB = tint < 0.5 ? [196, 72, 40] : tint < 0.8 ? [214, 150, 50] : [140, 96, 60];
    blendInto(out, leaf, speckle(x, z, 0.05, foot, s.fallenLeaves * 0.08 * amount, 19));
  }
}

/**
 * Coverage of small scattered things (size m) at a density: exact where the
 * pixels are small, their average color share where the pixels are larger.
 */
function speckle(
  x: number,
  z: number,
  size: number,
  foot: number,
  density: number,
  seed: number,
): number {
  if (density <= 0) {
    return 0;
  }
  if (foot > size * 1.5) {
    return density * 0.6;
  }
  const cx = Math.floor(x / size);
  const cz = Math.floor(z / size);
  return hash3(cx, cz, seed) < density ? 1 - smoothstep(size * 0.5, size * 1.5, foot) * 0.4 : 0;
}

/** The painted face of a kasumi target, its hoop at the edge, and the holes in its paper. */
function targetFace(
  u: number,
  v: number,
  foot: number,
  holes: readonly Hole[],
  out: [number, number, number],
): void {
  const r = Math.hypot(u, v);
  if (r > TARGET_FACE) {
    set(out, HOOP, 1);
    return;
  }
  let ink = 0;
  for (const [a, b] of BLACK_RINGS) {
    ink += intervalCoverage(r, a, b, foot);
  }
  const hoop = intervalCoverage(r, TARGET_FACE, 1, foot);
  out[0] = PAPER[0] + (INK[0] - PAPER[0]) * ink;
  out[1] = PAPER[1] + (INK[1] - PAPER[1]) * ink;
  out[2] = PAPER[2] + (INK[2] - PAPER[2]) * ink;
  blendInto(out, HOOP, hoop);
  // Torn holes show the dark sand behind.
  for (const h of holes) {
    const d = Math.hypot(u - h.u, v - h.v);
    const reach = 0.005 + foot * 0.5;
    if (d < reach) {
      blendInto(out, [60, 50, 40], Math.min(0.9, (0.005 / reach) * (1 - d / reach) * 3));
    }
  }
}
