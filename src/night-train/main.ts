import "../shared/base.css";
import "./style.css";
import { AudioEngine } from "./audio/engine.ts";
import { approach } from "./core/math.ts";
import { randomSeed } from "./core/random.ts";
import { readDevOptions } from "./dev.ts";
import { Input } from "./input.ts";
import { ScreenWake } from "./platform/wake-lock.ts";
import { Renderer } from "./render/renderer.ts";
import { Overlay } from "./ui.ts";
import { World } from "./sim/world.ts";

/** Longest simulated step; longer gaps (a stalled tab) are skipped, not replayed. */
const MAX_STEP = 0.1;
/** Average render time (ms) above which frames are drawn every other tick. */
const SLOW_FRAME_MS = 14;

const params = new URLSearchParams(location.search);
const seedParam = Number(params.get("seed"));
const seed = Number.isInteger(seedParam) && params.has("seed") ? seedParam : randomSeed();
const dev = import.meta.env.DEV ? readDevOptions(params) : { world: {}, timescale: 1 };

const world = new World({ seed, ...dev.world });
const canvas = document.querySelector<HTMLCanvasElement>("#view");
if (!canvas) {
  throw new Error("#view canvas is missing");
}
const renderer = new Renderer(canvas, world);
const audio = new AudioEngine(seed);
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
let seconds = 0;
let renderCost = 8;
let skip = false;
let pendingDt = 0;

function frame(now: number): void {
  const dt = Math.min(MAX_STEP, Math.max(0, (now - last) / 1000));
  last = now;
  seconds += dt;
  world.update(dt * dev.timescale);
  lampOn = approach(lampOn, lampTarget, 9, dt);
  audio.update(world, dt);
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

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    audio.pause();
  } else {
    last = performance.now();
    audio.resume();
  }
});

requestAnimationFrame((now) => {
  last = now;
  frame(now);
});

if (import.meta.env.DEV) {
  Object.assign(window, { nightTrain: { world, renderer, audio } });
}
