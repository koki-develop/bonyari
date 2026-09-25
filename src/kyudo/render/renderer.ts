import { lerp, smoothstep } from "../../shared/core/math.ts";
import { Cover } from "../../shared/render/cover.ts";
import { PixelDisplay } from "../../shared/render/display.ts";
import { computeLighting } from "../../shared/render/lighting.ts";
import { Painter } from "../../shared/render/painter.ts";
import type { Pinhole } from "../../shared/render/pinhole.ts";
import { Shade } from "../../shared/render/shade.ts";
import { SkyRenderer } from "../../shared/render/sky.ts";
import { EYE, TARGET_DISTANCE } from "../sim/dojo.ts";
import type { Vec3 } from "../sim/geometry.ts";
import type { World } from "../sim/world.ts";
import { ArrowRenderer } from "./arrows.ts";
import { drawRidges, drawTrees, plantTrees, type Tree } from "./background.ts";
import { DepthSurface } from "./depth.ts";
import { BowRenderer } from "./bow.ts";
import { Illuminator } from "./illum.ts";
import { LAMPS, lampLevel } from "./lamps.ts";
import { computeLayout, type Layout } from "./layout.ts";
import { Particles } from "./particles.ts";
import { CameraRig, type Watch } from "./rig.ts";
import { SceneRenderer } from "./scene.ts";

/** Glow of the town around the dojo, lighting the undersides of clouds at night. */
const LIGHT_POLLUTION = 0.35;

/**
 * Composes a frame: sky, distant hills, the dojo, the trees around it, the
 * arrows in it, the weather, and the archer's own bow and
 * arrow over it all; then scales the art pixels up to the display.
 */
export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly display: PixelDisplay;
  layout!: Layout;
  private view!: DepthSurface;
  readonly rig = new CameraRig();
  private readonly shade = new Shade();
  private readonly painter = new Painter<Pinhole>();
  private readonly cover = new Cover();
  private readonly sky: SkyRenderer;
  private readonly scene = new SceneRenderer();
  private readonly arrows = new ArrowRenderer();
  private readonly particles: Particles;
  private readonly bow = new BowRenderer();
  private readonly illuminator = new Illuminator();
  private readonly trees: readonly Tree[];
  private readonly seed: number;
  private hiddenColumns = new Uint8Array(0);

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    this.display = new PixelDisplay(canvas);
    this.sky = new SkyRenderer(world.env);
    this.trees = plantTrees(world.seed);
    this.particles = new Particles(world.seed);
    this.seed = world.seed;
  }

  resize(deviceWidth: number, deviceHeight: number): void {
    if (this.display.matches(deviceWidth, deviceHeight)) {
      return;
    }
    const canvas = this.canvas;
    const layout = computeLayout(
      deviceWidth,
      deviceHeight,
      Math.min(canvas.clientWidth, canvas.clientHeight) || Math.min(deviceWidth, deviceHeight),
    );
    this.layout = layout;
    this.display.resize(deviceWidth, deviceHeight, layout.width, layout.height, layout.scale);
    this.view = new DepthSurface(layout.width, layout.height);
  }

  /** Converts a position in CSS pixels on the canvas to art pixels. */
  toArt(cssX: number, cssY: number): { x: number; y: number } {
    return this.display.toArt(cssX, cssY);
  }

  /** Art pixels on the screen per meter at the targets, now. */
  get pixelsPerMeterAtTarget(): number {
    return this.rig.cam.focal / TARGET_DISTANCE;
  }

  render(world: World, dt: number, time: number): void {
    const layout = this.layout;
    const view = this.view;
    const env = world.env;
    const archer = world.archer;
    this.rig.update(layout, archer, this.watch(world));
    const cam = this.rig.cam;

    const light = computeLighting(env, LIGHT_POLLUTION);
    this.shade.update(light, env.weather.state.visibility);
    const lamps = lampLevel(light);
    this.sky.update(dt, env);

    view.clearDepth();
    this.scene.update(cam, env, world.holes);
    // The dojo covers most of the view; the sky only needs its own pixels.
    this.cover.reset(view.width, view.height);
    for (let i = 0; i < view.width * view.height; i++) {
      this.cover.order[i] = this.scene.depthAt(i);
    }
    this.sky.render(view, cam, env, light, time, this.cover, this.hidden(view.width));
    drawRidges(view, cam, env, light, this.seed);
    this.scene.shade(view, cam, env, light, this.shade, lamps, this.trees, time);

    view.summarize();
    this.painter.begin(view, cam, this.shade, light, env, time, this.cover);
    drawTrees(this.painter, view, this.trees);

    const illum = this.illuminator;
    illum.begin(env, cam, light, this.shade, LAMPS, lamps);
    this.arrows.draw(
      view,
      cam,
      illum,
      world.arrows,
      world.flights,
      world.time,
      Math.min(dt, 1 / 30),
      world.clearing,
      world.time - world.clearedAt,
    );
    this.particles.render(view, cam, world, illum, time);

    // Over everything, the archer's own bow and arrow.
    const c = archer.closeness;
    view.z = -1;
    this.bow.draw(
      view,
      lerp(layout.restAnchor.x, layout.aimAnchor.x, c),
      lerp(layout.restAnchor.y, layout.aimAnchor.y, c),
      layout.bowFocal,
      archer,
      illum,
      time,
    );

    this.display.screen.blit(view, 0, 0);
    this.display.present();
  }

  /**
   * Where the eye settles after a release: the arrow's nock end where it
   * struck, from a moment after the strike until the bow comes down.
   */
  private watch(world: World): Watch {
    const archer = world.archer;
    const none: Watch = { x: 0, y: 0, amount: 0 };
    if (archer.phase !== "release" && archer.phase !== "lower") {
      return none;
    }
    // The most recent arrow, in the air or at rest.
    const flight = world.flights[world.flights.length - 1];
    const impact = flight?.impact;
    let point: Vec3 | null = null;
    let since = 0;
    if (flight && impact) {
      since = flight.age - impact.time;
      point = impact.point;
    } else if (!flight && world.arrows.length > 0) {
      const a = world.arrows[world.arrows.length - 1];
      since = world.time - a.landedAt;
      point = { x: a.x - a.dx * 0.25, y: a.y - a.dy * 0.25, z: a.z - a.dz * 0.25 };
    }
    if (!point || since < 0 || point.z < 1) {
      return none;
    }
    // On the plane of the targets, along the eye's line to the point.
    const s = TARGET_DISTANCE / point.z;
    return {
      x: point.x * s,
      y: EYE + (point.y - EYE) * s,
      amount: smoothstep(0.05, 0.7, since),
    };
  }

  /** Columns where covered sky may be skipped: all of them, as nothing here mirrors the sky. */
  private hidden(width: number): Uint8Array {
    if (this.hiddenColumns.length !== width) {
      this.hiddenColumns = new Uint8Array(width).fill(1);
    }
    return this.hiddenColumns;
  }
}
