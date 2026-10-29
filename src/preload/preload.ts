/**
 * The only bridge. The renderer gets these functions and nothing else — no
 * require, no SDK, no filesystem.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { Settlement } from "../shared/types.js";

contextBridge.exposeInMainWorld("keep", {
  getRealm: () => ipcRenderer.invoke("getRealm"),
  found: (input: unknown) => ipcRenderer.invoke("found", input),
  raze: (id: string) => ipcRenderer.invoke("raze", id),
  move: (id: string, hex: { q: number; r: number }) => ipcRenderer.invoke("move", id, hex),
  send: (id: string, text: string) => ipcRenderer.invoke("send", id, text),
  answerFlag: (id: string, allow: boolean) => ipcRenderer.invoke("answerFlag", id, allow),
  interrupt: (id: string) => ipcRenderer.invoke("interrupt", id),
  openTerminal: (id: string) => ipcRenderer.invoke("openTerminal", id),
  openExternal: (url: string) => ipcRenderer.invoke("openExternal", url),
  testNotification: () => ipcRenderer.invoke("testNotification"),
  getAvatar: () => ipcRenderer.invoke("getAvatar"),
  setAvatar: () => ipcRenderer.invoke("setAvatar"),
  clearAvatar: () => ipcRenderer.invoke("clearAvatar"),
  pickFolder: (startIn?: string | null) => ipcRenderer.invoke("pickFolder", startIn),
  toggleMaximize: () => ipcRenderer.invoke("toggleMaximize"),
  onWindowState: (cb: (big: boolean) => void) =>
    ipcRenderer.on("windowState", (_e, big: boolean) => cb(big)),
  budgets: () => ipcRenderer.invoke("budgets"),
  models: () => ipcRenderer.invoke("models"),
  setModel: (id: string, model: string | null) => ipcRenderer.invoke("setModel", id, model),
  setPermissionMode: (id: string, mode: string | null) =>
    ipcRenderer.invoke("setPermissionMode", id, mode),
  onModels: (cb: (m: unknown[]) => void) => ipcRenderer.on("models", (_e, m: unknown[]) => cb(m)),
  saveDefaults: (d: unknown) => ipcRenderer.invoke("saveDefaults", d),
  onSettlement: (cb: (s: Settlement) => void) =>
    ipcRenderer.on("settlement", (_e, s: Settlement) => cb(s)),
  onRemoved: (cb: (id: string) => void) => ipcRenderer.on("removed", (_e, id: string) => cb(id)),
  onBudgets: (cb: (b: unknown[]) => void) => ipcRenderer.on("budgets", (_e, b: unknown[]) => cb(b)),
  onFocusSettlement: (cb: (id: string) => void) =>
    ipcRenderer.on("focusSettlement", (_e, id: string) => cb(id)),
});
