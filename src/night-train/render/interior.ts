import { hex, pack, type RGB } from "../core/color.ts";
import { smoothstep } from "../core/math.ts";
import { hash2 } from "../core/random.ts";
import { Surface } from "../core/surface.ts";
import { drawClock } from "./clock-display.ts";
import type { Layout, Rect } from "./layout.ts";

const WALL: RGB = hex("#d8caa9");
const WALL_SHADE: RGB = hex("#bfae8c");
const WAINSCOT: RGB = hex("#6e5139");
const WOOD_TOP: RGB = hex("#b58d5f");
const WOOD_EDGE: RGB = hex("#7b5a3b");
const FRAME: RGB = hex("#b9bec4");
const CURTAIN: RGB = hex("#2e3d66");
const TIEBACK: RGB = hex("#c9a24a");
const CHROME: RGB = hex("#c9cdd2");
const GRILLE_DARK: RGB = hex("#3c2e22");
const BRASS: RGB = hex("#b8964a");
const SHADE: RGB = hex("#efe3c6");
const WARM: RGB = [255, 222, 178];
const NIGHT_LIGHT: RGB = [10, 12, 22];

export interface InteriorFrame {
  /** Car lights on. */
  lampOn: number;
  /** Average color of the view outside, which lights the car through the window. */
  outside: RGB;
  /** Vertical jolt in pixels, for things on the table. */
  jolt: number;
  /** Train acceleration, tilting the tea in the bottle. */
  traction: number;
  /** Text for the dot-matrix clock. */
  time: string;
  seasonIndex: number;
  /** Real seconds, for the lamp flicker and the clock's glow. */
  seconds: number;
  sillSnow: number;
}

function inRoundedRect(x: number, y: number, r: Rect, radius: number): boolean {
  if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) {
    return false;
  }
  const cx = x < r.x + radius ? r.x + radius : x >= r.x + r.w - radius ? r.x + r.w - radius - 1 : x;
  const cy = y < r.y + radius ? r.y + radius : y >= r.y + r.h - radius ? r.y + r.h - radius - 1 : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius + 0.5;
}

/**
 * The inside of the car: a static albedo image lit every frame by the car
 * lights and by whatever light comes in through the window.
 */
export class Interior {
  readonly layout: Layout;
  readonly albedo: Surface;
  /** 1 where the interior covers the screen (everything but the visible glass). */
  readonly mask: Uint8Array;
  private readonly lampLight: Float32Array;
  private readonly windowLight: Float32Array;
  private readonly glassRadius = 3;

  constructor(layout: Layout) {
    this.layout = layout;
    const { width, height } = layout;
    this.albedo = new Surface(width, height);
    this.mask = new Uint8Array(width * height);
    this.lampLight = new Float32Array(width * height);
    this.windowLight = new Float32Array(width * height);
    this.paint();
    this.computeLight();
  }

  /** Whether a screen pixel shows the glass (and the view). */
  isGlass(x: number, y: number): boolean {
    return (
      inRoundedRect(x, y, this.layout.window, this.glassRadius) &&
      this.mask[y * this.layout.width + x] === 0
    );
  }

  private paint(): void {
    const { width, height, window: win, table, curtain } = this.layout;
    const a = this.albedo;
    const mask = this.mask;
    mask.fill(1);
    const set = (x: number, y: number, c: RGB) => {
      if (x >= 0 && y >= 0 && x < width && y < height) {
        a.data[y * width + x] = pack(c[0], c[1], c[2]);
        mask[y * width + x] = 1;
      }
    };
    const fill = (x0: number, y0: number, x1: number, y1: number, c: RGB) => {
      for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
          set(x, y, c);
        }
      }
    };

    // Walls: cream above, wood wainscot below the table.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const panelSeam = x % 48 === 0 ? 0.93 : 1;
        const v = 0.96 + hash2(x, y) * 0.04;
        const t = y / height;
        const c: RGB = [
          WALL[0] * v * panelSeam * (1 - t * 0.08),
          WALL[1] * v * panelSeam * (1 - t * 0.08),
          WALL[2] * v * panelSeam * (1 - t * 0.08),
        ];
        set(x, y, c);
      }
    }
    const wainTop = table.y + table.h;
    for (let y = wainTop; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const grain = 0.9 + 0.1 * Math.sin(x * 0.7 + Math.sin(y * 0.3) * 2) + hash2(x, y) * 0.05;
        set(x, y, [WAINSCOT[0] * grain, WAINSCOT[1] * grain, WAINSCOT[2] * grain]);
      }
    }
    // Heater grille under the window.
    const grilleTop = wainTop + Math.max(3, Math.round((height - wainTop) * 0.3));
    const grilleBottom = Math.min(
      height - 2,
      grilleTop + Math.max(4, Math.round((height - wainTop) * 0.35)),
    );
    for (let y = grilleTop; y < grilleBottom; y++) {
      const slat = (y - grilleTop) % 2 === 0;
      fill(
        win.x + 4,
        y,
        win.x + win.w - 4,
        y + 1,
        slat ? GRILLE_DARK : [WAINSCOT[0] * 0.8, WAINSCOT[1] * 0.8, WAINSCOT[2] * 0.8],
      );
    }

    // Luggage rack along the top.
    const rackY = Math.max(1, Math.round(win.y * 0.2));
    fill(0, 0, width, rackY + 3, WALL_SHADE);
    fill(0, rackY, width, rackY + 1, CHROME);
    fill(0, rackY + 2, width, rackY + 3, [CHROME[0] * 0.85, CHROME[1] * 0.85, CHROME[2] * 0.85]);
    fill(0, rackY + 3, width, rackY + 4, [WALL[0] * 0.8, WALL[1] * 0.8, WALL[2] * 0.8]);
    for (let x = 12; x < width; x += 56) {
      fill(x, 0, x + 2, rackY + 4, CHROME);
    }

    // Window frame: brushed aluminum with a lit top edge and a shadowed inner lip.
    const ft = Math.max(3, Math.round(Math.min(width, height) / 60));
    const outer: Rect = { x: win.x - ft, y: win.y - ft, w: win.w + ft * 2, h: win.h + ft * 2 };
    for (let y = outer.y; y < outer.y + outer.h; y++) {
      for (let x = outer.x; x < outer.x + outer.w; x++) {
        if (!inRoundedRect(x, y, outer, ft + 3)) {
          continue;
        }
        if (inRoundedRect(x, y, win, this.glassRadius)) {
          mask[y * width + x] = 0;
          continue;
        }
        const top = y < win.y;
        const bottom = y >= win.y + win.h;
        const dIn = Math.min(
          Math.abs(x - win.x),
          Math.abs(x - (win.x + win.w - 1)),
          Math.abs(y - win.y),
          Math.abs(y - (win.y + win.h - 1)),
        );
        let k = top ? 1.08 : bottom ? 0.86 : 0.97;
        if (dIn <= 1) {
          k *= 0.72;
        }
        if (x === outer.x || y === outer.y) {
          k *= 1.12;
        }
        set(x, y, [FRAME[0] * k, FRAME[1] * k, FRAME[2] * k]);
      }
    }
    // Curtain rail.
    fill(win.x - ft - 6, outer.y - 3, win.x + win.w + ft + 6, outer.y - 2, [90, 88, 86]);

    // Table: a wooden ledge seen slightly from above.
    for (let y = table.y; y < table.y + table.h; y++) {
      const front = y >= table.y + table.h - 2;
      for (let x = table.x; x < table.x + table.w; x++) {
        const grain = 0.92 + 0.08 * Math.sin(x * 0.35 + Math.sin(x * 0.05) * 3 + y * 0.2);
        const depth = (y - table.y) / table.h;
        const c = front
          ? WOOD_EDGE
          : ([
              WOOD_TOP[0] * grain * (0.9 + depth * 0.15),
              WOOD_TOP[1] * grain * (0.9 + depth * 0.15),
              WOOD_TOP[2] * grain * (0.9 + depth * 0.15),
            ] as RGB);
        set(x, y, c);
      }
    }
    // The sill between glass and table.
    fill(win.x - ft, win.y + win.h + ft, win.x + win.w + ft, table.y, [
      FRAME[0] * 0.75,
      FRAME[1] * 0.75,
      FRAME[2] * 0.75,
    ]);

    this.paintCurtain(set, win, outer, curtain, -1);
    this.paintCurtain(set, win, outer, curtain, 1);
    this.paintLamp(fill, set);
    this.paintTicket(set);
  }

  /** Gathered curtain tied back at one side of the window. */
  private paintCurtain(
    set: (x: number, y: number, c: RGB) => void,
    win: Rect,
    outer: Rect,
    overlap: number,
    side: -1 | 1,
  ): void {
    const top = outer.y - 3;
    const bottom = win.y + win.h + 2;
    const tie = Math.round(win.y + win.h * 0.62);
    const edge = side < 0 ? win.x : win.x + win.w;
    const outerWidth = Math.max(6, Math.round((win.x - 2) * 0.7));
    for (let y = top; y < bottom; y++) {
      // Width reaching into the window: full at the top, pinched at the tieback, flaring below.
      let reach: number;
      if (y < tie) {
        reach = overlap * (1 - 0.55 * smoothstep(top, tie, y));
      } else {
        reach = overlap * (0.45 + 0.5 * smoothstep(tie, bottom, y));
      }
      const x0 = side < 0 ? edge - outerWidth : Math.round(edge - reach);
      const x1 = side < 0 ? Math.round(edge + reach) : edge + outerWidth;
      for (let x = x0; x < x1; x++) {
        const u = side < 0 ? x1 - x : x - x0;
        const fold = 0.72 + 0.28 * Math.sin(u * 1.3 + (y < tie ? 0 : (y - tie) * 0.15 * side));
        const shadeEdge = u < 2 ? 0.8 : 1;
        const k = fold * shadeEdge * (0.95 + hash2(x, y) * 0.05);
        set(x, y, [CURTAIN[0] * k, CURTAIN[1] * k, CURTAIN[2] * k]);
      }
      if (Math.abs(y - tie) <= 1) {
        for (let x = x0; x < x1; x++) {
          set(x, y, TIEBACK);
        }
      }
    }
  }

  private paintLamp(
    fill: (x0: number, y0: number, x1: number, y1: number, c: RGB) => void,
    set: (x: number, y: number, c: RGB) => void,
  ): void {
    const l = this.layout.lamp;
    // Wall plate and arm.
    fill(l.x + 3, l.y, l.x + 6, l.y + 3, BRASS);
    fill(l.x + 4, l.y + 3, l.x + 5, l.y + 5, BRASS);
    // Shade: a small cone.
    for (let y = 0; y < 5; y++) {
      const half = 1.5 + y * 0.8;
      for (let x = Math.round(l.x + 4.5 - half); x < Math.round(l.x + 4.5 + half); x++) {
        set(x, l.y + 5 + y, y === 4 ? [SHADE[0] * 0.85, SHADE[1] * 0.85, SHADE[2] * 0.85] : SHADE);
      }
    }
  }

  private paintTicket(set: (x: number, y: number, c: RGB) => void): void {
    const { window: win, table } = this.layout;
    const tx = Math.round(win.x + win.w * 0.26);
    const ty = table.y + Math.max(1, Math.round(table.h * 0.35));
    const len = 11;
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < len; x++) {
        const px = tx + x + y;
        const printed = y === 1 && x > 1 && x < len - 2 && hash2(x, 91) < 0.55;
        set(px, ty + y, printed ? [60, 52, 48] : x === len - 1 ? [60, 60, 70] : [242, 204, 150]);
      }
    }
  }

  private computeLight(): void {
    const { width, height, window: win, lamp } = this.layout;
    const lx = lamp.x + 4.5;
    const ly = lamp.y + 9;
    const lr = height * 0.4;
    const wr = Math.max(8, height * 0.14);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d2 = ((x - lx) ** 2 + (y - ly) ** 2) / (lr * lr);
        this.lampLight[i] = 0.55 + 0.6 / (1 + d2 * 3);
        const dx = Math.max(win.x - x, 0, x - (win.x + win.w));
        const dy = Math.max(win.y - y, 0, y - (win.y + win.h));
        // Light through the window falls mostly downward onto the table and sill.
        const below = y > win.y + win.h ? 0.8 : 1.4;
        this.windowLight[i] = Math.exp(-Math.hypot(dx, dy * below) / wr);
      }
    }
  }

  /** Lights the interior and draws it (and its moving parts) over the screen. */
  render(screen: Surface, f: InteriorFrame): void {
    const { width, height } = this.layout;
    const out = screen.data;
    const alb = this.albedo.data;
    const lamp = f.lampOn;
    const flicker = 1 - 0.015 * Math.sin(f.seconds * 50) * lamp;
    const lr = (WARM[0] / 255) * lamp * flicker;
    const lg = (WARM[1] / 255) * lamp * flicker;
    const lb = (WARM[2] / 255) * lamp * flicker;
    const [or, og, ob] = f.outside;
    const nr = NIGHT_LIGHT[0] / 255;
    const ng = NIGHT_LIGHT[1] / 255;
    const nb = NIGHT_LIGHT[2] / 255;
    for (let i = 0; i < width * height; i++) {
      if (this.mask[i] === 0) {
        continue;
      }
      const c = alb[i];
      const ll = this.lampLight[i];
      const wl = this.windowLight[i] * 1.25;
      const r = (c & 255) * (lr * ll + (or / 255) * wl + nr + 0.06 * (or / 255));
      const g = ((c >>> 8) & 255) * (lg * ll + (og / 255) * wl + ng + 0.06 * (og / 255));
      const b = ((c >>> 16) & 255) * (lb * ll + (ob / 255) * wl + nb + 0.06 * (ob / 255));
      out[i] = pack(r, g, b);
    }
    this.renderSillSnow(screen, f);
    this.renderLamp(screen, f);
    this.renderBottle(screen, f);
    drawClock(screen, this.layout.clock, f.time, f.seasonIndex, f.seconds, lamp);
  }

  private renderSillSnow(screen: Surface, f: InteriorFrame): void {
    if (f.sillSnow < 0.3) {
      return;
    }
    const win = this.layout.window;
    const base = win.y + win.h - 1;
    for (let x = win.x; x < win.x + win.w; x++) {
      const h = f.sillSnow * (0.75 + 0.35 * Math.sin(x * 0.21) * Math.sin(x * 0.07 + 1));
      for (let k = 0; k < Math.round(h); k++) {
        if (this.isGlass(x, base - k)) {
          const shade = 0.75 + 0.25 * (k / Math.max(1, h));
          const [or, og, ob] = f.outside;
          screen.set(
            x,
            base - k,
            pack(200 * shade + or * 0.2, 205 * shade + og * 0.2, 215 * shade + ob * 0.2),
          );
        }
      }
    }
  }

  private renderLamp(screen: Surface, f: InteriorFrame): void {
    const l = this.layout.lamp;
    const k = f.lampOn;
    const bx = l.x + 4.5;
    const by = l.y + 10;
    const off = 1 - k;
    if (off > 0.01) {
      // With the lights out, a small pilot light on the wall plate marks the
      // switch and faintly picks out the shade below it.
      const px = l.x + 4;
      const py = l.y + 1;
      const pulse = 0.85 + 0.15 * Math.sin(f.seconds * 1.3);
      screen.blend(px, py, 255, 150, 60, off * pulse);
      screen.glow(px + 0.5, py + 0.5, 4, [255, 140, 50], 0.35 * off * pulse);
      for (let y = 0; y < 5; y++) {
        const half = 1.5 + y * 0.8;
        for (let x = Math.round(bx - half); x < Math.round(bx + half); x++) {
          const c = screen.get(x, l.y + 5 + y);
          const edge = y === 0 || x === Math.round(bx - half) || x === Math.round(bx + half) - 1;
          const lift = (edge ? 52 : 30) * off * (1 - y * 0.12);
          screen.set(
            x,
            l.y + 5 + y,
            pack(
              (c & 255) + lift,
              ((c >>> 8) & 255) + lift * 0.7,
              ((c >>> 16) & 255) + lift * 0.45,
            ),
          );
        }
      }
    }
    if (k <= 0.01) {
      return;
    }
    screen.fillRect(Math.round(bx - 1), by, 2, 1, pack(255, 246, 220));
    screen.glow(bx, by + 1, 7, [255, 210, 150], 0.35 * k);
    // The shade glows from inside.
    for (let y = 0; y < 5; y++) {
      const half = 1.5 + y * 0.8;
      for (let x = Math.round(bx - half); x < Math.round(bx + half); x++) {
        screen.add(x, l.y + 5 + y, 60 * k, 44 * k, 20 * k);
      }
    }
  }

  private renderBottle(screen: Surface, f: InteriorFrame): void {
    const { window: win, table } = this.layout;
    const h = Math.max(13, Math.round(this.layout.height * 0.085));
    const w = Math.max(5, Math.round(h * 0.36));
    const x0 = Math.round(win.x + win.w * 0.74);
    const base = table.y + Math.max(2, Math.round(table.h * 0.55)) - Math.round(f.jolt);
    const top = base - h;
    const light = (c: RGB, extra = 0): number => {
      const k = f.lampOn * 0.85 + extra;
      const [or, og, ob] = f.outside;
      return pack(
        c[0] * (k + (or / 255) * 0.9 + 0.05),
        c[1] * (k + (og / 255) * 0.9 + 0.05),
        c[2] * (k + (ob / 255) * 0.9 + 0.06),
      );
    };
    const liquidTop = top + Math.round(h * 0.28);
    const tilt = Math.max(-1.5, Math.min(1.5, -f.traction * 1.2));
    for (let y = top; y < base; y++) {
      const t = (y - top) / h;
      // Cap, neck, shoulder, body.
      let half: number;
      if (t < 0.1) {
        half = w * 0.22;
      } else if (t < 0.22) {
        half = w * 0.22 + ((t - 0.1) / 0.12) * w * 0.28;
      } else {
        half = w * 0.5;
      }
      for (let x = Math.round(x0 - half); x < Math.round(x0 + half); x++) {
        const u = (x + 0.5 - (x0 - half)) / (half * 2);
        let c: RGB;
        if (t < 0.1) {
          c = [236, 238, 232];
        } else {
          const surface = liquidTop + tilt * (u - 0.5) * 2;
          const tea = y >= surface;
          c = tea ? [178, 150, 58] : [196, 208, 206];
          if (t > 0.45 && t < 0.75) {
            // Label.
            c = t > 0.52 && t < 0.68 ? [238, 234, 214] : [62, 118, 64];
          }
        }
        const edge = u < 0.18 ? 0.75 : u > 0.82 ? 0.8 : 1;
        const shine = u > 0.25 && u < 0.36 && (t < 0.45 || t > 0.75) ? 0.5 : 0;
        screen.set(x, y, light([c[0] * edge, c[1] * edge, c[2] * edge], shine));
      }
    }
    // Contact shadow.
    screen.blendRect(x0 - w / 2 - 1, base, w + 2, 1, [0, 0, 0], 0.35);
  }
}
