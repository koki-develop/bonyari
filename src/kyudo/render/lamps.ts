import { smoothstep } from "../../shared/core/math.ts";
import type { Lighting } from "../../shared/render/lighting.ts";
import {
  BEAM_Y,
  CEILING_Y,
  HALL_FRONT,
  MAKU_Z,
  RANGE_EAVE_Y,
  TARGET_DISTANCE,
  TARGET_HEIGHT,
  TARGETS,
} from "../sim/dojo.ts";

/**
 * A lamp: a point that lights what faces it, falling off with distance, and
 * with a beam that narrows toward `aim`.
 */
export interface Lamp {
  x: number;
  y: number;
  z: number;
  /** Unit direction of the beam. */
  ax: number;
  ay: number;
  az: number;
  /** Cosine of the beam's half-angle; light fades out beyond it (-1 lights all around). */
  cone: number;
  /** How gradually (in cosine) the beam's edge fades. */
  soft: number;
  /** Light at 1 m (color channels 0..1). */
  r: number;
  g: number;
  b: number;
}

function lamp(
  x: number,
  y: number,
  z: number,
  toward: { x: number; y: number; z: number },
  cone: number,
  soft: number,
  color: readonly [number, number, number],
  power: number,
): Lamp {
  const dx = toward.x - x;
  const dy = toward.y - y;
  const dz = toward.z - z;
  const len = Math.hypot(dx, dy, dz);
  return {
    x,
    y,
    z,
    ax: dx / len,
    ay: dy / len,
    az: dz / len,
    cone,
    soft,
    r: (color[0] / 255) * power,
    g: (color[1] / 255) * power,
    b: (color[2] / 255) * power,
  };
}

const WARM_WHITE = [255, 236, 206] as const;
const HALL_WHITE = [255, 226, 186] as const;
const FLOOD_WHITE = [246, 244, 236] as const;

/**
 * The floodlights hidden behind the curtain, one over each target with a
 * narrow beam on it; the floodlights on the hall's front beam, aimed across
 * the range at the targets; the lamps along that beam that light the shooting
 * line; and the ceiling light over the archer.
 */
export const LAMPS: readonly Lamp[] = [
  ...TARGETS.map((t) =>
    lamp(
      t.x,
      RANGE_EAVE_Y - 0.12,
      MAKU_Z + 0.22,
      { x: t.x, y: TARGET_HEIGHT, z: t.z + 0.1 },
      0.9,
      0.12,
      WARM_WHITE,
      4.5,
    ),
  ),
  // Each covers its half of the target house, the beam's lower edge clear of the near lawn.
  ...[-1, 1].map((side) =>
    lamp(
      side * 2.4,
      BEAM_Y - 0.15,
      HALL_FRONT + 0.05,
      { x: side * 2.3, y: 0.75, z: TARGET_DISTANCE },
      0.993,
      0.004,
      FLOOD_WHITE,
      280,
    ),
  ),
  ...[-3.6, 0, 3.6].map((x) =>
    lamp(
      x,
      BEAM_Y - 0.32,
      HALL_FRONT - 0.05,
      { x, y: 0, z: HALL_FRONT + 3.5 },
      0.2,
      0.12,
      HALL_WHITE,
      1.6,
    ),
  ),
  lamp(0, CEILING_Y - 0.2, -0.8, { x: 0, y: 0, z: -0.8 }, -1, 0.12, HALL_WHITE, 2.4),
];

/** How much the lamps are on (0..1): at dusk, through the night, and on dark days. */
export function lampLevel(light: Lighting): number {
  return smoothstep(0.02, 0.35, light.lamps);
}
