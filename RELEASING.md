# Releasing

There is no CI and nothing is published. A release is a **git tag plus a
CHANGELOG entry**; the app itself is built locally by whoever wants it.

That is a deliberate choice for now — the build is 538MB, mostly Electron and
the bundled Claude Code CLI, and hosting it buys nothing while this is a tool
for one desk.

## Cutting one

```bash
npm run typecheck          # must be clean
npm run selftest           # spends ~$0.20 against a live session
```

Then write the entry **before** bumping the version, while you still remember
what changed:

1. Move everything under `## [Unreleased]` in `CHANGELOG.md` into a new
   `## [x.y.z] — YYYY-MM-DD` section, and add the compare links at the bottom.
2. `npm version x.y.z` — this bumps `package.json`, commits, and tags `vx.y.z`.
3. `git push && git push --tags`

`npm version` refuses to run on a dirty tree, which is the behaviour you want:
commit the changelog first.

### What the numbers mean

While below 1.0: **patch** for fixes, **minor** for anything you would tell
someone about. The first version you would let another person install is 1.0.

## Building the app

```bash
npm run package            # a .dmg and .zip in release/
npm run package:dir        # just the .app, faster, for testing
npm run install-app        # build and copy into /Applications
```

`release/` is gitignored — artifacts belong to the machine that made them, not
the repo.

`install-app` copies the bundle but **does not restart anything**. If a copy is
already running, `open -a` just brings that one to the front, so you sit there
testing the old build and concluding the fix did not work. Quit it first:

```bash
osascript -e 'tell application "Threadlands" to quit'
open -a /Applications/Threadlands.app
```

`ps -eo pid,lstart,comm | grep MacOS/Threadlands` settles the question — the
start time has to be later than the install.

### Check the packaged build can actually work

Launching is not evidence. A packaged app starts, draws and notifies perfectly
well while being unable to run a single session — the SDK spawns the Claude CLI
as a child process, and a path inside `app.asar` cannot be spawned. **Open a
settlement and send one message** before calling a build good.

### Two things only the packaged app has

- **Notifications.** macOS will not grant them to an app it has not registered,
  and refuses *silently*. Running from source they always fail with
  `UNErrorDomain error 1`. The packaged bundle is signed with a real identity
  and registers on first launch. The cottage has a **Send a test notification**
  button that reports what actually happened.
- **The right name.** In development the Dock says "Electron", because that is
  the bundle being run. Only the packaged build sets `CFBundleName`.

### Signing and notarization

`electron-builder` signs with whatever Apple identity is in your keychain —
currently an *Apple Development* certificate, which is enough for this machine.
It is **not notarized**, so another Mac will show a Gatekeeper warning. If this
ever goes to someone else, notarization needs an Apple Developer ID certificate
and `notarize` credentials in the builder config.

## Assets

`npm run assets` regenerates the sprites, the ground patches, the name plate and
the app icon from `assets/`. It needs Python with Pillow. The generated files
are committed, so a clone can run and package without it.
