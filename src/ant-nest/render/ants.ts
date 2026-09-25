import { mix, type RGB } from "../../shared/core/color.ts";
import { clamp, mod } from "../../shared/core/math.ts";
import { type Ant, maturity } from "../sim/colony.ts";
import { AIR_LOC, isStem, SURFACE } from "../sim/geometry.ts";
import { LEAVE_TIME, type World } from "../sim/world.ts";
import { blob, type Frame, soilTone, sx, sy } from "./frame.ts";
import { COCOON, CRUMB } from "./palette.ts";
import {
  type AntSprites,
  type Build,
  drawSprite,
  drawWings,
  type SpriteKey,
  STRIDES,
} from "./sprites.ts";
import { drawBroodItem } from "./things.ts";

const KEY: SpriteKey = {
  build: "worker",
  length: 8,
  stride: 0,
  antennae: 0,
  wings: "none",
  full: false,
  color: 3,
};

/** Which ants to draw: those in the nest, or those out on the ground, on plants and in the air. */
export type Where = "nest" | "outside";

/**
 * Draws the ants of one place, each in its pose: striding, digging with its
 * head bobbing, antennae busy when it meets another or tends the brood, and
 * whatever it carries in its jaws.
 */
export function drawAnts(f: Frame, world: World, sprites: AntSprites, where: Where): void {
  for (const ant of world.ants) {
    const inside = ant.loc.f >= 0;
    if ((where === "nest") !== inside) {
      continue;
    }
    drawAnt(f, world, sprites, ant);
  }
}

function buildOf(ant: Ant): Build {
  switch (ant.caste) {
    case "queen":
      return "queen";
    case "gyne":
      return "gyne";
    case "male":
      return "male";
    default:
      return ant.size > 10.2 ? "major" : "worker";
  }
}

function drawAnt(f: Frame, world: World, sprites: AntSprites, ant: Ant): void {
  const time = f.time;
  const key = KEY;
  key.build = buildOf(ant);
  key.length = Math.round(ant.size * 2) / 2;
  key.color = Math.min(3, Math.floor(maturity(world.day - ant.born) * 3.999));
  key.full = ant.crop > 0.5;
  key.wings = ant.winged ? (ant.pose === "fly" ? "beating" : "folded") : "none";
  const walking = ant.way !== null && ant.wait <= 0;
  // A stride frame for each fifth of a body length walked; at rest, feet where they stopped.
  key.stride = mod(Math.floor(ant.gait / (ant.size * 0.2)), STRIDES);
  // Each ant keeps its own rhythm; never negative, for the frame counts below.
  const phase = time + (ant.quirk + 1) * 5.3;
  switch (ant.pose) {
    case "dig":
      key.antennae = 2;
      break;
    case "antennate":
    case "feed":
    case "tend":
      key.antennae = Math.floor(phase * 7) % 2;
      break;
    case "shed":
      key.antennae = Math.floor(phase * 3) % 2 === 0 ? 0 : 2;
      key.stride = Math.floor(phase * 5) % STRIDES;
      break;
    case "groom":
      key.antennae = Math.floor(phase * 2.5) % 2 === 0 ? 1 : 2;
      key.stride = Math.floor(phase * 4) % 2;
      break;
    default:
      key.antennae = walking ? ((phase * 2.3) % 1 < 0.2 ? 1 : 0) : (phase * 0.6) % 1 < 0.5 ? 0 : 1;
  }
  const light = f.light;
  let x = sx(f, ant.x);
  let y = sy(f, ant.y);
  const cos = Math.cos(ant.heading);
  const sin = Math.sin(ant.heading);
  // Digging: the head bobs as the jaws work at the face.
  if (ant.pose === "dig" && ant.wait > 0) {
    const bob = Math.sin(time * 17 + ant.quirk * 3) > 0 ? 0.55 : 0;
    x += cos * bob;
    y -= sin * bob;
  }
  if (ant.loc.f === SURFACE) {
    // On the ground, seen from the side; one walking off into the grass fades away behind the cut.
    const dir = cos >= 0 ? 1 : -1;
    const tilt = clamp(Math.atan(world.surface.slope(ant.x)), -0.48, 0.48);
    const away = ant.leaving >= 0 ? Math.min(1, ant.leaving / LEAVE_TIME) : 0;
    drawSprite(f.view, sprites.side(key, dir, tilt), x, y - away * 3, light, 1 - away);
    if (away > 0) {
      return;
    }
    if (ant.winged) {
      // Folded wings along the back.
      blob(
        f.view,
        x - dir * ant.size * 0.2,
        y - ant.size * 0.33,
        ant.size * 0.36,
        ant.size * 0.07,
        -dir * 0.12,
        [214, 220, 226],
        light,
        0.5,
        0.4,
      );
    }
    drawCargo(f, world, ant, x + dir * ant.size * 0.46, y - ant.size * 0.16, dir > 0 ? 0 : Math.PI);
    return;
  }
  const sprite = sprites.top(key, ant.heading);
  drawSprite(f.view, sprite, x, y, light);
  if (key.wings !== "none") {
    drawWings(f.view, x, y, ant.heading, ant.size, key.wings, time, light);
  }
  if (ant.loc.f === AIR_LOC || isStem(ant.loc.f) || ant.loc.f >= 0) {
    drawCargo(f, world, ant, x + cos * ant.size * 0.47, y - sin * ant.size * 0.47, -ant.heading);
  }
}

/** What an ant carries, held in its jaws at screen (x, y), lying along `angle` (screen radians). */
function drawCargo(f: Frame, world: World, ant: Ant, x: number, y: number, angle: number): void {
  const cargo = ant.cargo;
  if (!cargo) {
    return;
  }
  const light = f.light;
  switch (cargo.kind) {
    case "soil": {
      // A pellet of the soil it was dug from.
      const tone = soilTone(world.soil.horizon(cargo.x, cargo.y));
      const r = 0.7 + Math.min(0.9, cargo.amount * 0.12);
      blob(f.view, x, y, r, r * 0.85, angle, tone, light, 1, 0.3);
      break;
    }
    case "brood": {
      const b = world.broodOf(cargo.id);
      if (b) {
        drawBroodItem(f, b, x + Math.cos(angle) * 0.8, y + Math.sin(angle) * 0.8, angle);
      }
      break;
    }
    case "food": {
      const c: RGB =
        cargo.from === "insect"
          ? [96, 84, 66]
          : cargo.from === "store"
            ? mix(CRUMB, [200, 170, 120], 0.3)
            : CRUMB;
      blob(f.view, x, y, 0.9, 0.75, angle, c, light, 1, 0.3);
      break;
    }
    case "husk":
      blob(
        f.view,
        x + Math.cos(angle) * 1.5,
        y + Math.sin(angle) * 1.5,
        2.2,
        1.1,
        angle,
        mix(COCOON, [240, 228, 200], 0.4),
        light,
        0.85,
        0.3,
      );
      break;
    case "scrap":
      blob(f.view, x, y, 0.9, 0.7, angle, [70, 58, 48], light, 0.9, 0.2);
      break;
  }
}
