import { hex, mix, pack, type RGB } from "../../shared/core/color.ts";
import { clamp01 } from "../../shared/core/math.ts";
import { hash2 } from "../../shared/core/random.ts";
import type { Surface } from "../../shared/core/surface.ts";
import type { Animal } from "../sim/animals.ts";
import { KINDS } from "../sim/buildings.ts";
import { rectPoint } from "../sim/geometry.ts";
import { bonfireSpot, garlandsUp } from "../sim/festival.ts";
import { isMarketDay } from "../sim/jobs.ts";
import type { Plan } from "../sim/plan.ts";
import type { Point } from "../sim/terrain.ts";
import { drawDragon } from "./dragon.ts";
import { lampsLit, type StreetLamp } from "./streetlamps.ts";
import { MARKET_CLOSES, MARKET_OPENS, STALLS, stallSpot } from "../sim/market.ts";
import type { Person } from "../sim/people.ts";
import { FLEE_TIME, type Monster } from "../sim/raids.ts";
import type { World } from "../sim/world.ts";
import { COS_E, gyOf, S, SIN_E } from "./projection.ts";
import type { Shader } from "./shading.ts";
import {
  type Action,
  drawAnimal,
  drawMonster,
  drawPerson,
  facingOf,
  type Held,
  type Look,
  lookOf,
  type Sprite,
} from "./sprites.ts";

/** What drawing figures into a frame needs: the frame, its heights, where it lies, and the light. */
export interface FrameInfo {
  view: Surface;
  /** Height of the world at each pixel of the frame (see `projection.ts`); very low where only sky shows. */
  z: Float32Array;
  /** Global art pixel of the frame's top left corner. */
  fx: number;
  fy: number;
  time: number;
  shader: Shader;
}

/** Meters a figure rises per row of pixels. */
const ROW_RISE = S / COS_E;
/** How far (m) in front of a surface a figure's pixel may be and still be hidden by it. */
const DEPTH_SLACK = 0.28;
/** Seconds per stroke of each kind of work, to keep the picture in time with its sound. */
const STROKE: Partial<Record<Action, number>> = {
  chop: 0.62,
  hammer: 0.5,
  saw: 1.1,
  dig: 1.1,
  hoe: 0.95,
  reap: 1.1,
  chisel: 0.55,
  sow: 1.3,
  throw: 1.2,
  thrust: 0.55,
  cast: 0.8,
  dance: 0.5,
  wave: 0.6,
  fish: 3,
};

const LOG: RGB = hex("#8a6440");
const LOG_END: RGB = hex("#c8a070");
const LOG_DARK: RGB = hex("#5e4430");
const STONE: RGB = hex("#b0aa9e");
const STONE_DARK: RGB = hex("#827c72");
const CART_WOOD: RGB = hex("#86623e");
const CART_DARK: RGB = hex("#4e3a28");
const SACK: RGB = hex("#d8cba8");
const SACK_DARK: RGB = hex("#a89a78");
/** Half-width (px) of each animal's shadow on the ground. */
const SHADOW_WIDTH: Record<Animal["kind"], number> = {
  sheep: 3,
  cow: 5,
  ox: 5,
  chicken: 1,
  dog: 2,
  crow: 1,
  duck: 1,
};
const STRING: RGB = hex("#4a3e30");
/** The mills' wood, and the sails' frames and cloth. */
const MILL_WOOD: RGB = hex("#6a4a30");
const SAIL_FRAME: RGB = hex("#5e4430");
const SAIL_CLOTH: RGB = hex("#dcd0b4");
/** A sack's pixels: column, row up from its foot, and color. */
const SACK_SHAPE = [
  [0, 0, SACK_DARK],
  [1, 0, SACK_DARK],
  [0, -1, SACK],
  [1, -1, SACK],
  [0, -2, SACK_DARK],
] as const;
/** The glow of a lantern by the way, and a torch's flame and glow. */
const LANTERN_GLOW: RGB = [255, 200, 120];
const FLAME_HEART: RGB = [255, 230, 150];
const FLAME_TIP: RGB = [255, 150, 60];
const TORCH_GLOW: RGB = [255, 170, 80];
const IRON_DARK: RGB = hex("#2e2c2a");
/** Height (m) of the lamps by the ways. */
const LAMP_HEIGHT = 2.4;
const LANTERNS: RGB[] = [hex("#ffcf6a"), hex("#ff8a4a"), hex("#ffe6a0"), hex("#ff6a5a")];
/** Height (m) of the lantern strings at their poles, and how far they sag between. */
const GARLAND_HEIGHT = 3.4;
const GARLAND_SAG = 0.7;
/** How far (m) a cart's axle trails behind its ox. */
const CART_BEHIND = 2.5;
/** Radius (m) of a cart's wheels. */
const WHEEL_R = 0.6;
const AWNINGS: RGB[] = [hex("#a8433a"), hex("#3d5b8c"), hex("#c8a040"), hex("#4f6d58")];
/** Logs on a cart, as they are loaded: across the bed and how high. */
const LOG_ROWS = [
  [-0.3, 0.12],
  [0, 0.12],
  [0.3, 0.12],
  [-0.15, 0.34],
  [0.15, 0.34],
  [0, 0.56],
] as const;

/** Something in a frame's draw list: one of the figures, or anything else by the way it is drawn. */
interface Item {
  y: number;
  person: Person | null;
  animal: Animal | null;
  cart: Animal | null;
  monster: Monster | null;
  lamp: StreetLamp | null;
  other: (() => void) | null;
}

/** A figure's sprites by frame, for what it was last doing and how it looked doing it. */
interface Memo {
  facing: string;
  action: string;
  held: string | null;
  job: string;
  ageBand: number;
  frames: (Sprite | undefined)[];
}

/** Where an ox's cart stands, and how far its wheels have turned. */
interface Cart {
  x: number;
  y: number;
  z: number;
  spin: number;
}

/**
 * Sorts items far to near, so nearer figures are drawn over farther ones:
 * a stable merge sort through `scratch`.
 */
function sortFarFirst(items: Item[], scratch: Item[]): void {
  const n = items.length;
  scratch.length = n;
  let from = items;
  let to = scratch;
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += width * 2) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + width * 2, n);
      let i = lo;
      let j = mid;
      for (let k = lo; k < hi; k++) {
        if (i < mid && (j >= hi || from[i].y >= from[j].y)) {
          to[k] = from[i++];
        } else {
          to[k] = from[j++];
        }
      }
    }
    const t = from;
    from = to;
    to = t;
  }
  if (from !== items) {
    for (let k = 0; k < n; k++) {
      items[k] = from[k];
    }
  }
}

/**
 * Draws everything that moves or comes and goes: people, animals, raiders
 * and the dragon; the piles of logs and stones, the stock at the yard, the
 * stalls on market days, and what flies through the air in a raid.
 */
export class Actors {
  private readonly sprites = new Map<string, Sprite>();
  private readonly looks = new Map<string, Look>();
  private readonly light = [0, 0, 0];
  /** The frame's draw list, and the items kept for it from frame to frame. */
  private readonly items: Item[] = [];
  private readonly pool: Item[] = [];
  private readonly sorted: Item[] = [];
  private readonly memos = new WeakMap<object, Memo>();
  private poles: Point[] | null = null;

  draw(f: FrameInfo, world: World, lamps: readonly StreetLamp[]): void {
    const items = this.items;
    items.length = 0;
    for (const q of world.piles) {
      if (q.kind !== "brush" && this.inView(f, q.x, q.y, world.groundAt(q.x, q.y), 20)) {
        this.other(q.y, () => this.pile(f, world, q.kind, q.x, q.y, q.count, q.angle));
      }
    }
    this.stock(f, world);
    const lit = lampsLit(world.env.darkness);
    for (const lamp of lamps) {
      if (this.inView(f, lamp.x, lamp.y, world.groundAt(lamp.x, lamp.y), 16)) {
        this.item(lamp.y).lamp = lamp;
      }
    }
    for (const a of world.animals) {
      if (!a.hidden && this.inView(f, a.x, a.y, a.z, 12)) {
        this.item(a.y).animal = a;
        if (a.kind === "ox" && a.home.type === "person") {
          this.item(this.cartAt(world, a).y).cart = a;
        }
      }
    }
    this.addPeople(f, world.people);
    this.addPeople(f, world.traders);
    for (const m of world.monsters) {
      if (this.inView(f, m.x, m.y, m.z, 16)) {
        this.item(m.y).monster = m;
      }
    }
    // The harvest home: the fire built on the square, lanterns strung round it on poles.
    if (garlandsUp(world)) {
      const fire = bonfireSpot(world.plan);
      if (this.inView(f, fire.x, fire.y, world.groundAt(fire.x, fire.y), 20)) {
        this.other(fire.y, () => this.woodpile(f, world, fire.x, fire.y));
      }
      this.poles ??= garlandPoles(world.plan);
      const poles = this.poles;
      poles.forEach((a, k) => {
        const b = poles[(k + 1) % poles.length];
        if (this.inView(f, (a.x + b.x) / 2, (a.y + b.y) / 2, world.groundAt(a.x, a.y), 60)) {
          this.other(Math.max(a.y, b.y), () => this.garland(f, world, a, b, k));
        }
      });
    }
    for (const b of world.town.buildings) {
      if (
        b.phase === "standing" &&
        (b.kind === "watermill" || b.kind === "windmill") &&
        this.inView(f, b.rect.x, b.rect.y, b.base, 60)
      ) {
        this.other(b.rect.y - 3, () =>
          b.kind === "watermill" ? this.wheel(f, world, b) : this.sails(f, world, b),
        );
      }
    }
    sortFarFirst(items, this.sorted);
    for (const it of items) {
      if (it.person) {
        this.person(f, world, it.person);
      } else if (it.animal) {
        this.animal(f, it.animal);
      } else if (it.cart) {
        this.cart(f, it.cart, this.rolled.get(it.cart.id)!);
      } else if (it.monster) {
        this.monster(f, it.monster);
      } else if (it.lamp) {
        this.lamp(f, world, it.lamp, lit);
      } else if (it.other) {
        it.other();
      }
    }
    this.missiles(f, world);
    if (world.dragon) {
      drawDragon(f, world, world.dragon);
    }
    this.lastTime = f.time;
  }

  /** Whether a figure at (x, y, z), reaching `reach` pixels about, may show in the frame. */
  private inView(f: FrameInfo, x: number, y: number, z: number, reach: number): boolean {
    const gx = x / S - f.fx;
    const gy = gyOf(y, z) - f.fy;
    return (
      gx > -reach && gy > -reach * 2 && gx < f.view.width + reach && gy < f.view.height + reach
    );
  }

  /** Adds those out of doors and in view to the draw list. */
  private addPeople(f: FrameInfo, people: readonly Person[]): void {
    for (const p of people) {
      if (p.inside < 0 && this.inView(f, p.x, p.y, p.z, 12)) {
        this.item(p.y).person = p;
      }
    }
  }

  /** A blank item at depth `y`, added to the draw list. */
  private item(y: number): Item {
    const k = this.items.length;
    let it = this.pool[k];
    if (!it) {
      it = { y: 0, person: null, animal: null, cart: null, monster: null, lamp: null, other: null };
      this.pool.push(it);
    }
    it.y = y;
    it.person = null;
    it.animal = null;
    it.cart = null;
    it.monster = null;
    it.lamp = null;
    it.other = null;
    this.items.push(it);
    return it;
  }

  /** Adds something drawn by `draw` to the draw list at depth `y`. */
  private other(y: number, draw: () => void): void {
    this.item(y).other = draw;
  }

  /** Blits a sprite anchored at world point (x, y, z), lit by `light`, hidden behind what is nearer. */
  private blit(
    f: FrameInfo,
    s: Sprite,
    x: number,
    y: number,
    z: number,
    light: number[],
    fade = 1,
  ): void {
    const view = f.view;
    const data = view.data;
    const w = view.width;
    const h = view.height;
    const ox = Math.round(x / S) - f.fx - s.ax;
    const oy = Math.round(gyOf(y, z)) - f.fy - s.ay;
    for (let j = 0; j < s.h; j++) {
      const sy = oy + j;
      if (sy < 0 || sy >= h) {
        continue;
      }
      const rise = (s.ay - j) * ROW_RISE;
      for (let i = 0; i < s.w; i++) {
        const k = j * s.w + i;
        const a = s.alpha[k];
        if (a === 0) {
          continue;
        }
        const sx = ox + i;
        if (sx < 0 || sx >= w) {
          continue;
        }
        const idx = sy * w + sx;
        if (z + rise < f.z[idx] - DEPTH_SLACK) {
          continue;
        }
        let r = s.rgb[k * 3];
        let g = s.rgb[k * 3 + 1];
        let b = s.rgb[k * 3 + 2];
        if (s.glow[k] === 0) {
          r *= light[0];
          g *= light[1];
          b *= light[2];
        }
        const alpha = (a / 255) * fade;
        if (alpha >= 1) {
          data[idx] = pack(r, g, b);
        } else {
          const o = data[idx];
          const or = o & 255;
          const og = (o >>> 8) & 255;
          const ob = (o >>> 16) & 255;
          data[idx] = pack(or + (r - or) * alpha, og + (g - og) * alpha, ob + (b - ob) * alpha);
        }
      }
    }
  }

  /** A soft dark patch on the ground beside a figure, away from the sun. */
  private shadow(
    f: FrameInfo,
    x: number,
    y: number,
    z: number,
    width: number,
    strength: number,
  ): void {
    const sh = f.shader;
    if (!sh.sunUp) {
      return;
    }
    const sun = sh.sunFlat;
    const view = f.view;
    const cx = Math.round((x - sun.x * 0.5) / S) - f.fx;
    const cy = Math.round(gyOf(y - sun.y * 0.5, z)) - f.fy;
    for (let dx = -width; dx <= width; dx++) {
      const sx = cx + dx - Math.round(sun.x * 1.5);
      const sy = cy;
      if (sx < 0 || sy < 0 || sx >= view.width || sy >= view.height) {
        continue;
      }
      const idx = sy * view.width + sx;
      if (Math.abs(f.z[idx] - z) > 0.4) {
        continue;
      }
      const k = 1 - strength * (Math.abs(dx) === width ? 0.5 : 1);
      const o = view.data[idx];
      view.data[idx] = pack((o & 255) * k, ((o >>> 8) & 255) * k, ((o >>> 16) & 255) * k);
    }
  }

  /** A figure's sprites by frame for what it is doing now, forgetting those of what it did before. */
  private memo(
    of: object,
    facing: string,
    action: string,
    held: string | null,
    job: string,
    ageBand: number,
  ): Memo {
    let m = this.memos.get(of);
    if (!m) {
      m = { facing, action, held, job, ageBand, frames: [] };
      this.memos.set(of, m);
    } else if (
      m.facing !== facing ||
      m.action !== action ||
      m.held !== held ||
      m.job !== job ||
      m.ageBand !== ageBand
    ) {
      m.facing = facing;
      m.action = action;
      m.held = held;
      m.job = job;
      m.ageBand = ageBand;
      m.frames.length = 0;
    }
    return m;
  }

  private cached(key: string, make: () => Sprite): Sprite {
    let s = this.sprites.get(key);
    if (!s) {
      s = make();
      this.sprites.set(key, s);
      if (this.sprites.size > 6000) {
        // Very long runs meet many looks; start the cache over rather than grow without end.
        this.sprites.clear();
        this.sprites.set(key, s);
      }
    }
    return s;
  }

  private person(f: FrameInfo, world: World, p: Person): void {
    const ageBand = p.age < 15 ? 0 : p.age >= 58 ? 2 : 1;
    const job = p.trader ? "trader" : p.job;
    const action = (p.pose === "pray" ? "stand" : p.pose) as Action;
    const facing = facingOf(p.heading);
    const frame = frameOf(action, p.poseTime);
    // Out after dark with hands free: a lantern to see the way by.
    const held = (carriesLight(world, p) ? "torch" : p.carry) as Held;
    const memo = this.memo(p, facing, action, held, job, ageBand);
    let sprite = memo.frames[frame];
    if (!sprite) {
      const lookKey = `${p.look}|${p.female ? 1 : 0}|${job}|${ageBand}`;
      let look = this.looks.get(lookKey);
      if (!look) {
        look = lookOf(p.look, p.female, job, p.age);
        this.looks.set(lookKey, look);
      }
      const key = `p|${lookKey}|${facing}|${action}|${frame}|${held}`;
      const chosen = look;
      sprite = this.cached(key, () => drawPerson(chosen, facing, action, frame, held));
      memo.frames[frame] = sprite;
    }
    const light = f.shader.lightAt(p.x, p.y, p.z, this.light);
    this.shadow(f, p.x, p.y, p.z, 1, 0.3);
    this.blit(f, sprite, p.x, p.y, p.z, light);
  }

  private animal(f: FrameInfo, a: Animal): void {
    const facing = facingOf(a.heading);
    const frame =
      a.pose === "walk" || a.pose === "run" || a.pose === "fly"
        ? Math.floor(a.poseTime * (a.pose === "fly" ? 7 : 6)) % 2
        : Math.floor(a.poseTime * 1.5) % 2;
    const memo = this.memo(a, facing, a.pose, null, "", 0);
    let sprite = memo.frames[frame];
    if (!sprite) {
      const seed = a.id % 7;
      const key = `a|${a.kind}|${facing}|${frame}|${a.pose}|${a.kind === "cow" || a.kind === "chicken" || a.kind === "dog" || a.kind === "ox" ? seed : 0}`;
      sprite = this.cached(key, () => drawAnimal(a.kind, facing, frame, a.pose, seed));
      memo.frames[frame] = sprite;
    }
    const light = f.shader.lightAt(a.x, a.y, a.z, this.light);
    if (a.lift <= 0.05) {
      this.shadow(f, a.x, a.y, a.z, SHADOW_WIDTH[a.kind], 0.25);
    }
    this.blit(f, sprite, a.x, a.y, a.z, light);
  }

  /** Where an ox's cart stands: trailing behind it, its wheels turned by how far it has rolled. */
  private cartAt(world: World, a: Animal): Cart {
    const hx = Math.sin(a.heading);
    const hy = -Math.cos(a.heading);
    const x = a.x - hx * CART_BEHIND;
    const y = a.y - hy * CART_BEHIND;
    let c = this.rolled.get(a.id);
    if (c) {
      c.spin = (c.spin + Math.hypot(x - c.x, y - c.y) / WHEEL_R) % (Math.PI * 2);
    } else {
      c = { x, y, z: 0, spin: 0 };
      this.rolled.set(a.id, c);
    }
    c.x = x;
    c.y = y;
    c.z = world.groundAt(x, y);
    return c;
  }

  private readonly rolled = new Map<number, Cart>();

  /**
   * A two-wheeled cart: a plank bed with low sides on an axle, shafts
   * running forward to the ox, and what it carries heaped on the bed.
   */
  private cart(f: FrameInfo, a: Animal, c: Cart): void {
    const hx = Math.sin(a.heading);
    const hy = -Math.cos(a.heading);
    // Across the cart, to its right.
    const rx = -hy;
    const ry = hx;
    const light = f.shader.lightAt(c.x, c.y, c.z + 0.8, this.light);
    // A line from (along, across, up) to another, in the cart's own frame.
    const seg = (
      a0: number,
      s0: number,
      z0: number,
      a1: number,
      s1: number,
      z1: number,
      color: RGB,
    ) => {
      this.line3(
        f,
        c.x + hx * a0 + rx * s0,
        c.y + hy * a0 + ry * s0,
        c.z + z0,
        c.x + hx * a1 + rx * s1,
        c.y + hy * a1 + ry * s1,
        c.z + z1,
        color,
        light,
      );
    };
    // A wheel: its rim, and two spokes across it turned by how far the cart has rolled.
    const wheel = (side: number) => {
      const across = side * 0.72;
      const arc = (t0: number, t1: number, color: RGB) => {
        seg(
          Math.cos(t0) * WHEEL_R,
          across,
          WHEEL_R + Math.sin(t0) * WHEEL_R,
          Math.cos(t1) * WHEEL_R,
          across,
          WHEEL_R + Math.sin(t1) * WHEEL_R,
          color,
        );
      };
      for (let k = 0; k < 12; k++) {
        arc((k / 12) * Math.PI * 2, ((k + 1) / 12) * Math.PI * 2, CART_DARK);
      }
      for (let k = 0; k < 2; k++) {
        const t = -c.spin + (k * Math.PI) / 2;
        arc(t, t + Math.PI, CART_WOOD);
      }
    };
    // The far wheel first, then the bed, what is on it, and the near wheel over them.
    // The side nearer the eye is the one further toward -y.
    const near = ry > 0 ? -1 : 1;
    wheel(-near);
    const bed = 0.85;
    for (let k = -6; k <= 6; k++) {
      seg(-1.05, k * 0.1, bed, 1.05, k * 0.1, bed, Math.abs(k) === 6 ? CART_DARK : CART_WOOD);
    }
    // Low sides, a board and a rail.
    for (let side = -1; side <= 1; side += 2) {
      seg(-1.05, side * 0.62, bed + 0.12, 1.05, side * 0.62, bed + 0.12, CART_DARK);
      seg(-1.05, side * 0.62, bed + 0.3, 1.05, side * 0.62, bed + 0.3, CART_WOOD);
    }
    for (let end = -1; end <= 1; end += 2) {
      seg(end * 1.05, -0.62, bed + 0.3, end * 1.05, 0.62, bed + 0.3, CART_DARK);
    }
    // Shafts, forward to the ox's shoulders.
    for (let side = -1; side <= 1; side += 2) {
      seg(1.05, side * 0.5, bed, CART_BEHIND - 0.5, side * 0.42, 1.1, CART_DARK);
    }
    this.cargo(f, a, c, hx, hy, c.z + bed, light);
    wheel(near);
  }

  /** What a cart has on it: logs lying along the bed, blocks of stone, or a trader's sacks. */
  private cargo(
    f: FrameInfo,
    a: Animal,
    c: Cart,
    hx: number,
    hy: number,
    z: number,
    light: number[],
  ): void {
    if (a.load <= 0) {
      return;
    }
    // Along the cart and across it, to its right.
    const ax = (along: number, across: number) => c.x + hx * along - hy * across;
    const ay = (along: number, across: number) => c.y + hy * along + hx * across;
    if (a.cargo === "logs") {
      for (let k = 0; k < Math.min(a.load, LOG_ROWS.length); k++) {
        const s = LOG_ROWS[k][0] * 1.2;
        const up = LOG_ROWS[k][1];
        this.log(f, ax(-1.3, s), ay(-1.3, s), ax(1.2, s), ay(1.2, s), z + up, light);
      }
      return;
    }
    if (a.cargo === "stones") {
      for (let k = 0; k < a.load; k++) {
        const along = -0.5 + (k % 3) * 0.5;
        const across = k < 3 ? -0.2 : 0.2;
        this.block(f, ax(along, across), ay(along, across), z + 0.1 + (k % 2) * 0.12, light);
      }
      return;
    }
    for (let k = 0; k < a.load; k++) {
      const along = -0.55 + (k % 3) * 0.55;
      const across = k < 3 ? -0.22 : 0.22;
      this.sack(f, ax(along, across), ay(along, across), z + 0.08 + (k >= 3 ? 0.18 : 0), light);
    }
  }

  /**
   * A lamp by the way: a pole with a torch in an iron cup, or in a town a
   * lantern on an iron post, burning after dusk.
   */
  private lamp(f: FrameInfo, world: World, lamp: StreetLamp, lit: number): void {
    const view = f.view;
    const z = world.groundAt(lamp.x, lamp.y);
    const light = f.shader.lightAt(lamp.x, lamp.y, z + 1.5, this.light);
    const top = z + LAMP_HEIGHT;
    this.line3(f, lamp.x, lamp.y, z, lamp.x, lamp.y, top, lamp.iron ? IRON_DARK : LOG_DARK, light);
    const sx = Math.round(lamp.x / S) - f.fx;
    const sy = Math.round(gyOf(lamp.y, top)) - f.fy;
    if (
      sx < 1 ||
      sy < 3 ||
      sx >= view.width - 1 ||
      sy >= view.height ||
      top < f.z[sy * view.width + sx] - DEPTH_SLACK
    ) {
      return;
    }
    const flicker =
      0.85 + 0.15 * Math.sin(f.time * 11 + lamp.x * 3.1) * Math.sin(f.time * 7.3 + lamp.y);
    if (lamp.iron) {
      // The lantern: a dark frame round a glowing pane.
      const pane =
        lit > 0
          ? pack(255 * (0.7 + 0.3 * lit), 214 * (0.6 + 0.4 * lit), 140 * (0.5 + 0.5 * lit))
          : pack(60 * light[0], 56 * light[1], 50 * light[2]);
      view.data[(sy - 1) * view.width + sx] = pane;
      view.data[sy * view.width + sx] = pane;
      view.data[(sy - 2) * view.width + sx] = pack(
        IRON_DARK[0] * light[0],
        IRON_DARK[1] * light[1],
        IRON_DARK[2] * light[2],
      );
      if (lit > 0) {
        view.glow(sx + 0.5, sy - 0.5, 3.5, LANTERN_GLOW, 0.45 * lit * flicker);
      }
      return;
    }
    // The torch: its cup, and the flame standing up out of it.
    view.data[sy * view.width + sx] = pack(
      IRON_DARK[0] * light[0],
      IRON_DARK[1] * light[1],
      IRON_DARK[2] * light[2],
    );
    if (lit > 0) {
      const tall = flicker > 0.9 ? 3 : 2;
      for (let j = 1; j <= tall; j++) {
        const c = j === 1 ? FLAME_HEART : FLAME_TIP;
        view.blend(sx + (j === tall && flicker > 0.95 ? 1 : 0), sy - j, c[0], c[1], c[2], lit);
      }
      view.glow(sx + 0.5, sy - 1.5, 4, TORCH_GLOW, 0.5 * lit * flicker);
    }
  }

  /** The harvest fire's wood, stood up in a cone. */
  private woodpile(f: FrameInfo, world: World, x: number, y: number): void {
    const z = world.groundAt(x, y);
    const light = f.shader.lightAt(x, y, z + 0.8, this.light);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + 0.3;
      this.line3(
        f,
        x + Math.cos(a) * 0.9,
        y + Math.sin(a) * 0.9,
        z,
        x,
        y,
        z + 1.7,
        k % 2 ? LOG : LOG_DARK,
        light,
      );
    }
  }

  /**
   * A string of lanterns from pole `a` to pole `b`: the pole standing at `a`,
   * the line sagging to the next, lanterns hung along it, alight after dusk.
   */
  private garland(f: FrameInfo, world: World, a: Point, b: Point, k: number): void {
    const view = f.view;
    const za = world.groundAt(a.x, a.y);
    const zb = world.groundAt(b.x, b.y);
    const light = f.shader.lightAt(a.x, a.y, za + 2, this.light);
    this.line3(f, a.x, a.y, za, a.x, a.y, za + GARLAND_HEIGHT + 0.2, LOG_DARK, light);
    const dark = world.env.darkness;
    const n = 12;
    let lastX = 0;
    let lastY = 0;
    let lastZ = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = za + (zb - za) * t + GARLAND_HEIGHT - GARLAND_SAG * 4 * t * (1 - t);
      if (i > 0) {
        this.line3(f, lastX, lastY, lastZ, x, y, z, STRING, light);
      }
      lastX = x;
      lastY = y;
      lastZ = z;
      if (i % 3 === 1 || i % 3 === 2) {
        const c = LANTERNS[(k * 5 + i) % LANTERNS.length];
        const sx = Math.round(x / S) - f.fx;
        const sy = Math.round(gyOf(y, z - 0.25)) - f.fy;
        if (
          sx < 0 ||
          sy < 0 ||
          sx >= view.width ||
          sy >= view.height ||
          z < f.z[sy * view.width + sx] - DEPTH_SLACK
        ) {
          continue;
        }
        // Paper lanterns: their color by day, lit from within by night.
        const lit = clamp01((dark - 0.15) * 2);
        const r = c[0] * (light[0] * (1 - lit) + lit);
        const g = c[1] * (light[1] * (1 - lit) + lit);
        const bl = c[2] * (light[2] * (1 - lit) + lit);
        view.data[sy * view.width + sx] = pack(r, g, bl);
        if (lit > 0) {
          view.glow(sx + 0.5, sy + 0.5, 2.5, c, 0.35 * lit);
        }
      }
    }
  }

  /** A sack of grain or wool: a pale lump with a tied top. */
  private sack(f: FrameInfo, x: number, y: number, z: number, light: number[]): void {
    const view = f.view;
    const cx = Math.round(x / S) - f.fx;
    const cy = Math.round(gyOf(y, z)) - f.fy;
    for (const [i, j, c] of SACK_SHAPE) {
      const sx = cx + i;
      const sy = cy + j;
      if (sx < 0 || sy < 0 || sx >= view.width || sy >= view.height) {
        continue;
      }
      const idx = sy * view.width + sx;
      if (z - j * ROW_RISE < f.z[idx] - DEPTH_SLACK) {
        continue;
      }
      view.data[idx] = pack(c[0] * light[0], c[1] * light[1], c[2] * light[2]);
    }
  }

  private monster(f: FrameInfo, m: Monster): void {
    const facing = facingOf(m.heading);
    const rate = m.pose === "run" ? 9 : m.pose === "attack" ? 3 : 5;
    const frame = Math.floor(m.poseTime * rate) % 2;
    const memo = this.memo(m, facing, m.pose, m.torch ? "torch" : null, "", 0);
    let s = memo.frames[frame];
    if (!s) {
      const key = `m|${m.kind}|${facing}|${frame}|${m.pose}|${m.torch ? 1 : 0}`;
      s = this.cached(key, () => drawMonster(m.kind, facing, frame, m.pose, m.torch));
      memo.frames[frame] = s;
    }
    const light = f.shader.lightAt(m.x, m.y, m.z, this.light);
    this.shadow(f, m.x, m.y, m.z, m.kind === "ogre" ? 3 : 1, 0.3);
    // A raider that has lost heart and is running shows it only by running; fading into the woods at the end.
    const fade =
      m.state === "flee"
        ? clamp01(
            Math.min(Math.hypot(m.home.x - m.x, m.home.y - m.y) / 6, (FLEE_TIME - m.fled) / 4),
          )
        : 1;
    this.blit(f, s, m.x, m.y, m.z, light, fade);
  }

  /** Logs lying in a heap, or a few blocks of stone. */
  private pile(
    f: FrameInfo,
    world: World,
    kind: "logs" | "stones" | "brush",
    x: number,
    y: number,
    count: number,
    angle: number,
  ): void {
    const z = world.groundAt(x, y);
    const light = f.shader.lightAt(x, y, z, this.light);
    if (kind === "stones") {
      for (let k = 0; k < Math.min(count, 8); k++) {
        const ox = (hash2(k, Math.round(x * 7)) - 0.5) * 1.4;
        const oy = (hash2(k + 9, Math.round(y * 7)) - 0.5) * 1.0;
        this.block(f, x + ox, y + oy, z + (k > 4 ? 0.3 : 0), light);
      }
      return;
    }
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    const layers = Math.min(3, Math.ceil(count / 3));
    let n = 0;
    for (let layer = 0; layer < layers && n < count; layer++) {
      for (let k = 0; k < 3 - layer && n < count; k++, n++) {
        const off = (k - (2 - layer) / 2) * 0.3;
        const cx = x - dy * off;
        const cy = y + dx * off;
        this.log(
          f,
          cx - dx * 1.1,
          cy - dy * 1.1,
          cx + dx * 1.1,
          cy + dy * 1.1,
          z + 0.14 + layer * 0.24,
          light,
        );
      }
    }
  }

  /** One log lying from a to b at height z: a line of bark with its cut ends showing. */
  private log(
    f: FrameInfo,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    z: number,
    light: number[],
  ): void {
    const view = f.view;
    const pax = ax / S - f.fx;
    const pay = gyOf(ay, z) - f.fy;
    const pbx = bx / S - f.fx;
    const pby = gyOf(by, z) - f.fy;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(pbx - pax), Math.abs(pby - pay))));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const sx = Math.round(pax + (pbx - pax) * t);
      const sy = Math.round(pay + (pby - pay) * t);
      const end = s === 0 || s === steps;
      for (let row = 0; row < 2; row++) {
        const yy = sy - row;
        if (sx < 0 || yy < 0 || sx >= view.width || yy >= view.height) {
          continue;
        }
        const idx = yy * view.width + sx;
        const zz = z + row * ROW_RISE;
        if (zz < f.z[idx] - DEPTH_SLACK) {
          continue;
        }
        const c = end ? LOG_END : row === 1 ? LOG : LOG_DARK;
        view.data[idx] = pack(c[0] * light[0], c[1] * light[1], c[2] * light[2]);
      }
    }
  }

  /** A block of dressed stone. */
  private block(f: FrameInfo, x: number, y: number, z: number, light: number[]): void {
    const view = f.view;
    const cx = Math.round(x / S) - f.fx;
    const cy = Math.round(gyOf(y, z)) - f.fy;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const sx = cx + i;
        const sy = cy - j;
        if (sx < 0 || sy < 0 || sx >= view.width || sy >= view.height) {
          continue;
        }
        const idx = sy * view.width + sx;
        if (z + j * ROW_RISE < f.z[idx] - DEPTH_SLACK) {
          continue;
        }
        const c = j === 1 ? STONE : STONE_DARK;
        view.data[idx] = pack(c[0] * light[0], c[1] * light[1], c[2] * light[2]);
      }
    }
  }

  /**
   * What the town has laid by, heaped where it is kept: logs stacked at the
   * yard, stone blocks at the quarry; materials brought to each building site;
   * the stalls on the square on market days.
   */
  private stock(f: FrameInfo, world: World): void {
    const wood = Math.min(60, Math.floor(world.stock.wood));
    const stone = Math.min(40, Math.floor(world.stock.stone));
    const woodAt = world.depot("wood");
    const stoneAt = world.depot("stone");
    if (wood > 0 && this.inView(f, woodAt.x, woodAt.y, world.groundAt(woodAt.x, woodAt.y), 30)) {
      this.other(woodAt.y + 1, () => this.stack(f, world, woodAt.x, woodAt.y, wood));
    }
    if (
      stone > 0 &&
      this.inView(f, stoneAt.x, stoneAt.y, world.groundAt(stoneAt.x, stoneAt.y), 30)
    ) {
      this.other(stoneAt.y + 1, () =>
        this.pile(f, world, "stones", stoneAt.x, stoneAt.y, Math.min(8, Math.ceil(stone / 5)), 0),
      );
    }
    for (const b of world.town.buildings) {
      if ((b.phase !== "building" && b.phase !== "clearing") || (b.wood <= 0 && b.stone <= 0)) {
        continue;
      }
      const spec = KINDS[b.kind];
      const left = b.progress < 1 ? 1 - b.progress : 0;
      const logs = Math.ceil(b.wood * left * 0.6);
      const blocks = Math.ceil(b.stone * left * 0.5);
      const at = rectPoint(b.rect, b.rect.width / 2 + 1.2, -b.rect.depth / 2 + 1);
      if (!this.inView(f, at.x, at.y, b.base, 20)) {
        continue;
      }
      if (logs > 0 && spec.wood > 0) {
        this.other(at.y, () =>
          this.pile(f, world, "logs", at.x, at.y, Math.min(8, logs), b.rect.angle + Math.PI / 2),
        );
      }
      if (blocks > 0 && spec.stone > 0) {
        const s2 = rectPoint(b.rect, -b.rect.width / 2 - 1.2, -b.rect.depth / 2 + 1);
        this.other(s2.y, () => this.pile(f, world, "stones", s2.x, s2.y, Math.min(8, blocks), 0));
      }
    }
    // Stalls round the square on market days, from morning till afternoon.
    const h = world.env.clock.hour;
    if (isMarketDay(world) && h > MARKET_OPENS && h < MARKET_CLOSES && !world.raids.alarm) {
      for (let k = 0; k < STALLS; k++) {
        const { x, y } = stallSpot(world.plan, k);
        if (this.inView(f, x, y, world.groundAt(x, y), 20)) {
          this.other(y, () => this.stall(f, world, x, y, k));
        }
      }
    }
  }

  /** A stack of logs at the yard, growing longer and higher with the stock. */
  private stack(f: FrameInfo, world: World, x: number, y: number, count: number): void {
    const z = world.groundAt(x, y);
    const light = f.shader.lightAt(x, y, z, this.light);
    const perRow = 6;
    const rows = Math.ceil(count / perRow);
    let n = 0;
    for (let row = 0; row < rows && row < 5; row++) {
      for (let k = 0; k < perRow && n < count; k++, n++) {
        const oy = (k - perRow / 2) * 0.28;
        this.log(f, x - 1.3, y + oy, x + 1.3, y + oy, z + 0.14 + row * 0.24, light);
      }
    }
  }

  /** A market stall: posts, a striped awning, goods on the board. */
  private stall(f: FrameInfo, world: World, x: number, y: number, k: number): void {
    const z = world.groundAt(x, y);
    const light = f.shader.lightAt(x, y, z, this.light);
    const s = this.cached(`stall|${k}`, () => {
      const w = 13;
      const h = 12;
      const rgb = new Float32Array(w * h * 3);
      const alpha = new Uint8Array(w * h);
      const glow = new Uint8Array(w * h);
      const set = (i: number, j: number, c: RGB) => {
        const q = j * w + i;
        rgb[q * 3] = c[0];
        rgb[q * 3 + 1] = c[1];
        rgb[q * 3 + 2] = c[2];
        alpha[q] = 255;
      };
      const cloth = AWNINGS[k % AWNINGS.length];
      const pale = mix(cloth, [236, 230, 214], 0.7);
      for (let i = 1; i < w - 1; i++) {
        set(i, 1, (i >> 1) % 2 === 0 ? cloth : pale);
        set(i, 2, (i >> 1) % 2 === 0 ? cloth : pale);
      }
      for (let j = 3; j < h; j++) {
        set(2, j, LOG_DARK);
        set(w - 3, j, LOG_DARK);
      }
      for (let i = 2; i < w - 2; i++) {
        set(i, 7, LOG);
      }
      const goods: RGB[] = [
        hex("#c8883a"),
        hex("#6a8a3a"),
        hex("#c83a2a"),
        hex("#d8c870"),
        hex("#8a5a8a"),
      ];
      for (let i = 3; i < w - 3; i++) {
        set(i, 6, goods[(i + k) % goods.length]);
      }
      return { w, h, ax: 6, ay: h - 1, rgb, alpha, glow };
    });
    this.blit(f, s, x, y, z, light);
  }

  /** How far round a mill's wheel or sails have turned. */
  private readonly turned = new Map<number, number>();
  private lastTime = 0;

  /** Turns a mill's wheel or sails on by the time since the last frame, at `speed` radians a second. */
  private turn(id: number, speed: number, time: number): number {
    const was = this.turned.get(id) ?? 0;
    const dt = Math.min(0.2, Math.max(0, time - this.lastTime));
    const now = was + speed * dt;
    this.turned.set(id, now);
    return now;
  }

  /** A line through the world from a to b, drawn behind whatever stands nearer. */
  private line3(
    f: FrameInfo,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    c: RGB,
    light: number[],
  ): void {
    const view = f.view;
    const pax = ax / S - f.fx;
    const pay = gyOf(ay, az) - f.fy;
    const pbx = bx / S - f.fx;
    const pby = gyOf(by, bz) - f.fy;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(pbx - pax), Math.abs(pby - pay))));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const sx = Math.round(pax + (pbx - pax) * t);
      const sy = Math.round(pay + (pby - pay) * t);
      if (sx < 0 || sy < 0 || sx >= view.width || sy >= view.height) {
        continue;
      }
      const idx = sy * view.width + sx;
      if (az + (bz - az) * t < f.z[idx] - DEPTH_SLACK) {
        continue;
      }
      view.data[idx] = pack(c[0] * light[0], c[1] * light[1], c[2] * light[2]);
    }
  }

  /**
   * A mill's water wheel, turning in the river on the side of the mill that
   * faces it: a rim, spokes and paddles.
   */
  private wheel(
    f: FrameInfo,
    world: World,
    b: {
      id: number;
      rect: { x: number; y: number; angle: number; width: number; depth: number };
      base: number;
    },
  ): void {
    const t = world.terrain;
    const fx = Math.sin(b.rect.angle);
    const fy = -Math.cos(b.rect.angle);
    // The side facing the river: front, back, or either end.
    const toRiver = Math.sign(t.riverX(b.rect.y) - b.rect.x);
    let nx = fx;
    let ny = fy;
    let reach = b.rect.depth / 2;
    if (-fx * toRiver > nx * toRiver) {
      nx = -fx;
      ny = -fy;
    }
    if (-fy * toRiver > nx * toRiver) {
      nx = -fy;
      ny = fx;
      reach = b.rect.width / 2;
    }
    if (fy * toRiver > nx * toRiver) {
      nx = fy;
      ny = -fx;
      reach = b.rect.width / 2;
    }
    const cx = b.rect.x + nx * (reach + 1.2);
    const cy = b.rect.y + ny * (reach + 1.2);
    const cz = Math.max(t.waterLevel(cy) + 1.1, b.base + 0.6);
    const R = 1.8;
    // Along the wall, and up.
    const ux = -ny;
    const uy = nx;
    const light = f.shader.lightAt(cx, cy, cz, this.light);
    const a0 = this.turn(b.id, -1.1, f.time);
    // Points round the wheel's hub, at angle a and radius r.
    const px = (a: number, r: number) => cx + ux * Math.cos(a) * r;
    const py = (a: number, r: number) => cy + uy * Math.cos(a) * r;
    const pz = (a: number, r: number) => cz + Math.sin(a) * r;
    for (let k = 0; k < 20; k++) {
      const a = a0 + (k / 20) * Math.PI * 2;
      const b1 = a0 + ((k + 1) / 20) * Math.PI * 2;
      this.line3(
        f,
        px(a, R),
        py(a, R),
        pz(a, R),
        px(b1, R),
        py(b1, R),
        pz(b1, R),
        MILL_WOOD,
        light,
      );
    }
    for (let k = 0; k < 8; k++) {
      const a = a0 + (k / 8) * Math.PI * 2;
      const x = px(a, R);
      const y = py(a, R);
      const z = pz(a, R);
      this.line3(f, cx, cy, cz, x, y, z, MILL_WOOD, light);
      const R1 = R + 0.45;
      this.line3(f, x + nx * 0.3, y + ny * 0.3, z, px(a, R1), py(a, R1), pz(a, R1), LOG, light);
    }
  }

  /** The sails of a post mill, turning in the wind while the miller is at work. */
  private sails(
    f: FrameInfo,
    world: World,
    b: {
      id: number;
      rect: { x: number; y: number; angle: number; width: number; depth: number };
      base: number;
    },
  ): void {
    const fx = Math.sin(b.rect.angle);
    const fy = -Math.cos(b.rect.angle);
    const rx = -fy;
    const ry = fx;
    // The hub, out in front of the body near the top.
    const hx = b.rect.x + fx * 2.2;
    const hy = b.rect.y + fy * 2.2;
    const hz = b.base + 6.2;
    const h = world.env.clock.hour;
    const working = h > 7 && h < 18 && !world.raids.alarm;
    const speed = working ? 0.5 + world.env.weather.state.wind * 1.6 : 0;
    const a0 = this.turn(b.id, speed, f.time);
    const light = f.shader.lightAt(hx, hy, hz, this.light);
    for (let k = 0; k < 4; k++) {
      const a = a0 + (k * Math.PI) / 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // Points of the sail, along its arm and across it.
      const sx = (along: number, across: number) => hx + rx * (cos * along - sin * across);
      const sy = (along: number, across: number) => hy + ry * (cos * along - sin * across);
      const sz = (along: number, across: number) => hz + sin * along + cos * across;
      this.line3(f, hx, hy, hz, sx(6.4, 0), sy(6.4, 0), sz(6.4, 0), SAIL_FRAME, light);
      // The lattice, and its cloth spread when the mill is working.
      const bar = working ? SAIL_CLOTH : SAIL_FRAME;
      for (let s = 1.2; s <= 6.4; s += 0.35) {
        this.line3(f, sx(s, 0), sy(s, 0), sz(s, 0), sx(s, 1.1), sy(s, 1.1), sz(s, 1.1), bar, light);
      }
      this.line3(
        f,
        sx(1.2, 1.1),
        sy(1.2, 1.1),
        sz(1.2, 1.1),
        sx(6.4, 1.1),
        sy(6.4, 1.1),
        sz(6.4, 1.1),
        SAIL_FRAME,
        light,
      );
    }
  }

  /** Arrows, the wizard's bolts, and torches thrown onto roofs. */
  private missiles(f: FrameInfo, world: World): void {
    const view = f.view;
    for (const m of world.missiles) {
      const sx = Math.round(m.x / S) - f.fx;
      const sy = Math.round(gyOf(m.y, m.z)) - f.fy;
      if (sx < -4 || sy < -4 || sx >= view.width + 4 || sy >= view.height + 4) {
        continue;
      }
      if (m.kind === "bolt") {
        view.glow(sx + 0.5, sy + 0.5, 5, [180, 140, 255], 0.9);
        view.add(sx, sy, 220, 200, 255);
        continue;
      }
      if (m.kind === "torch") {
        view.glow(sx + 0.5, sy + 0.5, 4, [255, 150, 60], 0.8);
        view.blend(sx, sy, 255, 210, 110, 1);
        continue;
      }
      // An arrow: a short dark line along its flight.
      const vx = m.vx / S;
      const vy = -(m.vy * SIN_E + m.vz * COS_E) / S;
      const l = Math.hypot(vx, vy) || 1;
      for (let k = 0; k < 3; k++) {
        view.blend(sx - Math.round((vx / l) * k), sy - Math.round((vy / l) * k), 60, 48, 36, 1);
      }
    }
  }
}

/** Whether someone carries a light: out after dark, grown enough, hands free. */
export function carriesLight(world: World, p: Person): boolean {
  return world.env.darkness > 0.45 && p.inside < 0 && p.carry === null && p.age >= 12;
}

/** Poles round the edge of the square that the harvest lanterns are strung between. */
export function garlandPoles(plan: Plan): Point[] {
  const sq = plan.square;
  return Array.from({ length: 8 }, (_, k) => {
    const a = (k / 8) * Math.PI * 2 + 0.2;
    return { x: sq.x + Math.cos(a) * (sq.radius - 0.6), y: sq.y + Math.sin(a) * (sq.radius - 0.6) };
  });
}

/** The frame of a figure's picture for what they are doing, `t` seconds into it. */
function frameOf(action: Action, t: number): number {
  if (action === "walk") {
    return Math.floor(t * 7) % 4;
  }
  if (action === "run") {
    return Math.floor(t * 11) % 4;
  }
  const stroke = STROKE[action];
  if (!stroke) {
    return 0;
  }
  return (t % stroke) / stroke < 0.62 ? 0 : 1;
}
