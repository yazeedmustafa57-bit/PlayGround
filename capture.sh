#!/usr/bin/env bash
# Capture desktop + mobile screenshots of the exact preview URL.
# Uses CAPTURE_URL and CAPTURE_DIR. Leaves the app running.
set -euo pipefail
cd "$(dirname "$0")"

: "${CAPTURE_URL:?Set CAPTURE_URL to the exact preview URL.}"
: "${CAPTURE_DIR:?Set CAPTURE_DIR to the evidence output directory.}"
/usr/bin/time -p mkdir -p "$CAPTURE_DIR"
/usr/bin/time -p test -n "$CAPTURE_URL"

/usr/bin/time -p node "${RUNTIME_DIR:?}/scripts/default-capture.mjs"

# Verify both PNGs exist and are valid (exit 1 = rendering/script defect).
/usr/bin/time -p python3 -c "import os,sys; d=os.environ['CAPTURE_DIR']; req=['final-desktop.png','final-mobile.png']; png=b'\x89PNG\r\n\x1a\n'; bad=[n for n in req if not (os.path.isfile(os.path.join(d,n)) and os.path.getsize(os.path.join(d,n))>24 and open(os.path.join(d,n),'rb').read(8)==png)]; sys.exit('Missing/invalid capture: '+' '.join(bad)) if bad else print('Captures OK: '+' '.join(req))"
/usr/bin/time -p ls -lh "$CAPTURE_DIR/final-desktop.png" "$CAPTURE_DIR/final-mobile.png"
