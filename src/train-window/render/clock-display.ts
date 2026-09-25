import { pack } from "../core/color.ts";
import type { Surface } from "../core/surface.ts";

type Glyph = readonly string[];

const DIGITS: Record<string, Glyph> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  ":": [".", "#", ".", "#", "."],
};

/** Width (px) of the table clock's body. */
export const TABLE_CLOCK_WIDTH = 21;
/** Height (px) of the table clock's body. */
const TABLE_CLOCK_HEIGHT = 9;

/**
 * A small travel clock standing on the table: dark casing, amber LED digits
 * that glow softly after dark. `light` lights the casing.
 */
export function drawTableClock(
  screen: Surface,
  x: number,
  base: number,
  time: string,
  seconds: number,
  light: (r: number, g: number, b: number) => number,
): void {
  const w = TABLE_CLOCK_WIDTH;
  const h = TABLE_CLOCK_HEIGHT;
  const top = base - h;
  // Casing with rounded top corners and a lighter top edge.
  for (let y = top; y < base; y++) {
    for (let xx = x; xx < x + w; xx++) {
      if (y === top && (xx === x || xx === x + w - 1)) {
        continue;
      }
      const k = y === top ? 1.5 : xx === x ? 1.2 : 1;
      screen.set(xx, y, light(46 * k, 44 * k, 48 * k));
    }
  }
  // Feet and a contact shadow.
  screen.set(x + 2, base, light(30, 30, 32));
  screen.set(x + w - 3, base, light(30, 30, 32));
  screen.blendRect(x, base, w, 1, [0, 0, 0], 0.3);
  // Screen and digits.
  screen.fillRect(x + 1, top + 1, w - 2, h - 2, pack(10, 8, 8));
  // A muted amber that reads clearly without drawing the eye.
  const pulse = 0.97 + 0.03 * Math.sin(seconds * 2);
  const color = pack(178 * pulse, 98 * pulse, 44 * pulse);
  let cx = x + 2;
  for (const ch of time) {
    const g = DIGITS[ch] ?? DIGITS["0"];
    for (let row = 0; row < g.length; row++) {
      for (let col = 0; col < g[row].length; col++) {
        if (g[row][col] === "#") {
          screen.set(cx + col, top + 2 + row, color);
        }
      }
    }
    cx += g[0].length + 1;
  }
  screen.glow(x + w / 2, top + h / 2, w * 0.5, [200, 100, 40], 0.03);
}
