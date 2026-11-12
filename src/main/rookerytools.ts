/**
 * Threadlands — the rookery, as a governor sees it.
 *
 * Four tools, and the whole of what one settlement can say to another: post a
 * finding, post a plan, reply in a thread, and read a letter it is part of.
 *
 * Nothing here wakes anyone. Every post a governor makes waits at the rookery
 * marked *waiting for you*, exactly like the ones the settler writes by hand,
 * and only the settler's forward — `apply({op:"forward"})`, which goes through
 * the same send as typing in a chat box — ever delivers one. A governor cannot
 * forward, cannot bin, cannot address a settlement directly, and cannot read a
 * post that was not written by it or forwarded to it: a thread may be half
 * inspected, and the half the settler has not looked at is not its business.
 *
 * Questions work the same way. `asks_question` raises a flag on the post so
 * the settler can see an answer is wanted; it does not ask anybody anything.
 *
 * Built per spawn, like the board's, because every handler has to know which
 * settlement is asking — that is the whole of the access rule.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { InferShape, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { summarise } from "./supervisor.js";
import type { GovernorExtras } from "./supervisor.js";
import type { RookeryStore } from "./rookery.js";
import type { Letter, LetterPost, Settlement } from "../shared/types.js";
import { letterRef } from "../shared/types.js";

const said = (text: string) => ({ content: [{ type: "text" as const, text }] });
const refused = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Every rookery tool a governor gets. */
const TOOL_NAMES = ["send_finding", "send_plan", "reply_to_letter", "read_letter"] as const;

const qualified = (name: string) => `mcp__rookery__${name}`;

const INSTRUCTIONS =
  "The realm's rookery, where letters wait for the settler. This is the only way anything you " +
  "write reaches another settlement, and it never reaches one by itself: every letter and every " +
  "reply waits at the rookery until the settler reads it and decides whether to forward it. " +
  "Send a finding when you have evidence that another settlement's code is wrong — what is wrong " +
  "and how you know, not a fix. Send a plan when you have written one the settler may want to " +
  "keep or show to people outside the realm. Reply to a letter to answer one that was forwarded " +
  "to you: it is the only way you can answer another settlement. Set asks_question when you need " +
  "an answer before you can go on, which raises a flag on the letter — then stop and wait; the " +
  "settler answers in this chat, not through the rookery. You can read only the letters you wrote " +
  "yourself and the posts forwarded to you.";

/** A plan's body is read from the settlement's folder, so keep it sane. */
const MAX_PLAN_BYTES = 400_000;

export class GovernorRookery {
  constructor(
    private readonly rookery: RookeryStore,
    /** Push the rookery at the renderer. The store writes itself to disk. */
    private readonly emit: () => void,
    /** The settlement as it stands now, so a razed one cannot still post. */
    private readonly look: (id: string) => Settlement | undefined,
  ) {}

  /** What this settlement is given at the rookery. Merged with the board's. */
  extrasFor(s: Settlement): GovernorExtras {
    const server = this.serverFor(s.id);
    return {
      options: {
        mcpServers: { rookery: server },
        // Allowed without asking, like the board's: a letter that waits for the
        // settler is already the flag. Asking twice would only be noise.
        allowedTools: TOOL_NAMES.map(qualified),
      },
      summarise: (toolName, input) =>
        toolName.startsWith("mcp__rookery__") ? describe(toolName, input) : summarise(toolName, input),
    };
  }

  // ── what this settlement may see ───────────────────────────────────────────

  private settlement(id: string): Settlement {
    const s = this.look(id);
    if (!s) throw new Error("This settlement is no longer on the map.");
    return s;
  }

  /**
   * A post this settlement is entitled to: one it wrote, or one the settler
   * forwarded to it. Anything else in the thread is still being inspected.
   */
  private mine(p: LetterPost, id: string): boolean {
    if (p.author.kind === "settlement" && p.author.id === id) return true;
    return p.status === "forwarded" && p.forwardedTo === id;
  }

  /**
   * A letter by the id the settler says out loud.
   *
   * One that exists but has nothing in it for this settlement is refused in the
   * same words as one that never existed: what else is at the rookery is not a
   * governor's business.
   */
  private letterNamed(id: string, ref: string): Letter {
    const l = this.rookery.find(ref);
    if (!l || !l.posts.some((p) => this.mine(p, id))) {
      throw new Error(
        `${ref.trim()} is not yours to read. You can read the letters you sent, and the ones the settler ` +
          `forwarded to you.`,
      );
    }
    return l;
  }

  /** A file the settlement may post: inside its own folder, and a real file. */
  private planPath(s: Settlement, path: string): string {
    const want = isAbsolute(path) ? path : resolve(s.cwd, path);
    let real: string;
    let root: string;
    try {
      real = realpathSync(want);
      root = realpathSync(s.cwd);
    } catch {
      throw new Error(`No file at ${want}.`);
    }
    // Resolved on both sides, so a symlink or a ".." cannot lead out of the folder.
    if (real !== root && !real.startsWith(root.endsWith("/") ? root : `${root}/`)) {
      throw new Error(`${want} is outside this settlement's folder. A plan has to come from your own work.`);
    }
    if (!statSync(real).isFile()) throw new Error(`${want} is not a file.`);
    if (statSync(real).size > MAX_PLAN_BYTES) throw new Error(`${want} is too long to send as a letter.`);
    return real;
  }

  /** The thread as this settlement may read it, newest last. */
  private thread(l: Letter, id: string): string {
    const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
    const turns = l.posts.filter((p) => this.mine(p, id)).map((p) => {
      const who =
        p.author.kind === "you" ? "The settler"
        : p.author.kind === "outside" ? `${p.author.name} (outside the realm)`
        : p.author.id === id ? "You" : p.author.name;
      const note = p.forwardedTo === id && p.note ? `\n\nThe settler's note: ${p.note}` : "";
      return `### ${who} — ${when(p.at)}${p.asksQuestion ? " (asked the settler a question)" : ""}\n\n${p.body.trim()}${note}`;
    });
    const hidden = l.posts.length - turns.length;
    return [
      `${letterRef(l)} — ${l.title} (${l.kind})`,
      ``,
      turns.join("\n\n---\n\n"),
      ...(hidden > 0
        ? [
            ``,
            `---`,
            ``,
            `(${hidden} other post${hidden === 1 ? "" : "s"} in this thread ${hidden === 1 ? "is" : "are"} ` +
              `not yours to read. The settler will forward what you need.)`,
          ]
        : []),
    ].join("\n");
  }

  /** The same closing words everywhere: nothing has been sent to anyone. */
  private waiting(l: Letter, asked: boolean): string {
    return (
      `${letterRef(l)} — "${l.title}" is at the rookery, waiting for the settler. ` +
      (asked ? `It is flagged as asking a question. ` : "") +
      `Nobody has been told and no settlement has been woken: the settler reads it and decides whether to ` +
      `forward it. ${asked ? "Stop here and wait for an answer in this chat." : "Carry on with your work."}`
    );
  }

  // ── the tools ──────────────────────────────────────────────────────────────

  private serverFor(id: string): McpSdkServerConfigWithInstance {
    /** One rookery tool. Anything it throws comes back as a refusal to read. */
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

    const asks = z
      .boolean()
      .optional()
      .describe(
        "True if you need an answer from the settler before you can go on. It raises a flag on the letter " +
          "so the settler can see an answer is wanted. It does not ask anyone anything by itself.",
      );
    const titleArg = z.string().describe("A short line that says what this is, for the rookery's list.");

    return createSdkMcpServer({
      name: "rookery",
      version: "1.0.0",
      instructions: INSTRUCTIONS,
      alwaysLoad: true,
      tools: [
        t(
          "send_finding",
          "Post a finding at the rookery: something wrong in another settlement's code, with the evidence for it — what you saw and how you know, not a fix. It waits there for the settler, who decides who, if anyone, it goes to. Nothing is sent and nobody is woken.",
          {
            title: titleArg,
            body: z
              .string()
              .describe("The finding in full, as markdown: what is wrong, where, and the evidence for it."),
            asks_question: asks,
          },
          async ({ title, body, asks_question }) => {
            const s = this.settlement(id);
            const text = body.trim();
            if (!text) throw new Error("A finding needs a body: what is wrong, and how you know.");
            const l = this.rookery.open(
              "finding",
              title,
              text,
              { kind: "settlement", id: s.id, name: s.name },
              null,
              !!asks_question,
            );
            this.emit();
            return this.waiting(l, !!asks_question);
          },
        ),

        t(
          "send_plan",
          "Post a plan at the rookery for the settler to keep, read and share with people outside the realm. Either write it out, or name a markdown file in this settlement's folder. It waits there for the settler; nothing is sent and nobody is woken.",
          {
            title: z.string().optional().describe("A short line that says what the plan is. Taken from the file's first heading if you give a path."),
            body: z.string().optional().describe("The plan in full, as markdown. Leave it out if you are giving a path."),
            path: z
              .string()
              .optional()
              .describe("A markdown file to send instead, inside this settlement's folder. Absolute, or relative to the folder."),
            asks_question: asks,
          },
          async ({ title, body, path, asks_question }) => {
            const s = this.settlement(id);
            if (!path && !body?.trim()) throw new Error("Give the plan as a body, or the path of a file in this settlement's folder.");
            if (path && body?.trim()) throw new Error("Give a body or a path, not both.");
            let text: string;
            let name: string | undefined = title;
            if (path) {
              const file = this.planPath(s, path);
              text = await readFile(file, "utf8");
              if (!text.trim()) throw new Error(`${file} is empty.`);
              name = title ?? text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(file);
            } else {
              text = body!.trim();
            }
            const l = this.rookery.open(
              "plan",
              name ?? "Untitled plan",
              text,
              { kind: "settlement", id: s.id, name: s.name },
              null,
              !!asks_question,
            );
            this.emit();
            return this.waiting(l, !!asks_question);
          },
        ),

        t(
          "reply_to_letter",
          "Add a reply to a letter's thread at the rookery — the only way you can answer another settlement. Your reply waits there for the settler like any letter; it does not reach the other settlement unless the settler forwards it.",
          {
            letter: z.string().describe('The letter, by the id at the rookery — "L-7".'),
            body: z.string().describe("Your reply, as markdown."),
            asks_question: asks,
          },
          async ({ letter, body, asks_question }) => {
            const s = this.settlement(id);
            const l = this.letterNamed(id, letter);
            const text = body.trim();
            if (!text) throw new Error("A reply needs a body.");
            this.rookery.reply(l, text, { kind: "settlement", id: s.id, name: s.name }, !!asks_question);
            this.emit();
            return (
              `Your reply is in ${letterRef(l)} — "${l.title}", waiting for the settler. ` +
              (asks_question ? `It is flagged as asking a question. ` : "") +
              `Nobody has been told and no settlement has been woken. ` +
              `${asks_question ? "Stop here and wait for an answer in this chat." : "Carry on with your work."}`
            );
          },
        ),

        t(
          "read_letter",
          "Read a letter at the rookery: one you sent, or one the settler forwarded to you. The posts the settler has not forwarded to you are not shown.",
          { letter: z.string().describe('The letter, by the id at the rookery — "L-7".') },
          async ({ letter }) => {
            this.settlement(id);
            return this.thread(this.letterNamed(id, letter), id);
          },
        ),
      ],
    });
  }
}

/**
 * One line about a governor's rookery call, for the transcript.
 *
 * The rookery's own words, so the folded run under a reply reads like the rest
 * of the map rather than like an MCP trace.
 */
export function describe(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const asked = i.asks_question === true ? ", with a question" : "";
  const ref = typeof i.letter === "string" ? i.letter : "a letter";
  switch (toolName.replace(/^mcp__rookery__/, "")) {
    case "send_finding": return `send a finding to the rookery${asked}`;
    case "send_plan": return `send a plan to the rookery${asked}`;
    case "reply_to_letter": return `reply to ${ref} at the rookery${asked}`;
    case "read_letter": return `read ${ref} at the rookery`;
    default: return `use ${toolName}`;
  }
}
