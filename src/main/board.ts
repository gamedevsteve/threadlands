/**
 * The bounty board: ledgers of bounties, in board.json beside the realm.
 *
 * Kept out of realm.json on purpose. Nothing done to the board can then cost a
 * settlement its session id. Written atomically, like the realm.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Board, BoardOp, Bounty, Settlement, Warden } from "../shared/types.js";

/** Transcripts are capped on disk; the SDK's own session history is the archive. */
const CHAT_KEPT_ON_DISK = 200;

/**
 * The warden, before it has ever been spoken to.
 *
 * `id` is a fixed word rather than a uuid: there is exactly one warden, the
 * renderer refers to it by name, and it must never read as a settlement.
 */
function freshWarden(cwd: string): Warden {
  return {
    id: "warden",
    name: "The warden",
    cwd,
    model: null,
    state: "idle",
    sessionId: null,
    flag: null,
    chat: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    maxBudgetUsd: null,
    windowSpentUsd: 0,
    windowResetsAt: null,
    lastActiveAt: Date.now(),
    error: null,
  };
}

export class BoardStore {
  private readonly file: string;
  /** The empty folder the warden runs in: no code, nothing to read. */
  readonly wardenCwd: string;
  board: Board;

  constructor(dir: string) {
    this.file = join(dir, "board.json");
    this.wardenCwd = join(dir, "warden");
    mkdirSync(this.wardenCwd, { recursive: true });
    this.board = { ledgers: [], bounties: [], nextNumber: 1, warden: freshWarden(this.wardenCwd) };
    this.load();
  }

  private load(): void {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Board>;
        this.board = {
          ledgers: raw.ledgers ?? [],
          bounties: raw.bounties ?? [],
          nextNumber: raw.nextNumber ?? 1,
          // A board written before the warden existed simply has none.
          warden: { ...freshWarden(this.wardenCwd), ...(raw.warden ?? {}) },
        };
        // Nothing is running at boot: a live state on disk is always a lie.
        const w = this.board.warden;
        w.id = "warden";
        w.cwd = this.wardenCwd;
        w.state = w.sessionId ? "dormant" : "idle";
        w.flag = null;
        // Bounties from before numbers existed get them now, oldest first.
        const unnumbered = this.board.bounties.filter((b) => !b.number).sort((a, b) => a.createdAt - b.createdAt);
        for (const b of unnumbered) b.number = this.board.nextNumber++;
        if (unnumbered.length) this.save();
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
    const onDisk: Board = {
      ...this.board,
      warden: { ...this.board.warden, chat: this.board.warden.chat.slice(-CHAT_KEPT_ON_DISK) },
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
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
   * Nothing here ever messages a settlement: you do that yourself, by its id.
   *
   * `actor` is who asked — you, at the panel, or the warden through its tools.
   * A comment is signed with it; the entries the board writes itself say so.
   */
  async apply(
    op: BoardOp,
    settlement: (id: string) => Settlement | undefined,
    actor: "you" | "warden" = "you",
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
    const note = (x: Bounty, text: string, who: "you" | "warden" | "board" = "board") =>
      x.log.push({ at: Date.now(), who, text });
    // The board's own entries name the warden when it was the warden's doing;
    // yours need no byline, because the board is yours.
    const by = actor === "warden" ? " by the warden" : "";
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
          id: randomUUID(), number: b.nextNumber++, ledgerId: op.ledgerId, title: clean(op.title, "bounty"), notes: "",
          state: "open", assignee: null, branch: null, commit: null, log: [],
          createdAt: Date.now(), doneAt: null,
        };
        note(x, `Posted${by}.`);
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
        note(x, `Moved from ${from} to ${to}${by}.`);
        break;
      }
      case "assign": {
        const x = bounty(op.id);
        if (op.settlementId === x.assignee) return;
        if (op.settlementId === null) {
          const was = x.assignee ? settlement(x.assignee)?.name ?? "its settlement" : "nobody";
          x.assignee = null;
          if (x.state === "assigned") x.state = "open";
          note(x, `Unassigned from ${was}${by}.`);
          break;
        }
        const s = settlement(op.settlementId);
        if (!s) throw new Error("That settlement is gone.");
        x.assignee = s.id;
        if (x.state === "open") x.state = "assigned";
        note(x, `Assigned to ${s.name}${by}.`);
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
          note(x, where ? `Done${by}, on ${where.branch} at ${where.commit}${where.dirty ? ", with uncommitted changes" : ""}.` : `Done${by}.`);
        } else {
          x.state = x.assignee ? "assigned" : "open";
          x.doneAt = null;
          note(x, `Opened again${by}.`);
        }
        break;
      }
      case "comment": {
        const t = op.text.trim();
        if (!t) return;
        note(bounty(op.id), t.slice(0, 20_000), actor);
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

/** One git command in a folder, or null if it failed. Never throws. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (err, out) =>
      resolve(err ? null : out.trim()),
    );
  });
}

/** Branch, short commit and whether the tree is dirty, or null if it is not a git repo. */
function gitWhere(cwd: string): Promise<{ branch: string; commit: string; dirty: boolean } | null> {
  return Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["rev-parse", "--short", "HEAD"]),
    git(cwd, ["status", "--porcelain"]),
  ]).then(([branch, commit, status]) =>
    branch && commit ? { branch, commit, dirty: !!status } : null,
  );
}

/** What the Keep can see of a settlement's work, without reading any code. */
export type GitReport = {
  repo: boolean;
  branch: string | null;
  lastCommit: string | null;
  /** Paths with uncommitted changes, capped — the count is what matters. */
  uncommitted: string[];
  uncommittedCount: number;
  /** One line per commit ahead of the upstream branch. */
  unpushed: string[];
  /** Null when the branch has no upstream at all: nothing has ever been pushed. */
  upstream: string | null;
};

/**
 * Look at a settlement's folder through git, for the warden.
 *
 * This is the whole of the warden's view of anybody's work: it never reads a
 * file, and nothing here can change the folder. Read-only git commands only.
 */
export async function gitReport(cwd: string): Promise<GitReport> {
  const [branch, lastCommit, status, upstream] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["log", "-1", "--format=%h %s (%cr)"]),
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  ]);
  if (!branch) return { repo: false, branch: null, lastCommit: null, uncommitted: [], uncommittedCount: 0, unpushed: [], upstream: null };
  const lines = (status ?? "").split("\n").filter(Boolean);
  const unpushed = upstream
    ? ((await git(cwd, ["log", "--format=%h %s", `${upstream}..HEAD`])) ?? "").split("\n").filter(Boolean)
    : [];
  return {
    repo: true,
    branch,
    lastCommit,
    uncommitted: lines.slice(0, 40).map((l) => l.trim()),
    uncommittedCount: lines.length,
    unpushed: unpushed.slice(0, 40),
    upstream,
  };
}
