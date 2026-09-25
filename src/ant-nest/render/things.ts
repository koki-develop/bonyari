import { mix, type RGB } from "../../shared/core/color.ts";
import { clamp01 } from "../../shared/core/math.ts";
import { hash2 } from "../../shared/core/random.ts";
import { type Brood, broodRadius, type Item, LARVA_FOOD } from "../sim/colony.ts";
import { SURFACE } from "../sim/geometry.ts";
import type { World } from "../sim/world.ts";
import { blob, type Frame, sx, sy } from "./frame.ts";
import { COCOON, COCOON_SPOT, CRUMB, CRUST, EGG, LARVA, WING, WING_VEIN } from "./palette.ts";

const P = { x: 0, y: 0 };

/** Insects that fall dead to the ground: a fly, a moth, a caterpillar, a young grasshopper. */
const INSECT_BODY: readonly RGB[] = [
  [52, 50, 54],
  [124, 106, 84],
  [118, 150, 70],
  [120, 132, 70],
];

/**
 * Draws a brood item lying at screen (x, y): an egg, a curled larva (fed ones
 * with the dark of their gut showing through), or a buff cocoon with the dark
 * spot at its end. `angle` turns it (radians, screen).
 */
export function drawBroodItem(f: Frame, b: Brood, x: number, y: number, angle: number): void {
  const view = f.view;
  const light = f.light;
  const r = broodRadius(b);
  switch (b.stage) {
    case "egg":
      blob(view, x, y, 0.62, 0.48, angle, EGG, light, 0.95, 0.5);
      break;
    case "larva": {
      // A grub curled like a comma: a round body and a smaller head end.
      const fed = clamp01(b.fed / LARVA_FOOD[b.caste]);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      blob(
        view,
        x - cos * r * 0.35,
        y - sin * r * 0.35,
        r * 0.85,
        r * 0.72,
        angle,
        LARVA,
        light,
        1,
        0.45,
      );
      blob(
        view,
        x + cos * r * 0.45 + sin * r * 0.2,
        y + sin * r * 0.45 - cos * r * 0.2,
        r * 0.55,
        r * 0.5,
        angle,
        LARVA,
        light,
        1,
        0.45,
      );
      if (fed > 0.3 && r > 1) {
        blob(
          view,
          x - cos * r * 0.3,
          y - sin * r * 0.3,
          r * 0.35,
          r * 0.28,
          angle,
          mix(LARVA, [120, 96, 70], 0.7),
          light,
          0.6 * fed,
          0,
        );
      }
      break;
    }
    case "pupa": {
      const long = r * 1.28;
      const wide = r * 0.8;
      blob(view, x, y, long, wide, angle, COCOON, light, 1, 0.4);
      // The spot where the larva left its gut, at the back end.
      blob(
        view,
        x - Math.cos(angle) * long * 0.72,
        y - Math.sin(angle) * long * 0.72,
        wide * 0.45,
        wide * 0.45,
        0,
        COCOON_SPOT,
        light,
        0.85,
        0,
      );
      break;
    }
  }
}

/** The angle a brood item lies at: its own, from its id. */
export function broodAngle(b: Brood): number {
  return hash2(b.id, 911) * Math.PI * 2;
}

/** The brood lying in the nest (what is carried is drawn with its carrier). */
export function drawBrood(f: Frame, world: World): void {
  // Cocoons at the back, then larvae, then eggs on top.
  for (const stage of ["pupa", "larva", "egg"] as const) {
    for (const b of world.brood) {
      if (b.carried || b.stage !== stage) {
        continue;
      }
      world.locate(b.loc, P);
      drawBroodItem(f, b, sx(f, P.x), sy(f, P.y) - broodRadius(b) * 0.2, broodAngle(b));
    }
  }
}

/**
 * Draws an item at screen (x, y): food on the ground, food stored, cocoon
 * husks, scraps, and the queen's shed wings.
 */
export function drawItem(f: Frame, item: Item, x: number, y: number): void {
  const view = f.view;
  const light = f.light;
  const angle = hash2(item.id, 17) * Math.PI * 2;
  switch (item.kind) {
    case "crumb": {
      // A crumb of bread: pale inside, a brown crust on one side; it shrinks as it is eaten, darkens in the rain.
      const left = Math.sqrt(clamp01(item.amount / Math.max(1, item.size * item.size * 0.45)));
      const r = (item.size / 2) * Math.max(0.35, left);
      const soak = item.soggy * 0.35;
      const crumb = mix(CRUMB, [150, 128, 96], soak);
      const crust = mix(CRUST, [80, 60, 40], soak);
      blob(view, x, y - r * 0.7, r, r * 0.8, angle, crumb, light, 1, 0.3);
      blob(view, x + r * 0.35, y - r * 0.5, r * 0.55, r * 0.5, angle, crust, light, 0.9, 0.2);
      break;
    }
    case "insect": {
      const left = clamp01(item.amount / Math.max(1, Math.round(item.size * 0.9)));
      const long = (item.size / 2) * (0.45 + 0.55 * left);
      const body = INSECT_BODY[item.variant % INSECT_BODY.length];
      const flat = Math.cos(angle) > 0 ? 0 : Math.PI;
      if (item.variant === 2) {
        // A caterpillar: segments in a gentle curve.
        const n = Math.max(2, Math.round(long * 1.2));
        for (let k = 0; k < n; k++) {
          const t = k / (n - 1) - 0.5;
          blob(
            view,
            x + t * long * 2,
            y - 1.2 - Math.abs(t) * 0.8,
            1.2,
            1.1,
            0,
            mix(body, [60, 80, 40], k % 2 ? 0.15 : 0),
            light,
            1,
            0.4,
          );
        }
      } else {
        blob(view, x, y - long * 0.35, long, long * 0.38, flat + 0.15, body, light, 1, 0.3);
        if (item.variant === 0 || item.variant === 1) {
          // Wings, clear on a fly, dusty on a moth.
          const wing = item.variant === 0 ? ([200, 210, 220] as RGB) : ([150, 132, 106] as RGB);
          blob(
            view,
            x - long * 0.2,
            y - long * 0.8,
            long * 0.8,
            long * 0.32,
            flat - 0.4,
            wing,
            light,
            item.variant === 0 ? 0.45 : 0.85,
            0.2,
          );
        }
        // Legs in the air.
        for (let k = -1; k <= 1; k++) {
          view.blend(
            x + k * long * 0.4,
            y - long * 0.8 - 1,
            body[0] * light[0] * 0.7,
            body[1] * light[1] * 0.7,
            body[2] * light[2] * 0.7,
            0.8,
          );
        }
      }
      break;
    }
    case "store": {
      // Food brought in: crumbs pale, bits of insect dark.
      const r = 0.8 + Math.min(1.4, item.amount * 0.5);
      const c: RGB = item.variant === 1 ? [92, 78, 62] : CRUMB;
      blob(view, x, y - r * 0.6, r, r * 0.8, angle, c, light, 1, 0.3);
      break;
    }
    case "husk": {
      // An empty cocoon, split at one end.
      const long = item.size / 2;
      blob(
        view,
        x,
        y - long * 0.5,
        long,
        long * 0.5,
        angle,
        mix(COCOON, [240, 228, 200], 0.4),
        light,
        0.85,
        0.3,
      );
      blob(
        view,
        x + Math.cos(angle) * long * 0.8,
        y - long * 0.5 + Math.sin(angle) * long * 0.8,
        long * 0.35,
        long * 0.3,
        0,
        [60, 44, 34],
        light,
        0.35,
        0,
      );
      break;
    }
    case "scrap":
      blob(view, x, y - 1, 1.2, 0.8, angle, [70, 58, 48], light, 0.9, 0.2);
      break;
    case "wing": {
      // A shed wing lying flat: long, clear, with its veins.
      const long = item.size / 2;
      const tilt = (hash2(item.id, 23) - 0.5) * 0.35;
      blob(view, x, y - 0.8, long, long * 0.22, tilt, WING, light, 0.55, 0.5);
      for (let k = -long * 0.8; k < long * 0.8; k += 1) {
        view.blend(
          x + k,
          y - 0.8 + Math.sin(tilt) * k - long * 0.1,
          WING_VEIN[0] * light[0],
          WING_VEIN[1] * light[1],
          WING_VEIN[2] * light[2],
          0.35,
        );
      }
      break;
    }
  }
}

/** Items inside the nest: the food store, husks and scraps waiting to go out. */
export function drawNestItems(f: Frame, world: World): void {
  for (const it of world.items) {
    if (it.carried || it.loc.f < 0) {
      continue;
    }
    world.locate(it.loc, P);
    drawItem(f, it, sx(f, P.x), sy(f, P.y) + 1.5);
  }
}

/** Items on the ground: crumbs and insects (some still falling), the midden, the shed wings. */
export function drawGroundItems(f: Frame, world: World): void {
  for (const it of world.items) {
    if (it.carried || it.loc.f !== SURFACE) {
      continue;
    }
    const x = it.loc.s;
    const y = world.surface.height(x) + it.drop;
    drawItem(f, it, sx(f, x), sy(f, y));
  }
}
