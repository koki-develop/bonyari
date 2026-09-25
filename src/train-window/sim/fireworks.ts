import { hash, Rng } from "../../shared/core/random.ts";
import type { RouteSeason } from "./season.ts";

export type ShellKind = "peony" | "chrysanthemum" | "willow" | "ring";

export interface Shell {
  /** World position of the burst: along-track (m), lateral distance (m), height (m). */
  along: number;
  lateral: number;
  height: number;
  /** Seconds since launch (the burst happens at `riseTime`). */
  age: number;
  riseTime: number;
  radius: number;
  kind: ShellKind;
  hue: number;
  seed: number;
  /** Set once the burst has happened; the audio engine uses it for the delayed boom. */
  burst: boolean;
}

/** Fireworks festivals on summer nights, somewhere ahead along the line. */
export class Fireworks {
  private readonly rng: Rng;
  private readonly seed: number;
  readonly shells: Shell[] = [];
  /** Shells that burst during the last update. */
  readonly bursts: Shell[] = [];
  private festivalDay = -1;
  private festivalAlong = 0;
  private festivalLateral = 0;
  private nextShellIn = 0;

  constructor(seed: number) {
    this.seed = seed;
    this.rng = new Rng(seed ^ 0xf1e0);
  }

  update(dt: number, days: number, hour: number, pos: number, season: RouteSeason): void {
    this.bursts.length = 0;
    const day = Math.floor(days);
    const festival = hash(day, this.seed, 31) < season.fireworks * 0.85;
    const showTime = hour >= 19.2 && hour < 21.6;
    if (festival && showTime) {
      if (this.festivalDay !== day) {
        this.festivalDay = day;
        this.festivalAlong = pos + this.rng.range(900, 2400);
        this.festivalLateral = this.rng.range(1400, 2800);
      }
      this.nextShellIn -= dt;
      if (this.nextShellIn <= 0) {
        // Launches come in small salvos with pauses in between.
        this.nextShellIn = this.rng.chance(0.3)
          ? this.rng.range(0.15, 0.5)
          : this.rng.range(1.2, 4);
        const r = this.rng;
        this.shells.push({
          along: this.festivalAlong + r.range(-120, 120),
          lateral: this.festivalLateral + r.range(-80, 80),
          height: r.range(220, 380),
          age: 0,
          riseTime: r.range(1.6, 2.4),
          radius: r.range(70, 150),
          kind: r.weighted<ShellKind>({ peony: 4, chrysanthemum: 3, willow: 1.5, ring: 0.8 }),
          hue: r.next(),
          seed: r.int(0, 1 << 30),
          burst: false,
        });
      }
    }
    for (const s of this.shells) {
      s.age += dt;
      if (!s.burst && s.age >= s.riseTime) {
        s.burst = true;
        this.bursts.push(s);
      }
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      if (this.shells[i].age > this.shells[i].riseTime + 6) {
        this.shells.splice(i, 1);
      }
    }
  }
}
