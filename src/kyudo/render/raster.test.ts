import { describe, expect, it } from "vitest";
import { Pinhole } from "../../shared/render/pinhole.ts";
import { EYE, HALL_PRIMS, OUTER_GROUND, RANGE_PRIMS } from "../sim/dojo.ts";
import { castRay, makeHit } from "../sim/geometry.ts";
import { facesOf, NEAR, rasterize } from "./raster.ts";

const PRIMS = [...RANGE_PRIMS, ...HALL_PRIMS, OUTER_GROUND];
const FACES = facesOf(PRIMS);

function camera(
  width: number,
  height: number,
  focal: number,
  cx: number,
  horizon: number,
): Pinhole {
  const cam = new Pinhole();
  cam.configure(width, height, horizon, focal);
  cam.cx = cx;
  cam.eye = EYE;
  return cam;
}

describe("rasterizer", () => {
  it.each([
    ["standing, portrait", camera(195, 422, 520, 97, 198)],
    ["standing, landscape", camera(400, 190, 400, 200, 110)],
    ["at full draw, on the own target", camera(195, 422, 1850, 97, 74)],
    ["looking down at the lawn", camera(195, 422, 1850, 30, -40)],
  ])("sees at every pixel what a ray from the eye strikes first (%s)", (_name, cam) => {
    const w = cam.width;
    const h = cam.height;
    const face = new Int16Array(w * h);
    const depth = new Float32Array(w * h);
    rasterize(cam, FACES, face, depth, w, 0, 0, w, h);
    const hit = makeHit();
    let checked = 0;
    let differing = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const dx = (x + 0.5 - cam.cx) / cam.focal;
        const dy = (cam.horizon - (y + 0.5)) / cam.focal;
        const ray = castRay(PRIMS, 0, EYE, 0, dx, dy, 1, NEAR, 1e6, hit);
        const i = y * w + x;
        const seen = face[i] < 0 ? null : PRIMS[FACES[face[i]].prim];
        checked++;
        if ((ray?.prim ?? null) !== seen) {
          differing++;
          continue;
        }
        if (ray) {
          expect(depth[i]).toBeCloseTo(ray.t, 3);
        }
      }
    }
    // Only pixels whose center falls on an edge between two parts may differ.
    expect(differing / checked).toBeLessThan(0.002);
  });
});
