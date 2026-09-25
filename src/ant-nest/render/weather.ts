import type { RGB } from "../../shared/core/color.ts";
import { clamp01, mod, smoothstep } from "../../shared/core/math.ts";
import { hash3, noise1 } from "../../shared/core/random.ts";
import type { World } from "../sim/world.ts";
import { type Frame, sx, sy } from "./frame.ts";

/** Width (mm) of the stretch of the section that holds one set of drops, flakes and fireflies. */
const TILE = 240;
/**
 * Streaks of rain in a stretch at the heaviest rain, flakes of snow in every
 * `FLAKE_FALL` mm of their fall, and fireflies.
 */
const DROPS = 260;
const FLAKES = 220;
const FLAKE_FALL = 420;
const FIREFLIES = 12;
/** Fall speeds (mm/s) of rain and snow, near. */
const RAIN_FALL = 420;
const SNOW_FALL = 26;

const RAIN: RGB = [196, 206, 220];
const SNOW: RGB = [240, 244, 250];

/**
 * Rain and snow over the ground, falling to where the ground meets the cut
 * and splashing there; the snow lying on the ground, cut through along the
 * edge; fireflies over the grass on early summer nights. Every particle's
 * place in the section is a function of time and its index, so dropped
 * frames lose nothing and the weather stays put as the view moves.
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

/**
 * Calls `each` with the index of every stretch of the section `TILE` wide
 * that comes within `margin` mm of the view.
 */
function stretches(f: Frame, margin: number, each: (k: number) => void): void {
  const left = -f.cx - margin;
  const right = f.view.width - f.cx + margin;
  for (let k = Math.floor(left / TILE); k * TILE < right; k++) {
    each(k);
  }
}

function rain(f: Frame, world: World, amount: number, wind: number): void {
  const view = f.view;
  const count = Math.round(DROPS * amount);
  const light = f.lighting;
  const glow = 0.45 + 0.55 * light.daylight;
  // Each drop falls from above the highest the view can show to the ground, then starts again.
  const top = f.extent.top + 20;
  const drift = wind * 90;
  stretches(f, Math.abs(drift) + 20, (k) => {
    for (let i = 0; i < count; i++) {
      const h0 = hash3(i, k, 71);
      const h1 = hash3(i, k, 72);
      const near = 0.45 + 0.55 * hash3(i, k, 73);
      const speed = RAIN_FALL * near;
      const x = (k + h1) * TILE + drift * near * ((f.time * 0.37 + h0) % 1);
      const ground = world.surface.height(x);
      const cycle = (top - ground) / speed + 0.08;
      const t = mod(f.time + h0 * cycle, cycle);
      const y = top - t * speed;
      const col = sx(f, x);
      const groundY = sy(f, ground);
      if (y < ground) {
        // A splash on the ground for a moment.
        const since = (ground - y) / speed;
        if (since < 0.06 && near > 0.6) {
          const a = 0.6 * (1 - since / 0.06);
          for (const dx of [-1, 1]) {
            view.blend(
              col + dx * (1 + since * 30),
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
      const row = sy(f, y);
      if (row < -8 || row > view.height) {
        continue;
      }
      const len = 3 + 4 * near;
      for (let j = 0; j < len; j++) {
        const yy = row - j;
        if (yy > groundY) {
          continue;
        }
        view.blend(
          col - ((drift * near) / speed) * j,
          yy,
          RAIN[0] * glow,
          RAIN[1] * glow,
          RAIN[2] * glow,
          (0.35 + 0.25 * near) * (1 - j / len),
        );
      }
    }
  });
}

function snow(f: Frame, world: World, amount: number, wind: number): void {
  const view = f.view;
  const glow = 0.55 + 0.45 * f.lighting.daylight;
  // Flakes fall from above the highest the view can show to below the lowest the ground lies.
  const top = f.extent.top + 10;
  const fall = top + 30;
  const count = Math.round(((FLAKES * fall) / FLAKE_FALL) * amount);
  stretches(f, 10, (k) => {
    for (let i = 0; i < count; i++) {
      const h0 = hash3(i, k, 81);
      const h1 = hash3(i, k, 82);
      const near = 0.4 + 0.6 * hash3(i, k, 83);
      const speed = SNOW_FALL * (0.5 + near);
      const cycle = fall / speed;
      const t = mod(f.time + h0 * cycle, cycle);
      const y = top - t * speed;
      const sway = Math.sin(f.time * (0.8 + h1) + i) * 4 * near;
      const x = k * TILE + mod(h1 * TILE + wind * 30 * t + sway, TILE);
      if (y < world.surface.height(x)) {
        continue;
      }
      const col = sx(f, x);
      const row = sy(f, y);
      const a = 0.55 + 0.4 * near;
      view.blend(col, row, SNOW[0] * glow, SNOW[1] * glow, SNOW[2] * glow, a);
      if (near > 0.8) {
        view.blend(col + 1, row, SNOW[0] * glow, SNOW[1] * glow, SNOW[2] * glow, a * 0.6);
        view.blend(col, row + 1, SNOW[0] * glow, SNOW[1] * glow, SNOW[2] * glow, a * 0.6);
      }
    }
  });
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
  // Height (mm) of the horizon: the eye's.
  const horizon = f.ground - f.cam.horizon;
  stretches(f, 10, (k) => {
    for (let i = 0; i < count; i++) {
      const h = hash3(i, k, world.seed);
      const n = i + k * FIREFLIES;
      // A slow wander above the grass behind the cut.
      const x = (k + mod(h * 1.7 + noise1(f.time * 0.05 + n * 13.1, 7) * 0.8, 1)) * TILE;
      const y = horizon - 10 + noise1(f.time * 0.07 + n * 5.3, 9) * 70;
      if (y < 2) {
        continue;
      }
      // Each glows up and fades over a couple of seconds, then rests dark.
      const phase = mod(f.time / (2.6 + h * 1.4) + h, 1);
      const blink = phase < 0.35 ? Math.sin((phase / 0.35) * Math.PI) : 0;
      if (blink < 0.05) {
        continue;
      }
      const col = sx(f, x);
      const row = sy(f, y);
      view.glow(col, row, 3.2, [150, 230, 90], 0.9 * blink);
      view.add(col, row, 120 * blink, 200 * blink, 80 * blink);
    }
  });
}
