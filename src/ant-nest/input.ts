import type { Renderer } from "./render/renderer.ts";
import type { World } from "./sim/world.ts";

/** CSS pixels a finger may move and still tap. */
const TAP_SLOP = 8;
/** Longest press (ms) that still counts as a tap. */
const TAP_TIME = 600;
/** Art rows the arrow keys move the view by. */
const KEY_PAN = 24;

export interface InputHandlers {
  /** Any touch or key: the controls show, sound resumes. */
  activity(): void;
}

/**
 * Touches on the view: a tap above the ground drops a crumb there; on a
 * screen too short for the whole nest, dragging (or the wheel, or the arrow
 * keys) moves the view up and down.
 */
export class Input {
  private readonly canvas: HTMLCanvasElement;
  private readonly world: World;
  private readonly renderer: Renderer;
  private readonly handlers: InputHandlers;
  private pointer: number | null = null;
  private startX = 0;
  private startY = 0;
  private lastY = 0;
  private startTime = 0;
  private dragging = false;

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
    canvas.addEventListener(
      "wheel",
      (e) => {
        this.handlers.activity();
        this.renderer.panBy(-e.deltaY / this.cssPerArt());
        e.preventDefault();
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") {
        this.renderer.panBy(KEY_PAN);
      } else if (e.key === "ArrowDown") {
        this.renderer.panBy(-KEY_PAN);
      }
    });
  }

  /** CSS pixels per art pixel on the view now. */
  private cssPerArt(): number {
    const rect = this.canvas.getBoundingClientRect();
    return rect.height / Math.max(1, this.renderer.layout.height);
  }

  private down(e: PointerEvent): void {
    this.handlers.activity();
    if (!e.isPrimary || this.pointer !== null) {
      return;
    }
    this.pointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.lastY = e.clientY;
    this.startTime = performance.now();
    this.dragging = false;
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointer) {
      return;
    }
    this.handlers.activity();
    if (!this.dragging && Math.hypot(e.clientX - this.startX, e.clientY - this.startY) > TAP_SLOP) {
      this.dragging = true;
    }
    if (this.dragging) {
      this.renderer.panBy((e.clientY - this.lastY) / this.cssPerArt());
    }
    this.lastY = e.clientY;
  }

  private up(e: PointerEvent, finished: boolean): void {
    if (e.pointerId !== this.pointer) {
      return;
    }
    this.pointer = null;
    if (!finished || this.dragging || performance.now() - this.startTime > TAP_TIME) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const at = this.renderer.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    // Only over the ground: a crumb falls from where the finger is.
    if (at.y > this.world.surface.height(at.x) - 1) {
      this.world.dropCrumb(at.x, Math.max(at.y, this.world.surface.height(at.x) + 2));
    }
  }
}
