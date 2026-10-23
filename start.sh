#!/usr/bin/env bash
# Build the static app inside PROJECT_DIR and serve it in the foreground.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3000}"
WEB_DIR="${OPENCODE_WEB_DIR:-/home/runner/work/_temp/omgithub-web}"
SOURCE_DIR="$ROOT_DIR/src"
BUILD_DIR="$ROOT_DIR/dist"

t() {
  /usr/bin/time -p "$@"
}

t mkdir -p "$WEB_DIR"

built=false
if [[ -f "$ROOT_DIR/package.json" ]]; then
  if [[ -f "$ROOT_DIR/package-lock.json" ]]; then
    t npm ci --no-audit --no-fund
  else
    t npm install --no-audit --no-fund
  fi

  if t node -e '
    const pkg = require(process.argv[1]);
    process.exit(pkg.scripts && pkg.scripts.build ? 0 : 1);
  ' "$ROOT_DIR/package.json"; then
    t npm run build
    built=true
  fi
fi

if [[ "$built" != true ]]; then
  t rm -rf "$BUILD_DIR"
  t mkdir -p "$BUILD_DIR"
  if [[ -d "$SOURCE_DIR" ]]; then
    t cp -R "$SOURCE_DIR/." "$BUILD_DIR/"
  fi
fi

if [[ ! -f "$BUILD_DIR/index.html" ]]; then
  echo "Build did not produce index.html in $BUILD_DIR" >&2
  exit 1
fi

t node -e '
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [project, directory, web] = process.argv.slice(1);
mkdirSync(web, { recursive: true });
writeFileSync(
  join(web, "deployment-output.json"),
  JSON.stringify({ project, directory }) + "\n"
);
' "$ROOT_DIR" "$BUILD_DIR" "$WEB_DIR"

exec /usr/bin/time -p python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$BUILD_DIR"
