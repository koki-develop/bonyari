import type { RGB } from "../../shared/core/color.ts";
import { clamp01, lerp, smoothstep } from "../../shared/core/math.ts";
import type { Surface } from "../../shared/core/surface.ts";
import { Pinhole } from "../../shared/render/pinhole.ts";
import { ARROW_REST, type Archer, LOWER_TIME } from "../sim/archer.ts";
import { EYE } from "../sim/dojo.ts";
import type { Vec3 } from "../sim/geometry.ts";
import { capsule, type P2 } from "./draw2d.ts";
import type { Illuminator } from "./illum.ts";

/*
 * The archer's own bow and arrow, seen from the eye. Positions here are
 * meters from the eye: x right, y up, z toward the targets. The bow is held in
 * the left hand; the arrow lies along the bow's right side at the level of the
 * mouth, and at full draw its nock is at the right cheek.
 */

/** Lengths (m) of the bow above and below the grip: a 2.21 m bow gripped a third of the way up. */
const UPPER = 1.45;
const LOWER = 0.76;
/** Distance (m) of the string from the grip when the bow is braced, and more at full draw. */
const BRACE = 0.15;
const DRAWN_BEND = 0.2;
/** Width (m) of the bow at the grip and at the tips. */
const GRIP_WIDTH = 0.029;
const TIP_WIDTH = 0.017;
/** Where the leather grip is wrapped, above and below the hand (m from the grip's center). */
const GRIP_WRAP: readonly [number, number] = [-0.07, 0.09];
/** Rattan bindings along the bow (m from the grip). */
const BINDINGS: readonly number[] = [-0.62, -0.3, 0.28, 0.62, 1.1, 1.36];

const LACQUER: RGB = [104, 54, 30];
const LEATHER: RGB = [48, 32, 24];
const RATTAN: RGB = [168, 128, 78];
const HORN: RGB = [26, 22, 20];
const STRING: RGB = [226, 216, 190];
const BAMBOO: RGB = [206, 176, 118];
/** Nearest depth (m) drawn: what is closer is too close to the eye to see. */
const NEAR = 0.06;

/** A pose of the bow hand and the drawing hand. */
interface Pose {
  /** Center of the grip. */
  grip: Vec3;
  /** Unit direction up along the bow, and toward the archer across it. */
  up: Vec3;
  /** The nock end of the arrow, where the string is drawn to. */
  nock: Vec3;
}

/** Standing: the bow held at the left hip, well below and beside the view. */
const REST: Pose = {
  grip: { x: 0.34, y: -0.78, z: 0.22 },
  up: { x: -0.12, y: 0.98, z: 0.16 },
  nock: { x: 0.42, y: -0.72, z: 0.1 },
};
/**
 * Raised above the head (uchiokoshi) and pushed toward the target (daisan).
 * The body faces a quarter turn right of the target, so the raised arms are
 * off to the right of the view, the bow leaning in toward the target.
 */
const RAISED: Pose = {
  grip: { x: 0.34, y: 0.3, z: 0.42 },
  up: { x: -0.3, y: 0.94, z: -0.12 },
  nock: { x: 0.48, y: 0.36, z: 0.06 },
};
/** Full draw (kai). */
const FULL: Pose = {
  grip: { x: ARROW_REST.x - 0.017, y: ARROW_REST.y - 0.004, z: ARROW_REST.z - 0.02 },
  up: { x: 0.02, y: 1, z: 0 },
  nock: { x: ARROW_REST.x, y: ARROW_REST.y, z: 0 },
};

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    grip: lerpVec(a.grip, b.grip, t),
    up: unit(lerpVec(a.up, b.up, t)),
    nock: lerpVec(a.nock, b.nock, t),
  };
}

/**
 * Draws the archer's bow and arrow over the view. The eye's own focal length
 * is used (the view may be closing in on the target; the bow is not).
 */
export class BowRenderer {
  private readonly cam = new Pinhole();

  draw(
    view: Surface,
    anchorX: number,
    anchorY: number,
    focal: number,
    archer: Archer,
    light: Illuminator,
    time: number,
  ): void {
    const cam = this.cam;
    cam.configure(view.width, view.height, anchorY, focal);
    cam.cx = anchorX;
    cam.eye = 0;
    // The bow is under the eaves of the hall, facing the bright range.
    light.at(0, EYE - 0.3, 0.5, 0.1, 0.8);

    const { pose, bend, turn, stringPull, arrow, shake } = this.pose(archer, time);
    // Points clipped to the near plane land on it within rounding.
    const project = (p: Vec3): P2 | null =>
      p.z < NEAR - 1e-9 ? null : { x: cam.x(p.x, p.z), y: cam.y(p.z, p.y) };

    // The bow: a curve through the grip, its limbs bending back toward the archer.
    const up = pose.up;
    // Across the bow toward the archer, turned about the bow by its twist in
    // the hand: after the release the string swings out to the left and round.
    const flat = unit({ x: up.x * up.z, y: up.y * up.z, z: -1 + up.z * up.z });
    const turned = cross(up, flat);
    const back: Vec3 = {
      x: flat.x * Math.cos(turn) + turned.x * Math.sin(turn),
      y: flat.y * Math.cos(turn) + turned.y * Math.sin(turn),
      z: flat.z * Math.cos(turn) + turned.z * Math.sin(turn),
    };
    const side = cross(up, back);
    const along = (s: number): Vec3 => {
      // Both limbs curve toward the string, the longer upper one less sharply.
      const length = s >= 0 ? UPPER : LOWER;
      const k = (s / length) ** 2;
      const curl = (BRACE + bend * DRAWN_BEND) * k * 1.15;
      const g = pose.grip;
      return {
        x: g.x + up.x * s + back.x * curl + shake * s * 0.01,
        y: g.y + up.y * s + back.y * curl,
        z: g.z + up.z * s + back.z * curl,
      };
    };
    const tipTop = along(UPPER);
    const tipBottom = along(-LOWER);

    // The string: straight from tip to tip, or drawn to the nock.
    const stringLine = (from: Vec3, to: Vec3) => {
      const a = project(from);
      const b = project(clipNear(from, to));
      if (a && b) {
        capsule(
          view,
          a,
          b,
          px(0.0012, from.z, focal),
          px(0.0012, clipNear(from, to).z, focal),
          () => light.color(STRING, 0.9),
        );
      }
    };
    const pulled = lerpVec(
      lerpVec(tipTop, tipBottom, UPPER / (UPPER + LOWER)),
      pose.nock,
      stringPull,
    );

    // Far to near: the string's far side when the bow has turned, the bow,
    // the arrow, and the string's near side.
    const stringBehind = Math.cos(turn) < 0;
    if (stringBehind) {
      stringLine(tipTop, pulled);
      stringLine(tipBottom, pulled);
    }
    this.bow(view, along, project, focal, light, side);
    if (arrow > 0) {
      this.arrow(view, pose, project, focal, light, arrow);
    }
    if (!stringBehind) {
      stringLine(tipTop, pulled);
      stringLine(tipBottom, pulled);
    }
  }

  /** Where everything is for the archer's state. */
  private pose(
    archer: Archer,
    time: number,
  ): { pose: Pose; bend: number; turn: number; stringPull: number; arrow: number; shake: number } {
    const d = archer.draw;
    const raised = lerpPose(REST, RAISED, smoothstep(0, 1, archer.raise));
    switch (archer.phase) {
      case "rest":
        return { pose: REST, bend: 0, turn: 0, stringPull: 0, arrow: 1, shake: 0 };
      case "draw": {
        // From the raised bow down into full draw; the string comes back with it.
        const e = d * d * (3 - 2 * d);
        const pose = lerpPose(raised, FULL, e);
        const drawnNock = lerpVec(
          { x: pose.grip.x + 0.02, y: pose.grip.y + 0.02, z: pose.grip.z - BRACE },
          FULL.nock,
          e,
        );
        const breath = archer.steadiness * Math.sin(time * 1.4) * 0.0015;
        pose.grip = { ...pose.grip, y: pose.grip.y + breath };
        return {
          pose: { ...pose, nock: drawnNock },
          bend: e,
          turn: 0,
          stringPull: 1,
          arrow: 1,
          shake: 0,
        };
      }
      case "release": {
        // The bow turns in the hand (yugaeri) and the string snaps home.
        const t = archer.releaseAge;
        const turn = Math.PI * smoothstep(0, 0.14, t) + Math.sin(t * 38) * Math.exp(-t * 9) * 0.25;
        const pose = {
          ...FULL,
          grip: { ...FULL.grip, z: FULL.grip.z + 0.012 * smoothstep(0, 0.1, t) },
        };
        const shake = Math.sin(t * 70) * Math.exp(-t * 7);
        return { pose, bend: 0, turn, stringPull: 0, arrow: 0, shake };
      }
      case "lower": {
        // The bow comes down to the side (yudaoshi).
        const p = smoothstep(0, 1, clamp01(archer.lowerAge / LOWER_TIME));
        const pose = lerpPose(FULL, REST, p);
        return {
          pose,
          bend: 0,
          turn: Math.PI * (1 - smoothstep(0.7, 1, p)),
          stringPull: 0,
          arrow: 0,
          shake: 0,
        };
      }
    }
  }

  private bow(
    view: Surface,
    along: (s: number) => Vec3,
    project: (p: Vec3) => P2 | null,
    focal: number,
    light: Illuminator,
    side: Vec3,
  ): void {
    const steps = 44;
    let prev: Vec3 | null = null;
    let prevS = 0;
    for (let i = 0; i <= steps; i++) {
      const s = -LOWER + ((UPPER + LOWER) * i) / steps;
      const p = along(s);
      if (prev) {
        const a = project(prev);
        const b = project(p);
        if (a && b) {
          const mid = (s + prevS) / 2;
          const width = lerp(GRIP_WIDTH, TIP_WIDTH, Math.abs(mid) / (mid >= 0 ? UPPER : LOWER));
          const color = bowColor(mid);
          capsule(view, a, b, px(width / 2, prev.z, focal), px(width / 2, p.z, focal), (u) => {
            // Lacquer shines along one edge, turned toward the light from the range.
            const shine = Math.max(0, 1 - Math.abs(u - 0.45 * Math.sign(side.x || 1)) * 2.2);
            return light.color(color, 0.8 + 0.2 * (1 - u * u) + shine * 0.45);
          });
        }
      }
      prev = p;
      prevS = s;
    }
  }

  private arrow(
    view: Surface,
    pose: Pose,
    project: (p: Vec3) => P2 | null,
    focal: number,
    light: Illuminator,
    alpha: number,
  ): void {
    // Along the bow's right side, resting on the thumb, its nock at the string.
    const tip: Vec3 = { x: pose.grip.x + 0.017, y: pose.grip.y + 0.004, z: pose.grip.z + 0.03 };
    const nock = pose.nock;
    const a = project(tip);
    const nearEnd = clipNear(tip, nock);
    const b = project(nearEnd);
    if (!a || !b) {
      return;
    }
    capsule(view, b, a, px(0.0045, nearEnd.z, focal), px(0.0045, tip.z, focal), (u) =>
      light.color(BAMBOO, (0.82 + 0.18 * (1 - u * u)) * alpha),
    );
  }
}

function bowColor(s: number): RGB {
  if (s >= GRIP_WRAP[0] && s <= GRIP_WRAP[1]) {
    return LEATHER;
  }
  if (s > UPPER - 0.035 || s < -LOWER + 0.03) {
    return HORN;
  }
  for (const b of BINDINGS) {
    if (Math.abs(s - b) < 0.02) {
      return RATTAN;
    }
  }
  return LACQUER;
}

/** Screen radius (px) of `m` meters at depth z. */
function px(m: number, z: number, focal: number): number {
  return (m * focal) / Math.max(NEAR, z);
}

/** The point on the segment from `from` toward `to` that is still in front of the eye. */
function clipNear(from: Vec3, to: Vec3): Vec3 {
  if (to.z >= NEAR) {
    return to;
  }
  const t = (from.z - NEAR) / (from.z - to.z);
  return { ...lerpVec(from, to, t), z: NEAR };
}
