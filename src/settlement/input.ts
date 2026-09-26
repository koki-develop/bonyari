import type { Viewport } from "./render/viewport.ts";

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
 * Looking about: one finger drags the view, two pinch it larger or smaller;
 * the wheel zooms about the pointer, the arrow keys move the view, + and -
 * zoom it and 0 brings back the view the screen opened on.
 */
export class Input {
  private readonly canvas: HTMLCanvasElement;
  private readonly view: Viewport;
  private readonly handlers: InputHandlers;
  private readonly fingers = new Map<number, Finger>();
  /** A pinch under way: the fingers' spread and the scale asked for when it began, and what lay between them. */
  private pinch: { spread: number; level: number; at: { x: number; y: number } } | null = null;

  constructor(canvas: HTMLCanvasElement, view: Viewport, handlers: InputHandlers) {
    this.canvas = canvas;
    this.view = view;
    this.handlers = handlers;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
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
    this.fingers.set(e.pointerId, this.point(e));
    this.regrip();
  }

  private move(e: PointerEvent): void {
    const finger = this.fingers.get(e.pointerId);
    if (!finger) {
      return;
    }
    this.handlers.activity();
    const p = this.point(e);
    if (this.pinch) {
      finger.x = p.x;
      finger.y = p.y;
      const { middle, spread } = this.spread();
      const pinch = this.pinch;
      this.view.zoomTo(pinch.level * (spread / pinch.spread), middle.x, middle.y, pinch.at);
      return;
    }
    this.view.panBy(p.x - finger.x, p.y - finger.y);
    finger.x = p.x;
    finger.y = p.y;
  }

  private up(e: PointerEvent): void {
    if (this.fingers.delete(e.pointerId)) {
      this.regrip();
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
      at: this.view.toArt(middle.x, middle.y),
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
