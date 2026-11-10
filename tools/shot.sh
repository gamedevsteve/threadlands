#!/bin/zsh
# Screenshot Threadlands without touching the real realm or the screen.
#
#   tools/shot.sh <out.png> ['<js to run first>']
#
# Builds, copies the realm into a scratch folder, runs a dev copy pointed at it
# (THREADLANDS_DATA), runs the optional JS in the page, captures the window's
# own contents (not the screen, so displays and screen-recording permission
# don't matter) and quits. No settlement is woken, so nothing is spent.
set -e
out=${1:?usage: tools/shot.sh out.png [js]}
cd "${0:A:h}/.."
scratch=$(mktemp -d /tmp/tl-shot.XXXXXX)
mkdir -p "$scratch/realm"
cp ~/Library/Application\ Support/threadlands/realm/*.json ~/Library/Application\ Support/threadlands/realm/avatar.png "$scratch/realm/" 2>/dev/null || true
npm run build >/dev/null 2>&1
THREADLANDS_DATA="$scratch" THREADLANDS_SHOT="${out:A}" THREADLANDS_SHOT_JS="${2:-}" \
  npx electron . 2>&1 | grep -E '^\[shot|\[renderer\].*[Ee]rror' || true
rm -rf "$scratch"
