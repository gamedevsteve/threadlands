/**
 * Threadlands — the Keep.
 *
 * Owns every Agent SDK session. One `Governor` per settlement. The renderer
 * never sees any of this; it gets plain `Settlement` snapshots pushed at it.
 *
 * Three lifecycle traps are load-bearing here, all found in the Phase 0 spike:
 *   1. Never `for await ... break` over a Query — the break calls .return() and
 *      kills the session. Hold one iterator and call .next() by hand.
 *   2. `canUseTool` must never throw. An exception takes down the whole session,
 *      not just the tool call, so it degrades to a deny.
 *   3. Never `await` iterator teardown on a session whose input stream is parked
 *      on a promise that never settles. It hangs forever. Fire and forget.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type {
  FlagChoice,
  PendingFlag,
  PermissionModeValue,
  Session,
  Settlement,
  SettlementKind,
} from "../shared/types.js";

/** A push-driven async iterable that never closes on its own: the governor's ear. */
function createInputStream() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

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

  const close = () => {
    closed = true;
    wake?.();
    wake = null;
  };

  const stream = (async function* () {
    while (!closed) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; });
      while (queue.length) yield queue.shift()!;
    }
  })();

  return { stream, push, close };
}

/** A short, human line about a tool call, so the map never parses tool input. */
export function summarise(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.file_path === "string" ? i.file_path : undefined;
  switch (toolName) {
    case "Write": return `write ${path ?? "a file"}`;
    case "Edit": return `edit ${path ?? "a file"}`;
    case "Read": return `read ${path ?? "a file"}`;
    case "Bash": return `run: ${String(i.command ?? "").slice(0, 120)}`;
    default: return `use ${toolName}`;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => (b as any)?.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export type SupervisorEvents = {
  changed: (s: Settlement) => void;
};

export class Supervisor {
  private governors = new Map<string, Governor<Settlement>>();

  constructor(
    private readonly settlements: Map<string, Settlement>,
    private readonly emit: (s: Settlement) => void,
    private readonly profileDir: (profileId: string) => string | null,
    private readonly maxBudgetUsd: () => number,
    private readonly defaultModel: () => string | null,
    private readonly defaultMode: () => PermissionModeValue,
    private readonly executable: string | undefined,
    private readonly sessionResetsAt: (profileId: string) => string | null,
    /**
     * What a settlement is given on top of the realm's defaults: its board
     * tools, bound to it. Merged last, so nothing above can be lost to it.
     */
    private readonly extrasFor: (s: Settlement) => GovernorExtras = () => ({}),
  ) {}

  /**
   * Start the settlement's session spend again if the account's usage session
   * has reset since it was counted: the reset time has passed, or the probe
   * reports a new one.
   */
  private rollWindow(s: Settlement): void {
    const current = this.sessionResetsAt(s.profileId);
    const now = Date.now();
    const expired = !!s.windowResetsAt && Date.parse(s.windowResetsAt) <= now;
    const moved = !!current && current !== s.windowResetsAt;
    if (!expired && !moved) return;
    s.windowSpentUsd = 0;
    s.windowResetsAt = current && Date.parse(current) > now ? current : null;
  }

  /** Send a prompt, spawning or resuming the governor as needed. */
  async send(id: string, text: string): Promise<void> {
    const s = this.settlements.get(id);
    if (!s) throw new Error(`no settlement ${id}`);

    let g = this.governors.get(id);
    if (!g) {
      // The ceiling caps spend within the account's usage session, so a spawn
      // is given only what is left of it this session.
      this.rollWindow(s);
      const left = this.ceilingOf(s) - s.windowSpentUsd;
      if (left < 0.01) {
        s.chat.push({ role: "you", text, at: Date.now() });
        s.chat.push({ role: "system", text: overBudget(s, this.ceilingOf(s)), at: Date.now() });
        s.state = s.sessionId ? "dormant" : "idle";
        this.emit(s);
        return;
      }
      g = new Governor(
        s,
        this.emit,
        this.profileDir(s.profileId),
        left,
        s.model ?? this.defaultModel(),
        s.permissionMode ?? this.defaultMode(),
        this.executable,
        (subtype) => this.afterTurn(id, subtype),
        (delta) => {
          this.rollWindow(s);
          s.windowSpentUsd += delta;
        },
        this.extrasFor(s),
      );
      this.governors.set(id, g);
      g.start();
    }
    s.chat.push({ role: "you", text, at: Date.now() });
    s.state = "working";
    s.lastActiveAt = Date.now();
    this.emit(s);
    g.push(text);
  }

  /** True or false, or the value of one of the flag's own choices. */
  answerFlag(id: string, answer: boolean | string): void {
    this.governors.get(id)?.answerFlag(answer);
  }

  /**
   * Point a settlement at a different model.
   *
   * A live session changes in place — `setModel` works in streaming input mode,
   * so a governor mid-conversation just answers the next turn differently. One
   * that is dormant picks it up when it next wakes.
   */
  async setModel(id: string, model: string | null): Promise<void> {
    const s = this.settlements.get(id);
    if (!s) return;
    s.model = model;
    await this.governors.get(id)?.setModel(model ?? this.defaultModel());
    this.emit(s);
  }

  /**
   * Change how much a settlement asks before acting.
   *
   * Live sessions change in place. `bypassPermissions` needs a flag that can
   * only be given at spawn, so if the running session refuses the switch the
   * governor is reaped — the next thing you say respawns it with the right
   * options and the transcript intact.
   */
  async setPermissionMode(id: string, mode: PermissionModeValue | null): Promise<void> {
    const s = this.settlements.get(id);
    if (!s) return;
    s.permissionMode = mode;
    const effective = mode ?? this.defaultMode();
    const g = this.governors.get(id);
    if (g && !(await g.setPermissionMode(effective))) this.reap(id);
    this.emit(s);
  }

  private ceilingOf(s: Settlement): number {
    return s.maxBudgetUsd ?? this.maxBudgetUsd();
  }

  /**
   * A running governor was given its budget when it spawned, and the SDK has no
   * way to change it mid-session. So a changed ceiling, or a reset, retires the
   * governor once it is idle: the next thing you say respawns it with the new
   * amount and its transcript intact.
   */
  private budgetStale = new Set<string>();

  private retireForBudget(id: string): void {
    const g = this.governors.get(id);
    const s = this.settlements.get(id);
    if (!g || !s) return;
    if (s.state === "idle") this.reap(id);
    else this.budgetStale.add(id);
  }

  /** Called by a governor at the end of every turn. */
  private afterTurn(id: string, subtype: string): void {
    const s = this.settlements.get(id);
    if (!s) return;
    if (subtype === "error_max_budget_usd") {
      s.chat.push({ role: "system", text: overBudget(s, this.ceilingOf(s)), at: Date.now() });
      this.budgetStale.delete(id);
      this.reapIfStillIdle(id);
      return;
    }
    if (this.budgetStale.has(id) && s.state === "idle") {
      this.budgetStale.delete(id);
      this.reapIfStillIdle(id);
    }
  }

  /** Deferred, because this runs inside the governor's own pump; and only if
   *  nothing was said in between, or that message would go down with it. */
  private reapIfStillIdle(id: string): void {
    setTimeout(() => {
      if (this.settlements.get(id)?.state === "idle") this.reap(id);
    }, 0);
  }

  /** Null follows the realm default. */
  setBudget(id: string, usd: number | null): void {
    const s = this.settlements.get(id);
    if (!s) return;
    s.maxBudgetUsd = usd;
    this.retireForBudget(id);
    this.emit(s);
  }

  defaultBudgetChanged(): void {
    for (const id of [...this.governors.keys()]) {
      if (this.settlements.get(id)?.maxBudgetUsd === null) this.retireForBudget(id);
    }
  }

  /** Settlements following the realm default need telling when it changes. */
  async defaultModelChanged(): Promise<void> {
    for (const [id, g] of this.governors) {
      const s = this.settlements.get(id);
      if (s && s.model === null) await g.setModel(this.defaultModel());
    }
  }

  async defaultModeChanged(): Promise<void> {
    for (const [id, g] of [...this.governors]) {
      const s = this.settlements.get(id);
      if (s && s.permissionMode === null && !(await g.setPermissionMode(this.defaultMode()))) {
        this.reap(id);
      }
    }
  }

  async interrupt(id: string): Promise<void> {
    await this.governors.get(id)?.interrupt();
  }

  /** Reap: kill the process, keep the sessionId. The settlement goes dormant. */
  reap(id: string): void {
    this.budgetStale.delete(id);
    const g = this.governors.get(id);
    if (!g) return;
    g.stop();
    this.governors.delete(id);
    const s = this.settlements.get(id);
    if (s && s.state !== "needs_you") {
      s.state = s.sessionId ? "dormant" : "idle";
      s.flag = null;
      this.emit(s);
    }
  }

  razed(id: string): void {
    this.governors.get(id)?.stop();
    this.governors.delete(id);
  }

  stopAll(): void {
    for (const g of this.governors.values()) g.stop();
    this.governors.clear();
  }

  /** Settlements whose governor is alive but which have been quiet too long. */
  idleCandidates(now: number, minutesFor: (k: SettlementKind) => number): string[] {
    const out: string[] = [];
    for (const [id, _g] of this.governors) {
      const s = this.settlements.get(id);
      if (!s || s.state === "working" || s.state === "needs_you") continue;
      if (now - s.lastActiveAt > minutesFor(s.kind) * 60_000) out.push(id);
    }
    return out;
  }
}

function overBudget(s: Settlement, ceiling: number): string {
  const resets = s.windowResetsAt
    ? ` It starts again when your account's session resets, at ${new Date(s.windowResetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
    : "";
  return `Out of budget: $${s.windowSpentUsd.toFixed(2)} of its $${ceiling.toFixed(2)} ceiling is spent this session.` +
    `${resets} Or raise the ceiling in this settlement's details, then send your message again.`;
}

/**
 * What a session is given beyond the realm's defaults.
 *
 * The warden is the reason this exists: it is a Governor like any other, but
 * its world is the board rather than a folder of code, so it hands in its own
 * tools, its own system prompt, and its own way of putting a tool call into
 * one line for the flag.
 */
export type GovernorExtras = {
  /** Merged into the query's options, last. */
  options?: Partial<Options>;
  /** Overrides the default one-liner for a tool call. */
  summarise?: (toolName: string, input: unknown) => string;
  /**
   * More than two answers for this call, when allow-or-decline is the wrong
   * question. The warden's close flag is the one that has them.
   */
  choicesFor?: (toolName: string, input: unknown) => FlagChoice[] | undefined;
};

/**
 * One live session. Spawns lazily, resumes when it has a sessionId.
 *
 * Generic over what it is driving so the caller gets its own record back from
 * `emit` — a Settlement for the map, the Warden for the board.
 */
export class Governor<S extends Session = Session> {
  private q: Query | null = null;
  private input = createInputStream();
  private pending: ((r: PermissionResult) => void) | null = null;
  private stopped = false;
  /**
   * The last total the SDK reported. Its total_cost_usd covers the whole
   * conversation, resumes included, so a resumed session starts from what was
   * stored, and only the growth since then is new spend.
   */
  private lastTotal: number;

  constructor(
    private readonly s: S,
    private readonly emit: (s: S) => void,
    private readonly configDir: string | null,
    private readonly maxBudgetUsd: number,
    private model: string | null,
    private mode: PermissionModeValue,
    private readonly executable: string | undefined,
    private readonly onTurnEnd: (subtype: string) => void,
    private readonly onSpend: (deltaUsd: number) => void,
    private readonly extras: GovernorExtras = {},
  ) {
    this.lastTotal = s.sessionId ? s.costUsd : 0;
  }

  /** The one line the flag shows. Board tools need their own; see the warden. */
  private describe(toolName: string, input: unknown): string {
    return (this.extras.summarise ?? summarise)(toolName, input);
  }

  push(text: string): void {
    this.input.push(text);
  }

  /** The flag mechanic: only fires when permission falls through to a prompt. */
  private canUseTool: CanUseTool = async (toolName, input) => {
    try {
      const choices = this.extras.choicesFor?.(toolName, input);
      const flag: PendingFlag = {
        id: randomUUID(),
        toolName,
        input,
        summary: this.describe(toolName, input),
        raisedAt: Date.now(),
        ...(choices?.length ? { choices } : {}),
      };
      this.s.flag = flag;
      this.s.state = "needs_you";
      this.emit(this.s);

      const answer = await new Promise<PermissionResult>((resolve) => {
        this.pending = resolve;
      });

      this.s.flag = null;
      this.s.state = "working";
      this.emit(this.s);
      return answer;
    } catch (e) {
      // Trap 2: throwing here kills the session. Always degrade to a deny.
      return { behavior: "deny", message: `Threadlands could not raise the flag: ${String(e)}` };
    }
  };

  /**
   * Answer the raised flag: true or false, or the value of one of its choices.
   *
   * A value the flag never offered is not an answer, so it degrades to a
   * decline — anything else would leave the session parked on a promise that
   * never settles.
   */
  answerFlag(answer: boolean | string): void {
    const resolve = this.pending;
    if (!resolve) return;
    this.pending = null;
    const flag = this.s.flag;
    const chosen = typeof answer === "string" ? flag?.choices?.find((c) => c.value === answer) : undefined;
    const allow = chosen ? chosen.allow : answer === true;
    this.s.chat.push({
      role: "system",
      text: chosen
        ? `you chose "${chosen.label}": ${flag?.summary ?? "it"}`
        : `you ${allow ? "allowed" : "declined"}: ${flag?.summary ?? "it"}`,
      at: Date.now(),
    });
    resolve(
      allow
        ? { behavior: "allow", updatedInput: (flag?.input ?? {}) as Record<string, unknown> }
        : { behavior: "deny", message: chosen?.reply ?? "The settler declined this." },
    );
  }

  start(): void {
    this.q = query({
      prompt: this.input.stream,
      options: {
        cwd: this.s.cwd,
        ...(this.s.sessionId ? { resume: this.s.sessionId } : {}),
        canUseTool: this.canUseTool,
        permissionMode: this.mode,
        ...(this.executable ? { pathToClaudeCodeExecutable: this.executable } : {}),
        ...(this.mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        maxBudgetUsd: this.maxBudgetUsd,
        // Threadlands has no UI for the question tool yet: a question asked
        // with it goes nowhere. Governors ask in plain text instead.
        disallowedTools: ["AskUserQuestion"],
        ...(this.model ? { model: this.model } : {}),
        // Only override the config dir for a named profile. See realm.profileDir.
        ...(this.configDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: this.configDir } } : {}),
        includePartialMessages: false,
        // Last, so a session with a world of its own can replace any of these.
        ...(this.extras.options ?? {}),
      },
    }) as Query;

    void this.pump();
  }

  /** Trap 1: one iterator, .next() by hand, no break. */
  private async pump(): Promise<void> {
    const q = this.q;
    if (!q) return;
    const it = q[Symbol.asyncIterator]();
    try {
      for (;;) {
        const { value, done } = await it.next();
        if (done || this.stopped) return;
        this.ingest(value);
      }
    } catch (e) {
      if (this.stopped) return;
      this.s.state = "error";
      this.s.error = String((e as Error)?.message ?? e);
      this.s.chat.push({ role: "system", text: `the governor died: ${this.s.error}`, at: Date.now() });
      this.emit(this.s);
    }
  }

  private ingest(msg: SDKMessage): void {
    const s = this.s;
    switch (msg.type) {
      case "assistant": {
        const text = textOf(msg.message?.content);
        if (text) s.chat.push({ role: "governor", text, at: Date.now() });
        const calls = Array.isArray(msg.message?.content)
          ? msg.message.content.filter((b: any) => b?.type === "tool_use")
          : [];
        for (const c of calls as any[]) {
          s.chat.push({ role: "tool", text: this.describe(c.name, c.input), at: Date.now() });
        }
        s.lastActiveAt = Date.now();
        this.emit(s);
        break;
      }
      case "result": {
        // The session id is re-emitted every turn; the latest result is truth.
        s.sessionId = msg.session_id;
        if (typeof msg.total_cost_usd === "number") {
          this.onSpend(Math.max(0, msg.total_cost_usd - this.lastTotal));
          this.lastTotal = msg.total_cost_usd;
          s.costUsd = msg.total_cost_usd;
        }
        for (const u of Object.values(msg.modelUsage ?? {})) {
          const m = u as any;
          s.tokens.input += m.inputTokens ?? 0;
          s.tokens.output += m.outputTokens ?? 0;
          s.tokens.cacheRead += m.cacheReadInputTokens ?? 0;
          s.tokens.cacheWrite += m.cacheCreationInputTokens ?? 0;
        }
        if (msg.subtype !== "success" && msg.subtype !== "error_max_budget_usd") {
          s.chat.push({ role: "system", text: `turn ended: ${msg.subtype}`, at: Date.now() });
        }
        s.state = s.flag ? "needs_you" : "idle";
        s.lastActiveAt = Date.now();
        this.emit(s);
        this.onTurnEnd(msg.subtype);
        break;
      }
      case "system":
        if (msg.subtype === "init" && !s.sessionId) s.sessionId = msg.session_id;
        break;
      default:
        break;
    }
  }

  /** Returns false when the live session would not take the new mode. */
  async setPermissionMode(mode: PermissionModeValue): Promise<boolean> {
    this.mode = mode;
    if (!this.q) return true;
    try {
      await this.q.setPermissionMode(mode);
      return true;
    } catch {
      return false;
    }
  }

  async setModel(model: string | null): Promise<void> {
    this.model = model;
    try {
      await this.q?.setModel(model ?? undefined);
    } catch {
      // Not fatal: the next spawn passes it as an option anyway.
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt?.();
    } catch {
      /* already gone */
    }
  }

  stop(): void {
    this.stopped = true;
    this.pending?.({ behavior: "deny", message: "The settlement went dormant." });
    this.pending = null;
    this.input.close();
    // Trap 3: never await this.
    try {
      void (this.q as any)?.[Symbol.asyncIterator]?.()?.return?.(undefined);
      void this.q?.interrupt?.().catch?.(() => {});
    } catch {
      /* best effort */
    }
    this.q = null;
  }
}
