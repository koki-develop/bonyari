import { pack, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../shared/core/math.ts";
import { noise2, Rng } from "../../shared/core/random.ts";
import type { Surface } from "../../shared/core/surface.ts";
import type { Rect } from "./layout.ts";

interface Drop {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  sliding: boolean;
  /** Seconds left before it dries (only counts down once the rain stops). */
  life: number;
  /** Distance slid since the last trail droplet. */
  trail: number;
}

interface Flake {
  x: number;
  y: number;
  age: number;
  life: number;
}

const MAX_DROPS = 420;
const MAX_FLAKES = 160;

export interface GlassConditions {
  /** Train speed (m/s); airflow pushes drops toward the rear (screen left). */
  speed: number;
  rain: number;
  snow: number;
  /** 0..1 tendency of the inner surface to fog up. */
  condensation: number;
}

/**
 * The window pane: raindrops and snowflakes on the outside, condensation on
 * the inside.
 */
export class Glass {
  private width = 0;
  private height = 0;
  private fog = new Float32Array(0);
  private pattern = new Float32Array(0);
  private blur = new Uint32Array(0);
  private blurR = new Float32Array(0);
  private blurG = new Float32Array(0);
  private blurB = new Float32Array(0);
  private fogMax = 0;
  private readonly drops: Drop[] = [];
  private readonly flakes: Flake[] = [];
  private readonly rng: Rng;
  private readonly seed: number;
  /** Snow piled on the outside of the sill, in pixels. */
  sillSnow = 0;

  constructor(seed: number) {
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x61a55);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = width;
    this.height = height;
    this.fog = new Float32Array(width * height);
    this.blur = new Uint32Array(width * height);
    this.blurR = new Float32Array(width * height);
    this.blurG = new Float32Array(width * height);
    this.blurB = new Float32Array(width * height);
    this.pattern = new Float32Array(width * height);
    const min = Math.min(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Condensation creeps in from the edges and corners of the pane.
        const edge = Math.min(x, width - 1 - x, y * 1.4, (height - 1 - y) * 0.8) / (min * 0.5);
        const organic =
          noise2(x / 9, y / 9, this.seed ^ 0xf06) * 0.6 +
          noise2(x / 3.5, y / 3.5, this.seed ^ 0xf07) * 0.4;
        this.pattern[y * width + x] = clamp01(
          (1 - smoothstep(0, 0.75, edge)) * 0.85 + 0.15 + (organic - 0.5) * 0.5,
        );
      }
    }
    this.drops.length = 0;
    this.flakes.length = 0;
  }

  update(dt: number, c: GlassConditions): void {
    this.updateFog(dt, c.condensation);
    this.updateDrops(dt, c);
    this.updateFlakes(dt, c);
    const target = c.snow > 0.2 ? 1 + c.snow * 3 : 0;
    this.sillSnow +=
      (target - this.sillSnow) * Math.min(1, dt / (target > this.sillSnow ? 30 : 90));
  }

  private updateFog(dt: number, condensation: number): void {
    if (this.fogMax < 0.004 && condensation < 0.004) {
      return;
    }
    const grow = Math.min(1, dt / 55);
    const clear = Math.min(1, dt / 16);
    let max = 0;
    const fog = this.fog;
    const pattern = this.pattern;
    for (let i = 0; i < fog.length; i++) {
      const target = condensation * pattern[i];
      const f = fog[i];
      const next = f + (target - f) * (f > target ? clear : grow);
      fog[i] = next;
      if (next > max) {
        max = next;
      }
    }
    this.fogMax = max;
  }

  private updateDrops(dt: number, c: GlassConditions): void {
    const r = this.rng;
    // New drops land in proportion to the rain; more when we're moving.
    const rate = c.rain * (40 + c.speed * 3.2);
    let spawn = rate * dt;
    while (spawn > 0 && this.drops.length < MAX_DROPS) {
      if (spawn < 1 && !r.chance(spawn)) {
        break;
      }
      spawn -= 1;
      this.drops.push({
        x: r.next() * this.width,
        y: r.next() * this.height,
        r: 0.35 + Math.pow(r.next(), 3) * 1.4,
        vx: 0,
        vy: 0,
        sliding: false,
        life: r.range(25, 70),
        trail: 0,
      });
    }
    const push = c.speed / 25;
    for (const d of this.drops) {
      if (c.rain < 0.02) {
        d.life -= dt;
      }
      // Big drops start to run: backward in the airflow and down with gravity.
      const heavy = d.r > 0.95 - push * 0.35;
      if (!d.sliding && heavy && r.chance(dt * (0.6 + push * 2))) {
        d.sliding = true;
      }
      if (d.sliding) {
        const tvx = -push * 38 * d.r;
        const tvy = (5 + d.r * 6) * (1 - push * 0.45);
        d.vx += (tvx - d.vx) * Math.min(1, dt * 4);
        d.vy += (tvy - d.vy) * Math.min(1, dt * 4);
        const dx = d.vx * dt;
        const dy = d.vy * dt;
        d.x += dx;
        d.y += dy;
        d.trail += Math.hypot(dx, dy);
        if (d.trail > 2.5) {
          d.trail = 0;
          d.r *= 0.985;
          if (r.chance(0.45) && this.drops.length < MAX_DROPS) {
            this.drops.push({
              x: d.x - dx,
              y: d.y - dy,
              r: 0.35,
              vx: 0,
              vy: 0,
              sliding: false,
              life: r.range(10, 30),
              trail: 0,
            });
          }
        }
        if (d.r < 0.6) {
          d.sliding = false;
          d.vx = 0;
          d.vy = 0;
        }
      }
    }
    // Running drops swallow the droplets in their path.
    for (const d of this.drops) {
      if (!d.sliding) {
        continue;
      }
      for (const o of this.drops) {
        if (
          o !== d &&
          !o.sliding &&
          o.life > 0 &&
          Math.abs(o.x - d.x) < d.r + 0.6 &&
          Math.abs(o.y - d.y) < d.r + 0.6
        ) {
          d.r = Math.min(2.4, Math.hypot(d.r, o.r * 0.8));
          o.life = 0;
        }
      }
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if (d.life <= 0 || d.x < -3 || d.y > this.height + 3) {
        this.drops.splice(i, 1);
      }
    }
  }

  private updateFlakes(dt: number, c: GlassConditions): void {
    const r = this.rng;
    let spawn = c.snow * (8 + c.speed * 1.4) * dt;
    while (spawn > 0 && this.flakes.length < MAX_FLAKES) {
      if (spawn < 1 && !r.chance(spawn)) {
        break;
      }
      spawn -= 1;
      this.flakes.push({
        x: r.next() * this.width,
        y: r.next() * this.height,
        age: 0,
        life: r.range(3, 7),
      });
    }
    for (let i = this.flakes.length - 1; i >= 0; i--) {
      const f = this.flakes[i];
      f.age += dt;
      if (f.age >= f.life) {
        // A melted flake leaves a droplet behind.
        if (this.drops.length < MAX_DROPS) {
          this.drops.push({
            x: f.x,
            y: f.y,
            r: 0.45,
            vx: 0,
            vy: 0,
            sliding: false,
            life: r.range(8, 20),
            trail: 0,
          });
        }
        this.flakes.splice(i, 1);
      }
    }
  }

  private computeBlur(view: Surface, jolt: number, sway: number): void {
    const w = this.width;
    const h = this.height;
    const radius = 2;
    const tmpR = this.blurR;
    const tmpG = this.blurG;
    const tmpB = this.blurB;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let k = -radius; k <= radius; k++) {
          const c = view.get(x + k - sway, y - jolt);
          r += c & 255;
          g += (c >>> 8) & 255;
          b += (c >>> 16) & 255;
        }
        const i = y * w + x;
        tmpR[i] = r;
        tmpG[i] = g;
        tmpB[i] = b;
      }
    }
    const n = (radius * 2 + 1) ** 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.max(0, Math.min(h - 1, y + k));
          const i = yy * w + x;
          r += tmpR[i];
          g += tmpG[i];
          b += tmpB[i];
        }
        this.blur[y * w + x] = pack(r / n, g / n, b / n);
      }
    }
  }

  /**
   * Draws the view through the glass into `screen` at `rect`.
   * @param jolt vertical shake of the view (pixels)
   * @param sway sideways shift of the view as the car sways (pixels)
   * @param fogTint light scattered by the condensation (interior and outside light)
   */
  composite(
    screen: Surface,
    view: Surface,
    rect: Rect,
    jolt: number,
    sway: number,
    fogTint: RGB,
  ): void {
    const w = this.width;
    const h = this.height;
    const hasFog = this.fogMax > 0.01;
    if (hasFog) {
      this.computeBlur(view, jolt, sway);
    }
    const fog = this.fog;
    const out = screen.data;
    const src = view.data;
    const [tr, tg, tb] = fogTint;
    // The glass lies wholly on screen; each row is the view shifted by the
    // car's sway, copied as is where the glass is clear.
    const x0 = Math.max(0, -rect.x);
    const x1 = Math.min(w, screen.width - rect.x);
    for (let y = 0; y < h; y++) {
      const sy = rect.y + y;
      if (sy < 0 || sy >= screen.height) {
        continue;
      }
      const vy = Math.max(0, Math.min(h - 1, y - jolt));
      const srcRow = vy * w;
      const dstRow = sy * screen.width + rect.x;
      // Columns [a, b) read the view at x - sway without clamping.
      const a = Math.max(x0, sway);
      const b = Math.min(x1, w + sway);
      if (b > a) {
        out.set(src.subarray(srcRow + a - sway, srcRow + b - sway), dstRow + a);
      }
      for (let x = x0; x < a; x++) {
        out[dstRow + x] = src[srcRow];
      }
      for (let x = Math.max(b, x0); x < x1; x++) {
        out[dstRow + x] = src[srcRow + w - 1];
      }
      if (!hasFog) {
        continue;
      }
      const row = y * w;
      for (let x = x0; x < x1; x++) {
        const f = fog[row + x];
        if (f <= 0.01) {
          continue;
        }
        const c = out[dstRow + x];
        const bc = this.blur[row + x];
        const k = Math.min(0.94, f);
        const r = c & 255;
        const g = (c >>> 8) & 255;
        const bl = (c >>> 16) & 255;
        out[dstRow + x] = pack(
          r + ((bc & 255) * 0.75 + tr - r) * k,
          g + (((bc >>> 8) & 255) * 0.75 + tg - g) * k,
          bl + (((bc >>> 16) & 255) * 0.75 + tb - bl) * k,
        );
      }
    }
    this.drawDrops(screen, view, rect, jolt);
  }

  private drawDrops(screen: Surface, view: Surface, rect: Rect, jolt: number): void {
    const w = this.width;
    const h = this.height;
    for (const d of this.drops) {
      const fog = this.fogAt(d.x, d.y);
      const alpha = 1 - fog * 0.85;
      if (d.r < 0.8) {
        // A droplet: a speck of slightly brighter, refracted light.
        const c = view.get(d.x, d.y - jolt - 2);
        screen.blend(
          rect.x + d.x,
          rect.y + d.y,
          (c & 255) * 1.15 + 12,
          ((c >>> 8) & 255) * 1.15 + 12,
          ((c >>> 16) & 255) * 1.15 + 14,
          alpha * 0.6,
        );
        continue;
      }
      const rr = d.r;
      for (let y = Math.floor(d.y - rr); y <= Math.ceil(d.y + rr); y++) {
        for (let x = Math.floor(d.x - rr); x <= Math.ceil(d.x + rr); x++) {
          const dx = x + 0.5 - d.x;
          const dy = y + 0.5 - d.y;
          const dist = Math.hypot(dx, dy);
          if (dist > rr || x < 0 || y < 0 || x >= w || y >= h) {
            continue;
          }
          // A tiny lens: the world upside down and squeezed.
          const c = view.get(d.x - dx * 2.5, d.y - dy * 2.5 - jolt - 3);
          const rim = dist > rr - 0.7 ? 0.7 : 1.1;
          screen.blend(
            rect.x + x,
            rect.y + y,
            (c & 255) * rim + 8,
            ((c >>> 8) & 255) * rim + 8,
            ((c >>> 16) & 255) * rim + 10,
            alpha * 0.9,
          );
        }
      }
      screen.blend(rect.x + d.x - rr * 0.4, rect.y + d.y - rr * 0.5, 255, 255, 255, alpha * 0.45);
    }
    for (const f of this.flakes) {
      const a = (1 - f.age / f.life) * 0.85;
      screen.blend(rect.x + f.x, rect.y + f.y, 240, 244, 250, a);
      if (f.age < f.life * 0.4) {
        screen.blend(rect.x + f.x + 1, rect.y + f.y, 240, 244, 250, a * 0.5);
        screen.blend(rect.x + f.x, rect.y + f.y + 1, 240, 244, 250, a * 0.5);
      }
    }
  }

  private fogAt(x: number, y: number): number {
    const xi = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
    const yi = Math.max(0, Math.min(this.height - 1, Math.floor(y)));
    return this.fog[yi * this.width + xi] ?? 0;
  }
}
