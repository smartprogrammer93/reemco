#!/usr/bin/env bash
# REEA-1194 / REEA-1262 — scheduled loopback health probe.
#
# The app runs in a blue/green slot pair (REEA-1262): `app` publishes 3000 on
# loopback and `app_green` publishes 3001. The ACTIVE slot is recorded in
# /etc/reemco/image-tag.env. A hardcoded 127.0.0.1:3000 would silently probe an
# idle (stopped or old-build) slot after a switch, so resolve the port from the
# deploy state instead.
#
# Local loopback only: no TLS/DNS dependency, so the probe cannot fail because
# of Caddy or the certificate. A non-2xx exits non-zero and lands in the journal.
set -euo pipefail

TAG_FILE=/etc/reemco/image-tag.env
ACTIVE=$(sed -n 's/^REEMCO_ACTIVE_SLOT=//p' "$TAG_FILE" 2>/dev/null | tail -1 || true)
case "$ACTIVE" in
  app_green) PORT=3001 ;;
  app) PORT=3000 ;;
  *)
    echo "health-probe: no REEMCO_ACTIVE_SLOT in $TAG_FILE; falling back to the blue slot" >&2
    PORT=3000
    ACTIVE="app"
    ;;
esac

curl -fsS -m 45 -o /dev/null \
  -w "health %{http_code} in %{time_total}s (slot ${ACTIVE} port ${PORT})\n" \
  "http://127.0.0.1:${PORT}/api/health"
