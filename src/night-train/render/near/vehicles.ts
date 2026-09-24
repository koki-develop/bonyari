import { hex, pack, type RGB } from "../../core/color.ts";
import { intervalCoverage, mod, pulseCoverage, smoothstep } from "../../core/math.ts";
import { hash2, Rng } from "../../core/random.ts";
import { type Car, ONCOMING_CAR_LENGTH, type OncomingTrain } from "../../sim/traffic.ts";
import type { Camera } from "../camera.ts";
import type { Cover } from "../cover.ts";
import type { Painter } from "../painter.ts";

/** Near face of a train on the adjacent track. */
export const ONCOMING_LATERAL = 2.7;
const BODY_BOTTOM = 0.95;
const BODY_TOP = 3.85;
const WINDOW_BOTTOM = 1.75;
const WINDOW_TOP = 2.75;
/** Top (m above the rails) of a raised pantograph. */
const PANTOGRAPH_TOP = 5.2;
/** Deck height of a container wagon, the top of its containers, and their spacing. */
const WAGON_DECK = 1.25;
const CONTAINER_TOP = 3.75;
const CONTAINER_PITCH = 6.6;
/** Spacing (m) of our own car's windows, whose light falls on the passing train. */
const OUR_WINDOW_PITCH = 2.4;
/** Spacing (m) of the passengers seated along the benches. */
const SEAT_PITCH = 0.5;
const BODY: RGB = [200, 204, 208];
const LOCOMOTIVES: readonly RGB[] = ["#3c5c96", "#a8403a", "#5f7f9e", "#b8483e"].map(hex);
const STRIPES: readonly RGB[] = ["#2f7ac0", "#2e9a5c", "#e07a2a", "#c83a3a"].map(hex);
const CONTAINERS: readonly RGB[] = [
  "#4f86b8",
  "#b14a3a",
  "#d6c7a0",
  "#3f7d5a",
  "#7a6f9a",
  "#c9a23a",
].map(hex);

/** One column of a passing train: what the drawing and the occlusion both need. */
interface OncomingColumn {
  along: number;
  /** Coverage of the pixel column by the train. */
  inside: number;
  /** Distance (m) from the front of the train, the car it falls in and the position within it. */
  u: number;
  carIndex: number;
  inCar: number;
  loco: boolean;
  wagon: boolean;
  /** Container slot on a wagon, whether it is loaded, and the coverage of its box. */
  slot: number;
  loaded: boolean;
  inBox: number;
}

const ONCOMING_COLUMN: OncomingColumn = {
  along: 0,
  inside: 0,
  u: 0,
  carIndex: 0,
  inCar: 0,
  loco: false,
  wagon: false,
  slot: 0,
  loaded: false,
  inBox: 0,
};

/** Fills `out` for column `x`; false where the train isn't. */
function oncomingColumn(
  cam: Camera,
  train: OncomingTrain,
  footprint: number,
  x: number,
  out: OncomingColumn,
): boolean {
  const along = cam.alongAt(x, ONCOMING_LATERAL);
  const tail = train.front - train.cars * ONCOMING_CAR_LENGTH;
  const inside = intervalCoverage(along, tail, train.front, footprint);
  if (inside <= 0) {
    return false;
  }
  // Distance from the front of the train, and position within a car.
  const u = train.front - along;
  const carIndex = Math.floor(u / ONCOMING_CAR_LENGTH);
  const inCar = mod(u, ONCOMING_CAR_LENGTH);
  out.along = along;
  out.inside = inside;
  out.u = u;
  out.carIndex = carIndex;
  out.inCar = inCar;
  out.loco = train.freight && carIndex === 0;
  out.wagon = train.freight && carIndex > 0;
  // Container slots on the wagons: some carry nothing.
  const slot = Math.floor(inCar / CONTAINER_PITCH);
  out.slot = slot;
  out.loaded = hash2(carIndex * 3 + slot, train.seed ^ 0x33) > 0.14;
  out.inBox = pulseCoverage(
    inCar - 0.3 - CONTAINER_PITCH / 2 + 0.25,
    CONTAINER_PITCH,
    6.1,
    footprint,
  );
  return true;
}

/**
 * Marks the pixels a passing train paints over opaquely: its body below the
 * roof line; on container wagons, the frame and the containers themselves.
 */
export function coverOncoming(
  cam: Camera,
  train: OncomingTrain,
  relativeTravel: number,
  cover: Cover,
): void {
  const lateral = ONCOMING_LATERAL;
  const footprint = cam.footprint(lateral, relativeTravel);
  const top = Math.max(0, Math.floor(cam.yRail(lateral, PANTOGRAPH_TOP)));
  const col = ONCOMING_COLUMN;
  for (let x = 0; x < cover.width; x++) {
    if (!oncomingColumn(cam, train, footprint, x, col) || col.inside < 1) {
      continue;
    }
    let runStart = -1;
    for (let y = top; y < cover.height; y++) {
      const h = cam.railHeightAt(y, lateral);
      const opaque =
        h <= BODY_TOP &&
        (h < BODY_BOTTOM ||
          !col.wagon ||
          h < WAGON_DECK ||
          (h < CONTAINER_TOP && col.loaded && col.inBox >= 1));
      if (opaque && runStart < 0) {
        runStart = y;
      } else if (!opaque && runStart >= 0) {
        cover.markRun(x, runStart, y, lateral);
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      cover.markRun(x, runStart, cover.height, lateral);
    }
  }
}

/**
 * A train passing on the adjacent track, rendered per pixel with the relative
 * speed as motion blur. Along the train, detail smears away at speed, so the
 * cars are built mostly from what varies with height: underfloor equipment,
 * the shaded and sky-reflecting body side, the window band with seats and
 * passengers, the rounded roof edge and the pantographs. Container wagons
 * show the view through the gaps between containers. At night its lit
 * windows smear into a ribbon of light, and our own windows light its side.
 * @param spill how strongly our lit car shines out onto it (0..1)
 */
export function drawOncoming(
  p: Painter,
  train: OncomingTrain,
  relativeTravel: number,
  spill: number,
): void {
  const { view, cam, shade, light } = p;
  const lateral = ONCOMING_LATERAL;
  shade.at(lateral);
  const footprint = cam.footprint(lateral, relativeTravel);
  const r = new Rng(train.seed);
  const stripe = r.pick(STRIPES);
  const upperStripe = r.chance(0.4);
  const locoBody = r.pick(LOCOMOTIVES);
  const lit = light.lamps;
  const night = spill * (1 - light.daylight);
  const [hr, hg, hb] = light.horizon;
  // The side faces us; the roof edge turns up to the sky.
  const side = p.surfaceLight(0, 0, 1);
  const roofEdge = p.surfaceLight(0, 0.8, 0.6);
  const top = Math.max(0, Math.floor(cam.yRail(lateral, PANTOGRAPH_TOP)));
  const col = ONCOMING_COLUMN;
  for (let x = 0; x < view.width; x++) {
    if (!oncomingColumn(cam, train, footprint, x, col)) {
      continue;
    }
    const { along, inside, u, carIndex, inCar, loco, wagon, slot, loaded, inBox } = col;
    const gap = pulseCoverage(u + 0.4, ONCOMING_CAR_LENGTH, 0.8, footprint);
    // Our windows' light falls on its side in pools.
    const pool =
      night > 0
        ? night * (0.5 + 0.5 * Math.cos(((along - cam.pos) / OUR_WINDOW_PITCH) * Math.PI * 2)) ** 2
        : 0;
    // Pantographs on every other passenger car, and on the locomotive.
    const pantograph =
      (wagon ? 0 : 1) *
      (loco || carIndex % 2 === 1 ? 1 : 0) *
      pulseCoverage(inCar - 4.2, ONCOMING_CAR_LENGTH, 1.6, footprint);
    const box = CONTAINERS[Math.floor(hash2(carIndex * 3 + slot, train.seed) * CONTAINERS.length)];
    // Passengers' heads in the windows, and the seats below them.
    const seat = Math.floor(u / SEAT_PITCH);
    const seated =
      hash2(seat, train.seed ^ 0x51) < 0.5
        ? pulseCoverage(u - SEAT_PITCH * 0.25, SEAT_PITCH, 0.24, footprint)
        : 0;
    // Heads sit at slightly different heights.
    const headTop = 2.36 + 0.1 * hash2(seat, train.seed ^ 0x52);
    for (let y = top; y < view.height; y++) {
      const h = cam.railHeightAt(y, lateral);
      let cr: number;
      let cg: number;
      let cb: number;
      let k = side;
      let emissive = 0;
      let reflect = 0;
      let alpha = inside;
      if (h > BODY_TOP) {
        // Above the roof line only the pantographs and roof boxes show.
        if (h < BODY_TOP + 0.3 && !wagon) {
          const unit = pulseCoverage(inCar - 1.5, ONCOMING_CAR_LENGTH - 3, 2.2, footprint);
          alpha *= unit;
          cr = 120;
          cg = 124;
          cb = 128;
        } else if (h < PANTOGRAPH_TOP) {
          alpha *= pantograph * 0.55;
          cr = 60;
          cg = 62;
          cb = 66;
        } else {
          continue;
        }
        if (alpha <= 0.01) {
          continue;
        }
      } else if (h < BODY_BOTTOM) {
        // Wheels and bogies, underfloor boxes between them.
        const bogie = pulseCoverage(inCar - 2.5 + 1.3, ONCOMING_CAR_LENGTH - 5, 2.6, footprint);
        const boxes = h > 0.4 ? pulseCoverage(inCar - 7, 6, 4.2, footprint) : 0;
        const v = 26 + bogie * 22 + boxes * 30;
        cr = v;
        cg = v;
        cb = v + 4;
        if (wagon && h > 0.7) {
          // The wagon's side sill.
          cr = 74;
          cg = 58;
          cb = 50;
        }
      } else if (wagon) {
        if (h < WAGON_DECK) {
          // Wagon frame under the containers.
          cr = 78;
          cg = 60;
          cb = 52;
          k *= h > WAGON_DECK - 0.08 ? 1.2 : 0.85;
        } else if (h < CONTAINER_TOP && loaded) {
          // Corrugated steel boxes with rails top and bottom, grimy low down;
          // the view shows through between them.
          alpha *= inBox;
          if (alpha <= 0.01) {
            continue;
          }
          const rib = pulseCoverage(inCar, 0.3, 0.08, footprint);
          const rail = h < WAGON_DECK + 0.12 || h > CONTAINER_TOP - 0.12 ? 0.75 : 1;
          // A painted panel with the operator's lettering near one end.
          const label =
            h > 2.5 && h < 2.8
              ? 0.35 * pulseCoverage(inCar - 1.5, CONTAINER_PITCH, 1.4, footprint)
              : 0;
          const grime = 1 - smoothstep(2.2, WAGON_DECK, h) * 0.18;
          const v = (1 - rib * 0.18) * rail * grime;
          cr = box[0] * v + (230 - box[0] * v) * label;
          cg = box[1] * v + (230 - box[1] * v) * label;
          cb = box[2] * v + (226 - box[2] * v) * label;
        } else {
          continue;
        }
      } else if (loco) {
        cr = locoBody[0];
        cg = locoBody[1];
        cb = locoBody[2];
        if (h > 1.8 && h < 2.3) {
          // Louvred grilles along the machine room.
          const louvre = mod(h, 0.12) < 0.04 ? 0.7 : 1;
          const grille = pulseCoverage(inCar - 8, 5, 3.5, footprint);
          k *= 1 - grille * (1 - louvre);
        } else if (h > 2.45 && h < 2.95) {
          // A row of small machine-room windows.
          const pane = pulseCoverage(inCar - 2, 2.6, 0.9, footprint);
          cr += (36 - cr) * pane;
          cg += (42 - cg) * pane;
          cb += (50 - cb) * pane;
          reflect = pane * 0.25;
        } else if (h > 3.4 && h < 3.48) {
          // Rain gutter.
          k *= 0.7;
        } else if (h > BODY_TOP - 0.2) {
          k = roofEdge;
        }
        if (h > 1.2 && h < 1.32) {
          cr = cg = cb = 220;
        }
      } else {
        // Stainless body: slightly darker low down, catching the sky higher up.
        cr = BODY[0];
        cg = BODY[1];
        cb = BODY[2];
        k *= 0.9 + 0.1 * smoothstep(BODY_BOTTOM, 2.6, h);
        reflect = 0.12 + 0.18 * smoothstep(2.8, BODY_TOP, h);
        if (h < BODY_BOTTOM + 0.1) {
          k *= 0.7;
        } else if (h > 1.25 && h < 1.5) {
          cr = stripe[0];
          cg = stripe[1];
          cb = stripe[2];
          reflect = 0.05;
        } else if (upperStripe && h > 2.85 && h < 2.95) {
          cr = stripe[0];
          cg = stripe[1];
          cb = stripe[2];
          reflect = 0.05;
        } else if (h > BODY_TOP - 0.25) {
          // The roof edge curves up to the sky.
          k = roofEdge;
          reflect = 0.3;
        }
        const win = pulseCoverage(inCar - 4.6, 2.3, 1.6, footprint);
        const door = pulseCoverage(inCar - 3.2, 6.5, 1.3, footprint);
        if (h > WINDOW_BOTTOM && h < WINDOW_TOP) {
          const glass = win * (1 - door);
          // Inside: seat backs, heads, the ceiling lights.
          let ir = 38;
          let ig = 44;
          let ib = 54;
          if (h < WINDOW_BOTTOM + 0.25) {
            ir = 52;
            ig = 58;
            ib = 92;
          } else if (h > 2.02 && h < headTop && seated > 0) {
            ir += (30 - ir) * seated;
            ig += (26 - ig) * seated;
            ib += (26 - ib) * seated;
          } else if (h > WINDOW_TOP - 0.12) {
            ir = 64;
            ig = 68;
            ib = 74;
          }
          const inner = glass * (1 - door * 0.3);
          cr += (ir - cr) * inner;
          cg += (ig - cg) * inner;
          cb += (ib - cb) * inner;
          reflect *= 1 - inner * 0.5;
          const bright =
            h > WINDOW_TOP - 0.12 ? 1.15 : h > 2.02 && h < headTop ? 0.9 - seated * 0.6 : 0.9;
          emissive = inner * lit * 0.95 * bright;
        }
        if (h < 2.9) {
          // Door leaves, a little proud of the body, with their own windows.
          const doorGlass = h > 1.9 && h < 2.7 ? 0.7 : 0;
          cr += (150 - cr) * door * 0.35;
          cg += (154 - cg) * door * 0.35;
          cb += (160 - cb) * door * 0.35;
          cr += (40 - cr) * door * doorGlass;
          cg += (46 - cg) * door * doorGlass;
          cb += (56 - cb) * door * doorGlass;
          emissive = Math.max(emissive, door * doorGlass * lit * 0.8);
        }
      }
      k *= 1 - gap * 0.85;
      k *= 1 + pool * 1.6 * Math.exp(-((h - 2.0) ** 2) / 1.4);
      let r0 = shade.litR(cr * k);
      let g0 = shade.litG(cg * k);
      let b0 = shade.litB(cb * k);
      if (reflect > 0) {
        r0 += (hr - r0) * reflect;
        g0 += (hg - g0) * reflect;
        b0 += (hb - b0) * reflect;
      }
      if (emissive > 0) {
        r0 += (236 - r0) * emissive;
        g0 += (232 - g0) * emissive;
        b0 += (206 - b0) * emissive;
      }
      view.blend(x, y, r0, g0, b0, alpha);
    }
  }
}

const CAR_BODIES: readonly RGB[] = [
  "#eeeeec",
  "#2a2c32",
  "#a02e2c",
  "#3a5a8a",
  "#b8bcc0",
  "#d8c8a0",
  "#4a6a4a",
].map(hex);

/** Side profile of each kind of car: roof height (m) along its length (0 = rear, 1 = front). */
const PROFILES: Record<Car["kind"], readonly (readonly [number, number])[]> = {
  // Sedan: trunk, rear window, roof, windshield, bonnet.
  car: [
    [0, 0.9],
    [0.18, 0.95],
    [0.3, 1.42],
    [0.62, 1.45],
    [0.76, 0.98],
    [1, 0.82],
  ],
  // Kei car: a tall box with a stub nose.
  kei: [
    [0, 1.62],
    [0.05, 1.7],
    [0.72, 1.68],
    [0.86, 1.0],
    [1, 0.9],
  ],
  // Minivan.
  van: [
    [0, 1.85],
    [0.04, 1.95],
    [0.74, 1.92],
    [0.88, 1.1],
    [1, 0.95],
  ],
  bus: [
    [0, 2.95],
    [0.02, 3.0],
    [0.98, 3.0],
    [1, 2.9],
  ],
};

/** Roof height (m) at fraction `t` of a profile. */
function profileAt(profile: readonly (readonly [number, number])[], t: number): number {
  for (let i = 1; i < profile.length; i++) {
    const [t1, h1] = profile[i];
    if (t <= t1) {
      const [t0, h0] = profile[i - 1];
      return h0 + ((h1 - h0) * (t - t0)) / Math.max(1e-6, t1 - t0);
    }
  }
  return profile[profile.length - 1][1];
}

/**
 * A car on the parallel road, seen from the side: its silhouette traced from
 * a profile, the body catching the sky along its shoulder, windows reflecting
 * the sky over a dark cabin, and wheels in their arches. Lamps at night.
 */
export function drawCar(p: Painter, car: Car, lateral: number): void {
  p.at(lateral);
  const s = p.s;
  const dims: Record<Car["kind"], number> = { car: 4.4, kei: 3.4, van: 4.7, bus: 11 };
  const len = dims[car.kind];
  const profile = PROFILES[car.kind];
  const color =
    car.kind === "bus" ? ([236, 236, 230] as RGB) : CAR_BODIES[car.color % CAR_BODIES.length];
  const x0 = p.x(car.along - len / 2);
  const x1 = p.x(car.along + len / 2);
  const base = p.y(0.05);
  const ground = p.y(0);
  if (x1 - x0 < 2) {
    p.rect(x0, p.y(profile[2][1]), Math.max(x0 + 1, x1), base, color);
    return;
  }
  const [hr, hg, hb] = p.light.horizon;
  const shoulder = p.surfaceLight(0, 0.7, 0.7);
  const flank = p.surfaceLight(0, -0.1, 1);
  const belt = car.kind === "bus" ? 1.15 : car.kind === "car" ? 0.9 : 1.0;
  const lamps = p.light.lamps;
  for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
    // Along the car from rear (0) to front (1).
    const f = (x + 0.5 - x0) / (x1 - x0);
    const t = car.dir > 0 ? f : 1 - f;
    const roof = profileAt(profile, t);
    const yRoof = Math.round(p.y(roof));
    for (let y = yRoof; y < Math.round(base); y++) {
      // Height (m) above the road.
      const hh = (ground - (y + 0.5)) / s;
      let c: RGB = color;
      let k = hh > belt - 0.12 && hh < belt ? shoulder : flank;
      let glass = 0;
      if (car.kind === "bus") {
        if (hh > 1.35 && hh < 2.6 && t > 0.05 && t < 0.95) {
          glass = mod(t * len, 1.3) < 1.1 ? 1 : 0;
        }
        if (hh > 0.9 && hh < 1.08) {
          c = STRIPES[car.seed % STRIPES.length];
        }
      } else if (hh > belt && hh < roof - 0.08) {
        // The glasshouse, split by pillars.
        const pillar =
          car.kind === "car"
            ? Math.abs(t - 0.47) < 0.03
            : Math.abs(t - 0.4) < 0.03 || Math.abs(t - 0.1) < 0.03;
        glass = pillar ? 0 : 1;
      }
      if (hh < 0.3) {
        k *= 0.7;
      }
      let cr = c[0] * k;
      let cg = c[1] * k;
      let cb = c[2] * k;
      if (glass > 0) {
        // Dark cabin behind glass that mirrors the sky toward its top.
        const sky = 0.25 + 0.35 * ((hh - belt) / Math.max(0.3, roof - belt));
        cr = 40;
        cg = 48;
        cb = 58;
        const lit = car.kind === "bus" && lamps > 0.3;
        if (lit) {
          p.lightDot(x, y, [236, 240, 230], 0.85);
          continue;
        }
        const lr = p.shade.litR(cr) + (hr - p.shade.litR(cr)) * sky;
        const lg = p.shade.litG(cg) + (hg - p.shade.litG(cg)) * sky;
        const lb = p.shade.litB(cb) + (hb - p.shade.litB(cb)) * sky;
        p.view.set(x, y, pack(lr, lg, lb));
        continue;
      }
      p.view.set(x, y, p.shade.color(cr, cg, cb));
    }
  }
  // Wheels in dark arches, with lighter hubs.
  const wr = Math.max(1, 0.32 * s);
  const axles = car.kind === "bus" ? [0.15, 0.78] : [0.17, 0.82];
  for (const a of axles) {
    const wx = x0 + (x1 - x0) * a;
    const wy = base - wr + 1;
    p.disc(wx, wy, wr * 1.15, [22, 22, 24]);
    p.disc(wx, wy, wr, [34, 34, 36]);
    if (wr >= 2) {
      p.disc(wx, wy, wr * 0.45, [150, 152, 156], true);
    }
  }
  if (lamps > 0.1) {
    const front = car.dir > 0 ? x1 : x0;
    const rear = car.dir > 0 ? x0 : x1;
    const ly = p.y(0.7);
    p.lightDot(front - (car.dir > 0 ? 1 : 0), ly, [255, 248, 220], 1);
    p.glow(front + car.dir * 2, ly, Math.max(3, 2.2 * s), [255, 240, 200], 0.4 * lamps);
    p.lightDot(rear - (car.dir > 0 ? 0 : 1), ly, [255, 40, 30], 0.9);
    p.glow(rear, ly, Math.max(2, 0.9 * s), [255, 40, 30], 0.25 * lamps);
  }
}
