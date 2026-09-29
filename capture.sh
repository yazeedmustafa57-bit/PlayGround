#!/usr/bin/env bash
# Capture desktop + mobile screenshots of exactly $CAPTURE_URL into $CAPTURE_DIR.
# Leaves the app running, keeps all output outside the source tree.
# Exit 75: temporary navigation/browser infrastructure failure.
# Exit 1:  script usage defect or rendering defect.
set -euo pipefail

: "${CAPTURE_URL:?CAPTURE_URL environment variable is required}"
: "${CAPTURE_DIR:?CAPTURE_DIR environment variable is required}"

/usr/bin/time -p mkdir -p "$CAPTURE_DIR"

BROWSER=""
for candidate in google-chrome chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BROWSER="$candidate"
    break
  fi
done
if [[ -z "$BROWSER" ]]; then
  echo "capture: no chromium browser found (infrastructure failure)" >&2
  exit 75
fi
echo "capture: using browser $BROWSER"

/usr/bin/time -p "$BROWSER" --version || exit 75

# Pre-check: exact URL must answer. 000/timeout/5xx = temporary (75), 4xx = defect (1).
HTTP_CODE="$(/usr/bin/time -p curl --silent --location --max-time 30 --output /dev/null --write-out '%{http_code}' "$CAPTURE_URL" || echo 000)"
echo "capture: pre-check HTTP $HTTP_CODE for $CAPTURE_URL"
if [[ "$HTTP_CODE" == "000" || "$HTTP_CODE" == 5* || "$HTTP_CODE" == 408 || "$HTTP_CODE" == 429 ]]; then
  echo "capture: temporary navigation failure (HTTP $HTTP_CODE)" >&2
  exit 75
fi
if [[ "$HTTP_CODE" == 4* ]]; then
  echo "capture: URL rejected with HTTP $HTTP_CODE (rendering defect)" >&2
  exit 1
fi

PROFILE_DIR="$(/usr/bin/time -p mktemp -d)"
cleanup() { /usr/bin/time -p rm -rf "$PROFILE_DIR"; }
trap cleanup EXIT

COMMON_FLAGS=(--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
  --hide-scrollbars --no-first-run --no-default-browser-check
  --user-data-dir="$PROFILE_DIR" --virtual-time-budget=10000 --timeout=90000)

if ! /usr/bin/time -p timeout 120s "$BROWSER" "${COMMON_FLAGS[@]}" \
  --window-size=1280,800 "--screenshot=$CAPTURE_DIR/final-desktop.png" "$CAPTURE_URL"; then
  echo "capture: desktop browser run failed (infrastructure failure)" >&2
  exit 75
fi

# Fresh profile for the mobile pass.
/usr/bin/time -p rm -rf "$PROFILE_DIR"
/usr/bin/time -p mkdir -p "$PROFILE_DIR"
if ! /usr/bin/time -p timeout 120s "$BROWSER" "${COMMON_FLAGS[@]}" \
  --window-size=390,844 \
  --user-agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" \
  "--screenshot=$CAPTURE_DIR/final-mobile.png" "$CAPTURE_URL"; then
  echo "capture: mobile browser run failed (infrastructure failure)" >&2
  exit 75
fi

# Validate renders: files must exist, be PNGs, and carry real pixels.
/usr/bin/time -p test -s "$CAPTURE_DIR/final-desktop.png" || { echo "capture: final-desktop.png missing/empty (rendering defect)" >&2; exit 1; }
/usr/bin/time -p test -s "$CAPTURE_DIR/final-mobile.png" || { echo "capture: final-mobile.png missing/empty (rendering defect)" >&2; exit 1; }
/usr/bin/time -p bash -c 'head -c 8 "$1" | grep -q "PNG" || exit 1' _ "$CAPTURE_DIR/final-desktop.png" || { echo "capture: final-desktop.png is not a PNG (rendering defect)" >&2; exit 1; }
/usr/bin/time -p bash -c 'head -c 8 "$1" | grep -q "PNG" || exit 1' _ "$CAPTURE_DIR/final-mobile.png" || { echo "capture: final-mobile.png is not a PNG (rendering defect)" >&2; exit 1; }

/usr/bin/time -p ls -l "$CAPTURE_DIR/final-desktop.png" "$CAPTURE_DIR/final-mobile.png"
echo "capture: OK (app left running)"
