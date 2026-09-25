import { bump, cyclicBump, smoothstep } from "../core/math.ts";
import { Rng } from "../core/random.ts";
import type { Environment } from "../env/environment.ts";
import type { Wildlife } from "./wildlife.ts";

/** What lives around the listener. */
export interface Habitat {
  /** Fields and woods (0..1). */
  rural: number;
  /** Houses and gardens (0..1 and a little over in town). */
  houses: number;
  /** Paddies and wet fields, where the frogs are (0..1). */
  fields: number;
}

/** Plays one call now, at `gain`, panned (-1..1) and at a playback `rate`. */
export type Sing = (call: AudioBuffer, gain: number, pan: number, rate: number) => void;

/** 1 through the day, easing in at dawn and out at dusk. */
export function daytime(hour: number): number {
  return smoothstep(5, 7, hour) * (1 - smoothstep(17.5, 19, hour));
}

/** 1 through the night. */
export function nighttime(hour: number): number {
  return 1 - smoothstep(4.5, 6, hour) + smoothstep(18.5, 20, hour);
}

/**
 * Birds, cicadas, frogs and insects, each calling at its own season, hour and
 * weather and in the places it lives.
 */
export class WildlifeChorus {
  private readonly rng: Rng;
  /** The call each species made last, so it doesn't repeat straight away. */
  private readonly lastCall = new Map<readonly AudioBuffer[], number>();

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0xb1d5);
  }

  /**
   * Draws the calls of the next `dt` seconds.
   * @param hearing how much of the outside reaches the listener (0..1)
   */
  update(
    env: Environment,
    calls: Wildlife,
    habitat: Habitat,
    dt: number,
    hearing: number,
    sing: Sing,
  ): void {
    if (hearing < 0.05) {
      return;
    }
    const season = env.season;
    const hour = env.clock.hour;
    const r = this.rng;
    const w = env.weather.state;
    const { rural, houses, fields } = habitat;
    const day = daytime(hour);
    const night = nighttime(hour);
    const dry = 1 - smoothstep(0.05, 0.35, w.rain);
    const noSnow = 1 - smoothstep(0.02, 0.2, w.snow);
    const calm = (1 - w.storm) * (1 - smoothstep(0.45, 0.85, w.wind));
    // Birds sing on fine mornings, not in snow, rain or a gale; a grey sky subdues them.
    const birds = dry * noSnow * calm * (1 - 0.45 * w.cloudCover) * (1 - 0.6 * w.mist);
    // Cicadas need warmth and some sun.
    const cicadas = dry * noSnow * calm * (1 - 0.7 * smoothstep(0.5, 1, w.cloudCover));
    // Frogs call all the more in a light rain, but not in a downpour or the cold.
    const frogs =
      (1 + 0.8 * Math.min(w.rain, 0.5)) * (1 - smoothstep(0.6, 1, w.rain)) * noSnow * (1 - w.storm);
    // Autumn insects fall silent in rain and wind.
    const insects = (1 - smoothstep(0.1, 0.4, w.rain)) * noSnow * calm;
    const call = (
      set: readonly AudioBuffer[],
      rate: number,
      gain: readonly [number, number],
      pitch: readonly [number, number] = [0.97, 1.03],
    ) => {
      if (r.chance(rate * dt * hearing)) {
        sing(
          this.fresh(set),
          r.range(gain[0], gain[1]),
          r.range(-0.9, 0.9),
          r.range(pitch[0], pitch[1]),
        );
      }
    };
    const f = season.yearFraction;
    const morning = bump(hour, 7, 4, 1.5);
    const dawnDusk = bump(hour, 6, 1.5, 0.8) + bump(hour, 17.4, 1.6, 0.8);
    // Spring mornings in the country: the bush warbler.
    call(
      calls.uguisu,
      0.09 * birds * cyclicBump(f, 0.12, 0.2, 0.05, 1) * morning * rural,
      [0.04, 0.09],
    );
    // Great tits through spring and early summer.
    call(
      calls.shijukara,
      0.07 * birds * cyclicBump(f, 0.2, 0.18, 0.06, 1) * morning * (0.4 + 0.6 * rural),
      [0.02, 0.05],
    );
    // Bulbuls all year, loudest in the morning.
    call(calls.hiyodori, 0.06 * birds * (0.3 + 0.7 * morning) * day, [0.02, 0.05]);
    // Sparrows around the houses through the day.
    call(
      calls.sparrow,
      0.35 *
        birds *
        (0.4 + 0.6 * season.warmth) *
        day *
        (0.3 + houses) *
        (1 - season.cicadas * 0.5),
      [0.02, 0.05],
      [0.95, 1.1],
    );
    // Crows at dawn and dusk, often some way off.
    call(calls.crow, 0.05 * birds * dawnDusk, [0.015, 0.045], [0.94, 1.06]);
    // Cicadas: robust cicadas by day, evening cicadas at dusk and dawn, and
    // the "tsuku-tsuku-booshi" as summer ends.
    const lateSummer = cyclicBump(f, 0.5, 0.05, 0.03, 1);
    call(
      calls.minmin,
      0.12 * cicadas * season.cicadas * (1 - lateSummer * 0.6) * day * rural,
      [0.03, 0.06],
    );
    call(calls.tsukutsukuboshi, 0.06 * cicadas * lateSummer * day * rural, [0.03, 0.06]);
    const dusk = bump(hour, 18.2, 1.2, 0.6) + bump(hour, 5, 0.8, 0.5);
    call(calls.higurashi, 0.15 * cicadas * season.cicadas * dusk * rural, [0.03, 0.06]);
    call(calls.frog, 7 * frogs * season.frogs * night * fields, [0.01, 0.04], [0.85, 1.2]);
    // Autumn insects: bell crickets, field crickets and pine crickets.
    const insectRate = 3 * insects * season.crickets * night * rural;
    call(calls.suzumushi, insectRate * 0.5, [0.01, 0.035]);
    call(calls.korogi, insectRate * 0.35, [0.01, 0.035]);
    call(calls.matsumushi, insectRate * 0.15, [0.01, 0.03]);
  }

  /** A call from `set`, never the same one twice in a row. */
  private fresh(set: readonly AudioBuffer[]): AudioBuffer {
    const last = this.lastCall.get(set);
    let i = this.rng.int(0, set.length - (last === undefined ? 1 : 2));
    if (last !== undefined && i >= last) {
      i++;
    }
    this.lastCall.set(set, i);
    return set[i];
  }
}
