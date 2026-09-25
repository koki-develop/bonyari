/**
 * Longest gap (s) between updates that is caught up on. A hidden page may get
 * its timer only once a minute; a longer gap means the page was frozen or the
 * device slept, and the work goes on from where it stopped.
 */
const MAX_CATCH_UP = 90;
/** Interval (ms) of the timer that keeps the world going while animation frames are paused. */
const HIDDEN_TICK_MS = 250;
/** Average draw time (ms) above which frames are drawn every other tick. */
const SLOW_FRAME_MS = 14;

export interface LoopHandlers {
  /** Advances the world by `dt` real seconds; `dt` is 0 after a stall. */
  advance(dt: number): void;
  /** Draws a frame; `dt` is the real time (s) since the last drawn frame. */
  draw(dt: number): void;
}

/**
 * Runs the world on animation frames while the page is shown, and on a timer
 * while it is hidden, so time, sound and weather go on in the background. On
 * slow devices frames are drawn every other tick; the world keeps its pace.
 */
export function runLoop(handlers: LoopHandlers): void {
  let last = performance.now();
  let drawCost = 8;
  let skip = false;
  let pendingDt = 0;

  /** Brings the world up to `now` (ms); returns the real seconds it advanced. */
  const advance = (now: number): number => {
    const elapsed = (now - last) / 1000;
    if (elapsed <= 0) {
      return 0;
    }
    last = now;
    const dt = elapsed > MAX_CATCH_UP ? 0 : elapsed;
    handlers.advance(dt);
    return dt;
  };

  const frame = (now: number): void => {
    pendingDt += advance(now);
    skip = drawCost > SLOW_FRAME_MS ? !skip : false;
    if (!skip) {
      const t0 = performance.now();
      handlers.draw(pendingDt);
      drawCost = drawCost * 0.95 + (performance.now() - t0) * 0.05;
      pendingDt = 0;
    }
    requestAnimationFrame(frame);
  };

  let hiddenTimer = 0;
  const followVisibility = (): void => {
    window.clearInterval(hiddenTimer);
    if (document.visibilityState === "hidden") {
      hiddenTimer = window.setInterval(() => advance(performance.now()), HIDDEN_TICK_MS);
    }
  };
  followVisibility();
  document.addEventListener("visibilitychange", followVisibility);

  requestAnimationFrame((now) => {
    last = now;
    frame(now);
  });
}

/**
 * Calls `onResize` with the canvas size in device pixels now and whenever it
 * changes, so the whole-number upscale stays crisp.
 */
export function observeDeviceSize(
  canvas: HTMLCanvasElement,
  onResize: (deviceWidth: number, deviceHeight: number) => void,
): void {
  const resize = (w: number, h: number) => onResize(Math.max(1, w), Math.max(1, h));
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    const box = entry.devicePixelContentBoxSize?.[0];
    if (box) {
      resize(box.inlineSize, box.blockSize);
    } else {
      const css = entry.contentBoxSize[0];
      resize(
        Math.round(css.inlineSize * devicePixelRatio),
        Math.round(css.blockSize * devicePixelRatio),
      );
    }
  });
  try {
    observer.observe(canvas, { box: "device-pixel-content-box" });
  } catch {
    observer.observe(canvas);
  }
  resize(
    Math.round(canvas.clientWidth * devicePixelRatio),
    Math.round(canvas.clientHeight * devicePixelRatio),
  );
}
