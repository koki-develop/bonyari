import { approach, clamp, clamp01, smoothstep, TAU } from "../../shared/core/math.ts";
import { noise1 } from "../../shared/core/random.ts";
import { AIM_LIMITS, EYE, TARGET_DISTANCE, TARGET_HEIGHT } from "./dojo.ts";
import type { Vec3 } from "./geometry.ts";

/** Seconds to raise the bow (uchiokoshi) before drawing it down. */
export const RAISE_TIME = 0.6;
/** Fastest the draw (0..1) moves per second. */
const DRAW_SPEED = 1.3;
/** How quickly the draw follows the hand (1/s). */
const DRAW_FOLLOW = 12;
/** Seconds the archer stays still after the release (zanshin). */
export const RESIDUAL = 1.4;
/** Seconds to lower the bow afterwards (yudaoshi). */
export const LOWER_TIME = 1.6;
/**
 * Where the arrow's point sits at full draw, from the eye (m): along the right
 * side of the bow, at the level of the mouth. The eye sees the whole target
 * just to the left of the bow (the "ariake" sight picture).
 */
export const ARROW_REST: Vec3 = { x: 0.075, y: -0.075, z: 0.88 };

export type ArcherPhase =
  /** Standing with the bow at the side. */
  | "rest"
  /** Raising, drawing, holding at full draw (kai), or letting down without shooting. */
  | "draw"
  /** Just released: still, watching the arrow. */
  | "release"
  /** Lowering the bow; the next arrow is readied at the end. */
  | "lower";

export type ArcherEvent = "raise" | "full" | "letdown" | "nock";

/** The released arrow: from where, toward which point on the plane of the targets. */
export interface Shot {
  from: Vec3;
  aim: Vec3;
}

/** The default aim: the middle of one's own target. */
export function defaultAim(): { x: number; y: number } {
  return { x: 0, y: TARGET_HEIGHT };
}

/**
 * The archer on the shooting line. Commands come from the hand on the
 * screen; `update` moves the body toward them.
 */
export class Archer {
  phase: ArcherPhase = "rest";
  /** Bow raised above the head, 0..1. */
  raise = 0;
  /** Draw from raised (0) to full (1). In "release" it stays 1, and falls while lowering. */
  draw = 0;
  /** Whether an arrow is on the string. */
  nocked = true;
  /** Seconds since the release, while in "release". */
  releaseAge = 0;
  /** Seconds into lowering, while in "lower". */
  lowerAge = 0;
  /** The point aimed at on the plane of the targets. */
  aimX: number;
  aimY: number;
  /** Seconds this archer has existed; drives the sway of the breath. */
  time = 0;
  /** Events of the last update, including those of the commands given before it. */
  readonly events: ArcherEvent[] = [];
  /** The shot loosed since the previous update, reported by the last update. */
  shot: Shot | null = null;
  private readonly pendingEvents: ArcherEvent[] = [];
  private pendingShot: Shot | null = null;
  private raiseGoal = 0;
  private drawGoal = 0;
  private wasFull = false;
  private readonly seed: number;

  constructor(seed: number, aim = defaultAim()) {
    this.seed = seed;
    this.aimX = aim.x;
    this.aimY = aim.y;
  }

  /** At full draw (kai): ready to loose. */
  get full(): boolean {
    return this.phase === "draw" && this.raise >= 0.999 && this.draw >= 0.999;
  }

  /** Whether a new draw can begin now. */
  get ready(): boolean {
    return this.phase === "rest" || this.phase === "lower";
  }

  /**
   * How close the view has come to the target, 0 standing to 1 at full draw;
   * it follows the draw, held through the release and eased back as the bow is lowered.
   */
  get closeness(): number {
    const d = this.draw;
    const eased = d * d * (3 - 2 * d);
    return clamp01(0.1 * this.raise + 0.9 * eased);
  }

  /** How still the body is at full draw: the breath shows only there. */
  get steadiness(): number {
    return smoothstep(0.8, 1, this.draw) * this.raise;
  }

  /** Starts raising the bow; returns false unless ready. */
  begin(): boolean {
    if (!this.ready) {
      return false;
    }
    if (this.phase === "lower" || !this.nocked) {
      this.pendingEvents.push("nock");
    }
    this.phase = "draw";
    this.nocked = true;
    this.raiseGoal = 1;
    this.drawGoal = this.draw;
    this.pendingEvents.push("raise");
    return true;
  }

  /** Sets how far to draw (0..1); while the bow is still going up, the draw waits. */
  pull(goal: number): void {
    if (this.phase === "draw") {
      this.drawGoal = clamp01(goal);
    }
  }

  get pullGoal(): number {
    return this.drawGoal;
  }

  /** Moves the aim (m on the plane of the targets). */
  nudge(dx: number, dy: number): void {
    this.aimAt(this.aimX + dx, this.aimY + dy);
  }

  aimAt(x: number, y: number): void {
    this.aimX = clamp(x, AIM_LIMITS.x0, AIM_LIMITS.x1);
    this.aimY = clamp(y, AIM_LIMITS.y0, AIM_LIMITS.y1);
  }

  /** Lets go: at full draw the arrow flies, otherwise the draw is let down. */
  loose(): void {
    if (this.phase !== "draw") {
      return;
    }
    if (this.full) {
      this.pendingShot = { from: this.launchPoint(), aim: this.effectiveAim() };
      this.phase = "release";
      this.releaseAge = 0;
      this.nocked = false;
      this.draw = 1;
      return;
    }
    this.letDown();
  }

  /** Brings the bow back down without shooting. */
  letDown(): void {
    if (this.phase !== "draw") {
      return;
    }
    this.raiseGoal = 0;
    this.drawGoal = 0;
    this.pendingEvents.push("letdown");
  }

  /** The point aimed at, with the sway of the breath. */
  effectiveAim(): Vec3 {
    const k = this.steadiness;
    const t = this.time;
    const sx = (noise1(t * 0.35, this.seed) - 0.5) * 0.018 + Math.sin(t * 1.3) * 0.002;
    const sy = Math.sin(t * TAU * 0.22) * 0.009 + (noise1(t * 0.5, this.seed ^ 0x77) - 0.5) * 0.01;
    return { x: this.aimX + sx * k, y: this.aimY + sy * k, z: TARGET_DISTANCE };
  }

  /** Where the arrow's point leaves from. */
  launchPoint(): Vec3 {
    return { x: ARROW_REST.x, y: EYE + ARROW_REST.y, z: ARROW_REST.z };
  }

  update(dt: number): void {
    this.events.length = 0;
    this.events.push(...this.pendingEvents);
    this.pendingEvents.length = 0;
    this.shot = this.pendingShot;
    this.pendingShot = null;
    this.time += dt;
    switch (this.phase) {
      case "rest":
        break;
      case "draw": {
        const raiseStep = dt / RAISE_TIME;
        this.raise = clamp01(this.raise + Math.sign(this.raiseGoal - this.raise) * raiseStep);
        // The draw comes down only from the raised bow, and goes back before the bow is lowered.
        const goal = this.raise >= 0.999 ? this.drawGoal : Math.min(this.drawGoal, this.draw);
        const next = approach(this.draw, goal, DRAW_FOLLOW, dt);
        const step = clamp(next - this.draw, -DRAW_SPEED * dt, DRAW_SPEED * dt);
        this.draw = clamp01(this.draw + step);
        if (Math.abs(this.draw - goal) < 1e-3) {
          this.draw = goal;
        }
        if (this.raiseGoal === 0 && this.draw > 0) {
          // Letting down: the draw goes first, the bow waits for it.
          this.raise = Math.max(this.raise, 0.999);
        }
        const full = this.full;
        if (full && !this.wasFull) {
          this.events.push("full");
        }
        this.wasFull = full;
        if (this.raiseGoal === 0 && this.raise === 0 && this.draw === 0) {
          this.phase = "rest";
        }
        break;
      }
      case "release":
        this.releaseAge += dt;
        if (this.releaseAge >= RESIDUAL) {
          this.phase = "lower";
          this.lowerAge = 0;
        }
        break;
      case "lower": {
        this.lowerAge += dt;
        const p = clamp01(this.lowerAge / LOWER_TIME);
        // The arms come down first, then the bow returns to the side.
        this.draw = 1 - smoothstep(0, 0.6, p);
        this.raise = 1 - smoothstep(0.35, 1, p);
        if (p >= 1) {
          this.phase = "rest";
          this.raise = 0;
          this.draw = 0;
          this.nocked = true;
          this.raiseGoal = 0;
          this.drawGoal = 0;
          this.events.push("nock");
        }
        break;
      }
    }
    if (this.phase !== "draw") {
      this.wasFull = false;
    }
  }
}
