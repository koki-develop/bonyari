import { clamp01 } from "./math.ts";

/** Linear-ish RGB with channels in 0..255 (floats allowed). */
export type RGB = readonly [number, number, number];

export function hex(value: string): RGB {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Packs to the little-endian RGBA layout of `ImageData` viewed as Uint32. */
export function pack(r: number, g: number, b: number): number {
  const ri = r <= 0 ? 0 : r >= 255 ? 255 : r | 0;
  const gi = g <= 0 ? 0 : g >= 255 ? 255 : g | 0;
  const bi = b <= 0 ? 0 : b >= 255 ? 255 : b | 0;
  return (0xff000000 | (bi << 16) | (gi << 8) | ri) >>> 0;
}

export function packRGB(c: RGB): number {
  return pack(c[0], c[1], c[2]);
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function mul(a: RGB, b: RGB): RGB {
  return [(a[0] * b[0]) / 255, (a[1] * b[1]) / 255, (a[2] * b[2]) / 255];
}

export function scale(a: RGB, k: number): RGB {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function add(a: RGB, b: RGB): RGB {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function luminance(c: RGB): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

export function desaturate(c: RGB, amount: number): RGB {
  const l = luminance(c) * 255;
  return mix(c, [l, l, l], clamp01(amount));
}

/** Samples a keyframed color ramp; keys must be sorted by position. */
export function ramp(keys: readonly (readonly [number, RGB])[], v: number): RGB {
  if (v <= keys[0][0]) {
    return keys[0][1];
  }
  for (let i = 1; i < keys.length; i++) {
    const [p1, c1] = keys[i];
    if (v <= p1) {
      const [p0, c0] = keys[i - 1];
      return mix(c0, c1, (v - p0) / (p1 - p0));
    }
  }
  return keys[keys.length - 1][1];
}

/** Samples a keyframed scalar ramp; keys must be sorted by position. */
export function rampScalar(keys: readonly (readonly [number, number])[], v: number): number {
  if (v <= keys[0][0]) {
    return keys[0][1];
  }
  for (let i = 1; i < keys.length; i++) {
    const [p1, s1] = keys[i];
    if (v <= p1) {
      const [p0, s0] = keys[i - 1];
      return s0 + ((s1 - s0) * (v - p0)) / (p1 - p0);
    }
  }
  return keys[keys.length - 1][1];
}

export function unpackR(c: number): number {
  return c & 255;
}

export function unpackG(c: number): number {
  return (c >>> 8) & 255;
}

export function unpackB(c: number): number {
  return (c >>> 16) & 255;
}
