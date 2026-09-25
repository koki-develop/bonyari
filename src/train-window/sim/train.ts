import { approach, clamp, mod } from "../../shared/core/math.ts";
import { makeTerrainScratch, RAIL_LENGTH, type Route, type Station } from "./route.ts";

/** Comfortable service acceleration and braking (m/s²). */
const ACCEL = 0.5;
export const DECEL = 0.65;
/** Gentle rate for changes of cruising speed. */
const CRUISE_ACCEL = 0.25;
/** Seconds spent at a station. */
export const DWELL = 28;

/**
 * Axle positions (m) relative to our seat, front of the train first: the rear
 * bogie of the car ahead, both bogies of our car, the front bogie of the car behind.
 */
export const AXLES: readonly { offset: number; gain: number }[] = [
  { offset: 14.15, gain: 0.35 },
  { offset: 12.05, gain: 0.4 },
  { offset: 7.95, gain: 0.85 },
  { offset: 5.85, gain: 1 },
  { offset: -5.85, gain: 1 },
  { offset: -7.95, gain: 0.85 },
  { offset: -12.05, gain: 0.4 },
  { offset: -14.15, gain: 0.35 },
];

export type TrainEventType =
  | "brake"
  | "arrive"
  | "airRelease"
  | "doorOpen"
  | "melody"
  | "doorChime"
  | "doorClose"
  | "depart";

/** Seconds after arrival at which each dwell event fires. */
const DWELL_TIMELINE: readonly (readonly [number, TrainEventType])[] = [
  [0.7, "airRelease"],
  [2.2, "doorOpen"],
  [DWELL - 13, "melody"],
  [DWELL - 4.2, "doorChime"],
  [DWELL - 2.4, "doorClose"],
  [DWELL, "depart"],
];

export type TrainPhase = "running" | "braking" | "stopped";

export const TRAIN_PHASES: readonly TrainPhase[] = ["running", "braking", "stopped"];

/** Seconds after arrival while the doors stand open. */
const DOORS_OPEN_FROM = DWELL_TIMELINE.find(([, type]) => type === "doorOpen")![0];
const DOORS_OPEN_UNTIL = DWELL_TIMELINE.find(([, type]) => type === "doorClose")![0];

/** The state a train carries from one moment to the next; everything else follows from the route. */
export interface TrainState {
  pos: number;
  speed: number;
  cruise: number;
  traction: number;
  phase: TrainPhase;
  dwell: number;
  stationsVisited: number;
}

export class Train {
  private readonly route: Route;
  private readonly terrain = makeTerrainScratch();
  /** Along-track position (m) of our window. */
  pos: number;
  /** Speed (m/s). */
  speed: number;
  /** Signed acceleration normalized to the service rates; drives the motor sound. */
  traction = 0;
  phase: TrainPhase = "running";
  /** Seconds since arrival while stopped. */
  dwell = 0;
  doorsOpen = false;
  station: Station | null = null;
  /** Stations stopped at so far. */
  stationsVisited = 0;
  /** Events fired during the last update. */
  readonly events: TrainEventType[] = [];
  private cruise: number;

  constructor(route: Route, pos: number) {
    this.route = route;
    this.pos = pos;
    this.cruise = route.terrain(pos, this.terrain).cruise;
    this.speed = this.cruise;
  }

  /**
   * A train continuing from `state`, or null when the state doesn't fit the
   * route: braking with no station ahead, or stopped away from a stop mark.
   */
  static restore(route: Route, state: TrainState): Train | null {
    const train = new Train(route, state.pos);
    train.speed = state.speed;
    train.cruise = state.cruise;
    train.traction = state.traction;
    train.phase = state.phase;
    train.dwell = state.dwell;
    train.stationsVisited = state.stationsVisited;
    if (state.phase === "braking") {
      train.station = route.nextStation(state.pos);
    } else if (state.phase === "stopped") {
      const station = route.stationAt(state.pos);
      train.station = station?.stop === state.pos ? station : null;
      train.doorsOpen = state.dwell >= DOORS_OPEN_FROM && state.dwell < DOORS_OPEN_UNTIL;
    }
    return state.phase !== "running" && train.station === null ? null : train;
  }

  snapshot(): TrainState {
    return {
      pos: this.pos,
      speed: this.speed,
      cruise: this.cruise,
      traction: this.traction,
      phase: this.phase,
      dwell: this.dwell,
      stationsVisited: this.stationsVisited,
    };
  }

  update(dt: number): void {
    this.events.length = 0;
    if (this.phase === "stopped") {
      this.updateDwell(dt);
      return;
    }

    const terrain = this.route.terrain(this.pos, this.terrain);
    this.cruise = approach(this.cruise, terrain.cruise, 0.2, dt);
    let target = this.cruise;
    const next = this.route.nextStation(this.pos + 0.01);
    if (next) {
      const remaining = next.stop - this.pos;
      const brakingSpeed = Math.sqrt(2 * DECEL * Math.max(0, remaining));
      if (brakingSpeed < target) {
        target = brakingSpeed;
        if (this.phase === "running") {
          this.phase = "braking";
          this.station = next;
          this.events.push("brake");
        }
      }
    }

    const prev = this.speed;
    if (this.phase === "braking" && this.station) {
      // Follow the braking curve exactly so the stop lands on the mark.
      const remaining = Math.max(0, this.station.stop - this.pos);
      // The speed that lands exactly on the curve after this step:
      // v = sqrt(2a (remaining - v dt)).
      const ad = DECEL * dt;
      const onCurve = -ad + Math.sqrt(ad * ad + 2 * DECEL * remaining);
      const v = Math.min(this.speed, onCurve);
      const step = Math.min(v * dt, remaining);
      this.pos += step;
      this.speed = v;
      if (remaining - step < 0.02 || v < 0.03) {
        this.pos = this.station.stop;
        this.speed = 0;
        this.phase = "stopped";
        this.dwell = 0;
        this.stationsVisited++;
        this.events.push("arrive");
      }
    } else {
      const rate = target > this.speed ? (this.speed < target - 3 ? ACCEL : CRUISE_ACCEL) : DECEL;
      this.speed += clamp(target - this.speed, -rate * dt, rate * dt);
      this.pos += this.speed * dt;
      if (next) {
        // Never run above the braking curve from where we now are.
        this.speed = Math.min(this.speed, Math.sqrt(2 * DECEL * Math.max(0, next.stop - this.pos)));
      }
    }
    const accel = dt > 0 ? (this.speed - prev) / dt : 0;
    this.traction = approach(this.traction, accel >= 0 ? accel / ACCEL : accel / DECEL, 4, dt);
  }

  private updateDwell(dt: number): void {
    const before = this.dwell;
    this.dwell += dt;
    this.traction = approach(this.traction, 0, 4, dt);
    for (const [at, type] of DWELL_TIMELINE) {
      if (before < at && this.dwell >= at) {
        this.events.push(type);
        if (type === "doorOpen") {
          this.doorsOpen = true;
        } else if (type === "doorClose") {
          this.doorsOpen = false;
        } else if (type === "depart") {
          this.phase = "running";
          this.station = null;
        }
      }
    }
  }

  /**
   * Vertical jolt 0..1 of the car body as the wheels under our seat cross a
   * rail joint; used to shake the view and the things on the table.
   */
  jolt(jointed: number): number {
    if (jointed < 0.5 || this.speed < 0.5) {
      return 0;
    }
    const window = this.speed * 0.05;
    let j = 0;
    for (let i = 2; i < 6; i++) {
      const d = mod(this.pos + AXLES[i].offset, RAIL_LENGTH);
      if (d < window) {
        j = Math.max(j, AXLES[i].gain * (1 - d / window));
      }
    }
    return j * Math.min(1, this.speed / 15);
  }
}
