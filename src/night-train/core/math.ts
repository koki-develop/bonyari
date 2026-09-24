export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01(invLerp(edge0, edge1, v));
  return t * t * (3 - 2 * t);
}

/** Positive modulo: the result always has the sign of `m`. */
export function mod(v: number, m: number): number {
  const r = v % m;
  return r < 0 ? r + m : r;
}

/** 1 inside [center - width/2, center + width/2], easing to 0 over `fade` on each side. */
export function bump(v: number, center: number, width: number, fade: number): number {
  const d = Math.abs(v - center) - width / 2;
  return 1 - smoothstep(0, fade, d);
}

/** Cyclic distance on a ring of circumference `period`. */
export function cyclicDistance(a: number, b: number, period: number): number {
  const d = mod(a - b, period);
  return Math.min(d, period - d);
}

/** `bump` on a ring, e.g. for yearly or daily cycles. */
export function cyclicBump(
  v: number,
  center: number,
  width: number,
  fade: number,
  period: number,
): number {
  const d = cyclicDistance(v, center, period) - width / 2;
  return 1 - smoothstep(0, fade, d);
}

/** Exponential approach factor for frame-rate independent smoothing. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/**
 * Integral of a pulse train from 0 to `t`: pulses of `width` starting at every
 * multiple of `period`.
 */
function pulseIntegral(t: number, period: number, width: number): number {
  const n = Math.floor(t / period);
  return n * width + Math.min(t - n * period, width);
}

/**
 * Box-filtered coverage of a pulse train over [t - footprint/2, t + footprint/2].
 * Used both for anti-aliasing and for motion blur of repeating structures.
 */
export function pulseCoverage(t: number, period: number, width: number, footprint: number): number {
  if (footprint <= 1e-6) {
    return mod(t, period) < width ? 1 : 0;
  }
  const a = t - footprint / 2;
  const b = t + footprint / 2;
  return clamp01((pulseIntegral(b, period, width) - pulseIntegral(a, period, width)) / footprint);
}

/** Box-filtered coverage of the single interval [lo, hi]. */
export function intervalCoverage(t: number, lo: number, hi: number, footprint: number): number {
  if (footprint <= 1e-6) {
    return t >= lo && t < hi ? 1 : 0;
  }
  const a = Math.max(t - footprint / 2, lo);
  const b = Math.min(t + footprint / 2, hi);
  return b > a ? (b - a) / footprint : 0;
}
