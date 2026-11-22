#!/usr/bin/env bash
# REEA-1044 — rollback to the previously deployed image tag.
#
#   /opt/reemco/scripts/rollback.sh [--tag <sha>]
#
# With no --tag it reads /etc/reemco/image-tag.prev.env, which deploy.sh writes
# before every change. That is the whole rollback path: redeploy the previous
# artifact, then run the same verification gate a deploy runs.
set -euo pipefail

COMPOSE=/opt/reemco/compose.prod.yml
ETC=/etc/reemco
TAG_FILE="$ETC/image-tag.env"
PREV_FILE="$ETC/image-tag.prev.env"
RELEASE_ENV="$ETC/release.env"
LOG=/var/log/reemco/deploy.log

TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    *) echo "rollback.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }

if [ -z "$TAG" ]; then
  [ -f "$PREV_FILE" ] || { log "FAILED: no previous tag recorded — nothing to roll back to"; exit 1; }
  TAG=$(sed -n 's/^REEMCO_IMAGE_TAG=//p' "$PREV_FILE" | tail -1)
fi
printf '%s' "$TAG" | grep -Eq '^[0-9a-f]{40}$' || { log "FAILED: rollback tag '$TAG' is not a commit sha"; exit 1; }

CURRENT=$(sed -n 's/^REEMCO_IMAGE_TAG=//p' "$TAG_FILE" | tail -1)
log "rollback: $CURRENT -> $TAG"

# Swap the rollback target the other way so a failed rollback can be undone by
# re-running rollback.sh (idempotency: rollback is just another deploy).
if [ -n "$CURRENT" ]; then
  printf 'REEMCO_IMAGE_TAG=%s\n' "$CURRENT" > "$PREV_FILE"
fi

docker compose -f "$COMPOSE" --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" pull app >>"$LOG" 2>&1 \
  || log "warning: pull failed, trying the locally cached $TAG image"

printf 'REEMCO_IMAGE_TAG=%s\n' "$TAG" > "$TAG_FILE"
docker compose -f "$COMPOSE" --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" up -d --remove-orphans >>"$LOG" 2>&1 \
  || { log "FAILED: compose up for rollback tag $TAG"; exit 1; }

if /opt/reemco/scripts/verify.sh --tag "$TAG"; then
  log "rollback verified: $TAG"
else
  log "FAILED: rollback to $TAG did not verify"
  exit 1
fi
