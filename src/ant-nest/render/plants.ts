import { hex, mix, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep, TAU } from "../../shared/core/math.ts";
import { hash2, Rng } from "../../shared/core/random.ts";
import type { Point } from "../sim/geometry.ts";
import type { Stem } from "../sim/surface.ts";
import type { World } from "../sim/world.ts";
import { blob, type Frame, sx, sy } from "./frame.ts";

const GREEN: RGB = hex("#5f8f3a");
const DARK_GREEN: RGB = hex("#44702e");
const STRAW: RGB = hex("#b89c62");
const DEAD: RGB = hex("#8a7453");
const FOXTAIL_GREEN: RGB = hex("#9dbb5a");
const FOXTAIL_GOLD: RGB = hex("#c8a860");
const PETAL: RGB = [246, 244, 238];
const DISK: RGB = [236, 190, 40];
const APHID: RGB = hex("#8fc04a");

const P: Point = { x: 0, y: 0 };
const Q: Point = { x: 0, y: 0 };

/**
 * The plants growing along the cut edge, whose stems the ants climb: foxtail
 * grass with its nodding heads, fleabane with small white daisies, and plain
 * grass; green in summer, straw in autumn, gone in winter. Aphids crowd the
 * upper stem of one of them in the warm months.
 */
export function drawPlants(f: Frame, world: World): void {
  const yf = world.season.yearFraction;
  const surface = world.surface;
  surface.stems.forEach((stem, k) => {
    const height = surface.stemHeight(k, yf);
    if (height < 3) {
      return;
    }
    const dryness = stemDryness(stem, yf);
    const color = mix(mix(GREEN, DARK_GREEN, hash2(stem.seed, 1)), STRAW, dryness);
    const r = new Rng(stem.seed);
    // Leaves first, so the stem crosses over them.
    drawLeaves(f, world, k, stem, height, color, dryness, r);
    drawStemLine(f, world, k, height, color);
    switch (stem.kind) {
      case "foxtail":
        drawFoxtailHead(f, world, k, height, dryness);
        break;
      case "fleabane":
        drawFleabaneHead(f, world, k, height, yf, r);
        break;
      case "grass":
        break;
    }
    const aphids = surface.aphids(k, yf);
    if (aphids > 0.02) {
      drawAphids(f, world, k, height, aphids, stem.seed);
    }
  });
}

/** How far a plant has dried to straw (0 green .. 1 dead) at `yf`. */
function stemDryness(stem: Stem, yf: number): number {
  switch (stem.kind) {
    case "foxtail":
      return smoothstep(0.55, 0.7, yf);
    case "fleabane":
      return smoothstep(0.5, 0.64, yf);
    case "grass":
      return smoothstep(0.6, 0.75, yf);
  }
}

function drawStemLine(f: Frame, world: World, k: number, height: number, color: RGB): void {
  const yf = world.season.yearFraction;
  const light = f.light;
  const steps = Math.ceil(height);
  for (let i = 0; i <= steps; i++) {
    world.surface.stemPoint(k, (i / steps) * height, yf, P);
    const x = sx(f, P.x);
    const y = sy(f, P.y);
    // Lit on its left side.
    f.view.blend(x, y, color[0] * light[0], color[1] * light[1], color[2] * light[2], 1);
    if (i < steps * 0.4) {
      f.view.blend(
        x + 1,
        y,
        color[0] * light[0] * 0.75,
        color[1] * light[1] * 0.75,
        color[2] * light[2] * 0.75,
        0.8,
      );
    }
  }
}

/** Long narrow leaves from the lower stem, arching out and down at their tips. */
function drawLeaves(
  f: Frame,
  world: World,
  k: number,
  stem: Stem,
  height: number,
  color: RGB,
  dryness: number,
  r: Rng,
): void {
  const yf = world.season.yearFraction;
  const light = f.light;
  const count = stem.kind === "fleabane" ? 7 : stem.kind === "grass" ? 4 : 3;
  const time = f.time;
  const wind = world.env.weather.state.wind;
  for (let n = 0; n < count; n++) {
    const at =
      stem.kind === "fleabane"
        ? height * (0.12 + 0.62 * (n / count))
        : height * (0.04 + 0.2 * r.next());
    const side = n % 2 === 0 ? 1 : -1;
    const long =
      (stem.kind === "fleabane" ? 7 + 6 * (1 - n / count) : 10 + 12 * r.next()) *
      (stem.kind === "grass" ? 1.5 : 1);
    world.surface.stemPoint(k, at, yf, P);
    const droop = 0.4 + 0.5 * r.next() + dryness * 0.5;
    const flutter = wind * Math.sin(time * 2.1 + n + stem.seed) * 0.15;
    const steps = Math.ceil(long);
    const wide = stem.kind === "fleabane" ? 1.6 : 1;
    const leaf = mix(
      color,
      dryness > 0.5 ? DEAD : [color[0] * 1.1, color[1] * 1.12, color[2]],
      0.3,
    );
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Out and up, then over and down.
      const dx = side * t * long * 0.85;
      const dy = t * long * (0.75 - droop * t) + flutter * t * long;
      const x = sx(f, P.x + dx);
      const y = sy(f, P.y + dy);
      const w = Math.max(0, wide * Math.sin(Math.PI * Math.min(1, t * 1.15)));
      const shade = 0.85 + 0.25 * (1 - t);
      f.view.blend(
        x,
        y,
        leaf[0] * light[0] * shade,
        leaf[1] * light[1] * shade,
        leaf[2] * light[2] * shade,
        1,
      );
      if (w > 0.8) {
        f.view.blend(
          x,
          y - 1,
          leaf[0] * light[0] * 1.08,
          leaf[1] * light[1] * 1.08,
          leaf[2] * light[2] * 1.08,
          0.7,
        );
      }
    }
  }
}

/** A foxtail's fuzzy head: a nodding cylinder of bristly spikelets, green, then gold. */
function drawFoxtailHead(f: Frame, world: World, k: number, height: number, dryness: number): void {
  const yf = world.season.yearFraction;
  const heading = smoothstep(0.24, 0.34, yf);
  if (heading < 0.05) {
    return;
  }
  const light = f.light;
  const long = 22 * heading;
  const color = mix(FOXTAIL_GREEN, FOXTAIL_GOLD, dryness);
  const wind = world.env.weather.state.wind;
  // The head nods over along the stem's last curve.
  world.surface.stemPoint(k, height, yf, P);
  world.surface.stemPoint(k, height - 4, yf, Q);
  let ax = P.x - Q.x;
  let ay = P.y - Q.y;
  const l = Math.hypot(ax, ay) || 1;
  ax /= l;
  ay /= l;
  const nod = 0.9 + wind * 0.3 * Math.sin(f.time * 1.7 + k);
  for (let i = 0; i < long; i++) {
    const t = i / long;
    // Bending over: the axis turns toward the ground along the head.
    const bend = nod * t * t;
    const dx = ax * Math.cos(bend) + Math.sign(ax || 1) * Math.sin(bend) * Math.abs(ay);
    const dy = ay * Math.cos(bend) - Math.sin(bend);
    const x = P.x + dx * i;
    const y = P.y + dy * i;
    const r = 1.6 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95));
    blob(f.view, sx(f, x), sy(f, y), r + 0.3, r + 0.3, 0, color, light, 0.9, 0.35);
    // Bristles sticking out.
    if (i % 2 === 0) {
      const h = hash2(k * 97 + i, 5);
      f.view.blend(
        sx(f, x) + (h > 0.5 ? r + 1.4 : -r - 1.4),
        sy(f, y) - 1,
        color[0] * light[0] * 1.15,
        color[1] * light[1] * 1.15,
        color[2] * light[2] * 1.1,
        0.55,
      );
    }
  }
}

/** Fleabane: a spray of small white daisies with yellow middles at the top, buds before, fluff after. */
function drawFleabaneHead(
  f: Frame,
  world: World,
  k: number,
  height: number,
  yf: number,
  r: Rng,
): void {
  const flowering = smoothstep(0.17, 0.24, yf) * (1 - smoothstep(0.48, 0.56, yf));
  const seeding = smoothstep(0.5, 0.56, yf) * (1 - smoothstep(0.62, 0.7, yf));
  world.surface.stemPoint(k, height, yf, P);
  const light = f.light;
  const count = 7;
  for (let n = 0; n < count; n++) {
    const a = -Math.PI / 2 + (n / (count - 1) - 0.5) * 2.2;
    const reach = 5 + 6 * r.next();
    const x = P.x + Math.cos(a + Math.PI) * reach * 0.9 * (n % 2 ? 1 : -1) * 0.6;
    const y = P.y + 2 + Math.abs(Math.sin(a)) * reach * 0.5 + r.next() * 3;
    // A thin pedicel up to each head.
    const steps = Math.ceil(Math.hypot(x - P.x, y - P.y));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      f.view.blend(
        sx(f, P.x + (x - P.x) * t),
        sy(f, P.y + (y - P.y) * t),
        GREEN[0] * light[0],
        GREEN[1] * light[1],
        GREEN[2] * light[2],
        0.9,
      );
    }
    const cx = sx(f, x);
    const cy = sy(f, y);
    if (flowering > 0.1) {
      const open = flowering;
      for (let p = 0; p < 10; p++) {
        const pa = (p / 10) * TAU;
        f.view.blend(
          cx + Math.cos(pa) * 1.8 * open,
          cy + Math.sin(pa) * 0.9 * open,
          PETAL[0] * light[0],
          PETAL[1] * light[1],
          PETAL[2] * light[2],
          0.9,
        );
      }
      blob(f.view, cx, cy, 0.9, 0.7, 0, DISK, light, 1, 0.3);
    } else if (seeding > 0.1) {
      blob(f.view, cx, cy - 0.5, 1.4, 1.2, 0, [236, 232, 220], light, 0.6 * seeding, 0.2);
    } else if (yf < 0.2) {
      blob(f.view, cx, cy, 0.8, 0.8, 0, [150, 170, 110], light, 1, 0.3);
    }
  }
}

/** Aphids on the upper stem: small green bodies in a line up the stem, more in the thick of summer. */
function drawAphids(
  f: Frame,
  world: World,
  k: number,
  height: number,
  amount: number,
  seed: number,
): void {
  const yf = world.season.yearFraction;
  const light = f.light;
  const count = Math.round(amount * 16);
  for (let n = 0; n < count; n++) {
    const s = height * (0.55 + 0.37 * hash2(seed + n, 3));
    world.surface.stemPoint(k, s, yf, P);
    const side = hash2(seed + n, 4) > 0.5 ? 1.2 : -1.2;
    const size = 0.8 + 0.6 * hash2(seed + n, 6);
    const color = mix(APHID, [70, 110, 40], hash2(seed + n, 5) * 0.5);
    blob(f.view, sx(f, P.x + side), sy(f, P.y), size, size * 0.8, 0.4, color, light, 1, 0.5);
    f.view.blend(
      sx(f, P.x + side) + (side > 0 ? 1 : -1),
      sy(f, P.y) + 0.5,
      40 * light[0],
      30 * light[1],
      30 * light[2],
      0.5 * clamp01(size),
    );
  }
}
