import { Rng } from "../core/random.ts";
import type { Surface } from "../core/surface.ts";
import type { World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Lighting } from "./lighting.ts";

/** Lateral distances (m) of the particle layers, nearest first. */
const LAYERS = [2.6, 5, 10, 22, 50];
const PER_LAYER = 90;
/** Fall speeds (m/s). */
const RAIN_FALL = 7.5;
const SNOW_FALL = 1.1;
/** Streak exposure (s) for rain. */
const EXPOSURE = 1 / 40;

/**
 * Rain and snow in the air outside, as screen-space particles per depth layer.
 * Their apparent motion combines the fall with our own speed, so snow streams
 * sideways while we run and drifts straight down at a station.
 */
export class Precipitation {
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly phase: Float32Array;
  private width = 1;
  private height = 1;

  constructor(seed: number) {
    const n = LAYERS.length * PER_LAYER;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.phase = new Float32Array(n);
    const r = new Rng(seed ^ 0x5a1f);
    for (let i = 0; i < n; i++) {
      this.x[i] = r.next();
      this.y[i] = r.next();
      this.phase[i] = r.next() * Math.PI * 2;
    }
  }

  resize(width: number, height: number): void {
    width = Math.max(1, width);
    height = Math.max(1, height);
    // Keep each particle at the same relative place in the resized view.
    for (let i = 0; i < this.x.length; i++) {
      this.x[i] = (this.x[i] / this.width) * width;
      this.y[i] = (this.y[i] / this.height) * height;
    }
    this.width = width;
    this.height = height;
  }

  render(
    view: Surface,
    cam: Camera,
    world: World,
    light: Lighting,
    dt: number,
    time: number,
    shelter: number,
  ): void {
    const w = world.weather.state;
    const rain = w.rain * (1 - shelter);
    const snow = w.snow * (1 - shelter);
    if (rain < 0.02 && snow < 0.02) {
      return;
    }
    const speed = world.train.speed;
    const wind = w.wind;
    const W = view.width;
    const H = view.height;
    const lampBoost = light.lamps * 0.25;
    for (let l = 0; l < LAYERS.length; l++) {
      const z = LAYERS[l];
      const s = cam.scale(z);
      const near = 1 - l / LAYERS.length;
      const count = Math.floor(PER_LAYER * Math.max(rain, snow));
      for (let k = 0; k < count; k++) {
        const i = l * PER_LAYER + k;
        const isSnow = snow > rain;
        const fall = isSnow ? SNOW_FALL : RAIN_FALL;
        const sway = isSnow ? Math.sin(time * 1.3 + this.phase[i]) * (0.4 + wind) : 0;
        const vx = (-speed - wind * 3 + sway) * s;
        const vy = fall * s;
        this.x[i] += vx * dt;
        this.y[i] += vy * dt;
        // Wrap around the view, keeping the particle's own random offset.
        if (this.x[i] < -8) {
          this.x[i] += W + 16;
        } else if (this.x[i] > W + 8) {
          this.x[i] -= W + 16;
        }
        if (this.y[i] > H + 4) {
          this.y[i] -= H + 8;
        } else if (this.y[i] < -4) {
          this.y[i] += H + 8;
        }
        const px = this.x[i];
        const py = this.y[i];
        if (isSnow) {
          const b = 150 + 90 * near;
          const r = (b * (light.ambient[0] + lampBoost + 0.25)) | 0;
          const g = (b * (light.ambient[1] + lampBoost + 0.25)) | 0;
          const bl = (b * (light.ambient[2] + lampBoost + 0.3)) | 0;
          // Motion streak for fast flakes.
          const len = Math.min(8, Math.abs(vx) * EXPOSURE);
          const steps = Math.max(1, Math.ceil(len));
          const a = (0.5 + 0.5 * near) / Math.sqrt(steps);
          for (let j = 0; j < steps; j++) {
            view.blend(px - (vx > 0 ? j : -j), py, r, g, bl, a);
          }
          if (l === 0) {
            view.blend(px + 1, py, r, g, bl, a * 0.7);
            view.blend(px, py + 1, r, g, bl, a * 0.7);
          }
        } else {
          const len = Math.hypot(vx, vy) * EXPOSURE;
          const steps = Math.max(1, Math.ceil(len));
          const b = 130 + 70 * near;
          const r = b * (light.ambient[0] * 0.8 + lampBoost + 0.15);
          const g = b * (light.ambient[1] * 0.8 + lampBoost + 0.17);
          const bl = b * (light.ambient[2] * 0.8 + lampBoost + 0.22);
          const a = (0.12 + 0.3 * near) * rain;
          for (let j = 0; j < steps; j++) {
            const t = j / steps;
            view.blend(px - vx * EXPOSURE * t, py - vy * EXPOSURE * t, r, g, bl, a);
          }
        }
      }
    }
  }
}
