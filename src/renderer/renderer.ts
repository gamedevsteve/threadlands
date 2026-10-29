/**
 * Threadlands — the Map.
 *
 * Canvas 2D, flat-top hex grid, and the panels beside it. This file never
 * imports the Agent SDK; every fact about a session arrives over `window.keep`.
 */
import { hexCorners, hexDistance, hexEq, hexSpiral, hexToPixel, pixelToHex } from "./hex.js";
import { marked } from "marked";
import { PERMISSION_MODES } from "../shared/types.js";
import type {
  AccountBudget,
  ModelChoice,
  PermissionModeValue,
  Realm,
  Settlement,
} from "../shared/types.js";

type Keep = {
  getRealm(): Promise<Realm>;
  found(i: { kind: "camp" | "city"; name: string; cwd: string; hex: { q: number; r: number }; profileId: string }): Promise<Settlement>;
  raze(id: string): Promise<void>;
  move(id: string, hex: { q: number; r: number }): Promise<void>;
  send(id: string, text: string): Promise<void>;
  answerFlag(id: string, allow: boolean): Promise<void>;
  interrupt(id: string): Promise<void>;
  openTerminal(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  pickFolder(startIn?: string | null): Promise<string | null>;
  budgets(): Promise<AccountBudget[]>;
  models(): Promise<ModelChoice[]>;
  setModel(id: string, model: string | null): Promise<void>;
  setPermissionMode(id: string, mode: PermissionModeValue | null): Promise<void>;
  onModels(cb: (m: ModelChoice[]) => void): void;
  toggleMaximize(): Promise<boolean>;
  onWindowState(cb: (big: boolean) => void): void;
  saveDefaults(d: Realm["defaults"]): Promise<void>;
  onSettlement(cb: (s: Settlement) => void): void;
  onRemoved(cb: (id: string) => void): void;
  onBudgets(cb: (b: AccountBudget[]) => void): void;
};
const keep = (window as unknown as { keep: Keep }).keep;

const MAP_RADIUS = 14;        // rings of hexes from the cottage
const SPRITE_FRACTION = 1.15; // sprite width relative to hex width — tuned to the art
const ZOOM_MIN = 0.22;
const ZOOM_MAX = 2.6;

// ── state ─────────────────────────────────────────────────────────────────────

let realm: Realm;
const byId = new Map<string, Settlement>();
let selected: string | null = null;
let cottageOpen = false;
let camera = { x: 0, y: 0, zoom: 0.62 };
let hover: { q: number; r: number } | null = null;
let founding: { q: number; r: number } | null = null;
let budgets: AccountBudget[] = [];
let budgetsLoading = false;
let models: ModelChoice[] = [];
/** Which collapsed runs of tool work have been opened, by settlement and index. */
const expandedRuns = new Set<string>();
let razeArmed: string | null = null;
let razeTyped = "";

const canvas = document.getElementById("map") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const pane = document.getElementById("pane")!;
const composer = document.getElementById("composer")!;
const promptEl = document.getElementById("prompt") as HTMLTextAreaElement;
const hint = document.getElementById("hint")!;
const toastEl = document.getElementById("toast")!;

const sprites: Record<string, HTMLImageElement> = {};
function loadSprite(name: string): Promise<void> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => { sprites[name] = img; res(); };
    img.onerror = () => res();
    img.src = `./assets/${name}.png`;
  });
}

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 4000);
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

marked.setOptions({ gfm: true, breaks: true });

/**
 * A governor's reply, as markdown.
 *
 * The text is HTML-escaped *before* parsing, never after: escaping afterwards
 * would undo the markup marked just produced, and skipping it would let a
 * model's output inject tags into the panel. Escaping first is harmless to the
 * markdown itself — none of its syntax uses the characters being escaped.
 */
function markdown(text: string): string {
  try {
    return marked.parse(esc(text), { async: false });
  } catch {
    return esc(text);
  }
}

// ── drawing ───────────────────────────────────────────────────────────────────

function hexSize(): number {
  // Rounded so the cached realm path is reused across tiny zoom deltas.
  return Math.round(74 * camera.zoom * 10) / 10;
}

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  // Reallocating the backing store is expensive, so only touch it on a real
  // change — a drag fires far more events than it changes pixels.
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Deliberately not dropping the ground cache here. A splitter drag resizes
  // the canvas every frame, and rebuilding the cache each time cost more than
  // having no cache at all. drawGround already rebuilds when the viewport
  // leaves the cached rectangle or the pixel ratio changes.
  invalidate();
  // No draw() here: the render loop owns painting. Calling it from here used to
  // start a second self-scheduling loop every time the window or the splitter
  // moved, and they multiplied until the map crawled.
}

function worldToScreen(x: number, y: number): { x: number; y: number } {
  return { x: x + camera.x + canvas.clientWidth / 2, y: y + camera.y + canvas.clientHeight / 2 };
}

function screenToWorld(x: number, y: number): { x: number; y: number } {
  return { x: x - camera.x - canvas.clientWidth / 2, y: y - camera.y - canvas.clientHeight / 2 };
}

/**
 * The outline of the whole realm, as one path: every hex unioned together.
 *
 * Cached, because it is hundreds of hexes and only changes when the zoom does.
 * Filling this once is what replaces drawing each tile — the grid is still
 * there underneath, it just has no seams to see.
 */
let realmPath: { size: number; path: Path2D } | null = null;

function getRealmPath(size: number): Path2D {
  if (realmPath && realmPath.size === size) return realmPath.path;
  const path = new Path2D();
  for (const h of hexSpiral(MAP_RADIUS)) {
    const p = hexToPixel(h, size);
    // A hair of overlap, so neighbouring hexes leave no hairline between them.
    const pts = hexCorners(p.x, p.y, size + 0.75);
    path.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i]![0], pts[i]![1]);
    path.closePath();
  }
  realmPath = { size, path };
  return path;
}

/**
 * The ground is a square lattice of texture cells, independent of the hex grid.
 *
 * Every tile in the set ends in the same border pixels — `tools/prep_assets.py`
 * composites each variant onto the base through a feathered mask to guarantee
 * it — so any variant can sit in any cell and the seams still line up. Which
 * variant lands where is a hash of the cell's coordinates: stable across
 * frames, across pans, and across restarts, with no state to store.
 */
type Patch = { file: string; group: string; w: number; h: number; weight: number };

/**
 * The ground is one seamless texture with patches scattered over it.
 *
 * Patches are free-standing transparent sprites, not variants of the ground
 * tile, which is the whole point: a patch is no longer trapped inside one cell.
 * They come in a range of sizes, land on a jittered scatter that has nothing to
 * do with the texture lattice, and overlap — so two or three run together into
 * one ragged area, and the next one along is a different size entirely.
 */
let groundSize = 512;
let patches: Patch[] = [];
let patchPick: number[] = []; // weight expanded into a lookup table
let maxPatchWorld = 0;

/** Roughly how far apart patch sites sit, in base-texture widths. */
const PATCH_SPACING = 1.1;
/** How many of those sites actually grow a patch. */
const PATCH_DENSITY = 0.55;

async function loadGround(): Promise<void> {
  let manifest: { size: number; base: string; patches: Patch[] };
  try {
    const res = await fetch("./assets/ground.json");
    manifest = await res.json();
  } catch {
    manifest = { size: 512, base: "grass.png", patches: [] };
  }
  groundSize = manifest.size;
  patches = manifest.patches ?? [];
  patchPick = patches.flatMap((p, i) => Array<number>(Math.max(1, p.weight)).fill(i));
  invalidateGround();
  maxPatchWorld = patches.reduce((m, p) => Math.max(m, p.w, p.h), 0);

  const load = (key: string, src: string) =>
    new Promise<void>((res) => {
      const img = new Image();
      img.onload = () => { sprites[key] = img; res(); };
      img.onerror = () => res();
      img.src = src;
    });

  await Promise.all([
    load("ground/base", `./assets/ground/${manifest.base}`),
    ...patches.map((p) => load(`ground/${p.file}`, `./assets/ground/${p.file}`)),
  ]);
}

/** Deterministic, well-mixed, and cheap. The same site always hashes the same. */
function hash2(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return (n ^ (n >>> 16)) >>> 0;
}

/** Debug switches for bisecting what a frame costs. */
const perf = { noShadow: false, noPatches: false, noClip: false, noCache: false };

/**
 * The ground is expensive and barely changes, so it is painted into an
 * offscreen canvas and blitted.
 *
 * It depends only on the zoom and on where you are looking, never on time, so
 * a cache covering rather more than the viewport survives a long pan and is
 * rebuilt only when you reach its edge or change zoom. Panning then costs one
 * blit instead of a clip, a pattern fill and a few dozen alpha-blended patches.
 */
type GroundCache = {
  canvas: HTMLCanvasElement;
  size: number;
  dpr: number;
  x: number;
  y: number;
  w: number;
  h: number;
};
let groundCache: GroundCache | null = null;

/** How far past the viewport the cache reaches, as a fraction of it. */
const GROUND_MARGIN = 0.4;

function invalidateGround(): void {
  groundCache = null;
}

/** Paint the ground for one world-space rectangle into any context. */
function paintGround(
  g: CanvasRenderingContext2D,
  size: number,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
): void {
  const path = getRealmPath(size);

  // A drop shadow under the whole landmass, so the realm sits on the water
  // instead of being cut out of it. Drawn before the clip: stroking the path
  // itself would outline every hex in it, which is the grid we are hiding.
  //
  // Only when the shore is in view. A blur costs by the area it covers, and
  // zoomed in the edge is far off screen while the blur was still being paid.
  const inradius = size * 1.5 * MAP_RADIUS;
  const reach = Math.hypot(vx + vw / 2, vy + vh / 2) + Math.hypot(vw / 2, vh / 2);
  if (!perf.noShadow && reach > inradius * 0.97) {
    g.save();
    g.beginPath();
    g.rect(vx, vy, vw, vh);
    g.clip();
    g.translate(0, size * 0.09);
    g.fillStyle = "rgba(6,16,21,.55)";
    g.filter = `blur(${Math.max(2, size * 0.09)}px)`;
    g.fill(path);
    g.restore();
  }

  g.save();
  if (!perf.noClip) g.clip(path);

  // A flat wash first, so a texture that has not loaded still reads as ground.
  g.fillStyle = "#6f8445";
  g.fillRect(vx, vy, vw, vh);

  const cell = groundSize * camera.zoom;
  const base = sprites["ground/base"];
  if (base && cell > 1) {
    const pat = g.createPattern(base, "repeat");
    if (pat) {
      pat.setTransform(new DOMMatrix().scaleSelf(camera.zoom));
      g.fillStyle = pat;
      g.fillRect(vx, vy, vw, vh);
    }
  }

  // Patches. The scatter is a jittered lattice in world units, widened by the
  // biggest patch so one hanging in from outside the rectangle is still drawn.
  if (patchPick.length && cell > 1 && !perf.noPatches) {
    const step = groundSize * PATCH_SPACING * camera.zoom;
    const margin = maxPatchWorld * camera.zoom * 0.5;
    const x0 = Math.floor((vx - margin) / step);
    const x1 = Math.ceil((vx + vw + margin) / step);
    const y0 = Math.floor((vy - margin) / step);
    const y1 = Math.ceil((vy + vh + margin) / step);

    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const h = hash2(sx, sy);
        if ((h & 0x3ff) / 1024 > PATCH_DENSITY) continue;
        const pick = patchPick[(h >>> 10) % patchPick.length];
        const pdef = pick === undefined ? undefined : patches[pick];
        const img = pdef ? sprites[`ground/${pdef.file}`] : undefined;
        if (!pdef || !img) continue;
        // Jitter off the lattice, so the scatter never reads as a grid.
        const jx = ((hash2(sx + 101, sy - 57) & 0xffff) / 65535 - 0.5) * 0.9;
        const jy = ((hash2(sx - 31, sy + 73) & 0xffff) / 65535 - 0.5) * 0.9;
        const w = pdef.w * camera.zoom;
        const hh = pdef.h * camera.zoom;
        const px0 = (sx + 0.5 + jx) * step - w / 2;
        const py0 = (sy + 0.5 + jy) * step - hh / 2;
        // The search area is widened by the largest patch, so sites near its
        // edge often hold a smaller one that misses entirely. Blending a big
        // transparent sprite is not cheap; skip those.
        if (px0 > vx + vw || px0 + w < vx || py0 > vy + vh || py0 + hh < vy) continue;
        g.drawImage(img, px0, py0, w, hh);
      }
    }
  }
  g.restore();
}

/** Grass, tiled across the realm and anchored to the world so it pans with it. */
function drawGround(size: number): void {
  const origin = worldToScreen(0, 0);
  const vx = -origin.x;
  const vy = -origin.y;
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;

  if (perf.noCache) {
    ctx.save();
    ctx.translate(origin.x, origin.y);
    paintGround(ctx, size, vx, vy, vw, vh);
    ctx.restore();
    return;
  }

  const stale =
    !groundCache ||
    groundCache.size !== size ||
    groundCache.dpr !== dpr ||
    vx < groundCache.x ||
    vy < groundCache.y ||
    vx + vw > groundCache.x + groundCache.w ||
    vy + vh > groundCache.y + groundCache.h;

  if (stale) {
    const mx = vw * GROUND_MARGIN;
    const my = vh * GROUND_MARGIN;
    const cx = vx - mx;
    const cy = vy - my;
    const cw = vw + mx * 2;
    const ch = vh + my * 2;

    const c = groundCache?.canvas ?? document.createElement("canvas");
    c.width = Math.ceil(cw * dpr);
    c.height = Math.ceil(ch * dpr);
    const g = c.getContext("2d");
    if (g) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.translate(-cx, -cy);
      paintGround(g, size, cx, cy, cw, ch);
      groundCache = { canvas: c, size, dpr, x: cx, y: cy, w: cw, h: ch };
    }
  }

  if (groundCache) {
    ctx.drawImage(
      groundCache.canvas,
      origin.x + groundCache.x,
      origin.y + groundCache.y,
      groundCache.w,
      groundCache.h,
    );
  }
}

function strokeHex(cx: number, cy: number, size: number, colour: string, width = 2): void {
  ctx.beginPath();
  const pts = hexCorners(cx, cy, size * 0.97);
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.stroke();
}

/**
 * A glow that traces the sprite's own silhouette.
 *
 * Canvas shadows follow an image's alpha, so drawing the sprite with a zero
 * offset shadow lays a copy of its outline underneath it, and stacking a few
 * passes deepens it. This is why selection no longer draws a hex on top of the
 * art: the building itself lights up instead.
 */
type Glow = { colour: string; blur: number; passes?: number };

/**
 * A hardened white copy of a sprite, used only as the shape to glow around.
 *
 * Glowing the sprite directly makes the halo only as clean as the art's alpha,
 * and keyed-out art tends to carry a collar of half-transparent pixels that
 * smears the glow into a rectangle. Compositing the shape onto itself a few
 * times pushes faint alpha towards solid or towards nothing, so the rim traces
 * the silhouette however the art was exported. Built once per sprite.
 */
const silhouettes = new Map<string, HTMLCanvasElement>();

function silhouetteOf(name: string, img: HTMLImageElement): HTMLCanvasElement | null {
  const cached = silhouettes.get(name);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const g = c.getContext("2d");
  if (!g) return null;
  g.drawImage(img, 0, 0, c.width, c.height);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "source-over";
  // alpha -> 1-(1-a)^4: solid stays solid, a faint collar fades out.
  for (let i = 0; i < 3; i++) g.drawImage(c, 0, 0);
  silhouettes.set(name, c);
  return c;
}

/** Far enough that the source lands off-canvas and only its shadow is seen. */
const SHADOW_SOURCE_OFFSET = 20000;

/**
 * Device pixel ratio, kept because shadow offsets are applied in device pixels
 * and ignore the canvas transform — the offset has to be scaled by hand or the
 * glow lands thousands of pixels away and silently never appears.
 */
let dpr = 1;

/** The sprite overlay: a soft shadow under the art so it sits on the ground. */
function drawSprite(
  name: string,
  cx: number,
  cy: number,
  size: number,
  dim: boolean,
  glows: Glow[] = [],
): void {
  const img = sprites[name];
  if (!img) return;
  const w = size * 2 * SPRITE_FRACTION;
  const h = w * (img.height / img.width);
  const x = cx - w / 2;
  const y = cy - h / 2 - size * 0.08;

  ctx.save();
  ctx.globalAlpha = dim ? 0.1 : 0.22;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(cx, cy + size * 0.3, size * 0.52, size * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (glows.length) {
    const sil = silhouetteOf(name, img);
    if (sil) {
      ctx.save();
      // Draw the silhouette off-canvas and let the shadow offset carry its
      // glow back into place, so only the halo lands — never the white shape.
      ctx.shadowOffsetX = SHADOW_SOURCE_OFFSET * dpr;
      ctx.shadowOffsetY = 0;
      for (const g of glows) {
        ctx.shadowColor = g.colour;
        ctx.shadowBlur = g.blur;
        for (let i = 0; i < (g.passes ?? 3); i++) {
          ctx.drawImage(sil, x - SHADOW_SOURCE_OFFSET, y, w, h);
        }
      }
      ctx.restore();
    }
  }

  ctx.save();
  if (dim) ctx.globalAlpha = 0.62;
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

/** The flag. Until there is needs-you art, it is drawn: a pole and a banner. */
function drawFlag(cx: number, cy: number, size: number, t: number): void {
  const bob = Math.sin(t / 260) * size * 0.04;
  // Clear of the sprite, which stands about 1.2 hex-radii tall.
  const top = cy - size * 1.5 + bob;
  ctx.save();
  ctx.strokeStyle = "#f0e4cf";
  ctx.lineWidth = Math.max(1.5, size * 0.035);
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx, top + size * 0.5);
  ctx.stroke();
  ctx.fillStyle = "#e05a3c";
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx + size * 0.38, top + size * 0.1);
  ctx.lineTo(cx, top + size * 0.21);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The name plate.
 *
 * Drawn at a fixed pixel size rather than in world units, so a name stays
 * readable zoomed out and never swells to fill the screen zoomed in. The art is
 * black linework on a white body with its own alpha, so a colour multiplied
 * through it tints the body and leaves the linework alone — white becomes the
 * tint, black stays black.
 */
const BANNER_WIDTH = 190;
/** The zoom the plate is sized for. */
const BANNER_REF_ZOOM = 0.62;
/** Below this, only plates you are looking at or being asked about are drawn. */
const BANNER_ALL_BELOW = 0.4;

/**
 * Plate scale: never larger than its drawn size, never below half.
 *
 * Fixed pixel size is right zoomed in — a name has no business swelling with
 * the map — but zoomed right out the plates stack up and bury the settlements
 * they belong to, so they are allowed to shrink part of the way back.
 */
function bannerScale(): number {
  return Math.min(1, Math.max(0.5, camera.zoom / BANNER_REF_ZOOM));
}

const tintedBanners = new Map<string, HTMLCanvasElement>();

function tintedBanner(colour: string): HTMLCanvasElement | null {
  const cached = tintedBanners.get(colour);
  if (cached) return cached;
  const img = sprites.banner;
  if (!img) return null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const g = c.getContext("2d");
  if (!g) return null;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "multiply";
  g.fillStyle = colour;
  g.fillRect(0, 0, c.width, c.height);
  // multiply ignores alpha, so put the plate's own shape back.
  g.globalCompositeOperation = "destination-in";
  g.drawImage(img, 0, 0);
  tintedBanners.set(colour, c);
  return c;
}

/** The y of a sprite's base, mirroring drawSprite's geometry. */
function spriteFoot(name: string, cy: number, size: number): number {
  const img = sprites[name];
  if (!img) return cy + size;
  const w = size * 2 * SPRITE_FRACTION;
  const h = w * (img.height / img.width);
  return cy + h / 2 - size * 0.08;
}

function nameplate(
  text: string,
  cx: number,
  footY: number,
  tint: string,
  ink: string,
): void {
  const plate = tintedBanner(tint);
  const w = BANNER_WIDTH * bannerScale();
  const h = plate ? (w * plate.height) / plate.width : 40;
  // Hung off the base of the sprite, just overlapping it, so the name reads as
  // a plate planted in front of the settlement rather than across its face.
  const y = footY - h * 0.16;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (plate) {
    ctx.shadowColor = "rgba(6,16,21,.5)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.drawImage(plate, cx - w / 2, y - h / 2, w, h);
    ctx.shadowColor = "transparent";
  }

  // Shrink to fit rather than overflow the plate.
  let px = 21 * bannerScale();
  ctx.font = `${px}px "Kaushan Script", ui-serif, Georgia, serif`;
  const room = w * 0.66;
  const measured = ctx.measureText(text).width;
  if (measured > room) {
    px = Math.max(8, Math.floor((px * room) / measured));
    ctx.font = `${px}px "Kaushan Script", ui-serif, Georgia, serif`;
  }
  ctx.fillStyle = ink;
  ctx.fillText(text, cx, y - h * 0.04);
  ctx.restore();
}

function draw(): void {
  const t = performance.now();
  const size = hexSize();
  ctx.fillStyle = "#16262e";
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!realm) return;

  const occupied = new Map<string, Settlement>();
  for (const s of byId.values()) occupied.set(`${s.hex.q},${s.hex.r}`, s);

  drawGround(size);

  // Name plates are collected and drawn after every sprite.
  const plates: (() => void)[] = [];

  // The grid is invisible until you reach for it: only the hex under the
  // pointer is ever outlined, plus the one you are founding on.
  const outlined = carrying ? null : (founding ?? hover);
  const taken =
    !!outlined && (occupied.has(`${outlined.q},${outlined.r}`) || hexEq(outlined, realm.cottageHex));
  // An occupied tile says so by making its building glow, so a hex is only ever
  // drawn over bare ground — never on top of the art.
  if (outlined && !taken) {
    const p = hexToPixel(outlined, size);
    const { x, y } = worldToScreen(p.x, p.y);
    if (founding && hexEq(founding, outlined)) {
      ctx.save();
      ctx.fillStyle = "rgba(224,176,80,.14)";
      ctx.beginPath();
      const pts = hexCorners(x, y, size * 0.97);
      pts.forEach(([px2, py2], i) => (i ? ctx.lineTo(px2, py2) : ctx.moveTo(px2, py2)));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      strokeHex(x, y, size, "rgba(224,176,80,.9)", 2.5);
    } else {
      strokeHex(x, y, size, "rgba(240,246,248,.6)", 2);
    }
  }

  // cottage
  {
    const p = hexToPixel(realm.cottageHex, size);
    const { x, y } = worldToScreen(p.x, p.y);
    const hoveredCottage = !!hover && hexEq(hover, realm.cottageHex);
    const cottageGlow: Glow[] = cottageOpen
      ? [{ colour: "#e0b050", blur: size * 0.26, passes: 4 }]
      : hoveredCottage
        ? [{ colour: "rgba(240,246,248,.85)", blur: size * 0.14, passes: 2 }]
        : [];
    drawSprite("cottage", x, y, size, false, cottageGlow);
    if (camera.zoom >= BANNER_ALL_BELOW || cottageOpen || hoveredCottage) {
      const foot = spriteFoot("cottage", y, size);
      plates.push(() => nameplate("You", x, foot, "#f0dcae", "#3a2a12"));
    }
  }

  // settlements, drawn back to front so near tiles overlap far ones
  const order = [...byId.values()].sort((a, b) => hexToPixel(a.hex, size).y - hexToPixel(b.hex, size).y);
  for (const s of order) {
    const p = hexToPixel(s.hex, size);
    const { x, y } = worldToScreen(p.x, p.y);
    // State first, as a soft halo; then selection as a tight bright rim on top,
    // so a selected settlement that also wants you reads as both at once.
    const glows: Glow[] = [];
    if (s.state === "working") {
      const pulse = 0.5 + 0.5 * Math.sin(t / 420);
      glows.push({ colour: "#58c0a8", blur: size * (0.14 + 0.16 * pulse), passes: 3 });
    } else if (s.state === "needs_you") {
      const pulse = 0.5 + 0.5 * Math.sin(t / 300);
      glows.push({ colour: "#ff6a44", blur: size * (0.2 + 0.16 * pulse), passes: 4 });
    } else if (s.state === "error") {
      glows.push({ colour: "#e05a3c", blur: size * 0.2, passes: 3 });
    }

    if (s.id === selected) {
      glows.push({ colour: "rgba(255,255,255,.95)", blur: size * 0.09, passes: 4 });
    } else if (hover && hexEq(hover, s.hex)) {
      glows.push({ colour: "rgba(240,246,248,.8)", blur: size * 0.12, passes: 2 });
    }

    // While carried, the settlement is drawn at the hex it would land on, and
    // its old tile is left empty so the move reads as a move.
    const lifted = carrying?.id === s.id;
    let dx = x;
    let dy = y;
    if (lifted && carrying) {
      const to = hexToPixel(carrying.to, size);
      const at = worldToScreen(to.x, to.y);
      dx = at.x;
      dy = at.y - size * 0.12;
      glows.push({
        colour: carrying.ok ? "rgba(255,255,255,.95)" : "#e05a3c",
        blur: size * 0.16,
        passes: 4,
      });
      strokeHex(at.x, at.y, size, carrying.ok ? "rgba(240,246,248,.85)" : "rgba(224,90,60,.9)", 2.5);
    }
    drawSprite(s.kind, dx, dy, size, s.state === "dormant", glows);
    if (s.state === "needs_you") drawFlag(dx, dy, size, t);

    // The plate carries state too: amber when it wants you, washed out when dormant.
    const tint =
      s.state === "needs_you" ? "#ffb08a" : s.state === "dormant" ? "#b9bfbd" : "#f4ead2";
    const ink = s.state === "dormant" ? "#4a5356" : "#2d2112";
    const worthShowing =
      camera.zoom >= BANNER_ALL_BELOW ||
      s.id === selected ||
      s.state === "needs_you" ||
      (!!hover && hexEq(hover, s.hex));
    const foot = spriteFoot(s.kind, dy, size);
    if (worthShowing) plates.push(() => nameplate(s.name, dx, foot, tint, ink));
  }

  // Names last, so a neighbouring settlement's sprite can never cover one. The
  // selected settlement's plate goes on top of the rest.
  for (const draw of plates) draw();
  if (selected) {
    const s = byId.get(selected);
    if (s) {
      const p = hexToPixel(s.hex, size);
      const { x, y } = worldToScreen(p.x, p.y);
      const tint = s.state === "needs_you" ? "#ffb08a" : s.state === "dormant" ? "#b9bfbd" : "#fff6e2";
      nameplate(s.name, x, spriteFoot(s.kind, y, size), tint, s.state === "dormant" ? "#4a5356" : "#2d2112");
    }
  }

}

/**
 * The one render loop. Started once; nothing else may schedule a frame.
 *
 * The map is still most of the time, so a frame is only painted when something
 * has changed, when a settlement is animating — the working pulse, the flag —
 * or on a slow heartbeat, which costs nothing and means a missed `invalidate`
 * can never leave a stale map on screen.
 */
let rafHandle = 0;
let frameWanted = true;
/** Set when the canvas needs its backing store resized before the next paint. */
let needsResize = false;
let lastDrawn = 0;
const HEARTBEAT_MS = 500;

function invalidate(): void {
  frameWanted = true;
}

function animating(): boolean {
  for (const s of byId.values()) {
    if (s.state === "working" || s.state === "needs_you") return true;
  }
  return false;
}

function startRenderLoop(): void {
  if (rafHandle) return;
  const tick = (now: number) => {
    if (frameWanted || animating() || now - lastDrawn > HEARTBEAT_MS) {
      // Resize first, in the same frame: it clears the canvas, so anything
      // painted before it would be thrown away.
      if (needsResize) {
        needsResize = false;
        resize();
      }
      frameWanted = false;
      lastDrawn = now;
      draw();
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

// ── interaction ───────────────────────────────────────────────────────────────

/**
 * One gesture, two meanings: starting on a settlement picks it up, starting on
 * open ground drags the map. Which one is decided at mousedown, by what is
 * under the pointer.
 */
let drag: {
  x: number;
  y: number;
  cx: number;
  cy: number;
  moved: boolean;
  settlementId?: string;
} | null = null;

/** Where a picked-up settlement currently hovers, and whether it can land. */
let carrying: { id: string; to: { q: number; r: number }; ok: boolean } | null = null;

function settlementAt(h: { q: number; r: number }): Settlement | undefined {
  for (const s of byId.values()) if (hexEq(s.hex, h)) return s;
  return undefined;
}

function canLandOn(h: { q: number; r: number }, movingId: string): boolean {
  if (hexDistance(h, { q: 0, r: 0 }) > MAP_RADIUS) return false;
  if (hexEq(h, realm.cottageHex)) return false;
  const there = settlementAt(h);
  return !there || there.id === movingId;
}

canvas.addEventListener("mousedown", (e) => {
  const r = canvas.getBoundingClientRect();
  const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
  const h = pixelToHex(w.x, w.y, hexSize());
  const under = settlementAt(h);
  drag = {
    x: e.clientX,
    y: e.clientY,
    cx: camera.x,
    cy: camera.y,
    moved: false,
    ...(under ? { settlementId: under.id } : {}),
  };
  canvas.classList.add("dragging");
});

window.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
  const h = pixelToHex(w.x, w.y, hexSize());
  const nextHover = hexDistance(h, { q: 0, r: 0 }) <= MAP_RADIUS ? h : null;
  if (!!nextHover !== !!hover || (nextHover && hover && !hexEq(nextHover, hover))) invalidate();
  hover = nextHover;

  if (drag) {
    invalidate();
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;

    if (drag.settlementId) {
      // Carrying a settlement: the map stays put and the tile follows.
      carrying = drag.moved && hover
        ? { id: drag.settlementId, to: hover, ok: canLandOn(hover, drag.settlementId) }
        : null;
    } else {
      camera.x = drag.cx + dx;
      camera.y = drag.cy + dy;
    }
  } else {
    // A settlement under the pointer advertises that it can be picked up.
    canvas.style.cursor = hover && settlementAt(hover) ? "grab" : "";
  }
});

window.addEventListener("mouseup", (e) => {
  canvas.classList.remove("dragging");
  const d = drag;
  const held = carrying;
  drag = null;
  carrying = null;
  invalidate();

  if (d?.settlementId && d.moved) {
    if (held?.ok) {
      void keep.move(d.settlementId, held.to).catch((err: Error) => toast(String(err?.message ?? err)));
    } else if (held) {
      toast(hexEq(held.to, realm.cottageHex) ? "the cottage is there" : "that hex is taken");
    }
    return;
  }

  if (!d || d.moved) return;
  const r = canvas.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right) return;
  const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
  const h = pixelToHex(w.x, w.y, hexSize());
  if (hexDistance(h, { q: 0, r: 0 }) > MAP_RADIUS) return;
  clickHex(h);
});

/** Zoom about a point on screen, so what is under the cursor stays under it. */
function zoomAt(px: number, py: number, factor: number): void {
  const before = screenToWorld(px, py);
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom * factor));
  const ratio = next / camera.zoom;
  camera.zoom = next;
  camera.x -= before.x * (ratio - 1);
  camera.y -= before.y * (ratio - 1);
  invalidate();
}

/**
 * Trackpad two-finger scroll pans; pinch and ⌘/ctrl-scroll zoom.
 *
 * A trackpad pinch arrives as a wheel event with ctrlKey set — that is how the
 * platform reports it, not a key anyone is holding — so the same branch serves
 * pinching and deliberate ⌘-scroll. Everything else is treated as a pan, which
 * is what two fingers should do on a map. Mouse users still drag to pan, and
 * hold ⌘ to zoom.
 */
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;

  if (e.ctrlKey || e.metaKey) {
    zoomAt(px, py, Math.exp(-e.deltaY * 0.01));
    return;
  }

  // Follow the fingers: the map moves with them, like dragging the paper.
  camera.x -= e.deltaX;
  camera.y -= e.deltaY;
  invalidate();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  const typing = document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA";
  if (typing) return;
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  if (e.key === "=" || e.key === "+") zoomAt(cx, cy, 1.2);
  else if (e.key === "-" || e.key === "_") zoomAt(cx, cy, 1 / 1.2);
  else if (e.key === "0") { camera = { x: 0, y: 0, zoom: 0.62 }; }
  invalidate();
});

function clickHex(h: { q: number; r: number }): void {
  razeArmed = null;
  razeTyped = "";
  if (hexEq(h, realm.cottageHex)) {
    selected = null;
    founding = null;
    cottageOpen = true;
    void refreshBudgets();
    render();
    return;
  }
  const s = [...byId.values()].find((x) => hexEq(x.hex, h));
  cottageOpen = false;
  if (s) {
    selected = s.id;
    founding = null;
  } else {
    selected = null;
    founding = h;
  }
  render();
}

// ── panels ────────────────────────────────────────────────────────────────────

function when(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  const rel = mins <= 0 ? "now" : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return `${d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · ${rel}`;
}

/**
 * The model picker. `null` means follow whatever is above it: the realm default
 * for a settlement, the CLI's own default for the realm.
 */
function modelOptions(selected: string | null, inheritLabel: string): string {
  const rows = models.map(
    (m) =>
      `<option value="${esc(m.value)}"${m.value === selected ? " selected" : ""}>${esc(m.label)}</option>`,
  );
  return (
    `<option value=""${selected === null ? " selected" : ""}>${esc(inheritLabel)}</option>` +
    rows.join("")
  );
}

function modeLabel(value: PermissionModeValue): string {
  return PERMISSION_MODES.find((m) => m.value === value)?.label ?? value;
}

function modeHint(value: PermissionModeValue): string {
  return PERMISSION_MODES.find((m) => m.value === value)?.hint ?? "";
}

function modeOptions(selected: PermissionModeValue | null, inheritLabel: string | null): string {
  const rows = PERMISSION_MODES.map(
    (m) => `<option value="${m.value}"${m.value === selected ? " selected" : ""}>${esc(m.label)}</option>`,
  );
  if (inheritLabel === null) return rows.join("");
  return (
    `<option value=""${selected === null ? " selected" : ""}>${esc(inheritLabel)}</option>` + rows.join("")
  );
}

function modelLabel(value: string | null): string {
  if (!value) return "default";
  return models.find((m) => m.value === value)?.label ?? value;
}

function renderCottage(): string {
  const rows = budgets
    .map((b) => {
      if (b.error) return `<div class="row"><span class="mono">${esc(b.profileId)}</span><span class="muted">unreachable</span></div>`;
      if (!b.planLimits) {
        return `<div class="meter"><div class="top"><b>${esc(b.profileId)}</b><span class="muted">bills per token</span></div>
          <div class="muted" style="font-size:11px">No plan windows on this lane — watch dollars, not percent.</div></div>`;
      }
      const meters = b.meters
        .map((m) => `<div class="meter">
            <div class="top"><span>${m.isActive ? "● " : ""}${esc(m.label)}</span><span class="muted">${m.percent}% · resets ${esc(when(m.resetsAt))}</span></div>
            <div class="track"><div class="fill ${esc(m.severity)}" style="width:${Math.min(100, m.percent)}%"></div></div>
          </div>`)
        .join("");
      const bd = b.breakdown.length
        ? `<div class="muted" style="font-size:11px;margin-bottom:10px">this week: ${b.breakdown.map((r) => `${esc(r.label)} ${r.percent}%`).join(" · ")}</div>`
        : "";
      const cr = b.credits?.enabled
        ? `<div class="muted" style="font-size:11px">extra usage: $${b.credits.usedUsd.toFixed(2)}${b.credits.limitUsd ? ` of $${b.credits.limitUsd.toFixed(2)}` : ""}</div>`
        : "";
      return `<div style="margin-bottom:14px">
          <div class="row"><b>${esc(b.profileId)}</b><span class="plan">${esc(b.plan ?? "—")}</span></div>
          ${meters}${bd}${cr}
        </div>`;
    })
    .join("<hr>");

  const d = realm.defaults;
  return `<h2>The cottage</h2>
    <p class="muted" style="margin-top:0">Realm defaults, and what each account has left.</p>
    <h2>Budget</h2>
    ${budgetsLoading ? '<div class="muted">probing accounts…</div>' : rows || '<div class="muted">no accounts</div>'}
    <div class="btns"><button id="reprobe">Refresh</button></div>
    <p class="muted" style="font-size:11px">Plan limits are published as percent and a reset time; there is no token balance to show. Per-settlement token counts are exact — see a settlement.</p>
    <hr>
    <h2>Defaults</h2>
    <label>Model</label>
    <select id="d-model">${modelOptions(d.model, models.length ? "Claude Code's default" : "loading models…")}</select>
    <p class="muted" style="font-size:11px;margin:4px 0 0">What a settlement uses unless it overrides this.</p>
    <label>Asks before acting</label>
    <select id="d-mode">${modeOptions(d.permissionMode, null)}</select>
    <p class="muted" style="font-size:11px;margin:4px 0 0">${esc(modeHint(d.permissionMode))}</p>
    <label>Base folder for new settlements</label>
    <div style="display:flex;gap:6px">
      <input id="d-base" placeholder="e.g. ~/Documents/repos" value="${esc(d.baseFolder ?? "")}" />
      <button id="d-browse">Browse</button>
    </div>
    <p class="muted" style="font-size:11px;margin:4px 0 0">Where the folder browser opens when you found a camp or a city.</p>
    <label>Camp idle timeout (minutes)</label><input id="d-camp" type="number" min="1" value="${d.campIdleMinutes}">
    <label>City idle timeout (minutes)</label><input id="d-city" type="number" min="1" value="${d.cityIdleMinutes}">
    <label>Per-settlement budget ceiling (USD)</label><input id="d-budget" type="number" min="0" step="0.5" value="${d.maxBudgetUsd}">
    <div class="btns"><button class="primary" id="d-save">Save</button></div>`;
}

function renderFounding(h: { q: number; r: number }): string {
  return `<h2>Found a settlement</h2>
    <p class="muted" style="margin-top:0">Empty ground at <span class="mono">${h.q}, ${h.r}</span>.</p>
    <label>Kind</label>
    <select id="f-kind">
      <option value="camp">Camp — short work, reaped quickly</option>
      <option value="city">City — a long project, kept warm</option>
    </select>
    <label>Folder</label>
    <div style="display:flex;gap:6px"><input id="f-cwd" placeholder="${esc(realm.defaults.baseFolder ?? "/path/to/project")}" value="${esc(realm.defaults.baseFolder ?? "")}" /><button id="f-pick">Browse</button></div>
    <label>Name</label><input id="f-name" placeholder="defaults to the folder name" />
    <label>Account</label>
    <select id="f-profile">${realm.profiles.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}</select>
    <p class="muted" style="font-size:11px">A settlement is scoped to its folder and cannot change account later without losing its transcript.</p>
    <div class="btns"><button class="primary" id="f-go">Found</button></div>`;
}

/**
 * Razing is the only irreversible thing on the map, so a city makes you type
 * the word. A camp is cheap and short-lived, so one deliberate click is enough
 * — a city holds a long transcript and is the one you would mourn.
 */
function renderRaze(s: Settlement): string {
  if (razeArmed !== s.id) {
    return `<div class="btns"><button class="danger" id="raze">Raze</button></div>`;
  }
  if (s.kind === "camp") {
    return `<div class="confirm">
        <div class="what">Raze <b>${esc(s.name)}</b>? Its transcript goes with it.</div>
        <div class="btns">
          <button class="danger" id="raze-go">Raze the camp</button>
          <button id="raze-no">Keep it</button>
        </div>
      </div>`;
  }
  return `<div class="confirm">
      <div class="what">Razing <b>${esc(s.name)}</b> destroys its whole history. Type <b>delete</b> to confirm.</div>
      <input id="raze-word" placeholder="delete" autocomplete="off" spellcheck="false" />
      <div class="btns">
        <button class="danger" id="raze-go" ${razeTyped.trim().toLowerCase() === "delete" ? "" : "disabled"}>Raze the city</button>
        <button id="raze-no">Keep it</button>
      </div>
    </div>`;
}

/**
 * The work between two bubbles: what the governor read, wrote and ran.
 *
 * Collapsed to one line once the turn is over, because by then it is a record
 * rather than news. The run still in progress stays open, so you can watch it.
 */
type ChatGroup =
  | { kind: "bubble"; entry: Settlement["chat"][number] }
  | { kind: "run"; entries: Settlement["chat"][number][]; key: string };

function groupChat(s: Settlement): ChatGroup[] {
  const out: ChatGroup[] = [];
  let run: Settlement["chat"][number][] = [];
  const flush = () => {
    if (run.length) {
      out.push({ kind: "run", entries: run, key: `${s.id}:${out.length}` });
      run = [];
    }
  };
  for (const entry of s.chat.slice(-200)) {
    if (entry.role === "governor" || entry.role === "you") {
      flush();
      out.push({ kind: "bubble", entry });
    } else {
      run.push(entry);
    }
  }
  flush();
  return out;
}

const VERBS: Record<string, string> = {
  read: "read",
  write: "wrote",
  edit: "edited",
  "run:": "ran",
  use: "used",
};

function runSummary(entries: Settlement["chat"][number][]): string {
  const counts = new Map<string, number>();
  let steps = 0;
  for (const e of entries) {
    if (e.role !== "tool") continue;
    steps++;
    const verb = VERBS[e.text.split(" ")[0] ?? ""] ?? "did";
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  if (!steps) return `${entries.length} note${entries.length === 1 ? "" : "s"}`;
  const parts = [...counts].map(([v, n]) => `${v} ${n}`);
  return `${steps} step${steps === 1 ? "" : "s"} · ${parts.join(" · ")}`;
}

function renderSettlement(s: Settlement): string {
  const stateWord = { idle: "idle", working: "working", needs_you: "needs you", dormant: "dormant · will resume", error: "error" }[s.state];
  const tk = s.tokens;
  const total = tk.input + tk.output;
  const flag = s.flag
    ? `<div class="flag">
        <h3>Needs you</h3>
        <div class="what">${esc(s.flag.summary)}</div>
        <div class="btns">
          <button class="primary" id="allow">Allow</button>
          <button class="danger" id="deny">Decline</button>
        </div>
      </div>`
    : "";

  const groups = groupChat(s);
  const chat = groups
    .map((g, i) => {
      if (g.kind === "bubble") {
        // Only the governor speaks markdown. What you typed is shown as typed.
        return g.entry.role === "governor"
          ? `<div class="msg governor md">${markdown(g.entry.text)}</div>`
          : `<div class="msg you">${esc(g.entry.text)}</div>`;
      }
      // The last run is still unfolding if nothing has answered it yet.
      const unfinished = i === groups.length - 1 && s.state !== "idle" && s.state !== "dormant";
      const open = unfinished || expandedRuns.has(g.key);
      const lines = g.entries
        .map((c) => `<div class="msg ${c.role}">${esc(c.text)}</div>`)
        .join("");
      return `<div class="run${open ? " open" : ""}">
          <button class="runtoggle" data-run="${esc(g.key)}">
            <span class="caret">${open ? "▾" : "▸"}</span>
            ${esc(runSummary(g.entries))}
            <span class="runhint">${open ? (unfinished ? "working…" : "hide") : "expand"}</span>
          </button>
          <div class="runbody">${lines}</div>
        </div>`;
    })
    .join("");

  return `${flag}
    <div class="row"><b>${esc(s.name)}</b><span class="muted">${esc(s.kind)} · ${esc(stateWord)}</span></div>
    <div class="row"><span class="muted mono">${esc(s.cwd)}</span></div>
    <div class="row"><span class="muted">account</span><span class="mono">${esc(s.profileId)}</span></div>
    <label>Asks before acting</label>
    <select id="s-mode">${modeOptions(
      s.permissionMode,
      `Realm default — ${modeLabel(realm.defaults.permissionMode)}`,
    )}</select>
    <p class="muted" style="font-size:11px;margin:4px 0 0">${esc(
      modeHint(s.permissionMode ?? realm.defaults.permissionMode),
    )} <span class="muted">· Shift+Tab cycles</span></p>
    <label>Model</label>
    <select id="s-model">${modelOptions(
      s.model,
      realm.defaults.model ? `Realm default — ${modelLabel(realm.defaults.model)}` : "Realm default",
    )}</select>
    <div class="row"><span class="muted">tokens</span><span class="mono">${total.toLocaleString()} (${tk.input.toLocaleString()} in · ${tk.output.toLocaleString()} out · ${tk.cacheRead.toLocaleString()} cached)</span></div>
    <div class="row"><span class="muted">spent</span><span class="mono">$${s.costUsd.toFixed(4)}</span></div>
    ${s.error ? `<div class="msg system">${esc(s.error)}</div>` : ""}
    ${renderRaze(s)}
    <hr>
    <h2>The governor</h2>
    <div id="chat">${chat || '<div class="muted">Nothing said yet.</div>'}</div>`;
}

function render(): void {
  if (!realm) return;
  invalidate();
  const s = selected ? byId.get(selected) : null;

  if (cottageOpen) {
    pane.innerHTML = renderCottage();
    composer.classList.add("hidden");
    hint.textContent = "the cottage";
    pane.querySelector("#reprobe")?.addEventListener("click", () => void refreshBudgets());
    pane.querySelector("#d-browse")?.addEventListener("click", async () => {
      const el = pane.querySelector("#d-base") as HTMLInputElement;
      const picked = await keep.pickFolder(el.value.trim() || realm.defaults.baseFolder);
      if (picked) el.value = picked;
    });
    pane.querySelector("#d-save")?.addEventListener("click", async () => {
      const num = (id: string, fallback: number) => Number((pane.querySelector(`#${id}`) as HTMLInputElement)?.value) || fallback;
      const base = (pane.querySelector("#d-base") as HTMLInputElement)?.value.trim();
      const chosen = (pane.querySelector("#d-model") as HTMLSelectElement)?.value || null;
      const mode = ((pane.querySelector("#d-mode") as HTMLSelectElement)?.value ||
        "default") as PermissionModeValue;
      realm.defaults = {
        model: chosen,
        permissionMode: mode,
        baseFolder: base || null,
        campIdleMinutes: num("d-camp", realm.defaults.campIdleMinutes),
        cityIdleMinutes: num("d-city", realm.defaults.cityIdleMinutes),
        maxBudgetUsd: num("d-budget", realm.defaults.maxBudgetUsd),
      };
      await keep.saveDefaults(realm.defaults);
      toast("defaults saved");
    });
    return;
  }

  if (founding) {
    const h = founding;
    pane.innerHTML = renderFounding(h);
    composer.classList.add("hidden");
    hint.textContent = "empty ground";
    pane.querySelector("#f-pick")?.addEventListener("click", async () => {
      const el = pane.querySelector("#f-cwd") as HTMLInputElement;
      const p = await keep.pickFolder(el.value.trim() || realm.defaults.baseFolder);
      if (p) el.value = p;
    });
    pane.querySelector("#f-go")?.addEventListener("click", async () => {
      const cwd = (pane.querySelector("#f-cwd") as HTMLInputElement).value.trim();
      if (!cwd) return toast("pick a folder first");
      try {
        const made = await keep.found({
          kind: (pane.querySelector("#f-kind") as HTMLSelectElement).value as "camp" | "city",
          name: (pane.querySelector("#f-name") as HTMLInputElement).value,
          cwd,
          hex: h,
          profileId: (pane.querySelector("#f-profile") as HTMLSelectElement).value,
        });
        byId.set(made.id, made);
        founding = null;
        selected = made.id;
        render();
      } catch (e) {
        toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '\w+': Error: /, ""));
      }
    });
    return;
  }

  if (!s) {
    pane.innerHTML = `<div class="empty">
      <p>Click empty ground to found a camp or a city. Click the cottage for realm defaults and what each account has left.</p>
      <p>Two fingers to pan, pinch or <kbd>⌘</kbd>+scroll to zoom — or drag with a mouse.
      <kbd>+</kbd> <kbd>-</kbd> zoom, <kbd>0</kbd> recentres. Drag a settlement to move it.</p>
      <p><kbd>Enter</kbd> sends a prompt, <kbd>Shift</kbd>+<kbd>Enter</kbd> starts a new line.</p>
      ${byId.size ? "" : "<p>The realm is empty.</p>"}
    </div>`;
    composer.classList.add("hidden");
    hint.textContent = `${byId.size} settlement${byId.size === 1 ? "" : "s"}`;
    return;
  }

  // Only follow new messages if you were already reading the newest ones.
  // Re-rendering for any other reason — expanding a run, a token count ticking
  // over — must leave the scroll exactly where you left it.
  const wasAtBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
  const keptScroll = pane.scrollTop;
  pane.innerHTML = renderSettlement(s);
  composer.classList.remove("hidden");
  hint.textContent = s.name;
  pane.querySelectorAll<HTMLButtonElement>(".runtoggle").forEach((b) => {
    b.addEventListener("click", () => {
      const key = b.dataset.run;
      if (!key) return;
      if (expandedRuns.has(key)) expandedRuns.delete(key);
      else expandedRuns.add(key);

      // Opening a run inserts content, which would otherwise shove everything
      // below it down the page. Measure the row you clicked before and after,
      // and take the difference out of the scroll so it does not appear to move.
      const before = b.getBoundingClientRect().top;
      render();
      const again = pane.querySelector<HTMLElement>(`.runtoggle[data-run="${CSS.escape(key)}"]`);
      if (again) pane.scrollTop += again.getBoundingClientRect().top - before;
    });
  });

  // A link in a reply would otherwise replace the whole app with a web page.
  pane.querySelectorAll<HTMLAnchorElement>(".md a[href]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void keep.openExternal(a.href);
    });
  });

  pane.querySelector("#s-mode")?.addEventListener("change", (e) => {
    const value = ((e.target as HTMLSelectElement).value || null) as PermissionModeValue | null;
    s.permissionMode = value;
    void keep.setPermissionMode(s.id, value);
    render();
    toast(`${s.name}: ${modeLabel(value ?? realm.defaults.permissionMode)}`);
  });
  pane.querySelector("#s-model")?.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value || null;
    s.model = value;
    // Takes effect on the next thing the governor says, mid-conversation.
    void keep.setModel(s.id, value);
    toast(value ? `now using ${modelLabel(value)}` : "following the realm default");
  });
  pane.querySelector("#allow")?.addEventListener("click", () => void keep.answerFlag(s.id, true));
  pane.querySelector("#deny")?.addEventListener("click", () => void keep.answerFlag(s.id, false));
  const doRaze = async () => {
    await keep.raze(s.id);
    byId.delete(s.id);
    selected = null;
    razeArmed = null;
    razeTyped = "";
    render();
  };

  pane.querySelector("#raze")?.addEventListener("click", () => {
    razeArmed = s.id;
    razeTyped = "";
    render();
  });
  pane.querySelector("#raze-no")?.addEventListener("click", () => {
    razeArmed = null;
    razeTyped = "";
    render();
  });
  pane.querySelector("#raze-go")?.addEventListener("click", () => {
    if (s.kind === "camp" || razeTyped.trim().toLowerCase() === "delete") void doRaze();
  });

  const word = pane.querySelector<HTMLInputElement>("#raze-word");
  if (word) {
    word.value = razeTyped;
    word.focus();
    word.setSelectionRange(razeTyped.length, razeTyped.length);
    word.addEventListener("input", () => {
      const ok = word.value.trim().toLowerCase() === "delete";
      razeTyped = word.value;
      const go = pane.querySelector<HTMLButtonElement>("#raze-go");
      // Flip the button in place rather than re-rendering, which would steal
      // the caret on every keystroke.
      if (go) go.disabled = !ok;
    });
    word.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && razeTyped.trim().toLowerCase() === "delete") void doRaze();
      if (e.key === "Escape") { razeArmed = null; razeTyped = ""; render(); }
    });
  }
  pane.scrollTop = wasAtBottom ? pane.scrollHeight : keptScroll;
}

async function refreshBudgets(): Promise<void> {
  budgetsLoading = budgets.length === 0;
  render();
  try {
    budgets = await keep.budgets();
  } catch (e) {
    toast(`budget probe failed: ${String((e as Error)?.message ?? e)}`);
  }
  budgetsLoading = false;
  render();
}

// ── composer ──────────────────────────────────────────────────────────────────

async function sendPrompt(): Promise<void> {
  const s = selected ? byId.get(selected) : null;
  const text = promptEl.value.trim();
  if (!s || !text) return;
  promptEl.value = "";
  try {
    await keep.send(s.id, text);
  } catch (e) {
    toast(String((e as Error)?.message ?? e));
  }
}

document.getElementById("send")!.addEventListener("click", () => void sendPrompt());
/** Shift+Tab steps the selected settlement through the modes, as Claude Code does. */
function cycleMode(): void {
  const s = selected ? byId.get(selected) : null;
  if (!s) return;
  const current = s.permissionMode ?? realm.defaults.permissionMode;
  const i = PERMISSION_MODES.findIndex((m) => m.value === current);
  const next = PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]!.value;
  s.permissionMode = next;
  void keep.setPermissionMode(s.id, next);
  render();
  toast(`${s.name}: ${modeLabel(next)}`);
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && e.shiftKey && selected) {
    e.preventDefault();
    cycleMode();
  }
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // Mid-composition Enter confirms an IME candidate; it is not a send.
  if (e.isComposing || e.keyCode === 229) return;
  // Shift keeps the line break. ⌘/Ctrl still sends, for the old habit.
  if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  void sendPrompt();
});
const zoomWin = document.getElementById("zoomwin") as HTMLButtonElement;
const setZoomLabel = (big: boolean) => { zoomWin.textContent = big ? "Restore" : "Fill screen"; };
zoomWin.addEventListener("click", async () => setZoomLabel(await keep.toggleMaximize()));
keep.onWindowState(setZoomLabel);

document.getElementById("terminal")!.addEventListener("click", () => {
  if (selected) void keep.openTerminal(selected);
});
document.getElementById("stop")!.addEventListener("click", () => {
  if (selected) void keep.interrupt(selected);
});

// ── boot ──────────────────────────────────────────────────────────────────────

keep.onSettlement((s) => {
  const isNew = !byId.has(s.id);
  byId.set(s.id, s);
  // Re-render when the open panel is about this settlement, when a flag goes up
  // anywhere, or when the idle pane is showing a count that just changed.
  if (s.id === selected || s.state === "needs_you" || (isNew && !selected && !cottageOpen)) render();
  else if (!selected && !cottageOpen) hint.textContent = `${byId.size} settlement${byId.size === 1 ? "" : "s"}`;
});
keep.onModels((m) => {
  models = m;
  render();
});
keep.onBudgets((b) => {
  budgets = b;
  budgetsLoading = false;
  if (cottageOpen) render();
});
keep.onRemoved((id) => {
  byId.delete(id);
  if (selected === id) selected = null;
  render();
});

// ── the splitter ──────────────────────────────────────────────────────────────

const ASIDE_DEFAULT = 380;
const ASIDE_MIN = 300;

/** Keep the panel a sensible width however the window is resized. */
let saveTimer = 0;

function setAsideWidth(px: number): void {
  const max = Math.max(ASIDE_MIN, window.innerWidth - 360);
  const w = Math.round(Math.min(max, Math.max(ASIDE_MIN, px)));
  // The layout change itself is cheap and has to be immediate to feel attached
  // to the pointer.
  document.documentElement.style.setProperty("--aside-w", `${w}px`);

  // Hand the resize to the render loop rather than scheduling it separately.
  // Setting canvas.width clears the canvas, and two independent animation
  // frames can run in either order — when the resize landed after the draw it
  // wiped the frame that had just been painted, which is a flashing map.
  needsResize = true;
  invalidate();

  // localStorage writes synchronously to disk. Once the drag settles is plenty.
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem("asideWidth", String(w));
    } catch {
      /* private window, or storage blocked — the width just will not persist */
    }
  }, 300);
}

{
  const splitter = document.getElementById("splitter")!;
  let startX = 0;
  let startW = ASIDE_DEFAULT;

  const onMove = (e: PointerEvent) => setAsideWidth(startW + (startX - e.clientX));
  const onUp = () => {
    splitter.classList.remove("dragging");
    document.body.classList.remove("resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = document.querySelector("aside")!.getBoundingClientRect().width;
    splitter.classList.add("dragging");
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  splitter.addEventListener("dblclick", () => setAsideWidth(ASIDE_DEFAULT));

  let saved = ASIDE_DEFAULT;
  try {
    saved = Number(localStorage.getItem("asideWidth")) || ASIDE_DEFAULT;
  } catch {
    /* fall back to the default */
  }
  setAsideWidth(saved);
}

window.addEventListener("resize", () => {
  // Re-clamp: the panel may now be wider than the window can spare.
  const current = document.querySelector("aside")!.getBoundingClientRect().width;
  setAsideWidth(current);
});

/** A small handle for driving the map from a test or the devtools console. */
(window as unknown as Record<string, unknown>).__threadlands = {
  select(id?: string) {
    selected = id ?? [...byId.keys()][0] ?? null;
    cottageOpen = false;
    founding = null;
    render();
  },
  cottage() {
    selected = null;
    founding = null;
    cottageOpen = true;
    void refreshBudgets();
  },
  list: () => [...byId.values()].map((s) => ({ id: s.id, name: s.name, state: s.state })),
  state: () => ({ selected, cottageOpen, founding, count: byId.size, camera, hover, carrying }),
  /** The renderer's own copy of a settlement — mutate it to stage a view. */
  get: (id?: string) => byId.get(id ?? selected ?? [...byId.keys()][0] ?? ""),
  zoom: (z: number) => { camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)); },
  /** Average milliseconds per draw, for finding what a frame is spending on. */
  benchDraw(n = 40) {
    draw();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) draw();
    return +((performance.now() - t0) / n).toFixed(2);
  },
  perf,
};

(async () => {
  // Size the backing store before anything can paint. Until this runs the
  // canvas is its default 300x150 stretched by CSS, which renders the whole map
  // about three times too big for a frame or two.
  resize();

  await Promise.all([
    loadGround(),
    ...["camp", "city", "cottage", "banner"].map(loadSprite),
    // Canvas silently falls back if the face is not ready when text is drawn.
    document.fonts.load('21px "Kaushan Script"').catch(() => []),
  ]);
  realm = await keep.getRealm();
  keep.models().then((m) => { models = m; render(); }).catch(() => {});
  for (const s of realm.settlements) byId.set(s.id, s);
  resize();
  render();
  startRenderLoop();
})();
