import { hash2, hash3 } from "../../shared/core/random.ts";
import { M } from "./materials.ts";
import { COS_E, SIN_E } from "./projection.ts";
import { packed, type Paint } from "./raster.ts";

/**
 * Textures for building surfaces, as `Paint`s: u runs across a face and v
 * up a wall or down a roof, in meters. At a fifth of a meter to the pixel a
 * beam is a pixel wide and a stone two, so every pattern is laid out in
 * those steps.
 */

/** Pixel-sized steps of u and v, for patterns laid out pixel by pixel. */
const PX = 0.2;

/** Hash of a cell of a pattern, in [0, 1). */
function cell(a: number, b: number, seed: number): number {
  return hash3(Math.floor(a), Math.floor(b), seed);
}

/**
 * Timber framing: posts, a sill and a top plate, a rail at each floor, and
 * braces, dark against plaster (`mat`). Walls taller than `storey` get a
 * floor beam at each storey.
 */
export function timberFrame(mat: number, seed: number, storey = 2.8, width = 0): Paint {
  const spacing = 1.2 + hash2(seed, 5) * 0.3;
  return (u, v) => {
    const within = ((v % storey) + storey) % storey;
    const fromEnd = width > 0 ? Math.min(u, width - u) : Infinity;
    const post =
      Math.abs(u / spacing - Math.round(u / spacing)) * spacing < PX * 0.6 || fromEnd < PX;
    const rail = within < PX || within > storey - PX || Math.abs(within - storey * 0.52) < PX * 0.5;
    // Braces from the posts: one per bay, alternating.
    const bay = Math.floor(u / spacing);
    const t = u / spacing - bay;
    const braced = hash2(bay, seed + Math.floor(v / storey)) > 0.45;
    const brace =
      braced &&
      within < storey * 0.52 &&
      Math.abs((bay & 1 ? 1 - t : t) * storey * 0.52 - within) < PX * 0.7;
    if (post || rail || brace) {
      return packed(M.TIMBER, 118 + hash2(Math.floor(u / PX), Math.floor(v / PX)) * 20);
    }
    // Plaster, a little uneven, grubbier near the ground.
    const grime = within < 0.5 && v < storey ? -10 : 0;
    return packed(mat, 124 + hash2(Math.floor(u / PX), Math.floor(v / PX) + seed) * 10 + grime);
  };
}

/** Round logs laid one on another, their ends showing at the corners. */
export function logs(seed: number, width: number): Paint {
  return (u, v) => {
    const course = 0.3;
    const k = Math.floor(v / course);
    const t = v / course - k;
    const end = u < 0.25 || u > width - 0.25;
    const round = Math.cos((t - 0.5) * Math.PI) * 26;
    if (end) {
      return packed(M.LOG, 150 + (t > 0.2 && t < 0.8 ? 16 : -20));
    }
    const grain = hash2(Math.floor(u / 0.6) + k * 17, seed) * 12;
    return packed(M.LOG, 104 + round + grain + (t < 0.1 ? -30 : 0));
  };
}

/** Upright boards with dark seams. */
export function boards(mat: number, seed: number, width = 0.25): Paint {
  return (u, v) => {
    const k = Math.floor(u / width);
    const seam = u - k * width < PX * 0.5;
    const weather = hash2(k, seed) * 20 - 10 + (v < 0.4 ? -12 : 0);
    return packed(mat, seam ? 86 : 128 + weather);
  };
}

/** Courses of dressed stone with mortar joints, each stone a shade of its own. */
export function stoneCourses(mat: number, seed: number, rough = false): Paint {
  const course = rough ? 0.4 : 0.34;
  return (u, v) => {
    const row = Math.floor(v / course);
    const shift = (row & 1) * 0.35 + hash2(row, seed) * 0.2;
    const len = rough ? 0.6 : 0.7;
    const col = Math.floor((u + shift) / len);
    const inRow = v - row * course;
    const inCol = u + shift - col * len;
    if (inRow < PX * 0.5 || inCol < PX * 0.5) {
      return packed(mat, 92);
    }
    return packed(mat, 118 + hash2(col, row + seed) * 28 + (inRow > course - PX ? -8 : 6));
  };
}

/** Thatch: straw laid in courses down the slope, combed into streaks, a ridge along the top. */
export function thatch(seed: number): Paint {
  return (u, v) => {
    if (v < 0.35) {
      return packed(M.THATCH, 100 + hash2(Math.floor(u / PX), seed) * 14);
    }
    const streak = hash2(Math.floor(u / PX), Math.floor(v / 0.9) + seed) * 26;
    const course = v % 0.55 < PX * 0.6 ? -18 : 0;
    return packed(M.THATCH, 112 + streak + course);
  };
}

/** Rows of wooden shingles, each row shadowing the one below. */
export function shingles(mat: number, seed: number, row = 0.26, width = 0.24): Paint {
  return (u, v) => {
    const k = Math.floor(v / row);
    const shift = (k & 1) * width * 0.5;
    const s = Math.floor((u + shift) / width);
    const inRow = v - k * row;
    const edge = inRow > row - PX * 0.6 ? -26 : 0;
    const gap = u + shift - s * width < PX * 0.4 ? -14 : 0;
    return packed(mat, 120 + cell(s, k, seed) * 22 + edge + gap);
  };
}

/** Clay tiles: rounded ridges running down the slope, in overlapping rows. */
export function tiles(seed: number): Paint {
  return (u, v) => {
    const row = 0.3;
    const k = Math.floor(v / row);
    const t = (u / 0.25) % 1;
    const round = Math.sin(t * Math.PI) * 22 - 8;
    const lap = v - k * row > row - PX * 0.6 ? -24 : 0;
    return packed(M.TILE, 116 + round + lap + hash2(Math.floor(u / 0.25), k + seed) * 14);
  };
}

/** Bark slabs pinned in overlapping rows: the settlers' first roofs. */
export function bark(seed: number): Paint {
  return (u, v) => {
    const row = 0.5;
    const k = Math.floor(v / row);
    const s = Math.floor((u + (k & 1) * 0.2) / 0.45);
    const lap = v - k * row > row - PX ? -30 : 0;
    return packed(M.BARK, 112 + cell(s, k, seed) * 30 + lap + hash2(Math.floor(u / PX), k) * 10);
  };
}

/** A plain surface with a little grain. */
export function plain(mat: number, seed: number, amount = 14): Paint {
  return (u, v) =>
    packed(mat, 128 + (hash2(Math.floor(u / PX), Math.floor(v / PX) + seed) - 0.5) * amount);
}

/**
 * Paving laid out on the screen's own pixels, so every stone is whole art
 * pixels: cobbles 3 to 5 pixels long in rows 2 deep, flagstones 5 to 8 long
 * in rows 3 deep, each row shifted along its own way, with a joint a pixel
 * wide under and after each stone and the upper row of each stone catching
 * the light. Returns the detail brightness (128 the material's own) at the
 * world point (x, y, z).
 */
export function pavingDetail(x: number, y: number, z: number, flags: boolean): number {
  const gx = Math.floor(x / PX);
  const gy = Math.floor(-(y * SIN_E + z * COS_E) / PX);
  const depth = flags ? 4 : 3;
  const row = Math.floor(gy / depth);
  const inRow = gy - row * depth;
  // Stones of a row are `length` long on average, each end moved a pixel either way.
  const length = flags ? 7 : 5;
  const run = gx + Math.floor(hash2(row, 0x51) * 97);
  let stone = Math.floor(run / length);
  if (run < stone * length + jog(stone, row)) {
    stone--;
  } else if (run >= (stone + 1) * length + jog(stone + 1, row)) {
    stone++;
  }
  const start = stone * length + jog(stone, row);
  const end = (stone + 1) * length + jog(stone + 1, row) - 1;
  if (inRow === depth - 1 || run === end) {
    return flags ? 100 : 94;
  }
  const tone = (hash2(stone, row) - 0.5) * (flags ? 24 : 36);
  // The upper row catches the light, but for its rounded-off corners.
  const lit = inRow === 0 ? (run === start || run === end - 1 ? -4 : 9) : 0;
  return 124 + tone + lit;
}

/** How far (-1, 0 or 1 pixels) the start of stone k of a row of paving is moved. */
function jog(k: number, row: number): number {
  return Math.floor(hash2(k, row + 0x3c1) * 3) - 1;
}

/** A window: a dark pane in a light frame, divided by glazing bars. */
export function windowPane(width: number, height: number): Paint {
  return (u, v) => {
    const frame = u < PX * 0.6 || u > width - PX * 0.6 || v < PX * 0.6 || v > height - PX * 0.6;
    if (frame) {
      return packed(M.PLANK, 150);
    }
    const bar = Math.abs(u - width / 2) < PX * 0.4 && height > 0.7;
    return bar ? packed(M.TIMBER, 110) : packed(M.WINDOW, 128 + (v > height * 0.6 ? 14 : 0));
  };
}

/** A plank door with iron bands. */
export function door(width: number): Paint {
  return (u, v) => {
    if (Math.abs(v - 0.45) < PX * 0.5 || Math.abs(v - 1.5) < PX * 0.5) {
      return packed(M.IRON, 120);
    }
    const seam = (u / (width / 3)) % 1 < 0.12;
    return packed(M.DOOR, seam ? 96 : 128 + hash2(Math.floor(u / PX), 3) * 10);
  };
}
