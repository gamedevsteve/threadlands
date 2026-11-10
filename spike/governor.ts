/**
 * Threadlands — the governor's board spike.
 *
 * Proves the things about a governor's board tools and the close flag that only
 * real sessions can prove:
 *
 *   1. A settlement has the board's read tools and report_fixed, and nothing
 *      else of the board: it cannot post, edit, move, assign or close.
 *   2. It reads the ledgers granted to it, and the bounties in them.
 *   3. A bounty in a ledger granted to nobody is refused by name — unless it is
 *      assigned to that settlement, which is its own grant.
 *   4. report_fixed goes to the warden, not to the board: the report lands in
 *      the bounty's log, the warden wakes with it, checks the work in git, and
 *      raises its close flag with three answers.
 *   5. "Send it back" closes nothing and leaves a comment behind; "Close it"
 *      records the branch and commit from git.
 *
 * It runs the real `Supervisor`, `GovernorBoard` and `Warden` against a scratch
 * realm and a scratch git repo — no Electron, no window — so what it exercises
 * is the code the app ships.
 *
 * Run:  npm run governor                 (Sonnet, about thirty cents)
 *       npm run governor -- --model claude-opus-5-5
 *
 * **It spends real tokens.**
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/main/board.js";
import { GovernorBoard } from "../src/main/boardtools.js";
import { Supervisor } from "../src/main/supervisor.js";
import { Warden } from "../src/main/warden.js";
import type { Settlement } from "../src/shared/types.js";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const model = arg("model", "claude-sonnet-5-5");

const banner = (s: string) => console.log(`\n\x1b[1m\x1b[32m── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}\x1b[0m`);
const log = (tag: string, msg: string) => console.log(`\x1b[2m[${tag}]\x1b[0m ${msg}`);

let passed = 0;
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${what}` : `  \x1b[31m✗ ${what}\x1b[0m`);
  ok ? passed++ : failed++;
};

// ── a realm, a board, and a settlement with real work in it ──────────────────

const dir = mkdtempSync(join(tmpdir(), "tl-gov-"));
const board = new BoardStore(dir);

/** A git repo with one commit and one uncommitted change: the interesting case. */
const cwd = join(dir, "city");
mkdirSync(cwd, { recursive: true });
const g = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
g("init", "-q", "-b", "work");
g("config", "user.email", "spike@example.invalid");
g("config", "user.name", "Spike");
writeFileSync(join(cwd, "login.txt"), "the redirect, as it was\n");
g("add", "-A");
g("commit", "-q", "-m", "The login redirect, before anyone touched it");
writeFileSync(join(cwd, "login.txt"), "the redirect, fixed\n");

const city: Settlement = {
  id: "s1", kind: "city", art: "city-1", name: "Bellhaven", hex: { q: 1, r: 0 },
  cwd, profileId: "default", model: null, permissionMode: null,
  state: "idle", sessionId: null, flag: null, chat: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0, maxBudgetUsd: null, windowSpentUsd: 0, windowResetsAt: null,
  foundedAt: Date.now(), lastActiveAt: Date.now(), error: null,
};
const settlements = new Map<string, Settlement>([[city.id, city]]);

const w = () => board.board.warden;
const ref = (n: number) => board.board.bounties.find((b) => b.number === n)!;

// ── the Keep, as main.ts assembles it ────────────────────────────────────────

/** Flags a governor raises are not the point here: decline them, and count. */
let govFlags = 0;

const governorBoard = new GovernorBoard(
  board,
  () => board.save(),
  (id) => settlements.get(id),
  (s, b, note) => warden.report(s, b, note),
);

const sup = new Supervisor(
  settlements,
  (s) => {
    if (s.state === "needs_you" && s.flag) {
      govFlags++;
      log("flag", `${s.name}: ${s.flag.summary} → decline (it should not need one)`);
      setTimeout(() => sup.answerFlag(s.id, false), 0);
    }
  },
  () => null,
  () => 1.5,
  () => model,
  () => "default",
  undefined,
  () => null,
  (s) => governorBoard.extrasFor(s),
);

/** What the next close flag is answered with, and what the last one offered. */
let closeAnswer: boolean | string = "leave";
let closeFlags = 0;
let lastChoices: string[] = [];

const warden = new Warden(
  board,
  () => {
    if (w().state === "needs_you" && w().flag) {
      closeFlags++;
      lastChoices = (w().flag!.choices ?? []).map((c) => c.value);
      log("flag", `warden: ${w().flag!.summary}`);
      log("flag", `  answers: ${lastChoices.join(" / ") || "allow / decline"} → ${closeAnswer}`);
      const a = closeAnswer;
      setTimeout(() => warden.answerFlag(a), 0);
    }
  },
  () => [...settlements.values()],
  () => model,
  () => 1.5,
  undefined,
  () => null,
);

// ── saying things, and waiting ───────────────────────────────────────────────

const quiet = (state: string) => state === "idle" || state === "error" || state === "dormant";

async function settle(state: () => string, what: string, ms = 300_000): Promise<void> {
  const deadline = Date.now() + ms;
  // Give the turn a moment to start before taking its stillness for an answer.
  await new Promise((r) => setTimeout(r, 400));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (quiet(state())) return;
  }
  log("timeout", `${what} never settled`);
}

/** Say something to the governor and wait for its turn to end. */
async function toCity(text: string): Promise<string> {
  const from = city.chat.length;
  log("you→city", text);
  await sup.send(city.id, text);
  await settle(() => city.state, "the governor");
  return show(city.chat.slice(from), "city");
}

/** Say something to the warden and wait for its turn to end. */
async function toWarden(text: string): Promise<string> {
  const from = w().chat.length;
  log("you→warden", text);
  warden.send(text);
  await settle(() => w().state, "the warden");
  return show(w().chat.slice(from), "warden");
}

function show(said: typeof city.chat, who: string): string {
  for (const e of said) {
    if (e.role === "governor") log(who, e.text.replace(/\n+/g, " ").slice(0, 300));
    else if (e.role === "tool") log("tool", e.text);
    else if (e.role === "system") log("system", e.text);
  }
  return said.filter((e) => e.role === "governor").map((e) => e.text).join("\n");
}

/** Everything the warden said and did since a mark, for checking its steps. */
const wardenDid = (from: number) => w().chat.slice(from).filter((e) => e.role === "tool").map((e) => e.text);

try {
  banner(`a realm in ${dir}`);
  // "Mine" is the ledger every board starts with: granted to nobody.
  const mine = board.board.ledgers[0]!;
  await board.apply({ op: "addLedger", name: "Platform" }, () => undefined);
  const platform = board.board.ledgers.find((l) => l.name === "Platform")!;
  await board.apply({ op: "setGrants", id: platform.id, grants: [city.id] }, (id) => settlements.get(id));

  await board.apply({ op: "addBounty", ledgerId: platform.id, title: "Fix the login redirect" }, () => undefined);
  await board.apply({ op: "editBounty", id: ref(1).id, notes: "It sends you to /login again after signing in. login.txt is the one to change." }, () => undefined);
  await board.apply({ op: "assign", id: ref(1).id, settlementId: city.id }, (id) => settlements.get(id));

  await board.apply({ op: "addBounty", ledgerId: mine.id, title: "Go to the bank today" }, () => undefined);
  await board.apply({ op: "addBounty", ledgerId: mine.id, title: "Rename the staging box" }, () => undefined);
  await board.apply({ op: "assign", id: ref(3).id, settlementId: city.id }, (id) => settlements.get(id));

  log("board", `${platform.name} → granted to ${city.name}: B-1`);
  log("board", `${mine.name} → granted to nobody: B-2, and B-3 assigned to ${city.name}`);

  banner("1 · what a governor has of the board");
  const tools = await toCity(
    "Without using any tool at all, list the exact names of every tool you have that comes from the " +
      "bounty board — every one whose name starts with mcp__board__ — one per line, and nothing else. " +
      "Do not read files or run commands.",
  );
  const t = tools.toLowerCase();
  check(/report_fixed/.test(t), "it has report_fixed");
  check(/list_ledgers|list_bounties|read_bounty/.test(t), "it has the board's read tools");
  check(!/create_bounty|edit_bounty|move_bounty|assign_bounty|close_bounty/.test(t),
    "and none that post, edit, move, assign or close");

  banner("2 · it reads what it has been granted");
  const listed = await toCity(
    "What is on the realm's bounty board for you? Use your board tools only. " +
      "List every bounty you can see, by id and title, and nothing else.",
  );
  check(/b-?1/i.test(listed) && /login redirect/i.test(listed), "it found B-1 in the granted ledger");
  check(/b-?3/i.test(listed), "and B-3, assigned to it in a ledger it cannot read");
  check(!/bank/i.test(listed), "and not B-2, which is nobody's business but the settler's");

  banner("3 · a bounty that is not its own");
  const refusedRead = await toCity(
    "Try to read bounty B-2 with your board tools and tell me, in one line, exactly what the board said back.",
  );
  check(/not yours|not been granted|not assigned/i.test(refusedRead), "B-2 was refused, and said why");
  check(!/bank/i.test(refusedRead), "and its title never reached the governor");

  banner("4 · reporting it fixed goes to the warden");
  const beforeLog = ref(1).log.length;
  const wardenFrom = w().chat.length;
  closeAnswer = "back";
  const reported = await toCity(
    "You have finished B-1: login.txt is changed, but you have not committed it. " +
      "Report B-1 fixed, with a note saying what you changed. Do not commit anything, " +
      "do not run git, and do not use any tool but the board's.",
  );
  await settle(() => w().state, "the warden");

  const b1 = ref(1);
  check(b1.log.length > beforeLog, "the board wrote the report in B-1's log");
  check(b1.log.some((e) => /Bellhaven reported this fixed/.test(e.text)), "naming the settlement that sent it");
  check(/warden|settler|not closed|will/i.test(reported), "and the governor was told it went to the warden");

  const did = wardenDid(wardenFrom);
  log("warden", `steps: ${did.join(" · ") || "none"}`);
  check(did.some((x) => /check Bellhaven's work in git/.test(x)), "the warden checked the work in git");
  check(did.some((x) => /^comment on/.test(x)), "commented on the bounty");
  check(closeFlags === 1, "and raised exactly one close flag");
  check(lastChoices.join(",") === "close,back,leave", "with three answers: close it, send it back, leave it open");
  check(ref(1).state !== "done", `"send it back" closed nothing`);
  check(ref(1).log.some((e) => e.who === "warden"), "and left what it found on the bounty");
  check(govFlags === 0, "no flag was ever raised at the settlement");

  banner("5 · closing records where the work landed");
  closeAnswer = "close";
  await toWarden("The settler has looked at it. Close B-1 now.");
  const done = ref(1);
  check(done.state === "done", "B-1 is done");
  check(done.branch === "work", `on the branch git says: ${done.branch}`);
  check(!!done.commit, `at the commit git says: ${done.commit}`);
  check(closeFlags === 2, "and it asked first, again");

  banner("spent");
  const sum = (x: { tokens: { input: number; output: number } }) => x.tokens.input + x.tokens.output;
  log("cost", `governor $${city.costUsd.toFixed(4)} · ${sum(city).toLocaleString()} tokens`);
  log("cost", `warden   $${w().costUsd.toFixed(4)} · ${sum(w()).toLocaleString()} tokens`);
} finally {
  sup.stopAll();
  warden.stop();
}

banner(failed ? `${failed} failed, ${passed} passed` : `all ${passed} checks passed`);
process.exit(failed ? 1 : 0);
