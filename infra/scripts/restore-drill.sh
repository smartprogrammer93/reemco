#!/usr/bin/env bash
# REEA-1048 — restore drill for the off-box backup.
#
# Restores the latest snapshot into a scratch directory and verifies a sample
# of the durable state (metrics + events) against the live volumes. It writes
# only to the scratch directory and never touches the running app, so it is
# safe to run against production at any time.
#
# Usage (root, with /etc/reemco/backup.env sourced):
#   sudo bash -c 'set -a; . /etc/reemco/backup.env; set +a; /opt/reemco/scripts/restore-drill.sh'
#   sudo bash -c '...' /opt/reemco/scripts/restore-drill.sh /var/tmp/my-scratch
#
# Exit status: 0 = snapshot restored and sample verified; 1 = restore/verify failed.
set -euo pipefail
: "${RESTIC_REPOSITORY:?source backup.env first (RESTIC_REPOSITORY)}"
: "${RESTIC_PASSWORD_FILE:?source backup.env first (RESTIC_PASSWORD_FILE)}"

SCRATCH=${1:-/var/tmp/reemco-restore-drill}
VOL_ROOT=/var/lib/docker/volumes
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

log "restore drill -> $SCRATCH (repo $RESTIC_REPOSITORY)"
rm -rf "$SCRATCH"
install -d -m 700 "$SCRATCH"

# Absolute paths are recreated under the scratch root, so the restored volume
# data lands at $SCRATCH/var/lib/docker/volumes/<volume>/_data/...
restic restore latest --target "$SCRATCH" --tag reemco-prod
SNAP=$(restic snapshots --latest 1 --json | jq -r '.[0].short_id // empty')
log "restored snapshot ${SNAP:-unknown}"

fail=0
check_json() { # <restored file> <live file> <label>
  local r="$1" l="$2" label="$3"
  [ -f "$r" ] || { log "FAIL $label: restored file missing ($r)"; fail=1; return; }
  jq empty "$r" 2>/dev/null || { log "FAIL $label: restored JSON does not parse"; fail=1; return; }
  if [ -f "$l" ] && cmp -s "$r" "$l"; then
    log "OK $label: byte-identical to live ($(sha256sum "$r" | cut -c1-16))"
  else
    log "OK $label: restored copy parses; live copy differs (expected if it changed after the snapshot)"
  fi
}

# metrics: single JSON document
check_json "$SCRATCH$VOL_ROOT/reemco_metrics/_data/metrics.json" \
           "$VOL_ROOT/reemco_metrics/_data/metrics.json" "metrics/metrics.json"

# events: append-only JSONL. Every restored line must still exist live, so a
# line-level subset check proves the snapshot holds real records.
EV="$SCRATCH$VOL_ROOT/reemco_events/_data/events.jsonl"
LV="$VOL_ROOT/reemco_events/_data/events.jsonl"
if [ -f "$EV" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf '%s\n' "$line" | jq empty 2>/dev/null \
      || { log "FAIL events/events.jsonl: a restored line does not parse"; fail=1; break; }
  done < "$EV"
  missing=$(comm -23 <(sort -u "$EV") <(sort -u "$LV" 2>/dev/null) | wc -l)
  if [ "$missing" -eq 0 ]; then
    log "OK events/events.jsonl: $(wc -l < "$EV") restored lines, all present in live volume"
  else
    log "FAIL events/events.jsonl: $missing restored lines are absent from the live volume"
    fail=1
  fi
else
  log "FAIL events/events.jsonl: restored file missing"; fail=1
fi

# collect store: three JSON documents that must parse.
for f in last-seen.json completed-jobs.json job-snapshots.json; do
  check_json "$SCRATCH$VOL_ROOT/reemco_collect/_data/$f" \
             "$VOL_ROOT/reemco_collect/_data/$f" "collect/$f"
done

if [ "$fail" -ne 0 ]; then
  log "restore drill FAILED (scratch kept at $SCRATCH for inspection)"
  exit 1
fi
log "restore drill PASSED (snapshot ${SNAP:-unknown}; scratch at $SCRATCH)"
