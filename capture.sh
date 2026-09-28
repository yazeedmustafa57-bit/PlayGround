#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Accept exact URL and outside-source output dir; default-capture opens the URL,
# waits for rendered content, captures final-desktop.png + final-mobile.png,
# closes its own browser, exits 75 transient / 1 defect, leaves app running.
/usr/bin/time -p test -n "${CAPTURE_URL:?Set CAPTURE_URL.}"
/usr/bin/time -p test -n "${CAPTURE_DIR:?Set CAPTURE_DIR.}"
/usr/bin/time -p mkdir -p "${CAPTURE_DIR}"
/usr/bin/time -p node "${RUNTIME_DIR:?}/scripts/default-capture.mjs"
