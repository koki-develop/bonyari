import type { RGB } from "../../core/color.ts";
import { fbm1, Rng } from "../../core/random.ts";
import type { Painter } from "../painter.ts";
import type { Scenery } from "./placement.ts";

const FISHING_LIGHT: RGB = [255, 244, 210];

export function drawBoat(p: Painter, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  // Boats drift slowly and bob on the swell.
  const along = o.along + Math.sin(p.time * 0.05 + o.seed) * 30;
  const cx = p.x(along);
  const bob = Math.sin(p.time * 1.3 + o.seed) * 0.3;
  const base = p.y(0) + bob;
  const len = Math.max(2, Math.round(r.range(10, 18) * s));
  const fishing = r.chance(0.6);
  if (p.light.lamps > 0.3 && fishing) {
    // Squid boats hang rows of bright lamps; their light streaks down the water.
    const lamps = p.light.lamps;
    for (let i = 0; i < Math.max(1, Math.round(len / 2)); i++) {
      const lx = cx - len / 2 + i * 2;
      p.lightDot(lx, base - 2, FISHING_LIGHT, lamps);
      p.glow(lx + 0.5, base - 1.5, 3.5, FISHING_LIGHT, 0.35 * lamps);
      for (let k = 1; k < 5; k++) {
        p.lightDot(
          lx + Math.round(Math.sin(p.time * 3 + k + i) * 0.6),
          base + k,
          [255, 220, 170],
          lamps * 0.4 * (1 - k / 5),
        );
      }
    }
    return;
  }
  p.rect(cx - len / 2, base - 1, cx + len / 2, base, [236, 236, 232]);
  p.rect(cx - len / 6, base - 2, cx + len / 6, base - 1, [210, 214, 218]);
  if (p.light.lamps > 0.3) {
    p.lightDot(cx, base - 3, [255, 80, 60], p.light.lamps);
  }
}

export function drawIsland(p: Painter, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const width = r.range(1500, 5000);
  const height = r.range(180, 480);
  const x0 = Math.floor(p.x(o.along - width / 2));
  const x1 = Math.ceil(p.x(o.along + width / 2));
  const base = p.y(0);
  for (let x = x0; x <= x1; x++) {
    const t = (x + 0.5 - x0) / Math.max(1, x1 - x0);
    const profile = Math.sin(Math.PI * t) ** 0.7 * (0.7 + 0.5 * fbm1(t * 5, o.seed, 3));
    const top = p.y(height * profile);
    p.rect(x, top, x + 1, base, [74, 92, 80]);
  }
}

export function drawLighthouse(p: Painter, o: Scenery): void {
  const r = new Rng(o.seed);
  p.at(o.lateral);
  const s = p.s;
  const len = r.range(60, 140);
  const breakwaterX0 = p.x(o.along - len);
  const breakwaterX1 = p.x(o.along);
  const base = p.y(0);
  // Breakwater with tetrapods at its foot.
  p.rect(breakwaterX0, p.y(3), breakwaterX1, base + 1, [160, 158, 150]);
  const red = r.chance(0.5);
  const body: RGB = red ? [206, 62, 52] : [238, 238, 234];
  const cx = breakwaterX1;
  const w = Math.max(1, Math.round(2.4 * s));
  const top = p.y(14);
  p.rect(cx - w, top, cx, p.y(3), body);
  p.rect(cx - w - 1, top - 1, cx + 1, top, [90, 90, 90]);
  const lamps = p.light.lamps;
  if (lamps > 0.1) {
    // A four-second flash.
    const phase = (p.time + o.seed * 0.37) % 4;
    const flash = phase < 0.5 ? Math.sin((phase / 0.5) * Math.PI) : 0;
    const c: RGB = red ? [255, 70, 60] : [140, 255, 150];
    p.lightDot(cx - w / 2, top - 2, c, lamps * (0.3 + flash * 0.7));
    p.glow(cx - w / 2, top - 2, 3 + flash * 5, c, lamps * flash * 0.8);
    for (let k = 1; k < 6; k++) {
      p.lightDot(cx - w / 2, base + k, c, lamps * flash * 0.5 * (1 - k / 6));
    }
  }
}
