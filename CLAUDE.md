# Threadlands — notes for Claude

## Are you running inside Threadlands?

If `__CFBundleIdentifier` is `com.hatfieldmedia.threadlands`, you are a governor
inside the installed app, working on the app that keeps you alive. Quitting or
reinstalling it kills your process. Your session id is in the realm, so you
should resume on the next message, but a turn that's still running is lost.

**Before starting work, say so plainly and recommend a terminal session if the
task touches any of these:**

- `src/main/supervisor.ts`, `src/main/realm.ts`, or session launch and IPC in
  `src/main/main.ts`, i.e. anything that could stop a settlement from starting or
  resuming. Walls, grants and routes are in this group.
- The shape of `realm.json`, or migrating it. A bad migration can lose the
  session ids that resume depends on.
- Packaging and install (`package.json` build config, `build.mjs`,
  electron-builder).

Use words like: "⚠️ This touches session launch. Do this from a terminal, not
from inside Threadlands. Want me to open one?" Then wait for the user to decide.
Renderer, art, panels, map and docs work is safe to do in the app.

If they say yes, write a short brief for the terminal session (the task, what
you've found so far, which files are involved) and show it in chat.

**Never write to the clipboard without asking first, every time.** The user may
have something on it they need. Saying yes to the terminal is not saying yes to
the clipboard. Ask something like "OK to put this brief on your clipboard? It
will replace what's there." and wait for a clear yes. If they say no, open the
terminal anyway and leave the brief in chat for them to copy themselves.

Once both are approved, hand off:

```bash
printf '%s' "<the brief>" | pbcopy
osascript -e 'tell application "Terminal"' -e 'activate' \
  -e 'do script "cd ~/Documents/repos/threadlands && claude"' -e 'end tell'
```

That opens a new Terminal window with `claude` already running, and puts the
brief on the clipboard. Tell the user to paste it (⌘V) and press Enter. Don't
pass the brief as an argument to `claude`: that sends it straight away, and the
user should see it before it goes. The new window gets Terminal's environment,
not ours, so the rule above won't fire there.

**Never run `npm run install-app` from inside the app.** Run
`npm run package:dir`, finish your turn, and tell the user to quit Threadlands
and copy `release/mac-arm64/Threadlands.app` into `/Applications` themselves.

If that variable isn't set, you're in a plain terminal and none of this applies.

## Reinstalling the app, and picking up afterwards

Settlements survive a reinstall. The realm is in
`~/Library/Application Support/Threadlands/realm/`, outside the app. Each
settlement comes back dormant and resumes with its full conversation on the next
message. Only a turn that's still running when the app quits is lost.

The order:

1. **The terminal session commits its work.** If you're the terminal session and
   the user is about to reinstall, commit first, with a message that says what
   changed and what's left. Git is how the in-app governor finds out what
   happened.
2. **The terminal session builds:** `npm run package:dir`.
3. **The user checks that nothing on the map is working**, then quits
   Threadlands, copies `release/mac-arm64/Threadlands.app` into `/Applications`
   and relaunches.
4. **Back in the app, the governor catches up.** When the user says "caught
   up?" or that the terminal is done, read `git log` since your last
   known commit and `git status`/`git diff` before doing anything else, then
   summarise what changed and carry on. Don't assume the code is still as you
   last saw it.

## Seeing the app

You can't see the user's screen, but you can see the app. `tools/shot.sh
out.png '<js>'` runs a scratch copy against a copy of the realm, runs the JS in
the page (click things, wait, return something), and saves a PNG of the window.
Read the PNG. It spends nothing and never touches the real realm. Do this after
any change to the panel or the map, before telling the user it's done: a style
change can look right in code and wrong on screen. `sips -Z 1400` shrinks a
shot before reading it. Example, opening the board's first ledger:

```bash
tools/shot.sh /tmp/board.png '(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById("go-bounty").click(); await w(700);
  document.querySelector(".ledgerrow").click(); await w(700); })()'
```

## Pitfalls

See "Things that will bite you" in README.md: never use `for await … break`
over a `Query`, `canUseTool` must never throw, never `await` iterator teardown,
and never set `CLAUDE_CONFIG_DIR` for the default profile.
