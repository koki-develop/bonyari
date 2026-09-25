import { mix, pack, type RGB } from "../../shared/core/color.ts";
import { TAU } from "../../shared/core/math.ts";
import type { Surface as Framebuffer } from "../../shared/core/surface.ts";
import { ANT_BODY, ANT_CALLOW, ANT_LEG, ANT_SHEEN, WING, WING_VEIN } from "./palette.ts";

/** Directions a sprite seen from above is drawn at. */
export const DIRECTIONS = 32;
/** Frames of the legs' stride. */
export const STRIDES = 4;
/** Sub-samples per pixel along each axis. */
const SS = 4;

/** Which body an ant has. */
export type Build = "worker" | "major" | "queen" | "gyne" | "male";

/** What the wings are doing. */
export type Wings = "none" | "folded" | "beating";

export interface SpriteKey {
  build: Build;
  /** Body length in pixels, rounded to a half. */
  length: number;
  /** Stride frame. */
  stride: number;
  /** Antennae: 0 out and searching, 1 swept in, 2 down to the ground. */
  antennae: number;
  wings: Wings;
  /** Full crop: the gaster swells and shows pale bands. */
  full: boolean;
  /** 0 pale (just out of the cocoon) .. 3 full color. */
  color: number;
}

/** A small image with coverage, drawn centered on the body's middle. */
export interface Sprite {
  w: number;
  h: number;
  /** Offset from the body's middle to the image's top-left pixel. */
  ox: number;
  oy: number;
  color: Uint32Array;
  alpha: Float32Array;
}

type Shape =
  | {
      kind: "ellipse";
      x: number;
      y: number;
      rx: number;
      ry: number;
      color: RGB;
      lit: boolean;
      bands: number;
    }
  | { kind: "line"; x0: number; y0: number; x1: number; y1: number; width: number; color: RGB };

/** Light from the upper left and in front, and the halfway vector for the sheen. */
const LIGHT = normalize(-0.42, 0.55, 0.72);
const HALF = normalize(LIGHT[0], LIGHT[1], LIGHT[2] + 1);

function normalize(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/**
 * Draws ants as small sprites, made once per look and kept: seen from above
 * inside the nest (turned to any of `DIRECTIONS`), and from the side on the
 * ground.
 */
export class AntSprites {
  private readonly cache = new Map<string, Sprite>();

  /** The ant seen from above, facing `heading` (radians, counterclockwise from +x, y up). */
  top(key: SpriteKey, heading: number): Sprite {
    const dir = ((Math.round((heading / TAU) * DIRECTIONS) % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
    const id = `t|${keyOf(key)}|${dir}`;
    let sprite = this.cache.get(id);
    if (!sprite) {
      sprite = rasterize(
        topShapes(key),
        (dir / DIRECTIONS) * TAU,
        key.length,
        key.wings === "beating" ? 0.9 : 0.66,
      );
      this.cache.set(id, sprite);
    }
    return sprite;
  }

  /**
   * The ant seen from the side, standing on the ground, facing right (`dir` 1)
   * or left (-1), leaning with the slope by `tilt` (radians, one of a few steps).
   */
  side(key: SpriteKey, dir: 1 | -1, tilt: number): Sprite {
    const step = Math.round(tilt / 0.12);
    const id = `s|${keyOf(key)}|${dir}|${step}`;
    let sprite = this.cache.get(id);
    if (!sprite) {
      const shapes = sideShapes(key);
      if (dir < 0) {
        for (const s of shapes) {
          if (s.kind === "ellipse") {
            s.x = -s.x;
          } else {
            s.x0 = -s.x0;
            s.x1 = -s.x1;
          }
        }
      }
      sprite = rasterize(shapes, step * 0.12, key.length, 0.62);
      this.cache.set(id, sprite);
    }
    return sprite;
  }
}

function keyOf(k: SpriteKey): string {
  return `${k.build}|${k.length}|${k.stride}|${k.antennae}|${k.wings}|${k.full ? 1 : 0}|${k.color}`;
}

/**
 * Draws `sprite` with its anchor at (x, y), lit by `light` (channel
 * multipliers), `alpha` times as opaque.
 */
export function drawSprite(
  view: Framebuffer,
  sprite: Sprite,
  x: number,
  y: number,
  light: RGB,
  alpha = 1,
): void {
  const lr = light[0];
  const lg = light[1];
  const lb = light[2];
  const x0 = Math.round(x) + sprite.ox;
  const y0 = Math.round(y) + sprite.oy;
  const data = view.data;
  const vw = view.width;
  for (let j = 0; j < sprite.h; j++) {
    const sy = y0 + j;
    if (sy < 0 || sy >= view.height) {
      continue;
    }
    for (let i = 0; i < sprite.w; i++) {
      const sx = x0 + i;
      if (sx < 0 || sx >= vw) {
        continue;
      }
      const k = j * sprite.w + i;
      const a = sprite.alpha[k] * alpha;
      if (a <= 0.02) {
        continue;
      }
      const c = sprite.color[k];
      const cr = (c & 255) * lr;
      const cg = ((c >>> 8) & 255) * lg;
      const cb = ((c >>> 16) & 255) * lb;
      const o = sy * vw + sx;
      if (a >= 0.99) {
        data[o] = pack(cr, cg, cb);
        continue;
      }
      const d = data[o];
      const dr = d & 255;
      const dg = (d >>> 8) & 255;
      const db = (d >>> 16) & 255;
      data[o] = pack(dr + (cr - dr) * a, dg + (cg - dg) * a, db + (cb - db) * a);
    }
  }
}

/** The body's colors, from pale to full. */
function tones(color: number): { body: RGB; leg: RGB } {
  const t = color / 3;
  return {
    body: mix(ANT_CALLOW, ANT_BODY, t),
    leg: mix(mix(ANT_CALLOW, [0, 0, 0], 0.15), ANT_LEG, t),
  };
}

/** Proportions of each build, in body lengths. */
interface Form {
  head: [number, number, number, number];
  thorax: [number, number, number, number];
  gaster: [number, number, number, number];
  bands: number;
}

const FORMS: Record<Build, Form> = {
  worker: {
    head: [0.255, 0, 0.09, 0.085],
    thorax: [0.05, 0, 0.125, 0.064],
    gaster: [-0.285, 0, 0.195, 0.135],
    bands: 0,
  },
  major: {
    head: [0.265, 0, 0.118, 0.112],
    thorax: [0.04, 0, 0.12, 0.066],
    gaster: [-0.285, 0, 0.19, 0.135],
    bands: 0,
  },
  queen: {
    head: [0.265, 0, 0.082, 0.082],
    thorax: [0.05, 0, 0.14, 0.085],
    gaster: [-0.3, 0, 0.245, 0.16],
    bands: 4,
  },
  gyne: {
    head: [0.265, 0, 0.082, 0.082],
    thorax: [0.05, 0, 0.14, 0.085],
    gaster: [-0.29, 0, 0.22, 0.145],
    bands: 3,
  },
  male: {
    head: [0.265, 0, 0.06, 0.058],
    thorax: [0.07, 0, 0.14, 0.07],
    gaster: [-0.26, 0, 0.18, 0.098],
    bands: 0,
  },
};

/** The ant from above: +x forward, +y to its left. */
function topShapes(key: SpriteKey): Shape[] {
  const form = FORMS[key.build];
  const { body, leg } = tones(key.color);
  const shapes: Shape[] = [];
  const [hx, hy, hrx, hry] = form.head;
  const [tx, ty, trx, try_] = form.thorax;
  let [gx, gy, grx, gry] = form.gaster;
  if (key.full) {
    grx *= 1.16;
    gry *= 1.24;
    gx -= 0.02;
  }
  // The body, front to back, so the head is found first where parts overlap.
  shapes.push({
    kind: "ellipse",
    x: hx,
    y: hy,
    rx: hrx,
    ry: hry,
    color: body,
    lit: true,
    bands: 0,
  });
  shapes.push({
    kind: "ellipse",
    x: tx,
    y: ty,
    rx: trx,
    ry: try_,
    color: body,
    lit: true,
    bands: 0,
  });
  shapes.push({
    kind: "ellipse",
    x: -0.075,
    y: 0,
    rx: 0.034,
    ry: 0.038,
    color: body,
    lit: true,
    bands: 0,
  });
  shapes.push({
    kind: "ellipse",
    x: gx,
    y: gy,
    rx: grx,
    ry: gry,
    color: body,
    lit: true,
    bands: key.full ? 3 : form.bands,
  });
  // Mandibles.
  const front = hx + hrx * 0.9;
  for (const side of [-1, 1]) {
    shapes.push({
      kind: "line",
      x0: front - 0.01,
      y0: side * hry * 0.4,
      x1: front + 0.045,
      y1: side * hry * 0.1,
      width: 0.022,
      color: leg,
    });
  }
  // Antennae: an elbowed scape and a long whip.
  const reach = [
    [0.47, 0.21],
    [0.45, 0.13],
    [0.43, 0.08],
  ][key.antennae];
  for (const side of [-1, 1]) {
    const bx = hx + hrx * 0.6;
    const by = side * hry * 0.55;
    const ex = hx + hrx * 0.35;
    const ey = side * (hry + 0.08);
    shapes.push({ kind: "line", x0: bx, y0: by, x1: ex, y1: ey, width: 0.02, color: leg });
    shapes.push({
      kind: "line",
      x0: ex,
      y0: ey,
      x1: reach[0],
      y1: side * reach[1],
      width: 0.018,
      color: leg,
    });
  }
  // Six legs in a tripod gait: front and hind of one side step with the middle of the other.
  const phase = (key.stride / STRIDES) * TAU;
  const legs = [
    { hip: [0.1, 0.034], knee: [0.2, 0.19], foot: [0.34, 0.29] },
    { hip: [0.05, 0.044], knee: [0.06, 0.23], foot: [0.05, 0.35] },
    { hip: [-0.005, 0.04], knee: [-0.12, 0.2], foot: [-0.33, 0.3] },
  ];
  // Small ants are drawn with their legs tucked a little closer, so the body reads.
  const spread = Math.min(1, 0.72 + (key.length - 8) * 0.04);
  legs.forEach((l, i) => {
    for (const side of [-1, 1]) {
      const group = (i === 1) === side > 0 ? 1 : -1;
      const swing = Math.sin(phase) * group * (key.wings === "beating" ? 0 : 1);
      const fold = (key.wings === "beating" ? 0.55 : 1) * spread;
      shapes.push({
        kind: "line",
        x0: l.hip[0],
        y0: side * l.hip[1],
        x1: l.knee[0] + swing * 0.035,
        y1: side * l.knee[1] * fold,
        width: 0.026,
        color: leg,
      });
      shapes.push({
        kind: "line",
        x0: l.knee[0] + swing * 0.035,
        y0: side * l.knee[1] * fold,
        x1: l.foot[0] + swing * 0.075,
        y1: side * l.foot[1] * fold,
        width: 0.022,
        color: leg,
      });
    }
  });
  return shapes;
}

/** The ant from the side: +x forward, +y up, feet on y = 0. */
function sideShapes(key: SpriteKey): Shape[] {
  const form = FORMS[key.build];
  const { body, leg } = tones(key.color);
  const far = mix(leg, [0, 0, 0], 0.35);
  const shapes: Shape[] = [];
  const [hx, , hrx, hry] = form.head;
  const [tx, , trx, try_] = form.thorax;
  let [gx, , grx, gry] = form.gaster;
  if (key.full) {
    grx *= 1.14;
    gry *= 1.26;
  }
  // Seen from the side, the body stands clear of the ground on its legs.
  const lift = 0.22;
  shapes.push({
    kind: "ellipse",
    x: hx + 0.01,
    y: lift + 0.045,
    rx: hrx,
    ry: hry * 0.92,
    color: body,
    lit: true,
    bands: 0,
  });
  shapes.push({
    kind: "ellipse",
    x: tx,
    y: lift + 0.03,
    rx: trx,
    ry: try_ * 1.05,
    color: body,
    lit: true,
    bands: 0,
  });
  shapes.push({
    kind: "ellipse",
    x: tx - 0.04,
    y: lift + 0.07,
    rx: trx * 0.55,
    ry: try_ * 0.7,
    color: body,
    lit: true,
    bands: 0,
  });
  shapes.push({
    kind: "ellipse",
    x: -0.075,
    y: lift + 0.03,
    rx: 0.03,
    ry: 0.055,
    color: body,
    lit: true,
    bands: 0,
  });
  shapes.push({
    kind: "ellipse",
    x: gx,
    y: lift + gry * 0.35,
    rx: grx,
    ry: gry,
    color: body,
    lit: true,
    bands: key.full ? 3 : form.bands,
  });
  // Mandibles and the near antenna.
  shapes.push({
    kind: "line",
    x0: hx + hrx * 0.8,
    y0: lift,
    x1: hx + hrx + 0.04,
    y1: lift - 0.03,
    width: 0.024,
    color: leg,
  });
  const tip = [
    [0.5, lift + 0.12],
    [0.44, lift + 0.2],
    [0.46, lift - 0.02],
  ][key.antennae];
  const elbowX = hx + hrx * 0.5;
  const elbowY = lift + 0.16;
  shapes.push({
    kind: "line",
    x0: hx + hrx * 0.6,
    y0: lift + 0.07,
    x1: elbowX,
    y1: elbowY,
    width: 0.02,
    color: leg,
  });
  shapes.push({
    kind: "line",
    x0: elbowX,
    y0: elbowY,
    x1: tip[0],
    y1: tip[1],
    width: 0.018,
    color: leg,
  });
  // Legs: the far three a shade darker, then the near three over them.
  const phase = (key.stride / STRIDES) * TAU;
  const legs = [
    { hip: [0.09, lift - 0.01], knee: [0.17, lift + 0.03], foot: [0.28, 0] },
    { hip: [0.04, lift - 0.02], knee: [0.06, lift + 0.03], foot: [0.03, 0] },
    { hip: [-0.01, lift - 0.01], knee: [-0.12, lift + 0.04], foot: [-0.27, 0] },
  ];
  for (const near of [false, true]) {
    legs.forEach((l, i) => {
      const group = (i === 1) === near ? 1 : -1;
      const swing = Math.sin(phase) * group;
      const up = Math.max(0, Math.cos(phase) * group) * 0.035;
      const shift = near ? 0 : 0.03;
      shapes.push({
        kind: "line",
        x0: l.hip[0] + shift,
        y0: l.hip[1],
        x1: l.knee[0] + swing * 0.03 + shift,
        y1: l.knee[1] + up,
        width: 0.026,
        color: near ? leg : far,
      });
      shapes.push({
        kind: "line",
        x0: l.knee[0] + swing * 0.03 + shift,
        y0: l.knee[1] + up,
        x1: l.foot[0] + swing * 0.07 + shift,
        y1: l.foot[1] + up,
        width: 0.022,
        color: near ? leg : far,
      });
    });
  }
  return shapes;
}

/**
 * Renders shapes (in body lengths) turned by `angle` into a sprite `length`
 * pixels long, sampling each pixel `SS`² times. The first shape hit at a
 * sample decides its color; wings are laid over the body translucently.
 */
function rasterize(shapes: Shape[], angle: number, length: number, reach: number): Sprite {
  const radius = Math.ceil(length * reach) + 1;
  const w = radius * 2 + 1;
  const h = w;
  const color = new Uint32Array(w * h);
  const alpha = new Float32Array(w * h);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Lines keep a visible width however small the ant.
  const minWidth = 0.7 / length;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      // Body and limbs are counted apart: the body is drawn crisp, the thin
      // legs and antennae as fine, half-seen strokes.
      let br = 0;
      let bg = 0;
      let bb = 0;
      let body = 0;
      let lr = 0;
      let lg = 0;
      let lb = 0;
      let limb = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          // Screen offset from the middle (y down), to the body's frame (y up).
          const px = (i - radius + (si + 0.5) / SS - 0.5) / length;
          const py = -(j - radius + (sj + 0.5) / SS - 0.5) / length;
          const lx = px * cos + py * sin;
          const ly = -px * sin + py * cos;
          const c = sample(shapes, lx, ly, cos, sin, minWidth);
          if (!c) {
            continue;
          }
          if (HIT_BODY.value) {
            br += c[0];
            bg += c[1];
            bb += c[2];
            body++;
          } else {
            lr += c[0];
            lg += c[1];
            lb += c[2];
            limb++;
          }
        }
      }
      const k = j * w + i;
      const n = SS * SS;
      if (body / n >= 0.4) {
        color[k] = pack(br / body, bg / body, bb / body);
        alpha[k] = 1;
      } else if (limb > 0 || body > 0) {
        const total = limb + body;
        color[k] = pack((lr + br) / total, (lg + bg) / total, (lb + bb) / total);
        alpha[k] = Math.min(0.7, (limb / n) * 1.7 + (body / n) * 1.2);
      }
    }
  }
  return { w, h, ox: -radius, oy: -radius, color, alpha };
}

const OUT: [number, number, number] = [0, 0, 0];
/** Whether the last sample hit the body (rather than a limb). */
const HIT_BODY = { value: false };

/** The color at a point of the body's frame, or null if nothing is there. */
function sample(
  shapes: Shape[],
  x: number,
  y: number,
  cos: number,
  sin: number,
  minWidth: number,
): [number, number, number] | null {
  for (const s of shapes) {
    if (s.kind === "ellipse") {
      const nx = (x - s.x) / s.rx;
      const ny = (y - s.y) / s.ry;
      const d2 = nx * nx + ny * ny;
      if (d2 > 1) {
        continue;
      }
      HIT_BODY.value = true;
      if (!s.lit) {
        OUT[0] = s.color[0];
        OUT[1] = s.color[1];
        OUT[2] = s.color[2];
        return OUT;
      }
      // The surface normal, turned to the screen, against the light.
      const nz = Math.sqrt(1 - d2);
      const wx = nx * cos - ny * sin;
      const wy = nx * sin + ny * cos;
      const diffuse = Math.max(0, wx * LIGHT[0] + wy * LIGHT[1] + nz * LIGHT[2]);
      const spec = Math.pow(Math.max(0, wx * HALF[0] + wy * HALF[1] + nz * HALF[2]), 8);
      let k = 0.5 + 0.8 * diffuse;
      // The pale joints between the plates of a swollen or a queen's gaster.
      if (s.bands > 0) {
        const t = ((nx + 1) / 2) * (s.bands + 1);
        const f = t - Math.floor(t);
        if (Math.floor(t) > 0 && f < 0.2) {
          k *= s.bands >= 3 ? 1.8 : 1.4;
        }
      }
      const sheen = spec * 0.85;
      OUT[0] = s.color[0] * k + ANT_SHEEN[0] * sheen;
      OUT[1] = s.color[1] * k + ANT_SHEEN[1] * sheen;
      OUT[2] = s.color[2] * k + ANT_SHEEN[2] * sheen;
      return OUT;
    }
    const half = Math.max(s.width, minWidth) / 2;
    if (segmentDistance(x, y, s.x0, s.y0, s.x1, s.y1) <= half) {
      HIT_BODY.value = false;
      OUT[0] = s.color[0];
      OUT[1] = s.color[1];
      OUT[2] = s.color[2];
      return OUT;
    }
  }
  return null;
}

function segmentDistance(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2));
  return Math.hypot(x - x0 - dx * t, y - y0 - dy * t);
}

/**
 * Wings laid over an ant seen from above: folded along its back, or a blur
 * to either side while it flies. Drawn after the body, translucent.
 */
export function drawWings(
  view: Framebuffer,
  x: number,
  y: number,
  heading: number,
  length: number,
  wings: Wings,
  time: number,
  light: RGB,
): void {
  if (wings === "none") {
    return;
  }
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const beating = wings === "beating";
  const ellipses = beating
    ? [
        { cx: 0.02, cy: 0.27, rx: 0.14, ry: 0.28, a: 0.22 + 0.1 * Math.sin(time * 90) },
        { cx: 0.02, cy: -0.27, rx: 0.14, ry: 0.28, a: 0.22 + 0.1 * Math.sin(time * 90 + 1) },
      ]
    : [
        { cx: -0.27, cy: 0.05, rx: 0.37, ry: 0.075, a: 0.5 },
        { cx: -0.27, cy: -0.05, rx: 0.37, ry: 0.075, a: 0.5 },
      ];
  const reach = length * 0.72 + 1;
  for (let j = Math.floor(y - reach); j <= Math.ceil(y + reach); j++) {
    for (let i = Math.floor(x - reach); i <= Math.ceil(x + reach); i++) {
      const px = (i + 0.5 - x) / length;
      const py = -(j + 0.5 - y) / length;
      const lx = px * cos + py * sin;
      const ly = -px * sin + py * cos;
      for (const e of ellipses) {
        const nx = (lx - e.cx) / e.rx;
        const ny = (ly - e.cy) / e.ry;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) {
          continue;
        }
        // A dark vein along the leading edge of a folded wing.
        const vein = !beating && Math.abs(ny - Math.sign(e.cy) * 0.55) < 0.22 && nx > -0.6;
        const c = vein ? WING_VEIN : WING;
        view.blend(
          i,
          j,
          c[0] * light[0],
          c[1] * light[1],
          c[2] * light[2],
          e.a * (1 - d2 * 0.4) * (vein ? 1.1 : 1),
        );
        break;
      }
    }
  }
}
