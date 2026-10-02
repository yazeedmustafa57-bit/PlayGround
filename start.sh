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

# Victor Secret-Restore: persistente Ablage außerhalb des Git-Repos (0600).
# Stellt $APP_DIR/.env nach einem Rebuild wieder her, falls sie fehlt.
# Es werden niemals Werte geloggt oder ausgegeben.
VICTOR_SECRETS_STORE="/home/runner/work/_temp/victor-secrets.env"
if [ ! -f "$APP_DIR/.env" ] && [ -f "$VICTOR_SECRETS_STORE" ]; then
  cp "$VICTOR_SECRETS_STORE" "$APP_DIR/.env"
  chmod 0600 "$APP_DIR/.env"
fi
# PUBLIC_BASE_URL dynamisch aus der aktuellen Tunnel-URL (ändert sich pro Neustart).
if [ -f "$APP_DIR/.env" ] && [ -f "$WEB_DIR/app-url" ]; then
  TUNNEL_URL="$(cat "$WEB_DIR/app-url")"
  if [ -n "$TUNNEL_URL" ]; then
    ESCAPED_URL="$(printf '%s' "$TUNNEL_URL" | sed 's/[&|\\]/\\&/g')"
    sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=${ESCAPED_URL}|" "$APP_DIR/.env"
    chmod 0600 "$APP_DIR/.env"
  fi
fi

/usr/bin/time -p mkdir -p "$WEB_DIR"
/usr/bin/time -p bash -c 'printf "%s" "{\"project\":\"/home/runner/work/PlayGround/PlayGround\",\"directory\":\"/home/runner/work/PlayGround/PlayGround/victor-ai-assistant/public\"}" > "$1/deployment-output.json"' _ "$WEB_DIR"
/usr/bin/time -p test -f "$APP_DIR/package.json"
/usr/bin/time -p test -f "$STATIC_DIR/index.html"
/usr/bin/time -p bash -c 'cd "$1" && npm install --no-audit --no-fund' _ "$APP_DIR"
/usr/bin/time -p bash -c 'cd "$1" && node -e "JSON.parse(require(\"fs\").readFileSync(\"package.json\",\"utf8\")); console.log(\"package.json OK\")"' _ "$APP_DIR"
cd "$APP_DIR"
exec /usr/bin/time -p node src/server.js
