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
#
# FLOOR / ALERT: 320 checked links/week = the pre-v5 design ceiling (20
# retailers x 8 links x 2 queries); 7 days x 96 = 672 max, ceil(320/7) = 46
# checked/day. scripts/link-smoke-monitor.mjs +
# .github/workflows/link-smoke-monitor.yml fail when a complete week has
# checked < 320, runs < 7, dead_rate > 10% or challenge_rate > 25%, and open a
# `link-smoke-alert` issue.
#
# IDEMPOTENCY: if `link_smoke:last_run_day` already equals today (UTC), the run
# is skipped. That key is stamped by both this script and the app's health
# after() runner, so the two paths cannot double-record the same day. On a
# failed run the day is NOT stamped, so the health fallback retries later.
#
# Secrets: none. The CLI posts to loopback and stores aggregate counters only.
set -euo pipefail

APP_CONTAINER="${REEMCO_APP_CONTAINER:-reemco-app-1}"
REDIS_CONTAINER="${REEMCO_REDIS_CONTAINER:-reemco-redis-1}"
DAY_KEY="link_smoke:last_run_day"
DAY_TTL_S=691200 # 8 days, the same TTL the app runner uses
DAY="$(date -u +%F)"

if ! docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null | grep -q true; then
  echo "link-smoke: app container $APP_CONTAINER is not running" >&2
  exit 1
fi

last="$(docker exec "$REDIS_CONTAINER" valkey-cli GET "$DAY_KEY" 2>/dev/null | tr -d '\r' || true)"
if [ "$last" = "$DAY" ]; then
  echo "link-smoke: already recorded for $DAY (day guard), skipping"
  exit 0
fi

echo "link-smoke: starting $DAY run (last=$last)"
if ! docker exec -w /app \
  -e SMOKE_BASE_URL=http://127.0.0.1:3000 \
  -e LINK_SMOKE_QUERY_POOL="${LINK_SMOKE_QUERY_POOL:-iphone 17 pro,nintendo switch 2,headphones,panadol,perfume,laptop,tv,air fryer,washing machine,coffee machine,backpack,playstation 5}" \
  -e LINK_SMOKE_QUERIES_PER_RUN="${LINK_SMOKE_QUERIES_PER_RUN:-6}" \
  -e LINK_SMOKE_PER_RETAILER="${LINK_SMOKE_PER_RETAILER:-8}" \
  -e LINK_SMOKE_MAX_CHECKS="${LINK_SMOKE_MAX_CHECKS:-96}" \
  -e LINK_SMOKE_SAMPLING_TIMEOUT_MS="${LINK_SMOKE_SAMPLING_TIMEOUT_MS:-22000}" \
  "$APP_CONTAINER" node scripts/dead-link-smoke.mjs; then
  # No day stamp: the health after() fallback retries later today.
  echo "link-smoke: run failed for $DAY — day not stamped, health fallback may retry" >&2
  exit 1
fi

# Stamp the day only after the ingest landed, so the app runner skips today.
docker exec "$REDIS_CONTAINER" valkey-cli SET "$DAY_KEY" "$DAY" EX "$DAY_TTL_S" >/dev/null
echo "link-smoke: recorded and day-stamped for $DAY"
