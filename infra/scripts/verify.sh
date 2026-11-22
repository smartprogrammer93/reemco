#!/usr/bin/env bash
# REEA-1044 — post-deploy verification gate. A deploy is only "done" when this
# passes. A rollback is verified by the exact same checks (no special path).
#
#   /opt/reemco/scripts/verify.sh --tag <sha> [--base https://host]
#
# Checks, in order:
#   1. /__commit.txt equals the tag that was deployed (artifact identity)
#   2. the four security headers the Vercel pipeline asserts are present
#   3. /api/health answers 200 through the proxy
#   4. container hardening on the running stack (REEA-1061): non-root redis and
#      proxy, cap_drop ALL, read-only rootfs, pinned image digests, segmented
#      networks. Runs only when docker is available (i.e. on the host).
# Exit 0 = verified; non-zero = treat the deploy as failed.
set -uo pipefail

TAG=""
BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    *) echo "verify.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$BASE" ] && [ -f /etc/reemco/release.env ]; then
  BASE=$(sed -n 's/^REEMCO_SITE_ADDRESS=//p' /etc/reemco/release.env | tail -1)
fi
[ -n "$BASE" ] || { echo "verify.sh: no --base and no REEMCO_SITE_ADDRESS" >&2; exit 2; }
# A bare IP has no TLS; a hostname does.
case "$BASE" in
  http://*|https://*) : ;;
  *) BASE="https://$BASE" ;;
esac
BASE="${BASE%/}"

fail() { echo "VERIFY FAILED: $*" >&2; exit 1; }
echo "verifying $BASE"

# 1. Artifact identity. Retry briefly: Caddy may still be warming the upstream.
SERVED=""
for _ in $(seq 1 20); do
  SERVED=$(curl -fsS -m 10 "$BASE/__commit.txt" 2>/dev/null | tr -d '[:space:]' || true)
  [ "$SERVED" = "$TAG" ] && break
  sleep 3
done
if [ -z "$TAG" ]; then
  echo "commit stamp: $SERVED (no --tag given, not compared)"
elif [ "$SERVED" != "$TAG" ]; then
  fail "commit stamp mismatch: served '$SERVED' != deployed '$TAG'"
else
  echo "commit stamp OK: $SERVED"
fi

# 2. Security headers. The app's middleware owns CSP/CTO/Referrer-Policy;
# Caddy adds HSTS. Missing any of them means the proxy or app is misconfigured.
HEADERS=$(curl -fsSI -m 15 "$BASE/" 2>/dev/null || true)
[ -n "$HEADERS" ] || fail "GET / returned no headers"
for H in content-security-policy x-content-type-options referrer-policy strict-transport-security; do
  printf '%s\n' "$HEADERS" | grep -iq "^$H:" || fail "missing security header: $H"
done
echo "security headers OK (4/4)"

# 3. Health through the proxy — proves Caddy→app routing, not just loopback.
# REEA-1044: this endpoint walks the live shopper funnel (home → results →
# product against real retailer adapters), so a single sample is not a stable
# gate: a cold walk legitimately takes ~20-26 s and one transient adapter
# error returns 503. Retry with a generous per-attempt timeout instead of
# failing the deploy on the first flake; a genuinely dead origin still fails
# every attempt. The gate is "eventually healthy", not "healthy on one sample".
HEALTH_OK=0
for attempt in 1 2 3 4 5; do
  CODE=$(curl -s -o /tmp/reemco-health.json -w '%{http_code}' -m 45 "$BASE/api/health" || echo 000)
  if [ "$CODE" = "200" ]; then HEALTH_OK=1; break; fi
  echo "health attempt $attempt/5 returned $CODE — retrying in 15s"
  sleep 15
done
[ "$HEALTH_OK" = "1" ] || fail "/api/health never returned 200 (last: $CODE)"
echo "health OK: 200"

# 4. Container hardening (REEA-1061). The compose file is only a declaration;
# this proves the RUNNING containers actually carry it. It needs the docker CLI
# and daemon, so it is skipped when verify.sh is run from outside the host (the
# external CI step still covers stamp/headers over the public surface).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ASSERT=/opt/reemco/scripts/assert-containers.sh
  [ -x "$ASSERT" ] || fail "missing $ASSERT (infra/scripts/assert-containers.sh was not synced)"
  "$ASSERT" || fail "container hardening assertions failed (see FAIL lines above)"
else
  echo "container hardening: skipped (docker unavailable in this shell)"
fi

echo "VERIFY PASSED for ${TAG:-$BASE}"
