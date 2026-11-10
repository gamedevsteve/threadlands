/**
 * Threadlands — the warden.
 *
 * The board's own Claude. You talk to it in the bounty board's panel the way
 * you talk to a governor, and it is a `Governor` underneath: the same session,
 * the same flag, the same budget. What makes it the warden is its world.
 *
 * Its world is the board. It has no built-in tools at all — no shell, no files,
 * no code — only an in-process MCP server whose tools go through the one
 * `BoardStore.apply` the panel uses. Its folder is an empty one in the realm,
 * so there is nothing there to read even if it had the means.
 *
 * Two things ask first. **Assigning** and **closing** are left out of
 * `allowedTools` and marked `always_ask`, so each call falls through to
 * `canUseTool` and raises a flag on the board for you to answer. Everything
 * else on the board it may simply do.
 *
 * Nothing here ever messages a settlement or starts work. Assigning records who
 * a bounty is for; telling the governor is still yours to do.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { InferShape, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Governor } from "./supervisor.js";
import { gitReport } from "./board.js";
import type { BoardStore } from "./board.js";
import type { Bounty, Ledger, Settlement, Warden as WardenRecord } from "../shared/types.js";
import { bountyRef } from "../shared/types.js";

/** An MCP text answer, and the same shaped like a refusal. */
const said = (text: string) => ({ content: [{ type: "text" as const, text }] });
const refused = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** The two tools that raise a flag instead of just happening. */
const ASKS_FIRST = ["assign_bounty", "close_bounty"] as const;

const TOOL_NAMES = [
  "list_ledgers",
  "list_bounties",
  "read_bounty",
  "list_settlements",
  "check_work",
  "create_bounty",
  "edit_bounty",
  "move_bounty",
  "comment_on_bounty",
  ...ASKS_FIRST,
] as const;

const qualified = (name: string) => `mcp__board__${name}`;

const WARDEN_PROMPT = `You are the warden of a bounty board in Threadlands — a map of the Claude Code
sessions its owner runs. Each session is a settlement: a camp for short work, a
city for a long project. The board is the realm's to-do list, and you keep it.

The board is your whole world. Ledgers hold bounties; a ledger is a named
checklist and a bounty is one item on it, with an id like B-12 that is never
reused. A bounty is open, assigned or done, and keeps a log of everything that
has happened to it. You have tools for all of this and nothing else: no shell,
no files, no code, no web. You cannot read a settlement's source. When you need
to know the state of someone's work, check_work asks git in that settlement's
folder for you and hands back the branch, the last commit, anything
uncommitted and anything unpushed.

How to work:

- **Brain dumps.** When the user throws a pile of issues at you, do not create
  anything yet. Propose, in chat, how you would organise it: a checklist of
  bounties, each with a title and a line of notes, filed into the ledgers that
  exist. Say which ledger each would go in. Then wait. Create them only once
  the user has agreed, and adjust to whatever they change first. If a ledger
  you want does not exist, say so and ask them to make it — creating ledgers is
  theirs, not yours.
- **What you may just do.** Create a bounty, edit its title or notes, move it
  between ledgers, and comment on it. Do these without asking once the work is
  agreed.
- **What asks first.** Assigning a bounty to a settlement, and closing one (or
  opening it again), raise a flag for the user to allow or decline. Call the
  tool when you mean it; the flag is how they answer. If it comes back
  declined, that is their answer — say so and leave it.
- **You never set anyone to work.** Assigning only records who a bounty is for.
  You cannot message a settlement, and nothing you do starts a session. If work
  needs doing, tell the user to hand the governor the bounty's id.
- **Closing honestly.** Before suggesting a bounty is done, check_work on the
  settlement it is assigned to. Uncommitted or unpushed work is not finished
  work: say so plainly, and suggest the governor commit and push before it
  counts.

How to talk: like a careful clerk who knows the board by heart. Short answers,
markdown, no preamble. Name bounties by id and title — "B-12 Fix login
redirect". When you have changed something, say what changed in one line. When
you are unsure which bounty or ledger is meant, ask rather than guess. Never
invent a bounty id: look it up.`;

/**
 * The warden, and the board tools it works through.
 *
 * Kept out of the Supervisor on purpose. The warden is not on the map and not
 * in realm.json, and nothing about starting or resuming a settlement should
 * have to know it exists.
 */
export class Warden {
  private gov: Governor<WardenRecord> | null = null;
  private readonly server: McpSdkServerConfigWithInstance;

  constructor(
    private readonly board: BoardStore,
    /** Push the board at the renderer, and write it to disk. */
    private readonly emit: () => void,
    private readonly settlements: () => Settlement[],
    private readonly defaultModel: () => string | null,
    private readonly maxBudgetUsd: () => number,
    private readonly executable: string | undefined,
    /** When the default account's usage session resets. */
    private readonly sessionResetsAt: () => string | null,
  ) {
    this.server = this.buildServer();
  }

  private get w(): WardenRecord {
    return this.board.board.warden;
  }

  // ── the board, as the warden sees it ────────────────────────────────────────

  private ledgerNamed(name: string): Ledger {
    const want = name.trim().toLowerCase();
    const hit =
      this.board.board.ledgers.find((l) => l.id === name) ??
      this.board.board.ledgers.find((l) => l.name.toLowerCase() === want);
    if (hit) return hit;
    const known = this.board.board.ledgers.map((l) => l.name).join(", ");
    throw new Error(`No ledger called "${name}". There is: ${known || "none"}.`);
  }

  /** A bounty by the id you say out loud: B-12, or 12, or its uuid. */
  private bountyNamed(ref: string): Bounty {
    const t = ref.trim();
    const n = Number(t.replace(/^b-?/i, ""));
    const hit =
      this.board.board.bounties.find((b) => b.id === t) ??
      (Number.isFinite(n) ? this.board.board.bounties.find((b) => b.number === n) : undefined);
    if (!hit) throw new Error(`No bounty ${t} on the board.`);
    return hit;
  }

  private settlementNamed(name: string): Settlement {
    const want = name.trim().toLowerCase();
    const all = this.settlements();
    const hit = all.find((s) => s.id === name) ?? all.find((s) => s.name.toLowerCase() === want);
    if (hit) return hit;
    const known = all.map((s) => s.name).join(", ");
    throw new Error(`No settlement called "${name}". The realm has: ${known || "none"}.`);
  }

  private ledgerName(id: string): string {
    return this.board.board.ledgers.find((l) => l.id === id)?.name ?? "an unknown ledger";
  }

  private who(id: string | null): string {
    if (!id) return "nobody";
    return this.settlements().find((s) => s.id === id)?.name ?? "a razed settlement";
  }

  /** One line per bounty, the way the warden should quote one back. */
  private line(b: Bounty): string {
    const state = b.state === "done" ? "done" : b.state === "assigned" ? `for ${this.who(b.assignee)}` : "open";
    return `${bountyRef(b)} ${b.title} — ${state}`;
  }

  private detail(b: Bounty): string {
    const log = b.log.map((e) => `  ${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")} ${e.who}: ${e.text}`);
    return [
      `${bountyRef(b)} ${b.title}`,
      `ledger: ${this.ledgerName(b.ledgerId)}`,
      `state: ${b.state}`,
      `assigned to: ${this.who(b.assignee)}`,
      ...(b.branch ? [`closed on: ${b.branch} at ${b.commit ?? "?"}`] : []),
      `notes: ${b.notes.trim() || "(none)"}`,
      "log:",
      ...(log.length ? log : ["  (empty)"]),
    ].join("\n");
  }

  /** Apply a change through the same path the panel uses, as the warden. */
  private async apply(op: Parameters<BoardStore["apply"]>[0]): Promise<void> {
    await this.board.apply(op, (id) => this.settlements().find((s) => s.id === id), "warden");
    this.emit();
  }

  // ── the tools ──────────────────────────────────────────────────────────────

  private buildServer(): McpSdkServerConfigWithInstance {
    /**
     * One board tool. The handler returns plain text and may throw: anything it
     * throws comes back as a refusal the model can read and act on, which is
     * how "no bounty B-99 on the board" reaches it.
     */
    const t = <S extends z.ZodRawShape>(
      name: string,
      description: string,
      schema: S,
      run: (args: InferShape<S>) => Promise<string>,
    ) =>
      tool(name, description, schema, async (args) => {
        try {
          return said(await run(args));
        } catch (e) {
          return refused(String((e as Error)?.message ?? e));
        }
      });

    const bountyArg = z.string().describe('The bounty, by id — "B-12".');
    const ledgerArg = z.string().describe("The ledger, by name.");

    return createSdkMcpServer({
      name: "board",
      version: "1.0.0",
      instructions:
        "The bounty board. These are the only tools the warden has: there is no shell, " +
        "no filesystem and no way to message a settlement. Assigning and closing ask the " +
        "user first.",
      alwaysLoad: true,
      tools: [
        t("list_ledgers", "Every ledger on the board, with how many bounties are open in it and which settlements can read it.", {}, async () => {
          const ls = this.board.board.ledgers;
          if (!ls.length) return "The board has no ledgers.";
          return ls
            .map((l) => {
              const mine = this.board.board.bounties.filter((b) => b.ledgerId === l.id);
              const open = mine.filter((b) => b.state !== "done").length;
              const readers = l.grants.map((id) => this.who(id)).join(", ");
              return `${l.name} — ${open} open of ${mine.length}; read by ${readers || "nobody"}`;
            })
            .join("\n");
        }),

        t("list_bounties", "Bounties on the board, newest last. Narrow it to one ledger or one state.", {
          ledger: z.string().optional().describe("Only this ledger, by name. Omit for the whole board."),
          state: z.enum(["open", "assigned", "done", "all"]).optional().describe('Default "open", which includes assigned ones.'),
        }, async ({ ledger, state }) => {
          const l = ledger ? this.ledgerNamed(ledger) : null;
          const want = state ?? "open";
          const rows = this.board.board.bounties
            .filter((b) => (l ? b.ledgerId === l.id : true))
            .filter((b) => (want === "all" ? true : want === "open" ? b.state !== "done" : b.state === want))
            .sort((a, b) => a.createdAt - b.createdAt);
          if (!rows.length) return `Nothing ${want === "all" ? "" : `${want} `}${l ? `in ${l.name}` : "on the board"}.`;
          const by = (b: Bounty) => (l ? "" : ` [${this.ledgerName(b.ledgerId)}]`);
          return rows.map((b) => `${this.line(b)}${by(b)}`).join("\n");
        }),

        t("read_bounty", "One bounty in full: its notes, its state, who it is for, and its whole log.", {
          bounty: bountyArg,
        }, async ({ bounty }) => this.detail(this.bountyNamed(bounty))),

        t("list_settlements", "The settlements on the map — who a bounty can be assigned to, and whose work check_work can look at.", {}, async () => {
          const all = this.settlements();
          if (!all.length) return "The realm has no settlements.";
          return all
            .map((s) => {
              const reads = this.board.board.ledgers.filter((l) => l.grants.includes(s.id)).map((l) => l.name);
              return `${s.name} — ${s.kind}, ${s.state}, at ${s.cwd}; reads ${reads.join(", ") || "no ledger"}`;
            })
            .join("\n");
        }),

        t("check_work", "Ask git what a settlement has actually done: its branch, last commit, uncommitted changes and unpushed commits. Reads nothing else and changes nothing.", {
          settlement: z.string().describe("The settlement, by name."),
        }, async ({ settlement }) => {
          const s = this.settlementNamed(settlement);
          const r = await gitReport(s.cwd);
          if (!r.repo) return `${s.name} (${s.cwd}) is not a git repository, so there is nothing to check.`;
          const dirty = r.uncommittedCount
            ? `${r.uncommittedCount} uncommitted change${r.uncommittedCount === 1 ? "" : "s"}:\n${r.uncommitted.map((l) => `  ${l}`).join("\n")}`
            : "nothing uncommitted";
          const ahead = !r.upstream
            ? "no upstream branch: nothing has ever been pushed"
            : r.unpushed.length
              ? `${r.unpushed.length} unpushed commit${r.unpushed.length === 1 ? "" : "s"} on top of ${r.upstream}:\n${r.unpushed.map((l) => `  ${l}`).join("\n")}`
              : `up to date with ${r.upstream}`;
          return [
            `${s.name} — ${s.cwd}`,
            `branch: ${r.branch}`,
            `last commit: ${r.lastCommit ?? "none yet"}`,
            dirty,
            ahead,
          ].join("\n");
        }),

        t("create_bounty", "Post a new bounty in a ledger. For a brain dump, propose the list in chat and wait for the user to agree before calling this.", {
          ledger: ledgerArg,
          title: z.string().describe("One line: what needs doing."),
          notes: z.string().optional().describe("What it is, where to look, how to know it is done."),
        }, async ({ ledger, title, notes }) => {
          const l = this.ledgerNamed(ledger);
          const before = new Set(this.board.board.bounties.map((b) => b.id));
          await this.apply({ op: "addBounty", ledgerId: l.id, title });
          const made = this.board.board.bounties.find((b) => !before.has(b.id));
          if (!made) return "Posted, but the board did not hand it back.";
          if (notes?.trim()) await this.apply({ op: "editBounty", id: made.id, notes });
          return `Posted ${bountyRef(made)} ${made.title} in ${l.name}.`;
        }),

        t("edit_bounty", "Change a bounty's title or its notes.", {
          bounty: bountyArg,
          title: z.string().optional(),
          notes: z.string().optional().describe("Replaces the notes entirely. Read it first if you mean to add to them."),
        }, async ({ bounty, title, notes }) => {
          const b = this.bountyNamed(bounty);
          if (title === undefined && notes === undefined) return "Nothing to change: pass a title, notes, or both.";
          await this.apply({ op: "editBounty", id: b.id, ...(title !== undefined ? { title } : {}), ...(notes !== undefined ? { notes } : {}) });
          return `Edited ${bountyRef(b)} ${b.title}.`;
        }),

        t("move_bounty", "Move a bounty to another ledger. Its assignment survives the move; who else can read it follows the new ledger.", {
          bounty: bountyArg,
          ledger: ledgerArg,
        }, async ({ bounty, ledger }) => {
          const b = this.bountyNamed(bounty);
          const l = this.ledgerNamed(ledger);
          await this.apply({ op: "moveBounty", id: b.id, ledgerId: l.id });
          return `${bountyRef(b)} is now in ${l.name}.`;
        }),

        t("comment_on_bounty", "Add a line to a bounty's log, signed by you. The log is its history, newest at the bottom.", {
          bounty: bountyArg,
          text: z.string().describe("What you want on the record."),
        }, async ({ bounty, text }) => {
          const b = this.bountyNamed(bounty);
          await this.apply({ op: "comment", id: b.id, text });
          return `Noted on ${bountyRef(b)}.`;
        }),

        t("assign_bounty", "Record who a bounty is for. This raises a flag: the user allows or declines it. It only records — nothing is sent and no work starts.", {
          bounty: bountyArg,
          settlement: z.string().describe('The settlement, by name. Pass "nobody" to unassign.'),
        }, async ({ bounty, settlement }) => {
          const b = this.bountyNamed(bounty);
          const off = /^(nobody|none|nothing|null|unassign(ed)?)$/i.test(settlement.trim());
          const s = off ? null : this.settlementNamed(settlement);
          await this.apply({ op: "assign", id: b.id, settlementId: s?.id ?? null });
          return s
            ? `${bountyRef(b)} is recorded as ${s.name}'s. Nothing has been sent: tell its governor yourself, by ${bountyRef(b)}.`
            : `${bountyRef(b)} is nobody's now.`;
        }),

        t("close_bounty", "Mark a bounty done, or open it again. This raises a flag: the user allows or declines it. Check the work first.", {
          bounty: bountyArg,
          reopen: z.boolean().optional().describe("True to open a done bounty again. Default false: close it."),
        }, async ({ bounty, reopen }) => {
          const b = this.bountyNamed(bounty);
          await this.apply({ op: "setDone", id: b.id, done: !reopen });
          const after = this.board.board.bounties.find((x) => x.id === b.id);
          const where = after?.branch ? `, on ${after.branch} at ${after.commit ?? "?"}` : "";
          return reopen ? `${bountyRef(b)} is open again.` : `${bountyRef(b)} is done${where}.`;
        }),
      ],
    });
  }

  /**
   * One line about a board tool call, for the flag and the transcript.
   *
   * The board's own vocabulary, not the tool's: the flag has to read like
   * something you can answer without knowing what an MCP tool is.
   */
  private describe = (toolName: string, input: unknown): string => {
    const i = (input ?? {}) as Record<string, unknown>;
    const ref = typeof i.bounty === "string" ? i.bounty : "a bounty";
    const title = (() => {
      try {
        const b = this.bountyNamed(String(i.bounty ?? ""));
        return `${bountyRef(b)} ${b.title}`;
      } catch {
        return ref;
      }
    })();
    switch (toolName.replace(/^mcp__board__/, "")) {
      case "list_ledgers": return "look over the ledgers";
      case "list_bounties": return `list bounties${typeof i.ledger === "string" ? ` in ${i.ledger}` : ""}`;
      case "read_bounty": return `read ${title}`;
      case "list_settlements": return "look over the settlements";
      case "check_work": return `check ${String(i.settlement ?? "a settlement")}'s work in git`;
      case "create_bounty": return `post "${String(i.title ?? "a bounty")}" in ${String(i.ledger ?? "a ledger")}`;
      case "edit_bounty": return `edit ${title}`;
      case "move_bounty": return `move ${title} to ${String(i.ledger ?? "another ledger")}`;
      case "comment_on_bounty": return `comment on ${title}`;
      case "assign_bounty": return `assign ${title} to ${String(i.settlement ?? "someone")}`;
      case "close_bounty": return i.reopen ? `open ${title} again` : `close ${title}`;
      default: return `use ${toolName}`;
    }
  };

  // ── the session ────────────────────────────────────────────────────────────

  /** Start the warden's session spend again if the account's window has reset. */
  private rollWindow(): void {
    const w = this.w;
    const current = this.sessionResetsAt();
    const now = Date.now();
    const expired = !!w.windowResetsAt && Date.parse(w.windowResetsAt) <= now;
    const moved = !!current && current !== w.windowResetsAt;
    if (!expired && !moved) return;
    w.windowSpentUsd = 0;
    w.windowResetsAt = current && Date.parse(current) > now ? current : null;
  }

  private ceiling(): number {
    return this.w.maxBudgetUsd ?? this.maxBudgetUsd();
  }

  /** Send a prompt, spawning or resuming the warden as needed. */
  send(text: string): void {
    const w = this.w;
    if (!this.gov) {
      this.rollWindow();
      const left = this.ceiling() - w.windowSpentUsd;
      if (left < 0.01) {
        w.chat.push({ role: "you", text, at: Date.now() });
        w.chat.push({
          role: "system",
          text:
            `Out of budget: $${w.windowSpentUsd.toFixed(2)} of its $${this.ceiling().toFixed(2)} ceiling is spent ` +
            `this session. Raise the ceiling in the warden's details, then send your message again.`,
          at: Date.now(),
        });
        w.state = w.sessionId ? "dormant" : "idle";
        this.emit();
        return;
      }
      this.gov = new Governor<WardenRecord>(
        w,
        () => this.emit(),
        // The default account, always: the warden is the realm's, not a
        // settlement's, and profiles beyond the default are not built.
        null,
        left,
        w.model ?? this.defaultModel(),
        // Never bypassPermissions: the flag on assigning and closing is the
        // whole mechanism, and it only exists while permission can fall
        // through to canUseTool.
        "default",
        this.executable,
        () => this.afterTurn(),
        (delta) => {
          this.rollWindow();
          w.windowSpentUsd += delta;
        },
        {
          summarise: this.describe,
          options: {
            // Its world, in four lines: no built-in tools at all, the board's
            // tools only, nothing from the filesystem's settings or CLAUDE.md,
            // and a prompt of its own rather than Claude Code's.
            tools: [],
            mcpServers: {
              board: {
                ...this.server,
                tools: ASKS_FIRST.map((name) => ({ name, permission_policy: "always_ask" as const })),
              },
            },
            // Spawning this logs CLAUDE_SDK_CAN_USE_TOOL_SHADOWED, naming the
            // tools below: a bare allowedTools entry approves a tool before
            // canUseTool is consulted. That is the point. The two left out are
            // the two that must reach the callback, and do.
            allowedTools: TOOL_NAMES.filter((n) => !(ASKS_FIRST as readonly string[]).includes(n)).map(qualified),
            settingSources: [],
            systemPrompt: { type: "custom", prompt: WARDEN_PROMPT },
          },
        },
      );
      this.gov.start();
    }
    w.chat.push({ role: "you", text, at: Date.now() });
    w.state = "working";
    w.lastActiveAt = Date.now();
    this.emit();
    this.gov.push(text);
  }

  answerFlag(allow: boolean): void {
    this.gov?.answerFlag(allow);
  }

  async interrupt(): Promise<void> {
    await this.gov?.interrupt();
  }

  /** A changed ceiling only reaches a new session, so retire this one when idle. */
  private budgetStale = false;

  private afterTurn(): void {
    if (this.budgetStale && this.w.state === "idle") {
      this.budgetStale = false;
      // Deferred: this runs inside the governor's own pump.
      setTimeout(() => {
        if (this.w.state === "idle") this.reap();
      }, 0);
    }
  }

  setBudget(usd: number | null): void {
    this.w.maxBudgetUsd = usd;
    if (this.gov) {
      if (this.w.state === "idle") this.reap();
      else this.budgetStale = true;
    }
    this.emit();
  }

  /** Takes effect mid-conversation, like a settlement's. */
  async setModel(model: string | null): Promise<void> {
    this.w.model = model;
    await this.gov?.setModel(model ?? this.defaultModel());
    this.emit();
  }

  /** The realm default moved under a warden that is following it. */
  async defaultModelChanged(): Promise<void> {
    if (this.w.model === null) await this.gov?.setModel(this.defaultModel());
  }

  defaultBudgetChanged(): void {
    if (this.w.maxBudgetUsd === null) this.setBudget(null);
  }

  /** Kill the process, keep the sessionId: the warden goes dormant. */
  reap(): void {
    this.budgetStale = false;
    if (!this.gov) return;
    this.gov.stop();
    this.gov = null;
    const w = this.w;
    if (w.state !== "needs_you") {
      w.state = w.sessionId ? "dormant" : "idle";
      w.flag = null;
      this.emit();
    }
  }

  /** Quiet too long, like a city. */
  idleFor(now: number, minutes: number): boolean {
    if (!this.gov) return false;
    const w = this.w;
    if (w.state === "working" || w.state === "needs_you") return false;
    return now - w.lastActiveAt > minutes * 60_000;
  }

  stop(): void {
    this.gov?.stop();
    this.gov = null;
  }
}
