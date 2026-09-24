/** Seconds of no pointer activity before the controls fade away. */
const HUD_IDLE = 3.5;
/** Seconds after boarding before the one-time hint appears. */
const HINT_DELAY = 25;
const HINT_KEY = "spaceout.night-train.hinted";

export interface OverlayHandlers {
  onBoard(): void;
  onSound(on: boolean): void;
  onLight(): void;
}

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`#${id} is missing`);
  }
  return el as T;
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Storage unavailable (private mode): the hint may show again next time.
  }
}

/** The boarding screen, the sound toggle and the back link. */
export class Overlay {
  private readonly hud = element<HTMLElement>("hud");
  private readonly sound = element<HTMLButtonElement>("sound");
  private readonly light = element<HTMLButtonElement>("light");
  private readonly hint = element<HTMLElement>("hint");
  private idleTimer = 0;
  private soundOn = true;

  constructor(handlers: OverlayHandlers) {
    const start = element<HTMLButtonElement>("start");
    start.addEventListener(
      "click",
      () => {
        handlers.onBoard();
        start.classList.add("gone");
        start.addEventListener("transitionend", () => start.remove(), { once: true });
        this.hud.hidden = false;
        this.activity();
        this.scheduleHint();
      },
      { once: true },
    );
    start.focus();
    this.sound.addEventListener("click", () => {
      this.soundOn = !this.soundOn;
      this.sound.setAttribute("aria-pressed", String(this.soundOn));
      this.sound.setAttribute("aria-label", this.soundOn ? "音を消す" : "音を出す");
      handlers.onSound(this.soundOn);
      this.activity();
    });
    this.light.addEventListener("click", () => {
      handlers.onLight();
      this.activity();
    });
    window.addEventListener("keydown", () => this.activity());
  }

  /** Reflects the car light state on its button. */
  setLight(on: boolean): void {
    this.light.setAttribute("aria-pressed", String(on));
    this.light.setAttribute("aria-label", on ? "車内灯を消す" : "車内灯をつける");
  }

  /** Shows the controls again and restarts their idle timer. */
  activity(): void {
    this.hud.classList.remove("idle");
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.hud.classList.add("idle"), HUD_IDLE * 1000);
  }

  private scheduleHint(): void {
    if (readFlag(HINT_KEY)) {
      return;
    }
    window.setTimeout(() => {
      this.hint.hidden = false;
      requestAnimationFrame(() => this.hint.classList.add("shown"));
      writeFlag(HINT_KEY);
      window.setTimeout(() => this.hint.classList.remove("shown"), 9000);
    }, HINT_DELAY * 1000);
  }
}
