import { describe, expect, it } from "vitest";
import { newAnimal } from "./animals.ts";
import { KINDS } from "./buildings.ts";
import { RING_AT_ONCE } from "./council.ts";
import { alongFence, fenceRun } from "./fence.ts";
import { rectPoint, rectsOverlap } from "./geometry.ts";
import { Rng } from "../../shared/core/random.ts";
import { GROWN } from "./people.ts";
import { generatePlan } from "./plan.ts";
import { decodeRecord, encodeRecord, runs, unrun } from "./record.ts";
import { Terrain } from "./terrain.ts";
import { TIMEKEEPING, World } from "./world.ts";

const SEEDS = [1, 2, 3, 12345, 99991];

/** Runs a world for `days` in-world days in one-second updates. */
function live(world: World, days: number): void {
  for (let s = 0; s < days * TIMEKEEPING.secondsPerDay; s++) {
    world.update(1);
  }
}

describe("plan", () => {
  for (const seed of SEEDS) {
    const terrain = new Terrain(seed);
    const plan = generatePlan(seed, terrain);

    it(`lays out a town for seed ${seed}`, () => {
      const kinds = new Set(plan.lots.map((l) => l.kind));
      for (const k of [
        "church",
        "tavern",
        "townhall",
        "lumberyard",
        "quarry",
        "watchtower",
        "well",
      ] as const) {
        expect(kinds.has(k)).toBe(true);
      }
      expect(plan.lots.filter((l) => l.kind === "plot").length).toBeGreaterThan(25);
      expect(plan.fields.length).toBeGreaterThan(8);
      expect(plan.wall.gates.length).toBeGreaterThanOrEqual(3);
    });

    it(`keeps lots, fields and pastures apart and off the water for seed ${seed}`, () => {
      const rects = [
        ...plan.lots.map((l) => l.rect),
        ...plan.fields.map((f) => f.rect),
        ...plan.pastures.map((p) => p.rect),
      ];
      for (let i = 0; i < rects.length; i++) {
        // Dry all over, not only in the middle.
        for (let u = 0; u <= 8; u++) {
          for (let v = 0; v <= 8; v++) {
            const q = rectPoint(
              rects[i],
              (u / 8 - 0.5) * rects[i].width,
              (v / 8 - 0.5) * rects[i].depth,
            );
            expect(terrain.isWater(q.x, q.y)).toBe(false);
          }
        }
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          // Wells stand on the square among other things; everything else keeps to itself.
          if (a.width < 3 || b.width < 3) {
            continue;
          }
          expect(rectsOverlap(a, b, -0.05)).toBe(false);
        }
      }
    });

    it(`fences each pasture all round but for its gate for seed ${seed}`, () => {
      for (const q of plan.pastures) {
        const run = fenceRun(plan, q);
        const perimeter = 2 * (q.rect.width + q.rect.depth);
        expect(run.length).toBeCloseTo(perimeter - 3, 6);
        // The run starts and ends at the gate posts, the gap between them on the pasture's edge.
        expect(run.points[0]).toEqual(run.gate[1]);
        expect(run.points[run.points.length - 1]).toEqual(run.gate[0]);
        expect(
          Math.hypot(run.gate[0].x - run.gate[1].x, run.gate[0].y - run.gate[1].y),
        ).toBeCloseTo(3, 6);
        const end = alongFence(run, run.length);
        expect(end.x).toBeCloseTo(run.gate[0].x, 6);
        expect(end.y).toBeCloseTo(run.gate[0].y, 6);
      }
    });

    it(`joins every lot and field to the roads out of the valley for seed ${seed}`, () => {
      const seen = new Set<number>([plan.exits[0]]);
      const queue = [plan.exits[0]];
      while (queue.length > 0) {
        const n = queue.pop() as number;
        for (const e of plan.adjacency[n]) {
          const edge = plan.edges[e];
          const o = edge.a === n ? edge.b : edge.a;
          if (!seen.has(o)) {
            seen.add(o);
            queue.push(o);
          }
        }
      }
      for (const lot of plan.lots) {
        expect(seen.has(lot.node)).toBe(true);
      }
      for (const f of plan.fields) {
        expect(seen.has(f.node)).toBe(true);
      }
    });
  }
});

describe("settlement", () => {
  it("grows from a camp into a village", () => {
    const world = World.create({ seed: 1 });
    expect(world.people.length).toBeGreaterThanOrEqual(4);
    live(world, 12);
    expect(world.people.length).toBeGreaterThan(15);
    const houses = world.town.buildings.filter(
      (b) => b.phase === "standing" && KINDS[b.kind].housing > 0 && b.kind !== "camp",
    );
    expect(houses.length).toBeGreaterThanOrEqual(3);
  });

  it("goes the same way every time from the same seed", () => {
    const a = World.create({ seed: 7 });
    const b = World.create({ seed: 7 });
    live(a, 3);
    live(b, 3);
    expect(a.people.map((p) => [p.x, p.y])).toEqual(b.people.map((p) => [p.x, p.y]));
    expect(a.town.buildings.map((q) => [q.kind, q.phase, q.progress])).toEqual(
      b.town.buildings.map((q) => [q.kind, q.phase, q.progress]),
    );
  });

  for (const seed of [1, 2, 3, 4]) {
    it(`keeps everyone out of the river except at the ford for seed ${seed}`, () => {
      const world = World.create({ seed });
      const ford = world.plan.crossing;
      // Long enough for families to live on both banks and children to play across the town.
      for (let s = 0; s < 30 * TIMEKEEPING.secondsPerDay; s++) {
        world.update(1);
        if (s % 5 !== 0) {
          continue;
        }
        for (const p of world.people) {
          if (world.terrain.isWater(p.x, p.y)) {
            expect(Math.hypot(p.x - ford.point.x, p.y - ford.point.y)).toBeLessThan(14);
          }
        }
      }
    });
  }

  it("sees raiders off and rings the all-clear", () => {
    const world = World.create({ seed: 2 });
    live(world, 8);
    world.raids.start(world, "band");
    for (let s = 0; s < 400 && world.raids.active; s++) {
      world.update(1);
    }
    expect(world.raids.active).toBeNull();
    expect(world.monsters.length).toBe(0);
  });

  it("keeps everyone but the defenders and those running from them away from raiders", () => {
    const world = World.create({ seed: 2 });
    live(world, 8);
    world.attention = { ...world.plan.center };
    world.raids.start(world, "band");
    let near = 0;
    let fought = 0;
    for (let s = 0; s < 800 && world.raids.active; s++) {
      world.update(0.5);
      for (const p of world.people) {
        if (p.inside >= 0) {
          continue;
        }
        const close = world.monsters.some(
          (m) => m.state !== "flee" && m.state !== "lurk" && Math.hypot(m.x - p.x, m.y - p.y) < 5,
        );
        if (close && world.raids.defenders.has(p.id)) {
          fought++;
        } else if (close && p.task?.kind !== "flee") {
          near++;
        }
      }
    }
    expect(fought).toBeGreaterThan(0);
    expect(near).toBe(0);
  });

  it("runs from a raider that turns up close by", () => {
    const world = World.create({ seed: 2 });
    live(world, 8);
    // Someone out and about who is not called out to fight.
    const about = (q: (typeof world.people)[number]) =>
      q.inside < 0 && !q.militia && q.task?.kind !== "sleep";
    while (!world.people.some(about)) {
      world.update(1);
    }
    const p = world.people.find(about)!;
    world.raids.start(world, "wolves");
    const m = world.monsters[0];
    const dx = world.terrain.isWater(p.x + 6, p.y) ? -6 : 6;
    m.x = p.x + dx;
    m.y = p.y;
    m.state = "charge";
    world.update(0.5);
    expect(p.task?.kind).toBe("flee");
    for (let s = 0; s < 8; s++) {
      world.update(0.5);
    }
    expect(p.inside >= 0 || Math.hypot(p.x - m.x, p.y - m.y) > 6).toBe(true);
  });

  it("raises the ring round the town a few pieces at a time", () => {
    const world = World.create({ seed: 2 });
    const ring = new Set(["wall", "gate", "tower"]);
    let most = 0;
    let closed = false;
    for (let s = 0; s < 52 * TIMEKEEPING.secondsPerDay && !closed; s++) {
      world.update(1);
      if (s % 10 === 0) {
        const going = world.town.buildings.filter(
          (b) =>
            ring.has(b.site.type) &&
            (b.phase === "clearing" || b.phase === "building" || b.phase === "demolish"),
        ).length;
        most = Math.max(most, going);
        // The stone wall is only begun round a closed palisade, and begins as soon as it closes.
        closed =
          world.council.walled(world, "palisade") ||
          world.town.buildings.some((b) => b.kind === "wall" || b.kind === "gatehouse");
      }
    }
    expect(closed).toBe(true);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(RING_AT_ONCE);
  });

  it("brings the dragon in and sends it off again", () => {
    const world = World.create({ seed: 4 });
    live(world, 6);
    world.raids.start(world, "dragon");
    expect(world.dragon).not.toBeNull();
    for (let s = 0; s < 600 && world.dragon; s++) {
      world.update(1);
    }
    expect(world.dragon).toBeNull();
  });

  it("gives up a raid that gets nowhere", () => {
    const world = World.create({ seed: 2 });
    live(world, 8);
    world.raids.start(world, "thieves");
    // Raiders that no one can beat still go in the end.
    for (const m of world.monsters) {
      m.spirit = 1e9;
    }
    for (let s = 0; s < 200 && world.raids.active; s++) {
      world.update(1);
    }
    expect(world.raids.active).toBeNull();
  });

  it("has everyone up and about by midday", () => {
    const world = World.create({ seed: 3 });
    live(world, 9);
    // On to noon.
    while (Math.abs(world.env.clock.hour - 12) > 0.05) {
      world.update(1);
    }
    const abed = world.people.filter(
      (p) => p.task?.kind === "sleep" && p.task.steps[p.task.i]?.t === "stay",
    );
    expect(abed.length).toBe(0);
  });

  it("drops a cartload at a site and keeps the rest on the cart", () => {
    const world = World.create({ seed: 1 });
    const plot = world.plan.lots.find(
      (l) =>
        l.kind === "plot" &&
        !world.town.buildings.some((b) => b.site.type === "lot" && b.site.lot === l.id),
    );
    const site = world.found("house", { type: "lot", lot: plot!.id }, 0, "building");
    const carter = world.people.find((p) => p.age >= GROWN);
    const ox = newAnimal(world, "ox", carter!.x, carter!.y, { type: "person", id: carter!.id });
    ox.load = 6;
    ox.cargo = "logs";
    const before = site!.wood;
    expect(world.apply(carter!, { kind: "unloadCart", building: site!.id, count: 2 })).toBe(true);
    expect(site!.wood).toBe(before + 2);
    expect(ox.load).toBe(4);
    // At the yard the rest goes onto the stock.
    const stock = world.stock.wood;
    expect(world.apply(carter!, { kind: "unloadCart", building: -1 })).toBe(true);
    expect(ox.load).toBe(0);
    expect(world.stock.wood).toBe(stock + 4);
  });

  it("keeps its tally of who is at what true as tasks begin and end", () => {
    const world = World.create({ seed: 4 });
    live(world, 6);
    const counted = new Map<string, number>();
    for (const p of world.people) {
      if (p.task) {
        counted.set(p.task.kind, (counted.get(p.task.kind) ?? 0) + 1);
      }
    }
    expect(new Map([...world.council.tally].filter(([, n]) => n > 0))).toEqual(counted);
  });

  it("finds the same nearest way onto the streets as a search of every node", () => {
    const world = World.create({ seed: 5 });
    const nodes = world.plan.nodes;
    const r = new Rng(9);
    for (let k = 0; k < 300; k++) {
      const x = r.range(-100, 120);
      const y = r.range(-50, 200);
      const region = world.nav.region(x, y);
      let best = -1;
      let bestD = Infinity;
      nodes.forEach((n, i) => {
        const d = (n.x - x) ** 2 + (n.y - y) ** 2;
        if (world.nav.region(n.x, n.y) === region && d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const found = world.nav.nearestNode(x, y);
      if (best >= 0) {
        expect((nodes[found].x - x) ** 2 + (nodes[found].y - y) ** 2).toBeCloseTo(bestD, 6);
      }
    }
  });

  it("sends a raid where the town is being watched", () => {
    const world = World.create({ seed: 2 });
    live(world, 10);
    const houses = world.town.buildings.filter(
      (b) => b.phase === "standing" && KINDS[b.kind].housing > 0,
    );
    const watched = houses[houses.length - 1];
    world.attention = { x: watched.rect.x, y: watched.rect.y };
    world.raids.start(world, "band");
    const toward = world.raids.active!.toward;
    const nearest = Math.min(
      ...houses.map(
        (b) => Math.hypot(b.rect.x - watched.rect.x, b.rect.y - watched.rect.y) || Infinity,
      ),
    );
    expect(Math.hypot(toward.x - watched.rect.x, toward.y - watched.rect.y)).toBeLessThan(
      Math.max(40, nearest * 3),
    );
  });

  it("brings its children up to work", () => {
    const world = World.create({ seed: 5 });
    const child = world.people.find((p) => p.age < GROWN);
    expect(child).toBeDefined();
  });
});

describe("record", () => {
  it("packs tree states into runs and back", () => {
    const values = new Uint8Array([2, 2, 2, 1, 0, 0, 2, 2]);
    expect(unrun(runs(values), values.length)).toEqual(values);
    expect(unrun(runs(values), values.length + 1)).toBeNull();
  });

  it("comes back as it was left", () => {
    const world = World.create({ seed: 11 });
    live(world, 6);
    const text = encodeRecord(world.snapshot());
    const record = decodeRecord(text);
    expect(record).not.toBeNull();
    const back = World.restore(record!);
    expect(back).not.toBeNull();
    expect(back!.people.length).toBe(world.people.length);
    expect(back!.town.buildings.map((b) => [b.id, b.kind, b.phase])).toEqual(
      world.town.buildings.map((b) => [b.id, b.kind, b.phase]),
    );
    expect(Array.from(back!.forest.state)).toEqual(Array.from(world.forest.state));
    expect(back!.env.clock.days).toBeCloseTo(world.env.clock.days, 9);
    // And it goes on from there.
    live(back!, 1);
    expect(back!.people.length).toBeGreaterThan(0);
  });

  it("refuses a record from another version or a broken one", () => {
    expect(decodeRecord("{}")).toBeNull();
    expect(decodeRecord("not json")).toBeNull();
    const world = World.create({ seed: 12 });
    const record = world.snapshot();
    const broken = JSON.parse(encodeRecord(record));
    broken.record.people[0].x = "nowhere";
    expect(decodeRecord(JSON.stringify(broken))).toBeNull();
  });

  it("refuses a record with things far outside the world", () => {
    const world = World.create({ seed: 12 });
    live(world, 1);
    const good = JSON.parse(encodeRecord(world.snapshot()));
    expect(decodeRecord(JSON.stringify(good))).not.toBeNull();
    const far = structuredClone(good);
    far.record.people[0].x = 1e9;
    expect(decodeRecord(JSON.stringify(far))).toBeNull();
    const huge = structuredClone(good);
    huge.record.town.buildings[0].rect.width = 1e6;
    expect(decodeRecord(JSON.stringify(huge))).toBeNull();
  });

  it("carries on numbering from where the saved settlement left off", () => {
    const world = World.create({ seed: 12 });
    live(world, 2);
    const back = World.restore(decodeRecord(encodeRecord(world.snapshot()))!)!;
    const again = World.restore(decodeRecord(encodeRecord(back.snapshot()))!)!;
    expect(again.nextId).toBe(world.nextId);
  });
});
