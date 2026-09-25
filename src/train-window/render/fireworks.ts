import type { RGB } from "../../shared/core/color.ts";
import { hash3 } from "../../shared/core/random.ts";
import type { Shell } from "../sim/fireworks.ts";
import type { Painter } from "../../shared/render/painter.ts";
import type { Camera } from "./camera.ts";

function hueToRgb(h: number, saturation: number): RGB {
  const k = (n: number) => (n + h * 6) % 6;
  const f = (n: number) => 255 * (1 - saturation * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
  return [f(5), f(3), f(1)];
}

const GOLD: RGB = [255, 198, 110];

/** A firework shell: the rising spark, then the burst of stars falling away. */
export function drawShell(p: Painter<Camera>, shell: Shell): void {
  p.at(shell.lateral);
  const s = p.s;
  const view = p.view;
  if (shell.age < shell.riseTime) {
    const t = shell.age / shell.riseTime;
    const h = shell.height * (1 - (1 - t) * (1 - t));
    const x = p.x(shell.along);
    const y = p.y(h);
    for (let k = 0; k < 4; k++) {
      const a = (1 - k / 4) * 0.8;
      view.add(x, y + k, 255 * a, 210 * a, 150 * a);
    }
    return;
  }
  const t = shell.age - shell.riseTime;
  const willow = shell.kind === "willow";
  const color = willow ? GOLD : hueToRgb(shell.hue, 0.65);
  const second = hueToRgb((shell.hue + 0.5) % 1, 0.5);
  const life = willow ? 4.5 : 2.6;
  if (t > life) {
    return;
  }
  const count = shell.kind === "ring" ? 36 : 56;
  const fade = Math.max(0, 1 - t / life);
  // The burst lights up the smoke around it for a moment.
  if (t < 0.4) {
    p.glow(p.x(shell.along), p.y(shell.height), shell.radius * s * 1.3, color, (0.4 - t) * 0.9);
  }
  for (let i = 0; i < count; i++) {
    let dx: number;
    let dy: number;
    if (shell.kind === "ring") {
      const a = (i / count) * Math.PI * 2;
      dx = Math.cos(a);
      dy = Math.sin(a) * 0.45;
    } else {
      const u = hash3(shell.seed, i, 1) * 2 - 1;
      const a = hash3(shell.seed, i, 2) * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      dx = rr * Math.cos(a);
      dy = u;
    }
    const inner = shell.kind === "chrysanthemum" && i % 3 === 0;
    const rad = shell.radius * (inner ? 0.55 : 1);
    const trail = shell.kind === "chrysanthemum" || willow ? 4 : 1;
    for (let k = 0; k < trail; k++) {
      const tk = Math.max(0, t - k * 0.08);
      const ek = 1 - Math.exp(-3.2 * tk);
      const gk = (willow ? 9 : 5) * tk * tk * 0.5;
      const along = shell.along + dx * rad * ek;
      const h = shell.height + dy * rad * ek - gk;
      const x = p.x(along);
      const y = p.y(h);
      const twinkle = t > life * 0.6 && hash3(shell.seed, i, Math.floor(t * 12)) < 0.4 ? 0.3 : 1;
      const c = inner ? second : color;
      const a = fade * twinkle * (1 - k / trail) * (k === 0 ? 1 : 0.5);
      view.add(x, y, c[0] * a, c[1] * a, c[2] * a);
    }
  }
}
