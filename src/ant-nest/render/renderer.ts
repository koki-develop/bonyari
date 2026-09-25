import type { RGB } from "../../shared/core/color.ts";
import { clamp, clamp01, DEG } from "../../shared/core/math.ts";
import { Cover } from "../../shared/render/cover.ts";
import { PixelDisplay } from "../../shared/render/display.ts";
import { computeLighting, type Lighting } from "../../shared/render/lighting.ts";
import { Painter } from "../../shared/render/painter.ts";
import { Pinhole } from "../../shared/render/pinhole.ts";
import { Shade } from "../../shared/render/shade.ts";
import { SkyRenderer } from "../../shared/render/sky.ts";
import type { World } from "../sim/world.ts";
import { drawAnts } from "./ants.ts";
import type { Frame } from "./frame.ts";
import { drawHills, drawLand, Meadow, plantLand } from "./landscape.ts";
import { computeLayout, type Layout } from "./layout.ts";
import { Particles } from "./particles.ts";
import { drawPlants } from "./plants.ts";
import { SoilPainter } from "./soil.ts";
import { AntSprites } from "./sprites.ts";
import { drawBrood, drawGroundItems, drawNestItems } from "./things.ts";
import { drawSnowCover, drawWeather } from "./weather.ts";

/** Focal length (art px) that shows the cut, a quarter meter off, at a pixel to the millimeter. */
const FOCAL = 250;
/** Height (mm) of the eye above the ground. */
const EYE = 30;
/** The way the view looks: west-northwest, so summer sunsets set in it. */
const HEADING = 112.5 * DEG;
/** Glow of the town far off, on the undersides of the clouds at night. */
const LIGHT_POLLUTION = 0.12;
/** The least light things above the ground get at night: the eye grown used to the dark. */
const NIGHT: RGB = [0.36, 0.39, 0.52];
/**
 * The light in the ground: the same by day and by night, so the nest is
 * always there to watch.
 */
const UNDERGROUND: RGB = [0.96, 0.95, 0.93];

/**
 * Composes a frame: the sky and the land far off, the grass behind the cut,
 * the cut face of the soil with the nest in it, and the ants, brood and
 * crumbs; then scales the art pixels up to the display.
 */
export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly display: PixelDisplay;
  layout!: Layout;
  private readonly cam = new Pinhole();
  private readonly shade = new Shade();
  private readonly cover = new Cover();
  private readonly sky: SkyRenderer;
  private readonly soil = new SoilPainter();
  private readonly sprites = new AntSprites();
  private readonly painter = new Painter<Pinhole>();
  private readonly meadow = new Meadow();
  private readonly particles: Particles;
  private readonly land: ReturnType<typeof plantLand>;
  private readonly seed: number;
  private hiddenColumns = new Uint8Array(0);
  /** Rows the view is dragged down by (negative: up), on screens too short for the whole nest. */
  private pan = 0;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    this.display = new PixelDisplay(canvas);
    this.sky = new SkyRenderer(world.env);
    this.land = plantLand(world.seed);
    this.particles = new Particles(world.seed);
    this.seed = world.seed;
  }

  resize(deviceWidth: number, deviceHeight: number): void {
    if (this.display.matches(deviceWidth, deviceHeight)) {
      return;
    }
    const layout = computeLayout(deviceWidth, deviceHeight, this.canvas.clientWidth || deviceWidth);
    this.layout = layout;
    this.display.resize(deviceWidth, deviceHeight, layout.width, layout.height, layout.scale);
    this.pan = clamp(this.pan, -layout.panDown, layout.panUp);
    // The soil is kept for every row the view can be dragged to.
    this.soil.resize(layout.width, layout.cx, layout.ground - layout.panDown - layout.height);
    this.hiddenColumns = new Uint8Array(layout.width).fill(1);
  }

  /** Takes note of what happened in the world's last update, for what it sets moving. */
  observe(world: World): void {
    this.particles.observe(world);
  }

  /** Drags the view by `rows` art pixels (positive: down, toward the sky). */
  panBy(rows: number): void {
    const l = this.layout;
    this.pan = clamp(this.pan + rows, -l.panDown, l.panUp);
  }

  /** Screen row of the ground level now. */
  private get ground(): number {
    return this.layout.ground + Math.round(this.pan);
  }

  /** The section position (mm) under a point in CSS pixels on the canvas. */
  toWorld(cssX: number, cssY: number): { x: number; y: number } {
    const art = this.display.toArt(cssX, cssY);
    return { x: art.x - this.layout.cx, y: this.ground - art.y };
  }

  render(world: World, dt: number, time: number): void {
    const layout = this.layout;
    const view = this.display.screen;
    const env = world.env;
    const ground = this.ground;
    const cam = this.cam;
    cam.configure(layout.width, layout.height, ground - EYE, FOCAL);
    cam.cx = layout.cx;
    cam.pos = 0;
    cam.eye = EYE / 1000;
    cam.heading = HEADING;

    const lighting = computeLighting(env, LIGHT_POLLUTION);
    this.shade.update(lighting, env.weather.state.visibility);
    this.sky.update(dt, env);
    this.cover.reset(view.width, view.height);
    this.sky.render(view, cam, env, lighting, time, this.cover, this.hiddenColumns);

    const frame: Frame = {
      view,
      cx: layout.cx,
      ground,
      time,
      light: this.faceLight(world, lighting),
      lighting,
      cam,
    };
    drawHills(view, cam, env, lighting, this.seed);
    this.painter.begin(view, cam, this.shade, lighting, env, time, this.cover);
    drawLand(this.painter, this.land);
    this.meadow.update(world, cam, this.shade, lighting, ground, view, dt, time);
    this.meadow.draw(view);
    this.soil.update(world);
    this.soil.draw(view, world, ground, UNDERGROUND, frame.light, time);
    drawSnowCover(frame, world);
    const inside: Frame = { ...frame, light: UNDERGROUND };
    drawNestItems(inside, world);
    drawBrood(inside, world);
    drawAnts(inside, world, this.sprites, "nest");
    drawPlants(frame, world);
    drawGroundItems(frame, world);
    drawAnts(frame, world, this.sprites, "outside");
    drawWeather(frame, world);
    this.particles.draw(frame, UNDERGROUND, world, dt);
    this.display.present();
  }

  /**
   * The light on the cut face: the sky's, plus the sun when it is behind the
   * viewer; never quite dark, as eyes get used to the night.
   */
  private faceLight(world: World, lighting: Lighting): RGB {
    const env = world.env;
    const sun = this.cam.toCamera(env.sky.sun);
    const behind = clamp01(-sun.forward) * clamp01(sun.up * 4);
    const direct = lighting.direct * behind * 0.3;
    const a = lighting.ambient;
    return [
      Math.max(NIGHT[0], a[0] * 0.92 + direct),
      Math.max(NIGHT[1], a[1] * 0.92 + direct * 0.95),
      Math.max(NIGHT[2], a[2] * 0.92 + direct * 0.85),
    ];
  }
}
