#!/usr/bin/env bash
# Once-per-worker prerequisites for building and capturing the app.
set -euo pipefail

# Idempotent: verifies the exact Chromium build the CLI expects and skips the download when present.
/usr/bin/time -p playwright-cli install-browser chromium
