import type { RGB } from "../core/color.ts";
import { bump, clamp01 } from "../core/math.ts";
import { Surface } from "../core/surface.ts";
import { formatClock, SEASONS } from "../sim/clock.ts";
import { crossingActive } from "../sim/crossing.ts";
import { type Crossing, makeTerrainScratch, type Station } from "../sim/route.ts";
import type { Shell } from "../sim/spectacle.ts";
import { type Car, LANE_OFFSET, type OncomingTrain } from "../sim/traffic.ts";
import type { World } from "../sim/world.ts";
import { Camera, EYE_ABOVE_RAIL } from "./camera.ts";
import { drawShell } from "./fireworks.ts";
import { Glass } from "./glass.ts";
import { GroundRenderer } from "./ground.ts";
import { Interior } from "./interior.ts";
import { computeLayout, type Layout } from "./layout.ts";
import { computeLighting, type Lighting } from "./lighting.ts";
import { drawCrossing, drawWaitingCar } from "./near/crossing.ts";
import {
  drawPillars,
  drawPlatform,
  drawPlatformBack,
  drawPlatformItem,
  itemLateral,
  PLATFORM_BACK,
  type PlatformItem,
  platformItems,
} from "./near/station.ts";
import {
  BARRIER_LATERAL,
  drawBarrier,
  drawPolesAndWires,
  drawRailing,
  drawTruss,
  drawTunnel,
  POLE_LATERAL_DOUBLE,
  POLE_LATERAL_SINGLE,
  POLE_SPACING,
  TRUSS_LATERAL_DOUBLE,
  TRUSS_LATERAL_SINGLE,
  TUNNEL_LATERAL,
} from "./near/trackside.ts";
import { drawCar, drawOncoming, ONCOMING_LATERAL } from "./near/vehicles.ts";
import { Painter } from "./painter.ts";
import { Precipitation } from "./precipitation.ts";
import { RidgeRenderer } from "./ridges.ts";
import {
  drawApartment,
  drawBarn,
  drawCluster,
  drawDryingRack,
  drawFactory,
  drawGreenhouse,
  drawHighrise,
  drawHouse,
  drawShop,
  drawShrine,
  drawVending,
} from "./scenery/buildings.ts";
import { drawBoat, drawIsland, drawLighthouse } from "./scenery/coast.ts";
import { drawPylon, drawRoadPole, drawStreetLamp } from "./scenery/infra.ts";
import { placeScenery, type Scenery } from "./scenery/placement.ts";
import { drawBamboo, drawBroadleaf, drawCedar, drawPine, drawSakura } from "./scenery/trees.ts";
import { Shade } from "./shade.ts";
import { SkyRenderer } from "./sky.ts";
import { TerrainTable } from "./terrain-table.ts";

const TERRAIN = makeTerrainScratch();
/** Half-length (m) over which the view heading blends between sections. */
const HEADING_BLEND = 900;

type Drawable =
  | { lateral: number; kind: "scenery"; item: Scenery }
  | { lateral: number; kind: "car"; car: Car }
  | { lateral: number; kind: "shell"; shell: Shell }
  | { lateral: number; kind: "poles" }
  | { lateral: number; kind: "barrier" }
  | { lateral: number; kind: "tunnels" }
  | { lateral: number; kind: "bridge"; index: number }
  | { lateral: number; kind: "platformBack"; station: Station }
  | { lateral: number; kind: "platform"; station: Station }
  | { lateral: number; kind: "pillars"; station: Station }
  | { lateral: number; kind: "platformItem"; item: PlatformItem }
  | { lateral: number; kind: "crossing"; crossing: Crossing }
  | { lateral: number; kind: "waitingCar"; crossing: Crossing }
  | { lateral: number; kind: "oncoming"; train: OncomingTrain };

export interface RenderOptions {
  /** Car lights on (0..1, eased). */
  lampOn: number;
}

/**
 * Composes a frame: the outside view (sky, ridges, ground, scenery, trackside
 * structures, weather), then the glass, then the lit interior, and finally
 * scales the art pixels up to the display.
 */
export class Renderer {
  private readonly display: HTMLCanvasElement;
  private readonly displayCtx: CanvasRenderingContext2D;
  private readonly art: HTMLCanvasElement;
  private readonly artCtx: CanvasRenderingContext2D;
  layout!: Layout;
  private screen!: Surface;
  private view!: Surface;
  private image!: ImageData;
  interior!: Interior;
  readonly glass: Glass;
  private readonly cam = new Camera();
  private readonly shade = new Shade();
  private readonly stationShade = new Shade();
  private readonly painter = new Painter();
  private readonly sky: SkyRenderer;
  private readonly ridges = new RidgeRenderer();
  private readonly ground = new GroundRenderer();
  private readonly table = new TerrainTable();
  private readonly precipitation: Precipitation;
  private readonly scenery: Scenery[] = [];
  private readonly drawables: Drawable[] = [];
  private readonly stationItems = new Map<Station, PlatformItem[]>();
  private offsetX = 0;
  private offsetY = 0;
  private deviceWidth = 0;
  private deviceHeight = 0;
  /** Duration (s) of the displayed frame, capped; sets the motion blur. */
  private frameDt = 1 / 60;
  /** Average color of the view in the last frame. */
  outside: RGB = [0, 0, 0];

  constructor(display: HTMLCanvasElement, world: World) {
    this.display = display;
    const ctx = display.getContext("2d");
    this.art = document.createElement("canvas");
    const artCtx = this.art.getContext("2d");
    if (!ctx || !artCtx) {
      throw new Error("Canvas 2D is not available");
    }
    this.displayCtx = ctx;
    this.artCtx = artCtx;
    this.sky = new SkyRenderer(world);
    this.precipitation = new Precipitation(world.seed);
    this.glass = new Glass(world.seed);
  }

  resize(deviceWidth: number, deviceHeight: number): void {
    if (deviceWidth === this.deviceWidth && deviceHeight === this.deviceHeight) {
      return;
    }
    this.deviceWidth = deviceWidth;
    this.deviceHeight = deviceHeight;
    this.display.width = deviceWidth;
    this.display.height = deviceHeight;
    const layout = computeLayout(deviceWidth, deviceHeight);
    this.layout = layout;
    this.screen = new Surface(layout.width, layout.height);
    this.view = new Surface(layout.window.w, layout.window.h);
    this.art.width = layout.width;
    this.art.height = layout.height;
    this.image = new ImageData(
      new Uint8ClampedArray(this.screen.data.buffer),
      layout.width,
      layout.height,
    );
    this.interior = new Interior(layout);
    this.glass.resize(layout.window.w, layout.window.h);
    this.precipitation.resize(layout.window.w, layout.window.h);
    this.cam.configure(layout.window.w, layout.window.h, layout.horizon, layout.focal);
    this.offsetX = Math.floor((layout.width * layout.scale - deviceWidth) / 2);
    this.offsetY = Math.floor((layout.height * layout.scale - deviceHeight) / 2);
  }

  /** Converts a position in CSS pixels on the canvas to art pixels. */
  toArt(cssX: number, cssY: number): { x: number; y: number } {
    const rect = this.display.getBoundingClientRect();
    const dx = (cssX / rect.width) * this.deviceWidth;
    const dy = (cssY / rect.height) * this.deviceHeight;
    return {
      x: (dx + this.offsetX) / this.layout.scale,
      y: (dy + this.offsetY) / this.layout.scale,
    };
  }

  render(world: World, dt: number, time: number, options: RenderOptions): void {
    const train = world.train;
    const cam = this.cam;
    this.table.update(world.route, train.pos);
    cam.pos = train.pos;
    cam.rail = this.table.sample(this.table.elevation, train.pos);
    cam.eye = cam.rail + EYE_ABOVE_RAIL;
    // The line curves gently between sections, turning the sky with it.
    cam.heading = world.route.terrain(train.pos, TERRAIN, HEADING_BLEND).heading;
    this.frameDt = Math.min(dt, 1 / 30);
    cam.travel = train.speed * this.frameDt;

    const light = computeLighting(world);
    const visibility = world.weather.state.visibility;
    this.shade.update(light, visibility);
    this.stationShade.update(this.platformLighting(light), visibility);
    this.sky.update(dt, world);

    const view = this.view;
    this.sky.render(view, cam, world, light, time);
    this.ridges.render(view, cam, world, light, this.shade);
    this.ground.render(view, cam, world, light, this.table, this.ridges.groundLimit, time);
    this.painter.begin(view, cam, this.shade, light, world, time);
    this.collectDrawables(world);
    for (const d of this.drawables) {
      this.draw(d, world, light, options, time);
    }
    const shelter = this.tunnelCover(world);
    this.precipitation.render(view, cam, world, light, dt, time, shelter);

    this.outside = averageColor(view);
    const w = world.weather.state;
    const season = world.season;
    const hour = world.clock.hour;
    const condensation = clamp01(
      (0.5 - season.warmth) * 0.9 +
        w.rain * 0.35 +
        w.snow * 0.25 +
        w.mist * 0.25 +
        bump(hour, 6, 3, 2) * 0.15,
    );
    this.glass.update(dt, {
      speed: train.speed,
      rain: w.rain * (1 - shelter),
      snow: w.snow * (1 - shelter),
      condensation,
    });

    const jolt = train.jolt(world.route.terrain(train.pos, TERRAIN).jointed);
    const joltPx = jolt > 0.45 ? 1 : 0;
    const lampTint = options.lampOn * 0.22;
    const fogTint: RGB = [
      255 * lampTint * 0.95 + this.outside[0] * 0.3,
      222 * lampTint * 0.95 + this.outside[1] * 0.3,
      178 * lampTint * 0.95 + this.outside[2] * 0.3,
    ];
    this.glass.composite(this.screen, view, this.layout.window, joltPx, fogTint);

    this.interior.render(this.screen, {
      lampOn: options.lampOn,
      outside: this.outside,
      jolt: joltPx,
      traction: train.traction,
      time: formatClock(world.clock.minuteOfDay),
      seasonIndex: SEASONS.indexOf(world.clock.season),
      seconds: time,
      sillSnow: this.glass.sillSnow,
    });

    this.artCtx.putImageData(this.image, 0, 0);
    const ctx = this.displayCtx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.art,
      -this.offsetX,
      -this.offsetY,
      this.layout.width * this.layout.scale,
      this.layout.height * this.layout.scale,
    );
  }

  /** How much of the view is inside a tunnel (sheltered from rain and snow). */
  private tunnelCover(world: World): number {
    const t = world.route.tunnelAt(world.train.pos);
    return t ? clamp01(Math.min(world.train.pos - t.start, t.end - world.train.pos) / 20) : 0;
  }

  /** Platforms are lit by their own lamps after dark. */
  private platformLighting(light: Lighting): Lighting {
    const lift = light.lamps * 0.75;
    return {
      ...light,
      ambient: [
        Math.max(light.ambient[0], lift * 0.95),
        Math.max(light.ambient[1], lift * 0.97),
        Math.max(light.ambient[2], lift * 1.0),
      ],
    };
  }

  private collectDrawables(world: World): void {
    const out = this.drawables;
    out.length = 0;
    const cam = this.cam;
    const route = world.route;
    const train = world.train;
    const table = this.table;

    placeScenery(this.scenery, cam, world, table);
    for (const item of this.scenery) {
      out.push({ lateral: item.lateral, kind: "scenery", item });
    }
    for (const car of world.traffic.cars) {
      const road = table.sample(table.road, car.along);
      if (road < 600) {
        out.push({ lateral: road + (car.dir > 0 ? LANE_OFFSET : -LANE_OFFSET), kind: "car", car });
      }
    }
    for (const shell of world.spectacle.shells) {
      out.push({ lateral: shell.lateral, kind: "shell", shell });
    }

    const twin = table.at(table.doubleTrack, train.pos) > 0.5;
    const [n0, n1] = cam.alongRange(8, 20);
    out.push({ lateral: twin ? POLE_LATERAL_DOUBLE : POLE_LATERAL_SINGLE, kind: "poles" });
    if (table.at(table.barrier, n0) > 0.1 || table.at(table.barrier, n1) > 0.1) {
      out.push({ lateral: BARRIER_LATERAL, kind: "barrier" });
    }
    if (route.tunnelsIn(n0 - 20, n1 + 20).length > 0) {
      out.push({ lateral: TUNNEL_LATERAL, kind: "tunnels" });
    }
    route.bridgesIn(n0 - 10, n1 + 10).forEach((_, index) => {
      out.push({
        lateral: twin ? TRUSS_LATERAL_DOUBLE : TRUSS_LATERAL_SINGLE,
        kind: "bridge",
        index,
      });
    });

    const [s0, s1] = cam.alongRange(30, 20);
    const stations = route.stationsIn(s0, s1);
    for (const st of stations) {
      out.push({ lateral: PLATFORM_BACK + 0.01, kind: "platformBack", station: st });
      out.push({ lateral: PLATFORM_BACK, kind: "platform", station: st });
      out.push({ lateral: 5.2, kind: "pillars", station: st });
      let items = this.stationItems.get(st);
      if (!items) {
        items = platformItems(st, world.clock.hour);
        this.stationItems.set(st, items);
      }
      for (const item of items) {
        out.push({ lateral: itemLateral(item, train, world.time), kind: "platformItem", item });
      }
    }
    for (const st of this.stationItems.keys()) {
      if (st.end < train.pos - 2000) {
        this.stationItems.delete(st);
      }
    }

    const [c0, c1] = cam.alongRange(12, 30);
    for (const c of route.crossingsIn(c0, c1)) {
      out.push({ lateral: twin ? 6.8 : 3.3, kind: "crossing", crossing: c });
      if (c.waitingCar && crossingActive(c, train.pos)) {
        out.push({ lateral: 9.5, kind: "waitingCar", crossing: c });
      }
    }
    for (const tr of world.traffic.trains) {
      out.push({ lateral: ONCOMING_LATERAL, kind: "oncoming", train: tr });
    }
    out.sort((a, b) => b.lateral - a.lateral);
  }

  private draw(
    d: Drawable,
    world: World,
    light: Lighting,
    options: RenderOptions,
    time: number,
  ): void {
    const p = this.painter;
    const cam = this.cam;
    const view = this.view;
    switch (d.kind) {
      case "scenery":
        drawScenery(p, d.item);
        return;
      case "car":
        drawCar(p, d.car, d.lateral);
        return;
      case "shell":
        drawShell(p, d.shell);
        return;
      case "poles": {
        const route = world.route;
        drawPolesAndWires(view, cam, this.shade, d.lateral, (i) => {
          const along = i * POLE_SPACING + 7;
          return (
            !route.tunnelAt(along) && !route.bridgeAt(along, 30) && !route.stationAt(along, 10)
          );
        });
        return;
      }
      case "barrier":
        drawBarrier(view, cam, this.shade, (along) => this.table.sample(this.table.barrier, along));
        return;
      case "tunnels": {
        const [a, b] = cam.alongRange(TUNNEL_LATERAL, 40);
        drawTunnel(
          view,
          cam,
          this.shade,
          light,
          world.route.tunnelsIn(a - 20, b + 20),
          options.lampOn,
        );
        return;
      }
      case "bridge": {
        const [a, b] = cam.alongRange(8, 20);
        const bridge = world.route.bridgesIn(a - 10, b + 10)[d.index];
        if (bridge) {
          if (bridge.kind === "truss") {
            drawTruss(view, cam, this.shade, bridge, d.lateral);
          } else {
            drawRailing(view, cam, this.shade, bridge, d.lateral);
          }
        }
        return;
      }
      case "platformBack":
        drawPlatformBack(view, cam, this.stationShade, d.station);
        return;
      case "platform":
        drawPlatform(view, cam, this.stationShade, d.station, light.lamps);
        return;
      case "pillars":
        drawPillars(view, cam, this.stationShade, d.station);
        return;
      case "platformItem": {
        p.shade = this.stationShade;
        drawPlatformItem(p, d.item, world.train, world.time);
        p.shade = this.shade;
        return;
      }
      case "crossing":
        drawCrossing(p, d.crossing, d.lateral, world.train.pos, time);
        return;
      case "waitingCar":
        drawWaitingCar(p, d.crossing, d.lateral, world.train.pos);
        return;
      case "oncoming": {
        drawOncoming(
          view,
          cam,
          this.shade,
          light,
          d.train,
          (d.train.speed + world.train.speed) * this.frameDt,
        );
        return;
      }
    }
  }
}

function drawScenery(p: Painter, o: Scenery): void {
  switch (o.kind) {
    case "house":
      return drawHouse(p, o);
    case "apartment":
      return drawApartment(p, o);
    case "shop":
      return drawShop(p, o);
    case "factory":
      return drawFactory(p, o);
    case "barn":
      return drawBarn(p, o);
    case "greenhouse":
      return drawGreenhouse(p, o);
    case "shrine":
      return drawShrine(p, o);
    case "vending":
      return drawVending(p, o);
    case "dryingRack":
      return drawDryingRack(p, o);
    case "highrise":
      return drawHighrise(p, o);
    case "cluster":
      return drawCluster(p, o);
    case "broadleaf":
      return drawBroadleaf(p, o);
    case "sakura":
      return drawSakura(p, o);
    case "cedar":
      return drawCedar(p, o);
    case "bamboo":
      return drawBamboo(p, o);
    case "pine":
      return drawPine(p, o);
    case "roadPole":
      return drawRoadPole(p, o);
    case "streetLamp":
      return drawStreetLamp(p, o);
    case "pylon":
      return drawPylon(p, o);
    case "boat":
      return drawBoat(p, o);
    case "island":
      return drawIsland(p, o);
    case "lighthouse":
      return drawLighthouse(p, o);
  }
}

function averageColor(view: Surface): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const stepX = Math.max(1, Math.floor(view.width / 16));
  const stepY = Math.max(1, Math.floor(view.height / 10));
  for (let y = stepY >> 1; y < view.height; y += stepY) {
    for (let x = stepX >> 1; x < view.width; x += stepX) {
      const c = view.data[y * view.width + x];
      r += c & 255;
      g += (c >>> 8) & 255;
      b += (c >>> 16) & 255;
      n++;
    }
  }
  return n > 0 ? [r / n, g / n, b / n] : [0, 0, 0];
}
