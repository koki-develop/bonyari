import { hex, mix, type RGB } from "../../core/color.ts";
import { Rng } from "../../core/random.ts";
import type { Painter } from "../painter.ts";

const SKINS: readonly RGB[] = ["#e6c2a2", "#dcb294", "#c99c7c", "#efcfb4"].map(hex);
const HAIR: readonly RGB[] = ["#1c1a1a", "#2e2420", "#4a3a2e", "#8a8680", "#b8b4ae"].map(hex);
const COATS: readonly RGB[] = [
  "#2d3340",
  "#5a4636",
  "#7b2f35",
  "#39527a",
  "#4d6048",
  "#1f1f24",
  "#8a7a64",
  "#c8c0b0",
].map(hex);
const SHIRTS: readonly RGB[] = [
  "#ecece6",
  "#aac4dc",
  "#d8ccb0",
  "#e8d0d0",
  "#9ab89a",
  "#f2f0e8",
  "#3a4458",
].map(hex);
const TROUSERS: readonly RGB[] = [
  "#23283a",
  "#3a3a3e",
  "#1c1c20",
  "#6a6254",
  "#4a5670",
  "#8c8472",
].map(hex);
const SCARVES: readonly RGB[] = ["#b0383a", "#d8b060", "#6a7ca8", "#e8e4dc", "#5a7a58"].map(hex);
const BAGS: readonly RGB[] = ["#2a2420", "#6a4a34", "#1e2230", "#9a8266"].map(hex);
const UMBRELLAS: readonly RGB[] = ["#e8eef2", "#e8eef2", "#2a2e3a", "#7a2a34", "#3a5a8a"].map(hex);
const SHOES: RGB = [30, 28, 28];
const SCREEN: RGB = [200, 225, 255];
/** Top of a seated person, as a fraction of their standing height. */
const SEATED_TOP = 0.78;

/** How someone waiting on a platform is dressed and holds themselves. */
interface Figure {
  height: number;
  /** 0 faces us; ±1 in profile, facing along the track. */
  facing: -1 | 0 | 1;
  skin: RGB;
  hair: RGB;
  top: RGB;
  legs: RGB;
  /** A coat reaching down over the legs to this height (fraction of height), or 0. */
  hem: number;
  shortSleeves: boolean;
  skirt: boolean;
  scarf: RGB | null;
  bag: "none" | "shoulder" | "backpack";
  bagColor: RGB;
  umbrella: RGB | null;
  phone: boolean;
  /** Forward lean of the upper body (older people), in fractions of the height. */
  stoop: number;
}

/** Picks a person's look from `seed`, dressed for the season and the weather. */
function figure(p: Painter, seed: number): Figure {
  const r = new Rng(seed);
  const warmth = p.world.season.warmth;
  const rain = p.world.weather.state.rain;
  const child = r.chance(0.08);
  const old = !child && r.chance(0.15);
  const cold = warmth < 0.35;
  const hot = warmth > 0.72;
  const coat = cold || (!hot && r.chance(0.35));
  const top = coat ? r.pick(COATS) : r.pick(SHIRTS);
  return {
    height: child ? r.range(1.05, 1.35) : r.range(1.52, 1.8) * (old ? 0.96 : 1),
    facing: r.chance(0.45) ? 0 : r.chance(0.5) ? 1 : -1,
    skin: r.pick(SKINS),
    hair: old ? HAIR[r.chance(0.6) ? 4 : 3] : r.pick(HAIR.slice(0, 3)),
    top,
    legs: r.pick(TROUSERS),
    hem: coat && r.chance(cold ? 0.6 : 0.3) ? r.range(0.3, 0.4) : 0,
    shortSleeves: hot && r.chance(0.7),
    skirt: !child && r.chance(0.25),
    scarf: cold && r.chance(0.5) ? r.pick(SCARVES) : null,
    bag: child ? "backpack" : r.chance(0.35) ? "shoulder" : r.chance(0.3) ? "backpack" : "none",
    bagColor: r.pick(BAGS),
    umbrella: rain > 0.15 && r.chance(0.8) ? r.pick(UMBRELLAS) : null,
    phone: r.chance(0.35),
    stoop: old ? 0.035 : 0,
  };
}

/**
 * The colour of a person at height `t` (fraction of their height) and signed
 * offset `u` (m) from their center line, or null outside their outline.
 * Front view shows two legs and arms at the sides; in profile the body is
 * narrower and a backpack sticks out behind.
 */
function bodyAt(f: Figure, t: number, u: number, seated: boolean): RGB | null {
  const a = Math.abs(u);
  const back = f.facing === 0 ? 0 : -u * f.facing;
  const side = f.facing !== 0;
  // Heights of the body's landmarks.
  const knee = seated ? 0.27 : 0.28;
  const waist = seated ? 0.33 : 0.47;
  const shoulder = seated ? 0.63 : 0.8;
  const neck = shoulder + 0.035;
  const chin = neck + 0.03;
  const top = seated ? SEATED_TOP : 1;
  const headMid = (chin + top) / 2;
  if (t > top || t < 0) {
    return null;
  }
  if (t >= chin) {
    // Head: an oval, hair on top and at the back.
    const hr = (top - chin) / 2;
    const dy = (t - headMid) / hr;
    const half = 0.085 * Math.sqrt(Math.max(0, 1 - dy * dy));
    if (a > half) {
      return null;
    }
    const hairLine = side ? back > -0.01 || dy < -0.2 : dy < -0.25 || a > half * 0.75;
    return hairLine ? f.hair : f.skin;
  }
  if (t >= neck) {
    if (f.scarf) {
      return a < 0.08 ? f.scarf : null;
    }
    return a < 0.045 ? f.skin : null;
  }
  if (t >= waist) {
    // Torso, shoulders rounding off, arms down the sides in front view.
    const s = (t - waist) / (shoulder - waist);
    const round =
      t > neck - 0.04 ? Math.sqrt(Math.max(0, 1 - ((t - (neck - 0.04)) / 0.04) ** 2)) : 1;
    const torso = (side ? 0.12 + 0.02 * s : 0.16 + 0.04 * s) * round;
    if (
      f.bag === "backpack" &&
      side &&
      back > 0 &&
      back < torso + 0.1 &&
      t > waist + 0.05 &&
      t < shoulder - 0.02
    ) {
      return f.bagColor;
    }
    if (a <= torso) {
      if (f.bag === "shoulder" && !side && u > torso - 0.06 && t < waist + 0.14) {
        return f.bagColor;
      }
      return f.top;
    }
    if (!side && a <= torso + 0.05 * round) {
      // Arms: sleeves, or bare forearms in summer.
      return f.shortSleeves && t < shoulder - 0.12 ? f.skin : mix(f.top, [0, 0, 0], 0.12);
    }
    return null;
  }
  // Below the waist: a coat's hem, hands at the sides, legs and shoes.
  if (seated && t >= knee) {
    // Thighs on the seat, seen end on.
    return a < 0.15 ? (f.hem > 0 ? f.top : f.legs) : null;
  }
  if (f.hem > 0 && t >= f.hem && !seated) {
    const flare = 0.17 + 0.03 * ((waist - t) / (waist - f.hem));
    if (a <= flare) {
      return f.top;
    }
  }
  if (!side && t > waist - 0.06 && a > 0.16 && a < 0.215) {
    return f.skin;
  }
  if (f.skirt && t > knee + 0.02 && !seated) {
    return a < 0.13 + (waist - t) * 0.12 ? f.legs : null;
  }
  const shoe = t < 0.035;
  if (side) {
    if (a < 0.075 || (shoe && u * f.facing > 0 && u * f.facing < 0.13)) {
      return shoe ? SHOES : f.skirt && t < knee ? f.skin : f.legs;
    }
    return null;
  }
  // Two legs with a gap between them.
  if (a > 0.025 && a < (shoe ? 0.11 : 0.1)) {
    return shoe ? SHOES : f.skirt && t < knee ? f.skin : f.legs;
  }
  return null;
}

/**
 * A person standing (or sitting on a bench whose seat is at `seat` m) on a
 * floor `floor` m above the rails, drawn at the painter's current distance.
 * They keep still: only the light of a phone or an umbrella above them.
 */
export function drawPerson(p: Painter, along: number, floor: number, seed: number, seat = 0): void {
  const f = figure(p, seed);
  const s = p.s;
  const seated = seat > 0;
  const H = f.height;
  const cx = p.x(along);
  const Y = (h: number) => p.cam.yRail(p.lateral, floor + h);
  const topY = Math.floor(Y(seated ? H * SEATED_TOP : H));
  const bottomY = Math.ceil(Y(0));
  const halfPx = Math.ceil(0.34 * s) + 1;
  for (let y = topY; y < bottomY; y++) {
    const t = (p.cam.railHeightAt(y, p.lateral) - floor) / H;
    const lean = f.stoop * Math.max(0, t - 0.45) * (f.facing === 0 ? 0 : f.facing) * H;
    for (let x = Math.floor(cx - halfPx); x <= Math.ceil(cx + halfPx); x++) {
      const u = (x + 0.5 - cx) / s - lean;
      const c = bodyAt(f, t, u, seated);
      if (!c) {
        continue;
      }
      // Rounded body: lit from the sun's side, darker at the edges.
      const w = Math.min(1, Math.abs(u) / 0.2) * Math.sign(u);
      const k = p.surfaceLight(w * 0.7, 0.2, Math.sqrt(Math.max(0.1, 1 - w * w * 0.5)));
      p.dotK(x, y, c, k);
    }
  }
  if (seated && s > 4) {
    // Thighs along the seat and knees forward, in profile.
    if (f.facing !== 0) {
      p.rect(
        cx - (f.facing < 0 ? 0.42 * s : 0),
        Y(seat + 0.1),
        cx + (f.facing > 0 ? 0.42 * s : 0),
        Y(seat - 0.02),
        f.legs,
      );
    }
  }
  const handY = Y(H * (seated ? 0.45 : 0.6));
  if (f.umbrella) {
    // An open umbrella held over the head; clear vinyl ones let the light through.
    const clear = f.umbrella[0] > 220;
    const uy = Y((seated ? H * SEATED_TOP : H) + 0.12);
    const ur = 0.5 * s;
    p.rect(cx + 0.12 * s, uy, cx + 0.12 * s + 1, handY, [60, 60, 64]);
    for (let y = Math.floor(uy - ur * 0.45); y <= Math.ceil(uy); y++) {
      for (let x = Math.floor(cx - ur); x <= Math.ceil(cx + ur); x++) {
        const dx = (x + 0.5 - cx) / ur;
        const dy = (y + 0.5 - uy) / (ur * 0.45);
        if (dx * dx + dy * dy > 1) {
          continue;
        }
        const k = p.surfaceLight(dx * 0.6, 0.8, 0.4);
        if (clear) {
          p.view.blend(
            x,
            y,
            p.shade.litR(f.umbrella[0] * k),
            p.shade.litG(f.umbrella[1] * k),
            p.shade.litB(f.umbrella[2] * k),
            y > uy - 1 ? 0.8 : 0.4,
          );
        } else {
          p.dotK(x, y, f.umbrella, k);
        }
      }
    }
  } else if (f.phone && p.light.lamps > 0.3) {
    // Looking at a phone; its light on the face.
    p.lightDot(cx + (f.facing === 0 ? 0 : f.facing * 0.1 * s), handY - 1, SCREEN, 0.9);
  }
}
