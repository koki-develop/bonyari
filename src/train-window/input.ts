import type { Renderer } from "./render/renderer.ts";

/** Minimum touch target (CSS px) around small interactive parts. */
const MIN_TARGET = 44;

export interface InputHandlers {
  toggleLamp(): void;
  activity(): void;
}

/** Touch and mouse on the scene: the reading lamp toggles the car lights. */
export class Input {
  private readonly renderer: Renderer;
  private readonly handlers: InputHandlers;

  constructor(canvas: HTMLCanvasElement, renderer: Renderer, handlers: InputHandlers) {
    this.renderer = renderer;
    this.handlers = handlers;
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", () => this.handlers.activity());
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

  private down(e: PointerEvent): void {
    this.handlers.activity();
    if (e.button !== 0 || !e.isPrimary) {
      return;
    }
    const { x, y } = this.art(e);
    if (this.onLamp(x, y)) {
      this.handlers.toggleLamp();
    }
  }
}
