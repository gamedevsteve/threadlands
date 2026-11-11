/**
 * Threadlands — Electron main. Window, IPC, the idle reaper.
 */
import { BrowserWindow, Menu, Notification, ShareMenu, app, dialog, ipcMain, nativeImage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RealmStore } from "./realm.js";
import { BoardStore } from "./board.js";
import { RookeryStore } from "./rookery.js";
import { asHtml, asMarkdown, fileName, plainHtml, toPdf, writePlain } from "./share.js";
import type { ShareFormat } from "./share.js";
import { Supervisor } from "./supervisor.js";
import { Warden } from "./warden.js";
import { GovernorBoard } from "./boardtools.js";
import { probeAccount } from "./usage.js";
import { listModels } from "./models.js";
import { artFor } from "../shared/types.js";
import type {
  RookeryOp,
  BoardOp,
  AccountBudget,
  Session,
  FolderChoice,
  ModelChoice,
  PermissionModeValue,
  RealmDefaults,
  Settlement,
  SettlementKind,
} from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Name the app before anything reads it.
 *
 * In development the Dock and the menu bar still say "Electron": those come
 * from the Electron binary's own bundle, and only a packaged build (npm run
 * package) sets CFBundleName. This does fix the name in dialogs, notifications
 * and the menu items below.
 *
 * Renaming also moves app.getPath("userData"), which would strand an existing
 * realm, so the data path is pinned to where it has always been.
 */
app.setPath("userData", process.env.THREADLANDS_DATA || join(app.getPath("appData"), "threadlands"));
// THREADLANDS_DATA points a dev copy at a scratch folder instead, so it can run
// beside the installed app without both writing the same realm.
app.setName("Threadlands");
// Windows groups notifications by this; without it they show as unattributed.
app.setAppUserModelId("com.hatfieldmedia.threadlands");

/**
 * Where the bundled Claude CLI actually is on disk.
 *
 * The SDK spawns it as a child process, and works out its path relative to its
 * own module — which, in a packaged app, is a path *inside* app.asar. Electron
 * remaps asar paths for file reads but not for spawn, so that fails with
 * ENOTDIR however much of the archive is unpacked. Point the SDK at the real
 * file instead. Returns undefined when it cannot be found, leaving the SDK to
 * resolve it the usual way.
 */
function claudeExecutable(): string | undefined {
  const base = app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked");
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const p = join(
    base,
    "node_modules",
    "@anthropic-ai",
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    exe,
  );
  return existsSync(p) ? p : undefined;
}

let win: BrowserWindow | null = null;
let store: RealmStore;
let sup: Supervisor;
let board: BoardStore;
let rookery: RookeryStore;
let warden: Warden;

/** When each account's usage session resets, from the cottage's probe. */
const sessionResetsAt = new Map<string, string | null>();

/**
 * Tell you when a settlement wants something, or has stopped working.
 *
 * Fired on the *transition*, not on the state, because a settlement emits many
 * times while it works and only one of those is the moment it changed.
 */
const lastNotifiedState = new Map<string, Settlement["state"]>();

/**
 * `reveal` is what the click should bring you to — the settlement's tile, or
 * the bounty board for the warden. A notification you cannot follow is worse
 * than none.
 */
function notify(title: string, body: string, reveal: () => void): void {
  const when = store?.defaults.notifications ?? "background";
  if (when === "off" || !Notification.isSupported()) return;
  // "background" means: do not interrupt someone already looking at the map.
  if (when === "background" && win?.isFocused()) return;

  const n = new Notification({ title, body, silent: false });
  // macOS refuses notifications from an app it has not registered, and does so
  // silently unless you listen: running the Electron binary straight out of
  // node_modules fails with UNErrorDomain 1 every time. Only a packaged,
  // signed bundle gets permission, so say which happened rather than assuming.
  n.on("show", () => console.log(`[notify] shown: ${body}`));
  n.on("failed", (_e, err) => console.error(`[notify] REFUSED by the OS: ${body} — ${err}`));
  n.on("click", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      reveal();
    }
    app.focus({ steal: true });
  });
  n.show();
}

/**
 * Tell you on the transition, whoever it was.
 *
 * The warden comes through here too: it is not on the map, so its click opens
 * the bounty board instead of selecting a tile.
 */
function announce(s: Session, reveal: () => void): void {
  const prev = lastNotifiedState.get(s.id);
  lastNotifiedState.set(s.id, s.state);
  if (prev === s.state) return;
  if (s.state === "needs_you") notify(s.name, "Needs your guidance.", reveal);
  else if (s.state === "idle" && prev === "working") notify(s.name, "Finished, and waiting for you.", reveal);
}

/** Push a settlement snapshot at the map. The renderer holds no other truth. */
function emit(s: Settlement): void {
  announce(s, () => win?.webContents.send("focusSettlement", s.id));
  win?.webContents.send("settlement", s);
}

/**
 * Push the whole board at the panel, and write it down.
 *
 * The warden lives in the board, so one push carries both a changed bounty and
 * whatever the warden has just said. Saving here rather than only in
 * `BoardStore.apply` is what keeps a warden turn on disk: the Governor writes
 * straight into the record.
 */
function pushBoard(): void {
  announce(board.board.warden, () => win?.webContents.send("focusBoard"));
  board.save();
  win?.webContents.send("board", board.board);
}

function createWindow(): void {
  // A screenshot run never shows its window: it is captured from its own
  // contents, so it never comes in front of whatever you are working on.
  const shooting = !!process.env.THREADLANDS_SHOT;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...(shooting ? { show: false, focusable: false } : {}),
    backgroundColor: "#1b2a30",
    ...(process.platform === "linux" ? { icon: join(here, "assets", "appicon.png") } : {}),
    titleBarStyle: "hiddenInset",
    webPreferences: { preload: join(here, "preload.cjs"), sandbox: false },
  });
  win.loadFile(join(here, "index.html"));

  // Keep the top bar's button honest when the window is zoomed from anywhere
  // else — a double click on the bar, the green light, or a menu command.
  const tellRenderer = () =>
    win?.webContents.send("windowState", win.isMaximized() || win.isFullScreen());
  win.on("maximize", tellRenderer);
  win.on("unmaximize", tellRenderer);
  win.on("enter-full-screen", tellRenderer);
  win.on("leave-full-screen", tellRenderer);

  // Dev hook: THREADLANDS_SHOT=<path> captures the window once it has settled
  // and quits. Lets the map be verified without a human at the mouse.
  const shot = process.env.THREADLANDS_SHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const js = process.env.THREADLANDS_SHOT_JS;
          if (js) {
            console.log("[shot-js]", JSON.stringify(await win!.webContents.executeJavaScript(js)));
            // Let the change paint. capturePage can otherwise return the frame
            // from before the script ran.
            await new Promise((r) => setTimeout(r, 600));
          }
          const img = await win!.webContents.capturePage();
          writeFileSync(shot, img.toPNG());
          console.log(`[shot] ${shot}`);
        } catch (e) {
          console.error("[shot] failed", e);
        }
        app.quit();
      }, Number(process.env.THREADLANDS_SHOT_DELAY ?? 2500));
    });
  }

  // Dev hook: surface renderer console errors on stdout, so a broken map is
  // visible from a terminal instead of only in devtools.
  win.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") console.error(`[renderer] ${e.message}`);
  });
}

/** Open the platform's terminal at a settlement's folder. */
function openTerminalAt(cwd: string): void {
  if (process.platform === "darwin") {
    execFile("/usr/bin/open", ["-a", "Terminal", cwd], () => {});
  } else if (process.platform === "win32") {
    execFile("cmd", ["/c", "start", "cmd", "/K", `cd /d "${cwd}"`], () => {});
  } else {
    execFile("x-terminal-emulator", ["--working-directory", cwd], (err) => {
      if (err) shell.openPath(cwd);
    });
  }
}

// A screenshot run is a background process: no Dock icon, no menu bar, and it
// never becomes the active app. Set before ready, or macOS activates it anyway.
if (process.env.THREADLANDS_SHOT && process.platform === "darwin") {
  app.setActivationPolicy("accessory");
}

app.whenReady().then(() => {
  // In development the Dock shows Electron's own icon; a packaged build uses
  // build/icon.icns instead and never reaches this.
  if (process.platform === "darwin" && !app.isPackaged) {
    const icon = join(here, "assets", "appicon.png");
    if (existsSync(icon)) app.dock?.setIcon(icon);
  }

  store = new RealmStore();
  // Before the Supervisor: every settlement is spawned with the board tools
  // bound to it, so the board has to exist before any governor can.
  board = new BoardStore(store.dir);

  /**
   * A governor's window onto the board. Read-only, apart from reporting a
   * bounty fixed — and that goes to the warden, which raises the close flag.
   * Nothing a settlement does here closes anything or reaches anyone else.
   */
  const governorBoard = new GovernorBoard(
    board,
    () => pushBoard(),
    (id) => store.settlements.get(id),
    (s, b, note) => warden.report(s, b, note),
  );

  sup = new Supervisor(
    store.settlements,
    (s) => {
      emit(s);
      store.save();
    },
    (profileId) => store.profileDir(profileId),
    () => store.defaults.maxBudgetUsd,
    () => store.defaults.model,
    () => store.defaults.permissionMode,
    claudeExecutable(),
    (profileId) => sessionResetsAt.get(profileId) ?? null,
    (s) => governorBoard.extrasFor(s),
  );

  ipcMain.handle("getRealm", () => store.toRealm());

  ipcMain.handle("getBoard", () => board.board);

  // The rookery. Letters wait here for you; forwarding is the only way one
  // reaches a settlement, and it goes through the same send as the chat box.
  rookery = new RookeryStore(store.dir);
  const pushRookery = () => win?.webContents.send("rookery", rookery.rookery);
  ipcMain.handle("getRookery", () => rookery.rookery);
  ipcMain.handle("rookeryOp", async (_e, op: RookeryOp) => {
    await rookery.apply(op, (id) => store.settlements.get(id), (id, text) => sup.send(id, text));
    pushRookery();
    return rookery.rookery;
  });
  // Getting a letter out: saved where you choose, or handed to the share sheet.
  const letterFile = async (letterId: string, format: ShareFormat, replies: boolean) => {
    const l = rookery.rookery.letters.find((x) => x.id === letterId);
    if (!l) throw new Error("That letter is gone.");
    const settler = store.defaults.cottageName || "The settler";
    const first = l.posts[0]!.author;
    const from = first.kind === "settlement" ? first.name : first.kind === "outside" ? first.name : settler;
    if (format === "plain" && !l.plain) throw new Error("Write the plain-language version first.");
    const data =
      format === "md" ? Buffer.from(asMarkdown(l, replies, settler))
      : format === "pdf" ? await toPdf(asHtml(l, replies, settler, from))
      : await toPdf(plainHtml(l, from));
    return { name: fileName(l, format), data };
  };
  ipcMain.handle("saveLetter", async (_e, letterId: string, format: ShareFormat, replies: boolean) => {
    const { name, data } = await letterFile(letterId, format, replies);
    const r = await dialog.showSaveDialog({ defaultPath: join(app.getPath("downloads"), name) });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, data);
    return r.filePath;
  });
  ipcMain.handle("shareLetter", async (_e, letterId: string, format: ShareFormat, replies: boolean) => {
    const { name, data } = await letterFile(letterId, format, replies);
    // The share sheet takes files, so the letter is written somewhere private first.
    const dir = join(app.getPath("temp"), "threadlands-share");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, data);
    new ShareMenu({ filePaths: [path] }).popup(win ? { window: win } : {});
  });
  ipcMain.handle("makePlain", async (_e, letterId: string, replies: boolean) => {
    const l = rookery.rookery.letters.find((x) => x.id === letterId);
    if (!l) throw new Error("That letter is gone.");
    const settler = store.defaults.cottageName || "The settler";
    rookery.setPlain(l.id, await writePlain(asMarkdown(l, replies, settler), claudeExecutable()));
    pushRookery();
    return rookery.rookery;
  });

  ipcMain.handle("importPlan", async (_e, settlementId: string) => {
    const s = store.settlements.get(settlementId);
    if (!s) throw new Error("That settlement is gone.");
    const r = await dialog.showOpenDialog({
      title: `A plan from ${s.name}`,
      defaultPath: s.cwd,
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    const path = r.canceled ? null : r.filePaths[0];
    if (!path) return null;
    rookery.importPlan(path, s);
    pushRookery();
    return rookery.rookery;
  });
  ipcMain.handle("boardOp", async (_e, op: BoardOp) => {
    await board.apply(op, (id) => store.settlements.get(id));
    pushBoard();
    return board.board;
  });

  // The warden: the board's own Claude. Not in the realm and not on the map, so
  // nothing about starting or resuming a settlement has to know it exists.
  warden = new Warden(
    board,
    () => pushBoard(),
    () => [...store.settlements.values()],
    () => store.defaults.model,
    () => store.defaults.maxBudgetUsd,
    claudeExecutable(),
    () => sessionResetsAt.get("default") ?? null,
  );

  ipcMain.handle("wardenSend", (_e, text: string) => warden.send(text));
  ipcMain.handle("wardenAnswerFlag", (_e, answer: boolean | string) => warden.answerFlag(answer));
  ipcMain.handle("wardenInterrupt", () => warden.interrupt());
  ipcMain.handle("wardenSetModel", (_e, model: string | null) => warden.setModel(model));
  ipcMain.handle("wardenSetBudget", (_e, usd: number | null) => warden.setBudget(usd));

  /**
   * The folder name a clone URL will produce, which is what git itself would
   * pick: the last path segment, without `.git`. Worked out up front so the
   * clone can be given an explicit destination and the result never has to be
   * guessed at afterwards.
   */
  const repoFolderName = (url: string): string => {
    const trimmed = url.replace(/\/+$/, "").replace(/\.git$/i, "");
    return trimmed.split(/[/:]/).pop() ?? "";
  };

  /** Where `new` and `clone` put what they make. */
  const baseFolder = (): string => {
    const base = store.defaults.baseFolder?.trim();
    if (!base) throw new Error("set a base folder in the cottage first");
    if (!existsSync(base)) throw new Error(`no such base folder: ${base}`);
    return base;
  };

  /**
   * Turn a choice of folder into a folder that exists.
   *
   * Nothing is founded until this returns, so a clone that fails or a name
   * that is already taken leaves the map exactly as it was.
   */
  const resolveFolder = async (f: FolderChoice): Promise<string> => {
    if (f.mode === "existing") {
      const path = f.path.trim();
      if (!path) throw new Error("pick a folder first");
      if (!existsSync(path)) throw new Error(`no such folder: ${path}`);
      return path;
    }

    const base = baseFolder();

    if (f.mode === "new") {
      const name = f.name.trim();
      // A folder name, not a path: anything that could climb out of the base
      // folder is a different request than the one the form is making.
      if (!name || name.startsWith(".") || /[/\\]/.test(name)) {
        throw new Error("that is not a folder name");
      }
      const dir = join(base, name);
      if (existsSync(dir)) throw new Error(`${name} is already in ${base}`);
      mkdirSync(dir);
      return dir;
    }

    const url = f.url.trim();
    if (!url) throw new Error("paste a clone URL");
    // git reads a leading dash as an option, so a URL that starts with one is
    // an argument in disguise. It is also never a real clone URL.
    if (url.startsWith("-")) throw new Error("that is not a clone URL");
    const name = repoFolderName(url);
    if (!name || name === "." || name === ".." || /[/\\]/.test(name)) {
      throw new Error(`cannot tell the folder name from ${url}`);
    }
    const dir = join(base, name);
    if (existsSync(dir)) throw new Error(`${name} is already in ${base}`);

    await new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        // `--` so the URL can never be read as an option, and an explicit
        // destination so the folder it lands in is the folder we return.
        ["clone", "--", url, name],
        {
          cwd: base,
          // Without this a private repo waits on a password prompt no one can
          // ever answer, and the clone hangs until the timeout.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          timeout: 10 * 60_000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (err, _out, stderr) => {
          if (!err) return resolve();
          const why = String(stderr || err.message).trim().split("\n").filter(Boolean).pop();
          reject(new Error(`clone failed: ${why ?? "git would not say why"}`));
        },
      );
    });
    if (!existsSync(dir)) throw new Error("the clone finished but left no folder behind");
    return dir;
  };

  const found = async (input: { kind: SettlementKind; art?: string; name: string; folder: FolderChoice; hex: { q: number; r: number }; profileId: string }): Promise<Settlement> => {
    const taken = [...store.settlements.values()].some((s) => s.hex.q === input.hex.q && s.hex.r === input.hex.r);
    if (taken) throw new Error("that hex is occupied");
    const cwd = await resolveFolder(input.folder);
    const s: Settlement = {
      id: randomUUID(),
      kind: input.kind,
      art: artFor(input.kind, input.art),
      name: input.name.trim() || basename(cwd),
      hex: input.hex,
      cwd,
      profileId: input.profileId || "default",
      model: null,
      permissionMode: null,
      maxBudgetUsd: null,
      windowSpentUsd: 0,
      windowResetsAt: null,
      state: "idle",
      sessionId: null,
      flag: null,
      chat: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      foundedAt: Date.now(),
      lastActiveAt: Date.now(),
      error: null,
    };
    store.settlements.set(s.id, s);
    store.save();
    emit(s);
    return s;
  };

  ipcMain.handle("found", (_e, input: Parameters<typeof found>[0]) => found(input));

  // Looks only, so it never disturbs a running session — the house is redrawn
  // and the settlement carries on whatever it was doing.
  ipcMain.handle("setArt", (_e, id: string, art: string) => {
    const s = store.settlements.get(id);
    if (!s) throw new Error("no such settlement");
    s.art = artFor(s.kind, art);
    store.save();
    emit(s);
  });

  ipcMain.handle("move", (_e, id: string, hex: { q: number; r: number }) => {
    const s = store.settlements.get(id);
    if (!s) throw new Error("no such settlement");
    if (hex.q === store.cottageHex.q && hex.r === store.cottageHex.r) {
      throw new Error("the cottage is there");
    }
    const taken = [...store.settlements.values()].some(
      (o) => o.id !== id && o.hex.q === hex.q && o.hex.r === hex.r,
    );
    if (taken) throw new Error("that hex is occupied");
    s.hex = hex;
    store.save();
    emit(s);
  });

  ipcMain.handle("raze", (_e, id: string) => {
    sup.razed(id);
    store.settlements.delete(id);
    board.forgetSettlement(id);
    pushBoard();
    lastNotifiedState.delete(id);
    store.save();
    win?.webContents.send("removed", id);
  });

  ipcMain.handle("send", (_e, id: string, text: string) => sup.send(id, text));
  ipcMain.handle("answerFlag", (_e, id: string, answer: boolean | string) => sup.answerFlag(id, answer));
  ipcMain.handle("interrupt", (_e, id: string) => sup.interrupt(id));

  ipcMain.handle("openTerminal", (_e, id: string) => {
    const s = store.settlements.get(id);
    if (s) openTerminalAt(s.cwd);
  });

  // The top bar is a drag region, so the system already zooms on a double
  // click; this is the explicit control beside it, and it reports back so the
  // button can say what it will do next.
  ipcMain.handle("toggleMaximize", () => {
    if (!win) return false;
    if (win.isFullScreen()) win.setFullScreen(false);
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized() || win.isFullScreen();
  });

  // Only ever hand the system browser a real web address.
  // Lets you confirm macOS will actually deliver one, which it refuses to do
  // for an app it has not registered — and refuses silently.
  ipcMain.handle("testNotification", () => {
    if (!Notification.isSupported()) return "This platform has no notifications.";
    return new Promise<string>((resolve) => {
      const n = new Notification({
        title: "Threadlands",
        body: "A test. Settlements will sound like this.",
      });
      n.on("show", () => resolve("Sent — if you saw nothing, check Notifications in System Settings."));
      n.on("failed", (_e, err) => resolve(`macOS refused it: ${err}`));
      n.show();
      setTimeout(() => resolve("Sent, but macOS never confirmed it."), 2500);
    });
  });

  // The avatar is read back as a data URL rather than a path: the renderer is a
  // file:// page, and handing it another file:// URL is both fragile and a
  // wider door than this needs.
  const avatarDataUrl = (): string | null => {
    if (!existsSync(store.avatarFile)) return null;
    return `data:image/png;base64,${readFileSync(store.avatarFile).toString("base64")}`;
  };

  ipcMain.handle("getAvatar", () => avatarDataUrl());

  ipcMain.handle("setAvatar", async () => {
    const r = await dialog.showOpenDialog({
      title: "Choose your avatar",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"] }],
    });
    const picked = r.canceled ? null : r.filePaths[0];
    if (!picked) return avatarDataUrl();

    const img = nativeImage.createFromPath(picked);
    if (img.isEmpty()) throw new Error("that file is not an image Threadlands can read");
    // Standing beside a cottage, it is never drawn large. Cap it so the realm
    // folder does not quietly grow by several megabytes.
    const { width, height } = img.getSize();
    const scaled = Math.max(width, height) > 512
      ? img.resize(width >= height ? { width: 512 } : { height: 512 })
      : img;
    writeFileSync(store.avatarFile, scaled.toPNG());
    return avatarDataUrl();
  });

  ipcMain.handle("clearAvatar", () => {
    if (existsSync(store.avatarFile)) rmSync(store.avatarFile);
  });

  ipcMain.handle("openExternal", (_e, url: string) => {
    const ok = /^https?:\/\//i.test(url);
    if (ok) void shell.openExternal(url);
  });

  ipcMain.handle("pickFolder", async (_e, startIn?: string | null) => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      // Falling back to the realm's base folder means the browser opens where
      // the work lives rather than at the root of the disk.
      ...(startIn || store.defaults.baseFolder
        ? { defaultPath: startIn || store.defaults.baseFolder! }
        : {}),
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  // Budgets are cached and refreshed in the background. A probe is free but not
  // instant — several seconds inside Electron — and the cottage panel should
  // open with numbers already on it rather than a spinner.
  let budgetCache: AccountBudget[] = [];
  let budgetRun: Promise<AccountBudget[]> | null = null;

  const refreshBudgets = (): Promise<AccountBudget[]> => {
    if (budgetRun) return budgetRun;
    const ids = [...new Set(["default", ...store.profiles, ...[...store.settlements.values()].map((s) => s.profileId)])];
    budgetRun = Promise.all(ids.map((p) => probeAccount(p, store.profileDir(p), claudeExecutable())))
      .then((rows) => {
        budgetCache = rows;
        for (const r of rows) {
          sessionResetsAt.set(r.profileId, r.meters.find((m) => m.kind === "session")?.resetsAt ?? null);
        }
        win?.webContents.send("budgets", rows);
        return rows;
      })
      .finally(() => {
        budgetRun = null;
      });
    return budgetRun;
  };

  ipcMain.handle("budgets", async () => {
    // Hand back what we have and refresh behind it; wait only on a cold start.
    if (!budgetCache.length) return refreshBudgets();
    void refreshBudgets();
    return budgetCache;
  });

  void refreshBudgets();
  setInterval(() => void refreshBudgets(), 120_000);

  ipcMain.handle("saveDefaults", async (_e, d: RealmDefaults) => {
    const modelChanged = d.model !== store.defaults.model;
    const modeChanged = d.permissionMode !== store.defaults.permissionMode;
    const budgetChanged = d.maxBudgetUsd !== store.defaults.maxBudgetUsd;
    store.defaults = { ...store.defaults, ...d };
    store.save();
    if (modelChanged) {
      await sup.defaultModelChanged();
      await warden.defaultModelChanged();
    }
    if (modeChanged) await sup.defaultModeChanged();
    if (budgetChanged) {
      sup.defaultBudgetChanged();
      warden.defaultBudgetChanged();
    }
  });

  ipcMain.handle("setBudget", (_e, id: string, usd: number | null) => sup.setBudget(id, usd));


  ipcMain.handle("setModel", (_e, id: string, model: string | null) => sup.setModel(id, model));
  ipcMain.handle("setPermissionMode", (_e, id: string, mode: PermissionModeValue | null) =>
    sup.setPermissionMode(id, mode),
  );

  // The model list costs nothing and never changes within a session.
  let modelCache: ModelChoice[] = [];
  let modelRun: Promise<ModelChoice[]> | null = null;
  const loadModels = (): Promise<ModelChoice[]> => {
    if (modelCache.length) return Promise.resolve(modelCache);
    modelRun ??= listModels(store.profileDir("default"), claudeExecutable())
      .then((rows) => {
        modelCache = rows;
        win?.webContents.send("models", rows);
        return rows;
      })
      .finally(() => {
        modelRun = null;
      });
    return modelRun;
  };
  ipcMain.handle("models", () => loadModels());
  void loadModels();

  // The idle reaper. Built in from the start: reaping is what makes dormant
  // settlements honest rather than a lie the map tells.
  setInterval(() => {
    const doomed = sup.idleCandidates(Date.now(), (k) =>
      k === "camp" ? store.defaults.campIdleMinutes : store.defaults.cityIdleMinutes,
    );
    for (const id of doomed) sup.reap(id);
    // The warden is kept warm as long as a city: the board is a long project.
    if (warden.idleFor(Date.now(), store.defaults.cityIdleMinutes)) warden.reap();
  }, 30_000);

  buildMenu();
  createWindow();

  if (process.argv.includes("--notify-test")) {
    const n = new Notification({ title: "Threadlands", body: "Bellhaven needs your guidance." });
    n.on("show", () => console.log("[notify] shown"));
    n.on("failed", (_e, err) => console.error(`[notify] REFUSED: ${err}`));
    n.show();
  }

  const selftest = process.env.THREADLANDS_SELFTEST;
  if (selftest && win) {
    win.webContents.once("did-finish-load", () => {
      void (async () => {
        const { runSelfTest } = await import("./selftest.js");
        const pass = await runSelfTest(win!, selftest, {
          found,
          send: (id, text) => sup.send(id, text),
          answerFlag: (id, allow) => sup.answerFlag(id, allow),
          get: (id) => store.settlements.get(id),
        });
        sup.stopAll();
        warden.stop();
        store.save();
        app.exit(pass ? 0 : 1);
      })();
    });
  }

  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

/** The application menu, so at least its labels carry the app's own name. */
function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    ...(isMac
      ? ([
          {
            label: "Threadlands",
            submenu: [
              { role: "about" as const, label: "About Threadlands" },
              { type: "separator" as const },
              { role: "hide" as const, label: "Hide Threadlands" },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const, label: "Quit Threadlands" },
            ],
          },
        ])
      : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Fill Screen",
          accelerator: "CmdOrCtrl+Ctrl+F",
          click: () => {
            if (!win) return;
            if (win.isMaximized()) win.unmaximize();
            else win.maximize();
          },
        },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("before-quit", () => {
  sup?.stopAll();
  warden?.stop();
  store?.save();
  board?.save();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
