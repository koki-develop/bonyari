import { pack } from "../core/color.ts";
import { clamp01, DEG, intervalCoverage, lerp, pulseCoverage, smoothstep } from "../core/math.ts";
import { hash2, hash3, tileNoise } from "../core/random.ts";
import { bayer, type Surface } from "../core/surface.ts";
import type { Bridge, Crossing } from "../sim/route.ts";
import type { World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Lighting } from "./lighting.ts";
import type { TerrainTable } from "./terrain-table.ts";

const PLOT_ALONG = 34;
const PLOT_LATERAL = 23;
/** Lateral distance (m) beyond which the ground is only haze. */
const MAX_GROUND = 40000;
const STEP = 5;
/** Center of the adjacent track and half its gauge (Japanese narrow gauge). */
/** Lateral distance (m) of the adjacent track's center line. */
export const NEXT_TRACK = 4;
export const HALF_GAUGE = 0.53;

/** Grassy verge (m) between the embankment and the first fields. */
const VERGE = 3;
/** Size (m) of the armour stones along a seawall. */
const STONE_ALONG = 1.3;
const STONE_LATERAL = 1.0;
/** Offset (m) of each lane's center from the road's center line. */
const LANE = 1.7;
/** Size (m) of the patches that make up yards and lots. */
const LOT = 7;
/** Size (m) of the fine texture cells: small along, finer across. */
const GRAIN_ALONG = 0.6;
const GRAIN_LATERAL = 0.22;

/** Mutable color accumulator to avoid allocations in the per-pixel loop. */
interface Px {
  r: number;
  g: number;
  b: number;
}

function set(p: Px, r: number, g: number, b: number): void {
  p.r = r;
  p.g = g;
  p.b = b;
}

function blendInto(p: Px, r: number, g: number, b: number, a: number): void {
  p.r += (r - p.r) * a;
  p.g += (g - p.g) * a;
  p.b += (b - p.b) * a;
}

/**
 * Fine surface texture. Along the track it is box-filtered by the motion blur,
 * so at speed it smears into streaks that still vary from row to row.
 */
function grain(p: Px, along: number, z: number, foot: number, rowFoot: number, seed: number): void {
  const lateralDetail = 1 - smoothstep(0.12, 0.7, rowFoot);
  if (lateralDetail <= 0) {
    return;
  }
  const row = Math.floor(z / GRAIN_LATERAL);
  const sharp = Math.min(1, Math.sqrt(GRAIN_ALONG / Math.max(GRAIN_ALONG, foot)));
  const streak = hash3(row, seed, 41);
  const speck = hash3(Math.floor(along / GRAIN_ALONG), row, seed + 42);
  const k = (streak * (1 - sharp) + speck * sharp - 0.5) * 0.18 * lateralDetail;
  p.r *= 1 + k;
  p.g *= 1 + k;
  p.b *= 1 + k;
}

/**
 * Cell noise in [0, 1] over the ground that the motion blur smears along the
 * track: once the footprint outgrows a cell, it fades into a per-row streak
 * instead of flickering from frame to frame.
 */
function cellNoise(
  along: number,
  z: number,
  cellAlong: number,
  cellLateral: number,
  foot: number,
  seed: number,
): number {
  const row = Math.floor(z / cellLateral);
  const sharp = cellAlong / Math.max(cellAlong, foot);
  const streak = hash3(row, seed, 43);
  const speck = hash3(Math.floor(along / cellAlong), row, seed);
  return 0.5 + (streak - 0.5) * (1 - sharp) * 0.5 + (speck - 0.5) * sharp;
}

/**
 * A sprinkle of small things (flowers, stubble) covering `density` of the
 * ground: sharp dots when they can be seen, their average tint once blurred.
 * Returns how much of the pixel they cover.
 */
function sprinkle(
  along: number,
  z: number,
  cell: number,
  foot: number,
  density: number,
  seed: number,
): number {
  if (density <= 0) {
    return 0;
  }
  const sharp = cell / Math.max(cell, foot);
  const dot = hash3(Math.floor(along / cell), Math.floor(z / cell), seed) < density ? 1 : 0;
  return dot * sharp + density * (1 - sharp);
}

/** Grass texture: tufts up close and lusher or drier patches farther out. */
function grassTexture(
  p: Px,
  along: number,
  z: number,
  foot: number,
  detail: number,
  seed: number,
): void {
  const tuft = detail > 0 ? cellNoise(along, z, 0.22, 0.16, foot, seed + 17) - 0.5 : 0;
  const patch = tileNoise(along * 0.3 + seed * 0.37, z * 0.8);
  const k = 1 + tuft * 0.34 * detail + (patch - 0.5) * 0.22;
  p.r *= k;
  p.g *= k;
  p.b *= k;
  if (patch > 0.68) {
    // Straw-colored stretches where the grass has dried.
    blendInto(p, 168, 150, 100, (patch - 0.68) * 1.1);
  }
}

/** Tilled soil: clods and furrow shadows up close, damper and drier patches. */
function soilTexture(
  p: Px,
  along: number,
  z: number,
  foot: number,
  detail: number,
  seed: number,
): void {
  const clod = detail > 0 ? cellNoise(along, z, 0.16, 0.1, foot, seed + 37) - 0.5 : 0;
  const damp = tileNoise(along * 0.12 + 71, z * 0.3 + seed * 0.23);
  const k = 1 + clod * 0.3 * detail - (damp - 0.5) * 0.24;
  p.r *= k;
  p.g *= k;
  p.b *= k;
}

/**
 * The ground plane, rendered per pixel by casting each pixel's ray onto it:
 * fields, roads, the adjacent track, rivers under bridges, beaches and the sea.
 * Everything that repeats is box-filtered over the pixel footprint plus the
 * distance traveled during the frame, which doubles as motion blur.
 */
export class GroundRenderer {
  private readonly px: Px = { r: 0, g: 0, b: 0 };
  private wildflowers = 0;
  private higanbana = 0;
  /** What `land` found at the last pixel, for the snow over it. */
  private plotPath = 0;
  /** Sunlight for shading the relief of stones: direction in view terms and strength. */
  private sunRight = 0;
  private sunUp = 1;
  private sunForward = 0;
  private direct = 0;
  private roadOffset = Infinity;

  render(
    view: Surface,
    cam: Camera,
    world: World,
    light: Lighting,
    table: TerrainTable,
    groundLimit: Float32Array,
    time: number,
  ): void {
    const route = world.route;
    const season = world.season;
    const weather = world.weather.state;
    const seed = world.seed;
    const [a0, a1] = cam.alongRange(MAX_GROUND, 2);
    const waters: Bridge[] = route.bridgesIn(a0, a1);
    const [n0, n1] = cam.alongRange(400, 4);
    const crossings: Crossing[] = route.crossingsIn(n0 - 10, n1 + 10);
    const sunX = cam.projectDirection(world.sky.sun)?.x ?? -1e9;
    const moonX = cam.projectDirection(world.sky.moon)?.x ?? -1e9;
    const sunAlt = Math.max(0.5, world.sky.sunAltitude);
    const moonAlt = Math.max(0.5, world.sky.moonAltitude);
    const sunGlint = smoothstep(-2, 6, world.sky.sunAltitude) * (1 - weather.cloudCover * 0.85);
    const moonGlint =
      smoothstep(0, 10, world.sky.moonAltitude) *
      world.sky.moonIllumination *
      (1 - light.daylight) *
      (1 - weather.cloudCover * 0.9);
    const [ar, ag, ab] = light.ambient;
    const [fr, fg, fb] = light.fog;
    const vis = weather.visibility * 0.55;
    const snow = weather.snowCover;
    const wet = weather.wetness;
    const flooded = season.paddyFlooded;
    const canola = season.canola;
    const pampas = season.pampas;
    this.wildflowers = season.wildflowers;
    this.higanbana = season.higanbana;
    // Sunlight on the snow: drifts are lit on the sun's side, blue in their shade.
    const sun = cam.toCamera(world.sky.sun);
    const direct = light.direct;
    this.sunRight = sun.right;
    this.sunUp = sun.up;
    this.sunForward = sun.forward;
    this.direct = direct;
    const glitter = direct * smoothstep(0.5, 1, snow);
    const [gr, gg, gb] = season.grass;
    const [pr, pg, pb] = season.paddy;
    const eye = cam.eye;
    const F = cam.focal;
    const W = view.width;
    const data = view.data;
    const p = this.px;
    const firstRow = Math.max(0, Math.floor(cam.horizon));

    for (let y = firstRow; y < view.height; y++) {
      const ry = y + 0.5 - cam.horizon;
      if (ry <= 0.05) {
        continue;
      }
      const z = (eye * F) / ry;
      const rowFoot = (z * z) / (eye * F);
      const pixelAlong = z / F;
      const foot = pixelAlong + Math.abs(cam.travel);
      const fogK = 1 - Math.exp(-z / vis);
      const detail = 1 - smoothstep(0.6, 3, pixelAlong);
      // Reflections come from the mirrored row of the sky already drawn above.
      const mirrorY = Math.max(0, Math.floor(2 * cam.horizon - y - 1));

      for (let x = 0; x < W; x++) {
        if (z > groundLimit[x]) {
          continue;
        }
        const along = cam.pos + ((x + 0.5 - cam.cx) * z) / F;
        let water = false;
        let waterDist = z;
        let paddy = false;

        // Rivers under bridges: re-cast the ray onto the lower water surface.
        let inRiver = false;
        for (let i = 0; i < waters.length; i++) {
          const wsp = waters[i].water;
          if (along >= wsp.start - 60 && along < wsp.end + 60) {
            const zw = ((eye + waters[i].depth) * F) / ry;
            const aw = cam.pos + ((x + 0.5 - cam.cx) * zw) / F;
            if (aw >= wsp.start && aw < wsp.end) {
              water = true;
              waterDist = zw;
              inRiver = true;
            } else if (along >= wsp.start && along < wsp.end) {
              // The ray hits the steep bank between ground and water.
              set(p, 104, 96, 74);
              blendInto(p, gr, gg, gb, 0.45);
              inRiver = true;
            }
            break;
          }
        }

        if (!inRiver) {
          const shore = table.sample(table.shore, along);
          if (z > shore) {
            water = true;
          } else if (z < 2.3) {
            // Our own ballast.
            const n = hash3(Math.floor(along * 6), Math.floor(z * 6), 5) * 30;
            set(p, 112 + n, 106 + n, 98 + n);
          } else {
            paddy = this.land(
              p,
              along,
              z,
              rowFoot,
              foot,
              detail,
              table,
              shore,
              crossings,
              seed,
              gr,
              gg,
              gb,
              pr,
              pg,
              pb,
              flooded,
              canola,
              pampas,
              time,
            );
            // A flooded paddy is mostly sky reflection with rows of seedlings.
            water = paddy;
            // Snow settles on everything but water, in drifts; roads and plot paths show through.
            if (!water && snow > 0) {
              const e = 0.9;
              const drift = tileNoise(along * 0.09 + 101, z * 0.2 + 53);
              const gA = (tileNoise((along + e) * 0.09 + 101, z * 0.2 + 53) - drift) / e;
              const gZ = (tileNoise(along * 0.09 + 101, (z + e) * 0.2 + 53) - drift) / e;
              const amp = 2.5 * snow;
              const len = Math.hypot(gA * amp, 1, gZ * amp);
              const diffuse = Math.max(
                0,
                (-gA * amp * sun.right + sun.up + gZ * amp * -sun.forward) / len,
              );
              const lit = (1 - direct) * 0.92 + direct * (0.62 + 0.55 * diffuse);
              // Thin snow lets the ground show through in patches.
              const depth = snow * (0.75 + 0.5 * drift);
              let cover = clamp01(depth * 1.25 - 0.1);
              if (this.roadOffset < 3.6) {
                // Wheel ruts worn through on the road.
                const rut = Math.abs(Math.abs(this.roadOffset - LANE) - 0.75) < 0.22 ? 0.55 : 0.2;
                cover *= 1 - rut;
              }
              cover *= 1 - this.plotPath * 0.25;
              const shadowBlue = 1 - lit;
              const sr = 250 * lit - 36 * shadowBlue;
              const sg = 250 * lit - 22 * shadowBlue;
              const sb = 252 * lit + 8 * shadowBlue;
              p.r = lerp(p.r, sr, cover);
              p.g = lerp(p.g, sg, cover);
              p.b = lerp(p.b, sb, cover);
              if (
                glitter > 0 &&
                detail > 0.3 &&
                hash3(x, y, Math.floor(time * 5)) < 0.006 * glitter
              ) {
                p.r = p.g = p.b = 300;
              }
            }
            if (!water && wet > 0) {
              const k = 1 - wet * 0.22;
              p.r *= k;
              p.g *= k;
              p.b *= k;
            }
          }
        }

        const i = y * W + x;
        const d = bayer(x, y) - 0.5;
        if (water) {
          const wz = waterDist;
          const sea = !paddy && !inRiver;
          const ripple =
            Math.sin(along * 0.9 + time * 1.7 + wz * 0.35) + Math.sin(along * 0.37 - time * 1.1);
          const amp = Math.min(sea ? 3.5 : 2.5, (sea ? 90 : 60) / wz) * (paddy ? 0.3 : 1);
          const rx = Math.max(0, Math.min(W - 1, Math.round(x + ripple * amp)));
          const refl =
            data[
              Math.min(mirrorY + Math.round(Math.abs(ripple) * amp * 0.3), view.height - 1) * W + rx
            ];
          // Fresnel: water mirrors the sky at grazing angles and shows its own color up close.
          const grazing = Math.exp(-ry / (F * 0.09));
          const fres = clamp01((sea ? 0.18 : 0.42) + (sea ? 0.72 : 0.5) * grazing);
          let r = (sea ? 22 : 30) * ar;
          let g = (sea ? 58 : 52) * ag;
          let b = (sea ? 78 : 64) * ab;
          r += ((refl & 255) - r) * fres;
          g += (((refl >>> 8) & 255) - g) * fres;
          b += (((refl >>> 16) & 255) - b) * fres;
          if (sea) {
            // Swell lines parallel to the shore.
            const swell =
              Math.sin(wz * 0.8 + time * 1.3 + Math.sin(along * 0.04) * 2) * (1 - grazing);
            r *= 1 + swell * 0.12;
            g *= 1 + swell * 0.12;
            b *= 1 + swell * 0.12;
          }
          if (paddy) {
            // Seedlings poke through the flooded paddy.
            const k = 0.25 + 0.2 * season.leafDensity;
            r += (pr * ar - r) * k;
            g += (pg * ag - g) * k;
            b += (pb * ab - b) * k;
          } else if (!inRiver) {
            // Waves roll toward the beach; foam near the waterline.
            const shore = table.sample(table.shore, along);
            const fromShore = wz - shore;
            const crest = pulseCoverage(
              wz + time * 1.6 + Math.sin(along * 0.05) * 3,
              11,
              1.2,
              rowFoot,
            );
            const foam =
              crest * smoothstep(26, 2, fromShore) +
              smoothstep(3, 0, fromShore) * (0.6 + 0.4 * Math.sin(time * 0.9 + along * 0.1));
            const foamLight = 150 * (ar + 0.15);
            r += (foamLight - r) * foam * 0.8;
            g += (foamLight * 1.02 - g) * foam * 0.8;
            b += (foamLight * 1.05 - b) * foam * 0.8;
          }
          // Glitter under the sun and moon.
          const sparkle = hash3(x, y, Math.floor(time * 7));
          const sd = Math.abs(x - sunX);
          const md = Math.abs(x - moonX);
          const spread = 2 + ry * 0.25;
          // Glitter only where the water reflects the sun toward us: the row's
          // depression below the horizon must match the sun's altitude.
          const depression = Math.atan2(ry, F) / DEG;
          const sunMatch = Math.exp(-(((depression - sunAlt) / 7) ** 2));
          const moonMatch = Math.exp(-(((depression - moonAlt) / 7) ** 2));
          if (
            sunGlint > 0 &&
            sd < spread * 3 &&
            sparkle < sunGlint * sunMatch * 0.5 * (1 - sd / (spread * 3))
          ) {
            r += light.sunGlow[0] * 0.8;
            g += light.sunGlow[1] * 0.8;
            b += light.sunGlow[2] * 0.8;
          } else if (
            moonGlint > 0 &&
            md < spread * 2 &&
            sparkle < moonGlint * moonMatch * 0.45 * (1 - md / (spread * 2))
          ) {
            r += 170;
            g += 175;
            b += 180;
          }
          const f = 1 - Math.exp(-wz / vis);
          data[i] = pack(
            r + (fr - r) * f + d * STEP,
            g + (fg - g) * f + d * STEP,
            b + (fb - b) * f + d * STEP,
          );
        } else {
          const k = 1 - fogK;
          data[i] = pack(
            p.r * ar * k + fr * fogK + d * STEP,
            p.g * ag * k + fg * fogK + d * STEP,
            p.b * ab * k + fb * fogK + d * STEP,
          );
        }
      }
    }
  }

  /**
   * Writes the unlit land color into `p`. Returns true for a flooded paddy,
   * which the caller renders as water instead.
   */
  private land(
    p: Px,
    along: number,
    z: number,
    rowFoot: number,
    foot: number,
    detail: number,
    table: TerrainTable,
    shore: number,
    crossings: Crossing[],
    seed: number,
    gr: number,
    gg: number,
    gb: number,
    pr: number,
    pg: number,
    pb: number,
    flooded: number,
    canola: number,
    pampas: number,
    time: number,
  ): boolean {
    this.plotPath = 0;
    this.roadOffset = Infinity;
    // Adjacent track.
    const twin = z < 6 ? table.at(table.doubleTrack, along) : 0;
    if (twin > 0.5 && z < NEXT_TRACK + 1.6) {
      const n = hash3(Math.floor(along * 5), Math.floor(z * 5), 9) * 26 * detail;
      set(p, 108 + n, 102 + n, 96 + n);
      if (z > NEXT_TRACK - 1.05 && z < NEXT_TRACK + 1.05) {
        const sleeper = pulseCoverage(along, 0.62, 0.22, foot);
        blendInto(p, 124, 118, 110, sleeper * 0.8);
      }
      const rail =
        intervalCoverage(
          z,
          NEXT_TRACK - HALF_GAUGE - 0.04,
          NEXT_TRACK - HALF_GAUGE + 0.04,
          rowFoot,
        ) +
        intervalCoverage(
          z,
          NEXT_TRACK + HALF_GAUGE - 0.04,
          NEXT_TRACK + HALF_GAUGE + 0.04,
          rowFoot,
        );
      blendInto(p, 196, 196, 204, Math.min(1, rail));
      return false;
    }

    const elevation = z < 30 ? table.at(table.elevation, along) : 0;
    const embankment = 2.3 + (twin > 0.5 ? 3.4 : 0) + elevation * 1.4;
    const road = table.sample(table.road, along);
    const onRoad = Math.abs(z - road) < 3.6;
    let crossing = false;
    if (z < 420) {
      for (let i = 0; i < crossings.length; i++) {
        if (Math.abs(along - crossings[i].at) < 3.1) {
          crossing = true;
          break;
        }
      }
    }

    if (crossing || onRoad) {
      this.roadOffset = crossing ? 0 : Math.abs(z - road);
      // Asphalt, with a dashed center line along the parallel road.
      set(p, 84, 84, 88);
      if (onRoad && !crossing) {
        const center =
          intervalCoverage(z, road - 0.07, road + 0.07, rowFoot) *
          pulseCoverage(along, 10, 5, foot);
        const edge =
          intervalCoverage(z, road - 3.1, road - 2.95, rowFoot) +
          intervalCoverage(z, road + 2.95, road + 3.1, rowFoot);
        blendInto(p, 220, 220, 214, Math.min(1, center + edge) * 0.9);
      }
      return false;
    }

    // The shore: sand where there is room for a beach, armour stones against a seawall.
    if (shore < 1e8) {
      const beach = 6 + 6 * table.sample(table.pines, along);
      if (z > shore - beach) {
        if (shore - embankment < 10) {
          // Armour stones: rounded boulders in offset rows, lit on the sun's
          // side, dark in the crevices; smeared to their average at speed.
          const row = Math.floor(z / STONE_LATERAL);
          const shift = hash2(row, 29) * 0.6;
          const u = along / STONE_ALONG + shift;
          const cell = Math.floor(u);
          const hv = hash3(cell, row, 23);
          // Each stone sits a little off center and has its own size.
          const fx = u - cell - 0.5 - (hash3(cell, row, 24) - 0.5) * 0.24;
          const fz = z / STONE_LATERAL - row - 0.5 - (hash3(cell, row, 25) - 0.5) * 0.2;
          const d2 = (fx * fx + fz * fz) / (0.14 + 0.1 * hv);
          let k: number;
          if (d2 < 1) {
            const nx = fx * 1.6;
            const nz = fz * 1.6;
            const ny = Math.sqrt(Math.max(0.05, 1 - nx * nx - nz * nz));
            const sunlit = Math.max(0, nx * this.sunRight + ny * this.sunUp + nz * this.sunForward);
            k = (1 - this.direct) * (0.82 + 0.1 * ny) + this.direct * (0.55 + 0.6 * sunlit);
            k *= 0.85 + 0.3 * hv;
          } else {
            k = 0.42;
          }
          const sharp = STONE_ALONG / Math.max(STONE_ALONG, foot);
          const v = 0.78 + (k - 0.78) * sharp;
          set(p, 150 * v, 148 * v, 140 * v);
          const wetStone =
            smoothstep(shore - 2.5, shore, z) * (0.6 + 0.4 * Math.sin(time * 0.9 + along * 0.1));
          blendInto(p, 70, 72, 70, wetStone);
        } else {
          // Sand, rippled by the wind in lines along the shore.
          const n = (cellNoise(along, z, 0.4, 0.25, foot, seed + 23) - 0.5) * 22 * detail;
          set(p, 204 + n, 188 + n, 150 + n);
          const ripple = pulseCoverage(z + Math.sin(along * 0.15) * 0.4, 0.45, 0.12, rowFoot);
          blendInto(p, 178, 162, 126, ripple * 0.35 * detail);
          const wetSand = smoothstep(shore - 5, shore - 0.5, z);
          blendInto(p, 150, 136, 108, wetSand * (0.7 + 0.3 * Math.sin(time * 0.9 + along * 0.1)));
        }
        grain(p, along, z, foot, rowFoot, seed);
        return false;
      }
    }

    if (z < embankment + VERGE) {
      // Grassy embankment slope and verge: tufts, lusher and drier patches, and
      // the flowers of the season.
      const slope = z < embankment ? 0.86 : 0.95;
      set(p, gr * slope, gg * slope, gb * slope);
      grassTexture(p, along, z, foot, detail, seed);
      const bloom = tileNoise(along * 0.07 + 31, z * 0.4 + 17);
      const flowers = sprinkle(along, z, 0.12, foot, this.wildflowers * 0.18 * bloom, seed + 19);
      blendInto(p, 238, 204, 56, flowers * (hash2(Math.floor(along * 3), 7) < 0.7 ? 1 : 0.4));
      const lilies = sprinkle(
        along,
        z,
        0.16,
        foot,
        this.higanbana * 0.3 * smoothstep(0.55, 0.75, bloom),
        seed + 23,
      );
      blendInto(p, 204, 40, 34, lilies);
      blendInto(p, 236, 214, 60, sprinkle(along, z, 0.2, foot, canola * 0.3, seed + 29));
      blendInto(p, 220, 206, 176, sprinkle(along, z, 0.3, foot, pampas * 0.22, seed + 31));
      grain(p, along, z, foot, rowFoot, seed);
      return false;
    }

    const pa = Math.floor(along / PLOT_ALONG);
    const pl = Math.floor(z / PLOT_LATERAL);
    const use = hash3(pa, pl, seed);
    const fields = table.at(table.fields, along);
    const built = table.at(table.houses, along) * 0.8 + table.at(table.apartments, along);
    const forest = table.at(table.forest, along);

    if (use < fields) {
      const crop = hash3(pa, pl, seed + 1);
      const inAlong = along - pa * PLOT_ALONG;
      const inLat = z - pl * PLOT_LATERAL;
      // Raised paths (aze) between plots.
      const path = Math.max(
        intervalCoverage(inAlong, 0, 0.9, foot),
        intervalCoverage(inLat, 0, 0.9, rowFoot),
      );
      if (crop < 0.68) {
        if (flooded > 0.5 && path < 0.5) {
          return true;
        }
        set(p, pr, pg, pb);
        soilTexture(p, along, z, foot, detail, seed);
        // Rows of rice, perpendicular to the track, visible up close.
        const rows = pulseCoverage(inAlong, 0.3, 0.12, foot);
        const k = (rows - 0.4) * 0.22 * detail;
        p.r *= 1 + k;
        p.g *= 1 + k;
        p.b *= 1 + k;
      } else if (crop < 0.84) {
        // Vegetable ridges.
        set(p, 118, 96, 70);
        soilTexture(p, along, z, foot, detail, seed);
        const rows = pulseCoverage(inAlong, 1.3, 0.6, foot);
        blendInto(p, gr * 0.9, gg * 0.95, gb * 0.8, rows * 0.75);
      } else if (canola > 0.2 && crop < 0.93) {
        set(p, gr, gg, gb);
        blendInto(p, 238, 214, 58, canola * 0.95);
      } else {
        set(p, gr * 0.95, gg * 0.92, gb * 0.85);
        grassTexture(p, along, z, foot, detail, seed);
      }
      // Each plot is a slightly different shade.
      const tone = 0.93 + hash3(pa, pl, seed + 5) * 0.14;
      p.r *= tone;
      p.g *= tone;
      p.b *= tone;
      blendInto(p, gr * 1.02, gg * 1.02, gb * 0.95, path);
      // Red spider lilies line the paths between the paddies.
      blendInto(
        p,
        204,
        40,
        34,
        path * sprinkle(along, z, 0.16, foot, this.higanbana * 0.5, seed + 23),
      );
      this.plotPath = path;
      grain(p, along, z, foot, rowFoot, seed);
      return false;
    }
    if (use < fields + built) {
      // Gardens, gravel, driveways and bare soil around houses.
      const ca = Math.floor(along / LOT);
      const cl = Math.floor(z / LOT);
      const tone = hash3(ca, cl, seed + 2);
      if (tone < 0.45) {
        set(p, gr * 0.9, gg * 0.92, gb * 0.85);
      } else if (tone < 0.7) {
        set(p, 142, 134, 122);
      } else if (tone < 0.85) {
        set(p, 98, 98, 102);
      } else {
        set(p, 122, 102, 82);
      }
      grain(p, along, z, foot, rowFoot, seed);
      return false;
    }
    if (use < fields + built + forest) {
      set(p, gr * 0.52, gg * 0.58, gb * 0.5);
      grassTexture(p, along, z, foot, detail, seed + 3);
      grain(p, along, z, foot, rowFoot, seed);
      return false;
    }
    set(p, gr, gg, gb);
    grassTexture(p, along, z, foot, detail, seed);
    grain(p, along, z, foot, rowFoot, seed);
    return false;
  }
}
