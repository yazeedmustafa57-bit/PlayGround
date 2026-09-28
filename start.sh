#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
export PORT
# Static project: no dependencies to install and no build step; default-start
# handles vite install/build when package.json is present, writes
# $OPENCODE_WEB_DIR/deployment-output.json, and serves foreground on $PORT.
/usr/bin/time -p pwd
/usr/bin/time -p test -f index.html
/usr/bin/time -p node "${RUNTIME_DIR:?}/scripts/default-start.mjs"
