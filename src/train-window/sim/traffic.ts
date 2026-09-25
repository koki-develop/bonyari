import { bump } from "../../shared/core/math.ts";
import { Rng } from "../../shared/core/random.ts";
import { makeTerrainScratch, type Route } from "./route.ts";

export type CarKind = "car" | "kei" | "van" | "bus";

export interface Car {
  along: number;
  /** +1 drives toward +along, -1 the other way. */
  dir: 1 | -1;
  speed: number;
  /** Speed the driver wants when the lane ahead is clear. */
  cruise: number;
  kind: CarKind;
  color: number;
  seed: number;
}

export interface OncomingTrain {
  /** Along position (m) of the front of the train; it runs toward -along. */
  front: number;
  speed: number;
  cars: number;
  freight: boolean;
  seed: number;
}

/** Lane offsets (m) from the road center line; Japan drives on the left. */
export const LANE_OFFSET = 1.7;
const CAR_LENGTH = 4.5;
export const ONCOMING_CAR_LENGTH = 20;
const ONCOMING_LEAD = 700;

/** Relative traffic density by hour of day. */
function trafficDensity(hour: number): number {
  return (
    0.08 +
    0.9 * Math.max(bump(hour, 8, 3, 2), bump(hour, 17.5, 4, 2.5)) +
    0.35 * bump(hour, 13, 6, 2)
  );
}

/** Cars on the parallel road and trains on the adjacent track, spawned just outside the view. */
export class Traffic {
  private readonly route: Route;
  private readonly rng: Rng;
  private readonly terrain = makeTerrainScratch();
  readonly cars: Car[] = [];
  readonly trains: OncomingTrain[] = [];
  private nextTrainIn: number;
  private initialized = false;

  constructor(route: Route, seed: number) {
    this.route = route;
    this.rng = new Rng(seed ^ 0x7aff1c);
    this.nextTrainIn = this.rng.range(40, 120);
  }

  /**
   * @param viewMin along-track start of the region where cars can be seen
   * @param viewMax along-track end of that region
   */
  update(
    dt: number,
    pos: number,
    trainSpeed: number,
    hour: number,
    viewMin: number,
    viewMax: number,
  ): void {
    const t = this.route.terrain(pos, this.terrain);
    const density =
      trafficDensity(hour) *
      (0.35 + 0.65 * t.houses + 0.5 * t.apartments) *
      Math.min(1, t.road * 1.5);
    const baseSpeed = 11 + 5 * (1 - t.houses);
    const spacing = 55;

    if (!this.initialized) {
      this.initialized = true;
      for (let a = viewMin; a < viewMax; a += spacing) {
        if (this.rng.chance(density)) {
          this.cars.push(
            this.makeCar(a + this.rng.range(0, spacing), this.rng.chance(0.5) ? 1 : -1, baseSpeed),
          );
        }
      }
    }

    // Keep a safe gap in each lane.
    for (const a of this.cars) {
      a.speed = a.cruise;
      for (const b of this.cars) {
        if (a !== b && a.dir === b.dir) {
          const ahead = (b.along - a.along) * a.dir;
          if (ahead > 0 && ahead < CAR_LENGTH * 2.5) {
            a.speed = Math.min(a.speed, b.cruise);
          }
        }
      }
    }
    for (const car of this.cars) {
      car.along += car.dir * car.speed * dt;
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.along < viewMin - 60 || c.along > viewMax + 60) {
        this.cars.splice(i, 1);
      }
    }

    // New cars cross into view at a rate proportional to their speed relative to the view.
    for (const dir of [1, -1] as const) {
      const rel = dir * baseSpeed - trainSpeed;
      const rate = (density / spacing) * Math.abs(rel);
      if (this.rng.chance(rate * dt)) {
        const along = rel < 0 ? viewMax + 40 : viewMin - 40;
        if (!this.cars.some((c) => c.dir === dir && Math.abs(c.along - along) < CAR_LENGTH * 3)) {
          this.cars.push(this.makeCar(along, dir, baseSpeed));
        }
      }
    }

    this.updateTrains(dt, pos, t.doubleTrack);
  }

  private makeCar(along: number, dir: 1 | -1, baseSpeed: number): Car {
    const r = this.rng;
    const kind = r.weighted<CarKind>({ car: 6, kei: 3, van: 1.5, bus: 0.4 });
    const speed = baseSpeed * r.range(0.85, 1.15) * (kind === "bus" ? 0.85 : 1);
    return {
      along,
      dir,
      speed,
      cruise: speed,
      kind,
      color: r.int(0, 1 << 30),
      seed: r.int(0, 1 << 30),
    };
  }

  private updateTrains(dt: number, pos: number, doubleTrack: number): void {
    for (const tr of this.trains) {
      tr.front -= tr.speed * dt;
    }
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const tr = this.trains[i];
      if (tr.front + tr.cars * ONCOMING_CAR_LENGTH < pos - ONCOMING_LEAD) {
        this.trains.splice(i, 1);
      }
    }
    this.nextTrainIn -= dt;
    if (this.nextTrainIn > 0 || this.trains.length > 0) {
      return;
    }
    const spawnAt = pos + ONCOMING_LEAD;
    const clear =
      doubleTrack > 0.9 &&
      this.route.terrain(spawnAt, this.terrain).doubleTrack > 0.9 &&
      this.route.tunnelsIn(pos - 100, spawnAt).length === 0;
    if (!clear) {
      this.nextTrainIn = 10;
      return;
    }
    const freight = this.rng.chance(0.35);
    this.trains.push({
      front: spawnAt,
      speed: freight ? this.rng.range(18, 23) : this.rng.range(22, 30),
      cars: freight ? this.rng.int(10, 18) : this.rng.int(4, 10),
      freight,
      seed: this.rng.int(0, 1 << 30),
    });
    this.nextTrainIn = this.rng.range(90, 240);
  }
}
