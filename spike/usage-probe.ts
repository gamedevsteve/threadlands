/**
 * Threadlands — the cottage probe.
 *
 * Answers "what has this account got left, and when does it reset?" without
 * spending a token: boot a session, send no prompt, ask the control channel for
 * the /usage data, kill it. ~500ms, $0.00.
 *
 * One profile per account — CLAUDE_CONFIG_DIR isolates credentials, so the Keep
 * runs this once per profile and the cottage panel renders the results.
 *
 * Run:  npm run usage
 *       CLAUDE_CONFIG_DIR=~/.threadlands/profiles/personal npm run usage
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const PROBE_TIMEOUT_MS = 20_000;

/** One row of the cottage panel, already shaped for the renderer. */
export type Meter = {
  /** The server's meter kind — 'session', 'weekly_all', 'weekly_scoped'. Classify on this, never on a label. */
  kind: string;
  group: string;
  label: string;
  percent: number;
  resetsAt: Date | null;
  severity: string;
  isActive: boolean;
};

export type AccountBudget = {
  profileId: string;
  /** 'pro' | 'max' | 'team' | 'enterprise', or null for an API-key / Bedrock / Vertex lane. */
  plan: string | null;
  /** False when plan windows don't apply — show cumulative dollars instead. */
  planLimits: boolean;
  meters: Meter[];
  /** Where the weekly window is going, by surface. */
  breakdown: { label: string; percent: number }[];
  /** Extra-usage credits, when the account has them switched on. */
  credits: { usedUsd: number; limitUsd: number | null; percent: number; enabled: boolean } | null;
  checkedAt: Date;
};

/** An input stream that never yields — the session boots, then waits. */
function silentInput(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    await new Promise<void>(() => {});
  })();
}

/**
 * Ask one account what it has left. Costs nothing: no prompt is ever sent, so
 * no model call happens. The control channel answers before `init` arrives.
 */
export async function probeAccount(profileId = "default"): Promise<AccountBudget> {
  const q = query({
    prompt: silentInput(),
    options: { cwd: process.cwd(), persistSession: false },
  }) as Query;

  // Hold ONE iterator and drain it. Never for-await with a break — that calls
  // .return() and kills the session out from under the control request.
  const it = q[Symbol.asyncIterator]();
  const drain = (async () => {
    for (;;) {
      const { done } = await it.next();
      if (done) return;
    }
  })();
  drain.catch(() => {});

  try {
    const u = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`usage probe timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
      ),
    ]);

    const rl = (u.rate_limits ?? {}) as Record<string, any>;

    // Prefer the server's limits[] rows: the server decides which meters exist,
    // their labels, order and severity, so a new meter needs no release here.
    const meters: Meter[] = Array.isArray(rl.limits)
      ? rl.limits.map((r: any): Meter => ({
          kind: r.kind,
          group: r.group,
          label:
            r.scope?.model?.display_name ??
            r.scope?.surface?.display_name ??
            (r.kind === "session" ? "Current session" : r.kind === "weekly_all" ? "This week" : r.kind),
          percent: r.percent ?? 0,
          resetsAt: r.resets_at ? new Date(r.resets_at) : null,
          severity: r.severity ?? "normal",
          isActive: r.is_active ?? false,
        }))
      : [];

    const breakdown: { label: string; percent: number }[] = Array.isArray(rl.seven_day_breakdown?.rows)
      ? rl.seven_day_breakdown.rows
          .filter((r: any) => (r.percent ?? 0) > 0)
          .map((r: any) => ({ label: r.display_name, percent: r.percent }))
      : [];

    const s = rl.spend;
    const credits =
      s && typeof s.used?.amount_minor === "number"
        ? {
            usedUsd: s.used.amount_minor / 10 ** (s.used.exponent ?? 2),
            limitUsd: s.limit ? s.limit.amount_minor / 10 ** (s.limit.exponent ?? 2) : null,
            percent: s.percent ?? 0,
            enabled: Boolean(s.enabled),
          }
        : null;

    return {
      profileId,
      plan: u.subscription_type ?? null,
      planLimits: u.rate_limits_available,
      meters,
      breakdown,
      credits,
      checkedAt: new Date(),
    };
  } finally {
    // Fire and forget. The input generator is parked on a promise that never
    // settles, so AWAITING the iterator's cleanup hangs the process forever.
    void it.return?.(undefined);
  }
}

// ── CLI rendering, roughly what the cottage panel shows ────────────────────────

function bar(pct: number, width = 24): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
}

function until(d: Date | null): string {
  if (!d) return "—";
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  if (mins < 0) return "now";
  const rel = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return `${d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} (${rel})`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const b = await probeAccount(process.env.CLAUDE_CONFIG_DIR ? "custom" : "default");

  console.log(`\n\x1b[1m── the cottage ${"─".repeat(48)}\x1b[0m`);
  console.log(`  plan      ${b.plan ?? "\x1b[2mno subscription on this lane — bills per token\x1b[0m"}`);

  if (!b.planLimits) {
    console.log("  limits    \x1b[2mnot applicable (API key, Bedrock, or Vertex) — track dollars instead\x1b[0m");
  } else {
    console.log("");
    for (const m of b.meters) {
      const colour = m.severity === "critical" ? "\x1b[31m" : m.severity === "warning" ? "\x1b[33m" : "\x1b[32m";
      const dot = m.isActive ? "\x1b[36m●\x1b[0m" : " ";
      console.log(
        `  ${dot} ${m.label.padEnd(18)} ${colour}${bar(m.percent)}\x1b[0m ${String(m.percent).padStart(3)}%   resets ${until(m.resetsAt)}`,
      );
    }
  }

  if (b.breakdown.length) {
    console.log("\n  \x1b[2mthis week went to:\x1b[0m " + b.breakdown.map((r) => `${r.label} ${r.percent}%`).join(" · "));
  }
  if (b.credits?.enabled) {
    console.log(`  \x1b[2mextra usage:\x1b[0m $${b.credits.usedUsd.toFixed(2)}${b.credits.limitUsd ? ` of $${b.credits.limitUsd.toFixed(2)}` : ""} (${b.credits.percent}%)`);
  }

  console.log(`\n  \x1b[2mprobed in ${Date.now() - t0}ms · cost $0.0000 · no prompt sent\x1b[0m`);
  console.log(`\x1b[1m${"─".repeat(62)}\x1b[0m\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("\x1b[31mprobe failed:\x1b[0m", e?.message ?? e);
    process.exit(1);
  },
);
