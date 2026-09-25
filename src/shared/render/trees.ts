import { mix, type RGB } from "../core/color.ts";
import { clamp01, smoothstep } from "../core/math.ts";
import { hash3, Rng } from "../core/random.ts";
import type { Painter } from "./painter.ts";

/** Where a tree stands: along (m), lateral distance (m), and the seed of its shape. */
export interface Planting {
  along: number;
  lateral: number;
  seed: number;
}

const SNOW: RGB = [236, 240, 248];
const BLOSSOM: RGB = [250, 206, 220];
const BAMBOO: RGB = [132, 168, 92];

/** One rounded mass of foliage, in screen pixels. */
interface Clump {
  x: number;
  y: number;
  r: number;
  /** Vertical squash; below 1 makes a flat, wide pad. */
  squash?: number;
  /** How far (px) the clump stands out toward the viewer from the crown's back. */
  z?: number;
  /** Color variation, -1..1. */
  tint?: number;
}

/** The overall mass of a crown, in screen pixels, that its clumps make up. */
interface Volume {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/** Reused per-clump arrays for `foliage`, grown as needed. */
const scratch = {
  bx: new Float64Array(64),
  by: new Float64Array(64),
  br: new Float64Array(64),
  brs: new Float64Array(64),
  dy: new Float64Array(64),
  active: new Int32Array(64),
};

/**
 * Paints a crown made of overlapping clumps, each shaded as a rounded mass:
 * the frontmost clump at a pixel decides its surface, so the crown reads as
 * lumps of leaves lit from the sun's side with darker hollows between them.
 * Rims are ragged with leaves; `density` below 1 opens the crown in sprays so
 * the branches show through. With a `volume`, the crown is also shaded as one
 * mass, so the clumps read as its surface rather than as separate balls.
 */
function foliage(
  p: Painter,
  clumps: readonly Clump[],
  color: RGB,
  density: number,
  seed: number,
  snowOnTop: number,
  volume: Volume | null = null,
): void {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const b of clumps) {
    x0 = Math.min(x0, b.x - b.r);
    x1 = Math.max(x1, b.x + b.r);
    y0 = Math.min(y0, b.y - b.r * (b.squash ?? 1));
    y1 = Math.max(y1, b.y + b.r * (b.squash ?? 1));
    zMin = Math.min(zMin, b.z ?? 0);
    zMax = Math.max(zMax, b.z ?? 0);
  }
  const ix0 = Math.floor(x0);
  const iy0 = Math.floor(y0);
  const zRange = Math.max(1e-6, zMax - zMin);
  const view = p.view;
  const shade = p.shade;
  // Leaves are translucent: against the sun, the rims of the crown glow.
  const backlit = p.direct * clamp01(-p.sun.back * 1.5);
  // Autumn crowns turn unevenly, some clumps redder, some still yellow.
  const warm = clamp01((color[0] - color[1]) / 90);
  // Per-clump constants, and the clumps that reach the current row.
  const count = clumps.length;
  if (scratch.bx.length < count) {
    const size = Math.max(count, scratch.bx.length * 2);
    scratch.bx = new Float64Array(size);
    scratch.by = new Float64Array(size);
    scratch.br = new Float64Array(size);
    scratch.brs = new Float64Array(size);
    scratch.dy = new Float64Array(size);
    scratch.active = new Int32Array(size);
  }
  const { bx, by, br, brs, dy: rowDy, active } = scratch;
  for (let i = 0; i < count; i++) {
    const b = clumps[i];
    bx[i] = b.x;
    by[i] = b.y;
    br[i] = b.r;
    brs[i] = b.r * (b.squash ?? 1);
  }
  const covered = p.cover.order;
  const lateral = p.lateral;
  // Only pixels inside the view can be written.
  const yFrom = Math.max(iy0, 0);
  const yTo = Math.min(Math.ceil(y1), view.height - 1);
  const xFrom = Math.max(ix0, 0);
  const xTo = Math.min(Math.ceil(x1), view.width - 1);
  for (let y = yFrom; y <= yTo; y++) {
    // A clump can only cover pixels of this row if the row crosses it.
    let n0 = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < count; i++) {
      const dy = (y + 0.5 - by[i]) / brs[i];
      if (dy * dy <= 1) {
        rowDy[i] = dy;
        active[n0++] = i;
        lo = Math.min(lo, bx[i] - br[i]);
        hi = Math.max(hi, bx[i] + br[i]);
      }
    }
    if (n0 === 0) {
      continue;
    }
    const xa = Math.max(xFrom, Math.floor(lo) - 1);
    const xb = Math.min(xTo, Math.ceil(hi) + 1);
    const coverRow = y * view.width;
    for (let x = xa; x <= xb; x++) {
      // Painted over later by something nearer.
      if (covered[coverRow + x] < lateral) {
        continue;
      }
      let n = -1;
      let best = -1;
      let bestZ = -Infinity;
      let bnx = 0;
      let bny = 0;
      let bnz = 0;
      let bd = 0;
      for (let j = 0; j < n0; j++) {
        const i = active[j];
        const dx = (x + 0.5 - bx[i]) / br[i];
        const dy = rowDy[i];
        const d2 = dx * dx + dy * dy;
        // Outside the clump whatever its rim; the leafy rim is never wider.
        if (d2 > 1) {
          continue;
        }
        if (n < 0) {
          n = hash3(seed, x - ix0, y - iy0);
        }
        // A ragged, leafy rim rather than a clean circle.
        const rim = 1 - 0.3 * ((n * (i + 3) * 7.31) % 1);
        if (d2 > rim * rim) {
          continue;
        }
        const nz = Math.sqrt(Math.max(0, 1 - d2));
        const z = (clumps[i].z ?? 0) + brs[i] * nz;
        if (z > bestZ) {
          bestZ = z;
          best = i;
          bnx = dx;
          bny = -dy;
          bnz = nz;
          bd = Math.sqrt(d2);
        }
      }
      if (best < 0) {
        continue;
      }
      // Thinning works on leaf sprays, not single pixels, so gaps come in patches.
      const spray = hash3(seed ^ 0x5bd1, (x - ix0) >> 1, (y - iy0) >> 1);
      if (spray * 0.6 + n * 0.4 > density) {
        continue;
      }
      const b = clumps[best];
      // How far out toward the silhouette this pixel lies, 0 at the center.
      let edge = bd;
      if (volume) {
        const vx = (x + 0.5 - volume.x) / volume.rx;
        const vy = -(y + 0.5 - volume.y) / volume.ry;
        const v2 = vx * vx + vy * vy;
        const vz = Math.sqrt(Math.max(0, 1 - v2));
        edge = Math.sqrt(v2);
        bnx = bnx * 0.3 + vx * 0.7;
        bny = bny * 0.3 + vy * 0.7;
        bnz = bnz * 0.3 + vz * 0.7;
        const len = Math.hypot(bnx, bny, bnz) || 1;
        bnx /= len;
        bny /= len;
        bnz /= len;
      }
      let k = p.surfaceLight(bnx, bny, bnz);
      // Hollows between clumps and the crown's interior get less light.
      k *=
        (0.9 + 0.1 * Math.sqrt(Math.max(0, 1 - bd * bd))) *
        (0.88 + 0.12 * (((b.z ?? 0) - zMin) / zRange));
      // Sprays of leaves: small lit tufts and dark gaps between them.
      k *= 0.86 + 0.24 * spray + (n - 0.5) * 0.16;
      k += backlit * 0.5 * smoothstep(0.7, 1.05, edge) * smoothstep(0.5, 1, bd);
      const t = b.tint ?? 0;
      let r = color[0] * k * (1 + t * (0.07 + 0.08 * warm));
      let g = color[1] * k * (1 + t * (0.07 - 0.16 * warm));
      let bl = color[2] * k * (1 + t * 0.05);
      if (snowOnTop > 0 && bny > 0.6 - snowOnTop * 0.45 && n < 0.9) {
        const lit = Math.min(1.1, 0.25 + k * 0.8);
        r += (SNOW[0] * lit - r) * 0.85;
        g += (SNOW[1] * lit - g) * 0.85;
        bl += (SNOW[2] * lit - bl) * 0.85;
      }
      view.set(x, y, shade.color(r, g, bl));
    }
  }
}

/**
 * A tapering limb from (x0, y0) to (x1, y1) with widths in pixels, rounded
 * and lit from the sun's side. Parts thinner than a pixel are dithered.
 */
function limb(
  p: Painter,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
  bark: RGB,
  seed: number,
): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  const view = p.view;
  const shade = p.shade;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = x0 + (x1 - x0) * t;
    const y = Math.round(y0 + (y1 - y0) * t);
    const w = w0 + (w1 - w0) * t;
    if (w < 1) {
      if (hash3(seed, k, 5) < w) {
        const c = p.surfaceLight(0, 0.2, 0.98);
        view.set(Math.round(x), y, shade.color(bark[0] * c, bark[1] * c, bark[2] * c));
      }
      continue;
    }
    const a = Math.round(x - w / 2);
    const b = Math.max(a + 1, Math.round(x + w / 2));
    for (let xx = a; xx < b; xx++) {
      const u = ((xx + 0.5 - x) / (w / 2)) * 0.9;
      const c = p.surfaceLight(u, 0, Math.sqrt(Math.max(0, 1 - u * u))) * 0.95;
      view.set(xx, y, shade.color(bark[0] * c, bark[1] * c, bark[2] * c));
    }
  }
}

/** A limb with a bend partway, so branches don't read as ruler lines. */
function bentLimb(
  p: Painter,
  r: Rng,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
  bark: RGB,
  bend: number,
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const off = r.range(-bend, bend) * len;
  const mx = (x0 + x1) / 2 + (-(y1 - y0) / Math.max(1e-6, len)) * off;
  const my = (y0 + y1) / 2 + ((x1 - x0) / Math.max(1e-6, len)) * off;
  const wm = (w0 + w1) / 2;
  const seed = r.int(0, 1 << 30);
  limb(p, x0, y0, mx, my, w0, wm, bark, seed);
  limb(p, mx, my, x1, y1, wm, w1, bark, seed ^ 1);
}

/** The shape of a crowned tree, in fractions of its height. */
interface CrownForm {
  /** Height of the crown's center. */
  center: number;
  /** Half width and half height of the crown. */
  rx: number;
  ry: number;
  /** Height where the trunk divides into limbs. */
  fork: number;
  limbs: readonly [number, number];
  /** How much the limbs bend. */
  bend: number;
  /** Clumps along the lower edge are pulled up into a flatter underside. */
  underside: number;
}

/** A zelkova's vase: limbs fanning up from a low fork into a broad dome. */
const VASE: CrownForm = {
  center: 0.7,
  rx: 0.5,
  ry: 0.27,
  fork: 0.3,
  limbs: [4, 6],
  bend: 0.12,
  underside: 0.55,
};
/** A rounded, full crown on a short trunk. */
const DOME: CrownForm = {
  center: 0.6,
  rx: 0.42,
  ry: 0.37,
  fork: 0.32,
  limbs: [3, 4],
  bend: 0.14,
  underside: 0.8,
};
/** A narrow, upright crown. */
const OVAL: CrownForm = {
  center: 0.6,
  rx: 0.25,
  ry: 0.4,
  fork: 0.24,
  limbs: [2, 3],
  bend: 0.08,
  underside: 0.85,
};
/** A cherry's low, spreading crown on crooked limbs. */
const SPREAD: CrownForm = {
  center: 0.62,
  rx: 0.56,
  ry: 0.3,
  fork: 0.26,
  limbs: [4, 5],
  bend: 0.22,
  underside: 0.6,
};

interface CrownedTree {
  clumps: Clump[];
  volume: Volume;
  /** Screen x and y of the fork. */
  forkX: number;
  forkY: number;
  /** Trunk width (px) at the ground. */
  trunkW: number;
}

/**
 * Lays out a crowned tree in screen pixels: clumps around the crown's rim
 * (making a lumpy silhouette) and a few inside, bulging toward the viewer.
 */
function layoutCrown(
  r: Rng,
  form: CrownForm,
  cx: number,
  base: number,
  height: number,
  s: number,
): CrownedTree {
  const h = height * s;
  const ccx = cx + r.range(-0.04, 0.04) * h;
  const ccy = base - form.center * h;
  const rx = form.rx * h * r.range(0.88, 1.12);
  const ry = form.ry * h * r.range(0.9, 1.1);
  const clumpR = 0.46 * Math.min(rx, ry);
  const count = Math.max(5, Math.min(22, Math.round(((rx * ry) / (clumpR * clumpR)) * 1.6)));
  const clumps: Clump[] = [];
  const outer = Math.max(3, Math.round(count * 0.68));
  const turn = r.range(0, Math.PI * 2);
  for (let i = 0; i < count; i++) {
    const rim = i < outer;
    const a = rim
      ? turn + ((i + r.range(-0.3, 0.3)) / outer) * Math.PI * 2
      : r.range(0, Math.PI * 2);
    const rho = rim ? r.range(0.58, 0.76) : r.range(0, 0.5);
    let ox = Math.cos(a) * rho * (rx - clumpR * 0.55);
    let oy = Math.sin(a) * rho * (ry - clumpR * 0.55);
    if (oy > 0) {
      oy *= form.underside;
      ox *= 1 + (1 - form.underside) * 0.3;
    }
    const radius = clumpR * r.range(0.8, 1.2) * (oy < 0 ? 1.05 : 0.95);
    clumps.push({
      x: ccx + ox,
      y: ccy + oy,
      r: radius,
      z: clumpR * (1.3 * Math.sqrt(Math.max(0, 1 - rho * rho)) + r.range(-0.2, 0.2)),
      tint: r.range(-1, 1),
    });
  }
  return {
    clumps,
    volume: { x: ccx, y: ccy, rx: rx * 1.05, ry: ry * 1.1 },
    forkX: cx,
    forkY: base - form.fork * h,
    trunkW: Math.max(1, r.range(0.32, 0.46) * s * Math.sqrt(height / 8)),
  };
}

/**
 * Trunk, limbs to the clumps and fine twigs: the whole structure shows when
 * the leaves are gone and through the gaps when they thin.
 */
function drawStructure(
  p: Painter,
  r: Rng,
  tree: CrownedTree,
  form: CrownForm,
  cx: number,
  base: number,
  bark: RGB,
  twigs: boolean,
): void {
  const tw = tree.trunkW;
  limb(p, cx, base, tree.forkX, tree.forkY, tw, tw * 0.8, bark, r.int(0, 1 << 30));
  const clumps = tree.clumps;
  // Limbs run from the fork to the highest and widest clumps, spread around the crown.
  const byAngle = clumps
    .map((c, i) => ({ i, a: Math.atan2(c.x - tree.forkX, tree.forkY - c.y) }))
    .sort((a, b) => a.a - b.a);
  const limbCount = Math.min(clumps.length, r.int(form.limbs[0], form.limbs[1]));
  const tips: { x: number; y: number }[] = [];
  for (let k = 0; k < limbCount; k++) {
    const c = clumps[byAngle[Math.floor(((k + 0.5) / limbCount) * byAngle.length)].i];
    const sx = tree.forkX + r.range(-0.3, 0.3) * tw;
    bentLimb(p, r, sx, tree.forkY, c.x, c.y, tw * 0.62, Math.max(0.5, tw * 0.22), bark, form.bend);
    tips.push({ x: sx + (c.x - sx) * 0.55, y: tree.forkY + (c.y - tree.forkY) * 0.55 });
  }
  if (!twigs) {
    return;
  }
  // Every clump hangs off the nearest limb, and sprays of twigs fan out from it.
  for (const c of clumps) {
    let best = tips[0];
    for (const t of tips) {
      if (Math.hypot(t.x - c.x, t.y - c.y) < Math.hypot(best.x - c.x, best.y - c.y)) {
        best = t;
      }
    }
    bentLimb(p, r, best.x, best.y, c.x, c.y, Math.max(0.6, tw * 0.3), 0.5, bark, 0.15);
    const sprays = 3 + r.int(0, 2);
    for (let k = 0; k < sprays; k++) {
      // Upward, fanning out.
      const a = r.range(Math.PI * 1.1, Math.PI * 1.9);
      const len = c.r * r.range(0.7, 1.1);
      limb(
        p,
        c.x,
        c.y,
        c.x + Math.cos(a) * len,
        c.y + Math.sin(a) * len * 0.9,
        0.7,
        0.25,
        bark,
        r.int(0, 1 << 30),
      );
    }
  }
}

const BROADLEAF_FORMS: readonly (readonly [CrownForm, number, RGB])[] = [
  [VASE, 0.35, [104, 94, 84]],
  [DOME, 0.45, [80, 66, 54]],
  [OVAL, 0.2, [92, 82, 70]],
];

/** The form and size of a broadleaf tree: the first draws from its random source. */
function broadleafShape(r: Rng): { form: CrownForm; bark: RGB; height: number } {
  let pick = r.next();
  let [form, , bark] = BROADLEAF_FORMS[0];
  for (const [f, weight, b] of BROADLEAF_FORMS) {
    form = f;
    bark = b;
    pick -= weight;
    if (pick < 0) {
      break;
    }
  }
  return { form, bark, height: r.range(6, 11) * (form === OVAL ? 1.15 : 1) };
}

export function drawBroadleaf(p: Painter, o: Planting): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const season = p.env.season;
  const { form, bark, height } = broadleafShape(r);
  const cx = p.x(o.along);
  const base = p.y(0);
  const density = season.leafDensity;
  const color = mix(
    season.leaf,
    [season.leaf[0] * 0.8, season.leaf[1] * 0.9, season.leaf[2] * 0.8],
    r.next() * 0.5,
  );
  const crownPx = form.rx * height * s;
  if (crownPx < 1.2) {
    const top = p.y(height * (form.center + form.ry * 0.6));
    p.rect(cx - 1, top, cx + 1, base, density > 0.4 ? color : bark);
    return;
  }
  const tree = layoutCrown(r, form, cx, base, height, s);
  drawStructure(p, r, tree, form, cx, base, bark, density < 0.95 && crownPx > 4);
  foliage(
    p,
    tree.clumps,
    color,
    0.12 + density * 0.86,
    o.seed,
    p.env.weather.state.snowCover * density,
    tree.volume,
  );
}

function mapleHeight(r: Rng): number {
  return r.range(4.5, 7);
}

/** A Japanese maple: a low, spreading crown, bright green in spring and red late in autumn. */
export function drawMaple(p: Painter, o: Planting): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const season = p.env.season;
  const height = mapleHeight(r);
  const cx = p.x(o.along);
  const base = p.y(0);
  // Maples hold their leaves a little longer than the rest.
  const density = Math.max(
    season.leafDensity,
    smoothstep(0.8, 0.72, season.yearFraction) * smoothstep(0.1, 0.16, season.yearFraction),
  );
  const color = mix(
    season.maple,
    [season.maple[0] * 0.85, season.maple[1] * 0.8, season.maple[2] * 0.8],
    r.next() * 0.6,
  );
  const bark: RGB = [84, 66, 58];
  const crownPx = SPREAD.rx * height * s;
  if (crownPx < 1.2) {
    const top = p.y(height * (SPREAD.center + SPREAD.ry * 0.6));
    p.rect(cx - 1, top, cx + 1, base, density > 0.4 ? color : bark);
    return;
  }
  const tree = layoutCrown(r, SPREAD, cx, base, height, s);
  drawStructure(p, r, tree, SPREAD, cx, base, bark, density < 0.95 && crownPx > 4);
  foliage(
    p,
    tree.clumps,
    color,
    0.1 + density * 0.88,
    o.seed,
    p.env.weather.state.snowCover * density,
    tree.volume,
  );
}

function sakuraHeight(r: Rng): number {
  return r.range(5, 8);
}

export function drawSakura(p: Painter, o: Planting): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const season = p.env.season;
  const height = sakuraHeight(r);
  const cx = p.x(o.along);
  const base = p.y(0);
  const bloom = season.blossom;
  // Cherry leaves come in after the flowers and turn orange early in autumn.
  const leaves = mix(
    season.leaf,
    [214, 120, 70],
    clamp01((season.yearFraction - 0.55) * 8) * (season.yearFraction < 0.8 ? 1 : 0),
  );
  const color = mix(leaves, BLOSSOM, bloom);
  const density = Math.max(bloom, season.leafDensity * (1 - bloom));
  const bark: RGB = [70, 56, 50];
  const crownPx = SPREAD.rx * height * s;
  if (crownPx < 1.2) {
    const top = p.y(height * (SPREAD.center + SPREAD.ry * 0.6));
    p.rect(cx - 1, top, cx + 1, base, density > 0.4 ? color : bark);
    return;
  }
  const tree = layoutCrown(r, SPREAD, cx, base, height, s);
  drawStructure(p, r, tree, SPREAD, cx, base, bark, density < 0.95 && crownPx > 4);
  foliage(
    p,
    tree.clumps,
    color,
    0.1 + density * 0.88,
    o.seed,
    p.env.weather.state.snowCover * density,
    tree.volume,
  );
  if (bloom > 0.5 && s > 2) {
    // Petals drifting away.
    const radius = SPREAD.rx * height;
    const crownY = p.y(height * SPREAD.center);
    for (let i = 0; i < 4; i++) {
      const t = (p.time * 0.3 + hash3(o.seed, i, 1)) % 1;
      p.dot(
        cx + (hash3(o.seed, i, 2) - 0.5) * radius * s * 2 - t * 3 * s,
        crownY + t * height * s * 0.7,
        BLOSSOM,
      );
    }
  }
}

function cedarShape(r: Rng): { height: number; width: number } {
  const height = r.range(12, 22);
  return { height, width: height * r.range(0.2, 0.26) };
}

export function drawCedar(p: Painter, o: Planting): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const season = p.env.season;
  const { height, width } = cedarShape(r);
  const cx = p.x(o.along);
  const base = Math.round(p.y(0));
  const top = Math.round(p.y(height));
  const color = mix(season.evergreen, [42, 58, 44], r.next() * 0.4);
  const snow = p.env.weather.state.snowCover;
  if (width * s < 1.5) {
    p.rect(cx, top, cx + 1, base, color);
    return;
  }
  const trunkTop = Math.round(p.y(height * 0.15));
  limb(p, cx, base, cx, trunkTop, Math.max(1, 0.4 * s), Math.max(1, 0.3 * s), [84, 64, 52], o.seed);
  const layers = Math.max(3, Math.round(height / 3));
  const view = p.view;
  const shade = p.shade;
  const covered = p.cover.order;
  for (let y = top; y < trunkTop; y++) {
    const t = (y - top) / Math.max(1, trunkTop - top);
    // Tiered cone.
    const tierPos = (t * layers) % 1;
    const half = (width / 2) * s * t * (tierPos * 0.35 + 0.65) + 0.5;
    // Each tier's upper face catches the light; its underside is in shade.
    const ny = 0.55 - tierPos * 0.9;
    const coverRow = y * view.width;
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
      // Painted over later by something nearer (and nothing to draw off the view).
      if (
        x < 0 ||
        x >= view.width ||
        y < 0 ||
        y >= view.height ||
        covered[coverRow + x] < o.lateral
      ) {
        continue;
      }
      const n = hash3(o.seed, x - Math.round(cx), y - top);
      const u = clamp01(Math.abs(x + 0.5 - cx) / half) * Math.sign(x + 0.5 - cx);
      const k =
        p.surfaceLight(u * 0.8, ny, Math.sqrt(Math.max(0.05, 1 - u * u * 0.64 - ny * ny))) *
        (0.84 + n * 0.2) *
        (1.02 - t * 0.12);
      let cr = color[0] * k;
      let cg = color[1] * k;
      let cb = color[2] * k;
      // Snow sits on the upper side of each tier, unevenly.
      const lump = hash3(o.seed, x - Math.round(cx), Math.floor(t * layers));
      if (snow > 0 && tierPos < 0.18 + snow * 0.3 * lump && n < snow * 1.1) {
        const lit = Math.min(1.1, 0.25 + k * 0.8);
        cr += (SNOW[0] * lit - cr) * 0.85;
        cg += (SNOW[1] * lit - cg) * 0.85;
        cb += (SNOW[2] * lit - cb) * 0.85;
      }
      view.set(x, y, shade.color(cr, cg, cb));
    }
  }
}

export function drawBamboo(p: Painter, o: Planting): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const height = r.range(9, 14);
  const cx = p.x(o.along);
  const base = Math.round(p.y(0));
  const width = r.range(8, 14) * s;
  const color = mix(BAMBOO, p.env.season.grass, 0.25);
  // A grove: slender culms clothed in feathery leaves most of the way up,
  // the tips bowing over.
  const clumps: Clump[] = [];
  const stems = Math.max(2, Math.round(width / 2));
  const lean = r.range(-0.12, 0.12) * height * s;
  for (let i = 0; i < stems; i++) {
    const x = cx + ((i + 0.5) / stems - 0.5) * width;
    const h = height * r.range(0.8, 1);
    const top = p.y(h);
    p.rect(x, top, x + 1, base, [150, 170, 104]);
    for (const f of [0.35, 0.55, 0.72, 0.88, 1]) {
      clumps.push({
        x: x + lean * f * f + r.range(-0.6, 0.6) * s,
        y: base - (base - top) * f,
        r: Math.max(1, h * (0.09 + 0.05 * f) * s * r.range(0.8, 1.2)),
        z: r.range(0, 1) * s,
        tint: r.range(-0.6, 0.6),
      });
    }
  }
  foliage(p, clumps, color, 1, o.seed, p.env.weather.state.snowCover * 0.6);
}

function pineHeight(r: Rng): number {
  return r.range(7, 12);
}

export function drawPine(p: Painter, o: Planting): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const height = pineHeight(r);
  const cx = p.x(o.along);
  const base = p.y(0);
  const topY = p.y(height);
  // A slightly bowed trunk: pines by the sea stand almost upright, with a gentle curve.
  const bow = r.range(-0.05, 0.05) * height * s;
  const trunkAt = (t: number) => cx + bow * Math.sin(t * Math.PI * 0.9);
  const bark: RGB = [92, 70, 58];
  const segments = 6;
  for (let k = 0; k < segments; k++) {
    const t0 = (k / segments) * 0.85;
    const t1 = ((k + 1) / segments) * 0.85;
    limb(
      p,
      trunkAt(t0),
      base - (base - topY) * t0,
      trunkAt(t1),
      base - (base - topY) * t1,
      Math.max(1, 0.4 * s * (1 - t0 * 0.4)),
      Math.max(1, 0.4 * s * (1 - t1 * 0.4)),
      bark,
      o.seed + k,
    );
  }
  // Tiers of flat, wide needle pads on short branches, largest near the middle.
  const clumps: Clump[] = [];
  const tiers = r.int(3, 5);
  for (let i = 0; i < tiers; i++) {
    const t = 0.5 + (0.5 * (i + 0.5)) / tiers;
    const y = base - (base - topY) * t;
    const spread = (1 - Math.abs(t - 0.7) * 1.2) * height * 0.28 * s;
    const side = i % 2 === 0 ? 1 : -1;
    const w = Math.max(1, r.range(0.8, 1.2) * spread);
    if (w > 2) {
      // The short branch carrying the pad.
      limb(p, trunkAt(t), y + w * 0.1, trunkAt(t) + side * w * 0.6, y, 1.2, 0.6, bark, o.seed + i);
    }
    clumps.push({
      x: trunkAt(t) + side * w * 0.45,
      y,
      r: w,
      squash: 0.42,
      tint: r.range(-0.5, 0.5),
    });
    if (r.chance(0.6)) {
      clumps.push({
        x: trunkAt(t) - side * w * 0.35,
        y: y + w * 0.12,
        r: w * 0.7,
        squash: 0.42,
        tint: r.range(-0.5, 0.5),
      });
    }
  }
  clumps.push({
    x: trunkAt(1),
    y: topY + 0.4 * s,
    r: Math.max(1, height * 0.13 * s),
    squash: 0.5,
  });
  const color = mix(p.env.season.evergreen, [48, 70, 52], 0.3);
  foliage(p, clumps, color, 1, o.seed, p.env.weather.state.snowCover);
}

export type TreeKind = "broadleaf" | "sakura" | "maple" | "cedar" | "pine";

/** The foliage of a tree as an upright ellipsoid (m): its center height and half extents. */
export interface Crown {
  height: number;
  center: number;
  rx: number;
  ry: number;
}

/** The crown the drawing of a tree of `kind` and `seed` has, for casting its shade. */
export function crownOf(kind: TreeKind, seed: number): Crown {
  const r = new Rng(seed);
  const ellipsoid = (form: CrownForm, height: number): Crown => ({
    height,
    center: form.center * height,
    rx: form.rx * height,
    ry: form.ry * height,
  });
  switch (kind) {
    case "broadleaf": {
      const { form, height } = broadleafShape(r);
      return ellipsoid(form, height);
    }
    case "sakura":
      return ellipsoid(SPREAD, sakuraHeight(r));
    case "maple":
      return ellipsoid(SPREAD, mapleHeight(r));
    case "cedar": {
      // A tiered cone from low on the trunk to the top.
      const { height, width } = cedarShape(r);
      return { height, center: height * 0.55, rx: width * 0.36, ry: height * 0.43 };
    }
    case "pine": {
      const height = pineHeight(r);
      return { height, center: height * 0.78, rx: height * 0.32, ry: height * 0.2 };
    }
  }
}
