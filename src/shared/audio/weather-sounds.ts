import { type Build, chain, envelope, filter, noiseBurst } from "./synth.ts";

// Sounds of the weather that every work hears the same way.

/** Thunder: a crack when near, then a rolling rumble of overlapping swells. */
export const thunder =
  (near: boolean): Build =>
  (ctx, noise, r) => {
    const out = ctx.createGain();
    out.connect(ctx.destination);
    if (near) {
      chain(
        noiseBurst(ctx, noise, 0, 0.4, r.next()),
        filter(ctx, "highpass", 900),
        envelope(ctx, 0, 0.002, 0.25, 0.6),
        out,
      );
    }
    // Rolling rumble: several overlapping swells.
    for (let i = 0; i < 7; i++) {
      const start = (near ? 0.05 : 0.2) + i * r.range(0.35, 0.9);
      const dur = r.range(1.2, 2.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(r.range(0.3, 0.8) * (1 - i * 0.1), start + r.range(0.1, 0.4));
      g.gain.setTargetAtTime(0, start + 0.4, dur / 3);
      chain(
        noiseBurst(ctx, noise, start, dur + 1.5, r.next()),
        filter(ctx, "lowpass", near ? 420 : 220),
        g,
        out,
      );
    }
  };

/** A raindrop tapping on something hard; variants differ in pitch. */
export const dropTick =
  (variant: number): Build =>
  (ctx, noise, r) => {
    chain(
      noiseBurst(ctx, noise, 0, 0.04, r.next()),
      filter(ctx, "bandpass", 2600 + variant * 1300, 3),
      envelope(ctx, 0, 0.001, 0.012, 0.8),
      ctx.destination,
    );
  };
