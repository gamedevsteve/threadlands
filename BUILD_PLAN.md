# Threadlands — Build Plan

A hex map of running Claude Code sessions. Camps for errands, cities for campaigns,
libraries held read-only, and a post office where messengers wait on you.

| | |
|---|---|
| **Stack** | Electron · TypeScript |
| **Spine** | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) |
| **Spike** | Half a day — Phase 0, and the only thing that can sink this |
| **Daily driver** | Phases 0–4, ~3 weeks of evenings |
| **Full realm** | Phases 5–6, open-ended |

---

## 1. The premise

You run too many Claude sessions at once, they blur together, and you keep terminals
open on the big ones because closing one feels like losing the thread. Threadlands
replaces the terminal as the *place* a session lives. The terminal becomes something
you open deliberately, not something you hoard.

> **The load-bearing fact:** a session's history lives on disk, not in the process.
> `listSessions()` enumerates them, `getSessionMessages()` reads a transcript without
> starting anything, and `resume: sessionId` picks up exactly where you stopped.
>
> So a city does not need a live process to hold its place. Threadlands can reap every
> idle session and respawn on click, and the illusion is seamless. Twelve open terminals
> become twelve tiles and close to zero running processes.

That reframes the core distinction. **Camp versus city is a retention policy, not a
process lifetime.** A camp is an errand: short allowlist, history discarded when you
raze it. A city is a campaign: keeps its transcript indefinitely, earns a wider
allowlist as you trust it, survives app restarts and gets resumed a month later by
clicking its tile.

A third kind arrived once the first two were settled. A **library** is shared code that many
settlements read and exactly one may write. Everything in §5 — fenced borders, walls, trade
routes, messengers — exists to make that single rule liveable rather than merely strict.

Two tiles are not settlements at all. The **cottage** holds realm-wide defaults and the agent
rules every settlement inherits; the **post** is where messengers wait until you read and
forward them. Neither runs an agent.

---

## 2. Architecture

Two processes, one rule: **the renderer never touches the SDK.**

The Agent SDK is a Node library. In Electron it runs in the main process alongside the
window, with no bridge and no sidecar — which is the entire reason to pick Electron over
Tauri here. Tauri would mean shelling out to a Node subprocess for the one thing the app
exists to do.

**Main process — the Keep.** Owns every live session, the supervisor that spawns and
reaps them, the permission queue, and the realm file on disk. It is the only code that
imports the Agent SDK.

**Renderer — the Map.** Draws the grid, the sprites, the flags and the governor panel.
Holds no session state of its own. Receives settlement snapshots and transcript deltas
over IPC, and sends back four kinds of intent: found, speak, answer, raze.

```ts
// preload-exposed surface — the whole contract
interface Threadlands {
  foundSettlement(spec: FoundSpec): Promise<Settlement>;
  speak(settlementId: string, text: string): Promise<void>;
  answerPrompt(requestId: string, verdict: Verdict): Promise<void>;
  raze(settlementId: string): Promise<void>;
  openTerminal(settlementId: string): Promise<void>;
  interrupt(settlementId: string): Promise<void>;

  onSettlementChanged(cb: (s: Settlement) => void): Unsubscribe;
  onTranscriptDelta(cb: (d: TranscriptDelta) => void): Unsubscribe;
}
```

Keep this list short. Every method added here is a thing the renderer can get wrong.

---

## 3. Domain model

```ts
type SettlementKind = "camp" | "city" | "library";

interface Settlement {
  id: string;                      // Threadlands id — stable forever
  kind: SettlementKind;
  name: string;                    // "Leafspring", "SEO Planner"
  hex: { q: number; r: number };   // axial coords, flat-top
  cwd: string;                     // the folder it was instanced in
  driver: "claude";                // see §4, Provider seam
  profileId: string;               // which account — see §4, Accounts
  workers: Worker[];               // one or more sessions; [0] is the governor
  grants: Grant[];                 // what it may reach — see §5, Scope
  allowedTools: string[];          // the city's walls — see §5, Walls
  spend: { usd: number; turns: number };
  foundedAt: number;
}

interface Grant {
  path: string;
  mode: "read" | "readwrite";      // a route to a library is always "read"
  settlementId: string | null;     // set when path is another settlement's cwd
}

// Fixtures are tiles with no cwd, no session and no governor. Keeping them out of
// Settlement is what stops every session field becoming nullable for two special cases.
type Fixture =
  | { kind: "cottage"; hex: Hex; defaults: RealmDefaults; budgets: AccountBudget[] }
  | { kind: "post";    hex: Hex };

interface RealmDefaults {
  permissionMode: PermissionMode;
  allowedTools: string[];
  budgetUsd: Record<SettlementKind, number>;
  idleTimeoutMs: Record<SettlementKind, number>;
  agentRules: string;              // seeded as CLAUDE.md into each profile
}

interface Dispatch {
  id: string;
  from: string;                    // settlement id
  to: string;                      // settlement id
  finding: string;                 // what is wrong, and how it is known
  evidence: string;                // failing case, file:line, repro
  ref: string | null;              // git rev of `from` at dispatch time
  state: "at_post" | "delivered" | "accepted" | "declined" | "implemented";
  createdAt: number;
}

interface Worker {
  id: string;
  sessionId: string | null;        // Agent SDK session; null before first run
  label: string;                   // "governor", or what you named the fork
  state: SettlementState;
  pending: PermissionRequest | null;
  lastActivity: number;
}

type SettlementState =
  | "dormant"    // no process. resumable from sessionId.
  | "working"    // process live, agent mid-turn
  | "needs_you"  // FLAG UP — permission prompt or a question
  | "idle"       // turn complete, process warm, waiting on you
  | "error";
```

State lives on the **worker**, not the settlement. A settlement's displayed state is the
most urgent state among its workers — `needs_you` beats `working` beats `idle` — so one
blocked fork raises the banner on the whole tile.

Two settlements may share a `cwd`. That is the supported way to run unrelated threads on
one repo; workers are for threads that belong together.

A **library** is a settlement that other settlements depend on: shared code you want read
widely and written in exactly one place. Its only structural difference is a rule Threadlands
enforces when routes are drawn, in §5.

| State | On the map | Reapable |
|---|---|---|
| `dormant` | Sprite dimmed, no smoke | Already reaped |
| `working` | Chimney smoke animating | No |
| `needs_you` | Banner raised, tile pulses | Never |
| `idle` | Lanterns lit | After the idle timeout |
| `error` | Banner at half-mast | On acknowledgement |

Persist the realm to Electron's `app.getPath("userData")` — `~/Library/Application Support/`
on macOS, `%APPDATA%` on Windows. Never hard-code either; see §12. It holds
settlements only — **never transcripts**, which already live in `~/.claude/projects/` and
are read through the SDK. Two sources of truth for history would be the first thing to rot.

---

## 4. Session mechanics

Everything else is ordinary app work. These are the ones to get right first.

### Talking to a running session

Passing a string to `query()` gives a one-shot turn. To chat, the prompt must be an
`AsyncIterable` that stays open — so you need a push-driven queue. This is the least
obvious piece of the SDK and it belongs in a utility written once.

```ts
function createInputStream() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;

  const push = (m: SDKUserMessage) => { queue.push(m); wake?.(); wake = null; };

  const stream = (async function* () {
    while (true) {
      if (!queue.length) await new Promise<void>(r => { wake = r; });
      while (queue.length) yield queue.shift()!;
    }
  })();

  return { stream, push };
}
```

The governor's ear. Hold `push` on the LiveSession; every chat message from the panel
calls it.

### Raising the flag

`canUseTool` fires **only** when the permission flow falls through to a prompt — not for
calls auto-approved by `allowedTools` or `permissionMode`. That is precisely the "it
needs me" moment, handed to you as an awaitable. You do not detect anything; you just
hold the promise.

```ts
const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
  const req = { id: randomUUID(), settlementId, toolName, input };

  supervisor.setState(settlementId, "needs_you", req);   // flag up
  ipc.send("settlement-changed", snapshot(settlementId));

  return await supervisor.awaitVerdict(req.id, signal);
  //  -> { behavior: "allow", updatedInput: input }
  //  -> { behavior: "deny",  message: "Not that folder." }
};
```

Three consequences worth designing around. The promise can sit unresolved for hours, so
persist enough of the request to show it after an app restart and resolve stale ones as
denied. `signal` aborts — wire it so a razed settlement doesn't leak a pending resolver.

And **this callback must never throw.** An exception inside it takes the whole session down,
not just the one tool call. Wrap the body and degrade to a deny on any failure. Also confirmed
in the spike, where a broken prompt killed a healthy session.

### Reaping and resuming

The supervisor keeps a `Map<settlementId, LiveSession>`. A sweep every 30 seconds closes
any session that has been `idle` past its timeout — short for camps, generous for cities —
calling `q.close()` and keeping only the `sessionId`. Clicking a dormant tile spawns a new
query with `resume` set, and the transcript is already there.

```ts
const q = query({
  prompt: input.stream,
  options: {
    cwd: s.cwd,
    sessionId: s.sessionId ?? undefined,     // first run: let it generate
    resume:    s.sessionId ?? undefined,     // later runs: pick up the thread
    persistSession: true,
    canUseTool,
    allowedTools: s.allowedTools,
    settingSources: ["user", "project"],     // inherit your CLAUDE.md files
    maxBudgetUsd: s.kind === "camp" ? 2 : 15,
    includePartialMessages: true,            // token-by-token in the panel
  },
});

// Hold ONE iterator for the life of the session and pull from it by hand.
const it = q[Symbol.asyncIterator]();
for (;;) {
  const { value, done } = await it.next();
  if (done) break;
  supervisor.ingest(s.id, value);
}
```

One loop per settlement. `ingest` is the only place SDK message types are translated into
Threadlands events.

**Do not write that loop as `for await (const msg of q) { ... break }`.** Exiting a `for await`
early calls `.return()` on the iterator, which closes the Query and ends the session. Anything
that consumes a turn at a time — which the supervisor does — must hold a single long-lived
iterator and call `.next()` itself. Confirmed in the Phase 0 spike, where it silently killed
the session after the first turn and looked like an SDK fault.

The `init` system message is re-emitted on later turns with the same id, so treat it as
informational and take the session id from the most recent `result`.

### Accounts

Each account is a **profile directory**, selected per settlement through the SDK's `env`
option:

```ts
env: { CLAUDE_CONFIG_DIR: `${REALM}/profiles/${s.profileId}` }
```

Log each profile in once, by hand, from a terminal — `CLAUDE_CONFIG_DIR=... claude`.
Threadlands never handles credentials itself, which is the only version of this worth
building.

`CLAUDE_CONFIG_DIR` relocates settings, plugins **and session history**. Three consequences:

- There is no single session store. `listSessions({ dir })` runs once per profile, and the
  realm keeps a session index per profile.
- A settlement cannot change profile after founding without abandoning its transcript.
  Make the founding dialog say so.
- A fresh profile has none of your `~/.claude/settings.json` or user-level `CLAUDE.md`.
  Seed each profile on creation, or symlink the files you want shared.

Profile is also the banner. Work cities fly one crest, personal another, legible at map zoom.

Profile isolation is **verified**. A fresh `CLAUDE_CONFIG_DIR` does *not* inherit the macOS
Keychain login: it reports `subscription_type: null`, `rate_limits_available: false`. Profiles
are genuinely separate accounts, and the directory gets its own `.claude.json`, `sessions/`
and `backups/`. The probe below is how you read each one.

### The cottage panel: what each account has left

Verified working. The `Query` object carries a control method that returns the structured data
behind `/usage` — plan, window utilisation, reset timestamps — and it is **free and fast**:
boot a session, never send a prompt, ask, tear down. Measured at **490ms and $0.0000**, because
no prompt means no model call. `spike/usage-probe.ts` is the working implementation.

```ts
const q = query({ prompt: silentInput(), options: { persistSession: false } }) as Query;
// drain the stream in the background, then:
const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
  skipBehaviors: true,   // skips a 7-day transcript scan; for a usage meter, always pass this
});
```

Three mechanics that are not obvious:

- **No prompt is needed, and no `init` either.** The control channel answers in ~500ms, before
  any `system/init` arrives. The probe must still drain the message stream concurrently or the
  reply never lands.
- **Teardown must be fire-and-forget.** `await it.return()` hangs forever, because the silent
  input generator is parked on a promise that never settles. `void it.return?.()`. This is the
  third variant of the same iterator-lifecycle trap as §4's `break` bug — the Query's iterator
  protocol is where this project's sharp edges live.
- **The method name is a warning label.** It is explicitly experimental and the name *will*
  change. Wrap it in exactly one adapter — `probeAccount()` — so a rename is a one-line fix.

**Render the server's rows, never your own.** The response carries a `limits[]` array whose rows
are the server's: `kind` ('session', 'weekly_all', 'weekly_scoped'), `group`, `percent`,
`resets_at`, `severity` ('normal' | 'warning' | 'critical'), `is_active`, and an optional `scope`
naming a model or surface. Classify on `kind`, colour on the server's `severity`, and order as
sent. Alongside `limits[]` sit ~30 named keys, most null — several are unreleased meters with
codename keys. Hardcoding `five_hour` / `seven_day` means the panel silently goes stale the week
a new meter ships; reading `limits[]` means it doesn't.

Also worth surfacing on the panel:

- `seven_day_breakdown.rows` — where the weekly window went, by surface (Claude Code / Chats /
  Cowork / Other). On a Threadlands realm this will read ~100% Claude Code, which is the point:
  it tells you Threadlands *is* your usage.
- `spend` — extra-usage credits in real money (`amount_minor` + `exponent`, so divide), with
  `enabled` and `percent`. Only meaningful once credits are switched on.
- `rate_limits_available: false` — an API-key or Bedrock/Vertex profile has no windows at all.
  That panel shows cumulative dollars from `total_cost_usd` instead. The two profile kinds need
  two different cottage rows, and only the API-key kind is a real bill.

**There is no token count.** Plan limits come back as percentages and reset timestamps, not
"412,000 tokens left" — Anthropic does not publish a token balance for subscription plans, so
the cottage cannot show one. The honest panel reads *"session 43%, resets 8:50 PM · week 28%,
resets Fri"*. Per-settlement token counts are a separate thing and do exist: `modelUsage` on each
`result` message gives exact input/output/cache tokens per model, which is how a settlement's own
meter gets filled.

**Poll, don't stream — but listen too.** There is also a push surface: a `rate_limit_event`
message (`SDKRateLimitInfo` — `status`, `utilization`, `resetsAt`, `rateLimitType`, plus overage
fields) arrives on a working session's stream when its limits change. Use both: the Keep polls
each profile on a timer for the cottage panel, and promotes a `status: 'rejected'` or
`'allowed_warning'` event from any settlement straight to the map, since that is the moment a
settlement is about to stall. A rejected status with `rateLimitType: 'seven_day'` should visibly
freeze every settlement on that profile — they are all about to fail.

### The provider seam

The Agent SDK is Claude-specific and the provider SDKs do not compose. But §2's rule — the
renderer never touches the SDK — already gives you most of a seam. Formalise it in Phase 1
as a `SettlementDriver` interface with `ClaudeDriver` as the only implementation.

Design that interface for what the renderer needs, not for a provider you haven't adopted;
designing it *for* ChatGPT before you have ChatGPT means guessing wrong. Expect capability
flags rather than a lowest common denominator — `canUseTool` has no equivalent elsewhere, so
a writing settlement would be a chat tile with no flag mechanic and no file access. For
writing, that may be exactly right.

---

## 5. Territory

What a settlement may reach, what it may not, and how work crosses between them without
anybody's walls coming down.

### Folder scope and trade routes

`cwd` does **not** confine anything on its own — Bash can `cd` out and the file tools take
absolute paths. Real confinement is two settings, applied per settlement:

```ts
settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
additionalDirectories: s.grants,   // SDK passes each as --add-dir
```

The first makes the file tools refuse paths outside the working directories in **every**
permission mode. The second is the grant list.

Two things to know before relying on it. Granting a folder grants more than file access:
`--add-dir` directories also load skills, commands and subagents from that folder under the
`project` setting source. And Bash is the leak — a settlement with a blanket `Bash` entry
in `allowedTools` can `cat` its way out, so keep Bash rules path-scoped on anything fenced.

**Trade routes** then fall out for free. When a grant in `s.grants` matches another
settlement's `cwd`, draw a road between the two hexes. The overlay visualises real
permission state rather than invented game state, which is what makes it worth drawing. It
is also directional: A reading B is not B reading A, so the road wants an arrow.

### Walls: keeping other settlements out

A folder **cannot defend itself**. Permissions are per-session, never ambient: when a session
reaches into a folder through `--add-dir`, that folder's `.claude/settings.json` contributes
only `enabledPlugins` and `extraKnownMarketplaces`. Its permission rules are not read. A
`deny` rule sitting inside a library is ignored by every project that reaches into it.

The default also cuts the wrong way — with the sandbox on, writes are permitted in the
working directory, temp, **and added directories**, so granting a library makes it writable.

So the wall is written into the **consumer's** config, which is fine, because Threadlands
writes every session's config. A library declares a policy; the hub compiles that policy into
each consumer when the route is created. Centrally auditable, re-appliable when the policy
changes, and visible on the map.

It takes two layers, because the tools split:

```ts
settings: {
  permissions: { deny: [`Edit(//${lib.cwd}/**)`, `Write(//${lib.cwd}/**)`] },
  sandbox: { enabled: true, filesystem: { denyWrite: [lib.cwd] } },
}
```

Permission rules cover Read, Edit and Write. The sandbox covers Bash, PowerShell and Monitor
commands and the processes they start — and **nothing else**; `denyRead` does not restrain
the Read tool. You need both, and the sandbox half is what finally closes the hole where a
blanket `Bash` entry lets a fenced settlement `cat` its way out.

Footgun: the two layers spell paths differently. Permission rules take `//absolute` and
`/project-relative`; sandbox paths are plain absolute or `~`-relative. Same folder, two
spellings, one settings object.

Pass the whole block through the SDK's `settings` option, the same shape `--settings` takes.
Confirm that during the Phase 0 spike before anything else depends on it.

### Libraries

A library's routes are **read-only by construction**. Threadlands refuses to create a writable
route into a library. To change one, you work in its own settlement — the single place writes
are allowed. You visit a city to trade; you don't rebuild it.

Most consumers need no route at all: an installed dependency sits in `node_modules` inside the
consumer's own folder and is already readable. A route is for reading the library's *source*,
which is exactly the case where an agent is most tempted to edit it.

Because routes are data, a library knows its own dependents. Open it and the map shows every
road leading out; begin editing and Threadlands can say how many settlements depend on what
you are about to change. That is the instrument for the thing that makes shared code
frightening, and it costs nothing beyond the overlay.

This stops an agent's enthusiasm, not an attacker. The sandbox is real OS-level enforcement
and deny rules hold, but a determined process has other paths. For your own agents on your own
machine, mistakes rather than malice, that is the right amount of wall.

### Messengers

A read-only library raises an obvious problem: a project finds a real bug in shared code and
can do nothing about it. A messenger is the answer, and it is deliberately **not** settlements
talking to each other. Both ends only ever talk to the hub, and a human sits in the middle:

```
drafted -> at_post -> delivered -> accepted | declined | implemented
```

Every settlement gets a `send_messenger` tool from an in-process MCP server the hub owns:

```ts
const sendMessenger = tool(
  "send_messenger",
  "Send findings to another settlement. Use when you have found a problem in code " +
  "you can read but may not edit. Describe the problem and the evidence — do not write a fix.",
  {
    to:       z.string().describe("Settlement name, e.g. hmcore"),
    finding:  z.string().describe("What is wrong, and how you know"),
    evidence: z.string().describe("Failing case, file:line, repro steps"),
  },
  async (args) => { /* write the Dispatch, return "messenger waiting at the post" */ },
);
```

**The post is the gate.** The tool writes the record and returns immediately — the sender
carries on working rather than freezing while a dispatch waits on you, which is what would
happen if the call blocked in `canUseTool` instead. The dispatch sits at the post until you
read it and forward it.

That makes a send-time permission gate redundant, and leaving it out costs one fewer
interruption per dispatch. It is also the sturdier arrangement: holding the call open would
rest on SDK permission semantics, whereas the post rests on nothing — Threadlands is the only
transport a dispatch has, so it cannot reach anyone until you click forward.

The cost of no send-time gate is that an enthusiastic settlement can queue several dispatches
at once. They pile up at the post and you bin them, so rate-limiting in the handler is a
convenience rather than a safeguard.

Delivery needs no new mechanism. On forward, the hub pushes the dispatch into the recipient's
input stream as a user message, through the same `push()` from the start of this section.

**A proposal, not a patch** — enforced in the tool description above. The sender doesn't know
the recipient's conventions, its current state, or what else depends on the line it wants to
change, so a diff from it is a guess. Send the failing case; let the recipient's own governor
write the fix with full context, in the one settlement where writes are allowed. The wall
never has to open.

Keep it to one message type in one direction. A general channel between settlements is the
agent-to-agent tar pit wearing a hat, and it is on the §12 list for good reason.

**The post is where they wait.** Its tile carries a count, legible from across the map, so
pending work has a place rather than a badge buried in a panel. Dispatch history lives there
too: what a settlement has sent and received, in one list.

The cottage is a different thing entirely — realm settings. Default permission mode, budget
caps, idle timeouts, and the agent rules seeded into every profile as `CLAUDE.md`. Rules change
monthly and dispatches arrive daily, so the two do not belong on one tile. Clicking it also opens the
budget panel — every profile's windows, utilisation and reset times, polled live (§4). That is
the one screen that answers "can I start another city right now?".

A **postmaster** — an agent triaging the queue for you — is the obvious next thought and is on
the §12 list. The point of the gate is that *you* read the finding; an agent that summarises
puts a judgement between you and the thing you asked to review. If volume ever demands one,
have it group and label, never collapse the finding itself.


---

## 6. Metaphor to API

| Threadlands | Agent SDK |
|---|---|
| Found a camp or city | `query({ prompt: stream, options: { cwd } })` |
| Talk to the governor | streaming input mode · `streamInput()` |
| Banner raised — needs input | `canUseTool` callback |
| Banner raised — work finished | `SDKResultMessage` |
| Background task reports in | `SDKTaskNotificationMessage` |
| Revisit a dormant settlement | `resume` · `getSessionMessages()` |
| Send out settlers | `forkSession(id, { upToMessageId })` |
| Recall the governor | `interrupt()` |
| City walls (trust level) | `allowedTools` · `permissionMode` |
| Fenced borders | `permissions.blockReadsOutsideWorkingDirectories` |
| City walls against outsiders | `permissions.deny` + `sandbox.filesystem.denyWrite`, written into each consumer |
| A library's holdings | a settlement every route reaches read-only |
| Send a messenger | `send_messenger`, an SDK MCP tool the hub provides |
| The messenger waits at the post | a `Dispatch` the hub holds until you forward it |
| The messenger is received | hub pushes the dispatch into the recipient's input stream |
| Trade route to another settlement | `additionalDirectories` entry matching its `cwd` |
| Which crest it flies | `env.CLAUDE_CONFIG_DIR` — the account profile |
| Workers outside the walls | several sessions under one settlement |
| Tribute cap | `maxBudgetUsd` |
| Survey the realm on launch | `listSessions({ dir })` |
| Ride out to the site | `open -a Terminal <cwd>` |

**City walls are the mechanic to lean on.** Because `canUseTool` is skipped for anything
on `allowedTools`, trust is literally how often a settlement interrupts you. A new camp
flags on everything. A city you've worked in for weeks has `Read`, `Grep`, `Glob` and
scoped `Bash` on its allowlist and only raises a banner for writes outside its folder.
Promoting a camp to a city should widen the walls — that is a real mechanic, not
decoration, and it directly reduces interruptions.

---

## 7. Phases

### Where this stands

Phases 0–2 are built and running. Phase 3 is most of the way there; 4 is partly done; 5 and 6
are untouched.

| | | |
|---|---|---|
| **Phase 0** — the spike | ✅ done | 6/6 checks, on a live session |
| **Phase 1** — the Keep | 🟡 core built | supervisor, realm, IPC, reaper. No grants, routes, workers or driver seam |
| **Phase 2** — the map | ✅ done | grid, camera, founding, moving, ground, name plates |
| **Phase 3** — the governor's hall | 🟡 most of it | transcript, collapsible tool runs, permission card, Open Terminal. No diffs, no *Allow always*, no workers |
| **Phase 4** — a living realm | 🟡 partly | dormant dimming, spend and tokens per settlement, editable cottage. No notifications, no tile animation, no routes, no `listSessions` import |
| **Phase 5** — settlers and walls | ⬜ not started | |
| **Phase 6** — messengers | ⬜ not started | |

Built along the way, and not in the original plan:

- Permission modes per settlement — ask / auto / accept edits / plan / never ask — cycled with
  Shift+Tab over a realm default. This is most of what *Allow always* was for.
- A model per settlement over a realm default, switchable **mid-conversation**.
- Drag a settlement to another hex.
- A base folder for founding, so the browser opens where the work is.
- Markdown rendering, escaped before parsing; links open in the system browser.
- Window chrome: a draggable top bar that zooms, a resizable panel, Enter to send.
- The parchment panel, Libre Baskerville, the name plates, the app icon, and
  `npm run package` for a real .app.
- A render loop that only draws when something changed, and a cached ground. See
  *Keeping the map cheap*.

**The honest gap:** everything about §5 — walls, grants, routes, libraries — is still just
this document. A settlement is scoped to its folder by `cwd` and nothing stops it reading
outside. That is the next real piece of work, and the one the metaphor most depends on.



Each phase ends at something runnable. The order is chosen so the riskiest unknown dies first.

### Phase 0 — The spike · half a day

No UI, no Electron, no hexes. One TypeScript file run with `tsx`. Spawn a session in a
folder, send a prompt from stdin, print messages as they stream, trigger a permission
prompt and answer it from the keyboard. Then kill the process, re-run with `resume`, and
ask it what you were just doing.

This is the whole bet. If the loop works here, everything after it is application code you
already know how to write.

**Gate:** the resumed session remembers the first conversation.

**Status: passed.** `spike/phase0.ts`, six of six checks — spawned in a given cwd, raised the
flag on a Write, wrote the file, captured the session id, was killed, and the resumed session
recalled both the file and the conversation. Run it with `npm run spike` to answer the flag
yourself, or `npm run spike -- --yes` to auto-approve. Roughly $0.28 a run on Opus, which is a
useful first data point for §11.

The walls stage (`--walls`) is written but unverified; it is the sandbox check §5 asks for.

A seventh thing fell out of the same spike: `spike/usage-probe.ts` (`npm run usage`) reads any
account's remaining budget and reset times in ~490ms for $0.00. See §4's cottage-panel notes.
It also proved profile isolation works, which §4's Accounts section had only assumed.

### Phase 1 — The Keep · 3–4 evenings

Electron shell. The supervisor, the realm store, the IPC contract. Drive it from a plain
HTML list — settlement name, state, a text box, an answer button. Deliberately ugly.

Build the idle reaper **here**, not later. Reaping is what makes the model honest, and
bolting it on after the UI exists means retrofitting every assumption about a session
being alive.

Four things belong in this phase precisely because they are cheap now and structural later:
the **many-workers** model (render one, support many), **profiles**, the **grant list** with
fenced borders on by default, and the **driver interface**. None of them need UI yet.

The route compiler belongs here too: one function from a settlement's `grants` to the
`permissions` and `sandbox` block its sessions launch with. Everything about walls is that one
function, so it is worth a test rather than a UI.

Attach an empty in-process MCP server to every settlement while you are here. It costs nothing
now and it is the seam every hub-provided tool arrives through later, messengers included.

**Gate:** three settlements working at once across two accounts, one flagging for permission,
one reaped and resumed, one fenced settlement refusing a read outside its folder, and a
consumer that can read a library but is refused when it tries to edit it — by the file tools
and through Bash. State survives an app restart.

**Status: core built.** `src/main/` is the Keep — `supervisor.ts` (one `Governor` per
settlement, all three iterator traps handled), `realm.ts` (a JSON realm in `userData`, chat
capped on disk because the SDK's own history is the real archive), `usage.ts` (the budget
probe), and `main.ts` (IPC, the 30-second idle reaper, the terminal opener). The renderer never
imports the SDK; `src/shared/types.ts` is the whole contract.

Still open from this phase's gate: multiple accounts in anger, the grant list and route
compiler, the many-workers model, the driver interface, and the empty MCP server. Those are
§5's walls and §4's provider seam — deliberately not built yet, because nothing above them
exists to constrain them.

**A found that cost an hour:** setting `CLAUDE_CONFIG_DIR` *at all* — even to the real
`~/.claude` — makes Claude Code miss its Keychain entry on macOS, and the session comes up
`Not logged in · Please run /login` with zero tokens spent. The default profile must leave the
variable unset entirely. §4's Accounts snippet showed the override unconditionally; it is
wrong for the default profile and `realm.profileDir()` now returns `null` for it. Profiles
other than default are unaffected, which is why the isolation test still passed.

### Phase 2 — The map · 3–4 evenings

Canvas 2D. Axial hex grid, flat-top. Pan, zoom, click-to-hex. The cottage pinned at the
origin. Click an empty hex to found a settlement: pick a folder, name it, choose camp or city.

Sprites draw at roughly twice the hex width, anchored bottom-centre so they overhang upward
and sideways. Sort by row then column and paint back to front; the overlap reads as depth.
Downscale the source art to around 512px before shipping it — 1254px at 2.8MB each is ten
times what the screen needs and it adds up fast across a populated map.

State is a **sprite swap**, not an overlay: one image per `kind` × `state`, so the renderer
stays a single `drawImage`. Minimum set is camp and city × calm and needs-you, plus the
cottage; `dormant` can be a canvas filter rather than its own art. Worker count shows as a
small tally on the tile — tents pitched outside the walls — rather than as separate
clickable sprites, which are fiddly at map zoom and collide with real settlements on
neighbouring hexes.

**Status: built.** `src/renderer/` — `hex.ts` (flat-top axial, cube rounding, spiral) and
`renderer.ts` (grid, pan, zoom, click-to-hex, founding, the chat panel, the flag, the cottage
budget panel). Three corrections to what this section assumed:

- **The art had no alpha at all.** The source PNGs are opaque with white backgrounds, so every
  sprite drew as a white box and the white hex corners painted over their neighbours, which
  read as gaps in the grid. `tools/prep_assets.py` (`npm run assets`) flood-fills the
  background from the border — so white *inside* the art survives — then crops to content and
  downscales. Do not feather the cut edge: a hard alpha ring haloes where tiles overlap, and
  the LANCZOS downscale already antialiases it.
- **The ground is one tileable texture with patch sprites scattered over it.** Variants are
  baked as transparent, soft-edged blobs in a range of sizes, not as versions of the ground
  tile, and placed on a jittered scatter unrelated to the texture lattice. Three earlier
  attempts each failed on the same point and are worth not repeating: baking variants *into*
  tiles confines every patch to exactly one cell, so patches are all one size and can never
  join; one mask per variant makes every instance of it the identical blob; and clustering with
  smooth value noise segregates the variants into regions *and* skews their frequencies, since
  value noise bunches around the middle. Free-standing sprites solve all three — size varies,
  patches overlap and merge, and different variants mingle.
- **The grid is not drawn at all any more.** Per-hex tile sprites were replaced by one tileable
  ground texture, repeated in world space and clipped to the union of every hex in the realm,
  with only the hovered hex outlined. That union is cached as a `Path2D` and reused across
  zoom steps. Do not *stroke* that path to get a shoreline — it strokes every subpath in it,
  which draws back the whole lattice you just removed. A blurred fill of the same path, offset
  downward before the clip, gives the island its edge instead.
- Were the grid ever drawn as tiles again: draw each at the true hex footprint, `2s × √3s`,
  not at the art's own aspect. The supplied art is within ~3% of a regular hex, and forcing the
  geometry is what makes it tessellate.
- **Sprites at ~1.15× the hex width**, not the 2× this section guessed. At 2× a settlement
  covers its neighbours entirely.

The needs-you sprite swap is still owed art, so the flag is drawn on canvas for now — a pole
and a banner above the tile, with a red ring. That is enough to read at zoom, and swapping in
a sprite later changes one function.

### Keeping the map cheap

Four things, found by measuring rather than guessing — `window.__threadlands.perf` has switches
for bisecting a frame, and frame *rate* is the only honest measure, because canvas work is
queued on the GPU and wall-clock around the JS reports near zero.

- **One render loop, owned by one place.** `draw()` used to schedule its own next frame, and
  `resize()` called `draw()` — so every window or splitter resize started another permanent
  loop and they multiplied until the map crawled. The loop is now started once and nothing else
  may schedule a frame.
- **Draw on demand.** The map is still most of the time: a frame is painted when something
  changes, while a settlement is animating, or on a 500ms heartbeat so a missed `invalidate`
  can never strand a stale map. Idle went 25fps to 120.
- **Never fill more than the viewport.** The ground filled the realm's whole extent, which at
  full zoom is a fill of over a hundred megapixels per frame. The island's blurred shadow is
  also skipped entirely unless the shore is actually on screen — a blur costs by area.
- **Resize inside the render loop, never beside it.** Setting `canvas.width` clears the canvas,
  so a resize scheduled in its own animation frame can land *after* the frame that was just
  painted and wipe it. Two independent `requestAnimationFrame` callbacks have no defined order
  between them. The symptom is a map that flashes while a splitter is dragged, and the fix is
  to make the loop do the resize immediately before it draws.
- **Cache the ground, but not on every resize.** It depends only on zoom and position, so it is
  painted into an offscreen canvas covering the viewport plus 40% and blitted; panning went
  28fps to 99. Dropping that cache inside `resize()` undid all of it, because a splitter drag
  resizes every frame — the staleness check already covers a viewport leaving the cached rect.

### The self test

`npm run selftest` drives the real app through its real IPC: founds a camp in a scratch
folder, sends a prompt that must use a tool, waits for the flag, answers it, and checks the
file landed. It screenshots each stage and exits non-zero on failure. It spends about $0.20,
which is the price of knowing the map, the Keep and a live session agree.

```
✓ camp founded and on the map      ✓ turn finished
✓ settlement went to work          ✓ session id captured for resume
✓ flag went up for permission      ✓ tokens counted
```

The window can screenshot itself (`THREADLANDS_SHOT`, plus `THREADLANDS_SHOT_JS` to drive the
map first through `window.__threadlands`). Give the page a beat to paint before capturing —
`capturePage` will otherwise hand back the frame from before your script ran.

**One performance note for §11's cost worry:** the budget probe that takes ~490ms from `tsx`
takes several seconds inside Electron. The Keep now probes at startup and every two minutes,
caches the rows, and pushes them at the renderer, so the cottage opens with numbers on it.

**Gate:** found, place and click into a settlement entirely from the map.

### Phase 3 — The governor's hall · 4–6 evenings

The side panel: streaming transcript, tool calls collapsed to one line each, diffs rendered
readably, the permission card with Allow / Allow always / Deny, and the Open Terminal button.

This is where workers become visible: the panel lists them, you click one to read it or
open its terminal, and each gets its own Open Terminal at the same `cwd`.

Budget real time here. Rendering an agent transcript well is more work than the hex grid,
and it is the surface you'll stare at all day. *Allow always* writing to the settlement's
`allowedTools` is what starts the trust loop.

**Gate:** a full working session run without opening a terminal once.

**Status: most of it.** The panel streams the transcript, collapses each run of tool work to
one line you can expand, renders markdown, and carries the permission card and Open Terminal.
Still owed: readable diffs instead of a bare `write path` line, and workers — the many-worker
model was deferred with Phase 1, so there is nothing to list yet.

*Allow always* was replaced rather than built. Permission **modes** turned out to be the thing
actually wanted — auto mode lets a classifier approve routine calls and only raises the flag
when it cannot decide, which is the trust loop without a growing list of rules to audit. A
per-tool `allowedTools` list is still the right mechanism for narrow, permanent grants, and
belongs with §5's route compiler.

### Phase 4 — A living realm · 2–3 evenings

Native notifications when the app is backgrounded and a banner goes up. Spend tracking per
settlement, surfaced on the tile. Chimney smoke while working, lanterns when idle, a dimmed
sprite when dormant. Trade-route overlay on selection, drawn from `grants` — roads out of a
library show everywhere it is installed, and opening one warns how many settlements depend on
it. The cottage becomes editable here: realm defaults and the agent rules seeded into every
profile, which until now have only been values in the realm file. On first launch,
offer to found a city for each existing session that `listSessions()` finds, per profile —
your twelve repos become a populated map on day one.

**Gate:** you stop opening terminals out of habit.

**Status: partly.** Dormant settlements dim, spend and exact token counts show in the panel,
and the cottage is editable — realm defaults for model, permission mode, idle timeouts, budget
ceiling and base folder. Not done: native notifications when a flag goes up while the app is
backgrounded (the thing most likely to make the map worth leaving open), spend on the tile
rather than only in the panel, chimney smoke and lanterns, the trade-route overlay, and the
first-launch offer to found a city for every session `listSessions()` finds.

### Phase 5 — Settlers and walls · open-ended

Everything that earns its place after daily use. `forkSession` as settlers leaving a city
to try a branch on an adjacent hex. Promotion from camp to city. Keyboard nav between
flagged settlements. Decay on camps untouched for weeks.

**Gate:** none. This is the part that stays fun.

**Status: not started.** Nothing here is blocked; it is all waiting on daily use to say which
parts earn their place.

### Phase 6 — Messengers · 3–4 evenings

The `send_messenger` tool, the `Dispatch` record, and the post. A dispatch is composed by one
settlement, held at the post, and pushed into the recipient's session as a user message when
you forward it. The sender never blocks.

This phase is genuinely additive — it touches no existing field on `Settlement`, which is why
it sits here instead of being back-ported into Phase 1. Build it when read-only libraries start
to chafe, and not before.

**Gate:** a project finds a bug in a library it cannot write to, keeps working while the
dispatch waits, and the fix lands in the library's own settlement without the wall ever opening.

**Status: not started**, and correctly so — it depends on walls, and walls do not exist yet.

---

## 8. Platforms

Electron ports cleanly and nothing in §2 through §7 is Mac-specific. One feature does not
travel, and a handful of paths need care.

### Walls do not exist on native Windows

Sandboxing runs on macOS (Seatbelt), Linux and WSL2 (bubblewrap). **Native Windows has no
sandbox**, so the Bash half of every wall in §5 is simply absent there.

The default behaviour makes it worse: when the sandbox can't start, Claude Code runs commands
*unsandboxed and silently*. A Windows settlement would look walled and not be. Nor can you
force it — `sandbox.failIfUnavailable: true` on Windows makes Claude Code exit at startup.

What survives on Windows is the permission half: `deny` rules still fence Read, Edit and Write,
so a library is protected from the file tools. What is lost is everything downstream of a
broad `Bash` entry in `allowedTools`, which can write to a library through the shell with
nothing to stop it.

Three ways to take it:

1. **Mac first, Windows left open.** Keep every path platform-agnostic from Phase 1 and treat
   walls as a macOS and Linux feature. *Recommended.*
2. **Ship Windows with walls visibly degraded** — drawn at half height on the tile, and said
   plainly in the founding dialog. Weaker, but not dishonest.
3. **Require WSL2 on Windows** for any walled settlement. Complete, but `cwd` becomes
   `/mnt/c/...`, profiles live in the WSL filesystem, and you maintain two path worlds.

### The smaller deltas

| | macOS | Windows |
|---|---|---|
| Realm file | `~/Library/Application Support/` | `%APPDATA%` — use `app.getPath("userData")` |
| Session store | `~/.claude/projects/` | `%USERPROFILE%\.claude\projects\` |
| Open terminal | `open -a Terminal <cwd>` | `wt.exe -d <cwd>`, falling back to `start cmd /K` |
| `settings.local.json` | at the repository root | stays beside `settings.json` |
| Network paths | n/a | UNC paths can't be working directories; map a drive letter |

Untested and worth an early spike if Windows ever becomes real: permission rules take `//` for
absolute paths, and how that meets a `C:\` drive letter is not something to assume.

### Distribution

For your own machine, skip signing entirely. If the app ever reaches someone else, macOS wants
notarization through an Apple Developer account and Windows throws SmartScreen warnings without
a code-signing certificate. Neither is worth doing before Phase 4.

---

## 9. Hex math

Flat-top axial, since the tile art is flat-top. Worth writing down once to avoid
relitigating it.

```ts
const SIZE = 64;               // centre to corner, in px
const W = SIZE * 2;            // 128 — full tile width
const H = Math.sqrt(3) * SIZE; // ~110.9 — full tile height

// axial (q, r) -> pixel centre
const toPixel = (q: number, r: number) => ({
  x: SIZE * 1.5 * q,
  y: H * (r + q / 2),
});

// pixel -> axial, via cube rounding (needed for click detection)
function toHex(x: number, y: number) {
  const q = (2 / 3) * x / SIZE;
  const r = (-1 / 3) * x / SIZE + (Math.sqrt(3) / 3) * y / SIZE;
  return cubeRound(q, r);      // round in cube space, not axial
}
```

Rounding in axial space puts clicks on the wrong tile near the edges. Convert to cube
coordinates, round all three, fix up whichever drifted furthest, convert back. Draw order
for sprites is a sort on `(r, q)` ascending.

---

## 10. Decisions

Six are now decided, by building them. The rest still wait on §5.

**Settled:**

- **Idle timeouts** — 20 minutes for camps, 120 for cities, editable in the cottage. The
  suggested 5/30 was too eager; a city you leave over lunch should still be warm.
- **Budget caps** — `maxBudgetUsd` per settlement, realm default $5, enforced by the SDK.
- **One realm** — one map, profiles separate the accounts. No second map.
- **Settings inheritance** — left at the SDK's own default, so settlements honour your
  existing `CLAUDE.md` and permissions. Worth revisiting when walls land, since a project's
  own config can widen what a settlement may do.
- **Permission posture** — not the ask-every-time default the plan assumed, but a mode per
  settlement over a realm default. The mechanism for fencing is §5's; this is the dial.
- **Profile seeding** — a new profile directory inherits nothing. You log it in yourself,
  once, from a terminal. Threadlands never touches credentials, which is the only version of
  this worth having.

**Still open:**

- **Settings inheritance.** `settingSources: ["user", "project"]` means settlements honour
  your existing `CLAUDE.md` files and permissions. Almost certainly what you want — but it
  means Threadlands is not a clean room, and a project's own config can widen what a
  settlement may do.
- **Raze semantics.** Still open, and now visible: razing removes the tile and the realm's
  record, and leaves the session in `~/.claude/projects/` untouched. The dialog does not say
  so. A city makes you type `delete` first; a camp takes one confirming click.
- **Default fencing.** `blockReadsOutsideWorkingDirectories` on for every new settlement, with
  grants as the deliberate exception. Starting open and tightening later never happens.
- **Sandbox on by default.** It is the only thing holding the Bash half of a wall. Decide what
  happens when it can't start — `failIfUnavailable`, or degrade and mark the tile. This is a
  platform decision as much as a policy one; see §12.
- **Promotion to library.** Whether any settlement can be declared a library later, which
  retroactively makes every existing route into it read-only. Probably yes, with a dialog
  naming the routes it would change.
- **The reply path.** Whether a recipient answering a dispatch ("fixed, pull latest") also
  waits at the post. Probably yes — one rule, no exceptions, and you want to know.
- **Stale dispatches.** One that has waited a week may name code that has moved. Record the
  sender's git rev at dispatch time and mark the dispatch when the recipient has moved past it.

---

## 11. Where this gets hard

**Process supervision.** Many concurrent sessions, each able to die, hang or leak a pending
permission resolver. Not conceptually hard — but this is where the bugs will live, and they
will be the kind that only appear after four hours of uptime.

**Transcript rendering.** Terminals give you streaming, tool output and diffs for free. You
are rebuilding all of it. Expect this to take longer than the map, and expect to keep tuning
it for months. *So far true, and cheaper than feared* — markdown and collapsible tool runs got
it readable quickly. Diffs are the part still missing, and will be the expensive half.

**Silent cost.** Six agents working at once burns tokens invisibly. The game frame helps:
per-settlement spend shown on the tile as a visible resource is both honest and thematic.
*Half done* — exact tokens and dollars show in a settlement's panel, and the cottage shows what
each account has left against its plan windows. Neither is on the tile yet, which is where it
would actually be glanceable.

Conspicuously *not* hard: the hex grid, placement, camera, flags, save and load. The fun
part is also the cheap part, which is a good property for a project you'll build in evenings.

---

## 12. Not in version one

Written down so they stop being tempting.

- Fog of war
- A tech tree
- Resources or yields per tile
- Units that move between hexes
- Terrain variety
- Multiple realms
- Turns or any time simulation
- Settlements talking to each other, directly or unattended
- A postmaster agent triaging the queue
- Version or dependency resolution
- Non-Claude providers
- Worker sprites on the map
- Anything multiplayer

Two of those were meant to be deliberate half-measures rather than deferrals. **Non-Claude
providers**: the driver seam goes in at Phase 1, the second driver does not. **Worker
sprites**: the many-worker model goes in at Phase 1, the swarm-around-the-tile rendering does
not. Both are structural if you build them early and a rewrite if you don't.

*Neither half-measure was built.* `Settlement` has a `workers[]` field and nothing fills it,
and the supervisor talks to the SDK directly with no `SettlementDriver` interface between.
Both were deferred on the same reasoning — nothing above them existed to constrain their shape
— which is defensible for the driver seam and a growing debt for workers, since every new
field on `Settlement` is one more thing a worker would have to grow too.

Roads between cities came off this list — they turned out to be a view of real permission
state (§5, Folder scope) rather than decoration.

**Settlements talking to each other** stays on it, with one carve-out. Messengers (§5) are not
that: both ends talk only to the hub, every dispatch stops at the cottage, and there is exactly
one message type going one direction. Direct or unattended exchange between settlements remains
cut, and the day a messenger becomes a free-form channel is the day this bullet was right.

Several of these are good ideas. All of them are better ideas once the thing is replacing
your terminals every day, and most will look different by then.

---

## 13. What to build next

In the order that makes the next thing possible.

1. **Walls** (§5). The whole of §5 is still prose. Until a settlement is actually fenced, the
   map promises a containment it does not have. The route compiler — one function from a
   settlement's `grants` to the `permissions` and `sandbox` block its sessions launch with —
   is the piece everything else hangs off, and it is testable without any UI.
2. **Notifications.** A flag that goes up while the app is in the background is currently
   invisible. This is the smallest change with the largest effect on whether the map is worth
   leaving open.
3. **`listSessions()` on first launch.** Offer a city for every session already on disk, per
   profile. A populated map on day one, from work that already exists.
4. **Diffs in the panel.** `write path/to/file` should show what changed. This is the main
   remaining reason to open a terminal.
5. **A realm backup.** One JSON file, written atomically but with no second copy. A rolling
   backup before each save is a small change and the kind of thing you want *before* you need
   it.
6. **Grants and routes in the UI**, once walls exist underneath them.

Assets still needed: a library sprite, a post sprite, and needs-you variants of camp and city
— the flag is drawn on canvas until those exist.
