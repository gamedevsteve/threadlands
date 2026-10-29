# Threadlands

A Civilization-style map for the Claude Code terminals you already run. Each
session is a settlement on a hex grid; you are the cottage in the middle.

- **Camps** are short work. They go dormant quickly.
- **Cities** are long projects, kept warm far longer.
- **The cottage** is you: realm defaults, and what each account has left.

A settlement is scoped to one folder. When its governor needs permission, a flag
goes up on the tile — click it, read what it wants, allow or decline. You can
open a real terminal at any settlement's folder when you'd rather do it by hand.

## Running it

```bash
npm install
npm run assets     # once: preps the sprites and the ground texture (needs Pillow)
npm start
```

The ground is a lattice of tileable textures, anchored to the world so it pans
and zooms with it. The hex grid is still underneath; it only shows under the
pointer.

### Ground variants

`assets/grass.png` is the base. To add a variant — a meadow, a dry patch, a
clover field — copy it, **change whatever you like in the middle**, and save it
next to the base:

```
assets/grass.png            the base
assets/grass-flowers@2.png  a variant, twice as common as a weight-1 one
assets/grass-long.png       another, weight 1
```

Then `npm run assets`. Each variant is composited onto the base through a
feathered mask, so its border is replaced by the base's border whatever you did
out there. That mask is multiplied by blurred noise, so the patch has a ragged
natural outline instead of tracing the square tile — without it, any variant
whose tone differs much from the base reads as a rectangle. Every tile in the set therefore ends in identical pixels and any two
can sit side by side — including a tile against itself. **You never have to be
careful near the edges.**

Each variant is baked into **patch sprites** — transparent, soft-edged blobs of
that texture in five sizes and two shapes each — rather than into versions of
the ground tile. That is what frees a patch from the tile grid: patches land on
a jittered scatter that has nothing to do with the texture lattice, come in very
different sizes, and overlap, so two or three run together into one ragged area
and flowers mingle with long grass instead of each keeping to its own square.

`PATCH_SPACING` and `PATCH_DENSITY` in the renderer set how close together and
how many; `PATCH_SIZES` in the tool sets the range of sizes. `@n` in the
filename sets how common a variant is relative to the others.

The two example variants are generated on first run purely so there is something
to look at — soft tonal drift, no detail, so they suit whatever the base is.
Replace or delete them, nothing depends on them. They are derived from the base,
so after swapping the base out, delete them and re-run to regenerate.

If the texture reads too coarse or too fine against the sprites, change the
`width` that `prepare_ground()` resizes to: a smaller number means the texture
repeats more often, so its detail looks smaller on the map.

One limit worth knowing: because the border always comes from the base, a
variant covers about three quarters of its cell. That gives sprinkled patches,
and neighbouring cells of the same variant do merge into larger fields, but it
cannot give you a large contiguous region with a hard boundary — a lake, a
forest edge. That needs an edge-matching set (Wang tiles), which is a bigger job
and not built.

`npm run dev` rebuilds on change. `npm run typecheck` is the fast check.

`npm run package` builds a real app with electron-builder — a .dmg and .zip on
macOS, NSIS on Windows, AppImage on Linux. The icon comes from
`assets/appicon.png`: `npm run assets` keys its near-black surround to
transparent (macOS shows a black tile otherwise), writes `build/icon.icns` via
`iconutil`, and leaves a 512px copy for the Dock while developing, where a
packaged icon does not exist yet.

## Proving it works

```bash
npm run selftest
```

Founds a camp in a scratch folder, sends a prompt that must use a tool, waits
for the flag, answers it, and checks the file landed — through the real IPC,
against a real session. It writes screenshots next to the prefix you give it and
exits non-zero if any check fails. **It spends real tokens** (about $0.20).

```
  ✓ camp founded and on the map
  ✓ settlement went to work
  ✓ flag went up for permission
  ✓ turn finished
  ✓ session id captured for resume
  ✓ tokens counted
```

`npm run usage` prints what the signed-in account has left, without spending
anything.

## Shape of it

```
src/main/        the Keep — owns every session; the renderer never sees the SDK
  supervisor.ts  one Governor per settlement, and the three lifecycle traps
  realm.ts       the realm file in userData
  usage.ts       the free budget probe behind the cottage panel
  selftest.ts    the end-to-end check
src/preload/     the only bridge
src/renderer/    the Map — canvas hex grid and the panels
src/shared/      the IPC contract both sides agree on
tools/           asset preparation
spike/           the Phase 0 spikes, kept because they still run
```

### Name plates

Settlement names are drawn on `assets/banner.png` in Kaushan Script, which is
shipped in `src/assets/fonts/` rather than fetched, so the map never waits on a
network. The plate art is black linework on a white body: the renderer
multiplies a colour through it at draw time, so white becomes the tint and the
linework stays black. Tints carry state — parchment normally, amber when a
settlement wants you, washed out when dormant.

Plates are sized in screen pixels, not world units, so they never swell as you
zoom in. `BANNER_WIDTH`, `BANNER_REF_ZOOM` and `BANNER_ALL_BELOW` in the
renderer set how big, what zoom that size is for, and the zoom below which only
the selected, hovered and flagged names are drawn — without that last one they
stack up and bury the settlements when you zoom out.

### Settings

The cottage holds the realm's defaults: the **model** every settlement uses
unless it says otherwise, idle timeouts, the per-settlement budget ceiling, and
the **base folder** that the folder browser opens at when you found
a settlement — so founding starts where your work lives rather than at the root
of the disk. The founding form pre-fills it too, so a settlement on the base
folder itself is one click.

A settlement's own panel has a model dropdown that overrides the realm default,
and it takes effect **mid-conversation** — `setModel` works in streaming input
mode, so the session is not restarted and nothing is forgotten. A settlement set
to "Realm default" follows the cottage, including while it is running.

### The panel

The side panel is `assets/parchment.webp`. Everything inside it reads its
colours from CSS custom properties, so the whole panel is reskinned by
redefining those tokens on `aside` rather than by touching each rule — swap the
texture and adjust that one block. The top bar and the map are unchanged.

Panel text is Libre Baskerville, shipped locally like the plate font. Google
Fonts has no plain "Baskerville" — that one is Monotype's, though macOS does
carry it, so `font-family: Baskerville` would work on a Mac with no download at
all. `Baskervville` is the other Google option, a more delicate revival.

A white veil sits over the texture so it reads as a tint rather than something
to look through — `--veil` on `aside`, currently `.46`. Higher knocks it back
further; `0` is the raw texture.

### The window

The top bar is the window's title bar: drag it to move the window, double-click
it to zoom (macOS does that for any drag region), or use **Fill screen** at its
right, which toggles and relabels itself and stays correct when the window is
zoomed from the green light or a menu instead.

The divider between map and panel drags: grab it for a wider chat when a
governor is being talkative, double-click to reset. The width is remembered, and
re-clamped if the window gets too narrow to honour it.

Settlements can be dragged to another hex: pick one up and the map stays still
while it follows the pointer, with the target outlined white if it can land and
red if it cannot — the cottage's tile and occupied tiles are refused. Dragging
from open ground pans the map as before; which gesture you get is decided at
mousedown by what is under the pointer.

The work between two bubbles — what it read, wrote and ran — collapses to one
line once the turn is over, with a count of what happened and an **expand** to
open it. The run still in progress stays open, so you can watch it work.

A governor's replies render as markdown. The text is HTML-escaped *before* it
is parsed, never after: escaping afterwards would undo the markup, and skipping
it would let a model's output inject tags into the panel. Links open in the
system browser rather than navigating the app away.

### Asking before acting

Each settlement has a permission mode, overriding a realm default set in the
cottage. `Shift`+`Tab` cycles the selected settlement through them, or use the
dropdown in its panel:

| Mode | What it does |
|---|---|
| Ask every time | The flag goes up for anything that changes something. |
| Auto | A classifier decides, and only asks when it genuinely cannot. |
| Accept edits | File edits go through; commands still ask. |
| Plan only | Reads and thinks, executes nothing. |
| Never ask | Runs anything in its folder without asking. No flag will ever go up. |

A live session changes mode in place. `Never ask` needs a flag that can only be
given when the session starts, so if a running governor refuses the switch it is
reaped and respawns on the next message with its transcript intact.

`Enter` sends a prompt, `Shift`+`Enter` starts a new line. `⌘`+`Enter` still
sends too.

### Moving around

Two fingers pan, pinch or ⌘+scroll zooms, and a mouse can still drag. `+` and
`-` zoom, `0` recentres.

Razing a city makes you type `delete` first; a camp takes one confirming click.
It is the only irreversible thing on the map.

`BUILD_PLAN.md` is the long version: the domain model, territory and walls,
messengers, and what is deliberately not in version one.

## Things that will bite you

Three are load-bearing and all cost real time to find:

1. **Never `for await … break` over a `Query`.** Leaving the loop early calls
   `.return()` and kills the session. Hold one iterator and call `.next()`.
2. **`canUseTool` must never throw.** An exception takes down the whole session,
   not just the tool call. It degrades to a deny.
3. **Never `await` iterator teardown** on a session whose input stream is parked
   on a promise that never settles. It hangs forever.

And one about accounts: setting `CLAUDE_CONFIG_DIR` *at all* — even to the real
`~/.claude` — changes which Keychain entry Claude Code looks for, so the session
comes up "Not logged in". The default profile must leave it unset.

## Not yet

Walls, libraries, trade routes, messengers, many workers per settlement, and
per-settlement accounts beyond the default profile. The map, the Keep, the flag,
the reaper and the cottage are done. See `BUILD_PLAN.md` phases 5 and 6.
