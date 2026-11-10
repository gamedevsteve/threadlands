/**
 * Threadlands — the warden spike.
 *
 * Proves the four things about the warden that only a real session can prove:
 *
 *   1. It has the board's tools and nothing else — no Bash, no Read, no Write.
 *   2. Those tools actually reach `BoardStore.apply`, so the board changes.
 *   3. Posting, editing and commenting happen without asking.
 *   4. Assigning raises a flag, and the answer is what decides it.
 *
 * It runs the real `Warden` class against a scratch realm — no Electron, no
 * window — so what it exercises is the code the app ships.
 *
 * Run:  npm run warden              (Sonnet, about ten cents)
 *       npm run warden -- --no      (decline the flag instead of allowing it)
 *       npm run warden -- --model claude-opus-5-5
 *
 * **It spends real tokens.**
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/main/board.js";
import { Warden } from "../src/main/warden.js";
import type { Settlement } from "../src/shared/types.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const allow = !process.argv.includes("--no");
const model = arg("model", "claude-sonnet-5-5");

const banner = (s: string) => console.log(`\n\x1b[1m\x1b[32m── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}\x1b[0m`);
const log = (tag: string, msg: string) => console.log(`\x1b[2m[${tag}]\x1b[0m ${msg}`);

let passed = 0;
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${what}` : `  \x1b[31m✗ ${what}\x1b[0m`);
  ok ? passed++ : failed++;
};

const dir = mkdtempSync(join(tmpdir(), "tl-warden-"));
const board = new BoardStore(dir);

// One settlement to assign work to and check up on: this repo, which is a git
// repo, so check_work has something true to say.
const here = process.cwd();
const city: Settlement = {
  id: "s1", kind: "city", art: "city-1", name: "Threadlands", hex: { q: 1, r: 0 },
  cwd: here, profileId: "default", model: null, permissionMode: null,
  state: "idle", sessionId: null, flag: null, chat: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0, maxBudgetUsd: null, windowSpentUsd: 0, windowResetsAt: null,
  foundedAt: Date.now(), lastActiveAt: Date.now(), error: null,
};

const w = () => board.board.warden;
let answered = 0;

const warden = new Warden(
  board,
  () => {
    // The flag is answered here, exactly as the panel's buttons would.
    if (w().state === "needs_you" && w().flag) {
      log("flag", `${w().flag!.summary} → ${allow ? "allow" : "decline"}`);
      answered++;
      setTimeout(() => warden.answerFlag(allow), 0);
    }
  },
  () => [city],
  () => model,
  () => 1.5,
  undefined,
  () => null,
);

/** Say something and wait for the turn to end. */
async function say(text: string): Promise<string> {
  const from = w().chat.length;
  log("you", text);
  warden.send(text);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (w().state === "idle" || w().state === "error" || w().state === "dormant") break;
  }
  const said = w().chat.slice(from);
  for (const e of said) {
    if (e.role === "governor") log("warden", e.text.replace(/\n+/g, " ").slice(0, 300));
    else if (e.role === "tool") log("tool", e.text);
    else if (e.role === "system") log("system", e.text);
  }
  return said.filter((e) => e.role === "governor").map((e) => e.text).join("\n");
}

try {
  banner(`a warden in ${dir}`);
  await board.apply({ op: "addLedger", name: "Platform" }, () => undefined);
  log("board", `ledgers: ${board.board.ledgers.map((l) => l.name).join(", ")}`);

  banner("1 · its world is the board");
  const tools = await say(
    "List the exact names of every tool you have, one per line, and nothing else. " +
      "If you have no way to run a shell command or read a file, say so on the last line.",
  );
  const lower = tools.toLowerCase();
  check(!/\bbash\b/.test(lower) && !/\bgrep\b/.test(lower), "no shell");
  check(!/\bwrite\b|\bedit\b/.test(lower) || /no way|cannot|can't|none/.test(lower), "no file tools");
  check(/ledger|bount/.test(lower), "the board's tools are there");

  banner("2 · it can read the board");
  const ledgers = await say("Which ledgers are on the board, and how many open bounties in each?");
  check(/platform/i.test(ledgers), "it found the Platform ledger");

  banner("3 · posting needs no permission");
  const before = board.board.bounties.length;
  await say('Post one bounty in Platform, titled exactly "Fix the login redirect", with a line of notes. Just do it.');
  const posted = board.board.bounties.find((b) => /login redirect/i.test(b.title));
  check(board.board.bounties.length === before + 1, "one bounty was posted");
  check(!!posted, "with the title asked for");
  check(answered === 0, "and no flag was raised for it");
  if (posted) {
    check(posted.log.some((e) => /by the warden/.test(e.text)), "the log says the warden did it");
    log("board", `${posted.notes ? "notes: " + posted.notes.slice(0, 120) : "no notes"}`);
  }

  banner("4 · check_work asks git");
  const work = await say("What state is Threadlands' work in? Check it.");
  check(/branch|commit|uncommitted|unpushed|master|main/i.test(work), "it reported what git said");

  banner(`5 · assigning raises a flag (and we ${allow ? "allow" : "decline"} it)`);
  await say("Assign the login redirect bounty to Threadlands.");
  check(answered === 1, "exactly one flag went up");
  const after = board.board.bounties.find((b) => /login redirect/i.test(b.title));
  check(!!after && (allow ? after.assignee === "s1" : after.assignee === null), allow ? "it was assigned" : "it was not assigned");

  banner("spent");
  log("cost", `$${w().costUsd.toFixed(4)} · ${(w().tokens.input + w().tokens.output).toLocaleString()} tokens`);
} finally {
  warden.stop();
}

banner(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
process.exit(failed ? 1 : 0);
