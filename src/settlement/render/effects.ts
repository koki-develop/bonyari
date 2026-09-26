import { mix, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../shared/core/math.ts";
import { hash2, hash3, Rng } from "../../shared/core/random.ts";
import { type Building, KINDS } from "../sim/buildings.ts";
import { bonfireSpot, FESTIVAL_TO, festivalDay, festive, garlandsUp } from "../sim/festival.ts";
import { rectPoint } from "../sim/geometry.ts";
import { BREATH, breathLanding } from "../sim/raids.ts";
import type { World } from "../sim/world.ts";
import { carriesLight, type FrameInfo, garlandPoles } from "./actors.ts";
import { gyOf, S } from "./projection.ts";
import { dragonBody } from "./dragon.ts";
import { chimneyOf } from "./structures.ts";

type Kind = "smoke" | "flame" | "ember" | "spark" | "dust" | "splash" | "magic" | "breath";

interface Particle {
  kind: Kind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
}

/** A light that moves or flickers: a fire, a torch, the dragon's breath. */
export interface Light {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  /** Meters its light reaches. */
  reach: number;
}

/** Most particles kept at once. */
const MOST = 2600;
/** Fire the dragon breathes: particles a second, and seconds each lasts at most if it never comes down. */
const BREATH_RATE = 300;
const BREATH_LIFE = 4;
const FIRE: RGB = [255, 150, 60];
const TORCH: RGB = [255, 170, 90];
const LANTERN: RGB = [255, 196, 120];

/**
 * Fire and smoke and everything else that drifts, flickers and fades:
 * spawned from the world's fires, chimneys and doings each frame, moved,
 * and drawn over the frame behind whatever stands nearer. Also the moving
 * lights they give, gathered for the frame.
 */
export class Effects {
  private readonly particles: Particle[] = [];
  private readonly rng = new Rng(0x5eed);
  readonly lights: Light[] = [];

  /** Spawns and moves particles for `dt` seconds of the world as it is now. */
  update(world: World, dt: number, time: number): void {
    const r = this.rng;
    const wind = world.env.weather.state.wind;
    const windX = (0.6 + wind * 2.4) * 0.7;
    const windY = (0.6 + wind * 2.4) * 0.3;
    this.lights.length = 0;
    const h = world.env.clock.hour;
    const cooking =
      smoothstep(5, 6.5, h) * (1 - smoothstep(8, 9.5, h)) +
      smoothstep(16.5, 17.5, h) * (1 - smoothstep(20, 21.5, h));
    const cold = 1 - world.season.warmth;
    for (const b of world.town.buildings) {
      if (b.fire > 0.02) {
        this.burning(b, dt, time);
      }
      // A thread of smoke from the chimney of a house with its fire lit.
      if (b.phase === "standing" && b.fire <= 0.02) {
        const c = chimneyOf(b);
        if (!c) {
          continue;
        }
        const lit =
          b.kind === "smithy" || b.kind === "bakery"
            ? 0.9
            : KINDS[b.kind].housing > 0
              ? Math.max(b.lamps > 0.15 ? 0.6 : 0, cooking, cold * 0.5)
              : 0;
        if (lit > 0.05 && r.chance(dt * 2.2 * lit)) {
          this.add(
            "smoke",
            c.x,
            c.y,
            c.z,
            windX * 0.3,
            windY * 0.3,
            0.9,
            r.range(2.5, 4.5),
            r.range(0.6, 1),
          );
        }
      }
    }
    for (const q of world.piles) {
      if (q.kind === "brush") {
        const k = clamp01(q.burn / 30);
        const z = world.groundAt(q.x, q.y);
        if (r.chance(dt * 14 * k)) {
          this.add(
            "flame",
            q.x + r.range(-0.6, 0.6),
            q.y + r.range(-0.4, 0.4),
            z + 0.3,
            0,
            0,
            1.5,
            r.range(0.4, 0.8),
            1,
          );
        }
        if (r.chance(dt * 5 * k)) {
          this.add(
            "smoke",
            q.x,
            q.y,
            z + 1,
            windX * 0.4,
            windY * 0.4,
            1.1,
            r.range(3, 5),
            r.range(0.8, 1.3),
          );
        }
        this.lights.push({
          x: q.x,
          y: q.y,
          z: z + 1,
          ...rgb(FIRE, 0.7 * k * flicker(time, q.id)),
          reach: 6,
        });
      }
    }
    const camp = world.town.buildings.find((b) => b.kind === "camp");
    if (camp) {
      const p = rectPoint(camp.rect, 1.9, -2.2);
      const z = camp.base + 0.1;
      if (r.chance(dt * 8)) {
        this.add(
          "flame",
          p.x + r.range(-0.3, 0.3),
          p.y + r.range(-0.2, 0.2),
          z + 0.15,
          0,
          0,
          1.2,
          r.range(0.3, 0.6),
          1,
        );
      }
      if (r.chance(dt * 2)) {
        this.add("smoke", p.x, p.y, z + 0.6, windX * 0.3, windY * 0.3, 0.8, r.range(2.5, 4), 0.7);
      }
      this.lights.push({
        x: p.x,
        y: p.y,
        z: z + 0.6,
        ...rgb(FIRE, 0.8 * flicker(time, 3)),
        reach: 7,
      });
    }
    // The harvest fire on the square, and the glow of the lanterns strung round it.
    if (festivalDay(world)) {
      const fire = bonfireSpot(world.plan);
      const z = world.groundAt(fire.x, fire.y);
      const blaze = festive(world)
        ? 1
        : h >= FESTIVAL_TO && h < FESTIVAL_TO + 1
          ? 0.25 * (FESTIVAL_TO + 1 - h)
          : 0;
      if (blaze > 0) {
        for (let n = dt * 70 * blaze; n > 0; n--) {
          if (n < 1 && !r.chance(n)) {
            break;
          }
          // Tongues of flame, broad at the foot of the pile and thinning as they rise.
          const spread = r.range(0, 0.8);
          const a = r.range(0, Math.PI * 2);
          this.add(
            "flame",
            fire.x + Math.cos(a) * spread,
            fire.y + Math.sin(a) * spread * 0.7,
            z + r.range(0.1, 0.6),
            r.range(-0.15, 0.15),
            r.range(-0.15, 0.15),
            r.range(1.2, 2.6) * blaze,
            r.range(0.35, 0.8),
            r.range(1.6, 2.6) * (1.2 - spread * 0.5) * blaze,
          );
        }
        if (r.chance(dt * 5 * blaze)) {
          this.add(
            "ember",
            fire.x,
            fire.y,
            z + 2,
            r.range(-0.6, 0.6),
            r.range(-0.6, 0.6),
            r.range(2, 4.5),
            r.range(1.5, 3),
            1,
          );
        }
        if (r.chance(dt * 3)) {
          this.add(
            "smoke",
            fire.x,
            fire.y,
            z + 2.5,
            windX * 0.4,
            windY * 0.4,
            1.3,
            r.range(3, 5),
            r.range(1, 1.6) * blaze,
          );
        }
        this.lights.push({
          x: fire.x,
          y: fire.y,
          z: z + 1.5,
          ...rgb(FIRE, 1.3 * blaze * flicker(time, 11)),
          reach: 13 * Math.sqrt(blaze),
        });
      }
      if (garlandsUp(world) && world.env.darkness > 0.2) {
        for (const pole of garlandPoles(world.plan)) {
          this.lights.push({
            x: pole.x,
            y: pole.y,
            z: world.groundAt(pole.x, pole.y) + 3,
            ...rgb(LANTERN, 0.35 * world.env.darkness),
            reach: 3.5,
          });
        }
      }
    }
    // Torches carried by people and raiders, and the lanterns of those out after dark.
    for (const p of world.people) {
      if (p.inside < 0 && (p.carry === "torch" || carriesLight(world, p))) {
        this.lights.push({
          x: p.x,
          y: p.y,
          z: p.z + 1.8,
          ...rgb(TORCH, 0.55 * flicker(time, p.id)),
          reach: 4.5,
        });
      }
    }
    for (const m of world.monsters) {
      // Dust kicked up by running feet: raiders are seen coming by the dust they raise.
      const running = m.pose === "run" || (m.kind === "ogre" && m.pose === "walk");
      if (
        running &&
        world.env.weather.state.wetness < 0.5 &&
        r.chance(dt * (m.kind === "ogre" ? 9 : 5))
      ) {
        this.add(
          "dust",
          m.x + r.range(-0.4, 0.4),
          m.y + r.range(-0.3, 0.3),
          m.z + 0.1,
          r.range(-0.4, 0.4),
          r.range(-0.3, 0.3),
          r.range(0.3, 0.8),
          r.range(0.8, 1.6),
          m.kind === "ogre" ? 1.4 : 0.9,
        );
      }
      if (m.torch) {
        this.lights.push({
          x: m.x,
          y: m.y,
          z: m.z + 1.4,
          ...rgb(TORCH, 0.6 * flicker(time, m.id)),
          reach: 4.5,
        });
        if (r.chance(dt * 3)) {
          this.add(
            "ember",
            m.x,
            m.y,
            m.z + 1.6,
            r.range(-0.3, 0.3),
            r.range(-0.3, 0.3),
            1.2,
            r.range(0.4, 0.8),
            1,
          );
        }
      }
    }
    for (const s of world.missiles) {
      if (s.kind === "torch" || s.kind === "bolt") {
        this.lights.push({
          x: s.x,
          y: s.y,
          z: s.z,
          ...rgb(s.kind === "torch" ? TORCH : [170, 130, 255], 0.6),
          reach: 4,
        });
      }
    }
    const d = world.dragon;
    if (d && d.breathing) {
      // Out of its open jaws, carried on with its own flight, forward and down onto what lies ahead.
      const { mouth, hx, hy } = dragonBody(d);
      for (let k = 0; k < dt * BREATH_RATE; k++) {
        const speed = d.speed + BREATH.speed + r.range(-2, 2);
        const side = r.range(-1.2, 1.2);
        this.add(
          "breath",
          mouth.x + r.range(-0.3, 0.3),
          mouth.y + r.range(-0.3, 0.3),
          mouth.z,
          hx * speed - hy * side,
          hy * speed + hx * side,
          d.climb - BREATH.drop + r.range(-1.5, 1.5),
          BREATH_LIFE,
          1,
        );
      }
      this.lights.push({
        x: mouth.x + hx * 3,
        y: mouth.y + hy * 3,
        z: mouth.z - 2,
        ...rgb(FIRE, 1.2),
        reach: 14,
      });
      // And where it comes down.
      const land = breathLanding(world, d);
      this.lights.push({
        x: land.x,
        y: land.y,
        z: world.groundAt(land.x, land.y) + 2,
        ...rgb(FIRE, 1.4),
        reach: 16,
      });
    }
    // Things that happened: a tree coming down, a house falling in, a blow landing, a spell.
    for (const e of world.events) {
      switch (e.kind) {
        case "treefall":
          for (let k = 0; k < 10; k++) {
            this.add(
              "dust",
              e.x + r.range(-2, 2),
              e.y + r.range(-1.5, 1.5),
              e.z,
              r.range(-0.5, 0.5),
              r.range(-0.3, 0.3),
              r.range(0.3, 0.8),
              r.range(1, 2),
              r.range(0.5, 1),
            );
          }
          break;
        case "collapse":
          for (let k = 0; k < 30; k++) {
            this.add(
              "dust",
              e.x + r.range(-4, 4),
              e.y + r.range(-3, 3),
              e.z,
              r.range(-1, 1),
              r.range(-0.6, 0.6),
              r.range(0.5, 1.8),
              r.range(2, 4),
              r.range(0.8, 1.6),
            );
            this.add(
              "ember",
              e.x + r.range(-3, 3),
              e.y + r.range(-2, 2),
              e.z + 1,
              r.range(-1, 1),
              r.range(-1, 1),
              r.range(2, 5),
              r.range(0.8, 1.6),
              1,
            );
          }
          break;
        case "hit":
          for (let k = 0; k < 4; k++) {
            this.add(
              "spark",
              e.x,
              e.y,
              e.z,
              r.range(-1.5, 1.5),
              r.range(-1, 1),
              r.range(0.5, 2),
              r.range(0.2, 0.4),
              1,
            );
          }
          break;
        case "anvil":
          for (let k = 0; k < 3; k++) {
            this.add(
              "spark",
              e.x,
              e.y,
              e.z - 0.2,
              r.range(-1.2, 1.2),
              r.range(-1.2, 1.2),
              r.range(0.6, 2.2),
              r.range(0.2, 0.45),
              1,
            );
          }
          this.lights.push({ x: e.x, y: e.y, z: e.z, ...rgb(FIRE, 0.35), reach: 3 });
          break;
        case "magic":
          for (let k = 0; k < 14; k++) {
            this.add(
              "magic",
              e.x + r.range(-0.5, 0.5),
              e.y + r.range(-0.5, 0.5),
              e.z + 1.2,
              r.range(-0.8, 0.8),
              r.range(-0.8, 0.8),
              r.range(0.5, 2.5),
              r.range(0.8, 1.8),
              1,
            );
          }
          break;
        case "splash":
          for (let k = 0; k < 6; k++) {
            this.add(
              "splash",
              e.x,
              e.y,
              e.z + 1,
              r.range(-1.5, 1.5),
              r.range(-1, 1),
              r.range(1, 3),
              r.range(0.3, 0.6),
              1,
            );
          }
          break;
      }
    }
    // The wizard's tower glimmers at its top by night.
    const tower = world.town.buildings.find((b) => b.kind === "wizard" && b.phase === "standing");
    if (tower && world.env.darkness > 0.3 && r.chance(dt * 1.5)) {
      this.add(
        "magic",
        tower.rect.x + r.range(-2, 2),
        tower.rect.y + r.range(-2, 2),
        tower.base + r.range(14, 24),
        r.range(-0.2, 0.2),
        r.range(-0.2, 0.2),
        r.range(-0.2, 0.4),
        r.range(1.5, 3),
        1,
      );
    }
    this.move(world, dt, windX, windY);
  }

  /** Flames along a burning building's roof, thick smoke above, embers, and its light. */
  private burning(b: Building, dt: number, time: number): void {
    const r = this.rng;
    const k = b.fire;
    const top = b.base + (b.phase === "ruin" ? 1 : KINDS[b.kind].housing > 0 ? 5 : 4);
    const w = b.rect.width;
    const d = b.rect.depth;
    for (let n = dt * 40 * k; n > 0; n--) {
      if (n < 1 && !r.chance(n)) {
        break;
      }
      const p = rectPoint(b.rect, r.range(-w / 2, w / 2), r.range(-d / 2, d / 2));
      this.add(
        "flame",
        p.x,
        p.y,
        top - r.range(0, 2),
        r.range(-0.3, 0.3),
        r.range(-0.3, 0.3),
        r.range(1.5, 3.5),
        r.range(0.4, 0.9),
        r.range(0.8, 1.6),
      );
    }
    if (r.chance(dt * 9 * k)) {
      const p = rectPoint(b.rect, r.range(-w / 3, w / 3), r.range(-d / 3, d / 3));
      this.add(
        "smoke",
        p.x,
        p.y,
        top + 1,
        r.range(-0.3, 0.3),
        r.range(-0.3, 0.3),
        1.6,
        r.range(4, 7),
        r.range(1.4, 2.4),
      );
    }
    if (r.chance(dt * 6 * k)) {
      this.add(
        "ember",
        b.rect.x + r.range(-w / 2, w / 2),
        b.rect.y + r.range(-d / 2, d / 2),
        top + 1,
        r.range(-1, 1),
        r.range(-1, 1),
        r.range(2, 5),
        r.range(1, 2.5),
        1,
      );
    }
    this.lights.push({
      x: b.rect.x,
      y: b.rect.y,
      z: top,
      ...rgb(FIRE, (0.6 + 0.9 * k) * flicker(time, b.id)),
      reach: 8 + 8 * k,
    });
  }

  private add(
    kind: Kind,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
  ): void {
    if (this.particles.length >= MOST) {
      return;
    }
    this.particles.push({ kind, x, y, z, vx, vy, vz, age: 0, life, size });
  }

  private move(world: World, dt: number, windX: number, windY: number): void {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      switch (p.kind) {
        case "smoke":
          // Rising, slowing, spreading and drifting with the wind.
          p.vx += (windX - p.vx) * dt * 0.5;
          p.vy += (windY - p.vy) * dt * 0.5;
          p.vz *= 1 - dt * 0.15;
          break;
        case "ember":
        case "spark":
        case "splash":
          p.vz -= (p.kind === "ember" ? 1.5 : 9.8) * dt;
          p.vx += (windX - p.vx) * dt * (p.kind === "ember" ? 0.8 : 0);
          break;
        case "breath": {
          p.vz -= BREATH.fall * dt;
          const ground = world.groundAt(p.x, p.y);
          if (p.z < ground + 0.3) {
            // Splashing along the ground, and soon out.
            p.z = ground + 0.3;
            p.vz = 1.5;
            p.vx *= 0.3;
            p.vy *= 0.3;
            p.life = Math.min(p.life, p.age + this.rng.range(0.25, 0.6));
          }
          break;
        }
        case "dust":
          p.vx *= 1 - dt * 1.5;
          p.vy *= 1 - dt * 1.5;
          p.vz *= 1 - dt;
          break;
        case "flame":
        case "magic":
          break;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
  }

  /** Draws the particles into the frame. */
  draw(f: FrameInfo, world: World, time: number): void {
    const view = f.view;
    // The harvest fire: a white-hot heart and a body of flame swaying over the pile.
    if (festive(world)) {
      const fire = bonfireSpot(world.plan);
      const z = world.groundAt(fire.x, fire.y);
      const cx = fire.x / S - f.fx;
      const base = gyOf(fire.y, z + 0.3) - f.fy;
      view.glow(cx, base, 6, [255, 170, 80], 0.55 * flicker(time, 11));
      const tall = 8 + 2 * Math.sin(time * 5.3) + Math.sin(time * 13.1);
      for (let j = 0; j < tall; j++) {
        const up = j / tall;
        const half = 3.2 * (1 - up ** 1.4) * (0.85 + 0.15 * Math.sin(time * 11 + j * 1.7));
        const sway = Math.sin(time * 6.1 + j * 0.6) * up * 1.4;
        const y = Math.round(base - j);
        for (let i = Math.round(-half); i <= Math.round(half); i++) {
          const x = Math.round(cx + sway + i);
          if (x < 0 || y < 0 || x >= view.width || y >= view.height) {
            continue;
          }
          const edge = Math.abs(i) / (half + 0.5);
          const heat = clamp01(1 - edge * 0.8 - up * 0.7);
          const c = mix(
            mix([200, 50, 20], [255, 140, 40], clamp01(heat * 1.6)),
            [255, 240, 170],
            clamp01(heat * 1.8 - 0.8),
          );
          view.blend(x, y, c[0], c[1], c[2], 0.95 - up * 0.35);
        }
      }
    }
    const light = f.shader.lightAt(world.plan.center.x, world.plan.center.y, 0, [0, 0, 0]);
    // Far first.
    this.particles.sort((a, b) => b.y - a.y);
    for (const p of this.particles) {
      const sx = p.x / S - f.fx;
      const sy = gyOf(p.y, p.z) - f.fy;
      if (sx < -10 || sy < -10 || sx >= view.width + 10 || sy >= view.height + 10) {
        continue;
      }
      const t = p.age / p.life;
      const ix = Math.round(sx);
      const iy = Math.round(sy);
      const hidden = (x: number, y: number) =>
        x < 0 ||
        y < 0 ||
        x >= view.width ||
        y >= view.height ||
        p.z < f.z[y * view.width + x] - 0.4;
      switch (p.kind) {
        case "smoke": {
          const rad = (p.size * (0.4 + t * 1.2)) / S / 2.2;
          const a = (1 - t) * 0.32 * smoothstep(0, 0.08, t);
          const grey = mix([150, 146, 142], [70, 66, 64], clamp01(p.size / 6));
          const c: RGB = [
            grey[0] * (light[0] * 0.8 + 0.1),
            grey[1] * (light[1] * 0.8 + 0.1),
            grey[2] * (light[2] * 0.8 + 0.12),
          ];
          const rr = Math.ceil(rad);
          for (let j = -rr; j <= rr; j++) {
            for (let i = -rr; i <= rr; i++) {
              const e = (i * i + j * j) / (rad * rad + 0.01);
              if (e > 1 || hidden(ix + i, iy + j)) {
                continue;
              }
              view.blend(ix + i, iy + j, c[0], c[1], c[2], a * (1 - e * 0.6));
            }
          }
          break;
        }
        case "flame":
        case "breath": {
          // The breath cools as it flies, however soon it comes down.
          const heat = p.kind === "breath" ? 1 - Math.min(1, p.age / 2) : 1 - t;
          const c = mix([255, 90, 30], [255, 230, 140], heat * heat);
          const size = p.kind === "breath" ? 2 : Math.max(1, Math.round(p.size * (1 - t) * 1.5));
          for (let j = 0; j < size; j++) {
            for (let i = 0; i < Math.max(1, size - 1); i++) {
              if (!hidden(ix + i, iy - j)) {
                view.blend(ix + i, iy - j, c[0], c[1], c[2], 0.85 * heat + 0.15);
              }
            }
          }
          break;
        }
        case "ember":
        case "spark":
          if (!hidden(ix, iy)) {
            const a = 1 - t;
            view.add(ix, iy, 255 * a, (p.kind === "spark" ? 220 : 140) * a, 60 * a);
          }
          break;
        case "magic":
          if (!hidden(ix, iy)) {
            const tw = 0.5 + 0.5 * Math.sin(time * 20 + p.x * 13);
            view.add(ix, iy, 190 * tw * (1 - t), 160 * tw * (1 - t), 255 * tw * (1 - t));
          }
          break;
        case "dust":
          if (!hidden(ix, iy)) {
            view.blend(ix, iy, 150 * light[0], 132 * light[1], 110 * light[2], 0.5 * (1 - t));
            view.blend(ix + 1, iy, 150 * light[0], 132 * light[1], 110 * light[2], 0.35 * (1 - t));
          }
          break;
        case "splash":
          if (!hidden(ix, iy)) {
            view.blend(ix, iy, 170, 200, 230, 0.7 * (1 - t));
          }
          break;
      }
    }
  }
}

/** A light color scaled by a strength, spread into r, g, b. */
function rgb(c: RGB, k: number): { r: number; g: number; b: number } {
  return { r: (c[0] / 255) * k, g: (c[1] / 255) * k, b: (c[2] / 255) * k };
}

/** A fire's light flickering in time, each fire its own way. */
function flicker(time: number, seed: number): number {
  return 0.82 + 0.1 * Math.sin(time * 9 + seed) + 0.08 * Math.sin(time * 23.7 + seed * 3.1);
}

/**
 * Weather and the small lights of the night, drawn straight from the time
 * and the place so they need no keeping: rain streaks and snowflakes over
 * the part of the world in view, fireflies over the meadows on summer
 * nights, and pale wisps drifting at the edge of the woods.
 */
export function drawAir(f: FrameInfo, world: World, time: number): void {
  const view = f.view;
  const w = world.env.weather.state;
  const cols = view.width;
  const rows = view.height;
  // Rain: streaks falling past, as many as the rain is heavy.
  if (w.rain > 0.02) {
    const count = Math.round(cols * rows * 0.0016 * w.rain * (1 + w.storm));
    const fall = 90;
    const slant = w.wind * 0.6;
    for (let k = 0; k < count; k++) {
      const u = hash2(k, 11) * (cols + 40) - 20;
      const phase = hash2(k, 12);
      const y = ((time * fall + phase * rows * 1.4) % (rows * 1.4)) - rows * 0.2;
      const x = u + slant * y * 0.3;
      const len = 3 + Math.round(hash2(k, 13) * 2);
      for (let s = 0; s < len; s++) {
        view.blend(
          Math.round(x + slant * s * 0.3),
          Math.round(y + s),
          190,
          200,
          215,
          0.35 * (1 - s / len),
        );
      }
    }
  }
  if (w.snow > 0.02) {
    const count = Math.round(cols * rows * 0.0012 * w.snow);
    for (let k = 0; k < count; k++) {
      const u = hash2(k, 21) * (cols + 20) - 10;
      const phase = hash2(k, 22);
      const speed = 8 + hash2(k, 23) * 6;
      const y = ((time * speed + phase * rows * 1.2) % (rows * 1.2)) - rows * 0.1;
      const x = u + Math.sin(time * 0.8 + k) * 2 + w.wind * y * 0.2;
      view.blend(Math.round(x), Math.round(y), 245, 248, 255, 0.85);
    }
  }
  const dark = world.env.darkness;
  if (dark < 0.4) {
    return;
  }
  // Fireflies over the meadows and by the river on early summer nights.
  const fireflies = world.season.fireflies * dark * (1 - w.rain);
  const x0 = f.fx * S;
  const x1 = (f.fx + cols) * S;
  if (fireflies > 0.05) {
    for (let cx = Math.floor(x0 / 6); cx <= Math.ceil(x1 / 6); cx++) {
      for (let k = 0; k < 40; k++) {
        const cell = cx * 131 + k;
        if (hash2(cell, 31) > fireflies * 0.5) {
          continue;
        }
        const x = cx * 6 + hash2(cell, 32) * 6 + Math.sin(time * 0.6 + cell) * 0.8;
        const y =
          world.plan.center.y - 120 + hash2(cell, 33) * 260 + Math.cos(time * 0.5 + cell) * 0.8;
        if (world.forest.density(x, y) > 0.3 && hash2(cell, 34) > 0.3) {
          continue;
        }
        const z = world.terrain.height(x, y) + 0.8 + Math.sin(time * 1.3 + cell) * 0.4;
        const sx = Math.round(x / S - f.fx);
        const sy = Math.round(gyOf(y, z) - f.fy);
        if (sx < 0 || sy < 0 || sx >= cols || sy >= rows || z < f.z[sy * cols + sx] - 0.5) {
          continue;
        }
        const on = Math.max(0, Math.sin(time * 2.2 + cell * 1.7));
        if (on > 0.2) {
          view.add(sx, sy, 190 * on, 230 * on, 90 * on);
        }
      }
    }
  }
  // Will-o'-the-wisps: a few pale lights drifting at the edge of the woods.
  const wisps = dark * (1 - w.rain * 0.8);
  for (let k = 0; k < 14; k++) {
    const a = hash2(k, 41) * Math.PI * 2 + time * 0.01;
    const c = world.plan.center;
    const d = 85 + hash2(k, 42) * 70;
    const x = c.x + Math.cos(a) * d + Math.sin(time * 0.2 + k) * 3;
    const y = c.y + Math.sin(a) * d * 0.9 + Math.cos(time * 0.17 + k) * 3;
    if (world.forest.density(x, y) < 0.4) {
      continue;
    }
    const z = world.terrain.height(x, y) + 1.2 + Math.sin(time * 0.9 + k) * 0.5;
    const sx = x / S - f.fx;
    const sy = gyOf(y, z) - f.fy;
    if (sx < -6 || sy < -6 || sx >= cols + 6 || sy >= rows + 6) {
      continue;
    }
    const ix = Math.round(sx);
    const iy = Math.round(sy);
    if (ix >= 0 && iy >= 0 && ix < cols && iy < rows && z < f.z[iy * cols + ix] - 1.5) {
      continue;
    }
    const pulse =
      (0.6 + 0.4 * Math.sin(time * 1.7 + k * 2.3)) *
      wisps *
      (hash3(k, Math.floor(time / 40), 7) > 0.4 ? 1 : 0);
    if (pulse > 0.05) {
      view.glow(sx, sy, 4, [120, 220, 200], pulse * 0.6);
      view.add(ix, iy, 160 * pulse, 255 * pulse, 230 * pulse);
    }
  }
}
