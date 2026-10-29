/**
 * Threadlands — Phase 0 spike.
 *
 * No UI, no Electron, no hexes. This proves the one thing that can sink the project:
 * that a session can be spawned in a folder, chatted with, interrupted for permission,
 * killed, and resumed with its memory intact.
 *
 * Run:  npm run spike              (interactive — you answer the flag yourself)
 *       npm run spike -- --yes     (auto-approve; for a non-interactive check)
 *       npm run spike -- --walls   (also exercises the sandbox half of a wall)
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

let rl: ReturnType<typeof createInterface> | null = null;
const prompter = () => (rl ??= createInterface({ input: process.stdin, output: process.stdout }));
const log = (tag: string, msg: string) => console.log(`\x1b[2m[${tag}]\x1b[0m ${msg}`);
const banner = (s: string) => console.log(`\n\x1b[1m\x1b[32m── ${s} ${"─".repeat(Math.max(0, 60 - s.length))}\x1b[0m`);

/** The governor's ear: a push-driven async iterable that never closes on its own. */
function createInputStream() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;

  const push = (text: string) => {
    queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    wake?.();
    wake = null;
  };

  const stream = (async function* () {
    while (true) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; });
      while (queue.length) yield queue.shift()!;
    }
  })();

  return { stream, push };
}

/** Everything the supervisor will later do with an SDKMessage, done crudely. */
function ingest(msg: SDKMessage): void {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") log("init", `session ${msg.session_id} · model ${msg.model}`);
      break;
    case "assistant":
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) log("say", block.text.trim().slice(0, 200));
        if (block.type === "tool_use") log("tool", `${block.name} ${JSON.stringify(block.input).slice(0, 120)}`);
      }
      break;
    case "result":
      log("turn", `${msg.subtype} · ${msg.num_turns} turns · $${msg.total_cost_usd?.toFixed(4) ?? "?"}`);
      break;
  }
}

interface TurnResult { text: string; sessionId: string }

/**
 * A live session: the query, the way to talk to it, and ONE iterator held for its lifetime.
 *
 * The iterator matters. `for await (const m of q) { ...; break }` calls `.return()` on the
 * iterator when it exits early, which closes the Query and ends the session. Anything that
 * consumes a turn at a time has to pull from a single long-lived iterator by hand.
 */
interface Spawned {
  q: Query;
  push: (text: string) => void;
  it: AsyncIterator<SDKMessage>;
}

function spawn(options: Options): Spawned {
  const { stream, push } = createInputStream();
  const q = query({ prompt: stream, options });
  return { q, push, it: q[Symbol.asyncIterator]() };
}

/** Push a message and pull messages until that turn resolves. */
async function turn(s: Spawned, text: string): Promise<TurnResult> {
  console.log(`\x1b[36m> ${text}\x1b[0m`);
  s.push(text);
  for (;;) {
    const { value, done } = await s.it.next();
    if (done) {
      throw new Error(
        "stream ended before the turn resolved — the session died mid-turn, " +
        "usually because canUseTool threw or maxTurns was hit",
      );
    }
    ingest(value);
    if (value.type === "result") {
      // The session id rides on every result — this is what makes resume possible.
      return {
        text: value.subtype === "success" ? value.result : `<${value.subtype}>`,
        sessionId: value.session_id,
      };
    }
  }
}

async function main() {
  const walls = process.argv.includes("--walls");
  const autoYes = process.argv.includes("--yes") || !process.stdin.isTTY;
  const cwd = await mkdtemp(join(tmpdir(), "threadlands-spike-"));
  log("cwd", cwd);

  let flagRaised = 0;

  /**
   * The flag. Fires only when the permission flow falls through to a prompt.
   *
   * It never throws. A callback that throws takes the whole session down with it —
   * learned the hard way — so any failure here degrades to a deny instead.
   */
  const canUseTool: CanUseTool = async (toolName, input) => {
    flagRaised++;
    console.log(`\n\x1b[1m\x1b[33m🚩 ${toolName}\x1b[0m wants to run:`);
    console.log(`   ${JSON.stringify(input).slice(0, 300)}`);

    if (autoYes) {
      console.log("   \x1b[2mauto-approved (--yes)\x1b[0m");
      return { behavior: "allow", updatedInput: input };
    }
    try {
      const answer = (await prompter().question("   allow? [y/N] ")).trim().toLowerCase();
      return answer === "y"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "The cottage said no." };
    } catch (e) {
      log("flag", `could not ask (${e instanceof Error ? e.message : e}) — denying`);
      return { behavior: "deny", message: "The cottage could not be reached." };
    }
  };

  const base: Options = {
    cwd,
    canUseTool,
    permissionMode: "default",
    settingSources: [],
    maxTurns: 8,
    ...(walls && {
      settings: JSON.stringify({
        sandbox: { enabled: true, filesystem: { denyWrite: ["/tmp/threadlands-forbidden"] } },
      }),
    }),
  };

  // ── Stage 1 ─ spawn, chat, raise the flag ────────────────────────────────
  banner("stage 1 · spawn, chat, raise the flag");
  const s1 = spawn(base);
  await turn(s1, "Write a file called acorn.txt in the current directory containing exactly the word ACORN.");
  const named = await turn(s1, "In one short sentence, what is this project called? Call it Threadlands.");
  const sessionId = named.sessionId;

  const wrote = await readFile(join(cwd, "acorn.txt"), "utf8").catch(() => null);
  await s1.q.close?.();
  log("kill", "session closed, process gone");

  // ── Stage 2 ─ resume from disk ───────────────────────────────────────────
  banner("stage 2 · resume from disk");
  if (!sessionId) throw new Error("never captured a session id");
  log("resume", sessionId);

  const s2 = spawn({ ...base, resume: sessionId });
  const { text: recall } = await turn(s2, "Without using any tools: what file did you create a moment ago, and what did I say this project is called?");
  await s2.q.close?.();

  // ── Stage 3 ─ walls (optional) ───────────────────────────────────────────
  let wallHeld: boolean | null = null;
  if (walls) {
    banner("stage 3 · walls");
    await writeFile("/tmp/threadlands-forbidden", "untouched\n").catch(() => {});
    const s3 = spawn({ ...base, allowedTools: ["Bash"], resume: sessionId });
    await turn(s3, "Run exactly this and report the exit code: echo BREACHED > /tmp/threadlands-forbidden");
    await s3.q.close?.();
    wallHeld = (await readFile("/tmp/threadlands-forbidden", "utf8").catch(() => "")).includes("untouched");
  }

  // ── Gate ─────────────────────────────────────────────────────────────────
  banner("gate");
  const checks: [string, boolean | null][] = [
    ["session spawned in the given cwd", wrote !== null],
    ["file written where expected (ACORN)", wrote?.trim() === "ACORN"],
    ["flag raised for permission", flagRaised > 0],
    ["session id captured for resume", !!sessionId],
    ["resumed session remembers the file", /acorn/i.test(recall)],
    ["resumed session remembers the chat", /threadlands/i.test(recall)],
    ["sandbox held the wall", wallHeld],
  ];
  for (const [label, ok] of checks) {
    if (ok === null) { console.log(`  \x1b[2m—  ${label} (skipped)\x1b[0m`); continue; }
    console.log(ok ? `  \x1b[32m✓\x1b[0m  ${label}` : `  \x1b[31m✗\x1b[0m  ${label}`);
  }
  const failed = checks.filter(([, ok]) => ok === false).length;
  console.log(failed === 0 ? "\n\x1b[1m\x1b[32mPhase 0 passes. The bet is good.\x1b[0m\n"
                           : `\n\x1b[1m\x1b[31m${failed} check(s) failed.\x1b[0m\n`);
  rl?.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); rl?.close(); process.exit(1); });
