import { mod } from "../core/math.ts";

/** Real seconds for one in-world day. */
export const REAL_SECONDS_PER_DAY = 300;
export const DAYS_PER_SEASON = 3;
export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS.length;
/** Calendar day of the year (0 = Jan 1) at which the in-world year (spring) starts: Mar 1. */
const YEAR_START_DAY_OF_YEAR = 59;
const CALENDAR_DAYS = 365.25;

export type Season = (typeof SEASONS)[number];

/**
 * In-world time. `days` is a continuous count of days since the start of the
 * first spring; its fractional part is the time of day.
 */
export class Clock {
  days: number;

  constructor(days: number) {
    this.days = days;
  }

  static at(dayOfYear: number, minuteOfDay: number): Clock {
    return new Clock(dayOfYear + minuteOfDay / 1440);
  }

  advance(realSeconds: number): void {
    this.days += realSeconds / REAL_SECONDS_PER_DAY;
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
    return mod(this.days, DAYS_PER_YEAR) / DAYS_PER_YEAR;
  }

  get season(): Season {
    return SEASONS[Math.min(SEASONS.length - 1, Math.floor(this.yearFraction * SEASONS.length))];
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
