import { describe, expect, it } from "vitest";
import { Rng } from "../../shared/core/random.ts";
import { Archer, ARROW_REST, LOWER_TIME, RESIDUAL } from "./archer.ts";
import { nockOf, obstaclesOf, settle, standingArrows, type RestingArrow } from "./arrows.ts";
import {
  AZUCHI_FOOT,
  EYE,
  OWN_TARGET,
  RANGE_PRIMS,
  TARGET_DISTANCE,
  TARGET_HEIGHT,
  TARGETS,
} from "./dojo.ts";
import { positionAt, solveLaunch, timeAtDepth, traceFlight } from "./flight.ts";
import { decodeRecord, encodeRecord } from "./record.ts";
import { CLEAR_TIME, DOJO_WEATHER, TIMEKEEPING, World } from "./world.ts";

const FROM = { x: ARROW_REST.x, y: EYE + ARROW_REST.y, z: ARROW_REST.z };

function aimAt(x: number, y: number) {
  return { x, y, z: TARGET_DISTANCE };
}

function shoot(x: number, y: number, standing: readonly RestingArrow[] = []) {
  const launch = solveLaunch(FROM, aimAt(x, y));
  return traceFlight(launch, RANGE_PRIMS, obstaclesOf(standing));
}

/** Runs the world for `seconds` in frame-sized steps. */
function run(world: World, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += 1 / 30) {
    world.update(1 / 30);
    each?.();
  }
}

describe("flight", () => {
  it("passes through the aim on the plane of the targets, holding high for the drop", () => {
    for (const [x, y] of [
      [0, TARGET_HEIGHT],
      [-3.6, 0.5],
      [2, 1.4],
      [1, -0.8],
    ]) {
      const launch = solveLaunch(FROM, aimAt(x, y));
      const t = timeAtDepth(launch, TARGET_DISTANCE);
      const p = positionAt(launch, t, { x: 0, y: 0, z: 0 });
      expect(p.x).toBeCloseTo(x, 4);
      expect(p.y).toBeCloseTo(y, 4);
      // About 0.6 s to the target, as a bow of 15 kg or so shoots.
      expect(t).toBeGreaterThan(0.5);
      expect(t).toBeLessThan(0.7);
      // Launched upward of the straight line to the mark.
      expect(launch.vy / launch.vz).toBeGreaterThan((y - FROM.y) / (TARGET_DISTANCE - FROM.z));
    }
  });

  it("strikes the target aimed at", () => {
    const impact = shoot(0, TARGET_HEIGHT);
    expect(impact?.prim).toBe(TARGETS[OWN_TARGET].disc);
    expect(Math.hypot(impact!.u, impact!.v)).toBeLessThan(0.002);
    const neighbour = shoot(TARGETS[0].x + 0.05, TARGET_HEIGHT + 0.1);
    expect(neighbour?.prim).toBe(TARGETS[0].disc);
    expect(neighbour!.u).toBeCloseTo(0.05, 2);
    expect(neighbour!.v).toBeGreaterThan(0.09);
  });

  it("goes into the bank, the lawn, the curtain or a post elsewhere", () => {
    expect(shoot(0.9, 0.8)?.prim?.material).toBe("azuchi");
    const low = shoot(0.5, -0.9);
    expect(low?.prim?.material).toBe("lawn");
    expect(low!.point.z).toBeGreaterThan(12);
    expect(low!.point.z).toBeLessThan(26.4);
    expect(shoot(1, 1.85)?.prim?.material).toBe("cloth");
    // The post stands in front of the plane of the targets, so the line to it is aimed a little wide.
    expect(shoot(2.77, 1)?.prim?.name).toBe("post2");
  });

  it("leaves arrows standing in the paper and the sand, and knocks them off the hoop and cloth", () => {
    const r = new Rng(1);
    const center = settle(shoot(0, TARGET_HEIGHT)!, [], 0, 0, 0, r);
    expect(center.sound).toBe("target");
    expect(center.arrow.rest).toBe("stuck");
    expect(center.hole?.target).toBe(OWN_TARGET);
    // The point is in the sand behind the paper, and most of the shaft stands out in front.
    expect(center.arrow.z).toBeGreaterThan(TARGET_DISTANCE + 0.2);
    expect(nockOf(center.arrow, { x: 0, y: 0, z: 0 }).z).toBeLessThan(TARGET_DISTANCE - 0.5);

    const rim = settle(shoot(0.178, TARGET_HEIGHT)!, [], 1, 1, 0, r);
    expect(rim.sound).toBe("rim");
    expect(rim.arrow.rest).toBe("lying");
    expect(rim.drop).toBeGreaterThan(0);

    const cloth = settle(shoot(-1, 1.85)!, [], 2, 0, 0, r);
    expect(cloth.sound).toBe("cloth");
    expect(cloth.arrow.rest).toBe("lying");
    expect(cloth.arrow.z).toBeLessThan(AZUCHI_FOOT);
    expect(cloth.arrow.y).toBeLessThan(0.01);
  });

  it("splits an arrow when the next one flies exactly the same path", () => {
    const first = settle(shoot(0, TARGET_HEIGHT)!, [], 0, 0, 0, new Rng(2)).arrow;
    const second = shoot(0, TARGET_HEIGHT, [first]);
    expect(second?.kind).toBe("nock");
    // A little to the side it glances off the shaft, or misses it altogether.
    const beside = shoot(0.02, TARGET_HEIGHT + 0.02, [first]);
    expect(beside?.kind === "shaft" || beside?.prim === TARGETS[OWN_TARGET].disc).toBe(true);
  });
});

describe("archer", () => {
  it("raises, draws, holds at full draw and looses, then lowers and nocks the next arrow", () => {
    const archer = new Archer(3);
    expect(archer.begin()).toBe(true);
    archer.pull(1);
    const events: string[] = [];
    for (let i = 0; i < 90 && !archer.full; i++) {
      archer.update(1 / 30);
      events.push(...archer.events);
    }
    expect(archer.full).toBe(true);
    expect(events).toContain("raise");
    expect(events).toContain("full");
    expect(archer.closeness).toBeCloseTo(1, 5);
    archer.loose();
    expect(archer.phase).toBe("release");
    archer.update(1 / 30);
    expect(archer.shot).not.toBeNull();
    archer.update(1 / 30);
    expect(archer.shot).toBeNull();
    for (let t = 0; t < RESIDUAL + LOWER_TIME + 0.2; t += 1 / 30) {
      archer.update(1 / 30);
      events.push(...archer.events);
    }
    expect(archer.phase).toBe("rest");
    expect(archer.nocked).toBe(true);
    expect(events).toContain("nock");
  });

  it("lets the draw down instead of shooting when released early", () => {
    const archer = new Archer(4);
    archer.begin();
    archer.pull(0.5);
    for (let i = 0; i < 60; i++) {
      archer.update(1 / 30);
    }
    archer.loose();
    archer.update(1 / 30);
    expect(archer.shot).toBeNull();
    expect(archer.events).toContain("letdown");
    for (let i = 0; i < 120; i++) {
      archer.update(1 / 30);
    }
    expect(archer.phase).toBe("rest");
    expect(archer.draw).toBe(0);
    expect(archer.raise).toBe(0);
  });
});

describe("world", () => {
  function shootOnce(world: World): void {
    expect(world.handBegin()).toBe(true);
    world.handPull(1);
    run(world, 3);
    expect(world.archer.full).toBe(true);
    world.handLoose();
    run(world, 1.2);
  }

  it("leaves the arrow standing in the target and the hole in its paper", () => {
    const world = World.create({ seed: 7, minute: 600, weather: "clear" });
    shootOnce(world);
    expect(world.arrows).toHaveLength(1);
    expect(world.holes).toHaveLength(1);
    expect(world.flights).toHaveLength(0);
    expect(world.arrows[0].target).toBe(OWN_TARGET);
  });

  it("never shoots on its own", () => {
    const world = World.create({ seed: 8, minute: 600, weather: "clear" });
    let loosed = 0;
    run(world, 120, () => {
      loosed += world.events.filter((e) => e.kind === "loose").length;
    });
    expect(loosed).toBe(0);
    expect(world.archer.phase).toBe("rest");
  });

  it("clears every arrow and every hole at once, and can shoot straight away", () => {
    const world = World.create({ seed: 9, minute: 600, weather: "clear" });
    expect(world.clearArrows()).toBe(false);
    for (const [x, y] of [
      [0, TARGET_HEIGHT],
      [1.2, 0.9],
      [-0.4, -0.9],
      [-2, 1.85],
    ]) {
      world.archer.aimAt(x, y);
      world.userAim.x = x;
      world.userAim.y = y;
      shootOnce(world);
      run(world, 3.5);
    }
    expect(world.arrows.length).toBe(4);
    expect(world.hasArrows).toBe(true);
    expect(world.clearArrows()).toBe(true);
    expect(world.arrows).toHaveLength(0);
    expect(world.holes).toHaveLength(0);
    expect(world.hasArrows).toBe(false);
    // They fade out for a moment, and are gone.
    expect(world.clearing).toHaveLength(4);
    world.update(1 / 30);
    expect(world.events.some((e) => e.kind === "cleared")).toBe(true);
    run(world, CLEAR_TIME + 0.1);
    expect(world.clearing).toHaveLength(0);
    expect(world.handBegin()).toBe(true);
  });

  it("keeps the same autumn day, day after day, with only autumn weather", () => {
    const world = World.create({ seed: 11, minute: 720 });
    const season = world.env.season;
    const sun = { ...world.env.sky.sun };
    // Three whole days on, at noon again.
    for (let i = 0; i < 90; i++) {
      world.update(TIMEKEEPING.secondsPerDay / 30);
    }
    expect(world.env.season).toEqual(season);
    expect(world.env.sky.sun.u).toBeCloseTo(sun.u, 6);
    expect(world.env.sky.sun.e).toBeCloseTo(sun.e, 6);
    expect(world.env.sky.sun.n).toBeCloseTo(sun.n, 6);
    for (let seed = 0; seed < 300; seed++) {
      expect(DOJO_WEATHER).toContain(World.create({ seed }).env.weather.state.kind);
    }
  });

  it("draws autumn weather afresh for a record kept in weather the dojo no longer has", () => {
    const world = World.create({ seed: 12, minute: 700 });
    shootOnce(world);
    const record = world.snapshot();
    record.env.weather.state.kind = "snow";
    const back = World.restore(decodeRecord(encodeRecord(record))!);
    expect(DOJO_WEATHER).toContain(back.env.weather.state.kind);
    expect(back.env.clock.days).toBe(record.env.days);
    expect(back.arrows).toHaveLength(1);
  });

  it("comes back to the same dojo from its record", () => {
    const world = World.create({ seed: 10, minute: 700, weather: "cloudy" });
    shootOnce(world);
    world.archer.aimAt(1, 0.8);
    world.userAim.x = 1;
    world.userAim.y = 0.8;
    const record = decodeRecord(encodeRecord(world.snapshot()));
    expect(record).not.toBeNull();
    const back = World.restore(record!);
    expect(back.arrows.map((a) => [a.x, a.y, a.z, a.target])).toEqual(
      world.arrows.map((a) => [a.x, a.y, a.z, a.target]),
    );
    expect(back.holes).toEqual(world.holes);
    expect(back.env.clock.days).toBe(world.env.clock.days);
    expect(back.userAim).toEqual(world.userAim);
    expect(standingArrows(back.arrows)).toHaveLength(1);
  });

  it("rejects records that are broken or of another format", () => {
    const text = encodeRecord(World.create({ seed: 3 }).snapshot());
    expect(decodeRecord(text)).not.toBeNull();
    expect(decodeRecord("{")).toBeNull();
    expect(decodeRecord(text.replace('"format":1', '"format":2'))).toBeNull();
    const broken = JSON.parse(text);
    broken.record.arrows = [{ rest: "stuck", x: 0 }];
    expect(decodeRecord(JSON.stringify(broken))).toBeNull();
  });
});
