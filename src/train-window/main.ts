import "../shared/base.css";
import "./style.css";
import { AudioEngine } from "./audio/engine.ts";
import { approach } from "./core/math.ts";
import { randomSeed } from "./core/random.ts";
import { readDevOptions } from "./dev.ts";
import { Input } from "./input.ts";
import { loadJourney, saveJourney } from "./platform/journey-store.ts";
import { ScreenWake } from "./platform/wake-lock.ts";
import { Renderer } from "./render/renderer.ts";
import { Overlay } from "./ui.ts";
import { World } from "./sim/world.ts";

/**
 * Longest gap (s) between updates that is caught up on. A hidden page may get
 * its timer only once a minute; a longer gap means the page was frozen or the
 * device slept, and the ride goes on from where it stopped.
 */
const MAX_CATCH_UP = 90;
/** Interval (ms) of the timer that keeps the ride going while animation frames are paused. */
const HIDDEN_TICK_MS = 250;
/** Real seconds between saves of the ride. */
const SAVE_INTERVAL = 10;
/** Average render time (ms) above which frames are drawn every other tick. */
const SLOW_FRAME_MS = 14;

const params = new URLSearchParams(location.search);
const seedParam = params.has("seed") ? Number(params.get("seed")) : Number.NaN;
const dev = import.meta.env.DEV ? readDevOptions(params) : { world: {}, timescale: 1 };
// A scene named in the URL is shown as asked and never saved over the ride kept on this device.
const scene = Number.isInteger(seedParam) || Object.keys(dev.world).length > 0;

const saved = scene ? null : loadJourney();
const world =
  (saved && World.resume(saved)) ??
  World.create({ seed: Number.isInteger(seedParam) ? seedParam : randomSeed(), ...dev.world });
const canvas = document.querySelector<HTMLCanvasElement>("#view");
if (!canvas) {
  throw new Error("#view canvas is missing");
}
const renderer = new Renderer(canvas, world);
const audio = new AudioEngine(world.seed);
const wake = new ScreenWake();

let lampTarget = 1;
let lampOn = 1;

function toggleLamp(): void {
  lampTarget = lampTarget > 0.5 ? 0 : 1;
  audio.playClick();
  overlay.setLight(lampTarget > 0.5);
}

const overlay = new Overlay({
  onBoard: () => {
    void audio.start();
    void wake.enable();
  },
  onSound: (on) => audio.setEnabled(on),
  onLight: toggleLamp,
});

new Input(canvas, renderer, {
  toggleLamp,
  activity: () => {
    overlay.activity();
    audio.wake();
  },
});

function resize(deviceWidth: number, deviceHeight: number): void {
  renderer.resize(Math.max(1, deviceWidth), Math.max(1, deviceHeight));
}

// Size the canvas in device pixels so the integer upscale stays crisp.
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

let last = performance.now();
let sinceSave = 0;
let seconds = 0;
let renderCost = 8;
let skip = false;
let pendingDt = 0;

function save(): void {
  if (!scene) {
    sinceSave = 0;
    saveJourney(world.snapshot());
  }
}

/** Brings the ride up to `now` (ms); returns the real seconds it advanced. */
function advance(now: number): number {
  const elapsed = (now - last) / 1000;
  if (elapsed <= 0) {
    return 0;
  }
  last = now;
  const dt = elapsed > MAX_CATCH_UP ? 0 : elapsed;
  world.update(dt * dev.timescale);
  audio.update(world, dt);
  sinceSave += dt;
  if (sinceSave >= SAVE_INTERVAL) {
    save();
  }
  return dt;
}

function frame(now: number): void {
  const dt = advance(now);
  seconds += dt;
  lampOn = approach(lampOn, lampTarget, 9, dt);
  pendingDt += dt;
  // On slow devices draw every other frame; the simulation keeps its pace.
  skip = renderCost > SLOW_FRAME_MS ? !skip : false;
  if (!skip) {
    const t0 = performance.now();
    renderer.render(world, pendingDt, seconds, { lampOn });
    renderCost = renderCost * 0.95 + (performance.now() - t0) * 0.05;
    pendingDt = 0;
  }
  requestAnimationFrame(frame);
}

// Animation frames pause while the page is hidden; a timer keeps the ride and its sound going.
let hiddenTimer = 0;
function followVisibility(): void {
  window.clearInterval(hiddenTimer);
  if (document.visibilityState === "hidden") {
    hiddenTimer = window.setInterval(() => advance(performance.now()), HIDDEN_TICK_MS);
  }
}
followVisibility();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    save();
  } else {
    audio.wake();
  }
  followVisibility();
});
window.addEventListener("pagehide", save);

requestAnimationFrame((now) => {
  last = now;
  frame(now);
});

if (import.meta.env.DEV) {
  Object.assign(window, { trainWindow: { world, renderer, audio } });
}
