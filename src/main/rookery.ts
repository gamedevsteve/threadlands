/**
 * The rookery: letters and their threads, in rookery.json beside the board.
 *
 * Every post a settlement makes waits here for you. Nothing in this file ever
 * reaches a settlement on its own: forwarding is your click, and it goes
 * through the same send as typing in a settlement's chat.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { letterRef } from "../shared/types.js";
import type { Letter, LetterAuthor, LetterKind, LetterPost, Rookery, RookeryOp, Settlement } from "../shared/types.js";

export class RookeryStore {
  private readonly file: string;
  rookery: Rookery = { letters: [], nextNumber: 1 };

  constructor(dir: string) {
    this.file = join(dir, "rookery.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Rookery>;
        this.rookery = { letters: raw.letters ?? [], nextNumber: raw.nextNumber ?? 1 };
      } catch (e) {
        console.error(`[rookery] could not read rookery.json, starting fresh: ${e}`);
        try { renameSync(this.file, `${this.file}.unreadable-${Date.now()}`); } catch { /* best effort */ }
      }
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.rookery, null, 2));
    renameSync(tmp, this.file);
  }

  /** How many posts are waiting for you, across every letter. */
  waiting(): number {
    return this.rookery.letters.reduce((n, l) => n + l.posts.filter((p) => p.status === "waiting").length, 0);
  }

  /** Start a thread. A settlement's first post waits for you; yours does not. */
  open(kind: LetterKind, title: string, body: string, author: LetterAuthor, to: string | null): Letter {
    const letter: Letter = {
      id: randomUUID(),
      number: this.rookery.nextNumber++,
      kind,
      title: title.trim().slice(0, 200) || "Untitled",
      to,
      posts: [post(author, body)],
      createdAt: Date.now(),
      plain: null,
    };
    this.rookery.letters.push(letter);
    this.save();
    return letter;
  }

  /** A markdown file from a settlement's folder, posted as a plan from it. */
  importPlan(path: string, from: Settlement): Letter {
    const body = readFileSync(path, "utf8");
    const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const letter = this.open("plan", heading || basename(path), body, { kind: "settlement", id: from.id, name: from.name }, null);
    // You chose the file, so it is not waiting to be inspected.
    letter.posts[0]!.status = "kept";
    this.save();
    return letter;
  }

  async apply(
    op: RookeryOp,
    settlement: (id: string) => Settlement | undefined,
    tell: (id: string, text: string) => Promise<void>,
  ): Promise<void> {
    const letter = this.rookery.letters.find((l) => l.id === op.letterId);
    if (!letter) throw new Error("That letter is gone.");
    const postOf = (id: string) => {
      const p = letter.posts.find((x) => x.id === id);
      if (!p) throw new Error("That post is gone.");
      return p;
    };

    switch (op.op) {
      case "post": {
        const body = op.body.trim();
        if (!body) return;
        if (op.author.kind === "outside" && !op.author.name.trim()) throw new Error("Say who it is from.");
        const author: LetterAuthor = op.author.kind === "outside" ? { kind: "outside", name: op.author.name.trim().slice(0, 80) } : { kind: "you" };
        letter.posts.push({ ...post(author, body), status: "kept" });
        break;
      }
      case "forward": {
        const p = postOf(op.postId);
        const s = settlement(op.to);
        if (!s) throw new Error("That settlement is gone.");
        // Told first: if it cannot be sent, the post stays where it was.
        await tell(s.id, delivery(letter, p, op.note.trim()));
        p.status = "forwarded";
        p.forwardedTo = s.id;
        p.forwardedAt = Date.now();
        p.note = op.note.trim() || null;
        break;
      }
      case "setStatus":
        postOf(op.postId).status = op.status;
        break;
      case "rename":
        letter.title = op.title.trim().slice(0, 200) || letter.title;
        break;
      case "deleteLetter":
        this.rookery.letters = this.rookery.letters.filter((l) => l.id !== letter.id);
        break;
    }
    this.save();
  }

  /** A razed settlement's letters stay: the thread is the record. Only its name is kept. */
}

function post(author: LetterAuthor, body: string): LetterPost {
  return {
    id: randomUUID(),
    at: Date.now(),
    author,
    body: body.slice(0, 200_000),
    status: author.kind === "settlement" ? "waiting" : "kept",
    forwardedTo: null,
    forwardedAt: null,
    note: null,
  };
}

export function authorName(a: LetterAuthor): string {
  return a.kind === "settlement" ? a.name : a.kind === "outside" ? a.name : "you";
}

/**
 * What a governor receives when you forward a post: the thread so far, so it
 * has the context, ending at the post you chose, and your note if any.
 */
function delivery(letter: Letter, chosen: LetterPost, note: string): string {
  const upTo = letter.posts.slice(0, letter.posts.indexOf(chosen) + 1).filter((p) => p.status !== "binned");
  const turns = upTo.map((p) => {
    const who = p.author.kind === "you" ? "The settler" : p.author.kind === "outside" ? `${p.author.name} (outside the realm)` : p.author.name;
    return `### ${who}\n\n${p.body.trim()}`;
  });
  return [
    `A letter from the rookery: **${letterRef(letter)} — ${letter.title}** (${letter.kind}).`,
    ...(note ? [``, `The settler's note: ${note}`] : []),
    ``,
    `The thread so far:`,
    ``,
    turns.join("\n\n---\n\n"),
    ``,
    `Work on what it asks here. If you have questions for the settler, ask them plainly and stop.`,
  ].join("\n");
}
