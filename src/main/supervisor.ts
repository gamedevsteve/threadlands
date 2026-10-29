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
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type {
  PendingFlag,
  PermissionModeValue,
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
function summarise(toolName: string, input: unknown): string {
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
  private governors = new Map<string, Governor>();

  constructor(
    private readonly settlements: Map<string, Settlement>,
    private readonly emit: (s: Settlement) => void,
    private readonly profileDir: (profileId: string) => string | null,
    private readonly maxBudgetUsd: () => number,
    private readonly defaultModel: () => string | null,
    private readonly defaultMode: () => PermissionModeValue,
    private readonly executable: string | undefined,
  ) {}

  /** Send a prompt, spawning or resuming the governor as needed. */
  async send(id: string, text: string): Promise<void> {
    const s = this.settlements.get(id);
    if (!s) throw new Error(`no settlement ${id}`);

    let g = this.governors.get(id);
    if (!g) {
      g = new Governor(
        s,
        this.emit,
        this.profileDir(s.profileId),
        this.maxBudgetUsd(),
        s.model ?? this.defaultModel(),
        s.permissionMode ?? this.defaultMode(),
        this.executable,
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

  answerFlag(id: string, allow: boolean): void {
    this.governors.get(id)?.answerFlag(allow);
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

/** One live session. Spawns lazily, resumes when it has a sessionId. */
class Governor {
  private q: Query | null = null;
  private input = createInputStream();
  private pending: ((r: PermissionResult) => void) | null = null;
  private stopped = false;

  constructor(
    private readonly s: Settlement,
    private readonly emit: (s: Settlement) => void,
    private readonly configDir: string | null,
    private readonly maxBudgetUsd: number,
    private model: string | null,
    private mode: PermissionModeValue,
    private readonly executable: string | undefined,
  ) {}

  push(text: string): void {
    this.input.push(text);
  }

  /** The flag mechanic: only fires when permission falls through to a prompt. */
  private canUseTool: CanUseTool = async (toolName, input) => {
    try {
      const flag: PendingFlag = {
        id: randomUUID(),
        toolName,
        input,
        summary: summarise(toolName, input),
        raisedAt: Date.now(),
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

  answerFlag(allow: boolean): void {
    const resolve = this.pending;
    if (!resolve) return;
    this.pending = null;
    this.s.chat.push({
      role: "system",
      text: allow ? `you allowed: ${this.s.flag?.summary ?? "it"}` : `you declined: ${this.s.flag?.summary ?? "it"}`,
      at: Date.now(),
    });
    resolve(
      allow
        ? { behavior: "allow", updatedInput: (this.s.flag?.input ?? {}) as Record<string, unknown> }
        : { behavior: "deny", message: "The settler declined this." },
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
        ...(this.model ? { model: this.model } : {}),
        // Only override the config dir for a named profile. See realm.profileDir.
        ...(this.configDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: this.configDir } } : {}),
        includePartialMessages: false,
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
          s.chat.push({ role: "tool", text: summarise(c.name, c.input), at: Date.now() });
        }
        s.lastActiveAt = Date.now();
        this.emit(s);
        break;
      }
      case "result": {
        // The session id is re-emitted every turn; the latest result is truth.
        s.sessionId = msg.session_id;
        s.costUsd = msg.total_cost_usd ?? s.costUsd;
        for (const u of Object.values(msg.modelUsage ?? {})) {
          const m = u as any;
          s.tokens.input += m.inputTokens ?? 0;
          s.tokens.output += m.outputTokens ?? 0;
          s.tokens.cacheRead += m.cacheReadInputTokens ?? 0;
          s.tokens.cacheWrite += m.cacheCreationInputTokens ?? 0;
        }
        if (msg.subtype !== "success") {
          s.chat.push({ role: "system", text: `turn ended: ${msg.subtype}`, at: Date.now() });
        }
        s.state = s.flag ? "needs_you" : "idle";
        s.lastActiveAt = Date.now();
        this.emit(s);
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
