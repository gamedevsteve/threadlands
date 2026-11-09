/**
 * The bounty board: ledgers of bounties, in board.json beside the realm.
 *
 * Kept out of realm.json on purpose. Nothing done to the board can then cost a
 * settlement its session id. Written atomically, like the realm.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Board, BoardOp, Bounty, Settlement } from "../shared/types.js";

export class BoardStore {
  private readonly file: string;
  board: Board = { ledgers: [], bounties: [] };

  constructor(dir: string) {
    this.file = join(dir, "board.json");
    this.load();
  }

  private load(): void {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Board>;
        this.board = { ledgers: raw.ledgers ?? [], bounties: raw.bounties ?? [] };
      } catch (e) {
        // A board that will not parse is kept aside rather than overwritten.
        console.error(`[board] could not read board.json, starting fresh: ${e}`);
        try { renameSync(this.file, `${this.file}.unreadable-${Date.now()}`); } catch { /* best effort */ }
      }
    }
    // There is always somewhere to put a bounty.
    if (!this.board.ledgers.length) {
      this.board.ledgers.push({ id: randomUUID(), name: "Mine", grants: [], createdAt: Date.now() });
      this.save();
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.board, null, 2));
    renameSync(tmp, this.file);
  }

  /** Forget a razed settlement: its grants go, and what it was working is open again. */
  forgetSettlement(id: string): void {
    let changed = false;
    for (const l of this.board.ledgers) {
      if (l.grants.includes(id)) { l.grants = l.grants.filter((g) => g !== id); changed = true; }
    }
    for (const b of this.board.bounties) {
      if (b.assignee === id) {
        b.assignee = null;
        const reopened = b.state === "assigned";
        if (reopened) b.state = "open";
        b.log.push({ at: Date.now(), who: "board", text: reopened ? "Its settlement was razed. Open again." : "Its settlement was razed." });
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /**
   * Apply one change. Throws with a reason fit to show if it cannot be done.
   * `settlement` looks up a settlement; `tell` sends one a message.
   */
  async apply(
    op: BoardOp,
    settlement: (id: string) => Settlement | undefined,
    tell: (id: string, text: string) => Promise<void>,
  ): Promise<void> {
    const b = this.board;
    const ledger = (id: string) => {
      const l = b.ledgers.find((x) => x.id === id);
      if (!l) throw new Error("That ledger is gone.");
      return l;
    };
    const bounty = (id: string) => {
      const x = b.bounties.find((y) => y.id === id);
      if (!x) throw new Error("That bounty is gone.");
      return x;
    };
    const note = (x: Bounty, text: string, who: "you" | "board" = "board") =>
      x.log.push({ at: Date.now(), who, text });
    const clean = (s: string, what: string) => {
      const t = s.trim();
      if (!t) throw new Error(`A ${what} needs a name.`);
      return t.slice(0, 200);
    };

    switch (op.op) {
      case "addLedger":
        b.ledgers.push({ id: randomUUID(), name: clean(op.name, "ledger"), grants: [], createdAt: Date.now() });
        break;
      case "renameLedger":
        ledger(op.id).name = clean(op.name, "ledger");
        break;
      case "deleteLedger": {
        ledger(op.id);
        if (b.bounties.some((x) => x.ledgerId === op.id)) throw new Error("Move or delete its bounties first.");
        if (b.ledgers.length === 1) throw new Error("The board keeps at least one ledger.");
        b.ledgers = b.ledgers.filter((x) => x.id !== op.id);
        break;
      }
      case "setGrants":
        ledger(op.id).grants = [...new Set(op.grants)].filter((id) => !!settlement(id));
        break;
      case "addBounty": {
        ledger(op.ledgerId);
        const x: Bounty = {
          id: randomUUID(), ledgerId: op.ledgerId, title: clean(op.title, "bounty"), notes: "",
          state: "open", assignee: null, branch: null, commit: null, log: [],
          createdAt: Date.now(), doneAt: null,
        };
        note(x, "Posted.");
        b.bounties.push(x);
        break;
      }
      case "editBounty": {
        const x = bounty(op.id);
        if (op.title !== undefined) x.title = clean(op.title, "bounty");
        if (op.notes !== undefined) x.notes = op.notes.slice(0, 20_000);
        break;
      }
      case "moveBounty": {
        const x = bounty(op.id);
        if (x.ledgerId === op.ledgerId) return;
        const from = ledger(x.ledgerId).name;
        const to = ledger(op.ledgerId).name;
        x.ledgerId = op.ledgerId;
        note(x, `Moved from ${from} to ${to}.`);
        break;
      }
      case "assign": {
        const x = bounty(op.id);
        if (op.settlementId === x.assignee) return;
        if (op.settlementId === null) {
          const was = x.assignee ? settlement(x.assignee)?.name ?? "its settlement" : "nobody";
          x.assignee = null;
          if (x.state === "assigned") x.state = "open";
          note(x, `Unassigned from ${was}.`);
          break;
        }
        const s = settlement(op.settlementId);
        if (!s) throw new Error("That settlement is gone.");
        // Told first: if the message cannot be sent, nothing on the board changes.
        const brief = [
          `A bounty from the board, ledger "${ledger(x.ledgerId).name}":`,
          ``,
          `**${x.title}**`,
          ...(x.notes.trim() ? ["", x.notes.trim()] : []),
          ``,
          `Work on it here. When it is done, say so, and say whether it is committed and pushed.`,
        ].join("\n");
        await tell(s.id, brief);
        x.assignee = s.id;
        if (x.state === "open") x.state = "assigned";
        note(x, `Assigned to ${s.name}.`);
        break;
      }
      case "setDone": {
        const x = bounty(op.id);
        if (op.done === (x.state === "done")) return;
        if (op.done) {
          const s = x.assignee ? settlement(x.assignee) : undefined;
          const where = s ? await gitWhere(s.cwd) : null;
          x.branch = where?.branch ?? null;
          x.commit = where?.commit ?? null;
          x.state = "done";
          x.doneAt = Date.now();
          note(x, where ? `Done, on ${where.branch} at ${where.commit}${where.dirty ? ", with uncommitted changes" : ""}.` : "Done.");
        } else {
          x.state = x.assignee ? "assigned" : "open";
          x.doneAt = null;
          note(x, "Opened again.");
        }
        break;
      }
      case "comment": {
        const t = op.text.trim();
        if (!t) return;
        note(bounty(op.id), t.slice(0, 20_000), "you");
        break;
      }
      case "deleteBounty":
        bounty(op.id);
        b.bounties = b.bounties.filter((x) => x.id !== op.id);
        break;
    }
    this.save();
  }
}

/** Branch, short commit and whether the tree is dirty, or null if it is not a git repo. */
function gitWhere(cwd: string): Promise<{ branch: string; commit: string; dirty: boolean } | null> {
  const git = (args: string[]) =>
    new Promise<string | null>((resolve) => {
      execFile("git", ["-C", cwd, ...args], { timeout: 5000 }, (err, out) => resolve(err ? null : out.trim()));
    });
  return Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["rev-parse", "--short", "HEAD"]),
    git(["status", "--porcelain"]),
  ]).then(([branch, commit, status]) =>
    branch && commit ? { branch, commit, dirty: !!status } : null,
  );
}
