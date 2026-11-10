/**
 * Threadlands — the bounty board, as a governor sees it.
 *
 * A settlement's own window onto the board: the ledgers it has been granted,
 * the bounties in them, and one thing it can say — `report_fixed`, which goes
 * to the warden rather than to the board.
 *
 * Everything else here is read-only. No governor can create, edit, move,
 * assign or close a bounty, and nothing here can reach another settlement. A
 * bounty is closed the way it always was: the warden checks the work and the
 * settler answers a flag on the board.
 *
 * What a settlement may read is the ledger's grant — plus anything assigned to
 * it, because assigning is its own explicit grant and survives a move to a
 * ledger nobody granted.
 *
 * The warden keeps its own tools in warden.ts: they are entwined with its
 * session, and it has powers no governor does. These are handed to every
 * settlement the Supervisor spawns, granted or not: grants change while a
 * session runs, and the tool set is fixed when it spawns.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { InferShape, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { summarise } from "./supervisor.js";
import type { GovernorExtras } from "./supervisor.js";
import type { BoardStore } from "./board.js";
import type { Bounty, Ledger, Settlement } from "../shared/types.js";
import { bountyRef } from "../shared/types.js";

const said = (text: string) => ({ content: [{ type: "text" as const, text }] });
const refused = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Every tool a governor gets. All read-only but the last. */
const TOOL_NAMES = ["list_ledgers", "list_bounties", "read_bounty", "report_fixed"] as const;

const qualified = (name: string) => `mcp__board__${name}`;

const INSTRUCTIONS =
  "The realm's bounty board. The settler keeps a to-do list here, and some of its ledgers " +
  "are granted to this settlement to read. Use it when the settler names a bounty by its id " +
  '("B-12"), or asks what is on the board for you. These tools read the board and nothing ' +
  "else: you cannot post, edit, move, assign or close a bounty. When you have finished what " +
  "a bounty asked for, report_fixed tells the board's warden, which checks your work and asks " +
  "the settler whether to close it. Nothing here reaches another settlement.";

/**
 * The board tools, bound to one settlement.
 *
 * Built per spawn rather than once, because every handler has to know which
 * settlement is asking — that is the whole of the access rule.
 */
export class GovernorBoard {
  constructor(
    private readonly board: BoardStore,
    /** Push the board at the renderer, and write it to disk. */
    private readonly emit: () => void,
    /** The settlement as it stands now, so a razed one cannot still report. */
    private readonly look: (id: string) => Settlement | undefined,
    /** Hand a report to the warden. Nothing goes straight to the board. */
    private readonly toWarden: (s: Settlement, b: Bounty, note: string) => void,
  ) {}

  /** What a settlement is given beyond the realm's defaults: just the board. */
  extrasFor(s: Settlement): GovernorExtras {
    const server = this.serverFor(s.id);
    return {
      options: {
        mcpServers: { board: server },
        // Reading the board asks nobody, and a report only wakes the warden —
        // the flag that decides anything is the warden's, not a governor's.
        allowedTools: TOOL_NAMES.map(qualified),
      },
      // Board calls get the board's words; everything else keeps the Keep's.
      summarise: (toolName, input) =>
        toolName.startsWith("mcp__board__") ? describe(toolName, input) : summarise(toolName, input),
    };
  }

  // ── what this settlement may see ───────────────────────────────────────────

  private ledgersFor(id: string): Ledger[] {
    return this.board.board.ledgers.filter((l) => l.grants.includes(id));
  }

  /** Granted, or assigned to it. Either is enough; nothing else is. */
  private visible(b: Bounty, id: string): boolean {
    if (b.assignee === id) return true;
    return !!this.board.board.ledgers.find((l) => l.id === b.ledgerId)?.grants.includes(id);
  }

  private bountiesFor(id: string): Bounty[] {
    return this.board.board.bounties.filter((b) => this.visible(b, id)).sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * A ledger this settlement may read, by name.
   *
   * One it has not been granted is "no such ledger" rather than "not yours":
   * what else is on the board is not a governor's business.
   */
  private ledgerNamed(id: string, name: string): Ledger {
    const want = name.trim().toLowerCase();
    const mine = this.ledgersFor(id);
    const hit = mine.find((l) => l.id === name) ?? mine.find((l) => l.name.toLowerCase() === want);
    if (hit) return hit;
    const known = mine.map((l) => l.name).join(", ");
    throw new Error(`No ledger called "${name}" is granted to you. You may read: ${known || "none"}.`);
  }

  /**
   * A bounty by the id the settler says out loud: B-12, or 12, or its uuid.
   *
   * One that exists but is neither granted nor assigned is refused by name, so
   * the governor knows to ask rather than wondering whether it mistyped.
   */
  private bountyNamed(id: string, ref: string): Bounty {
    const t = ref.trim();
    const n = Number(t.replace(/^b-?/i, ""));
    const all = this.board.board.bounties;
    const hit =
      all.find((b) => b.id === t) ?? (Number.isFinite(n) ? all.find((b) => b.number === n) : undefined);
    if (!hit) throw new Error(`No bounty ${t} on the board.`);
    if (!this.visible(hit, id)) {
      throw new Error(
        `${bountyRef(hit)} is not yours to read: its ledger has not been granted to this settlement, ` +
          `and it is not assigned to you. Ask the settler to grant the ledger or assign the bounty.`,
      );
    }
    return hit;
  }

  private settlement(id: string): Settlement {
    const s = this.look(id);
    if (!s) throw new Error("This settlement is no longer on the map.");
    return s;
  }

  private ledgerName(id: string): string {
    return this.board.board.ledgers.find((l) => l.id === id)?.name ?? "an unknown ledger";
  }

  /**
   * One line per bounty.
   *
   * Who else a bounty belongs to is not named: a governor is told whether it is
   * its own and nothing more about the rest of the map.
   */
  private line(b: Bounty, me: string): string {
    const state =
      b.state === "done" ? "done" : b.assignee === me ? "assigned to you" : b.assignee ? "assigned elsewhere" : "open";
    return `${bountyRef(b)} ${b.title} — ${state}`;
  }

  private detail(b: Bounty, me: string): string {
    const log = b.log.map(
      (e) => `  ${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")} ${e.who}: ${e.text}`,
    );
    return [
      `${bountyRef(b)} ${b.title}`,
      `ledger: ${this.ledgerName(b.ledgerId)}`,
      `state: ${b.state}${b.assignee === me ? " — assigned to you" : ""}`,
      ...(b.branch ? [`closed on: ${b.branch} at ${b.commit ?? "?"}`] : []),
      `notes: ${b.notes.trim() || "(none)"}`,
      "log:",
      ...(log.length ? log : ["  (empty)"]),
    ].join("\n");
  }

  // ── the tools ──────────────────────────────────────────────────────────────

  private serverFor(id: string): McpSdkServerConfigWithInstance {
    /** One board tool. Anything it throws comes back as a refusal to read. */
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

    const bountyArg = z.string().describe('The bounty, by the id on the board — "B-12".');

    return createSdkMcpServer({
      name: "board",
      version: "1.0.0",
      instructions: INSTRUCTIONS,
      alwaysLoad: true,
      tools: [
        t(
          "list_ledgers",
          "The ledgers on the realm's bounty board that this settlement may read, with how many bounties are open in each.",
          {},
          async () => {
            const mine = this.ledgersFor(id);
            const rows = mine.map((l) => {
              const all = this.board.board.bounties.filter((b) => b.ledgerId === l.id);
              const open = all.filter((b) => b.state !== "done").length;
              return `${l.name} — ${open} open of ${all.length}`;
            });
            // Assigning is its own grant, so work can be yours in a ledger you
            // cannot read. Say so rather than leaving a gap it cannot explain.
            const strays = this.board.board.bounties.filter(
              (b) => b.assignee === id && !mine.some((l) => l.id === b.ledgerId),
            );
            if (!rows.length && !strays.length) {
              return "No ledger on the board is granted to this settlement, and nothing is assigned to you.";
            }
            if (strays.length) {
              rows.push(
                `Also assigned to you, outside the ledgers you may read: ${strays.map((b) => bountyRef(b)).join(", ")}`,
              );
            }
            return rows.join("\n");
          },
        ),

        t(
          "list_bounties",
          "The bounties this settlement may read: everything in the ledgers granted to it, plus anything assigned to it. Newest last.",
          {
            ledger: z.string().optional().describe("Only this ledger, by name. Omit for everything you may read."),
            state: z
              .enum(["open", "assigned", "done", "all"])
              .optional()
              .describe('Default "open", which includes assigned ones.'),
            mine: z.boolean().optional().describe("True for only the bounties assigned to this settlement."),
          },
          async ({ ledger, state, mine }) => {
            const l = ledger ? this.ledgerNamed(id, ledger) : null;
            const want = state ?? "open";
            const rows = this.bountiesFor(id)
              .filter((b) => (l ? b.ledgerId === l.id : true))
              .filter((b) => (mine ? b.assignee === id : true))
              .filter((b) => (want === "all" ? true : want === "open" ? b.state !== "done" : b.state === want));
            if (!rows.length) {
              return `Nothing ${want === "all" ? "" : `${want} `}${l ? `in ${l.name}` : "on the board for you"}.`;
            }
            const by = (b: Bounty) => (l ? "" : ` [${this.ledgerName(b.ledgerId)}]`);
            return rows.map((b) => `${this.line(b, id)}${by(b)}`).join("\n");
          },
        ),

        t(
          "read_bounty",
          "One bounty in full: its notes, its state, and its whole log. Only a bounty in a ledger granted to this settlement, or one assigned to it.",
          { bounty: bountyArg },
          async ({ bounty }) => this.detail(this.bountyNamed(id, bounty), id),
        ),

        t(
          "report_fixed",
          "Tell the board's warden you have finished what a bounty asked for. The warden checks your work in git and asks the settler whether to close it — this closes nothing by itself, and you will not be told the answer. Commit and push first: uncommitted work is not finished work.",
          {
            bounty: bountyArg,
            note: z.string().describe("What you did, in a line or two: what changed, and how it was proved."),
          },
          async ({ bounty, note }) => {
            const s = this.settlement(id);
            const b = this.bountyNamed(id, bounty);
            if (b.state === "done") return `${bountyRef(b)} is already closed. Nothing was reported.`;
            const text = note.trim();
            if (!text) throw new Error("Say what you fixed: the warden has nothing else to go on.");
            await this.board.apply(
              { op: "reportFixed", id: b.id, settlementId: s.id, note: text },
              (x) => this.look(x),
            );
            this.emit();
            this.toWarden(s, b, text);
            return (
              `Reported to the warden, and written in ${bountyRef(b)}'s log. It will check this folder in git ` +
              `and ask the settler whether to close it. ${bountyRef(b)} is not closed, and nothing has been ` +
              `sent to anyone else. Carry on; the settler will tell you if more is wanted.`
            );
          },
        ),
      ],
    });
  }
}

/**
 * One line about a governor's board call, for the transcript.
 *
 * The board's own words, so the folded run under a reply reads like the rest of
 * the map rather than like an MCP trace.
 */
export function describe(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const ref = typeof i.bounty === "string" ? i.bounty : "a bounty";
  switch (toolName.replace(/^mcp__board__/, "")) {
    case "list_ledgers": return "look over the bounty board";
    case "list_bounties": return `read the board's bounties${typeof i.ledger === "string" ? ` in ${i.ledger}` : ""}`;
    case "read_bounty": return `read ${ref} on the board`;
    case "report_fixed": return `report ${ref} fixed to the warden`;
    default: return `use ${toolName}`;
  }
}
