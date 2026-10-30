/**
 * Threadlands — the contract between the Keep (main) and the Map (renderer).
 *
 * The renderer never imports the Agent SDK. Everything it knows about a session
 * arrives as one of these plain objects, over IPC. That rule is what keeps a
 * crashed governor from taking the map down with it.
 */

/** Axial hex coordinate, flat-top. */
export type Hex = { q: number; r: number };

export type SettlementKind = "camp" | "city";

/**
 * The house a settlement is built in.
 *
 * The kind decides how a settlement behaves — how long it survives idle, how
 * hard it is to raze. The house decides only how it looks, and that is the
 * point: three camps in the same house read as one project from across the
 * map, with nothing to click and no name to read.
 *
 * `value` is both what a settlement stores and the sprite's file name
 * (`src/assets/<value>.png`), so the JOBS table in tools/prep_assets.py has to
 * emit exactly these names.
 */
export const SETTLEMENT_ART = [
  { value: "camp-1", kind: "camp", label: "Banner" },
  { value: "camp-2", kind: "camp", label: "Caravan" },
  { value: "camp-3", kind: "camp", label: "Arcane" },
  { value: "city-1", kind: "city", label: "Bastion" },
  { value: "city-2", kind: "city", label: "Golden" },
  { value: "city-3", kind: "city", label: "Observatory" },
] as const;

export type SettlementArt = (typeof SETTLEMENT_ART)[number]["value"];

/** What a kind wears when nothing chose for it. */
export function defaultArt(kind: SettlementKind): SettlementArt {
  return kind === "camp" ? "camp-1" : "city-1";
}

/**
 * The house to actually draw. Anything that does not belong to the kind falls
 * back — a settlement founded before the choice existed, a name dropped from
 * the art, a hand-edited realm file. The map must never be left asking for a
 * sprite that will not load.
 */
export function artFor(kind: SettlementKind, art: string | null | undefined): SettlementArt {
  const hit = SETTLEMENT_ART.find((a) => a.value === art && a.kind === kind);
  return hit ? hit.value : defaultArt(kind);
}

/**
 * What a tile is doing, in the one vocabulary the map draws from.
 *
 * `needs_you` is the flag. It is the only state the user must act on, so it is
 * the only one that gets a sprite swap rather than a filter.
 */
export type SettlementState = "idle" | "working" | "needs_you" | "dormant" | "error";

/** A permission request waiting on the user — the raised flag, in full. */
export type PendingFlag = {
  id: string;
  toolName: string;
  input: unknown;
  /** A one-line human summary the map can show without parsing tool input. */
  summary: string;
  raisedAt: number;
};

export type ChatEntry =
  | { role: "you"; text: string; at: number }
  | { role: "governor"; text: string; at: number }
  | { role: "tool"; text: string; at: number }
  | { role: "system"; text: string; at: number };

export type Settlement = {
  id: string;
  kind: SettlementKind;
  /** Which of the kind's houses it was built in. Looks only; see SETTLEMENT_ART. */
  art: SettlementArt;
  name: string;
  hex: Hex;
  /** The folder this settlement is scoped to. Its whole world. */
  cwd: string;
  profileId: string;
  /** Overrides the realm default. Null means follow it. */
  model: string | null;
  /** Overrides the realm default. Null means follow it. */
  permissionMode: PermissionModeValue | null;
  state: SettlementState;
  /** Null until the first turn completes; needed to resume after a reap. */
  sessionId: string | null;
  flag: PendingFlag | null;
  chat: ChatEntry[];
  /** Cumulative, from modelUsage on each result. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  foundedAt: number;
  lastActiveAt: number;
  /** Set when the governor dies, so the tile can show why. */
  error: string | null;
};

/**
 * Where a settlement's folder comes from.
 *
 * A settlement is only ever scoped to a folder that exists, so the Keep is the
 * one that makes it: founding and creating are a single act, and a clone that
 * fails leaves no half-settled tile behind. `new` and `clone` both land inside
 * the realm's base folder — the one the cottage sets.
 */
export type FolderChoice =
  | { mode: "existing"; path: string }
  | { mode: "new"; name: string }
  | { mode: "clone"; url: string };

/** One row of the cottage's budget panel — the server's meter, verbatim. */
export type Meter = {
  kind: string;
  group: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  severity: string;
  isActive: boolean;
};

export type AccountBudget = {
  profileId: string;
  plan: string | null;
  planLimits: boolean;
  meters: Meter[];
  breakdown: { label: string; percent: number }[];
  credits: { usedUsd: number; limitUsd: number | null; percent: number; enabled: boolean } | null;
  checkedAt: number;
  error?: string;
};

export type ModelChoice = { value: string; label: string; description: string };

/** How much a settlement asks before acting. Ordered as Shift+Tab cycles them. */
export const PERMISSION_MODES = [
  { value: "default", label: "Ask every time", hint: "The flag goes up for anything that changes something." },
  { value: "auto", label: "Auto", hint: "A classifier decides, and only asks when it genuinely cannot." },
  { value: "acceptEdits", label: "Accept edits", hint: "File edits go through; commands still ask." },
  { value: "plan", label: "Plan only", hint: "Reads and thinks, executes nothing." },
  { value: "bypassPermissions", label: "Never ask", hint: "Runs anything in its folder without asking. No flag will ever go up." },
] as const;

export type PermissionModeValue = (typeof PERMISSION_MODES)[number]["value"];

/** When a settlement is allowed to interrupt you. */
export const NOTIFY_WHEN = [
  { value: "background", label: "When Threadlands is in the background" },
  { value: "always", label: "Always" },
  { value: "off", label: "Never" },
] as const;

export type NotifyWhen = (typeof NOTIFY_WHEN)[number]["value"];

export type RealmDefaults = {
  /** What the cottage is called on the map. Yours, not "You". */
  cottageName: string;
  /** When a settlement may raise a system notification. */
  notifications: NotifyWhen;
  /** The model a settlement uses unless it says otherwise. Null = the CLI's own default. */
  model: string | null;
  /** How much a settlement asks before acting, unless it overrides this. */
  permissionMode: PermissionModeValue;
  /**
   * Where the folder browser opens when founding a settlement. Null means
   * wherever the system would otherwise start, which is rarely useful.
   */
  baseFolder: string | null;
  /** Minutes of silence before a settlement is reaped. Camps go first. */
  campIdleMinutes: number;
  cityIdleMinutes: number;
  /** Hard ceiling per settlement, enforced by the SDK. */
  maxBudgetUsd: number;
};

export type Realm = {
  settlements: Settlement[];
  cottageHex: Hex;
  defaults: RealmDefaults;
  profiles: string[];
};

/** Everything the renderer can ask the Keep to do. */
export type Api = {
  getRealm(): Promise<Realm>;
  found(input: { kind: SettlementKind; art: SettlementArt; name: string; folder: FolderChoice; hex: Hex; profileId: string }): Promise<Settlement>;
  raze(id: string): Promise<void>;
  move(id: string, hex: Hex): Promise<void>;
  send(id: string, text: string): Promise<void>;
  answerFlag(id: string, allow: boolean): Promise<void>;
  interrupt(id: string): Promise<void>;
  openTerminal(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  testNotification(): Promise<string>;
  /** The avatar as a data URL, or null if none has been chosen. */
  getAvatar(): Promise<string | null>;
  setAvatar(): Promise<string | null>;
  clearAvatar(): Promise<void>;
  pickFolder(startIn?: string | null): Promise<string | null>;
  budgets(): Promise<AccountBudget[]>;
  models(): Promise<ModelChoice[]>;
  setModel(id: string, model: string | null): Promise<void>;
  setPermissionMode(id: string, mode: PermissionModeValue | null): Promise<void>;
  /** Rebuild an existing settlement in a different house. Nothing but looks. */
  setArt(id: string, art: SettlementArt): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  onWindowState(cb: (big: boolean) => void): void;
  saveDefaults(d: RealmDefaults): Promise<void>;
  /** Push: the Keep replaces a settlement whenever anything about it changes. */
  onSettlement(cb: (s: Settlement) => void): void;
  onRemoved(cb: (id: string) => void): void;
  onBudgets(cb: (b: AccountBudget[]) => void): void;
  onFocusSettlement(cb: (id: string) => void): void;
};
