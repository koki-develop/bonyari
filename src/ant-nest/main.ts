import "../shared/base.css";
import "../shared/ui/work.css";
import "./style.css";
import { randomSeed } from "../shared/core/random.ts";
import { observeDeviceSize, runLoop } from "../shared/platform/loop.ts";
import { ScreenWake } from "../shared/platform/wake-lock.ts";
import { Overlay } from "../shared/ui/overlay.ts";
import { AudioEngine } from "./audio/engine.ts";
import { applyDevOptions, asksForScene, readDevOptions } from "./dev.ts";
import { Input } from "./input.ts";
import { loadColony, saveColony } from "./platform/store.ts";
import { Renderer } from "./render/renderer.ts";
import { World } from "./sim/world.ts";

/** Real seconds between saves of the colony. */
const SAVE_INTERVAL = 10;

const params = new URLSearchParams(location.search);
const seedParam = params.has("seed") ? Number(params.get("seed")) : Number.NaN;
const dev = import.meta.env.DEV ? readDevOptions(params) : null;
// A scene named in the URL is shown as asked and never saved over the colony kept on this device.
const scene = Number.isInteger(seedParam) || (dev !== null && asksForScene(dev));

const saved = scene ? null : loadColony();
const world = saved
  ? World.restore(saved)
  : World.create({ seed: Number.isInteger(seedParam) ? seedParam >>> 0 : randomSeed() });
if (dev) {
  applyDevOptions(world, dev);
}
const timescale = dev?.timescale ?? 1;

const canvas = document.querySelector<HTMLCanvasElement>("#view");
if (!canvas) {
  throw new Error("#view canvas is missing");
}
const renderer = new Renderer(canvas, world);
const audio = new AudioEngine(world.seed);
const wake = new ScreenWake();

const overlay = new Overlay({
  onStart: () => {
    void audio.start();
    void wake.enable();
  },
  onSound: (on) => audio.setEnabled(on),
});

new Input(canvas, world, renderer.viewport, {
  activity: () => {
    overlay.activity();
    audio.wake();
  },
});

observeDeviceSize(canvas, (w, h) => renderer.resize(w, h));

let sinceSave = 0;
let seconds = 0;

function save(): void {
  if (!scene) {
    sinceSave = 0;
    saveColony(world.snapshot());
  }
}

runLoop({
  advance: (dt) => {
    world.update(dt * timescale);
    renderer.observe(world);
    audio.listen(renderer.viewport.middle, renderer.viewport.zoom);
    audio.update(world, dt);
    sinceSave += dt;
    if (sinceSave >= SAVE_INTERVAL) {
      save();
    }
  },
  draw: (dt) => {
    seconds += dt;
    renderer.render(world, dt, seconds);
  },
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    save();
  } else {
    audio.wake();
  }
});
window.addEventListener("pagehide", save);

if (import.meta.env.DEV) {
  Object.assign(window, { antNest: { world, renderer, audio } });
}
