/**
 * Keeps the screen on while the ride is shown. The lock is released by the
 * browser whenever the page is hidden, so it is re-acquired on return.
 */
export class ScreenWake {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  constructor() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.wanted) {
        void this.acquire();
      }
    });
  }

  async enable(): Promise<void> {
    this.wanted = true;
    await this.acquire();
  }

  private async acquire(): Promise<void> {
    if (!("wakeLock" in navigator) || (this.sentinel && !this.sentinel.released)) {
      return;
    }
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
    } catch {
      // Refused (battery saver, permissions policy): the screen may sleep as usual.
      this.sentinel = null;
    }
  }
}
