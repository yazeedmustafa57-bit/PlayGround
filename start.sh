#!/usr/bin/env bash
# Custom starter for the victor-ai-assistant Node project.
# Writes deployment-output.json, installs deps, serves in the FOREGROUND on $PORT (default 3000).
set -euo pipefail

PROJECT_ROOT="/home/runner/work/PlayGround/PlayGround"
APP_DIR="$PROJECT_ROOT/victor-ai-assistant"
STATIC_DIR="$APP_DIR/public"
WEB_DIR="${OPENCODE_WEB_DIR:-/home/runner/work/_temp/omgithub-web}"
PORT="${PORT:-3000}"
export PORT

/usr/bin/time -p mkdir -p "$WEB_DIR"
/usr/bin/time -p bash -c 'printf "%s" "{\"project\":\"/home/runner/work/PlayGround/PlayGround\",\"directory\":\"/home/runner/work/PlayGround/PlayGround/victor-ai-assistant/public\"}" > "$1/deployment-output.json"' _ "$WEB_DIR"
/usr/bin/time -p test -f "$APP_DIR/package.json"
/usr/bin/time -p test -f "$STATIC_DIR/index.html"
/usr/bin/time -p bash -c 'cd "$1" && npm install --no-audit --no-fund' _ "$APP_DIR"
/usr/bin/time -p bash -c 'cd "$1" && node -e "JSON.parse(require(\"fs\").readFileSync(\"package.json\",\"utf8\")); console.log(\"package.json OK\")"' _ "$APP_DIR"
cd "$APP_DIR"
exec /usr/bin/time -p node src/server.js
