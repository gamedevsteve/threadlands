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
  | { kind: "cottage"; hex: Hex; defaults: RealmDefaults }
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

Persist the realm to `~/Library/Application Support/Threadlands/realm.json`. It holds
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

Two consequences worth designing around. The promise can sit unresolved for hours, so
persist enough of the request to show it after an app restart and resolve stale ones as
denied. And `signal` aborts — wire it so a razed settlement doesn't leak a pending resolver.

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

for await (const msg of q) supervisor.ingest(s.id, msg);
```

One loop per settlement. `ingest` is the only place SDK message types are translated into
Threadlands events.

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
agent-to-agent tar pit wearing a hat, and it is on the §11 list for good reason.

**The post is where they wait.** Its tile carries a count, legible from across the map, so
pending work has a place rather than a badge buried in a panel. Dispatch history lives there
too: what a settlement has sent and received, in one list.

The cottage is a different thing entirely — realm settings. Default permission mode, budget
caps, idle timeouts, and the agent rules seeded into every profile as `CLAUDE.md`. Rules change
monthly and dispatches arrive daily, so the two do not belong on one tile.

A **postmaster** — an agent triaging the queue for you — is the obvious next thought and is on
the §11 list. The point of the gate is that *you* read the finding; an agent that summarises
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

Each phase ends at something runnable. The order is chosen so the riskiest unknown dies first.

### Phase 0 — The spike · half a day

No UI, no Electron, no hexes. One TypeScript file run with `tsx`. Spawn a session in a
folder, send a prompt from stdin, print messages as they stream, trigger a permission
prompt and answer it from the keyboard. Then kill the process, re-run with `resume`, and
ask it what you were just doing.

This is the whole bet. If the loop works here, everything after it is application code you
already know how to write.

**Gate:** the resumed session remembers the first conversation.

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

### Phase 5 — Settlers and walls · open-ended

Everything that earns its place after daily use. `forkSession` as settlers leaving a city
to try a branch on an adjacent hex. Promotion from camp to city. Keyboard nav between
flagged settlements. Decay on camps untouched for weeks.

**Gate:** none. This is the part that stays fun.

### Phase 6 — Messengers · 3–4 evenings

The `send_messenger` tool, the `Dispatch` record, and the post. A dispatch is composed by one
settlement, held at the post, and pushed into the recipient's session as a user message when
you forward it. The sender never blocks.

This phase is genuinely additive — it touches no existing field on `Settlement`, which is why
it sits here instead of being back-ported into Phase 1. Build it when read-only libraries start
to chafe, and not before.

**Gate:** a project finds a bug in a library it cannot write to, keeps working while the
dispatch waits, and the fix lands in the library's own settlement without the wall ever opening.

---

## 8. Hex math

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

## 9. Decisions to lock before Phase 1

- **Settings inheritance.** `settingSources: ["user", "project"]` means settlements honour
  your existing `CLAUDE.md` files and permissions. Almost certainly what you want — but it
  means Threadlands is not a clean room, and a project's own config can widen what a
  settlement may do.
- **Idle timeouts.** Suggest 5 minutes for camps, 30 for cities. Short enough to matter,
  long enough that a resume never happens mid-thought.
- **Budget caps.** `maxBudgetUsd` per settlement, lower for camps. This is the only thing
  standing between six parallel agents and a surprising bill.
- **Raze semantics.** Does razing a camp delete its session from `~/.claude/projects/`, or
  only remove the tile? Pick one and make the dialog say it plainly.
- **One realm or several.** One map for everything is simplest, and profiles already
  separate work from personal without a second map — so defer multiple realms.
- **Default fencing.** `blockReadsOutsideWorkingDirectories` on for every new settlement, with
  grants as the deliberate exception. Starting open and tightening later never happens.
- **Sandbox on by default.** It is the only thing holding the Bash half of a wall. Decide what
  happens when it can't start — `failIfUnavailable`, or degrade and mark the tile.
- **Promotion to library.** Whether any settlement can be declared a library later, which
  retroactively makes every existing route into it read-only. Probably yes, with a dialog
  naming the routes it would change.
- **The reply path.** Whether a recipient answering a dispatch ("fixed, pull latest") also
  waits at the post. Probably yes — one rule, no exceptions, and you want to know.
- **Stale dispatches.** One that has waited a week may name code that has moved. Record the
  sender's git rev at dispatch time and mark the dispatch when the recipient has moved past it.
- **Profile seeding.** What a new profile directory inherits from `~/.claude` — nothing,
  a copied `settings.json`, or symlinked `CLAUDE.md` files. Decide once; it is annoying to
  change after several profiles exist.

---

## 10. Where this gets hard

**Process supervision.** Many concurrent sessions, each able to die, hang or leak a pending
permission resolver. Not conceptually hard — but this is where the bugs will live, and they
will be the kind that only appear after four hours of uptime.

**Transcript rendering.** Terminals give you streaming, tool output and diffs for free. You
are rebuilding all of it. Expect this to take longer than the map, and expect to keep tuning
it for months.

**Silent cost.** Six agents working at once burns tokens invisibly. The game frame helps:
per-settlement spend shown on the tile as a visible resource is both honest and thematic.

Conspicuously *not* hard: the hex grid, placement, camera, flags, save and load. The fun
part is also the cheap part, which is a good property for a project you'll build in evenings.

---

## 11. Not in version one

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

Two of those are deliberate half-measures rather than deferrals. **Non-Claude providers**:
the driver seam goes in at Phase 1, the second driver does not. **Worker sprites**: the
many-worker model goes in at Phase 1, the swarm-around-the-tile rendering does not. Both are
structural if you build them early and a rewrite if you don't.

Roads between cities came off this list — they turned out to be a view of real permission
state (§5, Folder scope) rather than decoration.

**Settlements talking to each other** stays on it, with one carve-out. Messengers (§5) are not
that: both ends talk only to the hub, every dispatch stops at the cottage, and there is exactly
one message type going one direction. Direct or unattended exchange between settlements remains
cut, and the day a messenger becomes a free-form channel is the day this bullet was right.

Several of these are good ideas. All of them are better ideas once the thing is replacing
your terminals every day, and most will look different by then.

---

Next step is Phase 0 — one file, half a day, and it answers the only question that can
still sink this.

Assets on hand: `tile base`, `main cottage`, `camp`, `city` — downscale to ~512px.
Still needed: a library sprite, a post sprite, and a needs-you variant of camp and city.
