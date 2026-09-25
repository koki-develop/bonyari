import { mod } from "../core/math.ts";

const DAYS_PER_SEASON = 3;
/** Spring, summer, autumn and winter. */
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;
/** Calendar day of the year (0 = Jan 1) at which the in-world year (spring) starts: Mar 1. */
const YEAR_START_DAY_OF_YEAR = 59;
const CALENDAR_DAYS = 365.25;

/** How a work keeps time. */
export interface Timekeeping {
  /** Real seconds an in-world day lasts. */
  secondsPerDay: number;
  /**
   * The position in the year (0..1) that every day keeps, for a work that
   * stays in one moment of one season; null for a year that turns.
   */
  timeOfYear: number | null;
}

/**
 * In-world time. `days` is a continuous count of days since the start of the
 * first spring; its fractional part is the time of day.
 */
export class Clock {
  days: number;
  readonly timekeeping: Timekeeping;

  constructor(days: number, timekeeping: Timekeeping) {
    this.days = days;
    this.timekeeping = timekeeping;
  }

  static at(dayOfYear: number, minuteOfDay: number, timekeeping: Timekeeping): Clock {
    return new Clock(dayOfYear + minuteOfDay / 1440, timekeeping);
  }

  advance(realSeconds: number): void {
    this.days += realSeconds / this.timekeeping.secondsPerDay;
  }

  /** Minutes since midnight, 0 <= m < 1440. */
  get minuteOfDay(): number {
    return mod(this.days, 1) * 1440;
  }

  /** Hours since midnight as a fraction, 0 <= h < 24. */
  get hour(): number {
    return this.minuteOfDay / 60;
  }

  /** Position within the in-world year, 0 <= f < 1 (0 = first day of spring). */
  get yearFraction(): number {
    return this.timekeeping.timeOfYear ?? mod(this.days, DAYS_PER_YEAR) / DAYS_PER_YEAR;
  }

  /** Equivalent real-calendar day of the year (0 = Jan 1), for astronomy. */
  get calendarDayOfYear(): number {
    return mod(YEAR_START_DAY_OF_YEAR + this.yearFraction * CALENDAR_DAYS, CALENDAR_DAYS);
  }
}

export function formatClock(minuteOfDay: number): string {
  const m = Math.floor(mod(minuteOfDay, 1440));
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
