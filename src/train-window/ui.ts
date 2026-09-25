import type { Overlay } from "../shared/ui/overlay.ts";

/** The car light button in the HUD. */
export class LightButton {
  private readonly el: HTMLButtonElement;

  constructor(overlay: Overlay, onPress: () => void) {
    this.el = overlay.button("light", onPress);
  }

  /** Reflects the car light state on the button. */
  set(on: boolean): void {
    this.el.setAttribute("aria-pressed", String(on));
    this.el.setAttribute("aria-label", on ? "車内灯を消す" : "車内灯をつける");
  }
}
