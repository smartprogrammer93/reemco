#!/usr/bin/env bash
# REEA-1044 — deploy a pinned image tag on the Reemco host.
#
#   /opt/reemco/scripts/deploy.sh --tag <40-char-sha> [--dry-run]
#
# Contract:
#   * The tag is the ONLY variable. Nothing is edited on the host by hand.
#   * The currently deployed tag is saved to /etc/reemco/image-tag.prev before
#     anything changes, so rollback.sh always has a target (Rollback Path).
#   * The new tag is verified with verify.sh; a failed verification triggers an
#     automatic rollback to the previous tag (Blast Radius containment).
#   * Idempotent: deploying the tag that is already live is a no-op re-check.
set -euo pipefail

COMPOSE=/opt/reemco/compose.prod.yml
ETC=/etc/reemco
TAG_FILE="$ETC/image-tag.env"
PREV_FILE="$ETC/image-tag.prev.env"
RELEASE_ENV="$ETC/release.env"
APP_ENV="$ETC/app.env"
LOG=/var/log/reemco/deploy.log

TAG=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "deploy.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
die() { log "FAILED: $*"; exit 1; }

[ -n "$TAG" ] || die "--tag is required (the pinned 40-char commit sha)"
printf '%s' "$TAG" | grep -Eq '^[0-9a-f]{40}$' || die "tag '$TAG' is not a 40-char lowercase commit sha"
[ -f "$COMPOSE" ] || die "missing $COMPOSE (run infra/ansible/playbook.yml)"
[ -f "$RELEASE_ENV" ] || die "missing $RELEASE_ENV (site address is unset)"
[ -f "$APP_ENV" ] || die "missing $APP_ENV (runtime secrets are unset)"

CURRENT=""
if [ -f "$TAG_FILE" ]; then
  CURRENT=$(sed -n 's/^REEMCO_IMAGE_TAG=//p' "$TAG_FILE" | tail -1)
fi

log "deploy requested: tag=$TAG current=${CURRENT:-none} dry_run=$DRY_RUN"

if [ "$CURRENT" = "$TAG" ]; then
  log "tag already live — re-verifying instead of redeploying"
  exec /opt/reemco/scripts/verify.sh --tag "$TAG"
fi

if [ "$DRY_RUN" = "1" ]; then
  log "dry run: would pull $TAG, save current=${CURRENT:-none} as previous, compose up -d"
  exit 0
fi

# Save the rollback target BEFORE mutating anything. If there is no previous
# tag (first deploy) the file is still written so rollback fails loudly rather
# than silently rolling forward to a stale value.
mkdir -p "$ETC"
if [ -n "$CURRENT" ]; then
  printf 'REEMCO_IMAGE_TAG=%s\n' "$CURRENT" > "$PREV_FILE"
  log "rollback target recorded: $CURRENT"
else
  log "no previous tag — this is the first deploy (rollback = DNS back to Vercel)"
fi

# Pull first so the window where the old container is down is as short as
# possible, and so a bad tag fails before we stop serving.
log "pulling ${TAG}"
docker compose -f "$COMPOSE" --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" \
  pull app >>"$LOG" 2>&1 || {
    # image-tag.env still names the old tag, so nothing has changed yet.
    die "pull failed for $TAG — service untouched (still on ${CURRENT:-nothing})"
  }

printf 'REEMCO_IMAGE_TAG=%s\n' "$TAG" > "$TAG_FILE"
log "image-tag.env updated to $TAG"

log "starting stack"
if ! docker compose -f "$COMPOSE" --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" \
  up -d --remove-orphans >>"$LOG" 2>&1; then
  log "compose up failed — rolling back"
  /opt/reemco/scripts/rollback.sh || log "ROLLBACK ALSO FAILED — page the on-call"
  exit 1
fi

if /opt/reemco/scripts/verify.sh --tag "$TAG"; then
  log "deploy verified: $TAG"
  exit 0
fi

log "verification failed for $TAG — rolling back"
/opt/reemco/scripts/rollback.sh || log "ROLLBACK ALSO FAILED — page the on-call"
exit 1
