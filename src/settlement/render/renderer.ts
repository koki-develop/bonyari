import { Cover } from "../../shared/render/cover.ts";
import { PixelDisplay } from "../../shared/render/display.ts";
import { computeLighting, type Lighting } from "../../shared/render/lighting.ts";
import { Pinhole } from "../../shared/render/pinhole.ts";
import { SkyRenderer } from "../../shared/render/sky.ts";
import { Surface } from "../../shared/core/surface.ts";
import { WORLD } from "../sim/terrain.ts";
import type { World } from "../sim/world.ts";
import { pack, type RGB } from "../../shared/core/color.ts";
import { fieldLook } from "../sim/farming.ts";
import { Actors, type FrameInfo } from "./actors.ts";
import { BACKDROP_FOCAL, drawBackdrop } from "./backdrop.ts";
import { castShadows } from "./casters.ts";
import { cropColor } from "./crops.ts";
import { drawAir, Effects } from "./effects.ts";
import { applyLights, gatherLamps } from "./lights.ts";
import { FIELD_OWNER } from "./owners.ts";
import { NOTHING, TILE, TILE_SHIFT, type Tile, TileStore } from "./gbuffer.ts";
import { computeLayout, type Extent } from "./layout.ts";
import { gyOf, HEADING, S, toWorld, yAt } from "./projection.ts";
import { Scene } from "./scene.ts";
import { ShadowMap } from "./shadow.ts";
import { Shader } from "./shading.ts";
import { FenceStructure } from "./fences.ts";
import { lampsLit, placeStreetLamps, type StreetLamp } from "./streetlamps.ts";
import { BuildingStructure } from "./structures.ts";
import { BUILDING_OWNER } from "./owners.ts";
import { Viewport } from "./viewport.ts";
import { WaterShader } from "./water.ts";

/** Glow of the town on the undersides of the clouds at night: only candles and hearths. */
const LIGHT_POLLUTION = 0.03;
/** Art pixel rows of sky kept above the highest point of the far ridge. */
const SKY_ROWS = 150;
/** Most tiles kept drawn at once. */
const TILE_LIMIT = 900;
/** Milliseconds a frame may spend shading tiles afresh once all the tiles in view have colors. */
const SHADE_BUDGET = 3;
/**
 * Milliseconds a frame may spend drawing tiles in view. A tile is begun only if it should end
 * within the budget, going by how long the last one took; still, one a frame is always drawn.
 */
const DRAW_BUDGET = 8;
/** Milliseconds a frame may spend on tiles just out of view, and how many tiles out they go. */
const PREFETCH_BUDGET = 4;
const AHEAD = 2;
/** Steps the lamps' brightness is followed in (each a reshading of the ground). */
const LAMP_STEPS = 8;
/** Frames between paintings of the sky and the far mountains while the view stays put. */
const BACKDROP_EVERY = 3;
/** Color of the ground shown where a tile is not drawn yet. */
const PLACEHOLDER: RGB = [74, 84, 56];
/** Least change (radians) in the sun's direction worth sweeping the shadows again for. */
const SUN_STEP = 0.004;
/** Height of the sun's direction at and below which it lights nothing (as `ShadowMap.sweep`). */
const SUN_DOWN = 0.01;
/** Depth (m, front to back) of the world whose shadows are cast again each frame as the leaves change. */
const RECAST_STRIP = 40;

/**
 * Composes a frame: the world, drawn once into tiles and kept, shaded under
 * the light of the moment a few tiles at a time; the sky and the far
 * mountains where the world leaves off; the river shaded afresh each frame.
 * Then scales the art pixels up to the display.
 */
export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly display: PixelDisplay;
  readonly viewport = new Viewport();
  private readonly store = new TileStore(TILE_LIMIT);
  readonly scene: Scene;
  readonly shadow: ShadowMap;
  private readonly shader: Shader;
  private readonly water = new WaterShader();
  private readonly sky: SkyRenderer;
  private readonly cam = new Pinhole();
  private readonly cover = new Cover();
  private hidden = new Uint8Array(0);
  /** The sky and far mountains as last painted, the frame they were, and where the view was. */
  private backdrop: Surface | null = null;
  private backdropFrame = -1;
  private backdropAt = { x: 0, y: 0 };
  /** The part of the world the view may show, and the row the backdrop's horizon lies on. */
  readonly extent: Extent;
  private readonly horizon: number;
  private frame = 0;
  /** The sun's direction the shadows were last swept for, and whether they must be swept anew. */
  private sunSwept = { x: 0, y: 0, z: -1 };
  private resweep = true;
  private readonly sunNow = { x: 0, y: 0, z: 0 };
  private foliage: number;
  /** Where the shadows being cast again for the leaves have got to (m, north of `WORLD.y0`); -1 when done. */
  private recastFrom = -1;
  /** Milliseconds the last tile drawn took; taken as the whole budget till one has been timed. */
  private tileCost = DRAW_BUDGET;
  private ownersVersion = 0;
  /** The town's version the structures were last matched to its buildings for. */
  private townVersion = -1;
  private readonly seen = new Set<number>();
  private readonly world: World;
  /** The structure drawn for each building, by building id. */
  private readonly structures = new Map<number, BuildingStructure>();
  /** The lamps by the ways, what they were placed for, and how brightly they burn. */
  streetLamps: StreetLamp[] = [];
  private readonly lampKey = { grades: -1, square: -1, era: -1, count: -1, next: -1 };
  private lampsLit = -1;
  /** The fence round each pasture. */
  private readonly fences: FenceStructure[];
  private readonly actors = new Actors();
  private readonly effects = new Effects();
  /** Height of the world at each pixel of the frame, for what is drawn over it. */
  private frameZ = new Float32Array(0);
  /** How each field looked when last passed to the shader (see `fieldKey`). */
  private fieldLooks: number[] = [];
  /** The tiles of this frame's view, and those of them to draw. */
  private readonly tiles: Tile[] = [];
  private readonly fresh: Tile[] = [];
  private readonly outdated: Tile[] = [];
  private readonly frameInfo: FrameInfo;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    this.world = world;
    this.display = new PixelDisplay(canvas);
    this.sky = new SkyRenderer(world.env);
    this.scene = new Scene(world);
    this.fences = world.plan.pastures.map((q) => new FenceStructure(world, q.id));
    for (const f of this.fences) {
      this.scene.add(f);
    }
    this.shadow = new ShadowMap(world.terrain);
    this.shader = new Shader(this.shadow);
    // The leaves as the year has brought them, and the buildings standing now; then all their
    // shadows, which take in whatever changed in the world before.
    this.foliage = foliageLevel(world);
    this.scene.trees.foliage = this.foliage;
    this.shadow.leaves = this.foliage;
    this.syncStructures(world, false);
    castShadows(this.shadow, world, WORLD.x0, WORLD.y0, WORLD.x1, WORLD.y1);
    world.changes.length = 0;
    this.frameInfo = {
      view: this.display.screen,
      z: this.frameZ,
      fx: 0,
      fy: 0,
      time: 0,
      shader: this.shader,
    };
    const bounds = worldBounds(world);
    this.extent = bounds.extent;
    this.horizon = bounds.horizon;
    const c = world.plan.center;
    this.viewport.setHome(c.x / S, gyOf(c.y, world.terrain.height(c.x, c.y)));
  }

  /** The point of the ground under the middle of the view (world m), for the ear. */
  lookingAt(): { x: number; y: number } {
    const t = this.world.terrain;
    const m = this.viewport.middle;
    const x = m.x * S;
    // The height there decides which ground the row falls on: settle it in a couple of steps.
    let y = yAt(m.y, t.height(x, yAt(m.y, 0)));
    y = yAt(m.y, t.height(x, y));
    return { x, y };
  }

  resize(deviceWidth: number, deviceHeight: number): void {
    if (this.display.matches(deviceWidth, deviceHeight)) {
      return;
    }
    const layout = computeLayout(
      deviceWidth,
      deviceHeight,
      this.canvas.clientWidth || deviceWidth,
      this.extent,
    );
    this.display.sizeCanvas(deviceWidth, deviceHeight);
    this.viewport.setLayout(layout);
  }

  /** Takes note of what changed in the world's last update. */
  observe(world: World): void {
    for (const c of world.changes) {
      this.redraw(c.x0, c.y0, c.x1, c.y1, c.top);
    }
    world.changes.length = 0;
    this.syncStructures(world);
  }

  /** Draws a box of the world again, and recasts its shadows. */
  private redraw(x0: number, y0: number, x1: number, y1: number, top: number): void {
    this.store.invalidate(x0 / S - 2, gyOf(y1, top) - 2, x1 / S + 2, gyOf(y0, -5) + 2);
    castShadows(this.shadow, this.world, x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5);
    this.resweep = true;
  }

  /**
   * Keeps a structure for every building, drawn again when it has gone up a
   * step, been shut or opened, burned or been cleared away; and passes on
   * how charred each is and how lit its windows. With `cast` false, the
   * shadows are left to be cast for the whole world at once.
   */
  private syncStructures(world: World, cast = true): void {
    const town = world.town;
    let owners = false;
    // Buildings come and go only with a new version of the town.
    if (town.version !== this.townVersion) {
      this.townVersion = town.version;
      const seen = this.seen;
      seen.clear();
      for (const b of town.buildings) {
        seen.add(b.id);
        const s = this.structures.get(b.id);
        if (!s || s.building !== b) {
          if (s) {
            this.scene.remove(s);
          }
          const made = new BuildingStructure(world, b);
          this.structures.set(b.id, made);
          this.scene.add(made);
        }
      }
      for (const [id, s] of this.structures) {
        if (!seen.has(id)) {
          this.structures.delete(id);
          this.scene.remove(s);
          this.touch(s, cast);
        }
      }
    }
    const shader = this.shader;
    for (const b of town.buildings) {
      const s = this.structures.get(b.id)!;
      const look = s.look();
      if (look !== s.drawnLook) {
        s.drawnLook = look;
        this.touch(s, cast);
      }
      const owner = BUILDING_OWNER + b.id;
      if (
        Math.abs(shader.char[owner] - b.char) > 0.02 ||
        Math.abs(shader.lamps[owner] - b.lamps) > 0.02
      ) {
        shader.char[owner] = b.char;
        shader.lamps[owner] = b.lamps;
        owners = true;
      }
    }
    for (const f of this.fences) {
      const look = f.look();
      if (look !== f.drawnLook) {
        f.drawnLook = look;
        this.store.invalidate(f.gx0, f.gy0, f.gx1, f.gy1);
      }
    }
    if (this.fieldColors(world)) {
      owners = true;
    }
    // The lamps by the ways: placed again as streets are trodden and houses built, lit at dusk.
    let grades = 0;
    for (let i = 0; i < town.streetGrade.length; i++) {
      grades += town.streetGrade[i];
    }
    const key = this.lampKey;
    if (
      grades !== key.grades ||
      town.squareGrade !== key.square ||
      world.council.era !== key.era ||
      town.buildings.length !== key.count ||
      town.nextBuildingId !== key.next
    ) {
      key.grades = grades;
      key.square = town.squareGrade;
      key.era = world.council.era;
      key.count = town.buildings.length;
      key.next = town.nextBuildingId;
      this.streetLamps = placeStreetLamps(world);
      owners = true;
    }
    const lit = Math.round(lampsLit(world.env.darkness) * LAMP_STEPS) / LAMP_STEPS;
    if (lit !== this.lampsLit) {
      this.lampsLit = lit;
      owners = true;
    }
    if (owners) {
      this.ownersVersion++;
      gatherLamps(world, this.shader, this.streetLamps, this.lampsLit);
    }
  }

  /**
   * The color of each field's crop, as the year and the farm work have left
   * it; true if any changed.
   */
  private fieldColors(world: World): boolean {
    let changed = false;
    const s = world.season;
    const growth = Math.round(s.growth * 12);
    const ripe = Math.round(s.ripeness * 12);
    for (const f of world.plan.fields) {
      const look = fieldLook(world, f.id);
      const key = fieldKey(look, growth, ripe);
      if (this.fieldLooks[f.id] === key) {
        continue;
      }
      this.fieldLooks[f.id] = key;
      changed = true;
      this.shader.setOwnerColor(FIELD_OWNER + f.id, cropColor(look, growth / 12, ripe / 12));
    }
    return changed;
  }

  /** Draws the ground under a structure again, and (with `cast`) its shadows. */
  private touch(s: BuildingStructure, cast: boolean): void {
    this.store.invalidate(s.gx0, s.gy0, s.gx1, s.gy1);
    if (!cast) {
      return;
    }
    const b = s.building;
    const r = Math.hypot(b.rect.width, b.rect.depth) / 2 + 1.5;
    castShadows(this.shadow, this.world, b.rect.x - r, b.rect.y - r, b.rect.x + r, b.rect.y + r);
    this.resweep = true;
  }

  render(world: World, dt: number, time: number): void {
    this.frame++;
    const place = this.viewport.placement();
    this.display.place(place.width, place.height, place.scale, place.offsetX, place.offsetY);
    const view = this.display.screen;
    const env = world.env;
    const lighting = computeLighting(env, LIGHT_POLLUTION);
    this.followSeasons(world);
    this.followSun(world);
    this.shader.update(world, lighting, this.shadow.version, this.ownersVersion);

    // The sky and the far mountains, where the world does not reach.
    const cam = this.cam;
    cam.configure(view.width, view.height, this.horizon - place.gy, BACKDROP_FOCAL);
    cam.cx = -place.gx;
    cam.pos = 0;
    cam.eye = 0;
    cam.heading = HEADING;
    this.sky.update(dt, env);
    if (cam.horizon > -BACKDROP_FOCAL * 0.3) {
      // Only the rows down to the horizon show past the world. They change slowly, so they are
      // painted every few frames (and whenever the view moves) and copied in between.
      const rows = Math.max(0, Math.min(view.height, Math.ceil(cam.horizon) + 2));
      const cache = this.backdrop;
      const fits = cache !== null && cache.width === view.width && cache.height === view.height;
      const moved = !fits || this.backdropAt.x !== place.gx || this.backdropAt.y !== place.gy;
      if (moved || this.frame - this.backdropFrame >= BACKDROP_EVERY) {
        const target = fits ? cache : new Surface(view.width, view.height);
        this.cover.reset(view.width, view.height);
        if (this.hidden.length !== view.width) {
          this.hidden = new Uint8Array(view.width);
        }
        this.sky.render(target, cam, env, lighting, time, this.cover, this.hidden);
        drawBackdrop(target, cam, world, lighting, time);
        this.backdrop = target;
        this.backdropFrame = this.frame;
        this.backdropAt.x = place.gx;
        this.backdropAt.y = place.gy;
      }
      view.data.set(this.backdrop!.data.subarray(0, rows * view.width));
    }

    this.drawWorld(view, place.gx, place.gy, time, lighting);
    const frame = this.frameInfo;
    frame.view = view;
    frame.z = this.frameZ;
    frame.fx = place.gx;
    frame.fy = place.gy;
    frame.time = time;
    this.effects.update(world, dt, time);
    applyLights(frame, this.effects.lights, this.store, this.shader);
    this.actors.draw(frame, world, this.streetLamps);
    this.effects.draw(frame, world, time);
    drawAir(frame, world, time);
    // A lightning flash lights everything at once.
    const flash = env.weather.state.flash;
    if (flash > 0.02) {
      const k = flash * 70;
      const data = view.data;
      for (let i = 0; i < data.length; i++) {
        const o = data[i];
        data[i] = pack((o & 255) + k * 0.9, ((o >>> 8) & 255) + k * 0.92, ((o >>> 16) & 255) + k);
      }
    }
    this.display.present();
    this.store.evict(this.frame - 2);
  }

  /** Draws a tile afresh and gives it colors under the light of the moment. */
  private drawTile(tile: Tile, epoch: number): void {
    const start = performance.now();
    this.scene.draw(tile);
    this.shader.shade(tile, 0, TILE);
    tile.litEpoch = epoch;
    this.tileCost = performance.now() - start;
  }

  /**
   * Draws, nearest first, tiles of the box [tx0, tx1] × [ty0, ty1] that are
   * not drawn yet or out of date, while the frame's budget lasts.
   */
  private prefetch(
    tx0: number,
    ty0: number,
    tx1: number,
    ty1: number,
    mx: number,
    my: number,
    start: number,
    epoch: number,
  ): void {
    const e = this.extent;
    const want: { tx: number; ty: number; d: number }[] = [];
    for (
      let ty = Math.max(ty0, e.top >> TILE_SHIFT);
      ty <= Math.min(ty1, e.bottom >> TILE_SHIFT);
      ty++
    ) {
      for (
        let tx = Math.max(tx0, e.left >> TILE_SHIFT);
        tx <= Math.min(tx1, e.right >> TILE_SHIFT);
        tx++
      ) {
        const tile = this.store.peek(tx, ty);
        if (!tile || tile.stale) {
          want.push({ tx, ty, d: Math.hypot(tx + 0.5 - mx, ty + 0.5 - my) });
        }
      }
    }
    want.sort((a, b) => a.d - b.d);
    let drew = 0;
    for (const w of want) {
      if (performance.now() - start + (drew > 0 ? this.tileCost : 0) > PREFETCH_BUDGET) {
        break;
      }
      drew++;
      const tile = this.store.get(w.tx, w.ty);
      tile.used = this.frame;
      this.drawTile(tile, epoch);
    }
  }

  /**
   * Draws the tiles in view: drawn afresh where stale, shaded where they have
   * no colors yet, then as many older ones as the budget allows; copied
   * over the backdrop, with the water shaded on top.
   */
  private drawWorld(view: Surface, fx: number, fy: number, time: number, lighting: Lighting): void {
    const tx0 = fx >> TILE_SHIFT;
    const ty0 = fy >> TILE_SHIFT;
    const tx1 = (fx + view.width - 1) >> TILE_SHIFT;
    const ty1 = (fy + view.height - 1) >> TILE_SHIFT;
    const start = performance.now();
    const epoch = this.shader.epoch;
    const tiles = this.tiles;
    const fresh = this.fresh;
    const outdated = this.outdated;
    tiles.length = 0;
    fresh.length = 0;
    outdated.length = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const tile = this.store.get(tx, ty);
        tile.used = this.frame;
        tiles.push(tile);
        if (!tile.drawn) {
          fresh.push(tile);
        } else if (tile.stale) {
          outdated.push(tile);
        }
      }
    }
    // Drawing tiles is costly: a few a frame, those never drawn first, nearest the middle of the view,
    // then those out of date (their old look shows till then). At least one a frame whatever it takes.
    const mx = (fx + view.width / 2) / TILE;
    const my = (fy + view.height / 2) / TILE;
    const nearer = (a: Tile, b: Tile) =>
      Math.hypot(a.tx + 0.5 - mx, a.ty + 0.5 - my) - Math.hypot(b.tx + 0.5 - mx, b.ty + 0.5 - my);
    fresh.sort(nearer);
    outdated.sort(nearer);
    let drew = 0;
    for (let k = 0; k < fresh.length + outdated.length; k++) {
      if (drew > 0 && performance.now() - start + this.tileCost > DRAW_BUDGET) {
        break;
      }
      this.drawTile(k < fresh.length ? fresh[k] : outdated[k - fresh.length], epoch);
      drew++;
    }
    // Bring older colors up to the light of the moment, oldest first, within the budget.
    tiles.sort((a, b) => a.litEpoch - b.litEpoch);
    for (const tile of tiles) {
      if (tile.litEpoch === epoch || !tile.drawn || performance.now() - start > SHADE_BUDGET) {
        break;
      }
      this.shader.shade(tile, 0, TILE);
      tile.litEpoch = epoch;
    }
    // With time to spare, the tiles just beyond the view, so that moving it finds them ready.
    if (fresh.length === 0 && outdated.length === 0) {
      this.prefetch(tx0 - AHEAD, ty0 - AHEAD, tx1 + AHEAD, ty1 + AHEAD, mx, my, start, epoch);
    }
    const data = view.data;
    const w = view.width;
    const h = view.height;
    if (this.frameZ.length !== w * h) {
      this.frameZ = new Float32Array(w * h);
    }
    const frameZ = this.frameZ;
    const a = lighting.ambient;
    const placeholder = pack(PLACEHOLDER[0] * a[0], PLACEHOLDER[1] * a[1], PLACEHOLDER[2] * a[2]);
    for (const tile of tiles) {
      const ox = tile.tx * TILE - fx;
      const oy = tile.ty * TILE - fy;
      const px0 = Math.max(0, -ox);
      const px1 = Math.min(TILE, w - ox);
      const py0 = Math.max(0, -oy);
      const py1 = Math.min(TILE, h - oy);
      const lit = tile.lit;
      if (!tile.drawn) {
        // Not drawn yet (the view has just moved far): the ground's plain color till it is.
        for (let py = py0; py < py1; py++) {
          const dst = (oy + py) * w + ox;
          data.fill(placeholder, dst + px0, dst + px1);
          frameZ.fill(NOTHING, dst + px0, dst + px1);
        }
        continue;
      }
      const tz = tile.z;
      const open = tile.open;
      for (let py = py0; py < py1; py++) {
        const src = py * TILE;
        const dst = (oy + py) * w + ox;
        if (!open) {
          for (let px = px0; px < px1; px++) {
            frameZ[dst + px] = tz[src + px];
            data[dst + px] = lit[src + px];
          }
          continue;
        }
        for (let px = px0; px < px1; px++) {
          frameZ[dst + px] = tz[src + px];
          const c = lit[src + px];
          if (c !== 0) {
            data[dst + px] = c;
          }
        }
      }
    }
    const sun = this.world.env.sky.sun;
    const s = toWorld(sun.e, sun.n, sun.u, this.sunNow);
    this.water.update(lighting, s.y, s.z, this.world.env.weather.state.rain);
    for (const tile of tiles) {
      if (tile.water.length > 0) {
        this.water.shade(tile, view, fx, fy, time);
      }
    }
  }

  /**
   * Redraws the broadleaves when the year's foliage has come on or thinned
   * enough to see, and casts the crowns' shadows again a strip a frame.
   */
  private followSeasons(world: World): void {
    const level = foliageLevel(world);
    if (level !== this.foliage) {
      this.foliage = level;
      this.scene.trees.foliage = level;
      for (const tile of this.store.values()) {
        if (this.scene.hasFoliage(tile)) {
          tile.stale = true;
        }
      }
      // The crowns' shade thins and thickens with their leaves.
      this.shadow.leaves = level;
      this.recastFrom = 0;
    }
    if (this.recastFrom < 0) {
      return;
    }
    const y0 = WORLD.y0 + this.recastFrom;
    const y1 = Math.min(WORLD.y1, y0 + RECAST_STRIP);
    castShadows(this.shadow, world, WORLD.x0, y0, WORLD.x1, y1);
    if (y1 < WORLD.y1) {
      this.recastFrom += RECAST_STRIP;
    } else {
      this.recastFrom = -1;
      this.resweep = true;
    }
  }

  /** Sweeps the shadows again once the sun has moved enough to see, or what casts them has changed. */
  private followSun(world: World): void {
    const sun = world.env.sky.sun;
    const s = toWorld(sun.e, sun.n, sun.u, this.sunNow);
    const was = this.sunSwept;
    if (!this.resweep && Math.hypot(s.x - was.x, s.y - was.y, s.z - was.z) < SUN_STEP) {
      return;
    }
    was.x = s.x;
    was.y = s.y;
    was.z = s.z;
    this.resweep = false;
    // Below the horizon the sun lights nothing: once its shadows are out, they wait for sunrise.
    if (s.z <= SUN_DOWN && !this.shadow.up) {
      return;
    }
    this.shadow.sweep(s.x, s.y, s.z);
  }
}

/** How much of the broadleaves' foliage is drawn, in the steps it is followed in. */
function foliageLevel(world: World): number {
  return Math.round(world.season.leafDensity * 6) / 6;
}

/** Codes for a field's look, for keys that change when the look does. */
const FIELD_STATES = ["soil", "growing", "stubble", "fallow"];
const CROPS = new Map<string, number>();

/** A number standing for how a field looks at the given growth and ripeness steps. */
function fieldKey(
  look: { state: string; crop: string; spoiled: number; work: number },
  growth: number,
  ripe: number,
): number {
  let crop = CROPS.get(look.crop);
  if (crop === undefined) {
    crop = CROPS.size;
    CROPS.set(look.crop, crop);
  }
  const state = FIELD_STATES.indexOf(look.state);
  const spoiled = Math.round(look.spoiled * 8);
  const work = Math.round(look.work * 4);
  return ((((state * 64 + crop) * 16 + growth) * 16 + ripe) * 64 + spoiled) * 64 + work;
}

/**
 * The part of the world the view may show: from the near edge of the land
 * up to some sky over the far ridge; and the row the backdrop's horizon lies
 * on, just below the lowest point of the ridge.
 */
function worldBounds(world: World): { extent: Extent; horizon: number } {
  const t = world.terrain;
  let nearest = Infinity;
  let highest = Infinity;
  let lowest = -Infinity;
  for (let x = WORLD.x0 + 4; x <= WORLD.x1 - 4; x += 1) {
    nearest = Math.min(nearest, gyOf(WORLD.y0 + 4, t.height(x, WORLD.y0 + 4)));
    let crest = Infinity;
    for (let y = WORLD.y1 - 60; y <= WORLD.y1 - 1; y += 1) {
      crest = Math.min(crest, gyOf(y, t.height(x, y)));
    }
    highest = Math.min(highest, crest);
    lowest = Math.max(lowest, crest);
  }
  return {
    extent: {
      left: Math.ceil((WORLD.x0 + 4) / S),
      right: Math.floor((WORLD.x1 - 4) / S),
      top: Math.floor(highest - SKY_ROWS),
      bottom: Math.floor(nearest),
    },
    horizon: lowest + 6,
  };
}
