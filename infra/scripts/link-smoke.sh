#!/usr/bin/env bash
# infra/scripts/link-smoke.sh — REEA-1252: daily dead-link smoke (link-rot guardrail).
#
# SCHEDULE: reemco-link-smoke.timer, daily 09:10 UTC (host systemd; installed by
# infra/ansible/playbook.yml). The app's /api/health after() runner remains the
# once-per-UTC-day fallback, so a missed timer still gets a run that day.
#
# SAMPLE RULE (see scripts/dead-link-smoke.mjs header for the full statement):
# 6 broad queries/day from a 12-query UTC-day-rotated pool, offers read LIVE
# from /api/results-followup (the rendered results/PDP offer population), max 8
# links per retailer, max 96 links per run, spread round-robin across retailers.
# If the rotated day plans under the 46/run floor the script tops up from the
# remaining pool queries (bounded), so a thin day cannot under-fill the week.
#
# FLOOR / ALERT: 320 checked links/week = the pre-v5 design ceiling (20
# retailers x 8 links x 2 queries); 7 days x 96 = 672 max, ceil(320/7) = 46
# checked/day. scripts/link-smoke-monitor.mjs +
# .github/workflows/link-smoke-monitor.yml fail when a complete week has
# checked < 320, runs < 7, dead_rate > 10% or challenge_rate > 25%, and open a
# `link-smoke-alert` issue.
#
# SLOT (REEA-1262): the app runs as a blue/green pair (`app` on host loopback
# 3000, `app_green` on host loopback 3001). The ACTIVE slot is recorded in
# /etc/reemco/image-tag.env, so the smoke resolves which CONTAINER to exec into
# from there — a hardcoded `reemco-app-1` would measure a stopped/old slot after
# a switch and fail the schedule. If the recorded slot is not running, the other
# slot is tried; if neither is up, exit 1. The CLI always talks to the
# container's OWN loopback 3000 (the host port only maps to it), never the host
# port — inside the container 3001 is not bound.
#
# IDEMPOTENCY: if `link_smoke:last_run_day` already equals today (UTC), the run
# is skipped. That key is stamped by both this script and the app's health
# after() runner, so the two paths cannot double-record the same day. On a
# failed run the day is NOT stamped, so the health fallback retries later.
#
# Secrets: none. The CLI posts to loopback and stores aggregate counters only.
set -euo pipefail

TAG_FILE=/etc/reemco/image-tag.env
ACTIVE=$(sed -n 's/^REEMCO_ACTIVE_SLOT=//p' "$TAG_FILE" 2>/dev/null | tail -1 || true)
case "$ACTIVE" in
  app_green)
    APP_CONTAINER="${REEMCO_APP_CONTAINER:-reemco-app_green-1}"
    OTHER_CONTAINER="reemco-app-1"
    ;;
  app)
    APP_CONTAINER="${REEMCO_APP_CONTAINER:-reemco-app-1}"
    OTHER_CONTAINER="reemco-app_green-1"
    ;;
  *)
    echo "link-smoke: no REEMCO_ACTIVE_SLOT in $TAG_FILE; falling back to the blue slot" >&2
    APP_CONTAINER="${REEMCO_APP_CONTAINER:-reemco-app-1}"
    OTHER_CONTAINER="reemco-app_green-1"
    ACTIVE="app"
    ;;
esac
REDIS_CONTAINER="${REEMCO_REDIS_CONTAINER:-reemco-redis-1}"
DAY_KEY="link_smoke:last_run_day"
DAY_TTL_S=691200 # 8 days, the same TTL the app runner uses
DAY="$(date -u +%F)"

running() {
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true
}

if ! running "$APP_CONTAINER"; then
  if running "$OTHER_CONTAINER"; then
    echo "link-smoke: active slot $APP_CONTAINER is not running; using $OTHER_CONTAINER" >&2
    APP_CONTAINER="$OTHER_CONTAINER"
  else
    echo "link-smoke: neither app slot is running ($APP_CONTAINER, $OTHER_CONTAINER)" >&2
    exit 1
  fi
fi

last="$(docker exec "$REDIS_CONTAINER" valkey-cli GET "$DAY_KEY" 2>/dev/null | tr -d '\r' || true)"
if [ "$last" = "$DAY" ]; then
  echo "link-smoke: already recorded for $DAY (day guard), skipping"
  exit 0
fi

echo "link-smoke: starting $DAY run against $APP_CONTAINER (slot $ACTIVE) (last=$last)"
if ! docker exec -w /app \
  -e SMOKE_BASE_URL="http://127.0.0.1:3000" \
  -e LINK_SMOKE_QUERY_POOL="${LINK_SMOKE_QUERY_POOL:-iphone 17 pro,nintendo switch 2,headphones,panadol,perfume,laptop,tv,air fryer,washing machine,coffee machine,backpack,playstation 5}" \
  -e LINK_SMOKE_QUERIES_PER_RUN="${LINK_SMOKE_QUERIES_PER_RUN:-6}" \
  -e LINK_SMOKE_PER_RETAILER="${LINK_SMOKE_PER_RETAILER:-8}" \
  -e LINK_SMOKE_MAX_CHECKS="${LINK_SMOKE_MAX_CHECKS:-96}" \
  -e LINK_SMOKE_DAILY_FLOOR="${LINK_SMOKE_DAILY_FLOOR:-46}" \
  -e LINK_SMOKE_TOPUP_MAX_QUERIES="${LINK_SMOKE_TOPUP_MAX_QUERIES:-6}" \
  -e LINK_SMOKE_SAMPLING_TIMEOUT_MS="${LINK_SMOKE_SAMPLING_TIMEOUT_MS:-22000}" \
  "$APP_CONTAINER" node scripts/dead-link-smoke.mjs; then
  # No day stamp: the health after() fallback retries later today.
  echo "link-smoke: run failed for $DAY — day not stamped, health fallback may retry" >&2
  exit 1
fi

# Stamp the day only after the ingest landed, so the app runner skips today.
docker exec "$REDIS_CONTAINER" valkey-cli SET "$DAY_KEY" "$DAY" EX "$DAY_TTL_S" >/dev/null
echo "link-smoke: recorded and day-stamped for $DAY"
