#!/usr/bin/env bash
# Capture desktop and mobile screenshots of a rendered page.
set -euo pipefail

: "${CAPTURE_URL:?CAPTURE_URL is required}"
: "${CAPTURE_DIR:?CAPTURE_DIR is required}"

mkdir -p "$CAPTURE_DIR"
if [[ -z "${DISPLAY:-}" && -S /tmp/.X11-unix/X0 ]]; then
  export DISPLAY=:0
fi

SESSION="capture-$$-$(date +%s)"
DESKTOP="$CAPTURE_DIR/final-desktop.png"
MOBILE="$CAPTURE_DIR/final-mobile.png"

t() {
  /usr/bin/time -p "$@"
}

close_browser() {
  t playwright-cli -s="$SESSION" close >/dev/null 2>&1 || true
}
trap close_browser EXIT

# Open the exact capture URL in a dedicated browser session.
if ! t playwright-cli -s="$SESSION" open "$CAPTURE_URL"; then
  echo "Unable to open $CAPTURE_URL (temporary browser or navigation failure)." >&2
  exit 75
fi

# Wait for a rendered heading, which proves the page painted real content.
probe='JSON.stringify((() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const heading = document.querySelector("h1, h2, [data-rendered]");
  return {
    status: nav ? nav.responseStatus : null,
    title: document.title,
    ready: document.readyState,
    heading: heading ? heading.textContent.trim() : null,
    text: document.body ? document.body.innerText.slice(0, 200) : ""
  };
})())'

rendered=false
probe_output=""
for ((attempt = 0; attempt < 45; attempt++)); do
  if probe_output="$(t playwright-cli -s="$SESSION" --raw eval "$probe" 2>/dev/null)"; then
    if [[ "$(printf '%s' "$probe_output" | jq -r 'if type == "string" then fromjson else . end | .heading // empty' 2>/dev/null)" != "" ]]; then
      rendered=true
      break
    fi
  fi
  t sleep 1
done

if [[ "$rendered" != true ]]; then
  status="$(printf '%s' "$probe_output" | jq -r 'if type == "string" then fromjson else . end | .status // 0' 2>/dev/null || echo 0)"
  echo "No rendered content at $CAPTURE_URL: ${probe_output:-no probe output}" >&2
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    echo "Navigation returned HTTP $status (temporary failure)." >&2
    exit 75
  fi
  exit 1
fi

# Desktop view.
if ! t playwright-cli -s="$SESSION" resize 1440 900; then
  echo "Unable to resize the desktop viewport." >&2
  exit 75
fi
if ! t playwright-cli -s="$SESSION" screenshot --filename="$DESKTOP"; then
  echo "Unable to capture the desktop view." >&2
  exit 75
fi

# Mobile view.
if ! t playwright-cli -s="$SESSION" resize 390 844; then
  echo "Unable to resize the mobile viewport." >&2
  exit 75
fi
if ! t playwright-cli -s="$SESSION" screenshot --filename="$MOBILE"; then
  echo "Unable to capture the mobile view." >&2
  exit 75
fi

for shot in "$DESKTOP" "$MOBILE"; do
  if [[ ! -s "$shot" ]]; then
    echo "Screenshot missing or empty: $shot" >&2
    exit 1
  fi
done

close_browser
trap - EXIT
exit 0
