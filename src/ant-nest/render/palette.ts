import { hex, type RGB } from "../../shared/core/color.ts";

/** The soil's horizons: dark topsoil, the orange-brown loam below, pale clay deeper still. */
export const TOPSOIL: RGB = hex("#5f4634");
export const LOAM: RGB = hex("#a4734a");
export const CLAY: RGB = hex("#b89a6c");
/** Rusty mottles in the clay, and the black specks of manganese. */
export const RUST: RGB = hex("#b86a3c");
export const MANGANESE: RGB = hex("#3a2c24");
/** Fine roots, pale in the soil. */
export const ROOT: RGB = hex("#c9ad80");
export const STONES: readonly RGB[] = [
  hex("#8d867c"),
  hex("#9c8f7a"),
  hex("#6f7478"),
  hex("#a39a8c"),
];

/**
 * A dug hole's back wall: the soil's color dusted pale with the fine earth
 * the ants pack their walls with, a little in shade.
 */
export const HOLLOW = 0.86;
export const DUST: RGB = [198, 172, 140];
export const DUSTING = 0.45;

/** The ants: black, with a dull sheen; the young are amber until they darken. */
export const ANT_BODY: RGB = [40, 33, 30];
export const ANT_LEG: RGB = [66, 52, 43];
export const ANT_CALLOW: RGB = [168, 122, 80];
export const ANT_SHEEN: RGB = [170, 164, 160];
export const WING: RGB = [214, 220, 226];
export const WING_VEIN: RGB = [120, 104, 86];

/** Brood: eggs and larvae creamy white, cocoons buff with a dark spot at one end. */
export const EGG: RGB = [240, 234, 214];
export const LARVA: RGB = [236, 230, 212];
export const COCOON: RGB = [214, 184, 132];
export const COCOON_SPOT: RGB = [92, 64, 44];

/** A crumb of bread: crust and crumb. */
export const CRUST: RGB = hex("#a86a32");
export const CRUMB: RGB = hex("#ecd4a2");
