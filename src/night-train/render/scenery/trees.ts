import { mix, type RGB } from "../../core/color.ts";
import { clamp01 } from "../../core/math.ts";
import { hash3, Rng } from "../../core/random.ts";
import type { Painter } from "../painter.ts";
import type { Scenery } from "./placement.ts";

const TRUNK: RGB = [78, 62, 50];
const BRANCH: RGB = [92, 76, 64];
const SNOW: RGB = [236, 240, 248];
const BLOSSOM: RGB = [250, 206, 220];
const BAMBOO: RGB = [132, 168, 92];

interface Blob {
  x: number;
  y: number;
  r: number;
  /** Vertical squash; below 1 makes a flat, wide pad. */
  squash?: number;
}

/**
 * Paints a crown made of overlapping blobs. Light comes from above; `density`
 * below 1 thins the crown pixel by pixel so bare branches show through.
 */
function crown(
  p: Painter,
  blobs: readonly Blob[],
  color: RGB,
  density: number,
  seed: number,
  snowOnTop: number,
): void {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const b of blobs) {
    x0 = Math.min(x0, b.x - b.r);
    x1 = Math.max(x1, b.x + b.r);
    y0 = Math.min(y0, b.y - b.r * (b.squash ?? 1));
    y1 = Math.max(y1, b.y + b.r * (b.squash ?? 1));
  }
  const height = Math.max(1, y1 - y0);
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      let inside = false;
      let edge = 0;
      for (const b of blobs) {
        const d = Math.hypot(x + 0.5 - b.x, (y + 0.5 - b.y) / (b.squash ?? 1));
        if (d <= b.r) {
          inside = true;
          edge = Math.max(edge, 1 - d / b.r);
        }
      }
      if (!inside) {
        continue;
      }
      const n = hash3(seed, x - Math.floor(x0), y - Math.floor(y0));
      if (n > density) {
        continue;
      }
      const t = (y + 0.5 - y0) / height;
      // Top-lit with a little leafy texture.
      const k = 1.15 - t * 0.45 + (n - 0.5) * 0.18 + (edge < 0.15 ? -0.08 : 0);
      let c: RGB = [color[0] * k, color[1] * k, color[2] * k];
      if (snowOnTop > 0 && t < snowOnTop * 0.6 && n < 0.8) {
        c = mix(c, SNOW, 0.85);
      }
      p.dot(x, y, c);
    }
  }
}

/** Forked bare branches, drawn under thin crowns. */
function branches(
  p: Painter,
  cx: number,
  base: number,
  top: number,
  spread: number,
  seed: number,
): void {
  const r = new Rng(seed);
  const h = base - top;
  for (let i = 0; i < 5; i++) {
    const startY = base - h * r.range(0.35, 0.6);
    const endX = cx + r.range(-1, 1) * spread;
    const endY = top + h * r.range(0, 0.35);
    const steps = Math.ceil(Math.max(Math.abs(endX - cx), Math.abs(endY - startY)));
    for (let k = 0; k <= steps; k++) {
      const t = k / Math.max(1, steps);
      p.dot(cx + (endX - cx) * t, startY + (endY - startY) * t, BRANCH);
    }
  }
}

function trunk(p: Painter, cx: number, base: number, top: number, width: number): void {
  p.rect(cx - width / 2, top, cx + width / 2, base, TRUNK);
}

function roundCrown(r: Rng, cx: number, cy: number, radius: number, lumps: number): Blob[] {
  const blobs: Blob[] = [{ x: cx, y: cy, r: radius }];
  for (let i = 0; i < lumps; i++) {
    const a = r.range(0, Math.PI * 2);
    const d = r.range(0.35, 0.7) * radius;
    blobs.push({
      x: cx + Math.cos(a) * d,
      y: cy + Math.sin(a) * d * 0.7,
      r: radius * r.range(0.45, 0.7),
    });
  }
  return blobs;
}

export function drawBroadleaf(p: Painter, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const season = p.world.season;
  const height = r.range(6, 11);
  const radius = height * r.range(0.3, 0.42);
  const cx = p.x(o.along);
  const base = p.y(0);
  const crownY = p.y(height - radius);
  const density = season.leafDensity;
  const color = mix(
    season.leaf,
    [season.leaf[0] * 0.8, season.leaf[1] * 0.9, season.leaf[2] * 0.8],
    r.next() * 0.5,
  );
  if (radius * s < 1.2) {
    p.rect(cx - 1, crownY - 1, cx + 1, base, density > 0.4 ? color : BRANCH);
    return;
  }
  trunk(p, cx, base, crownY, Math.max(1, 0.35 * s));
  if (density < 0.8) {
    branches(p, cx, base - height * 0.25 * s, crownY - radius * s, radius * s, o.seed);
  }
  crown(
    p,
    roundCrown(r, cx, crownY, radius * s, 4),
    color,
    0.2 + density * 0.8,
    o.seed,
    p.world.weather.state.snowCover * density,
  );
}

export function drawSakura(p: Painter, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const season = p.world.season;
  const height = r.range(5, 8);
  const radius = height * 0.48;
  const cx = p.x(o.along);
  const base = p.y(0);
  const crownY = p.y(height - radius * 0.8);
  const bloom = season.blossom;
  // Cherry leaves come in after the flowers and turn orange early in autumn.
  const leaves = mix(
    season.leaf,
    [214, 120, 70],
    clamp01((season.yearFraction - 0.55) * 8) * (season.yearFraction < 0.8 ? 1 : 0),
  );
  const color = mix(leaves, BLOSSOM, bloom);
  const density = Math.max(bloom, season.leafDensity * (1 - bloom));
  if (radius * s < 1.2) {
    p.rect(cx - 1, crownY - 1, cx + 1, base, density > 0.4 ? color : BRANCH);
    return;
  }
  trunk(p, cx, base, crownY, Math.max(1, 0.45 * s));
  if (density < 0.85) {
    branches(p, cx, base - height * 0.2 * s, crownY - radius * s * 0.7, radius * s * 1.1, o.seed);
  }
  // A wide, low crown.
  const blobs = roundCrown(r, cx, crownY, radius * s, 5).map((b) => ({
    ...b,
    y: crownY + (b.y - crownY) * 0.75,
  }));
  crown(p, blobs, color, 0.15 + density * 0.85, o.seed, p.world.weather.state.snowCover * density);
  if (bloom > 0.5 && s > 2) {
    // Petals drifting away.
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

export function drawCedar(p: Painter, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const season = p.world.season;
  const height = r.range(12, 22);
  const width = height * r.range(0.2, 0.26);
  const cx = p.x(o.along);
  const base = Math.round(p.y(0));
  const top = Math.round(p.y(height));
  const color = mix(season.evergreen, [42, 58, 44], r.next() * 0.4);
  const snow = p.world.weather.state.snowCover;
  if (width * s < 1.5) {
    p.rect(cx, top, cx + 1, base, color);
    return;
  }
  const trunkTop = Math.round(p.y(height * 0.15));
  trunk(p, cx, base, trunkTop, Math.max(1, 0.4 * s));
  const layers = Math.max(3, Math.round(height / 3));
  for (let y = top; y < trunkTop; y++) {
    const t = (y - top) / Math.max(1, trunkTop - top);
    // Tiered cone.
    const tier = ((t * layers) % 1) * 0.35 + 0.65;
    const half = (width / 2) * s * t * tier + 0.5;
    const shade = 1.05 - t * 0.35;
    // Snow sits on the upper side of each tier, unevenly.
    const tierPos = (t * layers) % 1;
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
      const n = hash3(o.seed, x - Math.round(cx), y - top);
      let c: RGB = [
        color[0] * shade * (0.9 + n * 0.2),
        color[1] * shade * (0.9 + n * 0.2),
        color[2] * shade * (0.9 + n * 0.2),
      ];
      const lump = hash3(o.seed, x - Math.round(cx), Math.floor(t * layers));
      if (snow > 0 && tierPos < 0.18 + snow * 0.3 * lump && n < snow * 1.1) {
        c = mix(c, SNOW, 0.85);
      }
      p.dot(x, y, c);
    }
  }
}

export function drawBamboo(p: Painter, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const height = r.range(9, 14);
  const cx = p.x(o.along);
  const base = Math.round(p.y(0));
  const width = r.range(4, 7) * s;
  const color = mix(BAMBOO, p.world.season.grass, 0.25);
  // A grove: slender culms clothed in feathery leaves most of the way up,
  // the tips bowing over.
  const blobs: Blob[] = [];
  const stems = Math.max(2, Math.round(width / 2));
  const lean = r.range(-0.12, 0.12) * height * s;
  for (let i = 0; i < stems; i++) {
    const x = cx + ((i + 0.5) / stems - 0.5) * width;
    const h = height * r.range(0.8, 1);
    const top = p.y(h);
    p.rect(x, top, x + 1, base, [150, 170, 104]);
    for (const f of [0.35, 0.55, 0.72, 0.88, 1]) {
      blobs.push({
        x: x + lean * f * f + r.range(-0.6, 0.6) * s,
        y: base - (base - top) * f,
        r: Math.max(1, h * (0.09 + 0.05 * f) * s * r.range(0.8, 1.2)),
      });
    }
  }
  crown(p, blobs, color, 1, o.seed, p.world.weather.state.snowCover * 0.6);
}

export function drawPine(p: Painter, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const height = r.range(7, 12);
  const cx = p.x(o.along);
  const base = p.y(0);
  const topY = p.y(height);
  // A slightly bowed trunk: pines by the sea stand almost upright, with a gentle curve.
  const bow = r.range(-0.05, 0.05) * height * s;
  const trunkAt = (t: number) => cx + bow * Math.sin(t * Math.PI * 0.9);
  const steps = Math.ceil(base - topY);
  for (let k = 0; k <= steps * 0.85; k++) {
    const t = k / Math.max(1, steps);
    const x = trunkAt(t);
    p.rect(x, base - k - 1, x + Math.max(1, 0.4 * s * (1 - t * 0.4)), base - k, [92, 70, 58]);
  }
  // Tiers of flat, wide needle pads on short branches, largest near the middle.
  const blobs: Blob[] = [];
  const tiers = r.int(3, 5);
  for (let i = 0; i < tiers; i++) {
    const t = 0.5 + (0.5 * (i + 0.5)) / tiers;
    const y = base - (base - topY) * t;
    const spread = (1 - Math.abs(t - 0.7) * 1.2) * height * 0.28 * s;
    const side = i % 2 === 0 ? 1 : -1;
    const w = Math.max(1, r.range(0.8, 1.2) * spread);
    blobs.push({ x: trunkAt(t) + side * w * 0.45, y, r: w, squash: 0.42 });
    if (r.chance(0.6)) {
      blobs.push({ x: trunkAt(t) - side * w * 0.35, y: y + w * 0.12, r: w * 0.7, squash: 0.42 });
    }
  }
  blobs.push({ x: trunkAt(1), y: topY + 0.4 * s, r: Math.max(1, height * 0.13 * s), squash: 0.5 });
  const color = mix(p.world.season.evergreen, [48, 70, 52], 0.3);
  crown(p, blobs, color, 1, o.seed, p.world.weather.state.snowCover);
}
