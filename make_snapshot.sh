#!/bin/sh
#
# Make the boot snapshot of the disk image nerves.cfg boots (see Snapshots
# in the README): boot it in headless Chromium, save the machine at the IEx
# prompt as disk/<id>/snapshot-<hash>.gz, name it in blk.txt, and check that
# it restores. extract_firmware.sh runs this for a new image; run it again
# after changing nerves.cfg or the emulator, which a snapshot also belongs to.
#
# Usage (in the jsnerves directory, like extract_firmware.sh):
#   ./make_snapshot.sh [--settle 5] [--level 9] [--attempts 5] [--no-shrink]
# (see tools/make_snapshot.mjs)
#
# Needs Node.js 20.11 or later. The first run installs Playwright into
# tools/node_modules and its headless Chromium into Playwright's cache
# (~/.cache/ms-playwright, ~/Library/Caches/ms-playwright on a Mac). On
# Linux, if Chromium then cannot start for missing libraries:
#   cd tools && sudo npx playwright install-deps chromium
#

set -e

TOOLS="$(cd "$(dirname "$0")" && pwd)/tools"

if ! command -v node >/dev/null 2>&1; then
    echo "Error: node not found; making a snapshot needs Node.js 20.11 or later"
    exit 1
fi
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a == 20 && b >= 11) ? 0 : 1)'; then
    echo "Error: Node.js $(node --version) is too old; making a snapshot needs 20.11 or later"
    exit 1
fi

if [ ! -f "$TOOLS/node_modules/.package-lock.json" ] ||
   [ "$TOOLS/package-lock.json" -nt "$TOOLS/node_modules/.package-lock.json" ]; then
    echo "Installing Playwright into tools/node_modules..."
    npm ci --prefix "$TOOLS" --no-audit --no-fund
fi
# does nothing when this Playwright's headless Chromium is already there
(cd "$TOOLS" && npx playwright install --only-shell chromium)

exec node "$TOOLS/make_snapshot.mjs" "$@"
