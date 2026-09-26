import { Rng } from "../core/random.ts";

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

/** What besides meteors crosses a work's sky: a world before flight has no airplanes. */
export interface SkyTraffic {
  airplanes: boolean;
}

export const MODERN_SKY: SkyTraffic = { airplanes: true };

/**
 * Shooting stars and passing airplanes. Their directions are relative to the
 * view (azimuth 0 is straight ahead), so every work sees them wherever it looks.
 */
export class SkyEvents {
  private readonly rng: Rng;
  private readonly traffic: SkyTraffic;
  readonly shootingStars: ShootingStar[] = [];
  readonly airplanes: Airplane[] = [];
  private nextPlaneIn: number;

  constructor(seed: number, traffic: SkyTraffic = MODERN_SKY) {
    this.rng = new Rng(seed ^ 0xf17e);
    this.traffic = traffic;
    this.nextPlaneIn = this.rng.range(20, 90);
  }

  /** @param starlight how well shooting stars show: dark and clear (0..1) */
  update(dt: number, starlight: number): void {
    this.updateShootingStars(dt, starlight);
    this.updateAirplanes(dt);
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
    if (!this.traffic.airplanes) {
      return;
    }
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
