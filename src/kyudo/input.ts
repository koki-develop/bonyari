import { clamp01 } from "../shared/core/math.ts";
import type { Renderer } from "./render/renderer.ts";
import type { World } from "./sim/world.ts";

/** Share of the screen's height a finger travels down to draw the bow fully. */
const DRAW_TRAVEL = 0.26;
/**
 * How far the aim moves for the finger's travel: at 1 the target would follow
 * the finger exactly; less gives a finer hand.
 */
const AIM_GAIN = 0.6;
/** Seconds a held key takes to draw the bow fully, and aim speed (m/s at the target) of the arrow keys. */
const KEY_DRAW_TIME = 2.2;
const KEY_AIM_SPEED = 0.25;

export interface InputHandlers {
  /** Any touch or key: the controls show, sound resumes. */
  activity(): void;
}

/**
 * The hand on the screen: press to raise the bow, pull down to draw, slide to
 * aim, let go to loose. Letting go before full draw lets the bow down instead.
 * The keyboard does the same with Space (hold) and the arrow keys.
 */
export class Input {
  private readonly canvas: HTMLCanvasElement;
  private readonly world: World;
  private readonly renderer: Renderer;
  private readonly handlers: InputHandlers;
  private pointer: number | null = null;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private baseGoal = 0;
  /** Once full draw is reached, up and down move the aim instead of the draw. */
  private reachedFull = false;
  private keyHeld = false;
  private readonly arrows = { left: false, right: false, up: false, down: false };

  constructor(
    canvas: HTMLCanvasElement,
    world: World,
    renderer: Renderer,
    handlers: InputHandlers,
  ) {
    this.canvas = canvas;
    this.world = world;
    this.renderer = renderer;
    this.handlers = handlers;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e, true));
    canvas.addEventListener("pointercancel", (e) => this.up(e, false));
    canvas.addEventListener("lostpointercapture", (e) => this.up(e, false));
    window.addEventListener("keydown", (e) => this.key(e, true));
    window.addEventListener("keyup", (e) => this.key(e, false));
    window.addEventListener("blur", () => this.releaseKeys());
  }

  /** Meters on the plane of the targets per CSS pixel of finger travel, now. */
  private metersPerCss(): number {
    const rect = this.canvas.getBoundingClientRect();
    const artPerCss = this.renderer.layout.width / Math.max(1, rect.width);
    return (artPerCss / this.renderer.pixelsPerMeterAtTarget) * AIM_GAIN;
  }

  private down(e: PointerEvent): void {
    this.handlers.activity();
    if (e.button !== 0 || !e.isPrimary || this.pointer !== null) {
      return;
    }
    if (!this.world.handBegin()) {
      return;
    }
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.startY = e.clientY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.baseGoal = this.world.archer.pullGoal;
    this.reachedFull = this.world.archer.full;
  }

  private move(e: PointerEvent): void {
    this.handlers.activity();
    if (e.pointerId !== this.pointer) {
      return;
    }
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const k = this.metersPerCss();
    if (this.reachedFull) {
      this.world.handNudge(dx * k, -dy * k);
      return;
    }
    const travel = this.canvas.getBoundingClientRect().height * DRAW_TRAVEL;
    const goal = this.baseGoal + (e.clientY - this.startY) / travel;
    this.world.handPull(clamp01(goal));
    this.world.handNudge(dx * k, 0);
    if (goal >= 1) {
      this.reachedFull = true;
    }
  }

  private up(e: PointerEvent, loose: boolean): void {
    if (e.pointerId !== this.pointer) {
      return;
    }
    this.pointer = null;
    if (loose) {
      this.world.handLoose();
    } else {
      this.world.handLetDown();
    }
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) {
      return;
    }
    const arrow = ARROW_KEYS[e.key];
    if (arrow) {
      this.arrows[arrow] = down;
      e.preventDefault();
      this.handlers.activity();
      return;
    }
    if (e.key !== " " && e.key !== "Enter") {
      return;
    }
    e.preventDefault();
    this.handlers.activity();
    if (down && !e.repeat && !this.keyHeld) {
      this.keyHeld = this.world.handBegin();
    } else if (!down && this.keyHeld) {
      this.keyHeld = false;
      this.world.handLoose();
    }
  }

  private releaseKeys(): void {
    if (this.keyHeld) {
      this.keyHeld = false;
      this.world.handLetDown();
    }
    this.arrows.left = this.arrows.right = this.arrows.up = this.arrows.down = false;
  }

  /** Draws with a held key, and aims with the arrow keys. */
  update(dt: number): void {
    if (this.keyHeld) {
      this.world.handPull(this.world.archer.pullGoal + dt / KEY_DRAW_TIME);
    }
    const a = this.arrows;
    const dx = (a.right ? 1 : 0) - (a.left ? 1 : 0);
    const dy = (a.up ? 1 : 0) - (a.down ? 1 : 0);
    if (dx !== 0 || dy !== 0) {
      this.world.handNudge(dx * KEY_AIM_SPEED * dt, dy * KEY_AIM_SPEED * dt);
    }
  }
}

const ARROW_KEYS: Record<string, "left" | "right" | "up" | "down" | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};
