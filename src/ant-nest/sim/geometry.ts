/**
 * The vertical section of ground the colony lives in, in millimeters: x to the
 * right, y up from the original ground level. It is kept as a grid of 1 mm
 * cells; row 0 is the top.
 */
export const GRID_X0 = -400;
export const GRID_WIDTH = 800;
/** y of the top edge of the first row: a little above the ground, where the entrance opens. */
export const GRID_TOP = 8;
export const GRID_HEIGHT = 408;
export const GRID_SIZE = GRID_WIDTH * GRID_HEIGHT;

/** Where the colony may dig. */
export const DOMAIN = { x0: -96, x1: 96, y0: -296 } as const;

/** The part of the section every screen keeps in view: the whole nest and some sky above it. */
export const FRAME = { x0: -100, x1: 100, top: 50, bottom: -310 } as const;

/** How far along the surface the ants may wander. */
export const SURFACE_X0 = -380;
export const SURFACE_X1 = 380;

/** What a cell of the grid holds. */
export const SOIL = 0;
export const STONE = 1;
/** Dug out by the ants. */
export const OPEN = 2;
/** Above the ground. */
export const AIR = 3;
/** Soil packed back into a tunnel: the plug of an entrance. */
export const FILL = 4;

/** Index of the cell holding (x, y), or -1 outside the grid. */
export function cellIndex(x: number, y: number): number {
  const i = Math.floor(x - GRID_X0);
  const j = Math.floor(GRID_TOP - y);
  if (i < 0 || i >= GRID_WIDTH || j < 0 || j >= GRID_HEIGHT) {
    return -1;
  }
  return j * GRID_WIDTH + i;
}

/** x of the center of cell `index`. */
export function cellX(index: number): number {
  return GRID_X0 + (index % GRID_WIDTH) + 0.5;
}

/** y of the center of cell `index`. */
export function cellY(index: number): number {
  return GRID_TOP - Math.floor(index / GRID_WIDTH) - 0.5;
}

/**
 * Where something is: `f` is a feature of the nest (0 and up), or one of the
 * places outside it below; `s` is the distance (mm) along it, and `u` the
 * offset (mm) to the left of its direction.
 */
export interface Loc {
  f: number;
  s: number;
  u: number;
}

/** On the ground surface: `s` is x. */
export const SURFACE = -1;
/** In the air: `s` is x and `u` is y. */
export const AIR_LOC = -2;
/** On the stem of plant k: `f` is `STEM - k`, `s` runs up the stem from its foot. */
export const STEM = -10;

export function isStem(f: number): boolean {
  return f <= STEM;
}

export function stemIndex(f: number): number {
  return STEM - f;
}

/** A point in the section (mm). */
export interface Point {
  x: number;
  y: number;
}
