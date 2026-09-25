import type { Overlay } from "../shared/ui/overlay.ts";

/** The button that clears the arrows from the range. */
export class ClearButton {
  private readonly el: HTMLButtonElement;
  private available = true;

  constructor(overlay: Overlay, onPress: () => void) {
    this.el = overlay.button("clear", onPress);
  }

  /** Enabled only while there is something to clear; touches the page only on a change. */
  set(available: boolean): void {
    if (available === this.available) {
      return;
    }
    this.available = available;
    this.el.disabled = !available;
  }
}
