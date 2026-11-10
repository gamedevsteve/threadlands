/**
 * Threadlands — the Map.
 *
 * Canvas 2D, flat-top hex grid, and the panels beside it. This file never
 * imports the Agent SDK; every fact about a session arrives over `window.keep`.
 */
import { hexCorners, hexDistance, hexEq, hexSpiral, hexToPixel, pixelToHex } from "./hex.js";
import { Marked, marked } from "marked";
import { NOTIFY_WHEN, PERMISSION_MODES, SETTLEMENT_ART, artFor, defaultArt } from "../shared/types.js";
import type {
  AccountBudget,
  FolderChoice,
  ModelChoice,
  NotifyWhen,
  PermissionModeValue,
  Realm,
  Session,
  Settlement,
  SettlementArt,
  SettlementKind,
  SettlementState,
} from "../shared/types.js";
import type { Board, BoardOp, Bounty, Ledger, Warden } from "../shared/types.js";
import { bountyRef } from "../shared/types.js";

type Keep = {
  getRealm(): Promise<Realm>;
  found(i: { kind: SettlementKind; art: SettlementArt; name: string; folder: FolderChoice; hex: { q: number; r: number }; profileId: string }): Promise<Settlement>;
  raze(id: string): Promise<void>;
  move(id: string, hex: { q: number; r: number }): Promise<void>;
  send(id: string, text: string): Promise<void>;
  answerFlag(id: string, answer: boolean | string): Promise<void>;
  interrupt(id: string): Promise<void>;
  openTerminal(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  testNotification(): Promise<string>;
  getAvatar(): Promise<string | null>;
  setAvatar(): Promise<string | null>;
  clearAvatar(): Promise<void>;
  pickFolder(startIn?: string | null): Promise<string | null>;
  budgets(): Promise<AccountBudget[]>;
  models(): Promise<ModelChoice[]>;
  setModel(id: string, model: string | null): Promise<void>;
  setPermissionMode(id: string, mode: PermissionModeValue | null): Promise<void>;
  setArt(id: string, art: SettlementArt): Promise<void>;
  setBudget(id: string, usd: number | null): Promise<void>;
  onModels(cb: (m: ModelChoice[]) => void): void;
  toggleMaximize(): Promise<boolean>;
  onWindowState(cb: (big: boolean) => void): void;
  saveDefaults(d: Realm["defaults"]): Promise<void>;
  onSettlement(cb: (s: Settlement) => void): void;
  onRemoved(cb: (id: string) => void): void;
  onBudgets(cb: (b: AccountBudget[]) => void): void;
  onFocusSettlement(cb: (id: string) => void): void;
  getBoard(): Promise<Board>;
  boardOp(op: BoardOp): Promise<Board>;
  onBoard(cb: (b: Board) => void): void;
  wardenSend(text: string): Promise<void>;
  wardenAnswerFlag(answer: boolean | string): Promise<void>;
  wardenInterrupt(): Promise<void>;
  wardenSetModel(model: string | null): Promise<void>;
  wardenSetBudget(usd: number | null): Promise<void>;
  onFocusBoard(cb: () => void): void;
};
const keep = (window as unknown as { keep: Keep }).keep;

const MAP_RADIUS = 14;        // rings of hexes from the cottage
/**
 * The bounty board: due west of the cottage, level with it, six columns out.
 * Not built yet, so it stands greyed out and nothing can be raised on it.
 */
const BOUNTY_OFFSET = { q: -6, r: 3 };
/**
 * The rookery, where messengers will fly from: up and to the right of the
 * cottage, at q 2, r -4. Not working yet; it stands, and says so.
 */
const ROOKERY_OFFSET = { q: 2, r: -4 };
function rookeryHex(): { q: number; r: number } {
  return { q: realm.cottageHex.q + ROOKERY_OFFSET.q, r: realm.cottageHex.r + ROOKERY_OFFSET.r };
}
/** Hexes the realm's own buildings stand on. Nothing can be founded or moved there. */
function isRealmHex(h: { q: number; r: number }): boolean {
  return hexEq(h, realm.cottageHex) || hexEq(h, bountyHex()) || hexEq(h, rookeryHex());
}
function bountyHex(): { q: number; r: number } {
  return { q: realm.cottageHex.q + BOUNTY_OFFSET.q, r: realm.cottageHex.r + BOUNTY_OFFSET.r };
}
const SPRITE_FRACTION = 1.15; // sprite width relative to hex width — tuned to the art
/** Pole height in hex radii, and how many frames the flag waves in. */
const FLAG_HEIGHT = 1.7;
/**
 * Where the pole stands relative to the settlement, in hex radii: left of it,
 * and set back.
 *
 * Set back for two reasons. It reads as standing behind the building, which is
 * where a pole goes, and it lifts the pole's base clear of the name plate —
 * the plate is drawn at a fixed pixel size rather than in world units, so a
 * pole placed to clear it at one zoom would be buried at another. Standing
 * behind puts it above the plate at every zoom.
 */
const FLAG_BESIDE = 1.05;
const FLAG_BEHIND = 0.5;
const FLAG_FRAMES = 8;
const FLAG_FPS = 11;
/**
 * Where the shaft sits across the flag sprite, left to right.
 *
 * The art is mostly cloth, so the pole itself is nowhere near the middle of the
 * image — placing the sprite by its centre would stand the pole well right of
 * where you meant. prep_assets.py prints this as `shaft x` when it fits the
 * bare pole to the frames; it is that over the sprite's width.
 */
const FLAG_SHAFT = 183 / 256;
const ZOOM_DEFAULT = 0.62;
const ZOOM_MIN = 0.22;
const ZOOM_MAX = 2.6;

// ── state ─────────────────────────────────────────────────────────────────────

let realm: Realm;
const byId = new Map<string, Settlement>();
let selected: string | null = null;
let cottageOpen = false;
let camera = { x: 0, y: 0, zoom: ZOOM_DEFAULT };
let hover: { q: number; r: number } | null = null;
let founding: { q: number; r: number } | null = null;
/**
 * The build tool, armed. Set by the palette, cleared when the tile is placed
 * or the tool is put down; while it holds something the map shows a ghost of
 * it under the pointer and the next empty tile you click becomes it.
 */
let building: { kind: SettlementKind; art: SettlementArt } | null = null;
/**
 * What the founding form currently has chosen.
 *
 * Kept here rather than read off the form, because changing the house has to
 * repaint the ghost on the map and relight the tiles without replacing the
 * form — a folder you had already typed would go with it.
 */
let foundKind: SettlementKind = "camp";
let foundArt: SettlementArt = "camp-1";
/** Where the folder is coming from: one you have, one to make, one to clone. */
let foundMode: FolderChoice["mode"] = "existing";
let budgets: AccountBudget[] = [];
let budgetsLoading = false;
let models: ModelChoice[] = [];
/** Your avatar, as a data URL, and the decoded image the map draws. */
let avatarUrl: string | null = null;
let avatarImg: HTMLImageElement | null = null;

/**
 * The figure's own bounds inside the image.
 *
 * Avatars arrive padded — this one is 512x512 with the person occupying the
 * middle 59% — so sizing and shadowing from the file's dimensions puts a shadow
 * under empty space. Measure the opaque pixels once and draw only those.
 */
let avatarBox: { x: number; y: number; w: number; h: number } | null = null;

function measureAvatar(img: HTMLImageElement): void {
  avatarBox = null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return;
  g.drawImage(img, 0, 0);
  try {
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let minX = c.width;
    let minY = c.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3]! > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= minX) avatarBox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  } catch {
    // A tainted canvas would mean no measurement; fall back to the whole image.
  }
  if (!avatarBox) avatarBox = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
}

function loadAvatarImage(): void {
  if (!avatarUrl) {
    avatarImg = null;
    avatarBox = null;
    invalidate();
    return;
  }
  const img = new Image();
  img.onload = () => { avatarImg = img; measureAvatar(img); invalidate(); };
  img.onerror = () => { avatarImg = null; avatarBox = null; invalidate(); };
  img.src = avatarUrl;
}
/** Which collapsed runs of tool work have been opened, by settlement and index. */
const expandedRuns = new Set<string>();
/** Whether the details sheet is slid out over the transcript. */
/**
 * The panel's layers, above whatever the panel is open on. Each id is a sheet
 * that slides in over the one beneath; the header is a breadcrumb of them.
 * Clicking something on the map starts a fresh stack. See BUILD_PLAN, "The
 * panel's layers".
 */
let layers: string[] = [];
const LAYER_LABELS: Record<string, string> = { details: "Details" };
/** A layer the board is about to slide in: rendered closed first, so it can animate. */
let entering: string | null = null;

let boardOpen = false;
/**
 * Until the Keep hands over the real one. The warden here is a placeholder with
 * nothing said and nothing spent, so the panel can draw before the first push.
 */
let board: Board = {
  ledgers: [],
  bounties: [],
  nextNumber: 1,
  warden: {
    id: "warden", name: "The warden", cwd: "", model: null, state: "idle",
    sessionId: null, flag: null, chat: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0, maxBudgetUsd: null, windowSpentUsd: 0, windowResetsAt: null,
    lastActiveAt: 0, error: null,
  },
};
let boardLedger: string | null = null;
let boardBounty: string | null = null;
let boardFilter: "open" | "done" | "all" = "open";
/** Delete is two clicks: the first arms it. */
let deleteArmed: string | null = null;
let razeArmed: string | null = null;
let razeTyped = "";

const canvas = document.getElementById("map") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const pane = document.getElementById("pane")!;
const composer = document.getElementById("composer")!;
const promptEl = document.getElementById("prompt") as HTMLTextAreaElement;
const hint = document.getElementById("hint")!;
const toastEl = document.getElementById("toast")!;
const paletteEl = document.getElementById("palette")!;
const inHandEl = document.getElementById("inhand")!;
const buildBtn = document.getElementById("go-build")!;
/** Hidden for the warden: its folder is empty, so there is nothing to open. */
const terminalBtn = document.getElementById("terminal")!;

/** The sprite a settlement draws as, whatever its stored house turns out to be. */
function artOf(s: Settlement): SettlementArt {
  return artFor(s.kind, s.art);
}

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
// Raw HTML in a reply is shown as text, never rendered. Everything else marked
// escapes itself: code spans and blocks, plain text, link titles.
marked.use({ renderer: { html: ({ text }) => esc(text) } });

/**
 * A governor's reply, as markdown.
 *
 * Marked gets the raw text, and the `html` renderer above turns any tag a model
 * writes into visible text, so output cannot inject markup into the panel.
 * Escaping the text *before* parsing would also do that, but marked escapes
 * code again, so `~> 6.0` showed as `~&gt; 6.0`, and `>` blockquotes never
 * parsed.
 */
function markdown(text: string, parser: Marked | typeof marked = marked): string {
  try {
    return parser.parse(text, { async: false }) as string;
  } catch {
    return esc(text);
  }
}

/**
 * What you type, chat-app style: `*bold*` and `_italic_`. `**bold**` still
 * works. Governor replies keep standard markdown, where `*x*` is italic.
 */
const yourMarkdown = new Marked({ gfm: true, breaks: true });
yourMarkdown.use({
  renderer: {
    html: ({ text }) => esc(text),
    em(token) {
      const inner = this.parser.parseInline(token.tokens);
      return token.raw.startsWith("*") ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
    },
  },
});

/**
 * The breadcrumb: the thing the panel is open on, then each layer above it.
 * Every crumb but the last is a button back to that depth. The root carries a
 * line of status, shown only when nothing is stacked on it.
 */
function crumbs(root: string, rootClass: string, status: string): string {
  const parts = [
    `<button class="crumb${layers.length ? "" : " current"}" data-depth="0"><b class="${rootClass}">${esc(root)}</b></button>`,
  ];
  layers.forEach((id, i) => {
    const last = i === layers.length - 1;
    parts.push(`<span class="sep">›</span><button class="crumb${last ? " current" : ""}" data-depth="${i + 1}">${esc(layerLabel(id))}</button>`);
  });
  if (!layers.length) parts.push(`<span class="muted">${esc(status)}</span>`);
  return parts.join("");
}

function layerLabel(id: string): string {
  if (id === "ledger") return board.ledgers.find((l) => l.id === boardLedger)?.name ?? "Ledger";
  if (id === "bounty") {
    const b = board.bounties.find((x) => x.id === boardBounty);
    // Just the id: the title is the first thing on the sheet below, and a long
    // one would squeeze every crumb before it.
    return b ? bountyRef(b) : "Bounty";
  }
  return LAYER_LABELS[id] ?? id;
}

function bindCrumbs(): void {
  pane.querySelectorAll<HTMLButtonElement>("#crumbs .crumb:not(.current)").forEach((b) => {
    b.addEventListener("click", () => popLayer(Number(b.dataset.depth)));
  });
}

/**
 * Change the stack in place rather than re-rendering. A re-render builds each
 * sheet in its final position, so the browser has nothing to animate from and
 * it simply appears; toggling the class on the sheet already there slides it.
 */
function syncLayers(): void {
  pane.querySelectorAll<HTMLElement>(".layer[data-layer]").forEach((el) => {
    el.classList.toggle("open", layers.includes(el.dataset.layer!));
  });
  const btn = pane.querySelector<HTMLElement>("#details-toggle");
  const detailsOpen = layers.includes("details");
  btn?.classList.toggle("on", detailsOpen);
  btn?.setAttribute("aria-expanded", String(detailsOpen));
  btn?.setAttribute("title", detailsOpen ? "Hide details" : "Show details");
  const nav = pane.querySelector<HTMLElement>("#crumbs");
  const s = selected ? byId.get(selected) : null;
  if (nav && boardOpen) {
    nav.innerHTML = crumbs("Bounty board", "", boardStatus());
    bindCrumbs();
  } else if (nav && s) {
    nav.innerHTML = crumbs(s.name, s.state === "dormant" ? "muted" : "", `${s.kind} · ${stateWordOf(s)}`);
    bindCrumbs();
  }
}

function stateWordOf(s: Session): string {
  return { idle: "idle", working: "working", needs_you: "needs you", dormant: "dormant · will resume", error: "error" }[s.state];
}

function pushLayer(id: string): void {
  if (layers.includes(id)) return;
  layers.push(id);
  if (boardOpen) {
    // The board's layers are drawn from what was clicked, so render them
    // first, closed, then open them once the browser has a position to
    // slide from.
    entering = id;
    render();
    pane.querySelector<HTMLElement>(`.layer[data-layer="${id}"]`)?.getBoundingClientRect();
    entering = null;
  }
  syncLayers();
}

/** Drop back to `depth` layers: 0 is the thing itself. */
function popLayer(depth: number): void {
  if (depth >= layers.length) return;
  layers = layers.slice(0, depth);
  syncLayers();
}

/** The ceiling field, and how much of it this account session has used. */
function renderBudget(s: Session): string {
  const ceiling = s.maxBudgetUsd ?? realm.defaults.maxBudgetUsd;
  // A session that has already reset counts as nothing spent, even before the
  // Keep gets round to zeroing it.
  const expired = !!s.windowResetsAt && Date.parse(s.windowResetsAt) <= Date.now();
  const used = expired ? 0 : s.windowSpentUsd;
  const over = used >= ceiling - 0.01;
  const resets = s.windowResetsAt && !expired
    ? ` · resets ${new Date(s.windowResetsAt!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "";
  return `<input id="s-budget" type="number" min="0" step="0.5"
      value="${s.maxBudgetUsd ?? ""}" placeholder="Realm default — $${realm.defaults.maxBudgetUsd}">
    <p class="muted hint${over ? " overbudget" : ""}">$${used.toFixed(2)} of $${ceiling.toFixed(2)} this session${resets}${over ? " — out of budget" : ""}</p>`;
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
 * The ground is expensive and barely changes, so it is cached — in chunks.
 *
 * One cache covering the viewport is fine until you drag a long way: each time
 * the view leaves it the whole thing is repainted, which showed up as frames of
 * 100ms and more in the middle of a pan. A grid of small chunks means a long
 * drag only builds the few that have just come into view, each a fraction of a
 * full repaint.
 *
 * Chunks are sized in screen pixels, so their canvases stay the same size at
 * every zoom; the zoom is baked into the grid instead, and a zoom in motion
 * draws the set it has scaled until it settles.
 */
const CHUNK_PX = 384;
/** How many chunks may be built in one frame before the rest wait their turn. */
const CHUNK_BUDGET = 1;
/** Several screenfuls' worth; oldest evicted first. */
const CHUNK_LIMIT = 48;
/**
 * Overlap, in CSS pixels, painted beyond each chunk's own rectangle.
 *
 * A chunk's canvas is a whole number of device pixels but lands at a fractional
 * offset, so sampling its last column blends in the transparent pixel past the
 * edge and a thin dark line of background shows down every chunk boundary.
 * Chunks painted wide and drawn overlapping have no boundary to show through:
 * the ground's base fill is opaque, so whichever is drawn second covers the
 * strip.
 */
const CHUNK_BLEED = 1;
/** How long the zoom must hold still before the chunks are repainted for it. */
const SETTLE_MS = 120;

let groundChunks = new Map<string, HTMLCanvasElement>();
/** The hex size the cached chunks were painted at. */
let chunkSize = 0;
/** The pixel ratio they were painted at; a change of it voids them outright. */
let chunkDpr = 0;
/** The size seen on the last frame, and the time it first appeared. */
let lastSize = 0;
let lastSizeAt = 0;
let chunkBudget = 0;

function invalidateGround(): void {
  groundChunks = new Map();
}

/**
 * The landmass's drop shadow. Drawn straight to the screen, never into a chunk:
 * a blur clipped to a chunk would seam along every chunk edge.
 *
 * Only when the shore is in view. A blur costs by the area it covers, and
 * zoomed in the edge is far off screen while the blur was still being paid.
 */
function paintShore(size: number, vx: number, vy: number, vw: number, vh: number): void {
  if (perf.noShadow) return;
  const inradius = size * 1.5 * MAP_RADIUS;
  const reach = Math.hypot(vx + vw / 2, vy + vh / 2) + Math.hypot(vw / 2, vh / 2);
  if (reach <= inradius * 0.97) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(vx, vy, vw, vh);
  ctx.clip();
  ctx.translate(0, size * 0.09);
  ctx.fillStyle = "rgba(6,16,21,.55)";
  ctx.filter = `blur(${Math.max(2, size * 0.09)}px)`;
  ctx.fill(getRealmPath(size));
  ctx.restore();
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

function groundChunk(cx: number, cy: number, size: number): HTMLCanvasElement | null {
  const key = `${cx},${cy}`;
  const hit = groundChunks.get(key);
  if (hit) return hit;
  if (chunkBudget <= 0) return null;

  const span = CHUNK_PX + CHUNK_BLEED * 2;
  const c = document.createElement("canvas");
  c.width = Math.ceil(span * dpr);
  c.height = Math.ceil(span * dpr);
  const g = c.getContext("2d");
  if (!g) return null;
  chunkBudget--;

  const wx = cx * CHUNK_PX - CHUNK_BLEED;
  const wy = cy * CHUNK_PX - CHUNK_BLEED;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.translate(-wx, -wy);
  paintGround(g, size, wx, wy, span, span);

  groundChunks.set(key, c);
  if (groundChunks.size > CHUNK_LIMIT) {
    const oldest = groundChunks.keys().next().value;
    if (oldest !== undefined) groundChunks.delete(oldest);
  }
  return c;
}

/** Grass, tiled across the realm and anchored to the world so it pans with it. */
function drawGround(size: number): void {
  const origin = worldToScreen(0, 0);
  const vx = -origin.x;
  const vy = -origin.y;
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;

  ctx.save();
  ctx.translate(origin.x, origin.y);
  paintShore(size, vx, vy, vw, vh);

  if (perf.noCache) {
    paintGround(ctx, size, vx, vy, vw, vh);
    ctx.restore();
    return;
  }

  // Chunks bake the zoom in, so a change of zoom makes every one of them
  // wrong. Repainting them mid-gesture is hopeless: a viewport is a dozen
  // chunks and only one is built per frame, so the ground arrives a chunk at a
  // time while the next zoom step voids the lot — which is the flicker.
  // Instead the chunks already in hand are drawn scaled for as long as the zoom
  // keeps moving, which reads as the ground zooming with the map, and they are
  // repainted at the true size once it has held still.
  const now = performance.now();
  if (size !== lastSize) {
    lastSize = size;
    lastSizeAt = now;
  }
  if (dpr !== chunkDpr) {
    chunkDpr = dpr;
    invalidateGround();
  }
  if (!groundChunks.size || (size !== chunkSize && now - lastSizeAt >= SETTLE_MS)) {
    invalidateGround();
    chunkSize = size;
  }
  // Still waiting for the zoom to hold still: keep asking for frames so the
  // repaint lands the moment it does, not on the next heartbeat.
  if (size !== chunkSize) invalidate();

  // What the cached size has to be scaled by to stand in for the size wanted.
  const k = size / chunkSize;
  const step = CHUNK_PX * k;
  const bleed = CHUNK_BLEED * k;
  const x0 = Math.floor(vx / step);
  const x1 = Math.floor((vx + vw) / step);
  const y0 = Math.floor(vy / step);
  const y1 = Math.floor((vy + vh) / step);

  // A repaint for a settled zoom takes the whole viewport in one frame: it
  // costs what one uncached paint costs, and trickling it in would mean a run
  // of half-cached frames instead of one slow one. A long drag keeps the frame
  // budget it was tuned for.
  const refill = groundChunks.size === 0;
  chunkBudget = refill ? (x1 - x0 + 1) * (y1 - y0 + 1) : k === 1 ? CHUNK_BUDGET : 0;

  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const px = cx * step;
      const py = cy * step;
      const chunk = groundChunk(cx, cy, size);
      if (chunk) {
        ctx.drawImage(chunk, px - bleed, py - bleed, step + bleed * 2, step + bleed * 2);
        continue;
      }
      // Nothing cached and nothing to be had this frame — mid-zoom, or past the
      // frame's budget on a long drag. Paint this patch of ground straight to
      // the screen so water never shows through where ground belongs; the cache
      // catches up on a later frame.
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, step, step);
      ctx.clip();
      paintGround(ctx, size, px, py, step, step);
      ctx.restore();
      invalidate();
    }
  }
  ctx.restore();
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
/**
 * The pole beside a settlement, and the flag it raises.
 *
 * A bare pole stands there always; when the settlement needs you the same pole
 * is drawn waving, because every frame of the animation carries its own pole
 * and base. prep_assets.py fits the bare one onto the frames' own square at
 * the frames' own scale, so the swap moves nothing — the flag simply appears.
 *
 * It stands to the left, and the flag flies left, so the cloth waves away from
 * the building rather than over it.
 */
function drawFlagPole(
  state: SettlementState,
  sprite: string,
  cx: number,
  cy: number,
  size: number,
  t: number,
): void {
  const raised = state === "needs_you";
  const frame = Math.floor(t / (1000 / FLAG_FPS)) % FLAG_FRAMES;
  const img = sprites[raised ? `flag-${frame}` : "flag-pole"];
  if (!img) return;
  const h = size * FLAG_HEIGHT;
  const w = h * (img.width / img.height);
  // Clear of the building's edge, and standing on the same line it stands on —
  // its own art runs to the bottom of its sprite, so that is where the ground is.
  const shaftX = cx - size * FLAG_BESIDE;
  const ground = spriteFoot(sprite, cy, size) - size * FLAG_BEHIND;
  ctx.save();
  if (state === "dormant") ctx.globalAlpha = 0.62;
  ctx.drawImage(img, shaftX - w * FLAG_SHAFT, ground - h, w, h);
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

/**
 * A standing figure beside a building: a soft shadow on the ground under its
 * feet, then the figure. `box` is the part of the image that is the figure;
 * `cx` and `feet` are where its centre and its soles land on screen. `lean`
 * shifts the shadow by that fraction of the figure's width.
 */
function drawFigure(
  img: CanvasImageSource,
  box: { x: number; y: number; w: number; h: number },
  cx: number,
  feet: number,
  h: number,
  lean: number,
): void {
  const w = h * (box.w / box.h);
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = "#000";
  ctx.filter = `blur(${Math.max(1, w * 0.06)}px)`;
  ctx.beginPath();
  // An ellipse the width of the figure, flat on the ground under its feet.
  ctx.ellipse(cx + w * lean, feet - h * 0.05, w * 0.42, Math.max(1.5, w * 0.14), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.drawImage(img, box.x, box.y, box.w, box.h, cx - w / 2, feet - h, w, h);
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
    !!outlined &&
    (occupied.has(`${outlined.q},${outlined.r}`) || isRealmHex(outlined));
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
    // What you are about to raise, standing where it would stand. A ghost is
    // worth more than a label here: the houses differ by silhouette, and this
    // is the only place you see one at map scale before committing to it.
    const ghost = founding ? foundArt : building?.art;
    if (ghost) {
      ctx.save();
      ctx.globalAlpha = 0.46;
      drawSprite(ghost, x, y, size, false);
      ctx.restore();
    }
  }

  // The bounty board. Lit like the cottage when open or under the pointer —
  // and it carries the warden's state, since the warden is the board's own
  // Claude and has no tile of its own to raise a flag on.
  {
    const p = hexToPixel(bountyHex(), size);
    const { x, y } = worldToScreen(p.x, p.y);
    const hovered = !!hover && hexEq(hover, bountyHex());
    const warden = board.warden.state;
    const glow: Glow[] = [];
    if (warden === "working") {
      const pulse = 0.5 + 0.5 * Math.sin(t / 420);
      glow.push({ colour: "#58c0a8", blur: size * (0.14 + 0.16 * pulse), passes: 3 });
    } else if (warden === "needs_you") {
      const pulse = 0.5 + 0.5 * Math.sin(t / 300);
      glow.push({ colour: "#ff6a44", blur: size * (0.2 + 0.16 * pulse), passes: 4 });
    } else if (warden === "error") {
      glow.push({ colour: "#e05a3c", blur: size * 0.2, passes: 3 });
    }
    if (boardOpen) glow.push({ colour: "#e0b050", blur: size * 0.26, passes: 4 });
    else if (hovered) glow.push({ colour: "rgba(240,246,248,.85)", blur: size * 0.14, passes: 2 });
    // The warden's flag, on the board it keeps. Behind the board itself.
    drawFlagPole(warden, "bounty-board", x, y, size, t);
    drawSprite("bounty-board", x, y, size, false, glow);
    // The warden himself, standing at the board's right-hand side, the way you
    // stand by the cottage: fixed to it in world units, so he keeps his place
    // at every zoom. The pole is on the left, so the two never overlap.
    const wardenImg = sprites["warden"];
    if (wardenImg) {
      const h = size * 1.05;
      const w = h * (wardenImg.naturalWidth / wardenImg.naturalHeight);
      const boardFoot = spriteFoot("bounty-board", y, size);
      drawFigure(
        wardenImg,
        { x: 0, y: 0, w: wardenImg.naturalWidth, h: wardenImg.naturalHeight },
        x + size * SPRITE_FRACTION + w * 0.3,
        boardFoot - size * 0.3,
        h,
        0,
      );
    }
    if (camera.zoom >= BANNER_ALL_BELOW || boardOpen || hovered || warden === "needs_you") {
      const foot = spriteFoot("bounty-board", y, size);
      const open = board.bounties.filter((b) => b.state !== "done").length;
      const tint = warden === "needs_you" ? "#ffb08a" : "#f0dcae";
      plates.push(() => nameplate(open ? `Bounties · ${open}` : "Bounties", x, foot, tint, "#3a2a12"));
    }
  }

  // The rookery. Drawn as it is, but not open yet: its plate says so.
  {
    const p = hexToPixel(rookeryHex(), size);
    const { x, y } = worldToScreen(p.x, p.y);
    const hovered = !!hover && hexEq(hover, rookeryHex());
    drawSprite("rookery", x, y, size, false, hovered ? [{ colour: "rgba(240,246,248,.85)", blur: size * 0.14, passes: 2 }] : []);
    if (camera.zoom >= BANNER_ALL_BELOW || hovered) {
      const foot = spriteFoot("rookery", y, size);
      plates.push(() => nameplate("Rookery · soon", x, foot, "#d8d4cc", "#4a463e"));
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

    const foot = spriteFoot("cottage", y, size);

    // You, standing beside your own door: left of the cottage, clear of its
    // art, and drawn here with the sprites so the name plate passes in front
    // of you rather than the other way round.
    if (avatarImg && avatarBox) {
      const h = size * 1.1;
      const w = h * (avatarBox.w / avatarBox.h);
      // Fixed to the cottage, just off its left edge, in the same world units
      // as the building — so he keeps his place beside it at every zoom. The
      // name plate passes over him; it is drawn later. Shadow nudged right:
      // he stands with his weight off to one side.
      drawFigure(avatarImg, avatarBox, x - size * SPRITE_FRACTION - w * 0.45, foot - size * 0.36, h, 0.09);
    }

    if (camera.zoom >= BANNER_ALL_BELOW || cottageOpen || hoveredCottage) {
      plates.push(() => nameplate(realm.defaults.cottageName || "You", x, foot, "#f0dcae", "#3a2a12"));
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
    // Behind the building, so anything that leans in is overlapped by it.
    drawFlagPole(s.state, artOf(s), dx, dy, size, t);
    drawSprite(artOf(s), dx, dy, size, s.state === "dormant", glows);

    // The plate carries state too: amber when it wants you, washed out when dormant.
    const tint =
      s.state === "needs_you" ? "#ffb08a" : s.state === "dormant" ? "#b9bfbd" : "#f4ead2";
    const ink = s.state === "dormant" ? "#4a5356" : "#2d2112";
    const worthShowing =
      camera.zoom >= BANNER_ALL_BELOW ||
      s.id === selected ||
      s.state === "needs_you" ||
      (!!hover && hexEq(hover, s.hex));
    const foot = spriteFoot(artOf(s), dy, size);
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
      nameplate(s.name, x, spriteFoot(artOf(s), y, size), tint, s.state === "dormant" ? "#4a5356" : "#2d2112");
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
  // The warden's flag waves on the board, so the board animates for it too.
  if (board.warden.state === "working" || board.warden.state === "needs_you") return true;
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
  if (isRealmHex(h)) return false;
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

/** The hex under the pointer, in the top bar: its coordinate and what is on it. */
const coordEl = document.getElementById("coord")!;
function showCoord(h: { q: number; r: number } | null): void {
  if (!h || !realm) { coordEl.textContent = ""; return; }
  const num = (n: number) => (n < 0 ? `−${-n}` : String(n));
  const what = hexEq(h, realm.cottageHex)
    ? realm.defaults.cottageName || "the cottage"
    : hexEq(h, bountyHex())
      ? "bounty board"
      : hexEq(h, rookeryHex())
        ? "rookery"
        : settlementAt(h)?.name ?? "";
  coordEl.textContent = `q ${num(h.q)} · r ${num(h.r)}${what ? `  ·  ${what}` : ""}`;
}

window.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
  const h = pixelToHex(w.x, w.y, hexSize());
  const nextHover = hexDistance(h, { q: 0, r: 0 }) <= MAP_RADIUS ? h : null;
  if (!!nextHover !== !!hover || (nextHover && hover && !hexEq(nextHover, hover))) invalidate();
  hover = nextHover;
  showCoord(e.target === canvas ? nextHover : null);

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

/**
 * Glide the camera somewhere instead of teleporting.
 *
 * Snapping the map leaves you to work out what moved; a short ease makes the
 * relationship between where you were and where you are obvious. Interrupted by
 * any later call, so a second click during a flight simply takes over.
 */
let flightId = 0;

function flyTo(x: number, y: number, zoom?: number, ms = 420): void {
  const id = ++flightId;
  const fromX = camera.x;
  const fromY = camera.y;
  const fromZoom = camera.zoom;
  const dx = x - fromX;
  const dy = y - fromY;
  const dz = (zoom ?? fromZoom) - fromZoom;
  if (Math.hypot(dx, dy) < 1 && Math.abs(dz) < 0.001) return;
  const started = performance.now();
  const step = (now: number) => {
    if (id !== flightId) return;
    const t = Math.min(1, (now - started) / ms);
    const e = 1 - (1 - t) ** 3; // ease out: quick away, gentle arrival
    camera.x = fromX + dx * e;
    camera.y = fromY + dy * e;
    camera.zoom = fromZoom + dz * e;
    invalidate();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

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

/**
 * ⌘= / ⌘- / ⌘0: bigger, smaller, or normal conversation text. Held on the root
 * element so the panel's re-renders keep it, and remembered between launches.
 * Checked before the typing guard, so it works from the message box too.
 */
const CHAT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2];
let chatScale = Number(localStorage.getItem("chatScale")) || 1;
function setChatScale(next: number): void {
  chatScale = next;
  document.documentElement.style.setProperty("--chat-scale", String(next));
  localStorage.setItem("chatScale", String(next));
}
setChatScale(CHAT_SCALES.includes(chatScale) ? chatScale : 1);

window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const i = CHAT_SCALES.indexOf(chatScale);
  let next: number | null = null;
  if (e.key === "=" || e.key === "+") next = CHAT_SCALES[Math.min(i + 1, CHAT_SCALES.length - 1)]!;
  else if (e.key === "-" || e.key === "_") next = CHAT_SCALES[Math.max(i - 1, 0)]!;
  else if (e.key === "0") next = 1;
  if (next === null) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  setChatScale(next);
  toast(`Conversation text ${Math.round(next * 100)}%`);
});

window.addEventListener("keydown", (e) => {
  const typing = document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA";
  if (typing) return;
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  if (e.key === "=" || e.key === "+") zoomAt(cx, cy, 1.2);
  else if (e.key === "-" || e.key === "_") zoomAt(cx, cy, 1 / 1.2);
  else if (e.key === "0") flyTo(0, 0, ZOOM_DEFAULT);
  invalidate();
});

function clickHex(h: { q: number; r: number }): void {
  razeArmed = null;
  razeTyped = "";
  layers = [];
  // Only empty ground places what is in hand. Clicking anything else is not a
  // placement, so the tool goes down rather than following you around the map
  // with no way left on screen to say how to stop it.
  if (hexEq(h, bountyHex())) {
    setBuilding(null);
    openBoard();
    return;
  }
  if (hexEq(h, rookeryHex())) {
    setBuilding(null);
    toast("The rookery isn't open yet. Messengers will fly from here.");
    render();
    return;
  }
  if (hexEq(h, realm.cottageHex)) {
    selected = null;
    founding = null;
    cottageOpen = true;
    boardOpen = false;
    setBuilding(null);
    void refreshBudgets();
    render();
    return;
  }
  const s = [...byId.values()].find((x) => hexEq(x.hex, h));
  cottageOpen = false;
  boardOpen = false;
  if (s) {
    selected = s.id;
    founding = null;
    setBuilding(null);
  } else if (building) {
    selected = null;
    founding = h;
    // The build tool has already answered the first two questions, so the form
    // opens on the house you picked rather than back on the default.
    foundKind = building.kind;
    foundArt = building.art;
    foundMode = "existing";
    setBuilding(null);
  } else {
    // Bare ground, nothing in hand. Founding belongs to the build tool now, so
    // a stray click on grass puts the panel down instead of opening a form
    // nobody asked for — which also makes it the way out of one.
    selected = null;
    founding = null;
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
    <p class="muted" style="margin-top:0">Who you are, what every settlement inherits, and what each account has left.</p>

    <h2>You</h2>
    <div class="field">
      <label>Name</label>
      <input id="d-cottage-name" maxlength="24" placeholder="You" value="${esc(d.cottageName)}" />
      <p class="muted hint">What the cottage is called on the map.</p>
    </div>
    <div class="field">
      <label>Avatar</label>
      <div class="avatarrow">
        <div class="avatarprev empty" id="d-avatar-prev"></div>
        <div class="btns">
          <button id="d-avatar-pick">Choose image…</button>
          <button id="d-avatar-clear">Remove</button>
        </div>
      </div>
      <p class="muted hint">Stands outside the cottage. Kept beside your realm rather than in the app, so it stays yours.</p>
    </div>

    <h2>Budget</h2>
    ${budgetsLoading ? '<div class="muted">probing accounts…</div>' : rows || '<div class="muted">no accounts</div>'}
    <div class="btns"><button id="reprobe">Refresh</button></div>
    <p class="muted hint">Plan limits are published as percent and a reset time; there is no token balance to show. Per-settlement token counts are exact — see a settlement.</p>

    <h2>Defaults</h2>
    <div class="field">
      <label>Model</label>
      <select id="d-model">${modelOptions(d.model, models.length ? "Claude Code's default" : "loading models…")}</select>
      <p class="muted hint">What a settlement uses unless it overrides this.</p>
    </div>
    <div class="field">
      <label>Notify me</label>
      <select id="d-notify">${NOTIFY_WHEN.map(
        (n) => `<option value="${n.value}"${n.value === d.notifications ? " selected" : ""}>${esc(n.label)}</option>`,
      ).join("")}</select>
      <p class="muted hint">When a settlement needs you, or finishes what it was doing.</p>
      <div class="btns"><button id="d-testnotify">Send a test notification</button></div>
    </div>
    <div class="field">
      <label>Asks before acting</label>
      <select id="d-mode">${modeOptions(d.permissionMode, null)}</select>
      <p class="muted hint">${esc(modeHint(d.permissionMode))}</p>
    </div>
    <div class="field">
      <label>Base folder for new settlements</label>
      <div style="display:flex;gap:6px">
        <input id="d-base" placeholder="e.g. ~/Documents/repos" value="${esc(d.baseFolder ?? "")}" />
        <button id="d-browse">Browse</button>
      </div>
      <p class="muted hint">Where the folder browser opens when you found a camp or a city.</p>
    </div>
    <div class="field"><label>Camp idle timeout (minutes)</label><input id="d-camp" type="number" min="1" value="${d.campIdleMinutes}"></div>
    <div class="field"><label>City idle timeout (minutes)</label><input id="d-city" type="number" min="1" value="${d.cityIdleMinutes}"></div>
    <div class="field"><label>Per-settlement budget ceiling (USD)</label><input id="d-budget" type="number" min="0" step="0.5" value="${d.maxBudgetUsd}"></div>
    <div class="btns"><button class="primary" id="d-save">Save</button></div>`;
}

/**
 * One house, as the blank tile with its art laid inside the frame.
 *
 * The frame is the same slate the rail buttons are cut from, so a house reads
 * as something you pick up rather than a picture of a building.
 */
function artTile(kind: SettlementKind, art: SettlementArt, chosen: boolean): string {
  const def = SETTLEMENT_ART.find((a) => a.value === art);
  if (!def) return "";
  return `<button class="choice${chosen ? " on" : ""}" data-kind="${kind}" data-art="${art}"
      title="${esc(def.label)} ${kind}" aria-pressed="${chosen}">
      <span class="tile">
        <img class="frame" src="./assets/blank.png" alt="" />
        <img class="art" src="./assets/${art}.png" alt="" />
      </span>
      <span class="cap">${esc(def.label)}</span>
    </button>`;
}

/** Every house a kind can be built in, with one of them lit. */
function artChoices(kind: SettlementKind, chosen: string): string {
  return SETTLEMENT_ART.filter((a) => a.kind === kind)
    .map((a) => artTile(kind, a.value, a.value === chosen))
    .join("");
}

function renderPalette(): string {
  const d = realm.defaults;
  return `<h3>Camps<span>short work · reaped after ${d.campIdleMinutes}m idle</span></h3>
    <div class="choices">${artChoices("camp", building?.kind === "camp" ? building.art : "")}</div>
    <h3>Cities<span>a long project · kept warm for ${d.cityIdleMinutes}m</span></h3>
    <div class="choices">${artChoices("city", building?.kind === "city" ? building.art : "")}</div>`;
}

function renderFounding(h: { q: number; r: number }): string {
  const base = realm.defaults.baseFolder;
  // Both ways of making a folder put it in the realm's base folder, so say
  // which one — and say it plainly when there is not one to put it in.
  const where = (verb: string): string =>
    base
      ? `<p class="muted hint">${verb} <span class="mono">${esc(base)}</span>.</p>`
      : `<p class="muted hint">No base folder yet — set one in the cottage first.</p>`;
  return `<h2>Found a settlement</h2>
    <p class="muted" style="margin-top:0">Empty ground at <span class="mono">${h.q}, ${h.r}</span>.</p>
    <label>Kind</label>
    <select id="f-kind">
      <option value="camp"${foundKind === "camp" ? " selected" : ""}>Camp — short work, reaped quickly</option>
      <option value="city"${foundKind === "city" ? " selected" : ""}>City — a long project, kept warm</option>
    </select>
    <label>House</label>
    <div class="choices" id="f-art">${artChoices(foundKind, foundArt)}</div>
    <p class="muted hint">Looks only. Build a run of related projects in the same house and the map groups them for you.</p>
    <label>Folder</label>
    <div class="seg" id="f-mode">
      <button type="button" data-mode="existing" class="on">On disk</button>
      <button type="button" data-mode="new">New folder</button>
      <button type="button" data-mode="clone">Clone a repo</button>
    </div>
    <div class="fmode" data-mode="existing">
      <div style="display:flex;gap:6px"><input id="f-cwd" placeholder="${esc(base ?? "/path/to/project")}" value="${esc(base ?? "")}" /><button id="f-pick">Browse</button></div>
    </div>
    <div class="fmode hidden" data-mode="new">
      <input id="f-newname" placeholder="folder name" autocomplete="off" spellcheck="false" />
      ${where("Created empty in")}
    </div>
    <div class="fmode hidden" data-mode="clone">
      <input id="f-url" placeholder="https://github.com/you/project.git" autocomplete="off" spellcheck="false" />
      ${where("Cloned into")}
      <p class="muted hint">The settlement takes the folder git makes, not the one above it.</p>
    </div>
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
  | { kind: "bubble"; entry: Session["chat"][number] }
  | { kind: "run"; entries: Session["chat"][number][]; key: string };

function groupChat(s: Session): ChatGroup[] {
  const out: ChatGroup[] = [];
  let run: Session["chat"][number][] = [];
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

function runSummary(entries: Session["chat"][number][]): string {
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

/**
 * The raised flag. The same block for a governor and for the warden: what it
 * wants in one line, and the answers.
 *
 * Most flags are allow or decline. One that carries its own choices — the
 * warden's close flag, where "no" means two different things — draws a button
 * per choice with a line under it saying what it does, because the difference
 * between sending work back and leaving it alone is the whole question.
 */
function renderFlag(s: Session): string {
  if (!s.flag) return "";
  const choices = s.flag.choices ?? [];
  const answers = choices.length
    ? `<div class="btns">${choices
        .map((c, i) => `<button class="${i === 0 ? "primary" : ""}" data-choice="${esc(c.value)}">${esc(c.label)}</button>`)
        .join("")}</div>
      <div class="choicehints">${choices
        .filter((c) => c.hint)
        .map((c) => `<div><b>${esc(c.label)}</b> — ${esc(c.hint!)}</div>`)
        .join("")}</div>`
    : `<div class="btns">
        <button class="primary" id="allow">Allow</button>
        <button class="danger" id="deny">Decline</button>
      </div>`;
  return `<div class="flag">
      <h3>Needs you</h3>
      <div class="what${choices.length ? " said" : ""}">${esc(s.flag.summary)}</div>
      ${answers}
    </div>`;
}

/**
 * Wire whichever answers the flag drew.
 *
 * `answer` takes the same shape the Keep does: true, false, or the value of one
 * of the flag's own choices.
 */
function bindFlag(root: ParentNode, answer: (a: boolean | string) => void): void {
  root.querySelector("#allow")?.addEventListener("click", () => answer(true));
  root.querySelector("#deny")?.addEventListener("click", () => answer(false));
  root.querySelectorAll<HTMLButtonElement>(".flag [data-choice]").forEach((b) =>
    b.addEventListener("click", () => answer(b.dataset.choice!)),
  );
}

/** The transcript: bubbles, with the work between them folded into one line. */
function renderChat(s: Session): string {
  const groups = groupChat(s);
  return groups
    .map((g, i) => {
      if (g.kind === "bubble") {
        // Both sides speak markdown. The governor gets your text exactly as
        // typed; only the bubble renders it.
        return `<div class="msg ${g.entry.role} md">${markdown(g.entry.text, g.entry.role === "you" ? yourMarkdown : marked)}</div>`;
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
}

/** What a session has cost: the rows both a settlement and the warden show. */
function renderSpend(s: Session): string {
  const tk = s.tokens;
  const total = tk.input + tk.output;
  return `<div class="kv"><span class="k">Tokens</span><span class="v mono">${total.toLocaleString()}</span></div>
    <div class="kv sub"><span class="k">In · Out · Cached</span><span class="v mono">${tk.input.toLocaleString()} · ${tk.output.toLocaleString()} · ${tk.cacheRead.toLocaleString()}</span></div>
    <div class="kv"><span class="k">Spent, this conversation</span><span class="v mono">$${s.costUsd.toFixed(4)}</span></div>`;
}

function renderSettlement(s: Settlement): string {
  const stateWord = stateWordOf(s);
  const flag = renderFlag(s);
  const chat = renderChat(s);

  // Only the name is pinned. Everything else about a settlement lives behind
  // the info button, in a sheet that slides over the transcript — the details
  // are worth a glance now and then, the conversation is worth the room.
  const tint = s.state === "dormant" ? "muted" : "";
  const detailsOpen = layers.includes("details");
  return `<div class="shead">
      <nav class="who crumbs" id="crumbs">${crumbs(s.name, tint, `${s.kind} · ${stateWord}`)}</nav>
      <button class="infobtn${detailsOpen ? " on" : ""}" id="details-toggle"
        title="${detailsOpen ? "Hide details" : "Show details"}" aria-expanded="${detailsOpen}">
        <img src="./assets/info.png" alt="Details" />
      </button>
    </div>
    ${flag}
    <div class="chatwrap">
      <div class="layer details${detailsOpen ? " open" : ""}" id="details" data-layer="details">
        <div class="kv"><span class="k">Folder</span><span class="v mono">${esc(s.cwd)}</span></div>
        <div class="kv"><span class="k">Account</span><span class="v mono">${esc(s.profileId)}</span></div>
        ${renderSpend(s)}
        <div class="kv"><span class="k">Founded</span><span class="v">${esc(new Date(s.foundedAt).toLocaleDateString())}</span></div>

        <label>Asks before acting</label>
        <select id="s-mode">${modeOptions(
          s.permissionMode,
          realm.defaults.permissionMode ? `Realm default — ${modeLabel(realm.defaults.permissionMode)}` : "Realm default",
        )}</select>
        <p class="muted hint">${esc(modeHint(s.permissionMode ?? realm.defaults.permissionMode))} · Shift+Tab cycles</p>

        <label>Budget ceiling (USD)</label>
        ${renderBudget(s)}

        <label>Model</label>
        <select id="s-model">${modelOptions(
          s.model,
          realm.defaults.model ? `Realm default — ${modelLabel(realm.defaults.model)}` : "Realm default",
        )}</select>

        <label>House</label>
        <div class="choices" id="s-art">${artChoices(s.kind, artOf(s))}</div>

        ${s.error ? `<div class="msg system">${esc(s.error)}</div>` : ""}
        <div class="razerow">${renderRaze(s)}</div>
      </div>
      <div id="chat" class="chatscroll">${chat || '<div class="muted">Nothing said yet.</div>'}</div>
    </div>`;
}

// ── the bounty board ──────────────────────────────────────────────────────────

function openBoard(): void {
  selected = null;
  cottageOpen = false;
  founding = null;
  boardOpen = true;
  layers = [];
  boardLedger = null;
  boardBounty = null;
  deleteArmed = null;
  render();
}

function openCount(ledgerId?: string): number {
  return board.bounties.filter((b) => b.state !== "done" && (!ledgerId || b.ledgerId === ledgerId)).length;
}

function boardStatus(): string {
  const n = openCount();
  const open = n ? `${n} open` : "nothing open";
  const w = board.warden;
  // The warden's state belongs here: it is the board's, and the board's header
  // is the only place you would look for it.
  const doing =
    w.state === "working" ? "warden working" :
    w.state === "needs_you" ? "warden needs you" :
    w.state === "error" ? "warden stopped" : "";
  return doing ? `${open} · ${doing}` : open;
}

/**
 * The warden's own sheet: what it has cost, what it may spend, and which model
 * it thinks with. The same fields a settlement has, minus everything about a
 * folder — it has no code, no house and no account of its own.
 */
function renderWarden(w: Warden): string {
  return `<h2>The warden</h2>
    <p class="muted" style="margin-top:0">The board's own Claude. It can post, edit, move and comment on
      bounties by itself; assigning and closing raise a flag for you. It never messages a settlement.</p>
    <div class="kv"><span class="k">State</span><span class="v">${esc(stateWordOf(w))}</span></div>
    ${renderSpend(w)}
    <div class="kv"><span class="k">Folder</span><span class="v mono">${esc(w.cwd)}</span></div>
    <p class="muted hint">An empty folder in your realm. The warden has no tools but the board's: no files, no shell, no code.</p>

    <label>Budget ceiling (USD)</label>
    ${renderBudget(w)}

    <label>Model</label>
    <select id="s-model">${modelOptions(
      w.model,
      realm.defaults.model ? `Realm default — ${modelLabel(realm.defaults.model)}` : "Realm default",
    )}</select>

    ${w.error ? `<div class="msg system">${esc(w.error)}</div>` : ""}`;
}

function settlementName(id: string | null): string {
  return (id && byId.get(id)?.name) || "";
}

/** Send a change to the Keep. The board comes back by push; errors become a toast. */
async function boardDo(op: BoardOp): Promise<boolean> {
  try {
    board = await keep.boardOp(op);
    return true;
  } catch (e) {
    toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    return false;
  }
}

function renderLedgers(): string {
  const rows = board.ledgers
    .map((l) => {
      const n = openCount(l.id);
      const who = l.grants.length
        ? `read by ${l.grants.map(settlementName).filter(Boolean).join(", ")}`
        : "yours alone";
      return `<button class="ledgerrow" data-ledger="${esc(l.id)}">
          <span class="lname">${esc(l.name)}</span>
          <span class="muted">${n} open · ${esc(who)}</span>
        </button>`;
    })
    .join("");
  return `<h2>Ledgers</h2>
    <div class="ledgers">${rows}</div>
    <div class="addrow">
      <input id="b-new-ledger" maxlength="80" placeholder="A new ledger… (Enter)" />
    </div>
    <p class="muted hint">A checklist. Grant one to cities, or keep it to yourself.</p>`;
}

function renderLedger(l: Ledger | undefined): string {
  if (!l) return "";
  const all = board.bounties.filter((b) => b.ledgerId === l.id);
  const shown = all
    .filter((b) => (boardFilter === "all" ? true : boardFilter === "done" ? b.state === "done" : b.state !== "done"))
    .sort((a, b) => (a.state === "done" ? 1 : 0) - (b.state === "done" ? 1 : 0) || a.createdAt - b.createdAt);
  const items = shown
    .map((b) => `<li class="bountyrow ${b.state}">
        <input type="checkbox" data-done="${esc(b.id)}" ${b.state === "done" ? "checked" : ""} title="${b.state === "done" ? "Open again" : "Mark done"}" />
        <span class="bid">${bountyRef(b)}</span>
        <button class="btitle" data-bounty="${esc(b.id)}">${esc(b.title)}</button>
        ${b.assignee ? `<span class="muted who">${esc(settlementName(b.assignee))}</span>` : ""}
      </li>`)
    .join("");
  const seg = (v: typeof boardFilter, label: string) =>
    `<button data-filter="${v}" class="${boardFilter === v ? "on" : ""}">${label}</button>`;
  // Only the cities that can read it are listed; the rest wait in the select.
  const readers = l.grants
    .map((id) => byId.get(id))
    .filter((s): s is Settlement => !!s)
    .map((s) => `<div class="grant">
        <span class="gname">${esc(s.name)}</span>
        <span class="muted">${esc(s.kind)}</span>
        <button class="ungrant" data-ungrant="${esc(s.id)}" title="Stop ${esc(s.name)} reading this ledger" aria-label="Remove">×</button>
      </div>`)
    .join("");
  const others = [...byId.values()]
    .filter((s) => !l.grants.includes(s.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const addSelect = others.length
    ? `<select id="b-grant-add">
        <option value="">Add a city…</option>
        ${others.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.kind)}</option>`).join("")}
      </select>`
    : "";
  return `<div class="seg" id="b-filter">${seg("open", `Open · ${openCount(l.id)}`)}${seg("done", "Done")}${seg("all", "All")}</div>
    <div class="addrow"><input id="b-new-bounty" maxlength="200" placeholder="Post a bounty… (Enter)" /></div>
    <ul class="checklist">${items || `<li class="muted">${boardFilter === "done" ? "Nothing done yet." : "Nothing here."}</li>`}</ul>

    <label>Read by</label>
    <div class="grants">${readers || '<div class="muted">Nobody: this ledger is yours alone.</div>'}</div>
    ${addSelect}
    <p class="muted hint">A granted city can read this ledger's bounties, and report one fixed to the warden. Nothing else.</p>

    <label>Ledger name</label>
    <input id="b-ledger-name" maxlength="80" value="${esc(l.name)}" />
    <div class="btns">
      <button id="b-ledger-delete" class="danger">${deleteArmed === l.id ? "Click again to delete" : "Delete ledger"}</button>
    </div>`;
}

function renderBounty(b: Bounty | undefined): string {
  if (!b) return "";
  const when = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const log = b.log
    .map((e) => `<div class="logline ${e.who}">
        <div class="muted meta">${esc(e.who === "you" ? realm.defaults.cottageName || "You" : e.who === "warden" ? "Warden" : "Board")} · ${esc(when(e.at))}</div>
        <div class="${e.who === "board" ? "" : "md"}">${e.who === "board" ? esc(e.text) : markdown(e.text, e.who === "you" ? yourMarkdown : marked)}</div>
      </div>`)
    .join("");
  const people = [...byId.values()].sort((a, c) => a.name.localeCompare(c.name));
  const assignOpts = [`<option value="">Nobody</option>`]
    .concat(people.map((s) => `<option value="${esc(s.id)}" ${b.assignee === s.id ? "selected" : ""}>${esc(s.name)}</option>`))
    .join("");
  const ledgerOpts = board.ledgers
    .map((l) => `<option value="${esc(l.id)}" ${b.ledgerId === l.id ? "selected" : ""}>${esc(l.name)}</option>`)
    .join("");
  const stateWord = b.state === "done" ? "Done" : b.state === "assigned" ? "Assigned" : "Open";
  return `<div class="bidrow">
      <span class="bid big">${bountyRef(b)}</span>
      <button id="b-copy" title="Copy its id, title and notes, to hand to a governor">Copy</button>
    </div>
    <label>Bounty</label>
    <textarea id="b-title" rows="2" maxlength="200">${esc(b.title)}</textarea>
    <label>Notes</label>
    <textarea id="b-notes" rows="4" placeholder="What it is, where to look, how to know it is done.">${esc(b.notes)}</textarea>

    <div class="kv"><span class="k">State</span><span class="v">${stateWord}</span></div>
    ${b.branch ? `<div class="kv"><span class="k">Branch · commit</span><span class="v mono">${esc(b.branch)} · ${esc(b.commit ?? "")}</span></div>` : ""}

    <label>Assigned to</label>
    <select id="b-assign">${assignOpts}</select>
    <p class="muted hint">Only recorded: nothing is sent. Tell the governor yourself, by ${bountyRef(b)}.</p>

    <label>Ledger</label>
    <select id="b-move">${ledgerOpts}</select>

    <div class="btns">
      <button id="b-done" class="primary">${b.state === "done" ? "Open again" : "Mark done"}</button>
      <button id="b-delete" class="danger">${deleteArmed === b.id ? "Click again to delete" : "Delete"}</button>
    </div>

    <label>Log</label>
    <div class="blog">${log}</div>
    <textarea id="b-comment" rows="2" placeholder="Add to the log… (Enter, Shift+Enter for a new line)"></textarea>`;
}

function renderBoardPane(): void {
  // The board re-renders whenever it changes — and the warden changes it on
  // every message it says. Carry over whatever was being typed, and where each
  // sheet was scrolled, so nothing jumps or is lost.
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const typed = active && pane.contains(active) && active.id && "value" in active
    ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd }
    : null;
  const scrolls = new Map<string, number>();
  pane.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => scrolls.set(el.dataset.scroll!, el.scrollTop));
  // Only follow the warden's new messages if you were already at the newest.
  const chatBox = pane.querySelector<HTMLElement>("#chat.chatscroll");
  const chatAtBottom =
    !chatBox || chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 48;

  // Something open on the board may have gone: fall back to what still exists.
  if (boardLedger && !board.ledgers.some((l) => l.id === boardLedger)) { boardLedger = null; layers = []; }
  if (boardBounty && !board.bounties.some((b) => b.id === boardBounty)) { boardBounty = null; layers = layers.filter((x) => x !== "bounty"); }

  const w = board.warden;
  const detailsOpen = layers.includes("details");
  const isOpen = (id: string) => (layers.includes(id) && id !== entering ? " open" : "");
  pane.innerHTML = `<div class="shead">
      <nav class="who crumbs" id="crumbs">${crumbs("Bounty board", "", boardStatus())}</nav>
      <button class="infobtn${detailsOpen ? " on" : ""}" id="details-toggle"
        title="${detailsOpen ? "Hide the warden" : "The warden"}" aria-expanded="${detailsOpen}">
        <img src="./assets/info.png" alt="The warden" />
      </button>
    </div>
    ${renderFlag(w)}
    <div class="chatwrap">
      <div class="boardroot">
        <div class="boardtop" data-scroll="top">${renderLedgers()}</div>
        <div id="chat" class="chatscroll" data-scroll="chat">${renderChat(w) || '<div class="muted">Ask the warden to sort out your to-do list. Brain-dump at it and it will propose bounties before it posts any.</div>'}</div>
      </div>
      <div class="layer${isOpen("ledger")}" data-layer="ledger" data-scroll="ledger" style="z-index: 3">${renderLedger(board.ledgers.find((l) => l.id === boardLedger))}</div>
      <div class="layer${isOpen("bounty")}" data-layer="bounty" data-scroll="bounty" style="z-index: 4">${renderBounty(board.bounties.find((b) => b.id === boardBounty))}</div>
      <div class="layer${isOpen("details")}" data-layer="details" data-scroll="details" style="z-index: 5">${renderWarden(w)}</div>
    </div>`;
  // The board is talked to like a settlement, but there is no folder to open a
  // terminal at: the warden's is deliberately empty.
  composer.classList.remove("hidden");
  promptEl.placeholder = "Talk to the warden…  (Enter sends, Shift+Enter for a new line)";
  terminalBtn.classList.add("hidden");
  hint.textContent = "the bounty board";

  pane.querySelectorAll<HTMLElement>("[data-scroll]").forEach((el) => {
    const top = scrolls.get(el.dataset.scroll!);
    if (top !== undefined) el.scrollTop = top;
  });
  const chatAfter = pane.querySelector<HTMLElement>("#chat.chatscroll");
  if (chatAfter && chatAtBottom) chatAfter.scrollTop = chatAfter.scrollHeight;
  if (typed) {
    const el = pane.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${CSS.escape(typed.id)}`);
    if (el) {
      el.value = typed.value;
      el.focus();
      try { el.setSelectionRange(typed.start, typed.end); } catch { /* not a text field */ }
    }
  }
  bindCrumbs();
  bindBoard();
}

function bindBoard(): void {
  const $ = <T extends HTMLElement>(sel: string) => pane.querySelector<T>(sel);

  // The warden
  const w = board.warden;
  $("#details-toggle")?.addEventListener("click", () => {
    if (layers.includes("details")) popLayer(layers.indexOf("details"));
    else pushLayer("details");
  });
  bindFlag(pane, (a) => void keep.wardenAnswerFlag(a));
  $<HTMLSelectElement>("#s-model")?.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value || null;
    w.model = value;
    void keep.wardenSetModel(value);
    toast(value ? `the warden now uses ${modelLabel(value)}` : "the warden follows the realm default");
  });
  $<HTMLInputElement>("#s-budget")?.addEventListener("change", (e) => {
    const raw = (e.target as HTMLInputElement).value.trim();
    const n = Number(raw);
    const value = raw === "" || !Number.isFinite(n) || n < 0 ? null : n;
    w.maxBudgetUsd = value;
    void keep.wardenSetBudget(value);
    render();
    toast(value === null ? "the warden: realm default budget" : `the warden: $${value.toFixed(2)} ceiling`);
  });
  // The folded run of board tools between two of the warden's answers.
  pane.querySelectorAll<HTMLButtonElement>(".runtoggle").forEach((b) =>
    b.addEventListener("click", () => {
      const key = b.dataset.run;
      if (!key) return;
      if (expandedRuns.has(key)) expandedRuns.delete(key);
      else expandedRuns.add(key);
      render();
    }),
  );
  // A link in a reply would otherwise replace the whole app with a web page.
  pane.querySelectorAll<HTMLAnchorElement>(".md a[href]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void keep.openExternal(a.href);
    }),
  );
  const onEnter = (el: HTMLInputElement | HTMLTextAreaElement | null, go: (v: string) => void) =>
    el?.addEventListener("keydown", (e) => {
      const k = e as KeyboardEvent;
      if (k.key !== "Enter" || k.shiftKey || k.isComposing) return;
      k.preventDefault();
      const v = el.value.trim();
      if (!v) return;
      el.value = "";
      go(v);
    });

  // Ledgers
  pane.querySelectorAll<HTMLButtonElement>(".ledgerrow").forEach((b) =>
    b.addEventListener("click", () => {
      boardLedger = b.dataset.ledger!;
      boardBounty = null;
      deleteArmed = null;
      layers = [];
      pushLayer("ledger");
    }),
  );
  onEnter($<HTMLInputElement>("#b-new-ledger"), (name) => void boardDo({ op: "addLedger", name }));

  // A ledger
  const l = board.ledgers.find((x) => x.id === boardLedger);
  pane.querySelectorAll<HTMLButtonElement>("#b-filter button").forEach((b) =>
    b.addEventListener("click", () => {
      boardFilter = b.dataset.filter as typeof boardFilter;
      render();
    }),
  );
  if (l) onEnter($<HTMLInputElement>("#b-new-bounty"), (title) => void boardDo({ op: "addBounty", ledgerId: l.id, title }));
  pane.querySelectorAll<HTMLInputElement>("[data-done]").forEach((c) =>
    c.addEventListener("change", () => void boardDo({ op: "setDone", id: c.dataset.done!, done: c.checked })),
  );
  pane.querySelectorAll<HTMLButtonElement>(".btitle").forEach((b) =>
    b.addEventListener("click", () => {
      boardBounty = b.dataset.bounty!;
      deleteArmed = null;
      layers = layers.filter((x) => x !== "bounty");
      pushLayer("bounty");
    }),
  );
  $<HTMLSelectElement>("#b-grant-add")?.addEventListener("change", (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (l && id) void boardDo({ op: "setGrants", id: l.id, grants: [...l.grants, id] });
  });
  pane.querySelectorAll<HTMLButtonElement>("[data-ungrant]").forEach((b) =>
    b.addEventListener("click", () => {
      if (l) void boardDo({ op: "setGrants", id: l.id, grants: l.grants.filter((g) => g !== b.dataset.ungrant) });
    }),
  );
  $<HTMLInputElement>("#b-ledger-name")?.addEventListener("change", (e) => {
    if (l) void boardDo({ op: "renameLedger", id: l.id, name: (e.target as HTMLInputElement).value });
  });
  $<HTMLButtonElement>("#b-ledger-delete")?.addEventListener("click", async () => {
    if (!l) return;
    if (deleteArmed !== l.id) { deleteArmed = l.id; render(); return; }
    deleteArmed = null;
    if (await boardDo({ op: "deleteLedger", id: l.id })) { layers = []; boardLedger = null; }
    render();
  });

  // A bounty
  const b = board.bounties.find((x) => x.id === boardBounty);
  if (!b) return;
  const titleBox = $<HTMLTextAreaElement>("#b-title");
  // A title is one line: Enter saves rather than breaking it.
  titleBox?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); titleBox.blur(); } });
  titleBox?.addEventListener("change", () =>
    void boardDo({ op: "editBounty", id: b.id, title: titleBox.value.replace(/\s*\n\s*/g, " ") }));
  $<HTMLTextAreaElement>("#b-notes")?.addEventListener("change", (e) =>
    void boardDo({ op: "editBounty", id: b.id, notes: (e.target as HTMLTextAreaElement).value }));
  $<HTMLSelectElement>("#b-assign")?.addEventListener("change", async (e) => {
    const v = (e.target as HTMLSelectElement).value || null;
    if (await boardDo({ op: "assign", id: b.id, settlementId: v })) {
      toast(v ? `${bountyRef(b)} is for ${settlementName(v)}` : "Unassigned");
    }
    render();
  });
  $<HTMLSelectElement>("#b-move")?.addEventListener("change", async (e) => {
    const to = (e.target as HTMLSelectElement).value;
    if (await boardDo({ op: "moveBounty", id: b.id, ledgerId: to })) {
      // Follow it, so the breadcrumb says where it now lives.
      boardLedger = to;
      toast(`Moved to ${board.ledgers.find((x) => x.id === to)?.name ?? "another ledger"}`);
    }
    render();
  });
  // Your click, so your clipboard: this is the only way anything leaves the board.
  $<HTMLButtonElement>("#b-copy")?.addEventListener("click", async () => {
    const text = [`${bountyRef(b)}: ${b.title}`, ...(b.notes.trim() ? ["", b.notes.trim()] : [])].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast(`${bountyRef(b)} copied`);
    } catch {
      toast("Couldn't reach the clipboard");
    }
  });
  $<HTMLButtonElement>("#b-done")?.addEventListener("click", () =>
    void boardDo({ op: "setDone", id: b.id, done: b.state !== "done" }));
  $<HTMLButtonElement>("#b-delete")?.addEventListener("click", async () => {
    if (deleteArmed !== b.id) { deleteArmed = b.id; render(); return; }
    deleteArmed = null;
    if (await boardDo({ op: "deleteBounty", id: b.id })) {
      boardBounty = null;
      layers = layers.filter((x) => x !== "bounty");
    }
    render();
  });
  onEnter($<HTMLTextAreaElement>("#b-comment"), (text) => void boardDo({ op: "comment", id: b.id, text }));
}

keep.onBoard((b) => {
  board = b;
  invalidate();
  if (boardOpen) render();
});

function render(): void {
  if (!realm) return;
  invalidate();
  const s = selected ? byId.get(selected) : null;
  pane.classList.toggle("split", (!!s && !cottageOpen && !founding) || boardOpen);

  if (boardOpen) {
    renderBoardPane();
    return;
  }
  // Back off the board: the message box is a governor's again, and there is a
  // folder to open a terminal at.
  promptEl.placeholder = "Talk to the governor…  (Enter sends, Shift+Enter for a new line)";
  terminalBtn.classList.remove("hidden");

  if (cottageOpen) {
    pane.innerHTML = renderCottage();
    composer.classList.add("hidden");
    hint.textContent = "the cottage";
    pane.querySelector("#reprobe")?.addEventListener("click", () => void refreshBudgets());
    const showAvatar = (url: string | null) => {
      const box = pane.querySelector<HTMLElement>("#d-avatar-prev");
      if (!box) return;
      box.style.backgroundImage = url ? `url("${url}")` : "";
      box.classList.toggle("empty", !url);
    };
    showAvatar(avatarUrl);
    pane.querySelector("#d-avatar-pick")?.addEventListener("click", async () => {
      try {
        avatarUrl = await keep.setAvatar();
        loadAvatarImage();
        showAvatar(avatarUrl);
      } catch (e) {
        toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '\w+': Error: /, ""));
      }
    });
    pane.querySelector("#d-avatar-clear")?.addEventListener("click", async () => {
      await keep.clearAvatar();
      avatarUrl = null;
      loadAvatarImage();
      showAvatar(null);
    });

    pane.querySelector("#d-testnotify")?.addEventListener("click", async () => {
      toast(await keep.testNotification());
    });
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
      const notifyWhen = ((pane.querySelector("#d-notify") as HTMLSelectElement)?.value ||
        "background") as NotifyWhen;
      const cottageName =
        (pane.querySelector("#d-cottage-name") as HTMLInputElement)?.value.trim() || "You";
      realm.defaults = {
        cottageName,
        notifications: notifyWhen,
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
    // The form is never re-rendered while it is open — a kind or a house would
    // take a half-typed folder with it — so these edit it in place instead.
    const artRow = pane.querySelector<HTMLElement>("#f-art");
    const wireArt = () => {
      artRow?.querySelectorAll<HTMLButtonElement>(".choice").forEach((b) => {
        b.addEventListener("click", () => {
          foundArt = artFor(foundKind, b.dataset.art);
          artRow.querySelectorAll(".choice").forEach((o) => {
            const on = o === b;
            o.classList.toggle("on", on);
            o.setAttribute("aria-pressed", String(on));
          });
          invalidate();   // the ghost on the map is the real preview
        });
      });
    };
    wireArt();
    pane.querySelector("#f-kind")?.addEventListener("change", (e) => {
      foundKind = (e.target as HTMLSelectElement).value as SettlementKind;
      foundArt = defaultArt(foundKind);
      if (artRow) artRow.innerHTML = artChoices(foundKind, foundArt);
      wireArt();
      invalidate();
    });
    // All three folder panes are in the DOM at once and shown by class, so
    // switching between them keeps whatever you had already typed in the others.
    pane.querySelectorAll<HTMLButtonElement>("#f-mode button").forEach((b) => {
      b.addEventListener("click", () => {
        foundMode = b.dataset.mode as FolderChoice["mode"];
        pane.querySelectorAll("#f-mode button").forEach((o) => o.classList.toggle("on", o === b));
        pane.querySelectorAll<HTMLElement>(".fmode").forEach((pane2) => {
          pane2.classList.toggle("hidden", pane2.dataset.mode !== foundMode);
        });
      });
    });

    const go = pane.querySelector("#f-go") as HTMLButtonElement;
    go?.addEventListener("click", async () => {
      const value = (sel: string) => (pane.querySelector(sel) as HTMLInputElement | null)?.value.trim() ?? "";
      const folder: FolderChoice =
        foundMode === "existing"
          ? { mode: "existing", path: value("#f-cwd") }
          : foundMode === "new"
            ? { mode: "new", name: value("#f-newname") }
            : { mode: "clone", url: value("#f-url") };
      if (folder.mode === "existing" && !folder.path) return toast("pick a folder first");
      if (folder.mode === "new" && !folder.name) return toast("name the folder first");
      if (folder.mode === "clone" && !folder.url) return toast("paste a clone URL first");

      // A clone is the one thing here that takes real time, so the button says
      // what it is waiting on rather than looking like a click that missed.
      go.disabled = true;
      go.textContent = folder.mode === "clone" ? "Cloning…" : "Founding…";
      try {
        const made = await keep.found({
          kind: foundKind,
          art: foundArt,
          name: (pane.querySelector("#f-name") as HTMLInputElement).value,
          folder,
          hex: h,
          profileId: (pane.querySelector("#f-profile") as HTMLSelectElement).value,
        });
        byId.set(made.id, made);
        founding = null;
        selected = made.id;
        render();
      } catch (e) {
        toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '\w+': Error: /, ""));
      } finally {
        // Harmless when the pane has already been replaced by the new settlement.
        go.disabled = false;
        go.textContent = "Found";
      }
    });
    return;
  }

  if (!s) {
    pane.innerHTML = building
      ? `<div class="empty"><p><b>${esc(SETTLEMENT_ART.find((a) => a.value === building!.art)?.label ?? "")} ${esc(building.kind)}</b> in hand. Click empty ground to place it, or the build tool again to put it down.</p></div>`
      : renderSettlementList();
    pane.querySelectorAll<HTMLButtonElement>("[data-goto]").forEach((b) =>
      b.addEventListener("click", () => goToSettlement(b.dataset.goto!)),
    );
    pane.querySelectorAll<HTMLButtonElement>("[data-realm]").forEach((b) =>
      b.addEventListener("click", () => REALM_BUILDINGS.find((x) => x.id === b.dataset.realm)?.go?.()),
    );
    composer.classList.add("hidden");
    hint.textContent = `${byId.size} settlement${byId.size === 1 ? "" : "s"}`;
    return;
  }

  // Only follow new messages if you were already reading the newest ones.
  // Re-rendering for any other reason — expanding a run, a token count ticking
  // over — must leave the scroll exactly where you left it.
  const scroller = (): HTMLElement => pane.querySelector<HTMLElement>("#chat.chatscroll") ?? pane;
  const before = scroller();
  const wasAtBottom = before.scrollHeight - before.scrollTop - before.clientHeight < 48;
  const keptScroll = before.scrollTop;
  // A working settlement re-renders on every update. Carry a half-typed
  // budget across, or it would be wiped mid-keystroke.
  const typedBudget = document.activeElement?.id === "s-budget"
    ? (document.activeElement as HTMLInputElement).value
    : null;
  pane.innerHTML = renderSettlement(s);
  if (typedBudget !== null) {
    const box = pane.querySelector<HTMLInputElement>("#s-budget");
    if (box) { box.value = typedBudget; box.focus(); }
  }
  composer.classList.remove("hidden");
  hint.textContent = s.name;
  pane.querySelector("#details-toggle")?.addEventListener("click", () => {
    if (layers.includes("details")) popLayer(layers.indexOf("details"));
    else pushLayer("details");
  });
  bindCrumbs();

  pane.querySelectorAll<HTMLButtonElement>(".runtoggle").forEach((b) => {
    b.addEventListener("click", () => {
      const key = b.dataset.run;
      if (!key) return;
      if (expandedRuns.has(key)) expandedRuns.delete(key);
      else expandedRuns.add(key);

      // Opening a run inserts content, which would otherwise shove everything
      // below it down the page. Measure the row you clicked before and after,
      // and take the difference out of the scroll so it does not appear to move.
      const top = b.getBoundingClientRect().top;
      render();
      const again = pane.querySelector<HTMLElement>(`.runtoggle[data-run="${CSS.escape(key)}"]`);
      const box = pane.querySelector<HTMLElement>("#chat.chatscroll") ?? pane;
      if (again) box.scrollTop += again.getBoundingClientRect().top - top;
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
  // Empty means follow the realm. Applied on change, not per keystroke, since
  // a changed ceiling retires an idle governor so it respawns with the new one.
  pane.querySelector("#s-budget")?.addEventListener("change", (e) => {
    const raw = (e.target as HTMLInputElement).value.trim();
    const n = Number(raw);
    const value = raw === "" || !Number.isFinite(n) || n < 0 ? null : n;
    s.maxBudgetUsd = value;
    void keep.setBudget(s.id, value);
    render();
    toast(value === null ? `${s.name}: realm default budget` : `${s.name}: $${value.toFixed(2)} ceiling`);
  });
  pane.querySelector("#s-model")?.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value || null;
    s.model = value;
    // Takes effect on the next thing the governor says, mid-conversation.
    void keep.setModel(s.id, value);
    toast(value ? `now using ${modelLabel(value)}` : "following the realm default");
  });
  // Rebuilding in another house touches nothing but the sprite, so it is safe
  // mid-conversation. The tiles are lit here rather than waiting for the push
  // back from the Keep, so the click lands immediately.
  const sArt = pane.querySelector<HTMLElement>("#s-art");
  sArt?.querySelectorAll<HTMLButtonElement>(".choice").forEach((b) => {
    b.addEventListener("click", () => {
      const art = artFor(s.kind, b.dataset.art);
      if (art === artOf(s)) return;
      s.art = art;
      sArt.querySelectorAll(".choice").forEach((o) => {
        const on = o === b;
        o.classList.toggle("on", on);
        o.setAttribute("aria-pressed", String(on));
      });
      invalidate();
      void keep.setArt(s.id, art);
    });
  });
  bindFlag(pane, (a) => void keep.answerFlag(s.id, a));
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
  const after = scroller();
  after.scrollTop = wasAtBottom ? after.scrollHeight : keptScroll;
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
  const text = promptEl.value.trim();
  if (!text) return;
  // Whoever the panel is open on. The board's own Claude is the warden.
  if (boardOpen) {
    promptEl.value = "";
    try {
      await keep.wardenSend(text);
    } catch (e) {
      toast(String((e as Error)?.message ?? e));
    }
    return;
  }
  const s = selected ? byId.get(selected) : null;
  if (!s) return;
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
  if (e.key === "Escape" && (building || !paletteEl.classList.contains("hidden"))) {
    setBuilding(null);
    return;
  }
  // The founding form is a deliberate mode now, so it needs a way out that is
  // not clicking somewhere else on the map.
  if (e.key === "Escape" && founding) {
    founding = null;
    render();
    return;
  }
  // Escape goes back one layer, and at the top closes the panel. Not while
  // typing, where Escape is the text box's, and a closed panel would leave
  // a half-written message stranded.
  const typingHere = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "Escape" && layers.length) {
    popLayer(layers.length - 1);
    return;
  }
  if (e.key === "[" && (e.metaKey || e.ctrlKey) && layers.length) {
    e.preventDefault();
    popLayer(layers.length - 1);
    return;
  }
  if (e.key === "Escape" && !typingHere && (selected || cottageOpen || boardOpen)) {
    selected = null;
    cottageOpen = false;
    boardOpen = false;
    render();
    return;
  }
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
/**
 * Arm the build tool, or put it down.
 *
 * The palette is only up while you are choosing; once a house is in hand it
 * closes and gets out of the way of the map you are about to click.
 */
function setBuilding(next: { kind: SettlementKind; art: SettlementArt } | null): void {
  building = next;
  paletteEl.classList.add("hidden");
  buildBtn.classList.toggle("on", !!next);
  canvas.classList.toggle("placing", !!next);
  inHandEl.classList.toggle("hidden", !next);
  if (next) {
    const label = SETTLEMENT_ART.find((a) => a.value === next.art)?.label ?? "";
    inHandEl.innerHTML = `<span class="tile">
        <img class="frame" src="./assets/blank.png" alt="" />
        <img class="art" src="./assets/${next.art}.png" alt="" />
      </span>
      <span><b>${esc(label)} ${esc(next.kind)}</b> in hand
        <span class="sub">Click empty ground to place · Esc to cancel</span></span>
      <button class="drop" id="put-down" title="Put it down (Esc)" aria-label="Put it down">×</button>`;
    inHandEl.querySelector("#put-down")?.addEventListener("click", () => setBuilding(null));
  }
  invalidate();
  if (!founding && !selected && !cottageOpen) render();
}

function openPalette(): void {
  paletteEl.innerHTML = renderPalette();
  paletteEl.querySelectorAll<HTMLButtonElement>(".choice").forEach((b) => {
    b.addEventListener("click", () => {
      const kind = b.dataset.kind as SettlementKind;
      setBuilding({ kind, art: artFor(kind, b.dataset.art) });
      toast("click empty ground to place it");
    });
  });
}

buildBtn.addEventListener("click", () => {
  if (building) return setBuilding(null);
  const opening = paletteEl.classList.contains("hidden");
  paletteEl.classList.toggle("hidden", !opening);
  buildBtn.classList.toggle("on", opening);
  if (opening) openPalette();
});

document.getElementById("go-home")!.addEventListener("click", () => {
  // Zoom back out as well as recentring. Centred at full zoom the cottage is
  // 400-odd pixels across and fills the view, so "home" looked like it had
  // gone somewhere else entirely — there was nothing left on screen to
  // recognise. Home should be a view you know, not just a coordinate.
  flyTo(0, 0, ZOOM_DEFAULT);
});

// Zero in on the bounty board: centred, and close enough to read it.
const BOUNTY_ZOOM = 1.5;
document.getElementById("go-bounty")!.addEventListener("click", () => {
  // Camera units are screen pixels at the target zoom, so the hex is measured
  // at that zoom, rounded as hexSize() rounds it.
  const p = hexToPixel(bountyHex(), Math.round(74 * BOUNTY_ZOOM * 10) / 10);
  flyTo(-p.x, -p.y, BOUNTY_ZOOM);
  setBuilding(null);
  openBoard();
});

// The rookery is not open yet, so its button only takes you there.
document.getElementById("go-rookery")!.addEventListener("click", () => {
  const p = hexToPixel(rookeryHex(), Math.round(74 * BOUNTY_ZOOM * 10) / 10);
  flyTo(-p.x, -p.y, BOUNTY_ZOOM);
  setBuilding(null);
  toast("The rookery isn't open yet. Messengers will fly from here.");
});

const zoomWin = document.getElementById("zoomwin") as HTMLButtonElement;
const setZoomLabel = (big: boolean) => { zoomWin.textContent = big ? "Restore" : "Fill screen"; };
zoomWin.addEventListener("click", async () => setZoomLabel(await keep.toggleMaximize()));
keep.onWindowState(setZoomLabel);

terminalBtn.addEventListener("click", () => {
  if (selected) void keep.openTerminal(selected);
});
document.getElementById("stop")!.addEventListener("click", () => {
  if (boardOpen) void keep.wardenInterrupt();
  else if (selected) void keep.interrupt(selected);
});

// ── boot ──────────────────────────────────────────────────────────────────────

keep.onSettlement((s) => {
  const isNew = !byId.has(s.id);
  byId.set(s.id, s);
  // Re-render when the open panel is about this settlement, when a flag goes up
  // anywhere, or when the idle pane is showing a count that just changed.
  // The list on an empty panel shows every settlement's state, so it redraws too.
  const listShowing = !selected && !cottageOpen && !boardOpen && !founding;
  if (s.id === selected || s.state === "needs_you" || listShowing) render();
  else if (!selected && !cottageOpen) hint.textContent = `${byId.size} settlement${byId.size === 1 ? "" : "s"}`;
});
/**
 * The panel with nothing open: every settlement, the ones that want you first,
 * then the ones at work, then the rest by when they were last active.
 */
function renderSettlementList(): string {
  if (!byId.size) {
    return `<div class="empty"><p>No settlements yet. Pick a house from the build tool, then click empty ground to raise it.</p></div>${renderRealmList()}`;
  }
  const rank = (x: Settlement) => (x.state === "needs_you" ? 0 : x.state === "working" ? 1 : x.state === "error" ? 2 : 3);
  const rows = [...byId.values()]
    .sort((a, b) => rank(a) - rank(b) || b.lastActiveAt - a.lastActiveAt)
    .map((x) => `<button class="setrow ${x.state}" data-goto="${esc(x.id)}">
        <span class="dot" aria-hidden="true"></span>
        <span class="sname">${esc(x.name)}</span>
        <span class="muted">${esc(x.kind)} · ${esc(x.state === "needs_you" ? "needs you" : x.state)}</span>
      </button>`)
    .join("");
  return `<h2>Settlements</h2><div class="setlist">${rows}</div>${renderRealmList()}`;
}

/**
 * The realm's own buildings: not sessions, but the shared parts of the realm.
 * Planned ones are listed greyed out, so the list says what is coming. A new
 * building is one entry here.
 */
type RealmBuilding = { id: string; name: string; sprite: string; sub: () => string; go?: () => void };
const REALM_BUILDINGS: RealmBuilding[] = [
  {
    id: "cottage",
    name: "The cottage",
    sprite: "cottage",
    sub: () => `${realm.defaults.cottageName || "you"} · settings and accounts`,
    go: goToCottage,
  },
  {
    id: "board",
    name: "The bounty board",
    sprite: "bounty-board",
    sub: () => {
      const open = board.bounties.filter((b) => b.state !== "done").length;
      const w = board.warden.state;
      const warden = w === "needs_you" ? "the warden needs you" : w === "working" ? "the warden is working" : "";
      return [`${open} open`, warden].filter(Boolean).join(" · ");
    },
    go: goToBoard,
  },
  { id: "rookery", name: "The rookery", sprite: "rookery", sub: () => "planned · messengers" },
  { id: "guildhall", name: "The Guildhall", sprite: "", sub: () => "planned · rules and tools" },
];

function renderRealmList(): string {
  const rows = REALM_BUILDINGS.map((b) => {
    const art = b.sprite
      ? `<img class="bthumb" src="./assets/${b.sprite}.png" alt="" />`
      : `<span class="bthumb"></span>`;
    const flag = b.id === "board" && board.warden.state === "needs_you" ? " needs_you" : "";
    return b.go
      ? `<button class="setrow building${flag}" data-realm="${b.id}">${art}<span class="sname">${esc(b.name)}</span><span class="muted">${esc(b.sub())}</span></button>`
      : `<div class="setrow building planned">${art}<span class="sname">${esc(b.name)}</span><span class="muted">${esc(b.sub())}</span></div>`;
  }).join("");
  return `<h2 class="realmhead">The realm</h2><div class="setlist">${rows}</div>`;
}

function goToCottage(): void {
  selected = null;
  founding = null;
  boardOpen = false;
  cottageOpen = true;
  layers = [];
  setBuilding(null);
  const p = hexToPixel(realm.cottageHex, Math.round(74 * FOCUS_ZOOM * 10) / 10);
  flyTo(-p.x, -p.y, FOCUS_ZOOM);
  void refreshBudgets();
  render();
}

function goToBoard(): void {
  const p = hexToPixel(bountyHex(), Math.round(74 * BOUNTY_ZOOM * 10) / 10);
  flyTo(-p.x, -p.y, BOUNTY_ZOOM);
  setBuilding(null);
  openBoard();
}

/** Zoom the map in on a settlement and open its conversation. */
const FOCUS_ZOOM = 1.15;
function goToSettlement(id: string): void {
  const x = byId.get(id);
  if (!x) return;
  selected = id;
  cottageOpen = false;
  boardOpen = false;
  founding = null;
  layers = [];
  // Camera units are screen pixels at the target zoom, so measure there.
  const p = hexToPixel(x.hex, Math.round(74 * FOCUS_ZOOM * 10) / 10);
  flyTo(-p.x, -p.y, FOCUS_ZOOM);
  render();
}

keep.onFocusSettlement((id) => {
  if (!byId.has(id)) return;
  selected = id;
  cottageOpen = false;
  boardOpen = false;
  founding = null;
  // Bring it into view: a flag you clicked from the Dock may be off screen.
  const s = byId.get(id)!;
  const p = hexToPixel(s.hex, hexSize());
  flyTo(-p.x, -p.y);
  render();
});

keep.onFocusBoard(() => {
  // A notification about the warden, clicked. Bring the board into view and
  // open it, the way focusing a settlement does.
  const p = hexToPixel(bountyHex(), Math.round(74 * BOUNTY_ZOOM * 10) / 10);
  flyTo(-p.x, -p.y, BOUNTY_ZOOM);
  setBuilding(null);
  openBoard();
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
    boardOpen = false;
    founding = null;
    render();
  },
  cottage() {
    selected = null;
    founding = null;
    cottageOpen = true;
    boardOpen = false;
    void refreshBudgets();
  },
  list: () => [...byId.values()].map((s) => ({ id: s.id, name: s.name, state: s.state })),
  state: () => ({ selected, cottageOpen, founding, building, count: byId.size, camera, hover, carrying }),
  /** Arm the build tool without the palette, for driving a test. */
  build: (kind: SettlementKind = "camp", art?: string) =>
    setBuilding({ kind, art: artFor(kind, art) }),
  palette: () => buildBtn.click(),
  /** The renderer's own copy of a settlement — mutate it to stage a view. */
  get: (id?: string) => byId.get(id ?? selected ?? [...byId.keys()][0] ?? ""),
  /** The same for the board and its warden, and a way to redraw after staging. */
  board: () => board,
  warden: () => board.warden,
  redraw: () => render(),
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
    ...[
      ...SETTLEMENT_ART.map((a) => a.value),
      "cottage",
      "bounty-board",
      "warden",
      "rookery",
      "banner",
      "flag-pole",
      ...Array.from({ length: FLAG_FRAMES }, (_, i) => `flag-${i}`),
    ].map(loadSprite),
    // Canvas silently falls back if the face is not ready when text is drawn.
    document.fonts.load('21px "Kaushan Script"').catch(() => []),
  ]);
  realm = await keep.getRealm();
  board = await keep.getBoard().catch(() => board);
  keep.models().then((m) => { models = m; render(); }).catch(() => {});
  keep.getAvatar().then((u) => { avatarUrl = u; loadAvatarImage(); }).catch(() => {});
  for (const s of realm.settlements) byId.set(s.id, s);
  resize();
  render();
  startRenderLoop();
})();
