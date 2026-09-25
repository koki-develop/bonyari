import { add, desaturate, hex, luminance, mix, ramp, type RGB, scale } from "../core/color.ts";
import { clamp01, smoothstep } from "../core/math.ts";
import type { Environment } from "../env/environment.ts";

/** Per-frame light and color state shared by every layer. */
export interface Lighting {
  zenith: RGB;
  horizon: RGB;
  /** Glow around the sun (strongest when low). */
  sunGlow: RGB;
  sunDisc: RGB;
  /** Multiplier (0..~1) applied to surface colors. */
  ambient: RGB;
  /** Color distant things fade into. */
  fog: RGB;
  /** Brightness of lit cloud tops and of cloud undersides. */
  cloudLit: RGB;
  cloudShade: RGB;
  /** 0 at night, 1 in full daylight. */
  daylight: number;
  /** Strength (0..1) of direct sunlight, apart from the diffuse sky light. */
  direct: number;
  /** Street lamps and lit windows. */
  lamps: number;
  starVisibility: number;
  /** Glow of nearby towns (0..1) that lights the underside of clouds at night. */
  lightPollution: number;
}

const ZENITH: readonly (readonly [number, RGB])[] = [
  [-18, hex("#060a19")],
  [-12, hex("#0a1230")],
  [-8, hex("#13214f")],
  [-5, hex("#1f336f")],
  [-2, hex("#2f4b8d")],
  [0, hex("#3e60a0")],
  [3, hex("#5078b6")],
  [7, hex("#5a8ecd")],
  [15, hex("#4f8edd")],
  [40, hex("#3c7ede")],
];

const HORIZON: readonly (readonly [number, RGB])[] = [
  [-18, hex("#0b1227")],
  [-12, hex("#172047")],
  [-8, hex("#34305f")],
  [-5, hex("#80506a")],
  [-2, hex("#d9774f")],
  [0, hex("#f2924d")],
  [3, hex("#f5b574")],
  [7, hex("#e2d2b6")],
  [15, hex("#bcd5ea")],
  [40, hex("#a9cdf2")],
];

const AMBIENT: readonly (readonly [number, RGB])[] = [
  [-18, [20, 24, 42]],
  [-10, [26, 29, 52]],
  [-5, [56, 52, 78]],
  [-2, [112, 88, 98]],
  [0, [156, 116, 104]],
  [3, [204, 160, 128]],
  [8, [240, 218, 192]],
  [20, [255, 250, 242]],
  [40, [260, 260, 255]],
];

const SUN_GLOW: readonly (readonly [number, RGB])[] = [
  [-8, hex("#6a2c3c")],
  [-3, hex("#e0603a")],
  [0, hex("#ff8a3a")],
  [5, hex("#ffc27a")],
  [15, hex("#fff0d0")],
  [40, hex("#fffaf0")],
];

/** @param lightPollution glow of nearby towns, 0 (none) to 1 (city) */
export function computeLighting(env: Environment, lightPollution: number): Lighting {
  const alt = env.sky.sunAltitude;
  const w = env.weather.state;
  const cloud = w.cloudCover;
  const overcast = clamp01(cloud * 1.1 - 0.15);
  const gloom = clamp01(overcast * 0.35 + w.rain * 0.25 + w.storm * 0.25 + w.snow * 0.1);

  let zenith = ramp(ZENITH, alt);
  let horizon = ramp(HORIZON, alt);
  let ambient = ramp(AMBIENT, alt);

  // Moonlight lifts the night a little.
  const moonUp = smoothstep(-2, 12, env.sky.moonAltitude);
  const moon = moonUp * env.sky.moonIllumination * (1 - overcast * 0.8) * smoothstep(-2, -10, alt);
  ambient = add(ambient, scale([30, 36, 58], moon));
  zenith = add(zenith, scale([8, 12, 24], moon));
  horizon = add(horizon, scale([10, 14, 26], moon));

  // Overcast skies turn grey and darker.
  const overcastSky = (c: RGB): RGB => scale(desaturate(c, 0.85), 0.78 - gloom * 0.3);
  zenith = mix(zenith, overcastSky(mix(zenith, horizon, 0.5)), overcast);
  horizon = mix(horizon, overcastSky(horizon), overcast * 0.9);
  ambient = mix(ambient, scale(desaturate(ambient, 0.6), 0.85), overcast);
  ambient = scale(ambient, 1 - gloom * 0.35);

  // Snowfall brightens and whitens everything a little.
  horizon = mix(horizon, scale([225, 230, 240], luminance(horizon) + 0.1), w.snow * 0.5);

  let fog = mix(horizon, zenith, 0.15);
  fog = mix(fog, scale([210, 214, 222], luminance(ambient) * 0.9 + 0.05), w.mist * 0.7);

  if (w.flash > 0) {
    const f = w.flash;
    zenith = add(zenith, scale([140, 150, 190], f));
    horizon = add(horizon, scale([170, 175, 210], f));
    ambient = add(ambient, scale([120, 125, 150], f));
  }

  const sunGlow = scale(ramp(SUN_GLOW, alt), 1 - overcast * 0.85);
  const sunDisc: RGB = mix([255, 150, 80], [255, 250, 235], smoothstep(-1, 12, alt));
  const daylight = smoothstep(-6, 8, alt);
  const cloudLit = mix(
    mix(ambient, sunGlow, 0.55 * (1 - daylight) * smoothstep(-8, 0, alt)),
    [255, 255, 255],
    daylight * 0.8,
  );
  const cloudShade = scale(mix(zenith, [150, 150, 160], 0.45), 0.72);

  return {
    zenith,
    horizon,
    sunGlow,
    sunDisc,
    ambient: scale(ambient, 1 / 255),
    fog,
    cloudLit,
    cloudShade,
    daylight,
    direct: smoothstep(-1, 10, alt) * (1 - overcast) * (1 - gloom),
    lamps: Math.max(smoothstep(4, -3, alt), clamp01(gloom * 1.4 - 0.4)),
    starVisibility: smoothstep(-5, -15, alt) * (1 - lightPollution * 0.55) * (1 - w.mist * 0.6),
    lightPollution,
  };
}
