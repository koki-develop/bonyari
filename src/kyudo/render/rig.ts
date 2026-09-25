import { DEG, lerp } from "../../shared/core/math.ts";
import { Pinhole } from "../../shared/render/pinhole.ts";
import type { Archer } from "../sim/archer.ts";
import { EYE, TARGET_DISTANCE } from "../sim/dojo.ts";
import type { Layout } from "./layout.ts";

/** The view looks a little west of north: the sun is behind the archer and lights the targets. */
export const DOJO_HEADING = 160 * DEG;
/** The point on the plane of the targets at the middle of the view at rest. */
const REST_LOOK = { x: 0, y: 0.55 } as const;
/** How much closer the eye comes to where the arrow struck, while watching it. */
const WATCH_CLOSER = 0.6;

/** Where the eye settles after the release: the point struck, on the plane of the targets. */
export interface Watch {
  x: number;
  y: number;
  /** 0 not watching, to 1 settled on it. */
  amount: number;
}

/**
 * Places the camera for the archer's eye: standing, it takes in the whole
 * range; as the bow is drawn the eye settles on the mark and the view closes
 * in on it. After the release it stays, and settles on where the arrow
 * struck, until the bow is lowered.
 */
export class CameraRig {
  readonly cam = new Pinhole();
  /** The mark the eye was on at the last full draw; held through the release. */
  private held = { x: 0, y: 0 };

  constructor() {
    this.cam.heading = DOJO_HEADING;
    this.cam.eye = EYE;
    this.cam.pos = 0;
  }

  update(layout: Layout, archer: Archer, watch: Watch): void {
    const cam = this.cam;
    if (archer.phase === "draw" || archer.phase === "rest") {
      const aim = archer.effectiveAim();
      this.held.x = aim.x;
      this.held.y = aim.y;
    }
    const c = archer.closeness;
    const w = watch.amount * c;
    const focal =
      layout.restFocal * Math.pow(layout.aimFocal / layout.restFocal, c) * (1 + WATCH_CLOSER * w);
    const lookX = lerp(lerp(REST_LOOK.x, this.held.x, c), watch.x, w);
    const lookY = lerp(lerp(REST_LOOK.y, this.held.y, c), watch.y, w);
    const anchorX = lerp(layout.restAnchor.x, layout.aimAnchor.x, c);
    const anchorY = lerp(layout.restAnchor.y, layout.aimAnchor.y, c);
    // Shift the principal point so the look point lands on the anchor. Whole
    // pixels only: the view moves in steps of the art's own pixels, and a pan
    // is an exact scroll of what is already drawn.
    const horizon = Math.round(anchorY - ((EYE - lookY) * focal) / TARGET_DISTANCE);
    cam.configure(layout.width, layout.height, horizon, focal);
    cam.cx = Math.round(anchorX - (lookX * focal) / TARGET_DISTANCE);
  }
}
