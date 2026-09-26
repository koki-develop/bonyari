import "../shared/base.css";
import "../shared/ui/work.css";
import { randomSeed } from "../shared/core/random.ts";
import { observeDeviceSize, runLoop } from "../shared/platform/loop.ts";
import { ScreenWake } from "../shared/platform/wake-lock.ts";
import { Overlay } from "../shared/ui/overlay.ts";
import { AudioEngine } from "./audio/engine.ts";
import { applyDevOptions, asksForScene, readDevOptions } from "./dev.ts";
import { Input } from "./input.ts";
import { forgetTown, loadTown, saveTown } from "./platform/store.ts";
import { Renderer } from "./render/renderer.ts";
import { World } from "./sim/world.ts";

/** Real seconds between saves of the settlement. */
const SAVE_INTERVAL = 10;

const params = new URLSearchParams(location.search);
const seedText = params.get("seed")?.trim() ?? "";
const seedParam = seedText === "" ? Number.NaN : Number(seedText);
const dev = import.meta.env.DEV ? readDevOptions(params) : null;
// A scene named in the URL is shown as asked and never saved over the settlement kept on this device.
const scene = Number.isInteger(seedParam) || (dev !== null && asksForScene(dev));

const world =
  (scene ? null : restoreTown()) ??
  World.create({ seed: Number.isInteger(seedParam) ? seedParam >>> 0 : randomSeed() });

/** The settlement kept on this device, or null; one that can't be brought back is forgotten. */
function restoreTown(): World | null {
  const saved = loadTown();
  if (!saved) {
    return null;
  }
  try {
    const restored = World.restore(saved);
    if (restored) {
      return restored;
    }
  } catch (error) {
    console.error(error);
  }
  forgetTown();
  return null;
}
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

new Input(canvas, renderer.viewport, {
  activity: () => {
    overlay.activity();
    audio.wake();
  },
});

observeDeviceSize(canvas, (w, h) => renderer.resize(w, h));

let sinceSave = 0;
let seconds = 0;
// Once the world has failed partway through an update, it is no longer kept: the last good save stands.
let failed = false;

function save(): void {
  if (!scene && !failed) {
    sinceSave = 0;
    saveTown(world.snapshot());
  }
}

runLoop({
  advance: (dt) => {
    try {
      world.update(dt * timescale);
    } catch (error) {
      failed = true;
      throw error;
    }
    renderer.observe(world);
    const ear = renderer.lookingAt();
    world.attention = ear;
    audio.listen(ear.x, ear.y, renderer.viewport.zoom);
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
  Object.assign(window, { settlement: { world, renderer, audio } });
}
