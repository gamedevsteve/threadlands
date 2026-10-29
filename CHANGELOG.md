# Changelog

Notable changes, newest first. Dates are the day the tag was cut.

This project is not published anywhere — there are no downloads and no CI.
A release is a **tag plus an entry here**, and anyone who wants the app builds
it themselves with `npm run package`. See [RELEASING.md](RELEASING.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semver](https://semver.org/) — loosely, while below 1.0.

## [Unreleased]

### Added

- **Your name and your avatar.** The cottage takes a name, so the map says who
  you are instead of "You", and an image that stands outside the cottage door.
  The avatar is kept beside your realm rather than in the app's assets, so it is
  yours and not shipped to anyone else; it is copied in, scaled to 512px and
  read back as a data URL.
- A vertical rail of map tools against the inside edge of the panel, following
  the splitter as you drag it. First tool: **home**, which glides the map back
  to the cottage. The camera eases rather than snapping, and a notification you
  click now glides to its settlement the same way.

### Fixed

- **The packaged app could not start a session at all.** The SDK spawns the
  Claude CLI as a child process and resolves its path relative to its own
  module, which inside a packaged app is a path *within* `app.asar`. Electron
  remaps asar paths for file reads but not for `spawn`, so every session, the
  model list and the budget probe failed with `ENOTDIR` — while the app itself
  launched normally. The CLI is now unpacked and the SDK is handed its real
  path.

### Changed

- The avatar stands at a fixed spot beside the cottage, in the same world units
  as the building, behind the name plate rather than in front, and its shadow is
  sized from the figure itself.
  Avatars arrive padded — a 512px square with the person in the middle 59% —
  so measuring the file's dimensions put a shadow under empty space.
- The cottage reads like a settlement's details: capitalised labels, one setting
  per field, a hairline between each.
- The map tool rail sits at the top right rather than centred, and its buttons
  grow from their middle on hover instead of sliding left.

- A settlement's panel pins only its **name**, with an info button beside it.
  Everything else — folder, account, tokens, spend, model, permission mode,
  Raze — slides out over the transcript as its own sheet of parchment, and
  `Esc` closes it. Labels
  are capitalised with a hairline between rows, and Raze sits at the foot,
  right-aligned and red.
- A settlement's details stay put while only its transcript scrolls. Scrolling
  both together meant losing the name, the mode and the spend as soon as you
  read back through a conversation. On a short window the details scroll
  themselves rather than starve the transcript.

## [0.1.0] — 2026-10-29

First version that replaces a terminal rather than demonstrating that it could.

### Added

- **The map.** A hex realm you pan and zoom, with the cottage at its centre.
  Found a camp or a city on a folder, drag it to another hex, raze it — a city
  makes you type `delete` first.
- **The Keep.** The main process owns every Agent SDK session; the renderer
  never touches the SDK. Sessions resume by id, so a reaped settlement wakes
  with its transcript intact.
- **The flag.** A settlement raises one when its governor needs permission, and
  you answer from its panel.
- **Permission modes** per settlement over a realm default — ask, auto, accept
  edits, plan, never ask — cycled with `Shift`+`Tab`.
- **A model per settlement** over a realm default, switchable mid-conversation
  without restarting the session.
- **Notifications** when a settlement needs you or has gone idle. Clicking one
  focuses the app, selects that settlement and pans to it.
- **The cottage** holds realm settings and a budget panel: what each account has
  left against its plan windows, and when they reset.
- **The panel.** Markdown replies, tool work between two bubbles rolled up to
  one expandable line, exact token counts and spend, and Open Terminal.
- **Idle reaper.** Camps go dormant after 20 minutes, cities after 120.
- `npm run selftest` drives the whole app through its real IPC against a live
  session and exits non-zero if any check fails.

### Known limits

- **Nothing fences a settlement yet.** It is scoped to a folder by `cwd` and
  nothing stops it reading outside. Walls, grants, routes and libraries are
  still only described in `BUILD_PLAN.md` §5.
- **Notifications need the packaged app.** macOS refuses them to an app it has
  not registered, so running from source they fail silently. See RELEASING.md.
- **One account.** Profiles are plumbed through but there is no UI to add one.
- No workers, no messengers, no diffs in the transcript.

[Unreleased]: https://github.com/gamedevsteve/threadlands/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gamedevsteve/threadlands/releases/tag/v0.1.0
