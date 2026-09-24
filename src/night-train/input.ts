import type { Renderer } from "./render/renderer.ts";

/** Minimum touch target (CSS px) around small interactive parts. */
const MIN_TARGET = 44;
/** Movement (art px) that turns a touch into a stroke. */
const STROKE_THRESHOLD = 1.5;
/** A touch held longer than this (s) keeps breathing on the glass. */
const HOLD = 0.35;

export interface InputHandlers {
  toggleLamp(): void;
  breathe(x: number, y: number, amount: number): void;
  breathSound(): void;
  wipe(x0: number, y0: number, x1: number, y1: number): void;
  activity(): void;
}

interface Gesture {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  held: number;
  stroke: boolean;
  breathing: boolean;
}

/**
 * Touch and mouse on the window: a tap breathes on the glass, holding keeps
 * breathing, a stroke wipes a line through the fog. The reading lamp toggles
 * the car lights.
 */
export class Input {
  private gesture: Gesture | null = null;
  private readonly renderer: Renderer;
  private readonly handlers: InputHandlers;

  constructor(canvas: HTMLCanvasElement, renderer: Renderer, handlers: InputHandlers) {
    this.renderer = renderer;
    this.handlers = handlers;
    canvas.addEventListener("pointerdown", (e) => this.down(e, canvas));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.cancel(e));
    canvas.addEventListener("lostpointercapture", (e) => this.cancel(e));
  }

  /** Continues a held touch; call every frame. */
  update(dt: number): void {
    const g = this.gesture;
    if (!g || g.stroke) {
      return;
    }
    g.held += dt;
    if (g.held > HOLD) {
      if (!g.breathing) {
        g.breathing = true;
        this.handlers.breathSound();
      }
      const w = this.renderer.layout.window;
      this.handlers.breathe(g.startX - w.x, g.startY - w.y, dt * 0.9);
    }
  }

  private art(e: PointerEvent): { x: number; y: number } {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    return this.renderer.toArt(e.clientX - rect.left, e.clientY - rect.top);
  }

  private onLamp(x: number, y: number): boolean {
    const { lamp, scale } = this.renderer.layout;
    const pad = Math.max(
      0,
      ((MIN_TARGET * window.devicePixelRatio) / scale - Math.min(lamp.w, lamp.h)) / 2,
    );
    return (
      x >= lamp.x - pad &&
      x < lamp.x + lamp.w + pad &&
      y >= lamp.y - pad &&
      y < lamp.y + lamp.h + pad
    );
  }

  private onGlass(x: number, y: number): boolean {
    const w = this.renderer.layout.window;
    return (
      x >= w.x &&
      y >= w.y &&
      x < w.x + w.w &&
      y < w.y + w.h &&
      this.renderer.interior.isGlass(Math.floor(x), Math.floor(y))
    );
  }

  private down(e: PointerEvent, canvas: HTMLCanvasElement): void {
    this.handlers.activity();
    if (e.button !== 0 || !e.isPrimary) {
      return;
    }
    const { x, y } = this.art(e);
    if (this.onLamp(x, y)) {
      this.handlers.toggleLamp();
      return;
    }
    if (!this.onGlass(x, y) || (this.gesture && this.gesture.id !== e.pointerId)) {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    this.gesture = {
      id: e.pointerId,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      held: 0,
      stroke: false,
      breathing: false,
    };
  }

  private move(e: PointerEvent): void {
    this.handlers.activity();
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) {
      return;
    }
    const { x, y } = this.art(e);
    if (!g.stroke && Math.hypot(x - g.startX, y - g.startY) > STROKE_THRESHOLD) {
      g.stroke = true;
    }
    if (g.stroke) {
      const w = this.renderer.layout.window;
      this.handlers.wipe(g.lastX - w.x, g.lastY - w.y, x - w.x, y - w.y);
      g.lastX = x;
      g.lastY = y;
    }
  }

  private up(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) {
      return;
    }
    if (!g.stroke && !g.breathing) {
      const w = this.renderer.layout.window;
      this.handlers.breathe(g.startX - w.x, g.startY - w.y, 0.65);
      this.handlers.breathSound();
    }
    this.gesture = null;
  }

  private cancel(e: PointerEvent): void {
    if (this.gesture?.id === e.pointerId) {
      this.gesture = null;
    }
  }
}
