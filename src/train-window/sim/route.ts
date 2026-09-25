import { smoothstep } from "../core/math.ts";
import { fbm1, Rng } from "../core/random.ts";

export type SectionKind = "countryside" | "town" | "city" | "mountain" | "coast" | "river";

export const SECTION_KINDS: readonly SectionKind[] = [
  "countryside",
  "town",
  "city",
  "mountain",
  "coast",
  "river",
];

/** Continuous properties of the landscape; blended across section boundaries. */
export interface Terrain {
  /** Density of detached houses. */
  houses: number;
  /** Density of apartment blocks and shops. */
  apartments: number;
  /** Density of the distant high-rise skyline. */
  skyline: number;
  /** Fraction of open land used as rice paddies and fields. */
  fields: number;
  /** Density of broadleaf and cedar trees. */
  forest: number;
  /** Density of coastal pines. */
  pines: number;
  /** Height (m) of the hills a few hundred meters away. */
  hills: number;
  /** Height (m) of the distant mountain ranges. */
  mountains: number;
  /** 1 = along the sea. */
  coast: number;
  /** Lateral distance (m) from the track to the waterline where `coast` = 1. */
  shoreDistance: number;
  /** 1 = a road runs parallel to the track. */
  road: number;
  /** Lateral distance (m) of that road where `road` = 1. */
  roadDistance: number;
  /** Height (m) of the rails above the surrounding ground. */
  elevation: number;
  /** Noise barrier height (m) beside the track. */
  barrier: number;
  /** Cruising speed (m/s). */
  cruise: number;
  /** Artificial sky glow that hides faint stars. */
  lightPollution: number;
  /** 1 = a second track runs beside ours. */
  doubleTrack: number;
  /** 1 = jointed rails (the classic clickety-clack); 0 = continuous welded rail. */
  jointed: number;
  /**
   * Direction the window faces, as an azimuth from south (radians, west
   * positive). The line curves between sections, turning the sky with it.
   */
  heading: number;
}

const TERRAIN_KEYS = [
  "houses",
  "apartments",
  "skyline",
  "fields",
  "forest",
  "pines",
  "hills",
  "mountains",
  "coast",
  "shoreDistance",
  "road",
  "roadDistance",
  "elevation",
  "barrier",
  "cruise",
  "lightPollution",
  "doubleTrack",
  "jointed",
  "heading",
] as const satisfies readonly (keyof Terrain)[];

export interface Span {
  start: number;
  end: number;
}

export interface Bridge extends Span {
  /** Truss bridges span wide rivers; girder bridges cross creeks. */
  kind: "truss" | "girder";
  /** Water surface span. */
  water: Span;
  /** Depth (m) of the water surface below the surrounding ground. */
  depth: number;
}

export interface Station extends Span {
  /** Where the train stops (our window position). */
  stop: number;
  /** Station building and plaza lights; bigger in towns. */
  size: number;
  seed: number;
}

export interface Crossing {
  at: number;
  /** A car waits at the barrier. */
  waitingCar: boolean;
  seed: number;
}

export interface Section extends Span {
  index: number;
  kind: SectionKind;
  seed: number;
  terrain: Terrain;
  tunnels: Span[];
  bridges: Bridge[];
  station: Station | null;
  crossings: Crossing[];
}

/**
 * A section to regenerate the line from. The sections after it depend only on
 * it and the seed, so a line rebuilt from its oldest kept section is identical.
 */
export interface RouteAnchor {
  index: number;
  kind: SectionKind;
  start: number;
  /** Kind every section is forced to (development aid). */
  forced: SectionKind | null;
}

/** Half-length (m) of the transition between neighbouring sections. */
export const TRANSITION = 280;
/** Rail elevation (m) on bridges. */
const BRIDGE_ELEVATION = 7;
/** Length (m) of the embankment ramp up to a bridge. */
const RAMP = 260;
export const STATION_LENGTH = 180;
export const RAIL_LENGTH = 25;

const NEXT: Record<SectionKind, Partial<Record<SectionKind, number>>> = {
  countryside: { town: 3, mountain: 2.5, coast: 1.6, river: 1.8, countryside: 0.8 },
  town: { countryside: 3, city: 1.5, coast: 1, river: 1.2 },
  city: { town: 3, river: 1.2 },
  mountain: { countryside: 2, coast: 2, river: 1.3, mountain: 0.8 },
  coast: { countryside: 2, town: 1.6, mountain: 2, coast: 0.4 },
  river: { countryside: 3, town: 2, mountain: 1, city: 0.6 },
};

const LENGTH: Record<SectionKind, readonly [number, number]> = {
  countryside: [2400, 4200],
  town: [1600, 2600],
  city: [2000, 3200],
  mountain: [2800, 4800],
  coast: [2800, 4800],
  river: [900, 1400],
};

function makeTerrain(kind: SectionKind, r: Rng): Terrain {
  const base: Terrain = {
    houses: 0,
    apartments: 0,
    skyline: 0,
    fields: 0,
    forest: 0,
    pines: 0,
    hills: 0,
    mountains: 0,
    coast: 0,
    shoreDistance: 80,
    road: 0,
    roadDistance: 30,
    elevation: 1,
    barrier: 0,
    cruise: 24,
    lightPollution: 0.1,
    doubleTrack: 0,
    jointed: 1,
    heading: r.range(-1.15, 1.15),
  };
  switch (kind) {
    case "countryside":
      return {
        ...base,
        houses: r.range(0.08, 0.2),
        fields: r.range(0.75, 0.95),
        forest: r.range(0.15, 0.35),
        hills: r.range(15, 60),
        mountains: r.range(450, 1100),
        road: r.chance(0.55) ? 1 : 0,
        roadDistance: r.range(28, 60),
        elevation: r.range(0.8, 2),
        cruise: 26,
        lightPollution: 0.12,
        doubleTrack: r.chance(0.5) ? 1 : 0,
      };
    case "town":
      return {
        ...base,
        houses: r.range(0.6, 0.85),
        apartments: r.range(0.12, 0.3),
        skyline: r.range(0, 0.15),
        fields: r.range(0.1, 0.25),
        forest: 0.1,
        hills: r.range(0, 30),
        mountains: r.range(300, 800),
        road: 1,
        // Far enough back that a row of houses fits between the line and the road.
        roadDistance: r.range(20, 32),
        elevation: r.range(0.6, 1.2),
        cruise: 20,
        lightPollution: 0.5,
        doubleTrack: 1,
      };
    case "city":
      return {
        ...base,
        houses: 0.3,
        apartments: r.range(0.75, 0.95),
        skyline: 1,
        forest: 0.05,
        mountains: r.range(200, 500),
        road: 1,
        roadDistance: r.range(18, 24),
        elevation: 9,
        barrier: 1.4,
        cruise: 22,
        lightPollution: 0.9,
        doubleTrack: 1,
        jointed: 0,
      };
    case "mountain":
      return {
        ...base,
        houses: r.range(0.01, 0.05),
        fields: r.range(0.05, 0.15),
        forest: r.range(0.85, 1),
        hills: r.range(130, 260),
        mountains: r.range(1000, 1700),
        road: r.chance(0.4) ? 1 : 0,
        roadDistance: r.range(22, 40),
        elevation: r.range(1.5, 3),
        cruise: 18,
        lightPollution: 0.02,
      };
    case "coast": {
      // Right along the water, on a raised seawall or behind a narrow beach.
      const shore = r.range(9, 32);
      return {
        ...base,
        houses: r.range(0.03, 0.1),
        fields: 0.1,
        forest: 0.1,
        pines: shore > 20 ? r.range(0.3, 0.8) : 0.1,
        coast: 1,
        shoreDistance: shore,
        road: 0,
        elevation: r.range(3, 6),
        cruise: 22,
        lightPollution: 0.04,
      };
    }
    case "river":
      return {
        ...base,
        houses: r.range(0.05, 0.15),
        fields: r.range(0.4, 0.7),
        forest: 0.2,
        hills: r.range(0, 25),
        mountains: r.range(400, 900),
        elevation: 1.5,
        cruise: 22,
        lightPollution: 0.1,
        doubleTrack: r.chance(0.5) ? 1 : 0,
      };
  }
}

function overlaps(spans: readonly Span[], start: number, end: number, margin: number): boolean {
  return spans.some((s) => start < s.end + margin && end > s.start - margin);
}

function buildSection(index: number, kind: SectionKind, start: number, seed: number): Section {
  const r = new Rng(seed);
  const [minLen, maxLen] = LENGTH[kind];
  const length = r.range(minLen, maxLen);
  const end = start + length;
  const terrain = makeTerrain(kind, r);
  const tunnels: Span[] = [];
  const bridges: Bridge[] = [];
  const crossings: Crossing[] = [];
  let station: Station | null = null;
  const inner0 = start + TRANSITION + 200;
  const inner1 = end - TRANSITION - 200;

  if (kind === "river") {
    const len = r.range(280, 520);
    const mid = (start + end) / 2 + r.range(-80, 80);
    const b0 = mid - len / 2;
    bridges.push({
      kind: "truss",
      start: b0,
      end: b0 + len,
      water: { start: b0 + 20, end: b0 + len - 20 },
      depth: 4,
    });
  }
  if (kind === "mountain" || kind === "coast") {
    const count = kind === "mountain" ? r.int(1, 3) : r.int(0, 1);
    for (let i = 0; i < count; i++) {
      const len = kind === "mountain" ? r.range(250, 1400) : r.range(150, 420);
      const s = r.range(inner0 + 300, inner1 - len - 300);
      if (s > inner0 && !overlaps(tunnels, s, s + len, 900)) {
        tunnels.push({ start: s, end: s + len });
      }
    }
    if (kind === "mountain" && r.chance(0.5)) {
      const len = r.range(60, 140);
      const s = r.range(inner0, inner1 - len);
      if (!overlaps(tunnels, s, s + len, RAMP + 100)) {
        bridges.push({
          kind: "truss",
          start: s,
          end: s + len,
          water: { start: s + 14, end: s + len - 14 },
          depth: 9,
        });
      }
    }
  }
  if (kind === "countryside") {
    for (let i = r.int(0, 2); i > 0; i--) {
      const len = r.range(18, 36);
      const s = r.range(inner0, inner1 - len);
      if (!overlaps(bridges, s, s + len, 600)) {
        bridges.push({
          kind: "girder",
          start: s,
          end: s + len,
          water: { start: s + 4, end: s + len - 4 },
          depth: 2.5,
        });
      }
    }
  }

  const stationChance: Record<SectionKind, number> = {
    countryside: 0.45,
    town: 0.75,
    city: 0.85,
    mountain: 0.25,
    coast: 0.45,
    river: 0,
  };
  if (r.chance(stationChance[kind])) {
    const s = r.range(inner0, inner1 - STATION_LENGTH);
    if (
      !overlaps(tunnels, s, s + STATION_LENGTH, 500) &&
      !overlaps(bridges, s, s + STATION_LENGTH, RAMP + 150)
    ) {
      station = {
        start: s,
        end: s + STATION_LENGTH,
        stop: s + STATION_LENGTH * r.range(0.4, 0.6),
        size: kind === "city" ? 1 : kind === "town" ? 0.7 : 0.25,
        seed: r.int(0, 1 << 30),
      };
    }
  }

  if (kind === "countryside" || kind === "town") {
    const count = kind === "town" ? r.int(1, 3) : r.int(0, 2);
    const blocked: Span[] = [...tunnels, ...bridges, ...(station ? [station] : [])];
    for (let i = 0; i < count; i++) {
      const at = r.range(inner0, inner1);
      if (
        !overlaps(blocked, at, at, RAMP + 60) &&
        !crossings.some((c) => Math.abs(c.at - at) < 400)
      ) {
        crossings.push({ at, waitingCar: r.chance(0.55), seed: r.int(0, 1 << 30) });
      }
    }
    crossings.sort((a, b) => a.at - b.at);
  }

  return { index, kind, start, end, seed, terrain, tunnels, bridges, station, crossings };
}

/** Offsets of the sections searched around a position: its own, then the next, then the previous. */
const NEAR = [0, 1, -1] as const;

/**
 * The endless line. Sections are generated lazily from a seed so any stretch of
 * track is reproducible; queries are pure functions of the along-track position.
 */
export class Route {
  private readonly seed: number;
  private readonly sections: Section[] = [];
  private readonly forced: SectionKind | null;

  /** Rebuilds the line from `anchor` onwards; the sections after it follow from the seed. */
  constructor(seed: number, anchor: RouteAnchor) {
    this.seed = seed;
    this.forced = anchor.forced;
    this.sections.push(
      buildSection(anchor.index, anchor.kind, anchor.start, this.sectionSeed(anchor.index)),
    );
  }

  /** A new line starting at 0, with `firstKind` (or a seeded pick) as its first section. */
  static create(
    seed: number,
    firstKind: SectionKind | null = null,
    forced: SectionKind | null = null,
  ): Route {
    const kind =
      forced ??
      firstKind ??
      new Rng(seed).pick<SectionKind>(["countryside", "town", "mountain", "coast"]);
    return new Route(seed, { index: 0, kind, start: 0, forced });
  }

  /** Where this line can be rebuilt from: its oldest kept section. */
  get anchor(): RouteAnchor {
    const { index, kind, start } = this.sections[0];
    return { index, kind, start, forced: this.forced };
  }

  private sectionSeed(index: number): number {
    return (Math.imul(index + 1, 0x9e3779b1) ^ this.seed) >>> 0;
  }

  /** Makes sure sections exist up to `along` and drops those far behind `keepFrom`. */
  ensure(along: number, keepFrom: number): void {
    let last = this.sections[this.sections.length - 1];
    while (last.end < along) {
      const index = last.index + 1;
      const seed = this.sectionSeed(index);
      const kind = this.forced ?? new Rng(seed ^ 0x5eed).weighted(NEXT[last.kind]);
      last = buildSection(index, kind, last.end, seed);
      this.sections.push(last);
    }
    while (this.sections.length > 2 && this.sections[1].end < keepFrom) {
      this.sections.shift();
    }
  }

  get first(): Section {
    return this.sections[0];
  }

  /** The section containing `along`; positions outside the generated range clamp to the ends. */
  sectionAt(along: number): Section {
    const s = this.sections;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].start <= along) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return s[lo];
  }

  /** Sections overlapping [a, b]. */
  sectionsIn(a: number, b: number): Section[] {
    return this.sections.filter((s) => s.end > a && s.start < b);
  }

  /**
   * Terrain box-filtered over [along - width, along + width]. Wide windows are
   * used for distant layers so faraway ranges change gradually.
   */
  terrain(along: number, out: Terrain, width = TRANSITION): Terrain {
    const a = along - width;
    const b = along + width;
    for (const k of TERRAIN_KEYS) {
      out[k] = 0;
    }
    const s = this.sections;
    let total = 0;
    let i = this.indexAt(a);
    for (; i < s.length; i++) {
      const sec = s[i];
      const start = i === 0 ? -Infinity : sec.start;
      const end = i === s.length - 1 ? Infinity : sec.end;
      if (start >= b) {
        break;
      }
      const w = Math.min(end, b) - Math.max(start, a);
      if (w <= 0) {
        continue;
      }
      total += w;
      const t = sec.terrain;
      for (const k of TERRAIN_KEYS) {
        out[k] += t[k] * w;
      }
    }
    for (const k of TERRAIN_KEYS) {
      out[k] /= total;
    }
    // The blend of distances is weighted by presence so the distance itself stays meaningful.
    out.shoreDistance = this.weightedDistance(a, b, "coast", "shoreDistance");
    out.roadDistance = this.weightedDistance(a, b, "road", "roadDistance");
    return out;
  }

  private weightedDistance(
    a: number,
    b: number,
    weightKey: "coast" | "road",
    distKey: "shoreDistance" | "roadDistance",
  ): number {
    let sum = 0;
    let weight = 0;
    const s = this.sections;
    for (let i = this.indexAt(a); i < s.length; i++) {
      const sec = s[i];
      const start = i === 0 ? -Infinity : sec.start;
      const end = i === s.length - 1 ? Infinity : sec.end;
      if (start >= b) {
        break;
      }
      const w = (Math.min(end, b) - Math.max(start, a)) * sec.terrain[weightKey];
      if (w > 0) {
        sum += sec.terrain[distKey] * w;
        weight += w;
      }
    }
    return weight > 0 ? sum / weight : 100;
  }

  private indexAt(along: number): number {
    const s = this.sections;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].start <= along) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  /**
   * Lateral distance (m) of the waterline, or Infinity inland. As the coast
   * weight fades the shore recedes toward the horizon instead of vanishing.
   */
  shoreAt(terrain: Terrain, along: number): number {
    const c = terrain.coast;
    if (c < 0.004) {
      return Infinity;
    }
    const wiggle = (fbm1(along / 140, this.seed ^ 0x5407e, 3) - 0.5) * 36;
    return (terrain.shoreDistance + wiggle) / (c * c * c);
  }

  /** Lateral distance (m) of the parallel road, or Infinity without a road. */
  roadAt(terrain: Terrain, along: number): number {
    const r = terrain.road;
    if (r < 0.02) {
      return Infinity;
    }
    const wiggle = (fbm1(along / 400, this.seed ^ 0x40ad, 2) - 0.5) * 10;
    return (terrain.roadDistance + wiggle * r) / (r * r);
  }

  tunnelAt(along: number): Span | null {
    const i = this.indexAt(along);
    for (let n = 0; n < NEAR.length; n++) {
      const sec = this.sections[i + NEAR[n]];
      if (!sec) {
        continue;
      }
      for (const t of sec.tunnels) {
        if (along >= t.start && along < t.end) {
          return t;
        }
      }
    }
    return null;
  }

  bridgeAt(along: number, margin = 0): Bridge | null {
    const i = this.indexAt(along);
    for (let n = 0; n < NEAR.length; n++) {
      const sec = this.sections[i + NEAR[n]];
      if (!sec) {
        continue;
      }
      for (const b of sec.bridges) {
        if (along >= b.start - margin && along < b.end + margin) {
          return b;
        }
      }
    }
    return null;
  }

  stationAt(along: number, margin = 0): Station | null {
    const i = this.indexAt(along);
    for (let n = 0; n < NEAR.length; n++) {
      const st = this.sections[i + NEAR[n]]?.station;
      if (st && along >= st.start - margin && along < st.end + margin) {
        return st;
      }
    }
    return null;
  }

  /** The first station whose stop point lies strictly after `along`. */
  nextStation(along: number): Station | null {
    for (const sec of this.sections) {
      if (sec.station && sec.station.stop > along) {
        return sec.station;
      }
    }
    return null;
  }

  tunnelsIn(a: number, b: number): Span[] {
    return this.sectionsIn(a, b).flatMap((s) => s.tunnels.filter((t) => t.end > a && t.start < b));
  }

  bridgesIn(a: number, b: number): Bridge[] {
    return this.sectionsIn(a, b).flatMap((s) => s.bridges.filter((t) => t.end > a && t.start < b));
  }

  stationsIn(a: number, b: number): Station[] {
    return this.sectionsIn(a, b).flatMap((s) =>
      s.station && s.station.end > a && s.station.start < b ? [s.station] : [],
    );
  }

  crossingsIn(a: number, b: number): Crossing[] {
    return this.sectionsIn(a, b).flatMap((s) => s.crossings.filter((c) => c.at > a && c.at < b));
  }

  /** Height (m) of the rails above the surrounding ground, including bridge embankments. */
  elevationAt(along: number, terrain: Terrain): number {
    let e = terrain.elevation;
    const b = this.bridgeAt(along, RAMP);
    if (b) {
      const ramp = Math.min(
        smoothstep(b.start - RAMP, b.start, along),
        1 - smoothstep(b.end, b.end + RAMP, along),
      );
      const target = b.kind === "truss" ? BRIDGE_ELEVATION : Math.max(e, 2.5);
      e = e + (Math.max(e, target) - e) * ramp;
    }
    return e;
  }
}

export function makeTerrainScratch(): Terrain {
  return {
    houses: 0,
    apartments: 0,
    skyline: 0,
    fields: 0,
    forest: 0,
    pines: 0,
    hills: 0,
    mountains: 0,
    coast: 0,
    shoreDistance: 0,
    road: 0,
    roadDistance: 0,
    elevation: 0,
    barrier: 0,
    cruise: 0,
    lightPollution: 0,
    doubleTrack: 0,
    jointed: 0,
    heading: 0,
  };
}
