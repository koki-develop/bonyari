import { describe, expect, it } from "vitest";
import { DAYS_PER_YEAR } from "../../shared/env/clock.ts";
import { AIR, cellIndex, cellX, cellY, DOMAIN, FILL, OPEN, SOIL, SURFACE } from "./geometry.ts";
import { generatePlan } from "./plan.ts";
import { decodeRecord, decodeRuns, encodeRecord, encodeRuns } from "./record.ts";
import { Soil } from "./soil.ts";
import { TIMEKEEPING, World } from "./world.ts";

/** Time allowed (ms) to tests that live through years. */
const LONG = 60_000;

/** Runs a world for `seconds` of real time in steps of `step`. */
function run(world: World, seconds: number, step = 1): void {
  for (let t = 0; t < seconds; t += step) {
    world.update(step);
  }
}

describe("plan", () => {
  it("is the same for the same seed", () => {
    const a = generatePlan(42, new Soil(42));
    const b = generatePlan(42, new Soil(42));
    expect(a.features.length).toBe(b.features.length);
    a.features.forEach((f, i) => {
      expect(Array.from(f.dig)).toEqual(Array.from(b.features[i].dig));
    });
  });

  it("digs only soil, inside the colony's ground", () => {
    for (const seed of [1, 42, 9001]) {
      const soil = new Soil(seed);
      const plan = generatePlan(seed, soil);
      for (const f of plan.features) {
        for (const c of f.dig) {
          const x = cellX(c);
          const y = cellY(c);
          expect(soil.stoneAt(x, y)).toBe(false);
          expect(y).toBeLessThanOrEqual(soil.ground(x));
          expect(x).toBeGreaterThan(DOMAIN.x0 - 8);
          expect(x).toBeLessThan(DOMAIN.x1 + 8);
          expect(y).toBeGreaterThan(DOMAIN.y0 - 12);
        }
      }
    }
  });

  it("starts every feature on its parent's centerline", () => {
    const plan = generatePlan(7, new Soil(7));
    for (const f of plan.features) {
      if (f.parent < 0) {
        expect(f.role).toBe("entrance");
        continue;
      }
      const parent = plan.features[f.parent];
      expect(f.line.x(0)).toBeCloseTo(parent.line.x(f.attachS), 6);
      expect(f.line.y(0)).toBeCloseTo(parent.line.y(f.attachS), 6);
    }
  });

  it("lays out many chambers, deep down, for every seed", () => {
    for (let k = 1; k <= 40; k++) {
      const seed = Math.imul(k, 2654435761) >>> 0;
      const plan = generatePlan(seed, new Soil(seed));
      const chambers = plan.features.filter((f) => f.kind === "chamber");
      expect(chambers.length).toBeGreaterThanOrEqual(6);
      const deepest = Math.min(...chambers.map((f) => f.floor));
      expect(deepest).toBeLessThan(-180);
      expect(plan.portals.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("nest", () => {
  it("finds a way from the surface into what is dug, and none into what is not", () => {
    const world = World.create({ seed: 5 });
    const nest = world.nest;
    const entrance = world.plan.portals[0];
    const out: number[] = [];
    nest.dig(0, 100000, out);
    nest.dig(1, 100000, out);
    const into = nest.route({ f: SURFACE, s: entrance.x + 30, u: 0 }, { f: 1, s: 8, u: 0 });
    expect(into).not.toBeNull();
    expect(into?.at(-1)).toEqual({ f: 1, s: 8 });
    // The shaft below is not dug yet.
    expect(nest.route({ f: 1, s: 8, u: 0 }, { f: 2, s: 20, u: 0 })).toBeNull();
  });

  it("shuts an entrance only once the hole in the middle of its plug is packed", () => {
    const world = World.create({ seed: 5 });
    const nest = world.nest;
    nest.dig(0, 100000, []);
    const portal = world.plan.portals[0];
    expect(portal.shut).toBeGreaterThan(portal.plug.length / 2);
    expect(portal.shut).toBeLessThanOrEqual(portal.plug.length);
    nest.packPlug(0, portal.shut - 1);
    expect(nest.portalOpen(0)).toBe(true);
    nest.packPlug(0, 1);
    expect(nest.portalOpen(0)).toBe(false);
    nest.clearPlug(0, 1);
    expect(nest.portalOpen(0)).toBe(true);
  });
});

describe("colony", () => {
  it("is founded: the queen digs in, shuts herself in, and raises the first workers", () => {
    const world = World.create({ seed: 11 });
    run(world, 30);
    expect(world.queen?.winged).toBe(false);
    expect(world.items.filter((i) => i.kind === "wing").length).toBe(2);
    run(world, 600);
    expect(world.nest.complete(0)).toBe(true);
    expect(world.nest.complete(1)).toBe(true);
    expect(["claustral", "colony"]).toContain(world.colony.stage);
    // The first workers come out within the first summer, about 20 real minutes in.
    run(world, 900);
    expect(world.colony.stage).toBe("colony");
    expect(world.workers).toBeGreaterThanOrEqual(8);
    // And they open the way out, once it is not raining.
    for (let t = 0; t < 3 * TIMEKEEPING.secondsPerDay && world.nest.plugged(0); t += 10) {
      run(world, 10);
    }
    expect(world.nest.plugged(0)).toBe(false);
  });

  it("keeps every ant and every brood item in open ground", () => {
    const world = World.create({ seed: 23 });
    let checked = 0;
    let buried = 0;
    for (let t = 0; t < 3600; t += 1) {
      world.update(1);
      if (t % 10 !== 0) {
        continue;
      }
      for (const a of world.ants) {
        if (a.loc.f < 0) {
          continue;
        }
        checked++;
        const m = world.nest.material[cellIndex(a.x, a.y)];
        if (m !== OPEN && m !== AIR && m !== FILL) {
          buried++;
        }
      }
      for (const b of world.brood) {
        if (!b.carried) {
          const p = world.locate(b.loc, { x: 0, y: 0 });
          expect(world.nest.material[cellIndex(p.x, p.y)]).not.toBe(SOIL);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(buried / checked).toBeLessThan(0.002);
  });

  it(
    "rests through the winter behind shut doors, and opens them in spring",
    () => {
      const world = World.create({ seed: 31 });
      // To the middle of the first winter (early January, day 11 of the year).
      run(world, (11 - world.day) * TIMEKEEPING.secondsPerDay);
      expect(world.colony.dormancy).toBeGreaterThan(0.8);
      expect(world.colony.closed).toBe(true);
      expect(
        world.plan.portals.every((_, p) => !world.nest.portalOpen(p) || !world.nest.portalDug(p)),
      ).toBe(true);
      expect(world.brood.every((b) => b.stage !== "egg")).toBe(true);
      // To late spring.
      run(world, 4.5 * TIMEKEEPING.secondsPerDay);
      expect(world.colony.dormancy).toBeLessThan(0.2);
      run(world, 0.8 * TIMEKEEPING.secondsPerDay);
      expect(world.nest.portalOpen(0) || world.env.weather.state.rain > 0.02).toBe(true);
    },
    LONG,
  );

  it(
    "grows over the years, digging the nest deeper as it does",
    () => {
      const world = World.create({ seed: 12345 });
      run(world, 3 * DAYS_PER_YEAR * TIMEKEEPING.secondsPerDay, 2);
      expect(world.workers).toBeGreaterThanOrEqual(80);
      expect(world.nest.openCells).toBeGreaterThan(3000);
      // Everything that happens is finite.
      for (const a of world.ants) {
        expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.heading)).toBe(
          true,
        );
      }
      expect(world.surface.heap.every((h) => Number.isFinite(h) && h >= 0)).toBe(true);
    },
    LONG,
  );
});

describe("in the long run", () => {
  it(
    "keeps living once the colony is full grown: old workers leave, new ones are raised, food does not pile up",
    () => {
      const world = World.create({ seed: 42 });
      run(world, 7 * DAYS_PER_YEAR * TIMEKEEPING.secondsPerDay, 2);
      // To the middle of the next summer.
      const summer = 4.5 - (world.day % DAYS_PER_YEAR);
      run(world, (summer < 0 ? summer + DAYS_PER_YEAR : summer) * TIMEKEEPING.secondsPerDay, 2);
      expect(world.brood.length).toBeGreaterThan(0);
      expect(world.workers).toBeGreaterThan(100);
      const young = world.ants.filter(
        (a) => a.caste === "worker" && world.day - a.born < DAYS_PER_YEAR,
      );
      expect(young.length).toBeGreaterThan(10);
      expect(world.storedFood() + world.colony.honey).toBeLessThan(world.workers * 1.5);
      expect(world.items.length).toBeLessThan(150);
    },
    LONG,
  );

  it(
    "never shuts an ant into a plug",
    () => {
      const world = World.create({ seed: 12345 });
      for (let t = 0; t < 2.2 * DAYS_PER_YEAR * TIMEKEEPING.secondsPerDay; t += 2) {
        world.update(2);
        if (t % 60 !== 0) {
          continue;
        }
        for (const a of world.ants) {
          if (a.loc.f >= 0) {
            expect(world.nest.material[cellIndex(a.x, a.y)]).not.toBe(FILL);
          }
        }
      }
    },
    LONG,
  );
});

describe("things that fall", () => {
  it("come to rest on the ground, however long the steps", () => {
    for (const step of [1 / 60, 0.05, 0.1]) {
      const world = World.create({ seed: 9 });
      world.dropCrumb(20, 60);
      let lands = 0;
      for (let t = 0; t < 10; t += step) {
        world.update(step);
        lands += world.events.filter((e) => e.kind === "land").length;
      }
      const crumb = world.items.find((i) => i.kind === "crumb");
      expect(crumb?.drop).toBe(0);
      expect(crumb?.fall).toBe(0);
      expect(lands).toBeLessThanOrEqual(3);
    }
  });
});

describe("the winged young", () => {
  it(
    "are raised once the colony is grown, and fly on a fair afternoon in late spring",
    () => {
      const world = World.create({ seed: 12345 });
      const flights: { year: number; yearFraction: number; hour: number }[] = [];
      for (let t = 0; t < 4 * DAYS_PER_YEAR * TIMEKEEPING.secondsPerDay; t++) {
        world.update(1);
        for (const e of world.events) {
          if (e.kind === "takeoff") {
            flights.push({
              year: world.year,
              yearFraction: world.season.yearFraction,
              hour: world.env.clock.hour,
            });
          }
        }
      }
      expect(flights.length).toBeGreaterThan(0);
      for (const f of flights) {
        expect(f.year).toBeGreaterThanOrEqual(2);
        expect(f.yearFraction).toBeGreaterThan(0.13);
        expect(f.yearFraction).toBeLessThan(0.33);
        expect(f.hour).toBeGreaterThan(12);
      }
      // Those that flew are gone; the flight was not taken out of the colony's workers.
      expect(world.workers).toBeGreaterThan(80);
    },
    LONG,
  );
});

describe("record", () => {
  it("keeps runs of cells exactly", () => {
    const cells = [0, 1, 2, 7, 8, 100, 5000, 5001, 5002, 5003];
    expect(decodeRuns(encodeRuns(cells))).toEqual(cells);
    expect(decodeRuns(encodeRuns([]))).toEqual([]);
    expect(decodeRuns("1,0")).toBeNull();
    expect(decodeRuns("zzzzzzzz,1")).toBeNull();
  });

  it(
    "loses nothing that was being carried",
    () => {
      const world = World.create({ seed: 12345 });
      run(world, 17 * TIMEKEEPING.secondsPerDay, 2);
      let checked = 0;
      for (let k = 0; k < 4000 && checked < 5; k++) {
        run(world, 0.5, 0.1);
        const carried = world.brood.filter((b) => b.carried).length;
        if (carried === 0) {
          continue;
        }
        const record = decodeRecord(encodeRecord(world.snapshot()));
        const back = record ? World.restore(record) : null;
        expect(back?.brood.length).toBe(world.brood.length);
        expect(back?.brood.every((b) => !b.carried)).toBe(true);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    },
    LONG,
  );

  it("brings a colony back as it was left, and it goes on", () => {
    const world = World.create({ seed: 77 });
    run(world, 2400);
    const before = world.snapshot();
    const text = encodeRecord(before);
    const record = decodeRecord(text);
    expect(record).not.toBeNull();
    if (!record) {
      return;
    }
    const back = World.restore(record);
    expect(back.nest.openCells).toBe(world.nest.openCells);
    expect(Array.from(back.nest.plugs)).toEqual(Array.from(world.nest.plugs));
    expect(back.ants.length).toBe(world.ants.length);
    expect(back.workers).toBe(world.workers);
    expect(back.day).toBeCloseTo(world.day, 9);
    // Carried brood and things are put down where their carrier was, not lost.
    expect(back.brood.length).toBe(world.brood.length);
    expect(back.items.length).toBe(world.items.length);
    for (let i = 0; i < back.surface.heap.length; i++) {
      expect(back.surface.heap[i]).toBeCloseTo(world.surface.heap[i], 1);
    }
    run(back, 600);
    expect(back.ants.length).toBeGreaterThanOrEqual(world.ants.length);
  });

  it("refuses what is not a record of this version", () => {
    expect(decodeRecord("not json")).toBeNull();
    expect(decodeRecord(JSON.stringify({ format: 999, record: {} }))).toBeNull();
    const world = World.create({ seed: 3 });
    const good = JSON.parse(encodeRecord(world.snapshot()));
    const broken = structuredClone(good);
    broken.record.ants[0].caste = "wasp";
    expect(decodeRecord(JSON.stringify(broken))).toBeNull();
    const short = structuredClone(good);
    short.record.temperature.pop();
    expect(decodeRecord(JSON.stringify(short))).toBeNull();
    expect(decodeRecord(JSON.stringify(good))).not.toBeNull();
  });
});
