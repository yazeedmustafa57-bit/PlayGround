#!/usr/bin/env bash
# Cube Rush 3D – static offline game server.
# Builds dist/index.html inside PROJECT_DIR and serves it in the foreground.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
PROJECT_ROOT="$(/usr/bin/time -p pwd)"
DIST="$PROJECT_ROOT/dist"
WEB_DIR="${OPENCODE_WEB_DIR:-/home/runner/work/_temp/omgithub-web}"
SRC_HTML="offline-3d-game.html"

/usr/bin/time -p mkdir -p "$DIST"
/usr/bin/time -p mkdir -p "$WEB_DIR"

# Install dependencies when a package project exists (no-op for pure static).
if /usr/bin/time -p test -f "$PROJECT_ROOT/package.json"; then
  if /usr/bin/time -p test -f "$PROJECT_ROOT/package-lock.json"; then
    /usr/bin/time -p npm ci --no-audit --no-fund
  else
    /usr/bin/time -p npm install --no-audit --no-fund
  fi
  if /usr/bin/time -p test -x "$PROJECT_ROOT/node_modules/.bin/vite"; then
    /usr/bin/time -p npx vite build
  fi
fi

# Build: single-file offline game -> dist/index.html (stays inside PROJECT_DIR).
if /usr/bin/time -p test -f "$PROJECT_ROOT/$SRC_HTML"; then
  /usr/bin/time -p cp -f "$PROJECT_ROOT/$SRC_HTML" "$DIST/index.html"
elif /usr/bin/time -p test -f "$PROJECT_ROOT/index.html"; then
  /usr/bin/time -p cp -f "$PROJECT_ROOT/index.html" "$DIST/index.html"
fi
/usr/bin/time -p test -f "$DIST/index.html"

# Publish deployment output for the controller (worker metadata only).
/usr/bin/time -p python3 -c "import json,os; web=os.environ.get('OPENCODE_WEB_DIR','/home/runner/work/_temp/omgithub-web'); import pathlib; pathlib.Path(web).mkdir(parents=True,exist_ok=True); json.dump({'project':os.path.abspath('.'),'directory':os.path.abspath('dist')}, open(os.path.join(web,'deployment-output.json'),'w'))"

echo "Serving $DIST on port $PORT (project: $PROJECT_ROOT)"
exec python3 -m http.server "$PORT" --directory "$DIST" --bind 0.0.0.0
