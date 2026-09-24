import { DEG, mod, TAU } from "../core/math.ts";

/** Observer latitude (central Japan). */
export const LATITUDE = 35 * DEG;
const OBLIQUITY = 23.44 * DEG;
/** In-world days per lunar cycle; shorter than the real one so phases change visibly. */
export const LUNAR_CYCLE_DAYS = 8;

/** A direction in the local horizon frame: east, north and up components of a unit vector. */
export interface HorizonVector {
  e: number;
  n: number;
  u: number;
}

export interface Equatorial {
  /** Right ascension in radians. */
  ra: number;
  /** Declination in radians. */
  dec: number;
}

/** Converts ecliptic longitude (radians, ecliptic latitude 0) to equatorial coordinates. */
export function eclipticToEquatorial(lambda: number): Equatorial {
  const ra = Math.atan2(Math.cos(OBLIQUITY) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(lambda));
  return { ra: mod(ra, TAU), dec };
}

/** Ecliptic longitude of the sun for a calendar day of the year (0 = Jan 1). */
export function sunLongitude(calendarDayOfYear: number): number {
  // The March equinox falls on day ~79 (Mar 20/21).
  return mod(((calendarDayOfYear - 79.3) / 365.25) * TAU, TAU);
}

/**
 * Local sidereal angle (radians) for local solar time `hour`. Using local
 * solar time keeps the sun on the meridian at noon.
 */
export function siderealAngle(calendarDayOfYear: number, hour: number): number {
  const sun = eclipticToEquatorial(sunLongitude(calendarDayOfYear));
  return mod((hour - 12) * 15 * DEG + sun.ra, TAU);
}

export function equatorialToHorizon(
  eq: Equatorial,
  sidereal: number,
  latitude = LATITUDE,
): HorizonVector {
  const h = sidereal - eq.ra;
  const cosDec = Math.cos(eq.dec);
  const sinDec = Math.sin(eq.dec);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const cosH = Math.cos(h);
  return {
    e: -cosDec * Math.sin(h),
    n: cosLat * sinDec - sinLat * cosDec * cosH,
    u: sinLat * sinDec + cosLat * cosDec * cosH,
  };
}

export function altitude(v: HorizonVector): number {
  return Math.asin(Math.max(-1, Math.min(1, v.u)));
}

export interface SkyState {
  sidereal: number;
  sun: HorizonVector;
  /** Sun altitude in degrees. */
  sunAltitude: number;
  moon: HorizonVector;
  moonAltitude: number;
  /** 0 = new moon, 0.5 = full moon. */
  moonPhase: number;
  /** Illuminated fraction of the lunar disc. */
  moonIllumination: number;
}

export function computeSky(calendarDayOfYear: number, hour: number, worldDays: number): SkyState {
  const sidereal = siderealAngle(calendarDayOfYear, hour);
  const lambdaSun = sunLongitude(calendarDayOfYear);
  const sun = equatorialToHorizon(eclipticToEquatorial(lambdaSun), sidereal);
  const moonPhase = mod(worldDays / LUNAR_CYCLE_DAYS + 0.35, 1);
  const moon = equatorialToHorizon(eclipticToEquatorial(lambdaSun + moonPhase * TAU), sidereal);
  return {
    sidereal,
    sun,
    sunAltitude: altitude(sun) / DEG,
    moon,
    moonAltitude: altitude(moon) / DEG,
    moonPhase,
    moonIllumination: (1 - Math.cos(moonPhase * TAU)) / 2,
  };
}

/** North galactic pole and galactic longitude of the north celestial pole (J2000). */
const GAL_POLE_RA = 192.85948 * DEG;
const GAL_POLE_DEC = 27.12825 * DEG;
const GAL_NCP_L = 122.93192 * DEG;

export function galacticToEquatorial(l: number, b: number): Equatorial {
  const sinDec =
    Math.sin(GAL_POLE_DEC) * Math.sin(b) +
    Math.cos(GAL_POLE_DEC) * Math.cos(b) * Math.cos(GAL_NCP_L - l);
  const dec = Math.asin(sinDec);
  const y = Math.cos(b) * Math.sin(GAL_NCP_L - l);
  const x =
    Math.cos(GAL_POLE_DEC) * Math.sin(b) -
    Math.sin(GAL_POLE_DEC) * Math.cos(b) * Math.cos(GAL_NCP_L - l);
  return { ra: mod(GAL_POLE_RA + Math.atan2(y, x), TAU), dec };
}
