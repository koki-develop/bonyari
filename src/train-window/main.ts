import "../shared/base.css";
import "../shared/ui/work.css";
import "./style.css";
import { approach } from "../shared/core/math.ts";
import { randomSeed } from "../shared/core/random.ts";
import { observeDeviceSize, runLoop } from "../shared/platform/loop.ts";
import { ScreenWake } from "../shared/platform/wake-lock.ts";
import { Overlay } from "../shared/ui/overlay.ts";
import { AudioEngine } from "./audio/engine.ts";
import { readDevOptions } from "./dev.ts";
import { Input } from "./input.ts";
import { loadJourney, saveJourney } from "./platform/journey-store.ts";
import { Renderer } from "./render/renderer.ts";
import { World } from "./sim/world.ts";
import { LightButton } from "./ui.ts";

/** Real seconds between saves of the ride. */
const SAVE_INTERVAL = 10;

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
  light.set(lampTarget > 0.5);
}

const overlay = new Overlay({
  onStart: () => {
    void audio.start();
    void wake.enable();
  },
  onSound: (on) => audio.setEnabled(on),
});
const light = new LightButton(overlay, toggleLamp);

new Input(canvas, renderer, {
  toggleLamp,
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
    saveJourney(world.snapshot());
  }
}

runLoop({
  advance: (dt) => {
    world.update(dt * dev.timescale);
    audio.update(world, dt);
    sinceSave += dt;
    if (sinceSave >= SAVE_INTERVAL) {
      save();
    }
  },
  draw: (dt) => {
    seconds += dt;
    lampOn = approach(lampOn, lampTarget, 9, dt);
    renderer.render(world, dt, seconds, { lampOn });
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
  Object.assign(window, { trainWindow: { world, renderer, audio } });
}
