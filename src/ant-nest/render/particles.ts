import { mix, type RGB } from "../../shared/core/color.ts";
import { Rng } from "../../shared/core/random.ts";
import type { World } from "../sim/world.ts";
import { type Frame, soilTone, sx, sy } from "./frame.ts";
import { CRUMB } from "./palette.ts";

/** Most particles alive at once; the oldest give way. */
const MAX = 400;
const GRAVITY = 900;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  color: RGB;
  /** Rolls along the ground (the heap) rather than falling through the air. */
  rolls: boolean;
}

/**
 * Small things set moving by what happens in the world: crumbs of soil
 * falling from the face an ant bites at, grains rolling down the heap where
 * a pellet is dropped, a puff where a crumb lands.
 */
export class Particles {
  private readonly list: Particle[] = [];
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0x9a47);
  }

  /** Starts particles for what happened in the world's last update. */
  observe(world: World): void {
    const r = this.rng;
    for (const e of world.events) {
      switch (e.kind) {
        case "bite": {
          const color = soilTone(world.soil.horizon(e.x, e.y));
          for (let k = 0; k < 3; k++) {
            this.push({
              x: e.x + r.range(-1, 1),
              y: e.y + r.range(-1, 1),
              vx: r.range(-8, 8),
              vy: r.range(0, 10),
              age: 0,
              life: r.range(0.25, 0.5),
              color,
              rolls: false,
            });
          }
          break;
        }
        case "dump": {
          const color = soilTone(1 + r.range(-0.3, 0.6));
          for (let k = 0; k < 4; k++) {
            this.push({
              x: e.x,
              y: e.y + 1,
              vx: r.range(-14, 14),
              vy: r.range(4, 14),
              age: 0,
              life: r.range(0.4, 0.9),
              color: mix(color, [0, 0, 0], r.range(0, 0.25)),
              rolls: true,
            });
          }
          break;
        }
        case "pack":
          this.push({
            x: e.x,
            y: e.y,
            vx: r.range(-5, 5),
            vy: 4,
            age: 0,
            life: 0.3,
            color: soilTone(1),
            rolls: false,
          });
          break;
        case "land":
          if (e.item === "crumb") {
            for (let k = 0; k < 3; k++) {
              this.push({
                x: e.x,
                y: e.y + 1,
                vx: r.range(-16, 16),
                vy: r.range(10, 24),
                age: 0,
                life: r.range(0.2, 0.35),
                color: CRUMB,
                rolls: false,
              });
            }
          }
          break;
        default:
          break;
      }
    }
  }

  private push(p: Particle): void {
    if (this.list.length >= MAX) {
      this.list.shift();
    }
    this.list.push(p);
  }

  /** Moves the particles on by `dt` seconds and draws them: in the ground lit by `under`. */
  draw(f: Frame, under: RGB, world: World, dt: number): void {
    const step = Math.min(dt, 1 / 20);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.list.splice(i, 1);
        continue;
      }
      p.vy -= GRAVITY * step;
      p.x += p.vx * step;
      p.y += p.vy * step;
      if (p.rolls) {
        // Down the slope of the heap, slowing as it goes.
        const ground = world.surface.height(p.x);
        if (p.y < ground) {
          p.y = ground;
          p.vy = 0;
          p.vx = p.vx * 0.9 - world.surface.slope(p.x) * 60 * step * 10;
        }
      }
      const fade = 1 - p.age / p.life;
      const light = p.y < world.soil.ground(p.x) ? under : f.light;
      f.view.blend(
        sx(f, p.x),
        sy(f, p.y),
        p.color[0] * light[0],
        p.color[1] * light[1],
        p.color[2] * light[2],
        Math.min(1, fade * 1.5),
      );
    }
  }
}
