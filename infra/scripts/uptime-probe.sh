#!/usr/bin/env bash
# REEA-1194 — availability record for /api/health and /__commit.txt.
#
# Why: the 7-day availability question had no durable answer on the box. The
# legacy reemco-health.timer only samples /api/health twice a day and writes to
# the journal, and the GitHub-hosted probe measures the public pages, not these
# two routes. This script is the on-box half of the record: a timestamped JSONL
# line every run, so "was the app answering at 02:40?" has a file to read
# instead of a journal that rotates.
#
# Scope / Least Privilege: read-only HTTP against loopback. No secrets, no
# credentials, no writes outside /var/log/reemco. It runs as root only because
# /var/log/reemco is root-owned; the work itself needs no privilege.
#
# Loopback only, deliberately: this records the APP. The public edge (DNS, TLS,
# Caddy) is measured by .github/workflows/uptime.yml from outside the box, which
# is also the only probe that survives the box dying.
#
# Record:  /var/log/reemco/uptime.jsonl  (one JSON object per run, self-rotated)
# Alerts:  /var/log/reemco/uptime-alerts.log + a failed systemd unit (journal).
#          A failed unit is NOT a human alert by itself — the human-facing alert
#          is the deduped GitHub issue opened by .github/workflows/uptime.yml.
#
# Usage: /opt/reemco/scripts/uptime-probe.sh
# Exit:  0 = both routes answered and matched; 1 = a route failed (alert line
#         written, systemd unit goes red).
set -uo pipefail

RECORD=${UPTIME_RECORD:-/var/log/reemco/uptime.jsonl}
ALERTS=${UPTIME_ALERTS:-/var/log/reemco/uptime-alerts.log}
HEALTH_URL=${UPTIME_HEALTH_URL:-http://127.0.0.1:3000/api/health}
COMMIT_URL=${UPTIME_COMMIT_URL:-http://127.0.0.1:3000/__commit.txt}
TIMEOUT_S=${UPTIME_TIMEOUT_S:-45}
# 20 MB at ~1 line/10 min is ~3 years; rotate anyway so a bad loop cannot fill
# the disk. One previous file is kept for post-incident forensics.
MAX_RECORD_BYTES=${UPTIME_MAX_RECORD_BYTES:-20971520}

ts=$(date -u +%FT%TZ)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# curl only creates the -o file after it connects, so pre-create both: the
# parsers below must never trip on a missing file after a dead route.
: >"$tmp/health.json"
: >"$tmp/commit.txt"

probe() { # <url> <outfile> -> "<http_code> <seconds>"
  local url="$1" out="$2" res
  res=$(curl -sS -m "$TIMEOUT_S" -o "$out" -w '%{http_code} %{time_total}' "$url" 2>/dev/null || true)
  [ -n "$res" ] || res="000 0"
  printf '%s' "$res"
}

read -r hcode htime <<<"$(probe "$HEALTH_URL" "$tmp/health.json")"
read -r ccode ctime <<<"$(probe "$COMMIT_URL" "$tmp/commit.txt")"

# /api/health must be a real 200 with ok:true and a build stamp; a 200 error
# envelope or an empty body is a failure, not availability.
build=$(jq -r '.build // empty' "$tmp/health.json" 2>/dev/null || true)
okfield=$(jq -r '.ok // false' "$tmp/health.json" 2>/dev/null || true)
sha=$(tr -d '[:space:]' <"$tmp/commit.txt" 2>/dev/null | head -c 64 || true)

health_ok=false
commit_ok=false
[ "$hcode" = "200" ] && [ "$okfield" = "true" ] && [[ "$build" =~ ^[0-9a-f]{12,40}$ ]] && health_ok=true
[ "$ccode" = "200" ] && [[ "$sha" =~ ^[0-9a-f]{40}$ ]] && commit_ok=true
ok=false
[ "$health_ok" = "true" ] && [ "$commit_ok" = "true" ] && ok=true

if [ -f "$RECORD" ] && [ "$(stat -c %s "$RECORD" 2>/dev/null || echo 0)" -gt "$MAX_RECORD_BYTES" ]; then
  mv -f "$RECORD" "$RECORD.1"
fi

jq -nc \
  --arg ts "$ts" \
  --arg hc "$hcode" --arg ht "$htime" --arg hb "$build" \
  --arg cc "$ccode" --arg ct "$ctime" --arg cs "$sha" \
  --argjson ok "$ok" \
  '{ts:$ts,
    health_code:($hc|tonumber? // 0), health_s:($ht|tonumber? // 0), health_build:$hb,
    commit_code:($cc|tonumber? // 0), commit_s:($ct|tonumber? // 0), commit_sha:$cs,
    ok:$ok}' >>"$RECORD" 2>/dev/null \
  || printf '%s {"ts":"%s","health_code":"%s","commit_code":"%s","ok":%s}\n' \
       "$ts" "$ts" "$hcode" "$ccode" "$ok" >>"$RECORD"

if [ "$ok" = "true" ]; then
  printf '%s OK health=%s/%ss build=%s commit=%s/%ss\n' "$ts" "$hcode" "$htime" "$build" "$ccode" "$ctime"
  exit 0
fi

printf '%s ALERT health=%s/%ss ok=%s build=%s commit=%s/%ss sha=%s\n' \
  "$ts" "$hcode" "$htime" "$okfield" "$build" "$ccode" "$ctime" "$sha" \
  | tee -a "$ALERTS" >&2
exit 1
