/**
 * Threadlands — end-to-end self test.
 *
 * Drives the real app through its real IPC: founds a camp in a scratch folder,
 * sends a prompt, answers the flag when it goes up, and screenshots the result.
 * It spends real tokens, which is the point — it is the only proof that the map,
 * the Keep and a live session agree with each other.
 *
 *   THREADLANDS_SELFTEST=/path/to/shot-prefix npm start
 */
import type { BrowserWindow } from "electron";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settlement } from "../shared/types.js";

type Hooks = {
  found: (i: { kind: "camp" | "city"; name: string; folder: { mode: "existing"; path: string }; hex: { q: number; r: number }; profileId: string }) => Promise<Settlement>;
  send: (id: string, text: string) => Promise<void>;
  answerFlag: (id: string, allow: boolean) => void;
  get: (id: string) => Settlement | undefined;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(label: string, ms: number, test: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (test()) { console.log(`  ✓ ${label}`); return true; }
    await wait(250);
  }
  console.log(`  ✗ ${label} (timed out after ${ms}ms)`);
  return false;
}

async function shoot(win: BrowserWindow, path: string): Promise<void> {
  try {
    writeFileSync(path, (await win.webContents.capturePage()).toPNG());
    console.log(`  … ${path}`);
  } catch (e) {
    console.error("  shot failed", e);
  }
}

export async function runSelfTest(win: BrowserWindow, prefix: string, hooks: Hooks): Promise<boolean> {
  const results: boolean[] = [];
  console.log("\n── threadlands self test ──────────────────────────────");

  const cwd = mkdtempSync(join(tmpdir(), "threadlands-selftest-"));
  writeFileSync(join(cwd, "README.md"), "A scratch folder for the Threadlands self test.\n");

  const s = await hooks.found({ kind: "camp", name: "Testcamp", folder: { mode: "existing", path: cwd }, hex: { q: 1, r: -1 }, profileId: "default" });
  results.push(await until("camp founded and on the map", 5000, () => !!hooks.get(s.id)));
  await wait(600);
  await shoot(win, `${prefix}-founded.png`);

  // A prompt that must use a tool, so the flag has to go up.
  void hooks.send(s.id, "Create a file called acorn.txt containing exactly the word ACORN. Then tell me it is done.");
  results.push(await until("settlement went to work", 20_000, () => hooks.get(s.id)?.state === "working"));
  await wait(400);
  await shoot(win, `${prefix}-working.png`);

  const flagged = await until("flag went up for permission", 90_000, () => hooks.get(s.id)?.state === "needs_you");
  results.push(flagged);
  if (flagged) {
    await wait(700);
    await shoot(win, `${prefix}-flag.png`);
    hooks.answerFlag(s.id, true);
  }

  results.push(
    await until("turn finished", 90_000, () => {
      const c = hooks.get(s.id);
      return c?.state === "idle" && c.chat.some((m) => m.role === "governor");
    }),
  );

  const done = hooks.get(s.id);
  results.push(await until("session id captured for resume", 5000, () => !!hooks.get(s.id)?.sessionId));
  results.push(await until("tokens counted", 5000, () => (hooks.get(s.id)?.tokens.output ?? 0) > 0));

  await wait(600);
  await shoot(win, `${prefix}-done.png`);

  console.log("───────────────────────────────────────────────────────");
  console.log(`  folder   ${cwd}`);
  console.log(`  tokens   ${done?.tokens.input ?? 0} in · ${done?.tokens.output ?? 0} out`);
  console.log(`  cost     $${(done?.costUsd ?? 0).toFixed(4)}`);
  const pass = results.every(Boolean);
  console.log(`  ${pass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} (${results.filter(Boolean).length}/${results.length})\n`);
  return pass;
}
