import { hex, mix, type RGB } from "../../shared/core/color.ts";
import type { fieldLook } from "../sim/farming.ts";
import { SOIL, STUBBLE } from "./materials.ts";

/** Young green shoots, the full green of the growing crop, and each crop ripe. */
const SHOOTS: RGB = hex("#8aa24e");
const GREEN: RGB = hex("#5f8c3c");
const RIPE: Record<string, RGB> = {
  wheat: hex("#d4b152"),
  barley: hex("#dcc67e"),
  oats: hex("#c9c486"),
  flax: hex("#a08a58"),
};
/** Flax in flower, blue over the green. */
const FLAX_FLOWER: RGB = hex("#7a8ac8");
/** A field left fallow grows over with weeds; one trampled or burned goes dark. */
const FALLOW: RGB = hex("#8c8a56");
const SPOILED: RGB = hex("#4e4436");

/** The color of a field's surface for its state and the time of year (see `fieldLook`). */
export function cropColor(
  look: ReturnType<typeof fieldLook>,
  growth: number,
  ripeness: number,
): RGB {
  let c: RGB;
  switch (look.state) {
    case "soil":
      // Plowed, going darker and furrowed as the sowing gets on.
      c = mix(STUBBLE, SOIL, 0.4 + 0.6 * Math.min(1, look.work + 0.3));
      break;
    case "stubble":
      c = STUBBLE;
      break;
    case "fallow":
      c = FALLOW;
      break;
    case "growing": {
      const green = mix(SHOOTS, GREEN, Math.min(1, growth * 1.4));
      c = mix(mix(SOIL, green, Math.min(1, growth * 1.6)), RIPE[look.crop], ripeness);
      if (look.crop === "flax" && ripeness > 0.1 && ripeness < 0.6) {
        c = mix(c, FLAX_FLOWER, 0.55);
      }
      break;
    }
  }
  return mix(c, SPOILED, look.spoiled * 0.8);
}
