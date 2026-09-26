import { hash2 } from "../../shared/core/random.ts";
import { rectCorners } from "../sim/geometry.ts";
import { STANDING } from "../sim/forest.ts";
import type { World } from "../sim/world.ts";
import type { ShadowMap } from "./shadow.ts";
import { topAt } from "./structures.ts";
import { followsFoliage } from "./trees.ts";

/** Farthest (m) any one thing's shadow-casting top reaches from its middle. */
const REACH = 16;
/** Share of a bare broadleaf crown that still casts shade: trunk, boughs and twigs. */
const BARE_SHADE = 0.12;

/**
 * Raises onto the shadow map everything standing over the box [x0, x1] ×
 * [y0, y1], after lowering it back to the bare ground: the crowns of the
 * trees, and the buildings by the heights of their roofs.
 */
export function castShadows(
  shadow: ShadowMap,
  world: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  shadow.reset(x0, y0, x1, y1);
  const forest = world.forest;
  forest.inBox(x0 - 8, y0 - 8, x1 + 8, y1 + 8, (tree) => {
    if (forest.state[tree.id] !== STANDING) {
      return;
    }
    const r = tree.radius;
    const conifer = tree.kind === "spruce";
    // Bare boughs let most of the sun through: a dappling of shade, thickening as the leaves come.
    const cover = followsFoliage(tree) ? BARE_SHADE + (1 - BARE_SHADE) * shadow.leaves ** 2 : 1;
    shadow.raise(
      Math.max(x0, tree.x - r),
      Math.max(y0, tree.y - r),
      Math.min(x1, tree.x + r),
      Math.min(y1, tree.y + r),
      (x, y) => {
        const d = Math.hypot(x - tree.x, y - tree.y) / r;
        if (d > 1 || (cover < 1 && hash2(Math.round(x * 2), Math.round(y * 2)) > cover)) {
          return Number.NaN;
        }
        return tree.z + tree.height * (conifer ? 1 - d * 0.85 : 1 - d * d * 0.4);
      },
    );
  });
  for (const b of world.town.buildings) {
    if (
      Math.abs(b.rect.x - (x0 + x1) / 2) > (x1 - x0) / 2 + REACH ||
      Math.abs(b.rect.y - (y0 + y1) / 2) > (y1 - y0) / 2 + REACH
    ) {
      continue;
    }
    const corners = rectCorners(b.rect, 0.5);
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let by0 = Infinity;
    let by1 = -Infinity;
    for (const c of corners) {
      bx0 = Math.min(bx0, c.x);
      bx1 = Math.max(bx1, c.x);
      by0 = Math.min(by0, c.y);
      by1 = Math.max(by1, c.y);
    }
    const fx = Math.sin(b.rect.angle);
    const fy = -Math.cos(b.rect.angle);
    shadow.raise(
      Math.max(x0, bx0),
      Math.max(y0, by0),
      Math.min(x1, bx1),
      Math.min(y1, by1),
      (x, y) => {
        const dx = x - b.rect.x;
        const dy = y - b.rect.y;
        // Frame coordinates: across (right, seen from the front) and back.
        const a = dx * -fy + dy * fx;
        const back = -(dx * fx + dy * fy);
        const top = topAt(b, a, back);
        return Number.isNaN(top) ? Number.NaN : b.base + top;
      },
    );
  }
}
