import { hex, type RGB } from "../../core/color.ts";
import { intervalCoverage, mod, pulseCoverage } from "../../core/math.ts";
import { hash2, Rng } from "../../core/random.ts";
import type { Surface } from "../../core/surface.ts";
import { type Car, ONCOMING_CAR_LENGTH, type OncomingTrain } from "../../sim/traffic.ts";
import type { Camera } from "../camera.ts";
import type { Lighting } from "../lighting.ts";
import type { Painter } from "../painter.ts";
import type { Shade } from "../shade.ts";

/** Near face of a train on the adjacent track. */
export const ONCOMING_LATERAL = 2.7;
const BODY_BOTTOM = 0.95;
const BODY_TOP = 3.85;
const STRIPES: readonly RGB[] = ["#2f7ac0", "#2e9a5c", "#e07a2a", "#c83a3a"].map(hex);
const CONTAINERS: readonly RGB[] = [
  "#4f86b8",
  "#b14a3a",
  "#d6c7a0",
  "#3f7d5a",
  "#7a6f9a",
  "#c9a23a",
].map(hex);

/**
 * A train passing on the adjacent track, rendered per pixel with the relative
 * speed as motion blur — at night its lit windows smear into a ribbon of light.
 */
export function drawOncoming(
  view: Surface,
  cam: Camera,
  shade: Shade,
  light: Lighting,
  train: OncomingTrain,
  relativeTravel: number,
): void {
  const lateral = ONCOMING_LATERAL;
  shade.at(lateral);
  const footprint = cam.footprint(lateral, relativeTravel);
  const tail = train.front - train.cars * ONCOMING_CAR_LENGTH;
  const r = new Rng(train.seed);
  const stripe = r.pick(STRIPES);
  const lit = light.lamps;
  const top = Math.max(0, Math.floor(cam.yRail(lateral, BODY_TOP + 0.3)));
  for (let x = 0; x < view.width; x++) {
    const along = cam.alongAt(x, lateral);
    const inside = intervalCoverage(along, tail, train.front, footprint);
    if (inside <= 0) {
      continue;
    }
    // Distance from the front of the train, and position within a car.
    const u = train.front - along;
    const carIndex = Math.floor(u / ONCOMING_CAR_LENGTH);
    const inCar = mod(u, ONCOMING_CAR_LENGTH);
    const gap = pulseCoverage(u + 0.4, ONCOMING_CAR_LENGTH, 0.8, footprint);
    for (let y = top; y < view.height; y++) {
      const h = cam.railHeightAt(y, lateral);
      if (h > BODY_TOP + 0.3) {
        continue;
      }
      let cr: number;
      let cg: number;
      let cb: number;
      let emissive = 0;
      if (h < BODY_BOTTOM) {
        // Underfloor and bogies.
        const bogie = pulseCoverage(inCar - 2.5 + 1.3, ONCOMING_CAR_LENGTH - 5, 2.6, footprint);
        const k = 30 + bogie * 20;
        cr = k;
        cg = k;
        cb = k + 4;
      } else if (train.freight && carIndex > 0) {
        // Container wagons: boxes with gaps between them.
        const box =
          CONTAINERS[
            Math.floor(
              hash2(carIndex * 3 + Math.floor(inCar / 6.6), train.seed) * CONTAINERS.length,
            )
          ];
        const inBox = pulseCoverage(inCar - 0.3, 6.6, 6.1, footprint);
        const boxTop = 3.5;
        if (h > boxTop) {
          continue;
        }
        const rib = pulseCoverage(inCar, 0.6, 0.08, footprint) * 0.2;
        cr = 44 + (box[0] * (1 - rib) - 44) * inBox;
        cg = 44 + (box[1] * (1 - rib) - 44) * inBox;
        cb = 48 + (box[2] * (1 - rib) - 48) * inBox;
      } else {
        const loco = train.freight && carIndex === 0;
        const body: RGB = loco ? [60, 92, 150] : [202, 206, 210];
        cr = body[0];
        cg = body[1];
        cb = body[2];
        if (h > 1.25 && h < 1.5 && !loco) {
          cr = stripe[0];
          cg = stripe[1];
          cb = stripe[2];
        }
        const windowBand = h > 1.75 && h < 2.75;
        if (windowBand) {
          const win = loco
            ? pulseCoverage(inCar - 1, 16, 1.2, footprint)
            : pulseCoverage(inCar - 4.6, 2.3, 1.6, footprint);
          const doorZone = loco ? 0 : pulseCoverage(inCar - 3.2, 6.5, 1.3, footprint);
          const glass = win * (1 - doorZone);
          cr += (40 - cr) * glass;
          cg += (48 - cg) * glass;
          cb += (58 - cb) * glass;
          emissive = glass * lit * (loco ? 0.2 : 0.95);
        }
        const door = loco ? 0 : pulseCoverage(inCar - 3.2, 6.5, 1.3, footprint) * (h < 2.9 ? 1 : 0);
        cr += (170 - cr) * door * 0.4;
        cg += (174 - cg) * door * 0.4;
        cb += (178 - cb) * door * 0.4;
      }
      const k = 1 - gap * 0.85;
      let r0 = shade.litR(cr) * k;
      let g0 = shade.litG(cg) * k;
      let b0 = shade.litB(cb) * k;
      if (emissive > 0) {
        r0 += (236 - r0) * emissive;
        g0 += (232 - g0) * emissive;
        b0 += (206 - b0) * emissive;
      }
      view.blend(x, y, r0, g0, b0, inside);
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

/** A car on the parallel road, seen from the side. */
export function drawCar(p: Painter, car: Car, lateral: number): void {
  const r = new Rng(car.seed);
  p.at(lateral);
  const s = p.s;
  const dims: Record<Car["kind"], [number, number]> = {
    car: [4.4, 1.45],
    kei: [3.4, 1.7],
    van: [4.7, 1.95],
    bus: [11, 3.0],
  };
  const [len, h] = dims[car.kind];
  const x0 = p.x(car.along - len / 2);
  const x1 = p.x(car.along + len / 2);
  const base = p.y(0.05);
  const top = p.y(h);
  const color =
    car.kind === "bus" ? ([236, 236, 230] as RGB) : CAR_BODIES[car.color % CAR_BODIES.length];
  if (x1 - x0 < 2) {
    p.rect(x0, top, Math.max(x0 + 1, x1), base, color);
  } else {
    const belt = p.y(h * 0.55);
    const cabin0 = car.kind === "car" ? x0 + (x1 - x0) * 0.22 : x0 + 1;
    const cabin1 = car.kind === "car" ? x1 - (x1 - x0) * 0.25 : x1 - 1;
    p.rect(x0, belt, x1, base, color);
    p.rect(cabin0, top, cabin1, belt, color);
    const glassTop = top + Math.max(1, 0.15 * s);
    p.rect(cabin0 + 1, glassTop, cabin1 - 1, belt, [48, 56, 66]);
    if (car.kind === "bus") {
      p.rect(x0, p.y(1.2), x1, p.y(1.0), r.pick(STRIPES));
      if (p.light.lamps > 0.3) {
        p.lightRect(cabin0 + 1, glassTop, cabin1 - 1, belt, [236, 240, 230], 0.8);
      }
    }
    // Wheels.
    const wr = Math.max(1, 0.33 * s);
    for (const f of [0.18, 0.82]) {
      const wx = x0 + (x1 - x0) * f;
      p.rect(wx - wr, base - wr, wx + wr, base + 1, [26, 26, 28]);
    }
  }
  if (p.light.lamps > 0.1) {
    const front = car.dir > 0 ? x1 : x0;
    const rear = car.dir > 0 ? x0 : x1;
    const ly = p.y(0.7);
    p.lightDot(front - (car.dir > 0 ? 1 : 0), ly, [255, 248, 220], 1);
    p.glow(front + car.dir * 2, ly, Math.max(3, 2.2 * s), [255, 240, 200], 0.4 * p.light.lamps);
    p.lightDot(rear - (car.dir > 0 ? 0 : 1), ly, [255, 40, 30], 0.9);
    p.glow(rear, ly, Math.max(2, 0.9 * s), [255, 40, 30], 0.25 * p.light.lamps);
  }
}
