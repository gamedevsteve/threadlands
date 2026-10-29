/**
 * Threadlands — the cottage probe.
 *
 * Reads one account's remaining budget and reset times. Costs nothing: the
 * session boots, no prompt is ever sent, so no model call happens. ~500ms.
 *
 * The control method is explicitly experimental and its name WILL change. That
 * is why every caller goes through this one function.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AccountBudget, Meter } from "../shared/types.js";

const TIMEOUT_MS = 20_000;

function silentInput(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    await new Promise<void>(() => {});
  })();
}

export async function probeAccount(profileId: string, configDir: string | null): Promise<AccountBudget> {
  const base = { profileId, checkedAt: Date.now() };
  const q = query({
    prompt: silentInput(),
    options: {
      persistSession: false,
      // A null configDir means the ambient login; setting the variable at all
      // would make Claude Code miss the Keychain entry. See realm.profileDir.
      ...(configDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } } : {}),
    },
  }) as Query;

  const it = q[Symbol.asyncIterator]();
  // The reply never lands unless the stream is being drained concurrently.
  void (async () => {
    for (;;) {
      const { done } = await it.next();
      if (done) return;
    }
  })().catch(() => {});

  try {
    const u = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("usage probe timed out")), TIMEOUT_MS)),
    ]);

    const rl = (u.rate_limits ?? {}) as Record<string, any>;

    // Render the server's rows. It decides which meters exist, their labels,
    // order and severity — so a new meter needs no release here.
    const meters: Meter[] = Array.isArray(rl.limits)
      ? rl.limits.map((r: any): Meter => ({
          kind: r.kind,
          group: r.group,
          label:
            r.scope?.model?.display_name ??
            r.scope?.surface?.display_name ??
            (r.kind === "session" ? "Session" : r.kind === "weekly_all" ? "This week" : r.kind),
          percent: r.percent ?? 0,
          resetsAt: r.resets_at ?? null,
          severity: r.severity ?? "normal",
          isActive: r.is_active ?? false,
        }))
      : [];

    const breakdown = Array.isArray(rl.seven_day_breakdown?.rows)
      ? rl.seven_day_breakdown.rows
          .filter((r: any) => (r.percent ?? 0) > 0)
          .map((r: any) => ({ label: r.display_name as string, percent: r.percent as number }))
      : [];

    const sp = rl.spend;
    const credits =
      sp && typeof sp.used?.amount_minor === "number"
        ? {
            usedUsd: sp.used.amount_minor / 10 ** (sp.used.exponent ?? 2),
            limitUsd: sp.limit ? sp.limit.amount_minor / 10 ** (sp.limit.exponent ?? 2) : null,
            percent: sp.percent ?? 0,
            enabled: Boolean(sp.enabled),
          }
        : null;

    return {
      ...base,
      plan: u.subscription_type ?? null,
      planLimits: u.rate_limits_available,
      meters,
      breakdown,
      credits,
    };
  } catch (e) {
    return {
      ...base,
      plan: null,
      planLimits: false,
      meters: [],
      breakdown: [],
      credits: null,
      error: String((e as Error)?.message ?? e),
    };
  } finally {
    // Awaiting this hangs forever: the input generator never settles.
    void it.return?.(undefined);
  }
}
