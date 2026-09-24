import { describe, expect, it } from "vitest";
import { DEG } from "../core/math.ts";
import { computeSky } from "./astro.ts";
import { Clock, DAYS_PER_YEAR, formatClock } from "./clock.ts";
import { crossingActive, crossingClosure } from "./crossing.ts";
import { makeTerrainScratch, Route } from "./route.ts";
import { computeSeason } from "./season.ts";
import { DECEL, DWELL, Train } from "./train.ts";

describe("clock", () => {
  it("formats minutes as HH:MM and wraps at midnight", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(23 * 60 + 59.9)).toBe("23:59");
    expect(formatClock(1440 + 61)).toBe("01:01");
  });

  it("runs one day in five real minutes and one year in twelve days", () => {
    const c = new Clock(0);
    c.advance(150);
    expect(c.minuteOfDay).toBeCloseTo(720, 6);
    expect(DAYS_PER_YEAR).toBe(12);
    expect(Clock.at(3, 0).season).toBe("summer");
    expect(Clock.at(11.99, 0).season).toBe("winter");
  });
});

describe("sky", () => {
  /** Finds the hour the sun crosses the horizon, scanning from `from`. */
  function crossing(day: number, from: number, rising: boolean): number {
    const clock = Clock.at(day, 0);
    for (let m = from * 60; m < from * 60 + 720; m++) {
      const a = computeSky(clock.calendarDayOfYear, m / 60, day).sunAltitude;
      const b = computeSky(clock.calendarDayOfYear, (m + 1) / 60, day).sunAltitude;
      if (rising ? a < 0 && b >= 0 : a >= 0 && b < 0) {
        return m / 60;
      }
    }
    return Number.NaN;
  }

  it("has long summer days and short winter days at 35°N", () => {
    // Mid-summer (late June) and mid-winter (late December) in world days.
    const summerDay = crossing(3.9, 12, false) - crossing(3.9, 0, true);
    const winterDay = crossing(9.9, 12, false) - crossing(9.9, 0, true);
    expect(summerDay).toBeGreaterThan(14);
    expect(summerDay).toBeLessThan(15);
    expect(winterDay).toBeGreaterThan(9.5);
    expect(winterDay).toBeLessThan(10.3);
  });

  it("puts the sun due south and highest at noon", () => {
    const clock = Clock.at(4, 0);
    const sky = computeSky(clock.calendarDayOfYear, 12, 4);
    expect(sky.sun.e).toBeCloseTo(0, 6);
    expect(sky.sun.n).toBeLessThan(0);
    expect(sky.sunAltitude).toBeGreaterThan(70);
  });

  it("rises a full moon at sunset", () => {
    // Find a day where the phase is full, then check the moon is opposite the sun.
    for (let d = 0; d < 8; d += 0.01) {
      const clock = Clock.at(d, 0);
      const sky = computeSky(clock.calendarDayOfYear, 18, d);
      if (Math.abs(sky.moonPhase - 0.5) < 0.005) {
        const dot = sky.sun.e * sky.moon.e + sky.sun.n * sky.moon.n + sky.sun.u * sky.moon.u;
        expect(dot).toBeLessThan(Math.cos(160 * DEG));
        return;
      }
    }
    throw new Error("no full moon found");
  });
});

describe("season", () => {
  it("blooms cherries in spring and flooded paddies before summer", () => {
    expect(computeSeason(0.1).blossom).toBeCloseTo(1, 5);
    expect(computeSeason(0.6).blossom).toBe(0);
    expect(computeSeason(0.21).paddyFlooded).toBeCloseTo(1, 5);
    expect(computeSeason(0.43).warmth).toBeGreaterThan(0.95);
    expect(computeSeason(0.9).warmth).toBeLessThan(0.05);
  });
});

describe("route", () => {
  it("is reproducible from its seed", () => {
    const a = new Route(42);
    const b = new Route(42);
    a.ensure(40000, 0);
    b.ensure(40000, 0);
    expect(a.sectionsIn(0, 40000).map((s) => [s.kind, s.start, s.end])).toEqual(
      b.sectionsIn(0, 40000).map((s) => [s.kind, s.start, s.end]),
    );
  });

  it("keeps structures inside their section and apart from each other", () => {
    const route = new Route(7);
    route.ensure(200000, 0);
    for (const s of route.sectionsIn(0, 200000)) {
      const spans = [...s.tunnels, ...s.bridges, ...(s.station ? [s.station] : [])];
      for (const sp of spans) {
        expect(sp.start).toBeGreaterThan(s.start);
        expect(sp.end).toBeLessThan(s.end);
      }
      for (const c of s.crossings) {
        expect(spans.every((sp) => c.at < sp.start - 60 || c.at > sp.end + 60)).toBe(true);
      }
    }
  });

  it("blends terrain continuously across section boundaries", () => {
    const route = new Route(3);
    route.ensure(100000, 0);
    const t = makeTerrainScratch();
    let prev = route.terrain(0, t).cruise;
    for (let a = 5; a < 100000; a += 5) {
      const v = route.terrain(a, t).cruise;
      expect(Math.abs(v - prev)).toBeLessThan(0.3);
      prev = v;
    }
  });

  it("pushes the coastline to the horizon where the coast ends", () => {
    const route = new Route(11, "coast");
    route.ensure(50000, 0);
    const t = makeTerrainScratch();
    const first = route.first;
    const mid = (first.start + first.end) / 2;
    expect(route.shoreAt(route.terrain(mid, t), mid)).toBeLessThan(60);
    const inland = route.sectionsIn(first.end + 2000, 50000).find((s) => s.terrain.coast === 0);
    if (inland) {
      const at = (inland.start + inland.end) / 2;
      expect(route.shoreAt(route.terrain(at, t), at)).toBe(Infinity);
    }
  });
});

describe("train", () => {
  it("stops exactly at the station mark, dwells, and departs", () => {
    const route = new Route(5, "town", "town");
    route.ensure(60000, 0);
    const station = route.nextStation(0);
    expect(station).not.toBeNull();
    const train = new Train(route, station!.stop - 900);
    const events: string[] = [];
    for (let i = 0; i < 60 * 240 && train.pos < station!.stop + 50; i++) {
      train.update(1 / 60);
      events.push(...train.events);
      if (train.phase === "stopped") {
        expect(train.pos).toBe(station!.stop);
        expect(train.speed).toBe(0);
      }
    }
    expect(events).toEqual([
      "brake",
      "arrive",
      "airRelease",
      "doorOpen",
      "melody",
      "doorChime",
      "doorClose",
      "depart",
    ]);
    expect(DWELL).toBeGreaterThan(20);
  });

  it("never exceeds the braking curve while approaching", () => {
    const route = new Route(9, "town", "town");
    route.ensure(60000, 0);
    const station = route.nextStation(0)!;
    const train = new Train(route, station.stop - 600);
    while (train.phase !== "stopped") {
      train.update(1 / 60);
      const remaining = station.stop - train.pos;
      expect(train.speed).toBeLessThanOrEqual(Math.sqrt(2 * DECEL * Math.max(0, remaining)) + 1e-9);
    }
  });
});

describe("crossing", () => {
  it("closes before we arrive and opens after we pass", () => {
    const c = { at: 1000, waitingCar: false, seed: 1 };
    expect(crossingActive(c, 500)).toBe(false);
    expect(crossingActive(c, 700)).toBe(true);
    expect(crossingClosure(c, 1000)).toBe(1);
    expect(crossingClosure(c, 1300)).toBe(0);
  });
});
