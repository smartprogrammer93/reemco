#!/usr/bin/env bash
# REEA-1044 — off-box backup of the durable app state.
#
# Runs from reemco-backup.timer with /etc/reemco/backup.env injected:
#   RESTIC_REPOSITORY=s3:...           (or any restic backend)
#   RESTIC_PASSWORD_FILE=/etc/reemco/restic.pass   (0600, root)
#   BACKUP_PATHS=/data/events /data/metrics /data/collect   (optional override)
#
# RAID is not backup. This is the only copy that survives losing the box.
set -euo pipefail
LOG=/var/log/reemco/backup.log
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }

: "${RESTIC_REPOSITORY:?backup.env must set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?backup.env must set RESTIC_PASSWORD_FILE}"

PATHS=${BACKUP_PATHS:-/data/events /data/metrics /data/collect}
# Include the deployable config so a rebuild does not depend on remembering it.
PATHS="$PATHS /opt/reemco /etc/reemco"

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

log "backup done"
