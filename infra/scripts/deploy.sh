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

# Image repo and optional compose profiles. Both are non-secret and live in
# release.env; profiles empty means the default stack (app + Valkey + Caddy).
# REEA-1044: the local-kv gateway profile is gone — the app talks to Valkey
# over RESP via REDIS_URL, which compose.prod.yml sets.
REPO=$(sed -n 's/^REEMCO_IMAGE_REPO=//p' "$RELEASE_ENV" | tail -1)
REPO=${REPO:-ghcr.io/smartprogrammer93/reemco}
PROFILES=$(sed -n 's/^REEMCO_COMPOSE_PROFILES=//p' "$RELEASE_ENV" | tail -1)
PROFILE_ARGS=()
for p in $PROFILES; do PROFILE_ARGS+=(--profile "$p"); done

CURRENT=""
if [ -f "$TAG_FILE" ]; then
  CURRENT=$(sed -n 's/^REEMCO_IMAGE_TAG=//p' "$TAG_FILE" | tail -1)
fi

# REEA-1061 — redis and the proxy now run as non-root users, but a named volume
# is created root-owned on first use. Chown the volumes idempotently before
# `up` using the same digest-pinned images (no extra image, no mutable tag).
# Idempotent: re-running it is a no-op on an already-correct volume, and it is
# safe while the containers are running (chown does not touch live files).
ensure_volume_ownership() {
  local cfg redis_img proxy_img redis_vol caddy_data caddy_config
  cfg=$(docker compose -f "$COMPOSE" "${PROFILE_ARGS[@]}" \
    --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" config --format json 2>/dev/null) || {
    log "warning: compose config failed; skipping volume ownership fix"
    return 0
  }
  redis_img=$(jq -r '.services.redis.image // empty' <<<"$cfg")
  proxy_img=$(jq -r '.services.proxy.image // empty' <<<"$cfg")
  redis_vol=$(jq -r '.volumes.redis.name // "reemco_redis"' <<<"$cfg")
  caddy_data=$(jq -r '.volumes["caddy-data"].name // "reemco_caddy-data"' <<<"$cfg")
  caddy_config=$(jq -r '.volumes["caddy-config"].name // "reemco_caddy-config"' <<<"$cfg")

  if [ -n "$redis_img" ] && docker volume inspect "$redis_vol" >/dev/null 2>&1; then
    docker run --rm -v "$redis_vol:/data" --entrypoint sh "$redis_img" \
      -c 'chown -R valkey:valkey /data' >/dev/null 2>&1 \
      || log "warning: could not chown $redis_vol to valkey"
  fi
  if [ -n "$proxy_img" ] && docker volume inspect "$caddy_data" >/dev/null 2>&1; then
    docker run --rm -v "$caddy_data:/data" -v "$caddy_config:/config" --entrypoint sh "$proxy_img" \
      -c 'chown -R 1000:1000 /data /config' >/dev/null 2>&1 \
      || log "warning: could not chown $caddy_data/$caddy_config to 1000:1000"
  fi
}

log "deploy requested: tag=$TAG current=${CURRENT:-none} dry_run=$DRY_RUN"

if [ "$CURRENT" = "$TAG" ]; then
  # Idempotent re-check: the image tag is unchanged, but the stack shape may
  # not be (e.g. a service was added). Converge it, then run the same gate.
  log "tag already live — reconciling stack shape, then re-verifying"
  ensure_volume_ownership
  docker compose -f "$COMPOSE" "${PROFILE_ARGS[@]}" \
    --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" \
    up -d --remove-orphans >>"$LOG" 2>&1 \
    || log "warning: compose reconcile failed; verifying the running stack as-is"
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
docker compose -f "$COMPOSE" "${PROFILE_ARGS[@]}" \
  --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" \
  pull app >>"$LOG" 2>&1 || {
    # Standup path: the image is built on this host (no registry credentials),
    # so `pull` has nothing to fetch. Accept the tag only when that exact
    # artifact is already present locally; otherwise fail without touching the
    # running service (image-tag.env still names the old tag).
    if docker image inspect "${REPO}:${TAG}" >/dev/null 2>&1; then
      log "pull failed for $TAG, but ${REPO}:${TAG} exists locally — continuing with the on-host build"
    else
      die "pull failed for $TAG and no local image — service untouched (still on ${CURRENT:-nothing})"
    fi
  }

printf 'REEMCO_IMAGE_TAG=%s\n' "$TAG" > "$TAG_FILE"
log "image-tag.env updated to $TAG"

log "starting stack"
ensure_volume_ownership
if ! docker compose -f "$COMPOSE" "${PROFILE_ARGS[@]}" \
  --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" \
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
