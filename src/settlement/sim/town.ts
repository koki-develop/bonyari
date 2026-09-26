import type { Building, Site } from "./buildings.ts";
import type { Plan } from "./plan.ts";

/** How far a street is built: not at all, a trodden track, a graveled road, or cobbled. */
export type Grade = 0 | 1 | 2 | 3;

/** The year's work on a field. */
export interface FieldState {
  /** Whether its trees and stumps are gone and it has been broken for plowing. */
  cleared: boolean;
  /** The year (count of in-world years) it was last sown, and last reaped. */
  sownYear: number;
  reapedYear: number;
  /** How much of this year's work is done: plowing and sowing, or reaping (0..1). */
  work: number;
  /** Which crop it grows this year. */
  crop: "wheat" | "barley" | "oats" | "flax";
  /** How trampled or burned it is by raiders (0..1); it recovers at the next sowing. */
  spoiled: number;
}

export interface PastureState {
  fenced: boolean;
}

/**
 * The built town: how far each street is built, the square, the fields and
 * pastures, the ground of each lot, and every building. The shape of it all
 * is in the plan; this is what has come of it so far.
 */
export class Town {
  readonly streetGrade: Uint8Array;
  squareGrade: Grade = 0;
  readonly fields: FieldState[];
  readonly pastures: PastureState[];
  /** What the ground of each lot is: 0 wild, 1 a trodden yard, 2 a yard with a garden. */
  readonly lotGround: Uint8Array;
  /** Every building, in the order they were founded. Changed only through `add` and `remove`. */
  readonly buildings: Building[] = [];
  nextBuildingId = 0;
  /** Goes up whenever a building is added or removed, or its ground is cleared and it starts to rise. */
  version = 0;
  private readonly byId = new Map<number, Building>();
  private readonly bySite = new Map<string, Building>();

  constructor(plan: Plan) {
    this.streetGrade = new Uint8Array(plan.streets.length);
    plan.streets.forEach((s, i) => {
      this.streetGrade[i] = s.old ? 1 : 0;
    });
    this.fields = plan.fields.map(() => ({
      cleared: false,
      sownYear: -1,
      reapedYear: -1,
      work: 0,
      crop: "wheat",
      spoiled: 0,
    }));
    this.pastures = plan.pastures.map(() => ({ fenced: false }));
    this.lotGround = new Uint8Array(plan.lots.length);
  }

  building(id: number): Building | undefined {
    return this.byId.get(id);
  }

  /** What stands (or is going up, or lies in ruins) on a site. */
  at(site: Site): Building | undefined {
    return this.bySite.get(siteKey(site));
  }

  /** The bridge over the ford, if one has been started. */
  get bridge(): Building | undefined {
    return this.bySite.get(FORD);
  }

  add(b: Building): void {
    this.buildings.push(b);
    this.byId.set(b.id, b);
    this.bySite.set(siteKey(b.site), b);
    this.version++;
  }

  /** Notes that a building's footprint has changed what it takes up on the ground. */
  touched(): void {
    this.version++;
  }

  remove(b: Building): void {
    const i = this.buildings.indexOf(b);
    if (i < 0) {
      return;
    }
    this.buildings.splice(i, 1);
    this.byId.delete(b.id);
    if (this.bySite.get(siteKey(b.site)) === b) {
      this.bySite.delete(siteKey(b.site));
    }
    this.version++;
  }
}

/** A name for a site, the same for any two that are the same place. */
export function siteKey(site: Site): string {
  switch (site.type) {
    case "lot":
      return `lot ${site.lot}`;
    case "wall":
      return `wall ${site.index}`;
    case "tower":
      return `tower ${site.index}`;
    case "gate":
      return `gate ${site.gate}`;
    case "square":
      return "square";
    case "ford":
      return FORD;
  }
}

const FORD = "ford";
