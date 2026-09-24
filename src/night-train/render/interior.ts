import { hex, pack, type RGB } from "../core/color.ts";
import { smoothstep } from "../core/math.ts";
import { hash2 } from "../core/random.ts";
import { Surface } from "../core/surface.ts";
import { drawTableClock, TABLE_CLOCK_WIDTH } from "./clock-display.ts";
import type { Layout, Rect } from "./layout.ts";

const WALL: RGB = hex("#cfb690");
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
/** Width (px) of the ticket lying on the table. */
const TICKET_WIDTH = 13;

/**
 * A light source just outside the window (a tunnel lamp, platform lights, a
 * passing train's windows): screen position and color already scaled by
 * brightness and distance.
 */
export interface NearLight {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

/** Direct sunlight falling through the window onto the table. */
export interface SunPatch {
  /** 0..1 */
  intensity: number;
  color: RGB;
  /** Sideways shift (px) of the lit patch per pixel of table depth. */
  slope: number;
  /** Table depth (0 = against the wall, 1 = front edge) where the sunlight starts. */
  depth: number;
}

export interface InteriorFrame {
  dt: number;
  /** Real seconds, for flicker, steam and the clock's glow. */
  seconds: number;
  /** Car lights on. */
  lampOn: number;
  /** Average color of the view outside. */
  outside: RGB;
  /** Lights close outside the window, which throw light into the car. */
  lights: readonly NearLight[];
  sun: SunPatch | null;
  /** Vertical jolt in pixels, for things on the table. */
  jolt: number;
  /** Sideways sway of the car, -1..1, which sets the curtain tassels swinging. */
  sway: number;
  /** Train acceleration, tilting the tea in the bottle. */
  traction: number;
  /** In-world time for the table clock. */
  time: string;
  sillSnow: number;
  /** Condensation on the glass, which also beads on the window frame. */
  condensation: number;
  /** What the table holds changes a little at every station. */
  stationsVisited: number;
  warmth: number;
  hour: number;
}

type TableItem = "mikan" | "frozenMikan" | "ekiben" | "coffee" | "book" | "can";

/** Picks what lies on the table after a stop, from what suits the season and hour. */
function chooseItems(visited: number, warmth: number, hour: number): TableItem[] {
  const pool: TableItem[] = ["book", "can", "ekiben"];
  if (warmth < 0.35) {
    pool.push("mikan", "mikan");
  }
  if (warmth > 0.7) {
    pool.push("frozenMikan", "frozenMikan");
  }
  if (hour > 5 && hour < 11) {
    pool.push("coffee", "coffee");
  }
  const out: TableItem[] = [];
  for (let slot = 0; slot < 2; slot++) {
    // Some slots stay empty.
    if (hash2(visited * 7 + slot, 41) < 0.25) {
      continue;
    }
    const item = pool[Math.floor(hash2(visited * 13 + slot, 42) * pool.length)];
    if (!out.includes(item)) {
      out.push(item);
    }
  }
  return out;
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
  /** Tassel pendulums on the two curtain tiebacks: angle and angular velocity. */
  private readonly tassels = [
    { angle: 0, velocity: 0 },
    { angle: 0, velocity: 0 },
  ];
  private items: TableItem[] = [];
  private lastSway = 0;
  private wasJolted = false;
  /** Light thrown into the car by nearby sources this frame (RGB, 0..1 per unit albedo). */
  private readonly thrown: Float32Array;
  /** Runs [start, end) of pixels that receive thrown light; row y's runs are rowRuns[y]..rowRuns[y + 1]. */
  private runStart = new Int32Array(0);
  private runEnd = new Int32Array(0);
  private rowRuns = new Int32Array(0);
  /** Runs [start, end) of pixels showing the car; row y's runs are surfaceRows[y]..surfaceRows[y + 1]. */
  private surfaceStart = new Int32Array(0);
  private surfaceEnd = new Int32Array(0);
  private surfaceRows = new Int32Array(0);
  private itemsFor = -1;

  constructor(layout: Layout) {
    this.layout = layout;
    const { width, height } = layout;
    this.albedo = new Surface(width, height);
    this.mask = new Uint8Array(width * height);
    this.lampLight = new Float32Array(width * height);
    this.windowLight = new Float32Array(width * height);
    this.thrown = new Float32Array(width * height * 3);
    this.paint();
    this.computeLight();
    this.findReceivers();
    this.findSurfaces();
  }

  /** Runs of pixels, row by row, that show the car rather than the glass. */
  private findSurfaces(): void {
    const { width, height } = this.layout;
    const starts: number[] = [];
    const ends: number[] = [];
    this.surfaceRows = new Int32Array(height + 1);
    for (let y = 0; y < height; y++) {
      this.surfaceRows[y] = starts.length;
      let open = -1;
      for (let x = 0; x <= width; x++) {
        const solid = x < width && this.mask[y * width + x] !== 0;
        if (solid && open < 0) {
          open = x;
        } else if (!solid && open >= 0) {
          starts.push(open);
          ends.push(x);
          open = -1;
        }
      }
    }
    this.surfaceRows[height] = starts.length;
    this.surfaceStart = Int32Array.from(starts);
    this.surfaceEnd = Int32Array.from(ends);
  }

  /**
   * Runs of pixels, row by row, that light thrown in through the window can
   * reach: the car's surfaces (not the glass) close enough to the window.
   */
  private findReceivers(): void {
    const { width, height } = this.layout;
    const starts: number[] = [];
    const ends: number[] = [];
    this.rowRuns = new Int32Array(height + 1);
    for (let y = 0; y < height; y++) {
      this.rowRuns[y] = starts.length;
      let open = -1;
      for (let x = 0; x <= width; x++) {
        const i = y * width + x;
        const receives = x < width && this.windowLight[i] >= 0.02 && this.mask[i] !== 0;
        if (receives && open < 0) {
          open = x;
        } else if (!receives && open >= 0) {
          starts.push(open);
          ends.push(x);
          open = -1;
        }
      }
    }
    this.rowRuns[height] = starts.length;
    this.runStart = Int32Array.from(starts);
    this.runEnd = Int32Array.from(ends);
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

    // Walls: pale wood-grain laminate in panels, darker wood below the table.
    const seam = 40;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const grain =
          0.95 +
          0.05 * Math.sin(x * 0.8 + Math.sin(y * 0.045 + x * 0.3) * 1.8) +
          hash2(x, y) * 0.03;
        const edge = x % seam === 0 ? 0.84 : x % seam === 1 ? 1.05 : 1;
        const t = y / height;
        const k = grain * edge * (1 - t * 0.08);
        set(x, y, [WALL[0] * k, WALL[1] * k, WALL[2] * k]);
      }
    }
    // Screws at the top and bottom of every panel seam.
    const rackRow = Math.max(1, Math.round(win.y * 0.2));
    for (let x = seam; x < width; x += seam) {
      for (const y of [rackRow + 7, table.y - 3]) {
        set(x - 2, y, [WALL[0] * 0.62, WALL[1] * 0.6, WALL[2] * 0.58]);
        set(x - 2, y - 1, [WALL[0] * 1.12, WALL[1] * 1.1, WALL[2] * 1.08]);
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
    this.paintPlate(fill, set);
  }

  /** The car and berth number plate: brass, with engraved lettering. */
  private paintPlate(
    fill: (x0: number, y0: number, x1: number, y1: number, c: RGB) => void,
    set: (x: number, y: number, c: RGB) => void,
  ): void {
    const p = this.layout.plate;
    fill(p.x, p.y, p.x + p.w, p.y + p.h, [BRASS[0] * 0.8, BRASS[1] * 0.8, BRASS[2] * 0.8]);
    fill(p.x + 1, p.y + 1, p.x + p.w - 1, p.y + p.h - 1, [226, 212, 176]);
    // Car number, a divider, and the berth number.
    for (let x = p.x + 2; x < p.x + p.w - 2; x++) {
      for (let y = p.y + 2; y < p.y + p.h - 2; y++) {
        const col = x - p.x - 2;
        const divider = col === 9;
        if (divider || ((col + 1) % 4 !== 0 && hash2(col, y - p.y) < 0.55)) {
          set(x, y, divider ? [150, 130, 90] : [70, 56, 40]);
        }
      }
    }
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
    this.throwLights(f.lights);
    const thrown = this.thrown;
    // Daylight through the window: an even fill that fades away from the glass.
    const dr = or / 255;
    const dg = og / 255;
    const db = ob / 255;
    const { surfaceStart, surfaceEnd, surfaceRows, windowLight, lampLight } = this;
    for (let y = 0; y < height; y++) {
      for (let run = surfaceRows[y]; run < surfaceRows[y + 1]; run++) {
        const end = y * width + surfaceEnd[run];
        for (let i = y * width + surfaceStart[run]; i < end; i++) {
          const wl = windowLight[i] * 1.25;
          const c = alb[i];
          const ll = lampLight[i];
          const t = i * 3;
          const r = (c & 255) * (lr * ll + dr * wl + thrown[t] + nr + 0.06 * dr);
          const g = ((c >>> 8) & 255) * (lg * ll + dg * wl + thrown[t + 1] + ng + 0.06 * dg);
          const b = ((c >>> 16) & 255) * (lb * ll + db * wl + thrown[t + 2] + nb + 0.06 * db);
          out[i] = pack(r, g, b);
        }
      }
    }
    if (f.sun) {
      this.renderSunPatch(screen, f.sun);
    }
    this.renderSillSnow(screen, f);
    this.renderCondensation(screen, f);
    this.renderTassels(screen, f);
    this.renderLamp(screen, f);
    this.renderTable(screen, f);
  }

  /**
   * Each nearby light casts a soft, wide pool into the car: brightest on the
   * sill, table and curtains beside it, fading with distance from the window.
   * Pools are offset and stretched diagonally away from the light, the way
   * light through a window lands, rather than dropping straight down.
   */
  private throwLights(lights: readonly NearLight[]): void {
    const { width, height, window: win } = this.layout;
    const thrown = this.thrown;
    thrown.fill(0);
    const sx = Math.max(18, win.w * 0.12);
    const sy = Math.max(22, win.h * 0.35);
    const midY = win.y + win.h / 2;
    for (const l of lights) {
      // Light from above lands low, from below lands high: mirror across the window's middle.
      const cy = midY + (midY - l.y) * 0.6;
      const x0 = Math.max(0, Math.floor(l.x - sx * 3));
      const x1 = Math.min(width, Math.ceil(l.x + sx * 3));
      const y0 = Math.max(0, Math.floor(cy - sy * 3));
      const y1 = Math.min(height, Math.ceil(cy + sy * 3));
      // The Gaussian is stepped along each run of receiving pixels by its
      // ratio recurrence instead of calling exp for every pixel.
      const step = 1 / sx;
      const decay = Math.exp(-step * step);
      const { runStart, runEnd, rowRuns } = this;
      for (let y = y0; y < y1; y++) {
        const dy = (y - cy) / sy;
        const rowK = Math.exp(-0.5 * dy * dy);
        // The pool leans away from the light as it spreads from the window.
        const lean = (y - midY) * 0.35 * Math.sign(l.x - (win.x + win.w / 2));
        const row = y * width;
        for (let r = rowRuns[y]; r < rowRuns[y + 1]; r++) {
          const a = Math.max(runStart[r], x0);
          const b = Math.min(runEnd[r], x1);
          if (a >= b) {
            continue;
          }
          const dx0 = (a - l.x + lean) / sx;
          // g = exp(-dx²/2) at x; ratio = g(x + 1) / g(x).
          let g = Math.exp(-0.5 * dx0 * dx0);
          let ratio = Math.exp(-dx0 * step - 0.5 * step * step);
          for (let x = a; x < b; x++) {
            const i = row + x;
            const k = g * rowK * this.windowLight[i];
            const t = i * 3;
            thrown[t] += l.r * k;
            thrown[t + 1] += l.g * k;
            thrown[t + 2] += l.b * k;
            g *= ratio;
            ratio *= decay;
          }
        }
      }
    }
  }

  /** Low sun streams through the window and lays a warm patch across the table. */
  private renderSunPatch(screen: Surface, sun: SunPatch): void {
    const { window: win, table, curtain } = this.layout;
    const rows = table.h - 2;
    for (let y = table.y; y < table.y + rows; y++) {
      const depth = (y - table.y) / Math.max(1, rows - 1);
      if (depth < sun.depth) {
        continue;
      }
      const shift = -sun.slope * (y - table.y) * 2;
      const x0 = Math.round(win.x + curtain * 0.6 + shift);
      const x1 = Math.round(win.x + win.w - curtain * 0.6 + shift);
      const fade = Math.min(1, (depth - sun.depth) * 6);
      const k = sun.intensity * fade * 0.55;
      for (let x = Math.max(table.x, x0); x < Math.min(table.x + table.w, x1); x++) {
        const edge = x === x0 || x === x1 - 1 ? 0.5 : 1;
        screen.add(x, y, sun.color[0] * k * edge, sun.color[1] * k * edge, sun.color[2] * k * edge);
      }
    }
  }

  /** Beads of condensation along the bottom of the window frame. */
  private renderCondensation(screen: Surface, f: InteriorFrame): void {
    if (f.condensation < 0.15) {
      return;
    }
    const win = this.layout.window;
    const y = win.y + win.h;
    const [or, og, ob] = f.outside;
    const glint = 18 + (0.25 * (or + og + ob)) / 3 + f.lampOn * 22;
    for (let x = win.x + 2; x < win.x + win.w - 2; x++) {
      const h = hash2(x, 77);
      if (h < f.condensation * 0.12) {
        screen.add(x, y, glint * 0.6, glint * 0.62, glint * 0.66);
        if (h < f.condensation * 0.03) {
          screen.add(x, y + 1, glint * 0.4, glint * 0.42, glint * 0.46);
        }
      }
    }
  }

  /** Tassels hanging from the curtain tiebacks swing with the car. */
  private renderTassels(screen: Surface, f: InteriorFrame): void {
    const { window: win, curtain } = this.layout;
    const tie = Math.round(win.y + win.h * 0.62);
    const dt = Math.min(f.dt, 1 / 20);
    const light = this.lightFor(f);
    const swayRate = dt > 0 ? (f.sway - this.lastSway) / dt : 0;
    this.lastSway = f.sway;
    const kick = f.jolt > 0 && !this.wasJolted;
    this.wasJolted = f.jolt > 0;
    this.tassels.forEach((t, i) => {
      // A lightly damped pendulum: nudged by every rail joint, swung by the
      // car rocking and leaning into curves.
      if (kick) {
        t.velocity += (i === 0 ? 1 : -0.8) * (0.45 + 0.25 * Math.sin(f.seconds * 3.1 + i));
      }
      const force = -24 * t.angle - 1.5 * t.velocity - swayRate * 3;
      t.velocity += force * dt;
      t.angle = Math.max(-0.7, Math.min(0.7, t.angle + t.velocity * dt));
      const ax =
        i === 0
          ? win.x + Math.round(curtain * 0.45)
          : win.x + win.w - Math.round(curtain * 0.45) - 1;
      const cord = 6;
      const dx = Math.sin(t.angle);
      const cordColor = light(TIEBACK[0] * 0.8, TIEBACK[1] * 0.8, TIEBACK[2] * 0.8);
      for (let k = 1; k <= cord; k++) {
        screen.set(Math.round(ax + dx * k), tie + 1 + Math.round(k * Math.cos(t.angle)), cordColor);
      }
      // The tassel: a knot, then threads fanning out below.
      const bx = ax + dx * (cord + 1);
      const by = tie + 2 + Math.round(cord * Math.cos(t.angle));
      for (let yy = 0; yy < 4; yy++) {
        const half = yy === 0 ? 0 : yy === 1 ? 1 : 1.5;
        const cx = Math.round(bx + dx * yy);
        for (let xx = Math.round(-half); xx <= Math.round(half); xx++) {
          const k = yy === 0 ? 1.1 : yy === 3 ? 0.7 : 0.95;
          screen.set(cx + xx, by + yy, light(TIEBACK[0] * k, TIEBACK[1] * k, TIEBACK[2] * k));
        }
      }
    });
  }

  /** Color lighting for small moving things: the car light plus what comes in through the window. */
  private lightFor(f: InteriorFrame): (r: number, g: number, b: number, extra?: number) => number {
    const [or, og, ob] = f.outside;
    return (r, g, b, extra = 0) => {
      const k = f.lampOn * 0.85 + extra;
      return pack(
        r * (k + (or / 255) * 0.9 + 0.05),
        g * (k + (og / 255) * 0.9 + 0.05),
        b * (k + (ob / 255) * 0.9 + 0.06),
      );
    };
  }

  /** The clock, the bottle and whatever else is on the table. */
  private renderTable(screen: Surface, f: InteriorFrame): void {
    const { window: win, table } = this.layout;
    if (this.itemsFor !== f.stationsVisited) {
      this.itemsFor = f.stationsVisited;
      this.items = chooseItems(f.stationsVisited, f.warmth, f.hour);
    }
    const light = this.lightFor(f);
    const base = table.y + Math.max(2, Math.round(table.h * 0.55)) - Math.round(f.jolt);
    // Everything sits together toward the left, the way you'd leave it within reach.
    const widths: Record<TableItem, number> = {
      mikan: 9,
      frozenMikan: 9,
      ekiben: 11,
      coffee: 5,
      book: 10,
      can: 3,
    };
    const bottleW = Math.max(
      5,
      Math.round(Math.max(13, Math.round(this.layout.height * 0.085)) * 0.36),
    );
    const gap = 4;
    let x = win.x + this.layout.curtain + gap;
    drawTableClock(screen, x, base, f.time, f.seconds, light);
    x += TABLE_CLOCK_WIDTH + gap;
    this.renderTicket(screen, x, base, light);
    x += TICKET_WIDTH + gap;
    for (const item of this.items) {
      this.renderItem(screen, item, x, base, f, light);
      x += widths[item] + gap;
    }
    this.renderBottle(screen, f, x + Math.round(bottleW / 2));
  }

  /** A train ticket lying flat. */
  private renderTicket(
    screen: Surface,
    x: number,
    base: number,
    light: (r: number, g: number, b: number, extra?: number) => number,
  ): void {
    const y = base - 2;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < TICKET_WIDTH - 2; col++) {
        const px = x + col + row;
        const printed = row === 1 && col > 1 && col < TICKET_WIDTH - 4 && hash2(col, 91) < 0.55;
        const c: RGB = printed
          ? [60, 52, 48]
          : col === TICKET_WIDTH - 3
            ? [60, 60, 70]
            : [242, 204, 150];
        screen.set(px, y + row, light(c[0], c[1], c[2]));
      }
    }
  }

  private renderItem(
    screen: Surface,
    item: TableItem,
    x: number,
    base: number,
    f: InteriorFrame,
    light: (r: number, g: number, b: number, extra?: number) => number,
  ): void {
    const dot = (xx: number, yy: number, c: RGB, extra = 0) =>
      screen.set(xx, yy, light(c[0], c[1], c[2], extra));
    const ball = (cx: number, cy: number, r: number, c: RGB) => {
      for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
        for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
          const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
          if (d <= r) {
            const k = 1.1 - ((yy - (cy - r)) / (2 * r)) * 0.35;
            dot(xx, yy, [c[0] * k, c[1] * k, c[2] * k], xx < cx && yy < cy ? 0.15 : 0);
          }
        }
      }
    };
    switch (item) {
      case "mikan": {
        ball(x + 2, base - 2, 2.2, [236, 140, 30]);
        ball(x + 6, base - 2, 2.2, [240, 150, 40]);
        ball(x + 4, base - 5, 2.2, [232, 132, 28]);
        dot(x + 4, base - 7, [70, 120, 50]);
        break;
      }
      case "frozenMikan": {
        // Four frozen mandarins in a red net, frosted.
        for (const [cx, cy] of [
          [x + 2, base - 2],
          [x + 6, base - 2],
          [x + 3, base - 5],
          [x + 6, base - 5],
        ]) {
          ball(cx, cy, 2, [238, 170, 90]);
        }
        for (let yy = base - 7; yy < base; yy += 2) {
          for (let xx = x; xx < x + 9; xx++) {
            if ((xx + yy) % 3 === 0) {
              dot(xx, yy, [200, 40, 40]);
            }
          }
        }
        break;
      }
      case "ekiben": {
        // An empty lunch box, lid on, tied with string.
        for (let yy = base - 4; yy < base; yy++) {
          for (let xx = x; xx < x + 11; xx++) {
            const top = yy === base - 4;
            const c: RGB = top ? [236, 226, 200] : [196, 60, 50];
            dot(xx, yy, xx === x + 5 ? [240, 236, 220] : c);
          }
        }
        dot(x + 3, base - 3, [240, 200, 80]);
        dot(x + 8, base - 2, [240, 200, 80]);
        break;
      }
      case "coffee": {
        // A paper cup with a sleeve, steaming.
        for (let yy = base - 7; yy < base; yy++) {
          const half = yy === base - 7 ? 2 : 2 - Math.floor((yy - (base - 7)) / 4);
          for (let xx = x + 2 - half; xx <= x + 2 + half; xx++) {
            const sleeve = yy > base - 5 && yy < base - 1;
            dot(xx, yy, sleeve ? [150, 110, 70] : [242, 240, 234]);
          }
        }
        for (let k = 0; k < 3; k++) {
          const t = (f.seconds * 0.35 + k / 3) % 1;
          const sx = x + 2 + Math.round(Math.sin(t * 6 + k) * 1.2);
          const sy = base - 8 - Math.round(t * 6);
          screen.blend(sx, sy, 240, 240, 240, 0.28 * (1 - t));
        }
        break;
      }
      case "book": {
        // A paperback lying face down.
        for (let yy = base - 2; yy < base; yy++) {
          for (let xx = x; xx < x + 10; xx++) {
            dot(xx, yy, yy === base - 2 ? [60, 90, 130] : [236, 232, 220]);
          }
        }
        dot(x + 9, base - 2, [236, 232, 220]);
        break;
      }
      case "can": {
        for (let yy = base - 6; yy < base; yy++) {
          for (let xx = x; xx < x + 3; xx++) {
            const top = yy === base - 6;
            const c: RGB = top ? [200, 200, 204] : yy < base - 3 ? [140, 80, 50] : [236, 226, 200];
            dot(xx, yy, c, xx === x ? 0.2 : 0);
          }
        }
        break;
      }
    }
    // Contact shadow.
    screen.blendRect(x - 1, base, 12, 1, [0, 0, 0], 0.2);
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

  private renderBottle(screen: Surface, f: InteriorFrame, cx: number): void {
    const { table } = this.layout;
    const h = Math.max(13, Math.round(this.layout.height * 0.085));
    const w = Math.max(5, Math.round(h * 0.36));
    const x0 = cx;
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
