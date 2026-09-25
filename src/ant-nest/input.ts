import type { Viewport } from "./render/viewport.ts";
import type { World } from "./sim/world.ts";

/** CSS pixels a finger may move and still tap. */
const TAP_SLOP = 8;
/** Longest press (ms) that still counts as a tap. */
const TAP_TIME = 600;
/** CSS pixels the arrow keys move the view by. */
const KEY_PAN = 48;
/** How much the wheel zooms per pixel it turns; a pinch on a touchpad turns it with ctrl held. */
const WHEEL_ZOOM = 0.0025;
const PINCH_WHEEL_ZOOM = 0.01;
/** Pixels one line of the wheel turns, for wheels that count lines. */
const WHEEL_LINE = 16;

export interface InputHandlers {
  /** Any touch or key: the controls show, sound resumes. */
  activity(): void;
}

/** Where a finger on the view is, in CSS pixels on the canvas. */
interface Finger {
  x: number;
  y: number;
}

/**
 * Touches on the view: a tap above the ground drops a crumb there. Two
 * fingers pinch the view larger or smaller, one drags it about; the wheel
 * zooms about the pointer, the arrow keys move the view, + and - zoom it and
 * 0 brings back the view the screen opened on.
 */
export class Input {
  private readonly canvas: HTMLCanvasElement;
  private readonly world: World;
  private readonly view: Viewport;
  private readonly handlers: InputHandlers;
  private readonly fingers = new Map<number, Finger>();
  /** The press that may still be a tap: no other finger joined it and it has not moved away. */
  private tap: { id: number; x: number; y: number; time: number } | null = null;
  /** A pinch under way: the fingers' spread and the scale asked for when it began, and what lay between them. */
  private pinch: { spread: number; level: number; at: { x: number; y: number } } | null = null;

  constructor(canvas: HTMLCanvasElement, world: World, view: Viewport, handlers: InputHandlers) {
    this.canvas = canvas;
    this.world = world;
    this.view = view;
    this.handlers = handlers;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e, true));
    canvas.addEventListener("pointercancel", (e) => this.up(e, false));
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this.key(e));
  }

  /** A point of an event in CSS pixels on the canvas. */
  private point(e: MouseEvent): Finger {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private down(e: PointerEvent): void {
    this.handlers.activity();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.point(e);
    this.fingers.set(e.pointerId, p);
    this.tap =
      this.fingers.size === 1 ? { id: e.pointerId, x: p.x, y: p.y, time: performance.now() } : null;
    this.regrip();
  }

  private move(e: PointerEvent): void {
    const finger = this.fingers.get(e.pointerId);
    if (!finger) {
      return;
    }
    this.handlers.activity();
    const p = this.point(e);
    const tap = this.tap;
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP) {
      this.tap = null;
    }
    if (this.pinch) {
      finger.x = p.x;
      finger.y = p.y;
      const { middle, spread } = this.spread();
      const pinch = this.pinch;
      this.view.zoomTo(pinch.level * (spread / pinch.spread), middle.x, middle.y, pinch.at);
      return;
    }
    // One finger drags the view, once it has moved too far to be a tap.
    if (!this.tap) {
      this.view.panBy(p.x - finger.x, p.y - finger.y);
    }
    finger.x = p.x;
    finger.y = p.y;
  }

  private up(e: PointerEvent, finished: boolean): void {
    if (!this.fingers.delete(e.pointerId)) {
      return;
    }
    const tap = this.tap;
    this.tap = null;
    this.regrip();
    if (!finished || !tap || tap.id !== e.pointerId || performance.now() - tap.time > TAP_TIME) {
      return;
    }
    const at = this.view.toWorld(tap.x, tap.y);
    // Only over the ground: a crumb falls from where the finger is.
    const ground = this.world.surface.height(at.x);
    if (at.y > ground - 1) {
      this.world.dropCrumb(at.x, Math.max(at.y, ground + 2));
    }
  }

  /** Starts a pinch afresh from the fingers down now, or ends it when fewer than two are. */
  private regrip(): void {
    if (this.fingers.size < 2) {
      this.pinch = null;
      return;
    }
    const { middle, spread } = this.spread();
    this.pinch = {
      spread: Math.max(1, spread),
      level: this.view.level,
      at: this.view.toWorld(middle.x, middle.y),
    };
  }

  /** The middle of the first two fingers down and how far apart they are. */
  private spread(): { middle: Finger; spread: number } {
    const [a, b] = this.fingers.values();
    return {
      middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      spread: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.handlers.activity();
    const pixels = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : e.deltaY * WHEEL_LINE;
    const rate = e.ctrlKey ? PINCH_WHEEL_ZOOM : WHEEL_ZOOM;
    const factor = Math.min(2, Math.max(0.5, Math.exp(-pixels * rate)));
    const p = this.point(e);
    this.view.zoomBy(factor, p.x, p.y);
  }

  private key(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const midX = rect.width / 2;
    const midY = rect.height / 2;
    switch (e.key) {
      case "ArrowUp":
        this.view.panBy(0, KEY_PAN);
        break;
      case "ArrowDown":
        this.view.panBy(0, -KEY_PAN);
        break;
      case "ArrowLeft":
        this.view.panBy(KEY_PAN, 0);
        break;
      case "ArrowRight":
        this.view.panBy(-KEY_PAN, 0);
        break;
      case "+":
      case "=":
        this.view.step(1, midX, midY);
        break;
      case "-":
        this.view.step(-1, midX, midY);
        break;
      case "0":
        this.view.home();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
