/**
 * Threadlands — Electron main. Window, IPC, the idle reaper.
 */
import { BrowserWindow, Menu, Notification, app, dialog, ipcMain, nativeImage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RealmStore } from "./realm.js";
import { Supervisor } from "./supervisor.js";
import { probeAccount } from "./usage.js";
import { listModels } from "./models.js";
import { artFor } from "../shared/types.js";
import type {
  AccountBudget,
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
app.setPath("userData", join(app.getPath("appData"), "threadlands"));
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

/**
 * Tell you when a settlement wants something, or has stopped working.
 *
 * Fired on the *transition*, not on the state, because a settlement emits many
 * times while it works and only one of those is the moment it changed.
 */
const lastNotifiedState = new Map<string, Settlement["state"]>();

function notify(settlement: Settlement, body: string): void {
  const when = store?.defaults.notifications ?? "background";
  if (when === "off" || !Notification.isSupported()) return;
  // "background" means: do not interrupt someone already looking at the map.
  if (when === "background" && win?.isFocused()) return;

  const n = new Notification({ title: "Threadlands", body, silent: false });
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
      win.webContents.send("focusSettlement", settlement.id);
    }
    app.focus({ steal: true });
  });
  n.show();
}

function announce(s: Settlement): void {
  const prev = lastNotifiedState.get(s.id);
  lastNotifiedState.set(s.id, s.state);
  if (prev === s.state) return;
  if (s.state === "needs_you") notify(s, `${s.name} needs your guidance.`);
  else if (s.state === "idle" && prev === "working") notify(s, `${s.name} has gone idle.`);
}

/** Push a settlement snapshot at the map. The renderer holds no other truth. */
function emit(s: Settlement): void {
  announce(s);
  win?.webContents.send("settlement", s);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
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

app.whenReady().then(() => {
  // In development the Dock shows Electron's own icon; a packaged build uses
  // build/icon.icns instead and never reaches this.
  if (process.platform === "darwin" && !app.isPackaged) {
    const icon = join(here, "assets", "appicon.png");
    if (existsSync(icon)) app.dock?.setIcon(icon);
  }

  store = new RealmStore();
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
  );

  ipcMain.handle("getRealm", () => store.toRealm());

  const found = (input: { kind: SettlementKind; art?: string; name: string; cwd: string; hex: { q: number; r: number }; profileId: string }): Settlement => {
    if (!existsSync(input.cwd)) throw new Error(`no such folder: ${input.cwd}`);
    const taken = [...store.settlements.values()].some((s) => s.hex.q === input.hex.q && s.hex.r === input.hex.r);
    if (taken) throw new Error("that hex is occupied");
    const s: Settlement = {
      id: randomUUID(),
      kind: input.kind,
      art: artFor(input.kind, input.art),
      name: input.name.trim() || basename(input.cwd),
      hex: input.hex,
      cwd: input.cwd,
      profileId: input.profileId || "default",
      model: null,
      permissionMode: null,
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
    lastNotifiedState.delete(id);
    store.save();
    win?.webContents.send("removed", id);
  });

  ipcMain.handle("send", (_e, id: string, text: string) => sup.send(id, text));
  ipcMain.handle("answerFlag", (_e, id: string, allow: boolean) => sup.answerFlag(id, allow));
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
    store.defaults = { ...store.defaults, ...d };
    store.save();
    if (modelChanged) await sup.defaultModelChanged();
    if (modeChanged) await sup.defaultModeChanged();
  });

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
  store?.save();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
