import { type Building, type BuildingKind, type Job, KINDS, type Site } from "./buildings.ts";
import { noteCleared, wants } from "./construction.ts";
import { GONE, STANDING } from "./forest.ts";
import { alongPolyline, inPolygon, inRect, polylineDistance, polylineLength } from "./geometry.ts";
import { newAnimal } from "./animals.ts";
import { newHousehold, RATION } from "./life.ts";
import { type Household, isChild, isOld, type Person, roofOf } from "./people.ts";
import type { Point } from "./terrain.ts";
import type { World } from "./world.ts";

/** Real seconds between the council's looks at how the settlement stands. */
const THINK = 2;
/** Real seconds between reshuffles of who does what. */
const JOBS_EVERY = 12;
/** Least in-world days between one family's arrival and the next. */
const ARRIVAL_GAP = 0.22;
/** How far (m) from the square newcomers are when they come into sight up the road. */
const ARRIVAL_REACH = 105;
/** Food (days of it for everyone) the settlement wants in store before it takes in newcomers. */
const FOOD_MARGIN = 1.5;
/** People a field feeds. */
const FEEDS = 8;
/** Food (per person a day) traders bring to a market town, and a mill's gain on the harvest. */
const TRADE = 0.25;
/** Most who go out against a band of raiders. */
const MOST_DEFENDERS = 12;
/** Meters from a raider within which a place is no place to be. */
export const DANGER = 12;

/** Whether a raider (not yet running) is within `DANGER` of (x, y). */
export function dangerAt(world: World, x: number, y: number): boolean {
  for (const m of world.monsters) {
    if (
      m.state !== "flee" &&
      Math.abs(m.x - x) < DANGER &&
      Math.abs(m.y - y) < DANGER &&
      Math.hypot(m.x - x, m.y - y) < DANGER
    ) {
      return true;
    }
  }
  return false;
}

/** Most buildings taken down and put up again anew at once. */
const RENEWING = 2;
/** Most ox carts the town keeps. */
const MOST_CARTS = 8;
/** Most pieces of the ring of wall going up at once. */
export const RING_AT_ONCE = 5;
/** Sheep and cows a pasture holds before another is fenced. */
const FLOCK_PER_PASTURE = 12;

/** The paving of a street under way: how many meters of it are done. */
export interface Paving {
  street: number;
  done: number;
  length: number;
  /** Meters done when the ground was last redrawn. */
  shown: number;
}

/**
 * The settlement's decisions: what to build next and where, who does what,
 * when to take in newcomers, which fields and streets to open, and what to
 * do after a raid. It looks every couple of seconds.
 */
export class Council {
  /** How far the settlement has come: 0 a hamlet, 1 a village, 2 a town. */
  era = 0;
  /** How many are at each task (by task kind), kept as tasks begin and end. */
  readonly tally = new Map<string, number>();
  /** How many are on their way to take from each pile. */
  readonly claims = new Map<number, number>();
  /** Fields the settlement works or is clearing. */
  readonly openFields = new Set<number>();
  /** Streets being opened: their trees felled before they are trodden. */
  readonly opening = new Set<number>();
  /** Standing wells, by building id. */
  wells: number[] = [];
  /** Whether traders come on market days, and the day (whole in-world days) they last came. */
  market = false;
  marketDay = -1;
  paving: Paving | null = null;
  /** Seconds of quarrying toward the next block, and of fencing toward the pasture. */
  quarried = 0;
  fencing = 0;
  /** In-world day the next newcomers may come. */
  nextArrival = 0;
  /** Raids seen: they make the settlement fortify. */
  threat = 0;
  /** Seconds till the next look, and the next reshuffle of jobs. */
  private think = 0;
  private jobsIn = 0;
  /** Trees wanted cleared, worked out at each look. */
  private clearing: number[] = [];
  /** Trees at the edge of the woods to cut for the stock. */
  private logging: number[] = [];
  private loggingAt = -1;
  /** The church (or chapel) and tavern as of the last look. */
  private churchHere: Building | null = null;
  private tavernHere: Building | null = null;
  /** The trees in the way of each street and each field (see `inWay`). */
  private readonly streetWay = new Map<number, number[]>();
  private readonly fieldWay = new Map<number, number[]>();

  /** The settlers' first plans: their first cabin and field. */
  begin(world: World): void {
    this.nextArrival = world.founded + 0.9;
    this.update(world, THINK, 0);
  }

  update(world: World, dt: number, days: number): void {
    // What is eaten, and what the hens, the flock and the cows give.
    let herd = 0;
    for (const a of world.animals) {
      herd += a.kind === "cow" ? 0.7 : a.kind === "sheep" ? 0.35 : a.kind === "chicken" ? 0.18 : 0;
    }
    // Traders come up the old road with grain, more once there is a market.
    const trade =
      world.people.length * (this.market ? TRADE : world.people.length >= 18 ? TRADE * 0.5 : 0);
    world.stock.food = Math.max(
      0,
      world.stock.food + (herd + trade - world.people.length * RATION) * days,
    );
    this.think -= dt;
    this.jobsIn -= dt;
    if (this.think > 0) {
      return;
    }
    this.think = THINK;
    this.era = this.eraNow(world);
    this.wells = world.town.buildings
      .filter((b) => b.kind === "well" && b.phase === "standing")
      .map((b) => b.id);
    this.market = world.people.length >= 35 && this.era >= 1;
    this.churchHere =
      world.town.buildings.find((b) => b.kind === "church" && b.phase === "standing") ??
      world.town.buildings.find((b) => b.kind === "chapel" && b.phase === "standing") ??
      null;
    this.tavernHere = this.place(world, "tavern");
    noteCleared(world);
    this.openStreets(world);
    this.planFields(world);
    this.clearing = this.gatherClearing(world);
    this.plan(world);
    this.pave(world);
    this.arrivals(world);
    if (this.jobsIn <= 0) {
      this.jobsIn = JOBS_EVERY;
      this.assignJobs(world);
    }
  }

  private eraNow(world: World): number {
    const pop = world.people.length;
    const has = (k: BuildingKind) =>
      world.town.buildings.some((b) => b.kind === k && b.phase === "standing");
    if (pop >= 72 && has("tavern") && this.walledInStone(world)) {
      return 2;
    }
    if (pop >= 26 && (has("chapel") || has("church"))) {
      return Math.max(1, this.era);
    }
    return this.era;
  }

  // Building.

  /** How many people the standing homes hold, and how many more those going up will. */
  capacity(world: World): { standing: number; coming: number } {
    let standing = 0;
    let coming = 0;
    for (const b of world.town.buildings) {
      const h = KINDS[b.kind].housing;
      if (h <= 0 || b.kind === "camp" || KINDS[b.kind].jobs.priest || b.kind === "tavern") {
        continue;
      }
      if (b.phase === "standing") {
        standing += h;
      } else if (b.phase !== "ruin") {
        coming += h;
      }
    }
    return { standing, coming };
  }

  /** Starts what the settlement needs most next, as many at once as there are hands for. */
  private plan(world: World): void {
    const town = world.town;
    // The ring of wall round the town counts as one work, however many pieces of it are going up.
    const going = (b: Building) =>
      b.phase === "clearing" || b.phase === "building" || b.phase === "demolish";
    const ring = (b: Building) =>
      b.site.type === "wall" || b.site.type === "gate" || b.site.type === "tower";
    const active =
      town.buildings.filter((b) => going(b) && !ring(b)).length +
      (town.buildings.some((b) => going(b) && ring(b)) ? 1 : 0);
    const hands = world.people.filter((p) => !isChild(p) && !isOld(p)).length;
    const most = Math.max(1, Math.min(7, Math.floor(hands / 5) + 1));
    if (active >= most) {
      return;
    }
    const pop = world.people.length;
    const has = (k: BuildingKind) => town.buildings.some((b) => b.kind === k);
    const standing = (k: BuildingKind) =>
      town.buildings.some((b) => b.kind === k && b.phase === "standing");
    const cap = this.capacity(world);
    const era = this.era;
    // A roof over everyone first, with room for the next family.
    if (cap.standing + cap.coming < pop + 4) {
      if (this.startHouse(world)) {
        return;
      }
    }
    const lotOf = (kind: string) =>
      world.plan.lots.find((l) => l.kind === kind && !this.lotTaken(world, l.id));
    const onLot = (kind: BuildingKind, lotKind: string): boolean => {
      const lot = lotOf(lotKind);
      if (!lot) {
        return false;
      }
      world.found(kind, { type: "lot", lot: lot.id }, era);
      return true;
    };
    const houses = town.buildings.filter(
      (b) => KINDS[b.kind].housing > 0 && b.kind !== "camp" && b.phase === "standing",
    ).length;
    // The list of what a growing settlement raises, in the order it wants it.
    const wishes: [boolean, () => boolean][] = [
      [houses >= 1 && !has("well"), () => onLot("well", "well")],
      [pop >= 12 && !has("lumberyard"), () => onLot("lumberyard", "lumberyard")],
      [this.openFields.size >= 3 && !has("barn"), () => this.onPlot(world, "barn", "outer")],
      [pop >= 22 && !has("chapel") && !has("church"), () => onLot("chapel", "church")],
      [pop >= 26 && !has("smithy"), () => this.onPlot(world, "smithy", "any")],
      [pop >= 28 && !has("bridge") && !has("stonebridge"), () => this.onFord(world, "bridge")],
      [
        ((this.threat >= 1 && pop >= 16) || pop >= 34) && !has("watchtower"),
        () => onLot("watchtower", "watchtower"),
      ],
      [
        ((this.threat >= 1.5 && pop >= 26) || pop >= 36) && !this.ringed(world, "palisade"),
        () => this.fortify(world, "palisade"),
      ],
      [pop >= 32 && !has("quarry"), () => onLot("quarry", "quarry")],
      [pop >= 38 && !has("bakery"), () => this.onPlot(world, "bakery", "inner")],
      [pop >= 42 && !has("tavern"), () => onLot("tavern", "tavern")],
      // Once the palisade is round the town, it goes up again in stone.
      [
        pop >= 46 &&
          standing("quarry") &&
          (this.walled(world, "palisade") || has("wall") || has("gatehouse")) &&
          !this.ringed(world, "wall"),
        () => this.fortify(world, "wall"),
      ],
      [
        pop >= 52 && this.openFields.size >= 5 && !has("watermill"),
        () => onLot("watermill", "watermill"),
      ],
      [
        pop >= 58 && world.town.buildings.filter((b) => b.kind === "well").length < 2,
        () => onLot("well", "well"),
      ],
      [pop >= 62 && !has("workshop"), () => this.onPlot(world, "workshop", "inner")],
      [
        pop >= 66 && world.town.buildings.filter((b) => b.kind === "watchtower").length < 2,
        () => onLot("watchtower", "watchtower"),
      ],
      [pop >= 74 && !has("windmill"), () => onLot("windmill", "windmill")],
      // A town, walled in stone: a hall to meet in, and a church.
      [era >= 2 && !has("townhall"), () => onLot("townhall", "townhall")],
      [
        era >= 2 && standing("chapel") && !has("church"),
        () => this.upgrade(world, "chapel", "church"),
      ],
      [
        era >= 2 && standing("bridge") && standing("quarry"),
        () => this.upgrade(world, "bridge", "stonebridge"),
      ],
      [
        era >= 2 && this.walledInStone(world) && (pop >= 120 || this.threat >= 6) && !has("wizard"),
        () => onLot("wizard", "wizard"),
      ],
      [
        era >= 2 && world.town.buildings.filter((b) => b.kind === "watchtower").length < 3,
        () => onLot("watchtower", "watchtower"),
      ],
      [era >= 1 && cap.standing + cap.coming < pop + 10, () => this.startHouse(world)],
      [era >= 1 && standing("cabin"), () => this.upgrade(world, "cabin", "house")],
      [era >= 2 && standing("house"), () => this.upgradeCore(world)],
      [
        era >= 2,
        () =>
          this.onPlot(world, era >= 2 && world.rng.chance(0.5) ? "townhouse" : "house", "inner"),
      ],
    ];
    for (const [want, start] of wishes) {
      if (want && start()) {
        return;
      }
    }
  }

  /** Whether a lot has anything on it. */
  private lotTaken(world: World, lot: number): boolean {
    return world.town.at({ type: "lot", lot }) !== undefined;
  }

  /**
   * A new home on the best free plot: round the square first, then along the
   * lanes, farmhouses out along the roads. Cabins at first, then timber
   * houses, then town houses.
   */
  private startHouse(world: World): boolean {
    const era = this.era;
    const houses = world.town.buildings.filter(
      (b) => KINDS[b.kind].housing > 0 && b.kind !== "camp",
    ).length;
    const zone = houses % 4 === 3 ? "outer" : "town";
    const kind: BuildingKind =
      zone === "outer"
        ? era >= 1
          ? "farmhouse"
          : "cabin"
        : era === 0 && houses < 5
          ? "cabin"
          : era >= 2
            ? "townhouse"
            : "house";
    return (
      this.onPlot(world, kind, zone === "outer" ? "outer" : "inner") ||
      this.onPlot(world, kind, "any")
    );
  }

  /** Starts `kind` on the nearest free house plot of a zone. */
  private onPlot(world: World, kind: BuildingKind, zone: "inner" | "outer" | "any"): boolean {
    const spec = KINDS[kind];
    let best = -1;
    let bestD = Infinity;
    for (const lot of world.plan.lots) {
      if (lot.kind !== "plot" || this.lotTaken(world, lot.id)) {
        continue;
      }
      if (zone === "outer" && lot.zone !== "outer") {
        continue;
      }
      if (zone === "inner" && lot.zone === "outer") {
        continue;
      }
      if (lot.rect.width < spec.width * 0.8 || lot.rect.depth < spec.depth * 0.8) {
        continue;
      }
      const d = lot.distance + (lot.zone === "outer" ? 10 : 0);
      if (d < bestD) {
        bestD = d;
        best = lot.id;
      }
    }
    if (best < 0) {
      return false;
    }
    world.found(kind, { type: "lot", lot: best }, this.era);
    return true;
  }

  private onFord(world: World, kind: BuildingKind): boolean {
    world.found(kind, { type: "ford" }, this.era);
    return true;
  }

  /** The pieces of the ring round the town: its gates, the runs of wall between, and (in stone) towers. */
  private ring(world: World, kind: "palisade" | "wall"): { kind: BuildingKind; site: Site }[] {
    const w = world.plan.wall;
    const pieces: { kind: BuildingKind; site: Site }[] = [];
    const gateKind: BuildingKind = kind === "palisade" ? "woodgate" : "gatehouse";
    w.gates.forEach((_, i) => pieces.push({ kind: gateKind, site: { type: "gate", gate: i } }));
    w.points.forEach((_, i) => pieces.push({ kind, site: { type: "wall", index: i } }));
    if (kind === "wall") {
      for (const t of w.towers) {
        pieces.push({ kind: "tower", site: { type: "tower", index: t } });
      }
    }
    return pieces;
  }

  /** What stands (or is going up) on a piece of the ring, and whether it is that piece or better. */
  private ringPiece(
    world: World,
    piece: { kind: BuildingKind; site: Site },
  ): { there: Building | undefined; done: boolean } {
    const there = world.town.at(piece.site);
    const stone =
      piece.kind === "palisade" || piece.kind === "woodgate"
        ? there?.kind === "wall" || there?.kind === "gatehouse"
        : false;
    return {
      there,
      done: !!there && (there.kind === piece.kind || stone || there.next === piece.kind),
    };
  }

  /** Whether the whole ring is begun in `kind` (or better). */
  private ringed(world: World, kind: "palisade" | "wall"): boolean {
    return this.ring(world, kind).every((piece) => this.ringPiece(world, piece).done);
  }

  /** Whether the whole ring stands finished in `kind` (or, for a palisade, better). */
  walled(world: World, kind: "palisade" | "wall"): boolean {
    return this.ring(world, kind).every((piece) => {
      const { there, done } = this.ringPiece(world, piece);
      return done && there?.phase === "standing";
    });
  }

  /** Whether the whole ring stands in stone. */
  walledInStone(world: World): boolean {
    return this.walled(world, "wall");
  }

  /**
   * Rings the settlement: a palisade with wooden gates, or later a stone
   * wall with towers and gatehouses, the old stakes taken down stretch by
   * stretch as the new wall goes up. Starts the next pieces so that no more
   * than `RING_AT_ONCE` are going up at a time.
   */
  private fortify(world: World, kind: "palisade" | "wall"): boolean {
    const pieces = this.ring(world, kind);
    let going = 0;
    for (const piece of pieces) {
      const there = world.town.at(piece.site);
      if (
        there &&
        (there.phase === "clearing" || there.phase === "building" || there.phase === "demolish")
      ) {
        going++;
      }
    }
    let started = 0;
    for (const piece of pieces) {
      if (going >= RING_AT_ONCE) {
        break;
      }
      const { there, done } = this.ringPiece(world, piece);
      if (done) {
        continue;
      }
      if (there) {
        if (there.phase === "standing" && !there.next) {
          there.next = piece.kind;
          there.phase = "demolish";
          started++;
          going++;
        }
      } else {
        world.found(piece.kind, piece.site, this.era);
        started++;
        going++;
      }
    }
    return started > 0;
  }

  /** Takes down one standing `from` to raise a `to` in its place. */
  private upgrade(world: World, from: BuildingKind, to: BuildingKind): boolean {
    const old = world.town.buildings.find(
      (b) => b.kind === from && b.phase === "standing" && b.fire <= 0,
    );
    return old ? this.upgradeOne(world, old, to) : false;
  }

  /** In town, the timber houses round the square give way to tall town houses. */
  private upgradeCore(world: World): boolean {
    // Half the timber houses in town (by the look each was given) go up again in stone or as town houses; the rest stay.
    const core = world.town.buildings.find(
      (b) =>
        b.kind === "house" &&
        b.phase === "standing" &&
        b.site.type === "lot" &&
        world.plan.lots[b.site.lot].zone !== "outer" &&
        (b.variant & 1) === 0,
    );
    if (!core) {
      return false;
    }
    return this.upgradeOne(world, core, world.rng.chance(0.4) ? "stonehouse" : "townhouse");
  }

  /**
   * Takes down `old` for a `to` in its place, a few at a time. Those who live
   * there lodge with others till it stands again.
   */
  private upgradeOne(world: World, old: Building, to: BuildingKind): boolean {
    let renewing = 0;
    for (const b of world.town.buildings) {
      if (b.phase === "demolish" || (b.replacing && b.phase !== "standing")) {
        renewing++;
      }
    }
    if (renewing >= RENEWING) {
      return false;
    }
    const living = world.households.filter((h) => roofOf(h) === old.id);
    for (const h of living) {
      this.lodge(world, h, old.id);
    }
    old.next = to;
    old.phase = "demolish";
    return true;
  }

  // Homes.

  /**
   * Finds a household a roof while their home is down: a house with room,
   * or else the nearest roof of any kind to crowd under. Their home stays
   * theirs to go back to.
   */
  lodge(world: World, h: Household, not: number): void {
    const home = world.building(h.home);
    const from = home ? home.rect : world.plan.center;
    const room = this.vacancies(world).filter((v) => v.building.id !== not);
    const fits = room.filter((v) => v.free >= h.members.length);
    const pick = (list: Building[]) => {
      let best: Building | null = null;
      let bestD = Infinity;
      for (const b of list) {
        const d = Math.hypot(b.rect.x - from.x, b.rect.y - from.y);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      return best;
    };
    const roof =
      pick(fits.map((v) => v.building)) ??
      pick(
        world.town.buildings.filter(
          (b) =>
            b.id !== not &&
            b.phase === "standing" &&
            b.fire <= 0.05 &&
            KINDS[b.kind].shelter &&
            b.kind !== "church",
        ),
      );
    h.lodging = roof ? roof.id : -1;
  }

  /**
   * Standing homes with room in them, and how much: what the households
   * whose home it is and those lodging in it leave free.
   */
  vacancies(world: World): { building: Building; free: number }[] {
    const living = new Map<number, number>();
    for (const h of world.households) {
      living.set(h.home, (living.get(h.home) ?? 0) + h.members.length);
      if (h.lodging >= 0) {
        living.set(h.lodging, (living.get(h.lodging) ?? 0) + h.members.length);
      }
    }
    const out: { building: Building; free: number }[] = [];
    for (const b of world.town.buildings) {
      const cap = KINDS[b.kind].housing;
      if (b.phase !== "standing" || cap <= 0 || b.kind === "tavern" || KINDS[b.kind].jobs.priest) {
        continue;
      }
      const free = cap - (living.get(b.id) ?? 0);
      if (free > 0) {
        out.push({ building: b, free });
      }
    }
    return out.sort((a, b) => b.free - a.free);
  }

  /** A building finished: people move in, the camp is struck when no one needs it. */
  built(world: World, b: Building): void {
    if (KINDS[b.kind].housing > 0 && b.kind !== "camp") {
      // Its own household comes home from lodging.
      for (const h of world.households) {
        if (h.home === b.id) {
          h.lodging = -1;
        }
      }
      // Those still in the camp, or without a home of their own, move in while there is room for them all.
      const camp = world.town.buildings.find((q) => q.kind === "camp");
      for (const h of world.households) {
        if (h.home < 0 || (camp && h.home === camp.id)) {
          const free = this.vacancies(world).find((v) => v.building.id === b.id);
          if (free && free.free >= h.members.length) {
            h.home = b.id;
            h.lodging = -1;
          }
        }
      }
      if (camp && !world.households.some((h) => h.home === camp.id || h.lodging === camp.id)) {
        world.town.remove(camp);
        const sq = world.plan.square;
        world.groundChanged(sq.x, sq.y, sq.radius);
      }
    }
    if (b.kind === "lumberyard") {
      // The logs piled by the square are carried over in time; the stock itself is one.
      world.groundChanged(b.rect.x, b.rect.y, 10);
    }
  }

  /** A building burned down: its people, and any lodging there, find a roof elsewhere till it is built again. */
  fell(world: World, b: Building): void {
    for (const h of world.households) {
      if (roofOf(h) === b.id) {
        this.lodge(world, h, b.id);
      }
    }
  }

  /** A ruin cleared away: the same built again, in stone if the town can now afford it. */
  ruinCleared(world: World, old: Building): void {
    let kind = old.kind;
    if (this.era >= 2 && (kind === "house" || kind === "townhouse" || kind === "cabin")) {
      kind = world.rng.chance(0.6) ? "stonehouse" : "townhouse";
    } else if (kind === "cabin" && this.era >= 1) {
      kind = "house";
    }
    const b = world.found(kind, old.site, this.era, "building");
    b.rebuilding = true;
    this.adopt(world, old, b);
  }

  /** Anyone whose home was `old` has `b` for a home now, lodging elsewhere till it is finished. */
  adopt(world: World, old: Building, b: Building): void {
    for (const h of world.households) {
      if (h.home === old.id) {
        h.home = b.id;
        if (h.lodging < 0) {
          this.lodge(world, h, old.id);
        }
      }
      if (h.lodging === old.id) {
        this.lodge(world, h, old.id);
      }
    }
  }

  // Raids.

  /** Raiders seen: the alarm bell, the gates shut, the militia called. */
  alarm(world: World): void {
    // Wolves at the flock frighten less than goblins with torches.
    this.threat += world.raids.active?.kind === "wolves" ? 0.5 : 1;
    const bell = this.bellTower(world);
    world.sound("alarm", bell.x, bell.y, bell.z);
    for (const b of world.town.buildings) {
      if ((b.kind === "woodgate" || b.kind === "gatehouse") && b.phase === "standing") {
        b.shut = true;
      }
    }
    this.muster(world);
    // Everyone drops what they were doing: a few to take up arms, the rest to get under a roof.
    for (const p of world.people) {
      if (p.task) {
        p.task.i = p.task.steps.length;
      }
    }
  }

  /**
   * Who goes out against the raiders: a few of the militia, those nearest
   * where they are coming, about one for every goblin or two and a couple
   * over; against the dragon only those who can shoot at it.
   */
  private muster(world: World): void {
    const raid = world.raids.active;
    const defenders = world.raids.defenders;
    defenders.clear();
    if (!raid) {
      return;
    }
    const able = world.people.filter((p) => p.militia && !isChild(p) && !isOld(p));
    if (raid.kind === "dragon") {
      for (const p of able) {
        if (p.job === "guard" || p.job === "wizard") {
          defenders.add(p.id);
        }
      }
      return;
    }
    const fighters = world.monsters.reduce(
      (n, m) => n + (m.kind === "ogre" ? 3 : m.kind === "wolf" ? 0.5 : 1),
      0,
    );
    const wanted = Math.min(MOST_DEFENDERS, Math.round(fighters * 0.7) + 2);
    const at = raid.toward;
    able
      .map((p) => ({ p, d: Math.hypot(p.x - at.x, p.y - at.y) - (p.job === "guard" ? 1000 : 0) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, wanted)
      .forEach(({ p }) => defenders.add(p.id));
  }

  /** The raiders gone: the all-clear, the gates opened. */
  allClear(world: World): void {
    world.raids.defenders.clear();
    const bell = this.bellTower(world);
    world.sound("allclear", bell.x, bell.y, bell.z);
    for (const b of world.town.buildings) {
      if (b.shut) {
        b.shut = false;
      }
    }
  }

  fireStarted(_world: World, _b: Building): void {
    // Neighbors see the smoke and come with buckets (see `jobs.ts`).
  }

  /** Where the alarm is rung from: a belfry, a watchtower, or the square. */
  private bellTower(world: World): { x: number; y: number; z: number } {
    const b = world.town.buildings.find(
      (q) =>
        (q.kind === "church" ||
          q.kind === "chapel" ||
          q.kind === "watchtower" ||
          q.kind === "townhall") &&
        q.phase === "standing",
    );
    if (b) {
      return { x: b.rect.x, y: b.rect.y, z: b.base + 10 };
    }
    const c = world.plan.center;
    return { x: c.x, y: c.y, z: world.terrain.height(c.x, c.y) + 2 };
  }

  // Land.

  /** Opens fields as the settlement needs food: the nearest first. */
  private planFields(world: World): void {
    const want = Math.max(1, Math.ceil(world.people.length / FEEDS));
    const cleared = [...this.openFields].filter((id) => world.town.fields[id].cleared).length;
    const clearing = this.openFields.size - cleared;
    if (this.openFields.size < want && clearing < 2) {
      const next = world.plan.fields.find((f) => !this.openFields.has(f.id));
      if (next) {
        this.openFields.add(next.id);
        this.opening.add(next.street);
      }
    }
  }

  /** Whether a field's trees and stumps are all gone. */
  fieldClear(world: World, id: number): boolean {
    const state = world.forest.state;
    return this.fieldTrees(world, id).every((t) => state[t] === GONE);
  }

  /**
   * Streets are trodden into tracks as buildings go up along them, once any
   * trees in the way are down; main roads are graveled in a village and the
   * square cobbled in a town.
   */
  private openStreets(world: World): void {
    const plan = world.plan;
    const town = world.town;
    for (const b of town.buildings) {
      if (b.site.type === "lot") {
        this.opening.add(plan.lots[b.site.lot].street);
      }
    }
    for (const id of this.opening) {
      if (town.streetGrade[id] > 0) {
        this.opening.delete(id);
        continue;
      }
      if (this.streetTrees(world, id).length === 0) {
        town.streetGrade[id] = 1;
        this.opening.delete(id);
        this.redrawStreet(world, id);
        // Lanes and tracks lead off a road: that must be open too.
        const s = plan.streets[id];
        const from = s.points[0];
        for (const o of plan.streets) {
          if (
            o.id !== id &&
            town.streetGrade[o.id] === 0 &&
            polylineDistance(from.x, from.y, o.points).distance < 3
          ) {
            this.opening.add(o.id);
          }
        }
      }
    }
    const pop = world.people.length;
    if (
      town.squareGrade === 0 &&
      town.buildings.filter((b) => b.phase === "standing").length >= 4
    ) {
      town.squareGrade = 1;
      world.groundChanged(plan.square.x, plan.square.y, plan.square.radius + 2);
    }
    if (this.era >= 1 && town.squareGrade === 1 && pop >= 40) {
      town.squareGrade = 2;
      world.groundChanged(plan.square.x, plan.square.y, plan.square.radius + 2);
    }
    if (this.era >= 1) {
      for (const s of plan.streets) {
        if (
          (s.tier === "trade" || s.tier === "road") &&
          town.streetGrade[s.id] === 1 &&
          world.rng.chance(0.02)
        ) {
          town.streetGrade[s.id] = 2;
          this.redrawStreet(world, s.id);
        }
      }
    }
  }

  /** Trees standing (or stumps) in the way of a street. */
  private streetTrees(world: World, id: number): number[] {
    const state = world.forest.state;
    return this.inWay(this.streetWay, id, () => {
      const s = world.plan.streets[id];
      const out = new Set<number>();
      for (let k = 0; k < s.points.length; k += 3) {
        const p = s.points[k];
        world.forest.near(p.x, p.y, s.half + 3, (t) => {
          if (polylineDistance(t.x, t.y, s.points).distance < s.half + 0.9) {
            out.add(t.id);
          }
        });
      }
      return [...out];
    }).filter((t) => state[t] !== GONE);
  }

  /** Trees (standing or not) on a field. */
  private fieldTrees(world: World, id: number): number[] {
    return this.inWay(this.fieldWay, id, () => {
      const rect = world.plan.fields[id].rect;
      const out: number[] = [];
      world.forest.near(rect.x, rect.y, Math.hypot(rect.width, rect.depth) / 2 + 1, (t) => {
        if (inRect(rect, t.x, t.y, 0.8)) {
          out.push(t.id);
        }
      });
      return out;
    });
  }

  /** The trees in the way of a street or field, worked out once: the plan and the woods never move. */
  private inWay(cache: Map<number, number[]>, id: number, find: () => number[]): number[] {
    let trees = cache.get(id);
    if (!trees) {
      trees = find();
      cache.set(id, trees);
    }
    return trees;
  }

  private redrawStreet(world: World, id: number): void {
    const s = world.plan.streets[id];
    for (let k = 0; k < s.points.length; k += 6) {
      const p = s.points[k];
      world.groundChanged(p.x, p.y, 8);
    }
    const last = s.points[s.points.length - 1];
    world.groundChanged(last.x, last.y, 8);
  }

  /** Every tree (or stump) wanted out of the way: building sites, open fields, streets being opened. */
  private gatherClearing(world: World): number[] {
    const out = new Set<number>();
    const state = world.forest.state;
    for (const b of world.town.buildings) {
      if (b.phase === "clearing") {
        for (const id of b.clearing) {
          if (state[id] !== GONE) {
            out.add(id);
          }
        }
      }
    }
    for (const id of this.openFields) {
      if (world.town.fields[id].cleared) {
        continue;
      }
      for (const t of this.fieldTrees(world, id)) {
        if (state[t] !== GONE) {
          out.add(t);
        }
      }
    }
    for (const id of this.opening) {
      for (const t of this.streetTrees(world, id)) {
        out.add(t);
      }
    }
    return [...out];
  }

  treesToClear(_world: World): readonly number[] {
    return this.clearing;
  }

  /** Logs the settlement wants in stock: what is being built still needs, and some over. */
  woodWanted(world: World): number {
    let want = 14;
    for (const b of world.town.buildings) {
      want += wants(b).wood;
    }
    return want;
  }

  /** Stones the settlement wants at hand: what is being built still needs, and a few over. */
  stoneWanted(world: World): number {
    let want = this.era >= 1 ? 8 : 3;
    for (const b of world.town.buildings) {
      want += wants(b).stone;
    }
    return want;
  }

  /**
   * A tree to cut for the stock: the nearest standing to the yard on its
   * side of the river, so the woods draw back from the settlement as it grows.
   */
  loggingTree(world: World, p: Person): number | null {
    const now = Math.floor(world.time / 30);
    if (now !== this.loggingAt) {
      this.loggingAt = now;
      const depot = world.depot("wood");
      const bank = world.terrain.riverOffset(depot.x, depot.y) > 0;
      const candidates: { id: number; d: number }[] = [];
      world.forest.near(depot.x, depot.y, 170, (t) => {
        if (
          world.forest.state[t.id] !== STANDING ||
          world.terrain.riverOffset(t.x, t.y) > 0 !== bank
        ) {
          return;
        }
        candidates.push({ id: t.id, d: Math.hypot(t.x - depot.x, t.y - depot.y) });
      });
      candidates.sort((a, b) => a.d - b.d);
      this.logging = candidates.slice(0, 24).map((c) => c.id);
    }
    const free = this.logging.filter(
      (id) => world.forest.state[id] === STANDING && !(this.tally.get(`tree-${id}`) ?? 0),
    );
    if (free.length === 0) {
      return null;
    }
    let best = free[0];
    let bestD = Infinity;
    for (const id of free.slice(0, 6)) {
      const t = world.forest.trees[id];
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /** A spot at the edge of the woods near someone, to gather what grows there. */
  woodsEdge(world: World, p: Person): Point | null {
    const region = world.nav.region(p.x, p.y);
    const c = world.plan.center;
    let best: Point | null = null;
    let bestD = Infinity;
    for (let tries = 0; tries < 12; tries++) {
      const a = world.rng.range(0, Math.PI * 2);
      const x = c.x + Math.cos(a) * world.rng.range(50, 90);
      const y = c.y + Math.sin(a) * world.rng.range(45, 80);
      let tree: Point | null = null;
      world.forest.near(x, y, 10, (t) => {
        if (!tree && world.forest.state[t.id] === STANDING) {
          tree = t;
        }
      });
      if (!tree) {
        continue;
      }
      const t: Point = tree;
      const toward = Math.atan2(c.y - t.y, c.x - t.x);
      const spot = { x: t.x + Math.cos(toward) * 2.5, y: t.y + Math.sin(toward) * 2.5 };
      if (world.nav.region(spot.x, spot.y) !== region || world.terrain.isWater(spot.x, spot.y)) {
        continue;
      }
      const d = Math.hypot(spot.x - p.x, spot.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = spot;
      }
    }
    return best;
  }

  /** A place on the near bank of the river to pick stones from. */
  riverbank(world: World, p: Person): Point {
    const t = world.terrain;
    const y = world.plan.center.y + world.rng.range(-25, 15);
    return t.bankPoint(y, t.riverOffset(p.x, p.y) > 0 ? 1 : -1, 1.2);
  }

  /** Water for buckets: the nearest standing well, or the river. */
  waterNear(world: World, x: number, y: number): Point {
    let best: Point | null = null;
    let bestD = Infinity;
    for (const id of this.wells) {
      const b = world.building(id);
      if (!b) {
        continue;
      }
      const d = Math.hypot(b.rect.x - x, b.rect.y - y);
      if (d < bestD) {
        bestD = d;
        // Round the well's rim, so those drawing water in turn don't stand on one spot.
        const a = world.rng.range(-1.2, 1.2) - Math.PI / 2;
        best = { x: b.rect.x + Math.cos(a) * 1.4, y: b.rect.y + Math.sin(a) * 1.4 };
      }
    }
    const t = world.terrain;
    const river = t.bankPoint(y, t.riverOffset(x, y) > 0 ? 1 : -1, 0.8);
    const dr = Math.hypot(river.x - x, river.y - y);
    return best && bestD < dr + 10 ? best : river;
  }

  /** The nearest standing building to take shelter in. */
  shelterNear(world: World, x: number, y: number): Building | null {
    let best: Building | null = null;
    let bestD = Infinity;
    for (const b of world.town.buildings) {
      if (b.phase !== "standing" || !KINDS[b.kind].shelter || b.fire > 0.05) {
        continue;
      }
      // Not a door with raiders at it, nor one to be run for past them.
      const d =
        Math.hypot(b.rect.x - x, b.rect.y - y) +
        (dangerAt(world, b.rect.x, b.rect.y) ? 200 : 0) +
        (dangerAt(world, (b.rect.x + x) / 2, (b.rect.y + y) / 2) ? 60 : 0);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** A standing building of `kind`, the one people go to for it. */
  place(world: World, kind: BuildingKind): Building | null {
    return world.town.buildings.find((b) => b.kind === kind && b.phase === "standing") ?? null;
  }

  worship(): Building | null {
    return this.churchHere;
  }

  tavern(): Building | null {
    return this.tavernHere;
  }

  /** Points along the ring lane and the main streets inside the wall, for the night watch. */
  patrolRoute(world: World): Point[] {
    const out: Point[] = [];
    for (const s of world.plan.streets) {
      if (!s.inside) {
        continue;
      }
      for (let k = 0; k < s.points.length; k += 4) {
        out.push(s.points[k]);
      }
    }
    return out.length > 0 ? out : [world.plan.center];
  }

  /** A pasture waiting for its fence, once there is a flock worth fencing in. */
  pastureToFence(world: World): number | null {
    if (world.people.length < 8) {
      return null;
    }
    const i = world.town.pastures.findIndex((p) => !p.fenced);
    if (i < 0) {
      return null;
    }
    // Another pasture only once the flock has outgrown those fenced already.
    const flock = world.animals.filter((a) => a.kind === "sheep" || a.kind === "cow").length;
    return i === 0 || flock > i * FLOCK_PER_PASTURE ? i : null;
  }

  // Paving.

  /** In a town, the streets inside the wall are cobbled one by one, the square first. */
  private pave(world: World): void {
    const town = world.town;
    const plan = world.plan;
    const paving = this.paving;
    if (paving) {
      // Redraw the ground as the paving front moves on.
      const s = plan.streets[paving.street];
      if (paving.done - paving.shown >= 3 || paving.done >= paving.length) {
        const p = alongPolyline(s.points, paving.shown + 1.5);
        world.groundChanged(p.x, p.y, 5);
        paving.shown = paving.done;
      }
      if (paving.done >= paving.length) {
        town.streetGrade[paving.street] = 3;
        this.redrawStreet(world, paving.street);
        this.paving = null;
        if (town.squareGrade < 3) {
          town.squareGrade = 3;
          world.groundChanged(plan.square.x, plan.square.y, plan.square.radius + 2);
        }
      }
      return;
    }
    if (this.era < 2) {
      return;
    }
    const next = plan.streets.find(
      (s) =>
        town.streetGrade[s.id] > 0 &&
        town.streetGrade[s.id] < 3 &&
        (s.inside || polylineDistance(plan.center.x, plan.center.y, s.points).distance < 1),
    );
    if (next) {
      this.paving = {
        street: next.id,
        done: 0,
        length: this.pavedLength(world, next.id),
        shown: 0,
      };
    }
  }

  /** How much of a street lies inside the wall (all of a lane inside it). */
  private pavedLength(world: World, id: number): number {
    const s = world.plan.streets[id];
    if (s.inside) {
      return polylineLength(s.points);
    }
    let len = 0;
    for (let k = 0; k + 1 < s.points.length; k++) {
      const a = s.points[k];
      const b = s.points[k + 1];
      if (inPolygon((a.x + b.x) / 2, (a.y + b.y) / 2, world.plan.wall.points)) {
        len += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
    return len;
  }

  /** Where the paving front is, for the pavers to kneel at. */
  paveSpot(world: World): Point | null {
    const paving = this.paving;
    if (!paving) {
      return null;
    }
    const s = world.plan.streets[paving.street];
    // Walk the street's length inside the wall up to the front.
    let left = paving.done;
    for (let k = 0; k + 1 < s.points.length; k++) {
      const a = s.points[k];
      const b = s.points[k + 1];
      if (!s.inside && !inPolygon((a.x + b.x) / 2, (a.y + b.y) / 2, world.plan.wall.points)) {
        continue;
      }
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (left <= len) {
        const t = left / len;
        const side = world.rng.range(-s.half, s.half) * 0.8;
        return {
          x: a.x + (b.x - a.x) * t - ((b.y - a.y) / len) * side,
          y: a.y + (b.y - a.y) * t + ((b.x - a.x) / len) * side,
        };
      }
      left -= len;
    }
    return null;
  }

  /** Whether the ground under a point of a street is paved already (the paving front has passed it). */
  paved(world: World, street: number, x: number, y: number): boolean {
    const grade = world.town.streetGrade[street];
    if (grade >= 3) {
      return true;
    }
    const paving = this.paving;
    if (!paving || paving.street !== street) {
      return false;
    }
    const s = world.plan.streets[street];
    if (!s.inside && !inPolygon(x, y, world.plan.wall.points)) {
      return false;
    }
    let along = 0;
    const near = polylineDistance(x, y, s.points);
    for (let k = 0; k < near.segment; k++) {
      const a = s.points[k];
      const b = s.points[k + 1];
      if (s.inside || inPolygon((a.x + b.x) / 2, (a.y + b.y) / 2, world.plan.wall.points)) {
        along += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
    return along <= paving.shown;
  }

  // Newcomers.

  /** Families come up the road when there are homes for them and food to spare. */
  private arrivals(world: World): void {
    const now = world.env.clock.days;
    const h = world.env.clock.hour;
    if (now < this.nextArrival || h < 7 || h > 16.5 || world.raids.active) {
      return;
    }
    const pop = world.people.length;
    if (world.stock.food < pop * FOOD_MARGIN * RATION) {
      return;
    }
    const room = this.vacancies(world);
    const free = room.reduce((n, v) => n + v.free, 0);
    if (free < 3) {
      return;
    }
    const r = world.rng;
    const home = room[0].building;
    // They come up one of the roads, first seen as they come out of the woods.
    const road = world.plan.nodes[r.pick(world.plan.exits)];
    const door = world.door(home);
    const way = world.nav.path(road.x, road.y, door.x, door.y);
    const c = world.plan.center;
    const exit = way.find((q) => Math.hypot(q.x - c.x, q.y - c.y) < ARRIVAL_REACH) ?? road;
    const children = r.int(0, Math.min(3, room[0].free - 2));
    const elder = room[0].free - 2 - children > 0 && r.chance(0.2) ? 1 : 0;
    const family = newHousehold(world, 2 + elder, children, exit.x, exit.y);
    family.home = home.id;
    // Newcomers bring what they can carry to eat.
    world.stock.food += family.members.length * 4;
    for (const id of family.members) {
      const p = world.person(id);
      if (p) {
        p.arriving = true;
        p.carry = r.pick(["bundle", "sack", "basket", null] as const);
        this.assignJob(world, p);
      }
    }
    // Some bring a hen or two, or a cow once there is a pasture.
    if (r.chance(0.4) && home.site.type === "lot") {
      const lot = world.plan.lots[home.site.lot];
      for (let k = r.int(1, 3); k > 0; k--) {
        newAnimal(world, "chicken", lot.rect.x, lot.rect.y, { type: "lot", id: lot.id });
      }
    }
    const pastures = world.plan.pastures.filter((q) => world.town.pastures[q.id].fenced);
    if (pastures.length > 0 && r.chance(0.3)) {
      const q = r.pick(pastures);
      newAnimal(world, r.chance(0.5) ? "cow" : "sheep", exit.x, exit.y, {
        type: "pasture",
        id: q.id,
      });
    }
    this.nextArrival = now + ARRIVAL_GAP + r.range(0, 0.15);
  }

  // Jobs.

  /** Who does what, rebalanced as the settlement changes. */
  assignJobs(world: World): void {
    const workers = world.people.filter((p) => !isChild(p) && !isOld(p) && !p.leaving);
    if (workers.length === 0) {
      return;
    }
    const want = this.jobWants(world, workers.length);
    const count = new Map<Job, number>();
    for (const p of workers) {
      count.set(p.job, (count.get(p.job) ?? 0) + 1);
    }
    // Move people off jobs with too many onto jobs with too few, one change at a time.
    for (const p of workers) {
      const have = count.get(p.job) ?? 0;
      const need = want.get(p.job) ?? 0;
      if (have <= need && p.job !== "idle") {
        continue;
      }
      let short: Job | null = null;
      let most = 0;
      for (const [job, n] of want) {
        const gap = n - (count.get(job) ?? 0);
        if (gap > most) {
          most = gap;
          short = job;
        }
      }
      if (!short) {
        break;
      }
      count.set(p.job, have - 1);
      count.set(short, (count.get(short) ?? 0) + 1);
      p.job = short;
    }
    // Carters with an ox and cart each, once there is a yard to cart from.
    const yard = world.town.buildings.some(
      (b) => b.kind === "lumberyard" && b.phase === "standing",
    );
    const carters = world.animals.filter(
      (a) =>
        a.kind === "ox" && a.home.type === "person" && world.person(a.home.id)?.job === "hauler",
    );
    const wantCarts = yard ? Math.min(MOST_CARTS, 1 + Math.floor(world.people.length / 15)) : 0;
    if (carters.length < wantCarts) {
      const p = workers.find((q) => q.job === "hauler" && !world.cartOf(q));
      if (p) {
        const depot = world.depot("wood");
        newAnimal(world, "ox", depot.x + 1, depot.y - 2, { type: "person", id: p.id });
      }
    }
    // Patch the flock onto the pastures once they are fenced.
    for (const a of world.animals) {
      if ((a.kind === "sheep" || a.kind === "cow") && a.home.type === "wild") {
        const q = world.plan.pastures.find((pp) => world.town.pastures[pp.id].fenced);
        if (q) {
          a.home = { type: "pasture", id: q.id };
          const c = q.rect;
          a.tx = c.x;
          a.ty = c.y;
          a.wait = 0;
        }
      }
      if (a.kind === "chicken" && a.home.type === "wild") {
        const home = world.town.buildings.find(
          (b) => b.site.type === "lot" && KINDS[b.kind].housing > 0 && b.phase === "standing",
        );
        if (home && home.site.type === "lot") {
          a.home = { type: "lot", id: home.site.lot };
        }
      }
    }
  }

  /** How many of each job the settlement wants, given `hands` grown-ups to work. */
  private jobWants(world: World, hands: number): Map<Job, number> {
    const want = new Map<Job, number>();
    let left = hands;
    const set = (job: Job, n: number) => {
      const k = Math.max(0, Math.min(left, Math.round(n)));
      want.set(job, (want.get(job) ?? 0) + k);
      left -= k;
    };
    // The trades each building gives.
    for (const b of world.town.buildings) {
      if (b.phase !== "standing") {
        continue;
      }
      for (const [job, n] of Object.entries(KINDS[b.kind].jobs) as [Job, number][]) {
        if (job === "builder" || job === "farmer" || job === "woodcutter") {
          continue;
        }
        set(job, n);
      }
    }
    if (world.town.pastures.some((p) => p.fenced)) {
      set("shepherd", 1);
    }
    const building = world.town.buildings.some(
      (b) =>
        b.phase === "building" ||
        b.phase === "clearing" ||
        b.phase === "demolish" ||
        b.phase === "ruin",
    );
    const clear = this.clearing.length;
    const fields = this.openFields.size;
    const rest = left;
    set("farmer", Math.max(1, Math.min(rest * 0.35, fields * 0.6 + 0.5)));
    set(
      "woodcutter",
      Math.max(1, Math.min(rest * 0.22, 1 + clear / 10 + (world.stock.wood < 10 ? 1 : 0))),
    );
    set(
      "quarrier",
      world.town.buildings.some((b) => b.kind === "quarry" && b.phase === "standing")
        ? Math.min(3, rest * 0.12)
        : world.stock.stone < 12
          ? 1
          : 0,
    );
    set("builder", building ? rest * 0.3 : rest * 0.1);
    set("hauler", left);
    return want;
  }

  /** A job for someone newly grown or newly come: whatever is shortest. */
  assignJob(world: World, p: Person): void {
    const workers = world.people.filter((q) => !isChild(q) && !isOld(q) && q !== p);
    const want = this.jobWants(world, workers.length + 1);
    let short: Job = "hauler";
    let most = -Infinity;
    for (const [job, n] of want) {
      const have = workers.filter((q) => q.job === job).length;
      if (n - have > most) {
        most = n - have;
        short = job;
      }
    }
    p.job = short;
  }
}
