import { hex, mix, pack, type RGB } from "../../shared/core/color.ts";
import { clamp01, smoothstep } from "../../shared/core/math.ts";
import type { Surface } from "../../shared/core/surface.ts";
import type { Dragon } from "../sim/raids.ts";
import type { World } from "../sim/world.ts";
import type { FrameInfo } from "./actors.ts";
import { COS_E, gyOf, S, SIN_E } from "./projection.ts";

const SCALES: RGB = hex("#962a24");
const SCALES_LIGHT: RGB = hex("#d0503a");
const SCALES_DARK: RGB = hex("#44121a");
const BELLY: RGB = hex("#d8a060");
const BELLY_DARK: RGB = hex("#9a6a3a");
const RIDGE: RGB = hex("#f0b070");
const MEMBRANE: RGB = hex("#521424");
const MEMBRANE_LIGHT: RGB = hex("#8e2c38");
const BONE: RGB = hex("#30100e");
const HORN: RGB = hex("#ece0c2");
const CLAW: RGB = hex("#e0d4b4");
const EDGE: RGB = hex("#140505");
const EYE: RGB = hex("#ffd84a");
const MAW: RGB = hex("#2a0608");

/** How much bigger than the meters below it is drawn: a beast that dwarfs the houses. */
const SIZE = 1.3;
/** Farthest (m) its shadow falls from under it, with the sun low. */
const SHADOW_REACH = 90;
/** Meters behind its middle to the tip of its tail, and ahead to the tip of its snout. */
const TAIL = 14;
const SNOUT = 9;
/** Thickness (m) along it, from the tail's tip (0) past the haunches, chest and slender neck to the snout (1). */
const GIRTH: readonly (readonly [number, number])[] = [
  [0, 0.08],
  [0.12, 0.22],
  [0.3, 0.48],
  [0.42, 0.85],
  [0.5, 1.12],
  [0.58, 1.3],
  [0.64, 1.18],
  [0.69, 0.7],
  [0.76, 0.48],
  [0.85, 0.44],
  [0.885, 0.66],
  [0.92, 0.64],
  [0.96, 0.42],
  [1, 0.22],
];
/** Where along it the neck leaves the chest, the head begins, the shoulders and haunches are. */
const NECK = 0.67;
const HEAD = 0.87;
const SHOULDERS = 0.62;
const HAUNCHES = 0.47;
/** Joints its body is drawn round, tail to snout. */
const JOINTS = 64;

/** A wing in its own frame: meters forward of the shoulder and out from it. */
const WING = {
  elbow: [-1.4, 4.4],
  wrist: [0.3, 8.8],
  fingers: [
    [-1, 12.8],
    [-3.8, 11.6],
    [-6, 8.8],
    [-7.2, 5.4],
  ],
  /** Where the membrane meets the flank again, by the haunches. */
  root: [-6, 0.6],
} as const;

type Pt = { x: number; y: number };
type P3 = { x: number; y: number; z: number };

/** A joint of the body: where it is in the world, how thick there, and how far along. */
export interface Joint extends P3 {
  r: number;
  t: number;
}

/** Its body as it flies: the joints of it, where its mouth is, and which way it faces. */
export interface DragonBody {
  joints: Joint[];
  mouth: P3;
  hx: number;
  hy: number;
}

/**
 * The shape of the body now: the tail sweeping side to side, the long neck
 * curving up from the chest and the head held level at the end of it, a
 * lift of the whole with each downbeat. Shared with the fire it breathes.
 */
export function dragonBody(d: Dragon): DragonBody {
  const hx = Math.sin(d.heading);
  const hy = -Math.cos(d.heading);
  const joints: Joint[] = [];
  for (let i = 0; i <= JOINTS; i++) {
    const t = i / JOINTS;
    const { along, across, up } = spine(d, t);
    joints.push({ ...world3(d, hx, hy, along, across, up), r: girth(t) * SIZE, t });
  }
  const tip = joints[JOINTS];
  const back = joints[JOINTS - 3];
  // Just ahead of the snout, between the jaws.
  const mouth = {
    x: tip.x + (tip.x - back.x) * 0.6,
    y: tip.y + (tip.y - back.y) * 0.6,
    z: tip.z - 0.5 * SIZE,
  };
  return { joints, mouth, hx, hy };
}

/** Where the backbone runs `t` along it (0 the tail's tip, 1 the snout), in the dragon's own frame. */
function spine(d: Dragon, t: number): { along: number; across: number; up: number } {
  const beat = d.flap * Math.PI * 2;
  // The tail sweeps; the neck bends a little the other way.
  const across =
    Math.sin(t * 6 - d.flap * 2.2) * (1 - t) ** 1.8 * 2 +
    Math.sin(d.flap * 0.9) * smoothstep(NECK, 1, t) * 0.8;
  const up =
    0.3 * Math.sin(beat + Math.PI) +
    2.4 * smoothstep(NECK, HEAD - 0.02, t) -
    0.4 * smoothstep(HEAD + 0.03, 1, t) -
    (t < 0.4 ? (0.4 - t) * 2.4 : 0);
  return { along: -TAIL + t * (TAIL + SNOUT), across, up };
}

/**
 * A point of the dragon (meters forward, to its side and up from its
 * middle, in its own frame) in the world, rolled about its length as it
 * leans into a turn.
 */
function world3(d: Dragon, hx: number, hy: number, along: number, across: number, up: number): P3 {
  const cb = Math.cos(d.bank);
  const sb = Math.sin(d.bank);
  const side = across * cb + up * sb;
  const lift = up * cb - across * sb;
  return {
    x: d.x + (hx * along - hy * side) * SIZE,
    y: d.y + (hy * along + hx * side) * SIZE,
    z: d.z + lift * SIZE,
  };
}

/** How far off from the eye a point is: the far drawn first, the near over them. */
function depth(p: P3): number {
  return p.y * COS_E - p.z * SIN_E;
}

/** Something to draw, and how far off it is. */
interface Part {
  depth: number;
  draw: () => void;
}

/** Which pixels are the dragon, for the dark edge drawn round it once it is all drawn. */
let mask = new Uint8Array(0);
/** Pixels of the ground its shadow falls on, so overlapping parts darken it only once. */
let shade = new Uint8Array(0);

/**
 * The dragon: a long red body from horned, heavy-jawed head down a slender
 * neck to the chest, the haunches and a whip of a tail ending in a spade,
 * ridged along the back and plated along the belly; forelegs and hind legs
 * drawn up under it, claws out; great bat's wings of bone and membrane
 * beating with their tips lagging; its eyes burn, and its jaws gape to
 * breathe fire. Drawn part by part from the far side to the near, so a
 * near wing sweeps over its back and a far one passes behind; ringed with a
 * dark edge; its shadow cast away from the sun onto the town below.
 */
export function drawDragon(f: FrameInfo, world: World, d: Dragon): void {
  const view = f.view;
  const w = view.width;
  const h = view.height;
  if (mask.length !== w * h) {
    mask = new Uint8Array(w * h);
  }
  const ground = world.groundAt(d.x, d.y);
  const light = f.shader.lightAt(d.x, d.y, ground + 2, [0, 0, 0]);
  const lit = (c: RGB): RGB => [
    c[0] * (0.45 + light[0] * 0.65),
    c[1] * (0.45 + light[1] * 0.65),
    c[2] * (0.45 + light[2] * 0.65),
  ];
  const body = dragonBody(d);
  const { joints, hx, hy } = body;
  const beat = d.flap * Math.PI * 2;
  const screen = (p: P3): Pt => ({ x: p.x / S - f.fx, y: gyOf(p.y, p.z) - f.fy });
  const local = (along: number, across: number, up: number) => world3(d, hx, hy, along, across, up);
  // Bounds of what it covers, for the edge and for clearing the mask after.
  const box = { x0: w, y0: h, x1: -1, y1: -1 };
  const cover = (p: Pt, r: number) => {
    box.x0 = Math.min(box.x0, Math.floor(p.x - r - 2));
    box.y0 = Math.min(box.y0, Math.floor(p.y - r - 2));
    box.x1 = Math.max(box.x1, Math.ceil(p.x + r + 2));
    box.y1 = Math.max(box.y1, Math.ceil(p.y + r + 2));
  };
  const parts: Part[] = [];

  // The body, joint by joint: scales lit on the back, darkening down the flanks to the pale belly plates.
  joints.forEach((j, i) => {
    const p = screen(j);
    const r = j.r / S;
    cover(p, r);
    const plated = j.t > 0.3 && j.t < 0.97;
    parts.push({ depth: depth(j), draw: () => bodyDisc(view, p, r, lit, i, plated) });
  });
  // Spines down the back and the neck.
  for (let i = Math.round(JOINTS * 0.18); i < Math.round(JOINTS * HEAD); i += 3) {
    const j = joints[i];
    const next = joints[i + 1];
    const base = { x: j.x, y: j.y, z: j.z + j.r * 0.85 };
    const tip = {
      x: j.x - (next.x - j.x) * 1.4,
      y: j.y - (next.y - j.y) * 1.4,
      z: j.z + j.r + 0.35 * SIZE * (0.5 + j.r),
    };
    parts.push({
      depth: depth(base) - 0.01,
      draw: () => line(view, screen(base), screen(tip), lit(RIDGE)),
    });
  }
  // The spade at the end of the tail.
  const tail = joints[0];
  const tail2 = joints[2];
  const dx = tail.x - tail2.x;
  const dy = tail.y - tail2.y;
  const dl = Math.hypot(dx, dy) || 1;
  const sx = -dy / dl;
  const sy = dx / dl;
  const blade = [
    { x: tail.x + sx * 0.9 * SIZE, y: tail.y + sy * 0.9 * SIZE, z: tail.z },
    { x: tail.x + (dx / dl) * 1.3 * SIZE, y: tail.y + (dy / dl) * 1.3 * SIZE, z: tail.z },
    { x: tail.x - sx * 0.9 * SIZE, y: tail.y - sy * 0.9 * SIZE, z: tail.z },
  ];
  parts.push({
    depth: depth(tail) + 0.01,
    draw: () => {
      const t = screen(tail);
      const [a, b, c] = blade.map(screen);
      triangle(view, t, a, b, lit(SCALES_DARK), 1, 1);
      triangle(view, t, b, c, lit(SCALES_DARK), 1, 1);
    },
  });

  // Legs drawn up under it in flight: thigh, shin, and a foot of claws.
  for (const [at, fore] of [
    [SHOULDERS, true],
    [HAUNCHES, false],
  ] as const) {
    const j = joints[Math.round(JOINTS * at)];
    const along = -TAIL + at * (TAIL + SNOUT);
    const r = j.r / SIZE;
    const up = spine(d, j.t).up;
    for (const side of [-1, 1]) {
      const hip = local(along, side * r * 0.7, up - r * 0.4);
      const knee = local(along + (fore ? 0.6 : -0.9), side * (r + 0.35), up - r - 0.5);
      const foot = local(along + (fore ? -0.2 : -2), side * (r + 0.3), up - r - 0.9);
      const thick = (fore ? 0.22 : 0.3) * SIZE;
      for (const [a, b, k] of [
        [hip, knee, thick],
        [knee, foot, thick * 0.7],
      ] as const) {
        for (let s = 0; s <= 3; s++) {
          const q = {
            x: a.x + ((b.x - a.x) * s) / 3,
            y: a.y + ((b.y - a.y) * s) / 3,
            z: a.z + ((b.z - a.z) * s) / 3,
          };
          const p = screen(q);
          cover(p, k / S);
          parts.push({ depth: depth(q), draw: () => limbDisc(view, p, k / S, lit) });
        }
      }
      parts.push({
        depth: depth(foot) - 0.02,
        draw: () => {
          const fp = screen(foot);
          for (const c of [-0.25, 0, 0.25]) {
            const tip = screen({
              x: foot.x - hx * 0.45 * SIZE - hy * c * SIZE,
              y: foot.y - hy * 0.45 * SIZE + hx * c * SIZE,
              z: foot.z - 0.2 * SIZE,
            });
            line(view, fp, tip, lit(CLAW));
          }
        },
      });
    }
  }

  // The head: brows over burning eyes, horns swept back, nostrils, and the jaw hanging open to breathe fire.
  const skull = joints[Math.round(JOINTS * 0.9)];
  const snout = joints[JOINTS];
  const head = spine(d, skull.t);
  const headAlong = head.along;
  const headUp = head.up;
  const headAcross = head.across;
  for (const side of [-1, 1]) {
    const root = local(headAlong - 0.2, headAcross + side * 0.35, headUp + 0.4);
    const bend = local(headAlong - 1.5, headAcross + side * 0.7, headUp + 1.1);
    const end = local(headAlong - 2.7, headAcross + side * 0.55, headUp + 0.8);
    parts.push({
      depth: depth(root) - 0.05,
      draw: () => {
        line(view, screen(root), screen(bend), lit(HORN), 2);
        line(view, screen(bend), screen(end), lit(HORN));
      },
    });
    const cheek = local(headAlong - 0.9, headAcross + side * 0.55, headUp - 0.1);
    const spur = local(headAlong - 1.6, headAcross + side * 0.85, headUp - 0.2);
    parts.push({
      depth: depth(cheek) - 0.05,
      draw: () => line(view, screen(cheek), screen(spur), lit(HORN)),
    });
    const eye = local(headAlong + 0.35, headAcross + side * 0.38, headUp + 0.28);
    const brow = local(headAlong + 0.1, headAcross + side * 0.42, headUp + 0.45);
    const browEnd = local(headAlong + 0.8, headAcross + side * 0.3, headUp + 0.4);
    parts.push({
      depth: depth(eye) - 0.06,
      draw: () => {
        const e = screen(eye);
        line(view, screen(brow), screen(browEnd), lit(SCALES_DARK));
        view.blend(e.x, e.y, EYE[0], EYE[1], EYE[2], 1);
        view.glow(e.x + 0.5, e.y + 0.5, 2.2, [255, 170, 40], 0.5);
      },
    });
    const nostril = local(SNOUT - 0.3, headAcross * 0.5 + side * 0.12, headUp - 0.25);
    parts.push({
      depth: depth(nostril) - 0.06,
      draw: () => {
        const n = screen(nostril);
        view.blend(n.x, n.y, MAW[0], MAW[1], MAW[2], 1);
      },
    });
  }
  if (d.breathing) {
    // The lower jaw dropped from under the skull, fire in the mouth between.
    const hinge = local(headAlong - 0.2, headAcross, headUp - 0.35);
    const chin = local(SNOUT - 0.4, headAcross * 0.5, headUp - 1.3);
    for (let s = 0; s <= 5; s++) {
      const q = {
        x: hinge.x + ((chin.x - hinge.x) * s) / 5,
        y: hinge.y + ((chin.y - hinge.y) * s) / 5,
        z: hinge.z + ((chin.z - hinge.z) * s) / 5,
      };
      const p = screen(q);
      const r = ((0.34 - s * 0.03) * SIZE) / S;
      cover(p, r);
      parts.push({ depth: depth(q) + 0.02, draw: () => limbDisc(view, p, r, lit) });
    }
    parts.push({
      depth: depth(snout) - 0.1,
      draw: () => {
        const m = screen(body.mouth);
        view.glow(m.x + 0.5, m.y + 0.5, 7, [255, 150, 50], 0.8);
        view.blend(m.x, m.y, 255, 240, 170, 1);
      },
    });
  }

  // The wings, rising and falling about the line of the body, the outer part lagging behind.
  for (const side of [-1, 1]) {
    const wg = wing(side, beat, local);
    const chain = [...wg.fingers, wg.root];
    const panels: [P3, P3, P3][] = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      panels.push([wg.wrist, chain[i], wg.scallops[i]], [wg.wrist, wg.scallops[i], chain[i + 1]]);
    }
    panels.push([wg.shoulder, wg.elbow, wg.root], [wg.elbow, wg.wrist, wg.root]);
    panels.forEach(([a, b, c], k) => {
      const mid = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 };
      // Panels between the fingers alternately catch the light, as a membrane stretched over ribs does.
      const tone = lit(
        mix(MEMBRANE, MEMBRANE_LIGHT, clamp01(wg.flat * 0.75 + (k % 2 === 0 ? 0.12 : -0.05))),
      );
      const [pa, pb, pc] = [a, b, c].map(screen);
      cover(pa, 0);
      cover(pb, 0);
      cover(pc, 0);
      parts.push({ depth: depth(mid), draw: () => triangle(view, pa, pb, pc, tone, 0.95, 2) });
    });
    // The bones and the scalloped trailing edge over the membrane.
    const bones: [P3, P3, number, RGB][] = [
      [wg.shoulder, wg.elbow, 2, BONE],
      [wg.elbow, wg.wrist, 2, BONE],
      ...wg.fingers.map((tip): [P3, P3, number, RGB] => [wg.wrist, tip, 1, BONE]),
    ];
    for (let i = 0; i + 1 < chain.length; i++) {
      bones.push([chain[i], wg.scallops[i], 1, EDGE], [wg.scallops[i], chain[i + 1], 1, EDGE]);
    }
    for (const [a, b, width, color] of bones) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      parts.push({
        depth: depth(mid) - 0.02,
        draw: () => line(view, screen(a), screen(b), color === EDGE ? EDGE : lit(color), width),
      });
    }
  }

  if (f.shader.sunUp) {
    castShadow(view, f, world, body, beat, local);
  }
  box.x0 = Math.max(0, box.x0);
  box.y0 = Math.max(0, box.y0);
  box.x1 = Math.min(w - 1, box.x1);
  box.y1 = Math.min(h - 1, box.y1);
  parts.sort((a, b) => b.depth - a.depth);
  for (const p of parts) {
    p.draw();
  }
  // A dark edge round the whole of it; then the mask cleared for the next frame.
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const i = y * w + x;
      if (mask[i] !== 0) {
        continue;
      }
      if (
        (x > 0 && mask[i - 1] !== 0) ||
        (x < w - 1 && mask[i + 1] !== 0) ||
        (y > 0 && mask[i - w] !== 0) ||
        (y < h - 1 && mask[i + w] !== 0)
      ) {
        view.blend(x, y, EDGE[0], EDGE[1], EDGE[2], 0.85);
      }
    }
  }
  for (let y = box.y0; y <= box.y1; y++) {
    mask.fill(0, y * w + box.x0, y * w + box.x1 + 1);
  }
}

/** Thickness (m) of the body a way `t` along it (0 the tail's tip, 1 the snout). */
function girth(t: number): number {
  for (let i = 1; i < GIRTH.length; i++) {
    const [t1, r1] = GIRTH[i];
    if (t <= t1) {
      const [t0, r0] = GIRTH[i - 1];
      return r0 + ((r1 - r0) * (t - t0)) / (t1 - t0);
    }
  }
  return GIRTH[GIRTH.length - 1][1];
}

interface WingShape {
  shoulder: P3;
  elbow: P3;
  wrist: P3;
  fingers: P3[];
  /** Between each finger's tip and the next, the scalloped trailing edge drawn in toward the wrist. */
  scallops: P3[];
  root: P3;
  /** How flat the wing lies: 1 spread level (catching the light), toward 0 raised or lowered. */
  flat: number;
}

/** A wing's points in the world, raised by the beat, the outer part following behind. */
function wing(
  side: number,
  beat: number,
  local: (a: number, c: number, u: number) => P3,
): WingShape {
  // Held a little above level, beating through some sixty degrees.
  const inner = 0.12 + 0.5 * Math.sin(beat);
  const outer = 0.2 + 0.58 * Math.sin(beat - 0.9);
  const shoulder = { along: -TAIL + SHOULDERS * (TAIL + SNOUT) + 0.4, across: side * 0.9, up: 0.7 };
  const place = ([fwd, out]: readonly [number, number], lift: number): P3 =>
    local(
      shoulder.along + fwd,
      shoulder.across + side * out * Math.cos(lift),
      shoulder.up + out * Math.sin(lift),
    );
  const elbow = place(WING.elbow, inner);
  const wrist = place(WING.wrist, (inner + outer) / 2);
  const fingers = WING.fingers.map((p) => place(p, outer));
  const root = place(WING.root, inner * 0.3);
  const chain = [...fingers, root];
  const scallops: P3[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    scallops.push({
      x: m.x + (wrist.x - m.x) * 0.22,
      y: m.y + (wrist.y - m.y) * 0.22,
      z: m.z + (wrist.z - m.z) * 0.22,
    });
  }
  return {
    shoulder: local(shoulder.along, shoulder.across, shoulder.up),
    elbow,
    wrist,
    fingers,
    scallops,
    root,
    flat: Math.cos((inner + outer) / 2),
  };
}

/** The shadow of body and wings, cast away from the sun onto the ground, darkening each pixel once. */
function castShadow(
  view: Surface,
  f: FrameInfo,
  world: World,
  body: DragonBody,
  beat: number,
  local: (a: number, c: number, u: number) => P3,
): void {
  const w = view.width;
  const h = view.height;
  if (shade.length !== w * h) {
    shade = new Uint8Array(w * h);
  }
  const sun = f.shader.sunFlat;
  const slope = Math.max(0.2, f.shader.sunSlope);
  const onGround = (p: P3): Pt => {
    const fall = Math.min(SHADOW_REACH, (p.z - world.groundAt(p.x, p.y)) / slope);
    const x = p.x - sun.x * fall;
    const y = p.y - sun.y * fall;
    return { x: x / S - f.fx, y: gyOf(y, world.groundAt(x, y)) - f.fy };
  };
  const box = { x0: w, y0: h, x1: -1, y1: -1 };
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) {
      shade[y * w + x] = 1;
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x);
      box.y1 = Math.max(box.y1, y);
    }
  };
  for (const j of body.joints) {
    const c = onGround(j);
    const r = j.r / S;
    for (let yy = -Math.ceil(r); yy <= Math.ceil(r); yy++) {
      for (let xx = -Math.ceil(r); xx <= Math.ceil(r); xx++) {
        if (xx * xx + yy * yy * 1.6 <= r * r) {
          mark(Math.round(c.x + xx), Math.round(c.y + yy * 0.6));
        }
      }
    }
  }
  for (const side of [-1, 1]) {
    const wg = wing(side, beat, local);
    const chain = [...wg.fingers, wg.root];
    const tris: [P3, P3, P3][] = [
      [wg.shoulder, wg.elbow, wg.root],
      [wg.elbow, wg.wrist, wg.root],
    ];
    for (let i = 0; i + 1 < chain.length; i++) {
      tris.push([wg.wrist, chain[i], chain[i + 1]]);
    }
    for (const [a, b, c] of tris) {
      eachInTriangle(w, h, onGround(a), onGround(b), onGround(c), mark);
    }
  }
  const data = view.data;
  for (let y = Math.max(0, box.y0); y <= box.y1; y++) {
    for (let x = Math.max(0, box.x0); x <= box.x1; x++) {
      const i = y * w + x;
      if (shade[i] === 1) {
        shade[i] = 0;
        if (f.z[i] > -1e8) {
          const o = data[i];
          data[i] = pack((o & 255) * 0.66, ((o >>> 8) & 255) * 0.66, ((o >>> 16) & 255) * 0.7);
        }
      }
    }
  }
}

/** A joint of the body, `r` pixels round: the back lit, the flanks shaded, pale plates below, a pattern of scales. */
function bodyDisc(
  view: Surface,
  p: Pt,
  r: number,
  lit: (c: RGB) => RGB,
  seg: number,
  plated: boolean,
): void {
  const n = Math.ceil(r);
  const scales = lit(SCALES);
  const light = lit(SCALES_LIGHT);
  const dark = lit(SCALES_DARK);
  const belly = lit(seg % 2 === 0 ? BELLY : BELLY_DARK);
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      if (i * i + j * j > r * r) {
        continue;
      }
      const down = j / (r || 1);
      const side = Math.abs(i) / (r || 1);
      let color: RGB;
      if (plated && down > 0.55) {
        color = belly;
      } else {
        const k = clamp01(0.55 - down * 0.5 - side * 0.25);
        color = k > 0.5 ? mix(scales, light, (k - 0.5) * 2) : mix(dark, scales, k * 2);
        if (((i + seg * 2 + (j & 1) * 2) & 3) === 0 && (j & 1) === 0) {
          color = mix(color, dark, 0.35);
        }
      }
      put(view, p.x + i, p.y + j, color, 1);
    }
  }
}

/** A round of a leg or the jaw: scales, darker below. */
function limbDisc(view: Surface, p: Pt, r: number, lit: (c: RGB) => RGB): void {
  const n = Math.ceil(r);
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      if (i * i + j * j <= r * r + 0.5) {
        put(view, p.x + i, p.y + j, lit(j < 0 ? SCALES : SCALES_DARK), 1);
      }
    }
  }
}

/** A pixel of the dragon: drawn, and marked as part of it (`id` 1 the body, 2 a wing). */
function put(view: Surface, x: number, y: number, c: RGB, id: number, alpha = 1): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= view.width || py >= view.height) {
    return;
  }
  view.blend(px, py, c[0], c[1], c[2], alpha);
  mask[py * view.width + px] = id;
}

function triangle(view: Surface, a: Pt, b: Pt, c: Pt, color: RGB, alpha: number, id: number): void {
  eachInTriangle(view.width, view.height, a, b, c, (x, y) => put(view, x, y, color, id, alpha));
}

/** Calls `visit` for each pixel whose middle lies in the triangle abc. */
function eachInTriangle(
  w: number,
  h: number,
  a: Pt,
  b: Pt,
  c: Pt,
  visit: (x: number, y: number) => void,
): void {
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-6) {
    return;
  }
  const s = area > 0 ? 1 : -1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (
        ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)) * s >= 0 &&
        ((c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)) * s >= 0 &&
        ((a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x)) * s >= 0
      ) {
        visit(x, y);
      }
    }
  }
}

/** A line of pixels `width` wide from a to b. */
function line(view: Surface, a: Pt, b: Pt, c: RGB, width = 1): void {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))));
  for (let k = 0; k <= n; k++) {
    const x = a.x + ((b.x - a.x) * k) / n;
    const y = a.y + ((b.y - a.y) * k) / n;
    put(view, x, y, c, 1);
    if (width > 1) {
      put(view, x, y + 1, c, 1);
    }
  }
}
