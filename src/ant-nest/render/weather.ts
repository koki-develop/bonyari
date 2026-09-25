import type { RGB } from "../../shared/core/color.ts";
import { clamp01, mod, smoothstep } from "../../shared/core/math.ts";
import { hash2, hash3, noise1 } from "../../shared/core/random.ts";
import type { World } from "../sim/world.ts";
import { type Frame, sy } from "./frame.ts";

/** Streaks of rain on screen at the heaviest rain, and flakes of snow. */
const DROPS = 260;
const FLAKES = 220;
/** Fall speeds (px/s) of rain and snow, near. */
const RAIN_FALL = 420;
const SNOW_FALL = 26;
const FIREFLIES = 12;

const RAIN: RGB = [196, 206, 220];
const SNOW: RGB = [240, 244, 250];

/**
 * Rain and snow over the ground, falling to where the ground meets the cut
 * and splashing there; the snow lying on the ground, cut through along the
 * edge; fireflies over the grass on early summer nights. Every particle's
 * place is a function of time and its index, so dropped frames lose nothing.
 */
export function drawWeather(f: Frame, world: World): void {
  const w = world.env.weather.state;
  if (w.rain > 0.02) {
    rain(f, world, w.rain, w.wind);
  }
  if (w.snow > 0.02) {
    snow(f, world, w.snow, w.wind);
  }
  fireflies(f, world);
}

function rain(f: Frame, world: World, amount: number, wind: number): void {
  const view = f.view;
  const count = Math.round(DROPS * amount * (view.width / 240));
  const light = f.lighting;
  const glow = 0.45 + 0.55 * light.daylight;
  const top = -20;
  for (let i = 0; i < count; i++) {
    const h0 = hash2(i, 71);
    const h1 = hash2(i, 72);
    const near = 0.45 + 0.55 * hash2(i, 73);
    const speed = RAIN_FALL * near;
    const x0 = h1 * (view.width + 40) - 20;
    const drift = wind * 90 * near;
    // Each drop falls from above the view to the ground, then starts again.
    const x = x0 + drift * ((f.time * 0.37 + h0) % 1);
    const groundY = sy(f, world.surface.height(x - f.cx));
    const span = groundY - top;
    const cycle = span / speed + 0.08;
    const t = mod(f.time + h0 * cycle, cycle);
    const y = top + t * speed;
    const len = 3 + 4 * near;
    if (y > groundY) {
      // A splash on the ground for a moment.
      const since = (y - groundY) / speed;
      if (since < 0.06 && near > 0.6) {
        const a = 0.6 * (1 - since / 0.06);
        for (const dx of [-1, 1]) {
          view.blend(
            x + dx * (1 + since * 30),
            groundY - 1 - since * 20,
            RAIN[0] * glow,
            RAIN[1] * glow,
            RAIN[2] * glow,
            a,
          );
        }
      }
      continue;
    }
    for (let k = 0; k < len; k++) {
      const yy = y - k;
      if (yy > groundY) {
        continue;
      }
      view.blend(
        x - (drift / speed) * k,
        yy,
        RAIN[0] * glow,
        RAIN[1] * glow,
        RAIN[2] * glow,
        (0.35 + 0.25 * near) * (1 - k / len),
      );
    }
  }
}

function snow(f: Frame, world: World, amount: number, wind: number): void {
  const view = f.view;
  const count = Math.round(FLAKES * amount * (view.width / 240));
  const glow = 0.55 + 0.45 * f.lighting.daylight;
  for (let i = 0; i < count; i++) {
    const h0 = hash2(i, 81);
    const h1 = hash2(i, 82);
    const near = 0.4 + 0.6 * hash2(i, 83);
    const speed = SNOW_FALL * (0.5 + near);
    const span = view.height + 20;
    const cycle = span / speed;
    const t = mod(f.time + h0 * cycle, cycle);
    const y = -10 + t * speed;
    const sway = Math.sin(f.time * (0.8 + h1) + i) * 4 * near;
    const x = mod(h1 * view.width + wind * 30 * t + sway, view.width + 20) - 10;
    const groundY = sy(f, world.surface.height(x - f.cx));
    if (y > groundY) {
      continue;
    }
    const a = 0.55 + 0.4 * near;
    view.blend(x, y, SNOW[0] * glow, SNOW[1] * glow, SNOW[2] * glow, a);
    if (near > 0.8) {
      view.blend(x + 1, y, SNOW[0] * glow, SNOW[1] * glow, SNOW[2] * glow, a * 0.6);
      view.blend(x, y + 1, SNOW[0] * glow, SNOW[1] * glow, SNOW[2] * glow, a * 0.6);
    }
  }
}

/**
 * Snow lying on the ground: a white layer on top of the cut, its surface
 * softly lumped, blue in the shade of its underside.
 */
export function drawSnowCover(f: Frame, world: World): void {
  const cover = world.env.weather.state.snowCover;
  if (cover < 0.03) {
    return;
  }
  const view = f.view;
  const light = f.light;
  const depth = cover * 24;
  for (let col = 0; col < view.width; col++) {
    const x = col - f.cx + 0.5;
    const ground = world.surface.height(x);
    const lump = (noise1(x / 7, world.seed ^ 0x5e0) - 0.5) * 2.4 * cover;
    const top = ground + depth + lump;
    const y0 = Math.floor(sy(f, top));
    const y1 = Math.ceil(sy(f, ground));
    for (let y = y0; y <= y1; y++) {
      const below = (y - y0) / Math.max(1, y1 - y0);
      const k = 1 - 0.18 * below;
      const blue = 0.05 + 0.1 * below;
      const edge = y === y0 ? 1 - (sy(f, top) - y0) : 1;
      view.blend(
        col,
        y,
        238 * k * light[0],
        242 * k * light[1],
        250 * (k + blue) * light[2],
        clamp01(edge),
      );
    }
  }
}

/** Fireflies drifting over the grass on warm, still, dark early-summer nights, blinking slowly. */
function fireflies(f: Frame, world: World): void {
  const env = world.env;
  const w = env.weather.state;
  const amount =
    env.season.fireflies *
    smoothstep(-2, -9, env.sky.sunAltitude) *
    (1 - smoothstep(0.02, 0.15, w.rain)) *
    (1 - smoothstep(0.3, 0.6, w.wind));
  if (amount < 0.02) {
    return;
  }
  const view = f.view;
  const count = Math.round(FIREFLIES * amount);
  for (let i = 0; i < count; i++) {
    const h = hash3(i, 91, world.seed);
    // A slow wander above the grass behind the cut.
    const x = mod(h * 1.7 + noise1(f.time * 0.05 + i * 13.1, 7) * 0.8, 1) * view.width;
    const y = f.cam.horizon + 10 - noise1(f.time * 0.07 + i * 5.3, 9) * 70;
    if (y > f.ground - 2) {
      continue;
    }
    // Each glows up and fades over a couple of seconds, then rests dark.
    const phase = mod(f.time / (2.6 + h * 1.4) + h, 1);
    const blink = phase < 0.35 ? Math.sin((phase / 0.35) * Math.PI) : 0;
    if (blink < 0.05) {
      continue;
    }
    view.glow(x, y, 3.2, [150, 230, 90], 0.9 * blink);
    view.add(x, y, 120 * blink, 200 * blink, 80 * blink);
  }
}
