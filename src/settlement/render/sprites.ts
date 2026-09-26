import { hex, mix, type RGB } from "../../shared/core/color.ts";
import { hashU32 } from "../../shared/core/random.ts";

/**
 * A small picture drawn at a point of the world: `w` × `h` pixels, anchored
 * at (ax, ay), the pixel that stands on the ground. Each pixel has a color
 * (r, g, b in `rgb`) and an opacity (`alpha`, 0 see-through); `glow` marks
 * pixels that give their own light (a torch's flame) and are not darkened
 * by the night.
 */
export interface Sprite {
  w: number;
  h: number;
  ax: number;
  ay: number;
  rgb: Float32Array;
  alpha: Uint8Array;
  glow: Uint8Array;
}

/** Which way a figure faces on screen. */
export type Facing = "front" | "back" | "left" | "right";

/** The facing of something heading `angle` (radians, as `Rect.angle`). */
export function facingOf(angle: number): Facing {
  const a = (((angle % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(a) < Math.PI / 4) {
    return "front";
  }
  if (Math.abs(a) > (Math.PI * 3) / 4) {
    return "back";
  }
  return a > 0 ? "right" : "left";
}

/** Draws into a sprite being made, with y going up from the ground row. */
class Canvas {
  readonly w: number;
  readonly h: number;
  readonly ax: number;
  readonly ay: number;
  readonly rgb: Float32Array;
  readonly alpha: Uint8Array;
  readonly glow: Uint8Array;

  constructor(w: number, h: number, ax: number) {
    this.w = w;
    this.h = h;
    this.ax = ax;
    this.ay = h - 1;
    this.rgb = new Float32Array(w * h * 3);
    this.alpha = new Uint8Array(w * h);
    this.glow = new Uint8Array(w * h);
  }

  /** Sets pixel (x, y): x from the anchor column, y up from the ground row. */
  px(x: number, y: number, c: RGB | null, glow = false, alpha = 255): void {
    if (!c) {
      return;
    }
    const i = this.ax + x;
    const j = this.ay - y;
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) {
      return;
    }
    const k = j * this.w + i;
    this.rgb[k * 3] = c[0];
    this.rgb[k * 3 + 1] = c[1];
    this.rgb[k * 3 + 2] = c[2];
    this.alpha[k] = alpha;
    this.glow[k] = glow ? 1 : 0;
  }

  /** A run of pixels along a row. */
  row(x0: number, x1: number, y: number, c: RGB | null): void {
    for (let x = x0; x <= x1; x++) {
      this.px(x, y, c);
    }
  }

  /** A line of pixels from (x0, y0) to (x1, y1). */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, glow = false): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k++) {
      this.px(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), c, glow);
    }
  }

  done(): Sprite {
    return {
      w: this.w,
      h: this.h,
      ax: this.ax,
      ay: this.ay,
      rgb: this.rgb,
      alpha: this.alpha,
      glow: this.glow,
    };
  }
}

// Colors people wear and are.
const SKINS: RGB[] = [
  hex("#f0c8a0"),
  hex("#e2b088"),
  hex("#c89068"),
  hex("#a8704c"),
  hex("#f4d4b4"),
];
const HAIRS: RGB[] = [
  hex("#3a2a1e"),
  hex("#5a3a22"),
  hex("#8a5a2e"),
  hex("#c89a52"),
  hex("#a8462a"),
  hex("#2a2420"),
];
const CLOTHS: RGB[] = [
  hex("#7a5a3a"),
  hex("#5a6a3a"),
  hex("#3e5a7a"),
  hex("#8a3a2e"),
  hex("#b08a4a"),
  hex("#6a6a6a"),
  hex("#d8ccb0"),
  hex("#4a6a5a"),
  hex("#7a4a6a"),
  hex("#a86a3a"),
];
const LEGS: RGB[] = [
  hex("#4a3a2e"),
  hex("#3a3a44"),
  hex("#5a4a3a"),
  hex("#2e3a4a"),
  hex("#6a5a44"),
];
const SHOE: RGB = hex("#2e241c");
const IRON: RGB = hex("#8a8a92");
const WOOD: RGB = hex("#7a5a3a");
const WOOD_DARK: RGB = hex("#5a3e28");
const LOG: RGB = hex("#8a6440");
const LOG_END: RGB = hex("#c8a070");
const STONE: RGB = hex("#a8a298");
const SACK: RGB = hex("#c8b48a");
const STRAW: RGB = hex("#d8b860");
const FLAME: RGB = hex("#ffd070");
const FLAME_RED: RGB = hex("#ff8030");
const WATER: RGB = hex("#6a9ac8");
const BREAD: RGB = hex("#c8883a");
const WHITE: RGB = hex("#ece6d6");
const PURPLE: RGB = hex("#5a3a8a");
const MAGIC: RGB = hex("#c8a8ff");

/** How a person looks: what they wear, drawn from their seed, their trade and their age. */
export interface Look {
  skin: RGB;
  hair: RGB;
  top: RGB;
  legs: RGB;
  /** Long skirt or robe down to the feet. */
  robe: boolean;
  hat: "none" | "straw" | "hood" | "cap" | "helmet" | "wizard" | "kerchief";
  hatColor: RGB;
  apron: RGB | null;
  child: boolean;
  old: boolean;
}

export function lookOf(seed: number, female: boolean, job: string, age: number): Look {
  const h = (k: number) => hashU32(seed * 31 + k);
  const old = age >= 58;
  const child = age < 15;
  let top = CLOTHS[h(1) % CLOTHS.length];
  let legs = LEGS[h(2) % LEGS.length];
  let hat: Look["hat"] = "none";
  let hatColor = CLOTHS[h(3) % CLOTHS.length];
  let apron: RGB | null = null;
  let robe = female && !child ? h(4) % 5 !== 0 : false;
  if (female && robe) {
    legs = top;
    top = mix(top, WHITE, 0.25);
    if (h(5) % 3 === 0) {
      hat = "kerchief";
      hatColor = mix(CLOTHS[h(6) % CLOTHS.length], WHITE, 0.4);
    }
  }
  switch (job) {
    case "farmer":
      hat = h(7) % 2 === 0 ? "straw" : hat;
      hatColor = STRAW;
      break;
    case "guard":
      hat = "helmet";
      hatColor = IRON;
      top = hex("#6a2e2a");
      robe = false;
      legs = hex("#3a3a44");
      break;
    case "smith":
      apron = hex("#3e2e22");
      break;
    case "baker":
      apron = WHITE;
      hat = "cap";
      hatColor = WHITE;
      break;
    case "priest":
      top = hex("#2e2a30");
      legs = top;
      robe = true;
      hat = "none";
      break;
    case "wizard":
      top = hex("#34407a");
      legs = top;
      robe = true;
      hat = "wizard";
      hatColor = PURPLE;
      break;
    case "woodcutter":
      hat = h(8) % 3 === 0 ? "hood" : hat;
      hatColor = hex("#4a5a3a");
      break;
    case "shepherd":
      hat = "hood";
      hatColor = hex("#6a5a4a");
      break;
    case "trader":
      // A traveller's cloak in a strong dye, and a hat against the road's weather.
      top = [hex("#8a2e3a"), hex("#2e4a7a"), hex("#6a3a7a"), hex("#2e6a5a")][h(11) % 4];
      hat = "cap";
      hatColor = mix(top, hex("#2a2420"), 0.5);
      robe = false;
      break;
  }
  const hair = old
    ? mix(HAIRS[h(9) % HAIRS.length], hex("#c8c4bc"), 0.75)
    : HAIRS[h(9) % HAIRS.length];
  return {
    skin: SKINS[h(10) % SKINS.length],
    hair,
    top,
    legs,
    robe,
    hat,
    hatColor,
    apron,
    child,
    old,
  };
}

/** What a figure is doing, as far as its picture goes. */
export type Action =
  | "stand"
  | "walk"
  | "run"
  | "chop"
  | "hammer"
  | "saw"
  | "dig"
  | "hoe"
  | "reap"
  | "sow"
  | "chisel"
  | "throw"
  | "thrust"
  | "cast"
  | "sit"
  | "dance"
  | "fish"
  | "wave";

/** What a figure has in hand, as far as its picture goes. */
export type Held =
  | null
  | "log"
  | "logs"
  | "stone"
  | "sack"
  | "bucket"
  | "sheaf"
  | "basket"
  | "bundle"
  | "rubble"
  | "plank"
  | "torch"
  | "spear"
  | "bread"
  | "staff"
  | "rod";

/**
 * Draws a person: a head of two rows, a body of three, legs of two or three,
 * about eight pixels tall; turned to `facing`, in `frame` of what they are
 * doing (0..3), with what they hold.
 */
export function drawPerson(
  look: Look,
  facing: Facing,
  action: Action,
  frame: number,
  held: Held,
): Sprite {
  const c = new Canvas(13, 15, 6);
  const tall = look.child ? 0 : 1;
  const bend = look.old ? 1 : 0;
  const side = facing === "left" || facing === "right";
  const dir = facing === "left" ? -1 : 1;
  const sit = action === "sit";
  const crouch =
    action === "dig" || action === "hoe" || action === "sow" || action === "chisel" ? 1 : 0;
  // Legs.
  const legTop = sit ? 1 : 1 + tall;
  const stride = action === "walk" || action === "run" || action === "dance" ? frame % 4 : -1;
  const feet = look.robe ? look.legs : SHOE;
  if (sit) {
    if (side) {
      c.row(0, dir * 2, 0, look.legs);
    } else {
      c.px(0, 0, look.legs);
      c.px(1, 0, look.legs);
    }
  } else if (side) {
    const a = stride === 0 ? -1 : stride === 2 ? 1 : 0;
    const b = -a;
    for (let y = 1; y <= legTop; y++) {
      c.px(y === 1 ? a : 0, y, look.legs);
      c.px(y === 1 ? b : 0, y, look.legs);
    }
    c.px(a, 0, feet);
    c.px(b, 0, feet);
    if (look.robe) {
      c.row(-1, 1, 1, look.legs);
      c.row(-1, 1, 2, look.legs);
    }
  } else {
    const lift = stride === 1 ? 0 : stride === 3 ? 1 : -1;
    for (let y = 1; y <= legTop; y++) {
      c.px(0, y, look.legs);
      c.px(1, y, look.legs);
    }
    c.px(0, lift === 0 ? 1 : 0, feet);
    c.px(1, lift === 1 ? 1 : 0, feet);
    if (look.robe) {
      c.row(-1, 2, 1, look.legs);
      c.row(-1, 2, 2, look.legs);
      c.row(0, 1, 0, look.legs);
    }
  }
  // Body: shoulders, chest, waist.
  const y0 = legTop + 1 - crouch;
  const bodyRows = look.child ? 2 : 3;
  const shade = mix(look.top, [0, 0, 0], 0.25);
  for (let k = 0; k < bodyRows; k++) {
    const y = y0 + k;
    if (side) {
      c.px(0, y, look.top);
      c.px(-dir, y, k === 0 && bend ? look.top : shade);
      if (look.apron && k < 2) {
        c.px(dir, y, look.apron);
      }
    } else {
      c.px(0, y, look.top);
      c.px(1, y, look.top);
      if (k > 0) {
        c.px(-1, y, shade);
        c.px(2, y, shade);
      }
      if (look.apron && facing === "front" && k < 2) {
        c.px(0, y, look.apron);
        c.px(1, y, look.apron);
      }
    }
  }
  if (!look.child && !side) {
    // A belt at the waist.
    c.px(0, y0, mix(look.top, [40, 30, 20], 0.5));
    c.px(1, y0, mix(look.top, [40, 30, 20], 0.5));
  }
  // Head: face or the back of it, hair, and a hat.
  const headY = y0 + bodyRows - (bend && side ? 1 : 0);
  const hx = side ? (bend ? dir : 0) : 0;
  if (side) {
    c.px(hx, headY, look.skin);
    c.px(hx - dir, headY, look.hair);
    c.px(hx, headY + 1, look.hair);
    c.px(hx - dir, headY + 1, look.hair);
  } else if (facing === "front") {
    c.px(0, headY, look.skin);
    c.px(1, headY, look.skin);
    c.px(0, headY + 1, look.hair);
    c.px(1, headY + 1, look.hair);
    if (look.robe && !look.child && look.hat === "none") {
      c.px(-1, headY, look.hair);
      c.px(2, headY, look.hair);
    }
  } else {
    c.row(0, 1, headY, look.hair);
    c.row(0, 1, headY + 1, look.hair);
  }
  hat(c, look, facing, hx, headY + 1);
  // Arms, tools and loads by what they are doing.
  arms(c, look, facing, action, frame, held, y0, bodyRows, headY);
  return c.done();
}

function hat(c: Canvas, look: Look, facing: Facing, hx: number, top: number): void {
  const side = facing === "left" || facing === "right";
  const a = side ? hx - 1 : -1;
  const b = side ? hx + 1 : 2;
  switch (look.hat) {
    case "straw":
      c.row(a, b, top, look.hatColor);
      c.row(side ? hx : 0, side ? hx : 1, top + 1, look.hatColor);
      break;
    case "hood":
      c.row(side ? hx - 1 : 0, side ? hx : 1, top, look.hatColor);
      c.px(side ? hx - (facing === "left" ? -1 : 1) : -1, top - 1, look.hatColor);
      if (!side) {
        c.px(2, top - 1, look.hatColor);
      }
      break;
    case "cap":
    case "kerchief":
      c.row(side ? hx - 1 : 0, side ? hx : 1, top, look.hatColor);
      break;
    case "helmet":
      c.row(side ? hx - 1 : 0, side ? hx : 1, top, look.hatColor);
      c.px(side ? hx : 0, top + 1, look.hatColor);
      break;
    case "wizard":
      c.row(a, b, top, look.hatColor);
      c.row(side ? hx - 1 : 0, side ? hx : 1, top + 1, look.hatColor);
      c.px(side ? hx : 0, top + 2, look.hatColor);
      c.px(side ? hx + (facing === "left" ? -1 : 1) : 1, top + 3, look.hatColor);
      break;
    case "none":
      break;
  }
}

/** Arms and whatever is in hand, posed for the action and its frame. */
function arms(
  c: Canvas,
  look: Look,
  facing: Facing,
  action: Action,
  frame: number,
  held: Held,
  y0: number,
  rows: number,
  headY: number,
): void {
  const side = facing === "left" || facing === "right";
  const dir = facing === "left" ? -1 : 1;
  const hand = look.skin;
  const sleeve = mix(look.top, [0, 0, 0], 0.15);
  const shoulder = y0 + rows - 1;
  // The side of the body the working arm is on, on screen.
  const ax = side ? dir : 2;
  const up = frame % 2 === 0;
  const tool = (x0: number, y0t: number, x1: number, y1: number, head: RGB, handle = WOOD) => {
    c.line(x0, y0t, x1, y1, handle);
    c.px(x1, y1, head);
  };
  switch (action) {
    case "chop": {
      // The axe up over the head, then down to the trunk.
      if (up) {
        c.px(ax, shoulder + 1, hand);
        tool(ax, shoulder + 1, ax + (side ? -dir : 0), headY + 2, IRON);
      } else {
        c.px(ax, shoulder - 1, hand);
        tool(ax, shoulder - 1, ax + (side ? dir * 2 : 1), shoulder - 2, IRON);
      }
      return;
    }
    case "hammer":
    case "chisel": {
      c.px(ax, up ? shoulder + 1 : shoulder, hand);
      const hy = up ? shoulder + 2 : shoulder - 1;
      tool(ax, up ? shoulder + 1 : shoulder, ax + (side ? dir : 1), hy, IRON);
      if (action === "chisel") {
        c.px(side ? dir * 2 : -1, shoulder - 1, IRON);
      }
      return;
    }
    case "saw": {
      const reach = up ? 1 : 2;
      c.px(side ? dir * reach : ax, shoulder - 1, hand);
      c.line(
        side ? dir * reach : ax,
        shoulder - 1,
        side ? dir * (reach + 2) : ax + 1,
        shoulder - 2,
        IRON,
      );
      return;
    }
    case "dig":
    case "hoe": {
      // Bent over the blade, driving it into the ground.
      c.px(ax, shoulder - 1, hand);
      tool(ax, shoulder, ax + (side ? dir * (up ? 1 : 2) : 0), up ? 1 : 0, IRON);
      return;
    }
    case "reap": {
      // The scythe swinging low across.
      c.px(ax, shoulder - 1, hand);
      const sx = side ? dir * (up ? 1 : 3) : up ? -2 : 3;
      c.line(ax, shoulder, sx, 1, WOOD);
      c.row(
        Math.min(sx, sx + (side ? dir : 1) * 2),
        Math.max(sx, sx + (side ? dir : 1) * 2),
        1,
        IRON,
      );
      return;
    }
    case "sow": {
      c.px(ax, up ? shoulder : shoulder - 1, hand);
      if (!up) {
        c.px(ax + (side ? dir : 1), shoulder - 2, STRAW);
      }
      c.px(side ? -dir : -1, shoulder - 1, SACK);
      return;
    }
    case "throw": {
      // Arm back, then flung forward: a bucket's water or a spear at a raider.
      c.px(ax, shoulder + (up ? 1 : 0), hand);
      if (held === "bucket" && !up) {
        c.px(ax + (side ? dir : 0), shoulder + 1, WATER);
        c.px(ax + (side ? dir * 2 : 1), shoulder + 2, WATER);
      }
      return;
    }
    case "thrust": {
      const reach = up ? 1 : 3;
      c.px(side ? dir : ax, shoulder - 1, hand);
      if (held === "torch") {
        c.line(side ? dir : ax, shoulder - 1, side ? dir * reach : ax + 1, shoulder, WOOD);
        c.px(side ? dir * reach : ax + 1, shoulder + 1, FLAME, true);
      } else {
        c.line(
          side ? dir * (reach - 3) : ax,
          shoulder - 1,
          side ? dir * (reach + 1) : ax,
          shoulder + 3,
          WOOD,
        );
        c.px(side ? dir * (reach + 1) : ax, shoulder + 4, IRON);
      }
      return;
    }
    case "cast": {
      // Arms raised, the staff aglow.
      c.px(-1, shoulder + 1, hand);
      c.px(2, shoulder + 1, hand);
      c.line(ax, shoulder, ax, headY + 3, WOOD_DARK);
      c.px(ax, headY + 4, up ? MAGIC : WHITE, true);
      return;
    }
    case "dance":
    case "wave": {
      c.px(-1, shoulder + (up ? 1 : 0), hand);
      c.px(2, shoulder + (up ? 0 : 1), hand);
      break;
    }
    case "fish": {
      c.px(ax, shoulder - 1, hand);
      c.line(ax, shoulder - 1, ax + (side ? dir * 4 : 3), headY + 2, WOOD);
      c.line(ax + (side ? dir * 4 : 3), headY + 2, ax + (side ? dir * 5 : 4), 0, WHITE);
      return;
    }
    default:
      break;
  }
  // Arms hanging, or holding a load.
  switch (held) {
    case "log":
    case "logs":
    case "plank": {
      // Over the shoulder, sticking out front and back.
      const y = shoulder + 1;
      const color = held === "plank" ? hex("#b08a5a") : LOG;
      if (side) {
        c.row(-3, 3, y, color);
        c.px(3 * dir, y, LOG_END);
        if (held === "logs") {
          c.row(-3, 3, y + 1, color);
          c.px(3 * dir, y + 1, LOG_END);
        }
      } else {
        c.row(-1, 2, y, color);
        c.px(0, y, facing === "front" ? LOG_END : color);
        if (held === "logs") {
          c.row(-1, 2, y + 1, color);
        }
      }
      c.px(ax, shoulder, hand);
      return;
    }
    case "stone":
    case "rubble":
      c.px(side ? dir : -1, shoulder - 1, hand);
      c.px(side ? dir : 2, shoulder - 1, hand);
      c.row(
        side ? dir : -1,
        side ? dir * 2 : 2,
        shoulder,
        held === "rubble" ? hex("#6a625a") : STONE,
      );
      return;
    case "sack":
    case "bundle":
    case "sheaf": {
      // On the back.
      const color = held === "sheaf" ? STRAW : held === "sack" ? SACK : hex("#8a6a4a");
      if (side) {
        c.px(-dir, shoulder, color);
        c.px(-dir, shoulder + 1, color);
        c.px(-dir * 2, shoulder, color);
      } else {
        c.row(-1, 2, shoulder + 1, color);
        if (facing === "back") {
          c.row(0, 1, shoulder, color);
          c.row(0, 1, shoulder - 1, color);
        }
      }
      c.px(ax, shoulder - 1, hand);
      return;
    }
    case "bucket":
    case "basket":
    case "bread": {
      c.px(ax, shoulder - 1, hand);
      const color = held === "bucket" ? WOOD_DARK : held === "bread" ? BREAD : STRAW;
      c.px(ax + (side ? 0 : 0), shoulder - 2, color);
      c.px(ax + (side ? dir : 1), shoulder - 2, color);
      return;
    }
    case "torch":
      c.px(ax, shoulder, hand);
      c.line(ax, shoulder, ax, shoulder + 2, WOOD);
      c.px(ax, shoulder + 3, frame % 2 === 0 ? FLAME : FLAME_RED, true);
      c.px(ax, shoulder + 4, FLAME, true);
      return;
    case "spear":
    case "staff":
    case "rod":
      c.px(ax, shoulder - 1, hand);
      c.line(ax, 0, ax, headY + 3, held === "staff" ? WOOD_DARK : WOOD);
      if (held === "spear") {
        c.px(ax, headY + 4, IRON);
      } else if (held === "staff") {
        c.px(ax, headY + 4, MAGIC, true);
      }
      return;
    default: {
      // Hands at the sides, swinging a little as they walk.
      const swing = action === "walk" || action === "run" ? (frame % 2 === 0 ? 1 : 0) : 0;
      if (side) {
        c.px(swing ? dir : 0, shoulder - 1, sleeve);
        c.px(swing ? dir : 0, shoulder - 2, hand);
      } else {
        c.px(-1, shoulder - 1 - swing, hand);
        c.px(2, shoulder - 2 + swing, hand);
      }
    }
  }
}

/** The build and coat of a four-legged beast, in pixels (1 px ≈ 0.2 m across, 0.24 m up). */
interface Build {
  /** Body length side-on, and width head-on. */
  len: number;
  wide: number;
  /** Rows of leg under the body, and rows of body. */
  legs: number;
  body: number;
  /** Head size side-on (columns, rows), and the row its lowest pixel sits on when held up. */
  head: [number, number];
  headUp: number;
  /** Tail length (px) and whether it hangs down or is carried up. */
  tail: number;
  tailUp: boolean;
  coat: RGB;
  /** Belly and legs, the back in the light, and the face. */
  shade: RGB;
  light: RGB;
  face: RGB;
}

/**
 * Draws a four-legged beast side-on or head-on: legs that step in turn when
 * walking and stretch out when running, a head held up or down to graze.
 * Returns where its head is, for horns, eyes and the like.
 */
function beast(
  c: Canvas,
  b: Build,
  facing: Facing,
  step: number,
  pose: string,
): { hx: number; hy: number; dir: number } {
  const side = facing === "left" || facing === "right";
  const dir = facing === "left" ? -1 : 1;
  const run = pose === "run" || pose === "attack";
  const walk = pose === "walk";
  const low = pose === "graze" || pose === "attack";
  const sit = pose === "sit";
  const top = b.legs + b.body - 1;
  if (side) {
    const x0 = -Math.floor(b.len / 2);
    const x1 = x0 + b.len - 1;
    const X = (x: number) => x * dir;
    // Legs: the far pair a shade darker; in step when walking, stretched fore and aft when running.
    const reach = run ? 1 : 0;
    const legsAt = [
      { x: x0 + (run && step ? -reach : 0), far: false, lift: walk && step === 0 },
      { x: x0 + 1 + (run && !step ? reach : 0), far: true, lift: walk && step === 1 },
      { x: x1 - 1 - (run && step ? reach : 0), far: true, lift: walk && step === 0 },
      { x: x1 + (run && !step ? reach : 0), far: false, lift: walk && step === 1 },
    ];
    for (const [k, leg] of legsAt.entries()) {
      if (sit && k < 2) {
        continue;
      }
      const color = leg.far ? mix(b.shade, [0, 0, 0], 0.25) : b.shade;
      for (let y = leg.lift ? 1 : 0; y < b.legs; y++) {
        c.px(X(leg.x), y, color);
      }
    }
    // Body, lower at the haunches when sitting.
    for (let x = x0; x <= x1; x++) {
      const drop = sit && x < x0 + Math.ceil(b.len / 2) ? b.legs - 1 : 0;
      for (let y = b.legs; y <= top; y++) {
        const color = y === b.legs ? b.shade : y === top ? b.light : b.coat;
        c.px(X(x), y - drop, color);
      }
    }
    // Rounded ends.
    c.px(X(x0), top - (sit ? b.legs - 1 : 0), null);
    c.px(X(x1), top, b.coat);
    // Tail.
    const drop = sit ? b.legs - 1 : 0;
    for (let k = 0; k < b.tail; k++) {
      c.px(X(x0 - 1), (b.tailUp ? top + k : top - 1 - k) - drop, b.shade);
    }
    // Neck and head, forward of the shoulders.
    const [hw, hh] = b.head;
    const hy = low ? Math.max(0, b.legs - 1) : b.headUp;
    const hx0 = x1 + 1;
    for (let x = hx0; x < hx0 + hw; x++) {
      for (let y = hy; y < hy + hh; y++) {
        c.px(X(x), y, x === hx0 + hw - 1 && y === hy ? b.face : b.coat);
      }
    }
    if (low) {
      // The neck, down to the grass.
      for (let y = hy + hh; y <= top - 1; y++) {
        c.px(X(x1), y, b.coat);
        c.px(X(hx0), y, b.coat);
      }
    } else if (hy > top) {
      c.px(X(hx0), top, b.coat);
    }
    return { hx: X(hx0 + hw - 1), hy: hy + hh - 1, dir };
  }
  // Head-on or from behind: seen from above, the back runs away up the picture behind the chest or rump.
  const x0 = -Math.floor((b.wide - 1) / 2);
  const x1 = x0 + b.wide - 1;
  const back = Math.max(1, Math.round(b.len * 0.45));
  for (const x of [x0, x1]) {
    for (let y = walk && (x === x0) === (step === 0) ? 1 : 0; y < b.legs; y++) {
      c.px(x, y, b.shade);
    }
  }
  for (let y = b.legs; y <= top + back; y++) {
    // The far end of the back narrows a little.
    const inset = y > top + back - 1 && b.wide > 3 ? 1 : 0;
    for (let x = x0 + inset; x <= x1 - inset; x++) {
      const edge = x === x0 + inset || x === x1 - inset;
      const color = y > top ? (edge ? b.coat : b.light) : edge ? b.shade : b.coat;
      c.px(x, y, color);
    }
  }
  const [hw0, hh] = b.head;
  const hw = Math.min(hw0, b.wide);
  const hx0 = x0 + Math.floor((b.wide - hw) / 2);
  let hy: number;
  if (facing === "front") {
    hy = low ? Math.max(0, b.legs - 1) : Math.max(b.legs, b.headUp - 1);
    for (let x = hx0; x < hx0 + hw; x++) {
      for (let y = hy; y < hy + hh; y++) {
        c.px(x, y, y === hy ? b.face : b.coat);
      }
    }
  } else {
    // The head beyond the far end of the back, and the tail hanging over the rump.
    hy = top + back + (low ? 0 : 1);
    for (let x = hx0; x < hx0 + hw; x++) {
      c.px(x, hy, b.coat);
    }
    const tx = Math.round((x0 + x1) / 2);
    for (let k = 0; k < b.tail; k++) {
      c.px(tx, b.tailUp ? top + 1 + k : top - k, b.shade);
    }
  }
  return { hx: hx0, hy: facing === "front" ? hy + hh - 1 : hy, dir: 0 };
}

/** Animals, side-on or head-on, in two frames. */
export function drawAnimal(
  kind: string,
  facing: Facing,
  frame: number,
  pose: string,
  seed: number,
): Sprite {
  const c = new Canvas(19, 13, 9);
  const side = facing === "left" || facing === "right";
  const dir = facing === "left" ? -1 : 1;
  const step = frame % 2;
  switch (kind) {
    case "sheep": {
      const wool = pose === "run" ? hex("#e8e2d2") : hex("#ece6d8");
      beast(
        c,
        {
          len: 6,
          wide: 4,
          legs: 2,
          body: 3,
          head: [2, 2],
          headUp: 3,
          tail: 1,
          tailUp: false,
          coat: wool,
          shade: mix(wool, hex("#8a8070"), 0.35),
          light: hex("#f8f4ea"),
          face: hex("#3a342e"),
        },
        facing,
        step,
        pose,
      );
      return c.done();
    }
    case "cow": {
      const brown = (seed & 1) === 1;
      const coat = brown ? hex("#8a5a3a") : hex("#e6e0d4");
      const patch = brown ? hex("#e6e0d4") : hex("#2e2a26");
      const head = beast(
        c,
        {
          len: 10,
          wide: 5,
          legs: 2,
          body: 4,
          head: [2, 2],
          headUp: 4,
          tail: 3,
          tailUp: false,
          coat,
          shade: mix(coat, [0, 0, 0], 0.22),
          light: mix(coat, [255, 255, 255], 0.18),
          face: hex("#d8b8a0"),
        },
        facing,
        step,
        pose,
      );
      // Patches on the flank, where the seed puts them.
      if (facing === "left" || facing === "right") {
        for (let k = 0; k < 4; k++) {
          const x = ((seed * 7 + k * 5) % 7) - 3;
          const y = 3 + ((seed + k) % 2);
          c.px(x * head.dir, y, patch);
          c.px((x + 1) * head.dir, y, patch);
        }
        c.px(head.hx - head.dir, head.hy + 1, hex("#e0d8c0"));
      } else {
        c.px(-1, 4, patch);
        c.px(1, 3, patch);
        c.px(-2, head.hy + 1, hex("#e0d8c0"));
        c.px(2, head.hy + 1, hex("#e0d8c0"));
      }
      return c.done();
    }
    case "chicken": {
      const feather = (seed & 3) === 0 ? hex("#8a5a2e") : hex("#ece6d8");
      c.px(0, 0, feather);
      c.px(side ? -dir : 1, 0, feather);
      c.px(
        side ? (pose === "graze" && step ? dir : 0) : 0,
        pose === "graze" && step ? 0 : 1,
        feather,
      );
      c.px(
        side ? (pose === "graze" && step ? dir : 0) : 0,
        pose === "graze" && step ? 1 : 2,
        hex("#c83a2a"),
      );
      return c.done();
    }
    case "dog": {
      const coat = [hex("#8a6a4a"), hex("#3a3230"), hex("#c8a878")][seed % 3];
      const head = beast(
        c,
        {
          len: 5,
          wide: 3,
          legs: 2,
          body: 2,
          head: [2, 2],
          headUp: 3,
          tail: 2,
          tailUp: pose !== "sit",
          coat,
          shade: mix(coat, [0, 0, 0], 0.25),
          light: mix(coat, [255, 255, 255], 0.15),
          face: mix(coat, [0, 0, 0], 0.45),
        },
        facing,
        step,
        pose,
      );
      // An ear.
      if (head.dir !== 0) {
        c.px(head.hx - head.dir, head.hy + 1, mix(coat, [0, 0, 0], 0.3));
      }
      return c.done();
    }
    case "crow": {
      const black = hex("#1e1c22");
      if (pose === "fly") {
        c.px(0, 0, black);
        c.px(-1, step ? 1 : 0, black);
        c.px(1, step ? 1 : 0, black);
        c.px(-2, step ? 2 : 0, black);
        c.px(2, step ? 2 : 0, black);
      } else {
        c.px(0, 0, black);
        c.px(side ? dir : 1, pose === "graze" && step ? 0 : 1, black);
      }
      return c.done();
    }
    case "duck": {
      const body = hex("#8a6a4a");
      c.row(-1, 1, 0, body);
      c.px(side ? dir : 0, 1, hex("#2a5a3a"));
      c.px(side ? dir * 2 : 1, 1, hex("#d8a030"));
      return c.done();
    }
    case "ox": {
      const coat = [hex("#6a4a32"), hex("#8a6a4a"), hex("#5a4a42")][seed % 3];
      const horn = hex("#e0d8c0");
      const head = beast(
        c,
        {
          len: 11,
          wide: 5,
          legs: 3,
          body: 4,
          head: [2, 3],
          headUp: 4,
          tail: 3,
          tailUp: false,
          coat,
          shade: mix(coat, [0, 0, 0], 0.25),
          light: mix(coat, [255, 255, 255], 0.15),
          face: mix(coat, [255, 255, 255], 0.3),
        },
        facing,
        step,
        pose,
      );
      // Horns, and the yoke across the neck.
      const yoke = hex("#5e4430");
      if (head.dir !== 0) {
        c.px(head.hx - head.dir, head.hy + 1, horn);
        c.px(head.hx - head.dir * 2, head.hy + 1, horn);
        c.px(head.hx - head.dir * 2, head.hy, yoke);
        c.px(head.hx - head.dir * 2, head.hy - 1, yoke);
      } else if (facing === "front") {
        c.px(-2, head.hy + 1, horn);
        c.px(2, head.hy + 1, horn);
      }
      return c.done();
    }
  }
  return c.done();
}

/** A dark edge round raiders, so they stand out from whatever ground they cross. */
const MONSTER_EDGE: RGB = hex("#160c0a");

/** Rings the drawn figure with one pixel of `c` wherever a clear pixel touches it. */
function outline(canvas: Canvas, c: RGB): void {
  const { w, h, alpha } = canvas;
  const edge: number[] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (alpha[k] !== 0) {
        continue;
      }
      const solid = (ii: number, jj: number) =>
        ii >= 0 &&
        jj >= 0 &&
        ii < w &&
        jj < h &&
        alpha[jj * w + ii] !== 0 &&
        canvas.glow[jj * w + ii] === 0;
      if (solid(i - 1, j) || solid(i + 1, j) || solid(i, j - 1) || solid(i, j + 1)) {
        edge.push(k);
      }
    }
  }
  for (const k of edge) {
    canvas.rgb[k * 3] = c[0];
    canvas.rgb[k * 3 + 1] = c[1];
    canvas.rgb[k * 3 + 2] = c[2];
    canvas.alpha[k] = 200;
  }
}

/** What a goblin holds up at (x, y): a spear, or a torch alight. */
function weapon(
  c: Canvas,
  x: number,
  y: number,
  torch: boolean,
  step: number,
  attack: boolean,
): void {
  if (torch) {
    c.line(x, y - 1, x, y + 2, WOOD);
    c.px(x, y + 3, step ? FLAME : FLAME_RED, true);
    c.px(x, y + 4, FLAME, true);
    c.px(x + (step ? 1 : -1), y + 4, FLAME_RED, true, 180);
    c.px(x, y + 5, step ? FLAME_RED : FLAME, true, 200);
    return;
  }
  const lean = attack ? 1 : 0;
  c.line(x, y - 3, x + lean, y + 4, WOOD_DARK);
  c.px(x + lean, y + 5, IRON);
}

/** Raiders: gray wolves, green goblins in rags, great gray ogres with clubs. */
export function drawMonster(
  kind: string,
  facing: Facing,
  frame: number,
  pose: string,
  torch: boolean,
): Sprite {
  const c = new Canvas(17, 17, 8);
  const side = facing === "left" || facing === "right";
  const dir = facing === "left" ? -1 : 1;
  const step = frame % 2;
  switch (kind) {
    case "wolf": {
      const fur = hex("#6a6a72");
      const dark = hex("#3e3e46");
      const eye = hex("#e8d040");
      const head = beast(
        c,
        {
          len: 7,
          wide: 3,
          legs: 2,
          body: 3,
          head: [3, 2],
          headUp: 3,
          tail: 2,
          tailUp: false,
          coat: fur,
          shade: dark,
          light: hex("#8a8a92"),
          face: hex("#2a2a30"),
        },
        facing,
        step,
        pose,
      );
      // Pricked ears, and eyes that catch the light.
      if (head.dir !== 0) {
        c.px(head.hx - head.dir * 2, head.hy + 1, dark);
        c.px(head.hx - head.dir, head.hy, eye, true, 200);
      } else if (facing === "front") {
        c.px(-1, head.hy + 1, dark);
        c.px(1, head.hy + 1, dark);
        c.px(-1, head.hy, eye, true, 200);
        c.px(1, head.hy, eye, true, 200);
      } else {
        c.px(-1, head.hy + 1, dark);
        c.px(1, head.hy + 1, dark);
      }
      outline(c, MONSTER_EDGE);
      return c.done();
    }
    case "goblin": {
      // Hunched, big-eared, eyes that glow; rags, and a spear or a torch.
      const skin = pose === "hurt" ? hex("#c8e0a0") : hex("#86b03c");
      const skinDark = hex("#557a26");
      const rags = hex("#5e3c22");
      const ragsDark = hex("#3a2616");
      const eye = hex("#ff3a1a");
      const moving = pose === "walk" || pose === "run";
      const reach = pose === "run" ? 2 : 1;
      if (side) {
        const X = (x: number) => x * dir;
        // Legs: striding in turn.
        const back = moving ? (step ? -reach : 0) : 0;
        const front = moving ? (step ? 0 : reach) : 1;
        c.px(X(back), 0, ragsDark);
        c.px(X(front), 0, ragsDark);
        c.px(X(Math.round(back / 2)), 1, skinDark);
        c.px(X(Math.round(front / 2)), 1, skinDark);
        c.row(Math.min(X(-1), X(1)), Math.max(X(-1), X(1)), 2, ragsDark);
        c.row(Math.min(X(-1), X(1)), Math.max(X(-1), X(1)), 3, rags);
        // Shoulders hunched forward, the head thrust out ahead of them.
        c.px(X(0), 4, rags);
        c.px(X(1), 4, rags);
        c.px(X(1), 5, skin);
        c.px(X(2), 5, skin);
        c.px(X(1), 6, skin);
        c.px(X(2), 6, skinDark);
        c.px(X(2), 6, eye, true, 230);
        c.px(X(3), 5, hex("#e8e0c8"));
        // A long ear laid back.
        c.px(X(0), 6, skinDark);
        c.px(X(-1), 7, skin);
        c.px(X(-2), 7, skinDark);
        // The arm forward to what it holds.
        c.px(X(2), 4, skinDark);
        const lift = pose === "attack" && step ? 2 : 0;
        weapon(c, X(3), 3 + lift, torch, step, pose === "attack");
      } else {
        const front = facing === "front";
        const lift = moving ? (step ? 0 : 1) : -1;
        c.px(-1, lift === 0 ? 1 : 0, ragsDark);
        c.px(1, lift === 1 ? 1 : 0, ragsDark);
        c.px(-1, 1, skinDark);
        c.px(1, 1, skinDark);
        c.row(-1, 1, 2, ragsDark);
        c.row(-1, 1, 3, rags);
        c.row(-1, 1, 4, rags);
        c.px(-2, 3, skinDark);
        c.px(2, 3, skinDark);
        c.row(-1, 1, 5, skin);
        c.row(-1, 1, 6, front ? skin : skinDark);
        c.px(0, 7, skin);
        // Ears out to the sides, tips up.
        c.px(-2, 6, skinDark);
        c.px(-3, 7, skin);
        c.px(2, 6, skinDark);
        c.px(3, 7, skin);
        if (front) {
          c.px(-1, 6, eye, true, 230);
          c.px(1, 6, eye, true, 230);
          c.px(0, 5, hex("#2a1a10"));
        }
        const lift2 = pose === "attack" && step ? 2 : 0;
        weapon(c, 3, 3 + lift2, torch, step, pose === "attack");
      }
      outline(c, MONSTER_EDGE);
      return c.done();
    }
    case "ogre": {
      // Half again as tall as a man: a great belly, a small head with tusks, a club.
      const skin = pose === "hurt" ? hex("#c8d0b8") : hex("#8a9478");
      const skinDark = hex("#5c6450");
      const belly = hex("#a0a88a");
      const cloth = hex("#5a3e2a");
      const tusk = hex("#ece4cc");
      const eye = hex("#ff5030");
      const moving = pose === "walk" || pose === "run";
      const swing = pose === "attack" && step;
      if (side) {
        const X = (x: number) => x * dir;
        const lo = (a: number, b: number) => Math.min(X(a), X(b));
        const hi = (a: number, b: number) => Math.max(X(a), X(b));
        const stride = moving ? (step ? 1 : -1) : 0;
        // Legs like tree trunks.
        for (let y = 0; y <= 3; y++) {
          c.row(lo(-2 - stride, -1 - stride), hi(-2 - stride, -1 - stride), y, skinDark);
          c.row(lo(stride, 1 + stride), hi(stride, 1 + stride), y, skin);
        }
        c.row(lo(-2, 2), hi(-2, 2), 4, cloth);
        c.row(lo(-2, 2), hi(-2, 2), 5, cloth);
        for (let y = 6; y <= 9; y++) {
          c.row(lo(-3, 2), hi(-3, 2), y, skin);
        }
        c.row(lo(1, 3), hi(1, 3), 6, belly);
        c.row(lo(1, 3), hi(1, 3), 7, belly);
        c.row(lo(-2, 2), hi(-2, 2), 10, skinDark);
        // Head low and forward, tusks jutting.
        c.row(lo(1, 2), hi(1, 2), 11, skin);
        c.row(lo(1, 2), hi(1, 2), 12, skin);
        c.px(X(3), 11, tusk);
        c.px(X(2), 12, eye, true, 220);
        // The club: hanging, or swung up over the head.
        const hand = X(3);
        c.px(hand, 8, skinDark);
        c.px(hand, 7, skin);
        if (swing) {
          c.line(hand, 7, hand + X(1), 13, WOOD_DARK);
          c.row(lo(1, 2) + (dir > 0 ? 3 : -3), hi(1, 2) + (dir > 0 ? 3 : -3), 14, WOOD_DARK);
        } else {
          c.line(hand + X(1), 6, hand + X(1), 1, WOOD_DARK);
          c.row(lo(4, 5), hi(4, 5), 0, WOOD);
          c.row(lo(4, 5), hi(4, 5), 1, WOOD);
        }
      } else {
        const front = facing === "front";
        const stride = moving ? (step ? 1 : 0) : 0;
        // Legs: one foot lifted, then the other.
        for (let y = 0; y <= 3; y++) {
          if (y > 0 || !stride) {
            c.row(-3, -1, y, skinDark);
          }
          if (y > 0 || stride || !moving) {
            c.row(1, 3, y, skin);
          }
        }
        c.row(-3, 3, 4, cloth);
        c.row(-3, 3, 5, cloth);
        for (let y = 6; y <= 9; y++) {
          c.row(-4, 4, y, skin);
        }
        if (front) {
          c.row(-2, 2, 6, belly);
          c.row(-2, 2, 7, belly);
        }
        c.row(-3, 3, 10, skinDark);
        c.row(-1, 1, 11, skin);
        c.row(-1, 1, 12, skin);
        if (front) {
          c.px(-1, 12, eye, true, 220);
          c.px(1, 12, eye, true, 220);
          c.px(-1, 11, tusk);
          c.px(1, 11, tusk);
        }
        if (swing) {
          c.line(5, 7, 6, 13, WOOD_DARK);
          c.row(5, 7, 14, WOOD_DARK);
        } else {
          c.line(5, 7, 5, 2, WOOD_DARK);
          c.row(5, 6, 1, WOOD);
          c.row(5, 6, 0, WOOD);
        }
      }
      outline(c, MONSTER_EDGE);
      return c.done();
    }
  }
  return c.done();
}
