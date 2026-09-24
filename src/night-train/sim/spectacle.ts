import { hash, Rng } from "../core/random.ts";
import type { SeasonState } from "./season.ts";

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

export interface ShootingStar {
  /** Start direction as azimuth from south (radians, west positive) and altitude (radians). */
  az: number;
  alt: number;
  /** Direction of travel on the sky (radians/second). */
  dAz: number;
  dAlt: number;
  age: number;
  life: number;
  brightness: number;
}

export interface Airplane {
  az: number;
  alt: number;
  dAz: number;
  age: number;
  life: number;
  seed: number;
}

/** Fireworks festivals on summer nights, shooting stars and passing airplanes. */
export class Spectacle {
  private readonly rng: Rng;
  private readonly seed: number;
  readonly shells: Shell[] = [];
  /** Shells that burst during the last update. */
  readonly bursts: Shell[] = [];
  readonly shootingStars: ShootingStar[] = [];
  readonly airplanes: Airplane[] = [];
  private festivalDay = -1;
  private festivalAlong = 0;
  private festivalLateral = 0;
  private nextShellIn = 0;
  private nextPlaneIn: number;

  constructor(seed: number) {
    this.seed = seed;
    this.rng = new Rng(seed ^ 0xf17e);
    this.nextPlaneIn = this.rng.range(20, 90);
  }

  update(
    dt: number,
    days: number,
    hour: number,
    pos: number,
    season: SeasonState,
    darkness: number,
    clear: number,
  ): void {
    this.bursts.length = 0;
    this.updateFireworks(dt, days, hour, pos, season);
    this.updateShootingStars(dt, darkness * clear);
    this.updateAirplanes(dt);
  }

  private updateFireworks(
    dt: number,
    days: number,
    hour: number,
    pos: number,
    season: SeasonState,
  ): void {
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

  private updateShootingStars(dt: number, visibility: number): void {
    if (visibility > 0.5 && this.rng.chance(dt / 35)) {
      const r = this.rng;
      const angle = r.range(-Math.PI, Math.PI);
      const speed = r.range(0.35, 0.7);
      this.shootingStars.push({
        az: r.range(-0.9, 0.9),
        alt: r.range(0.35, 1.0),
        dAz: Math.cos(angle) * speed,
        dAlt: -Math.abs(Math.sin(angle)) * speed,
        age: 0,
        life: r.range(0.4, 0.9),
        brightness: r.range(0.5, 1),
      });
    }
    for (const s of this.shootingStars) {
      s.age += dt;
    }
    for (let i = this.shootingStars.length - 1; i >= 0; i--) {
      if (this.shootingStars[i].age > this.shootingStars[i].life) {
        this.shootingStars.splice(i, 1);
      }
    }
  }

  private updateAirplanes(dt: number): void {
    this.nextPlaneIn -= dt;
    if (this.nextPlaneIn <= 0) {
      this.nextPlaneIn = this.rng.range(80, 220);
      const r = this.rng;
      const dir = r.chance(0.5) ? 1 : -1;
      const life = r.range(45, 70);
      this.airplanes.push({
        az: -dir * 1.1,
        alt: r.range(0.18, 0.55),
        dAz: (dir * 2.2) / life,
        age: 0,
        life,
        seed: r.int(0, 1 << 30),
      });
    }
    for (const p of this.airplanes) {
      p.age += dt;
      p.az += p.dAz * dt;
    }
    for (let i = this.airplanes.length - 1; i >= 0; i--) {
      if (this.airplanes[i].age > this.airplanes[i].life) {
        this.airplanes.splice(i, 1);
      }
    }
  }
}
