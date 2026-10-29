/**
 * Threadlands — what models this account can use.
 *
 * Same trick as the budget probe: boot a session, send no prompt, ask, tear
 * down. No prompt means no model call, so the list costs nothing.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type ModelChoice = { value: string; label: string; description: string };

const TIMEOUT_MS = 20_000;

function silentInput(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    await new Promise<void>(() => {});
  })();
}

export async function listModels(
  configDir: string | null,
  executable?: string,
): Promise<ModelChoice[]> {
  const q = query({
    prompt: silentInput(),
    options: {
      persistSession: false,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
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
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("model list timed out")), TIMEOUT_MS)),
    ]);
    return models.map((m) => ({
      value: m.value,
      label: m.displayName || m.value,
      description: m.description ?? "",
    }));
  } catch {
    return [];
  } finally {
    // Awaiting this hangs: the input generator never settles.
    void it.return?.(undefined);
  }
}
