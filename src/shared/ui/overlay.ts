/** Seconds of no pointer activity before the controls fade away. */
const HUD_IDLE = 3.5;

export interface OverlayHandlers {
  /** The start screen was dismissed (a user gesture: audio may start now). */
  onStart(): void;
  onSound(on: boolean): void;
}

export function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`#${id} is missing`);
  }
  return el as T;
}

/**
 * The start screen and the controls over a work: `#start`, the `#hud` with the
 * back link and the `#sound` toggle, and any buttons a work adds with `button`.
 * The controls fade out while nothing is touched.
 */
export class Overlay {
  private readonly hud = element<HTMLElement>("hud");
  private readonly sound = element<HTMLButtonElement>("sound");
  private idleTimer = 0;
  private soundOn = true;

  constructor(handlers: OverlayHandlers) {
    const start = element<HTMLButtonElement>("start");
    start.addEventListener(
      "click",
      () => {
        handlers.onStart();
        start.classList.add("gone");
        start.addEventListener("transitionend", () => start.remove(), { once: true });
        this.hud.hidden = false;
        this.activity();
      },
      { once: true },
    );
    start.focus();
    this.button("sound", () => {
      this.soundOn = !this.soundOn;
      this.sound.setAttribute("aria-pressed", String(this.soundOn));
      this.sound.setAttribute("aria-label", this.soundOn ? "音を消す" : "音を出す");
      handlers.onSound(this.soundOn);
    });
    window.addEventListener("keydown", () => this.activity());
  }

  /** Wires a control in the HUD; pressing it also keeps the controls shown. */
  button(id: string, onPress: () => void): HTMLButtonElement {
    const el = element<HTMLButtonElement>(id);
    el.addEventListener("click", () => {
      onPress();
      this.activity();
    });
    return el;
  }

  /** Shows the controls again and restarts their idle timer. */
  activity(): void {
    this.hud.classList.remove("idle");
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.hud.classList.add("idle"), HUD_IDLE * 1000);
  }
}
