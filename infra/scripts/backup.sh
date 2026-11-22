#!/usr/bin/env bash
# REEA-1044/REEA-1048 — backup of the durable app state.
#
# Runs from reemco-backup.timer with /etc/reemco/backup.env injected:
#   RESTIC_REPOSITORY=s3:...           (or any restic backend)
#   RESTIC_PASSWORD_FILE=/etc/reemco/restic.pass   (0600, root)
#   BACKUP_PATHS=/var/lib/docker/volumes/...   (optional override)
#
# RAID is not backup. This is the only copy that survives losing the box.
#
# The app's durable state lives in docker named volumes (compose.prod.yml
# mounts events/metrics/collect/redis). There is no /data on the host, so the
# default path list below is the volume mountpoints — a backup pointed at
# /data/* would fail restic's path check and never capture the real data.
set -euo pipefail
LOG=/var/log/reemco/backup.log
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }

: "${RESTIC_REPOSITORY:?backup.env must set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?backup.env must set RESTIC_PASSWORD_FILE}"
[ -r "$RESTIC_PASSWORD_FILE" ] || { log "ERROR: RESTIC_PASSWORD_FILE not readable"; exit 1; }

VOL_ROOT=/var/lib/docker/volumes
DEFAULT_PATHS="$VOL_ROOT/reemco_metrics/_data $VOL_ROOT/reemco_events/_data $VOL_ROOT/reemco_collect/_data $VOL_ROOT/reemco_redis/_data"
PATHS=${BACKUP_PATHS:-$DEFAULT_PATHS}
# Include the deployable config so a rebuild does not depend on remembering it.
PATHS="$PATHS /opt/reemco /etc/reemco"

# Fail fast on a missing path instead of letting restic silently back up less
# than we think it does (or abort halfway through the run).
for p in $PATHS; do
  [ -e "$p" ] || { log "ERROR: backup path missing: $p"; exit 1; }
done

# KV consistency: ask Valkey for a fresh RDB so the snapshot contains a
# self-consistent keyspace, not just whatever AOF tail happened to be flushed.
if docker inspect reemco-redis-1 >/dev/null 2>&1; then
  if docker exec reemco-redis-1 valkey-cli BGSAVE >/dev/null 2>&1; then
    for _ in $(seq 1 60); do
      if docker exec reemco-redis-1 valkey-cli --raw info persistence 2>/dev/null \
           | grep -q 'rdb_bgsave_in_progress:0'; then break; fi
      sleep 1
    done
    log "valkey BGSAVE requested (fresh dump.rdb included)"
  else
    log "warning: valkey BGSAVE failed; backing up the AOF as-is"
  fi
fi

log "backup start -> $RESTIC_REPOSITORY"
# shellcheck disable=SC2086
restic backup $PATHS \
  --exclude='*.log' \
  --exclude='/etc/reemco/restic.pass' \
  --tag reemco-prod >>"$LOG" 2>&1

# Retention: 7 daily, 4 weekly, 6 monthly. Prune is separate so a failed prune
# cannot invalidate a successful backup run.
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune >>"$LOG" 2>&1 \
  || log "warning: prune failed (backup itself succeeded)"

restic check --read-data-subset=5% >>"$LOG" 2>&1 || log "warning: restic check failed"

# Record the snapshot id so the log proves what landed in the repository.
SNAP=$(restic snapshots --latest 1 --json 2>/dev/null | jq -r '.[0].short_id // empty' 2>/dev/null || true)
log "backup done snapshot=${SNAP:-unknown}"
