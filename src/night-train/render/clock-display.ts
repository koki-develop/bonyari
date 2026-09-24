import { pack } from "../core/color.ts";
import type { Surface } from "../core/surface.ts";
import type { Rect } from "./layout.ts";

type Glyph = readonly string[];

const DIGITS: Record<string, Glyph> = {
  "0": [".##.", "#..#", "#..#", "#..#", "#..#", "#..#", ".##."],
  "1": ["..#.", ".##.", "..#.", "..#.", "..#.", "..#.", ".###"],
  "2": [".##.", "#..#", "...#", "..#.", ".#..", "#...", "####"],
  "3": [".##.", "#..#", "...#", "..#.", "...#", "#..#", ".##."],
  "4": ["..#.", ".##.", "#.#.", "#.#.", "####", "..#.", "..#."],
  "5": ["####", "#...", "###.", "...#", "...#", "#..#", ".##."],
  "6": [".##.", "#...", "#...", "###.", "#..#", "#..#", ".##."],
  "7": ["####", "...#", "..#.", "..#.", ".#..", ".#..", ".#.."],
  "8": [".##.", "#..#", "#..#", ".##.", "#..#", "#..#", ".##."],
  "9": [".##.", "#..#", "#..#", ".###", "...#", "...#", ".##."],
  ":": [".", ".", "#", ".", "#", ".", "."],
};

/** Season marks: cherry blossom, sun, maple leaf, snowflake. */
const SEASON_ICONS: readonly Glyph[] = [
  ["..#.#..", ".##.##.", "#.###.#", ".##.##.", "#.###.#", ".##.##.", "..#.#.."],
  ["#..#..#", ".#...#.", "..###..", "#.###.#", "..###..", ".#...#.", "#..#..#"],
  ["...#...", "#.###.#", ".#####.", "#######", ".#####.", "..###..", "...#..."],
  ["...#...", ".#.#.#.", "..###..", "#######", "..###..", ".#.#.#.", "...#..."],
];

const LIT = [255, 156, 48] as const;
const UNLIT = [44, 20, 10] as const;
const PANEL = [14, 9, 7] as const;
const BEZEL = [52, 50, 54] as const;

/**
 * The dot-matrix clock above the window: season mark and in-world time in
 * amber LEDs, with a soft bloom.
 */
export function drawClock(
  screen: Surface,
  rect: Rect,
  time: string,
  seasonIndex: number,
  seconds: number,
  lamp: number,
): void {
  const { x, y, w, h } = rect;
  // Bezel (lit by the car light) and panel.
  const b = 0.35 + 0.65 * lamp;
  screen.fillRect(x - 1, y - 1, w + 2, h + 2, pack(BEZEL[0] * b, BEZEL[1] * b, BEZEL[2] * b));
  screen.fillRect(x, y, w, h, pack(PANEL[0], PANEL[1], PANEL[2]));
  const glyphs: Glyph[] = [SEASON_ICONS[seasonIndex % SEASON_ICONS.length]];
  for (const ch of time) {
    glyphs.push(DIGITS[ch] ?? DIGITS["0"]);
  }
  const lit = new Set<number>();
  const matrixX0 = x + 1;
  const matrixY0 = y + 2;
  let cx = x + 2;
  glyphs.forEach((g, gi) => {
    for (let row = 0; row < g.length; row++) {
      for (let col = 0; col < g[row].length; col++) {
        if (g[row][col] === "#") {
          lit.add((matrixY0 + row) * screen.width + cx + col);
        }
      }
    }
    cx += g[0].length + (gi === 0 ? 2 : 1);
  });
  // Unlit LED grid behind the characters.
  for (let yy = matrixY0; yy < matrixY0 + 7; yy++) {
    for (let xx = matrixX0; xx < x + w - 1; xx++) {
      screen.set(xx, yy, pack(UNLIT[0], UNLIT[1], UNLIT[2]));
    }
  }
  const pulse = 0.96 + 0.04 * Math.sin(seconds * 2.1);
  for (const i of lit) {
    const px = i % screen.width;
    const py = Math.floor(i / screen.width);
    screen.set(px, py, pack(LIT[0] * pulse, LIT[1] * pulse, LIT[2] * pulse));
  }
  for (const i of lit) {
    const px = i % screen.width;
    const py = Math.floor(i / screen.width);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (!lit.has((py + dy) * screen.width + px + dx)) {
        screen.add(px + dx, py + dy, 38, 16, 4);
      }
    }
  }
}
