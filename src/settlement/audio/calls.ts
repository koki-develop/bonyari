import { type Build, gainNode } from "../../shared/audio/synth.ts";
import { voice, whistle } from "./voice.ts";

/**
 * The birds of a valley in the old west of the world, and the farmyard's
 * rooster. Each builder draws its phrasing from the random source, so
 * rendering one several times gives a set of distinct calls.
 */

function out(ctx: BaseAudioContext): GainNode {
  const g = gainNode(ctx, 1);
  g.connect(ctx.destination);
  return g;
}

/** A blackbird: a rich, fluting phrase of a few notes, trailing into a twitter. */
export const blackbird: Build = (ctx, _noise, r) => {
  const o = out(ctx);
  let t = 0;
  const notes = r.int(4, 7);
  const base = r.range(1500, 1900);
  for (let i = 0; i < notes; i++) {
    const f = base * r.pick([1, 1.12, 1.26, 1.33, 1.5, 0.89]);
    const d = r.range(0.1, 0.22);
    const bend = r.range(0.9, 1.12);
    whistle(
      ctx,
      o,
      t,
      [
        [0, f],
        [d * 0.6, f * bend],
        [d, f * bend * 0.97],
      ],
      0.32,
      0.02,
    );
    t += d + r.range(0.02, 0.06);
  }
  // The twitter at the end.
  for (let i = 0; i < r.int(3, 6); i++) {
    const f = r.range(4000, 5200);
    whistle(
      ctx,
      o,
      t,
      [
        [0, f],
        [0.03, f * 0.85],
      ],
      0.12,
      0.005,
    );
    t += 0.045;
  }
};

/** A skylark high over the fields: a long, rapid, silvery warble. */
export const lark: Build = (ctx, _noise, r) => {
  const o = out(ctx);
  let t = 0;
  let f = r.range(3000, 3800);
  while (t < 4.3) {
    const d = r.range(0.04, 0.09);
    const next = Math.max(2600, Math.min(5200, f * r.range(0.85, 1.18)));
    whistle(
      ctx,
      o,
      t,
      [
        [0, f],
        [d, next],
      ],
      0.18 + r.range(0, 0.08),
      0.006,
    );
    f = next;
    t += d + r.range(0.005, 0.03);
  }
};

/** A cuckoo in the spring woods: "cu-coo", a falling third, soft and hollow. */
export const cuckoo: Build = (ctx, _noise, r) => {
  const o = out(ctx);
  const f = r.range(640, 720);
  const calls = r.int(2, 3);
  let t = 0;
  for (let i = 0; i < calls; i++) {
    whistle(
      ctx,
      o,
      t,
      [
        [0, f * 1.01],
        [0.2, f],
      ],
      0.4,
      0.04,
    );
    whistle(
      ctx,
      o,
      t + 0.28,
      [
        [0, f * 0.8],
        [0.3, f * 0.79],
      ],
      0.45,
      0.05,
    );
    t += 0.28 + 0.3 + r.range(0.35, 0.5);
  }
};

/** A tawny owl by night: a long hoot, a pause, then a quavering one. */
export const owl: Build = (ctx, _noise, r) => {
  const o = out(ctx);
  const f = r.range(360, 420);
  voice(
    ctx,
    r,
    0,
    [
      [0, f],
      [0.5, f * 1.03],
      [0.7, f * 0.98],
    ],
    [[f, 8, 1]],
    0.12,
    o,
    0.01,
  );
  // The quavering "hu-hu-hoooo".
  let t = 1.4;
  for (let i = 0; i < 3; i++) {
    voice(
      ctx,
      r,
      t,
      [
        [0, f * 0.97],
        [0.12, f],
      ],
      [[f, 8, 0.8]],
      0.08,
      o,
      0.01,
    );
    t += 0.18;
  }
  voice(
    ctx,
    r,
    t,
    [
      [0, f],
      [0.6, f * 1.02],
      [0.8, f * 0.96],
    ],
    [[f, 8, 1]],
    0.12,
    o,
    0.02,
  );
};

/** The rooster at first light: "cock-a-doodle-doo", four syllables, the last long and falling. */
export const rooster: Build = (ctx, _noise, r) => {
  const o = out(ctx);
  const f = r.range(430, 520);
  const formants = [
    [900, 4, 1],
    [1700, 5, 0.6],
    [3000, 6, 0.2],
  ] as const;
  let t = 0;
  for (const [len, from, to] of [
    [0.16, 0.9, 1],
    [0.12, 1.05, 1.1],
    [0.18, 1.2, 1.25],
    [0.7, 1.35, 0.85],
  ] as const) {
    voice(
      ctx,
      r,
      t,
      [
        [0, f * from],
        [len * 0.6, f * to * 1.02],
        [len, f * to],
      ],
      formants,
      0.08,
      o,
      0.04,
    );
    t += len + 0.04;
  }
};
