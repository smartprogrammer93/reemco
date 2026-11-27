#!/usr/bin/env bash
# REEA-1044 / REEA-1262 — deploy a pinned image tag on the Reemco host.
#
#   /opt/reemco/scripts/deploy.sh --tag <40-char-sha> [--dry-run]
#   /opt/reemco/scripts/deploy.sh --reconcile
#   /opt/reemco/scripts/rollback.sh [--tag <sha>]     (wrapper: prev slot/tag)
#
# REEA-1262 — ZERO-DOWNTIME BLUE/GREEN. The defect this fixes: the old
# single-service deploy stopped the only shopper-facing build before the new one
# could answer, so every push produced ~50 s of 503 / connection-refused. The
# contract is now:
#
#   1. Start the INACTIVE app slot (`app` or `app_green`) with the new tag on its
#      own loopback port, ALONGSIDE the running slot. Nothing is stopped yet.
#   2. Do not touch the proxy until that slot answers 200 on /__commit.txt (the
#      exact tag), /api/health AND a real search on its own port (AC-2). A slot
#      that cannot answer never receives shopper traffic.
#   3. Switch Caddy's upstream with a validated `caddy reload` (the Caddyfile
#      reads REEMCO_APP_UPSTREAM). Caddy keeps the running config on error, so a
#      failed reload leaves the old slot serving (AC-3).
#   4. Run the full verify.sh gate on the switched surface. If it fails, reload
#      the upstream back to the old slot and stop the new one (AC-3).
#   5. Only then stop the old slot. Its container is kept (stopped, not removed)
#      so a rollback is a start + switch, not a rebuild.
#
# The tag is the ONLY variable; deploy state lives in /etc/reemco/image-tag.env
# (blue tag, green tag, active slot, upstream) and the rollback target in
# /etc/reemco/image-tag.prev.env. Nothing is edited on the host by hand.
#
# Idempotency: deploying the tag that is already active reconciles the stack
# shape and re-verifies instead of switching. The whole run holds an flock, so
# two deploys cannot interleave (the workflow also serialises them).
set -euo pipefail

COMPOSE=/opt/reemco/compose.prod.yml
ETC=/etc/reemco
TAG_FILE="$ETC/image-tag.env"
PREV_FILE="$ETC/image-tag.prev.env"
RELEASE_ENV="$ETC/release.env"
APP_ENV="$ETC/app.env"
LOG=/var/log/reemco/deploy.log
LOCK=/var/lock/reemco-deploy.lock

TAG=""
DRY_RUN=0
RECONCILE=0
MODE="deploy"
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --reconcile) RECONCILE=1; shift ;;
    --mode) MODE="${2:-deploy}"; shift 2 ;;
    *) echo "deploy.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
die() { log "FAILED: $*"; exit 1; }

# --- static config ----------------------------------------------------------
[ -f "$COMPOSE" ] || die "missing $COMPOSE (run infra/ansible/playbook.yml)"
[ -f "$RELEASE_ENV" ] || die "missing $RELEASE_ENV (site address is unset)"
[ -f "$APP_ENV" ] || die "missing $APP_ENV (runtime secrets are unset)"

REPO=$(sed -n 's/^REEMCO_IMAGE_REPO=//p' "$RELEASE_ENV" | tail -1)
REPO=${REPO:-ghcr.io/smartprogrammer93/reemco}
PROFILES=$(sed -n 's/^REEMCO_COMPOSE_PROFILES=//p' "$RELEASE_ENV" | tail -1)
PROFILE_ARGS=()
for p in $PROFILES; do PROFILE_ARGS+=(--profile "$p"); done

# One deploy at a time. A half-applied slot switch is worse than a queued run.
mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
flock -w 900 9 || die "another deploy is holding $LOCK (waited 900s)"

# --- deploy state -----------------------------------------------------------
BLUE_TAG=""
GREEN_TAG=""
ACTIVE="app"

read_state() {
  if [ -f "$TAG_FILE" ]; then
    BLUE_TAG=$(sed -n 's/^REEMCO_IMAGE_TAG=//p' "$TAG_FILE" | tail -1)
    GREEN_TAG=$(sed -n 's/^REEMCO_IMAGE_TAG_GREEN=//p' "$TAG_FILE" | tail -1)
    ACTIVE=$(sed -n 's/^REEMCO_ACTIVE_SLOT=//p' "$TAG_FILE" | tail -1)
  fi
  case "$ACTIVE" in
    app|app_green) : ;;
    *) ACTIVE="app" ;;
  esac
  # Migration from the pre-REEA-1262 single-slot file: the green slot did not
  # exist, so it starts on the same image as blue until the first switch.
  [ -n "$GREEN_TAG" ] || GREEN_TAG="$BLUE_TAG"
}

# write_state <blue_tag> <green_tag> <active_slot>
# Atomic (tmp + rename) so an interrupted deploy cannot leave a half-written
# state file, and it keeps the 0640 root:deploy posture of /etc/reemco.
write_state() {
  local blue="$1" green="$2" active="$3" tmp
  tmp=$(mktemp "$ETC/image-tag.env.XXXXXX")
  {
    echo "# Written by deploy.sh/rollback.sh. Do not hand-edit."
    echo "REEMCO_IMAGE_TAG=$blue"
    echo "REEMCO_IMAGE_TAG_GREEN=$green"
    echo "REEMCO_ACTIVE_SLOT=$active"
    echo "REEMCO_APP_UPSTREAM=$active:3000"
  } >"$tmp"
  chmod 0640 "$tmp"
  chown root:deploy "$tmp" 2>/dev/null || true
  mv "$tmp" "$TAG_FILE"
}

# write_prev <tag> <slot> — the rollback target, written BEFORE any mutation.
write_prev() {
  local tag="$1" slot="$2" tmp
  tmp=$(mktemp "$ETC/image-tag.prev.env.XXXXXX")
  {
    echo "# Written by deploy.sh. Do not hand-edit."
    echo "REEMCO_IMAGE_TAG=$tag"
    echo "REEMCO_PREV_SLOT=$slot"
  } >"$tmp"
  chmod 0640 "$tmp"
  chown root:deploy "$tmp" 2>/dev/null || true
  mv "$tmp" "$PREV_FILE"
}

slot_tag() {
  case "$1" in
    app) printf '%s' "$BLUE_TAG" ;;
    app_green) printf '%s' "$GREEN_TAG" ;;
  esac
}
slot_port() {
  case "$1" in
    app) echo 3000 ;;
    app_green) echo 3001 ;;
  esac
}
other_slot() {
  if [ "$1" = "app" ]; then echo app_green; else echo app; fi
}

compose() {
  docker compose -f "$COMPOSE" "${PROFILE_ARGS[@]}" \
    --env-file "$RELEASE_ENV" --env-file "$TAG_FILE" "$@"
}

# REEA-1061 — redis and the proxy run as non-root users, but a named volume is
# created root-owned on first use. Chown the volumes idempotently before `up`
# using the same digest-pinned images (no extra image, no mutable tag).
ensure_volume_ownership() {
  local cfg redis_img proxy_img redis_vol caddy_data caddy_config
  cfg=$(compose config --format json 2>/dev/null) || {
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

# switch_upstream <slot> — point Caddy at the given slot. The CLI adapts the
# versioned Caddyfile with the exec environment (the same placeholder the
# proxy's own env carries), and Caddy validates before swapping: on error the
# RUNNING config is kept, so the caller can rely on the old slot still serving.
switch_upstream() {
  local slot="$1" proxy_cid
  proxy_cid=$(compose ps -q proxy 2>/dev/null | head -1)
  [ -n "$proxy_cid" ] || proxy_cid=$(docker ps -q --filter "label=com.docker.compose.service=proxy" | head -1)
  [ -n "$proxy_cid" ] || die "no proxy container found (compose project reemco)"

  log "switching proxy upstream to ${slot}:3000"
  docker exec -e REEMCO_APP_UPSTREAM="${slot}:3000" "$proxy_cid" \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >>"$LOG" 2>&1
}

# wait_ready <slot> <tag> — AC-2: the new build must answer 200 on the commit
# stamp (the exact artifact), /api/health AND one real search on its OWN port
# before it can receive a shopper request. /api/health walks the live funnel
# (18-26 s cold) and legitimately 503s once, so retry until the bounded
# deadline; a genuinely broken build fails every attempt.
wait_ready() {
  local slot="$1" tag="$2" port deadline commit code search
  port=$(slot_port "$slot")
  deadline=$((SECONDS + ${READY_TIMEOUT:-360}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    commit=$(curl -fsS -m 5 "http://127.0.0.1:${port}/__commit.txt" 2>/dev/null | tr -d '[:space:]' || true)
    if [ "$commit" = "$tag" ]; then
      code=$(curl -s -o /tmp/reemco-ready-health.json -w '%{http_code}' -m 60 \
        "http://127.0.0.1:${port}/api/health" || echo 000)
      if [ "$code" = "200" ]; then
        search=$(curl -s -o /dev/null -w '%{http_code}' -m 90 \
          "http://127.0.0.1:${port}/results?q=iphone+17+pro" || echo 000)
        if [ "$search" = "200" ]; then
          log "slot $slot ready: stamp=$tag health=200 search=200"
          return 0
        fi
        log "slot $slot: search returned $search — retrying"
      else
        log "slot $slot: health returned $code — retrying"
      fi
    else
      log "slot $slot: stamp '${commit:-none}' != $tag — waiting"
    fi
    sleep 5
  done
  return 1
}

# reconcile_stack <slot> — converge the stack shape without a switch: start
# redis/proxy plus the ACTIVE slot, then make sure Caddy points at it. Used by
# the ansible "reconcile stack" task and by the idempotent same-tag deploy.
reconcile_stack() {
  local slot="$1"
  ensure_volume_ownership
  compose up -d --remove-orphans redis proxy "$slot" >>"$LOG" 2>&1 \
    || log "warning: compose reconcile failed; verifying the running stack as-is"
  switch_upstream "$slot" || log "warning: caddy reload failed — proxy keeps its previous upstream"
}

# ---------------------------------------------------------------------------
read_state

if [ "$RECONCILE" = "1" ]; then
  log "reconcile requested: active=$ACTIVE blue=${BLUE_TAG:-none} green=${GREEN_TAG:-none}"
  # Normalise the state file (also migrates a pre-REEA-1262 single-slot file).
  write_state "$BLUE_TAG" "$GREEN_TAG" "$ACTIVE"
  reconcile_stack "$ACTIVE"
  ACTIVE_TAG=$(slot_tag "$ACTIVE")
  case "$ACTIVE_TAG" in
    ""|0000000000000000000000000000000000000000)
      log "no tag deployed yet — reconcile only"
      exit 0
      ;;
  esac
  exec /opt/reemco/scripts/verify.sh --tag "$ACTIVE_TAG"
fi

[ -n "$TAG" ] || die "--tag is required (the pinned 40-char commit sha)"
printf '%s' "$TAG" | grep -Eq '^[0-9a-f]{40}$' || die "tag '$TAG' is not a 40-char lowercase commit sha"

ACTIVE_TAG=$(slot_tag "$ACTIVE")
log "${MODE} requested: tag=$TAG active=$ACTIVE (${ACTIVE_TAG:-none}) dry_run=$DRY_RUN"

if [ "$TAG" = "$ACTIVE_TAG" ]; then
  # Idempotent re-check: the tag is unchanged, but the stack shape may not be
  # (e.g. a service was added). Converge it, then run the same gate.
  log "tag $TAG is already active on $ACTIVE — reconciling stack shape, then re-verifying"
  write_state "$BLUE_TAG" "$GREEN_TAG" "$ACTIVE"
  reconcile_stack "$ACTIVE"
  exec /opt/reemco/scripts/verify.sh --tag "$TAG"
fi

TARGET=$(other_slot "$ACTIVE")
TARGET_TAG=$(slot_tag "$TARGET")

# Fail BEFORE mutating anything if the artifact is not on the box. The CI
# workflow builds it; the manual fallback builds it by hand first.
if ! docker image inspect "${REPO}:${TAG}" >/dev/null 2>&1; then
  die "image ${REPO}:${TAG} is not present on this host — service untouched (still on ${ACTIVE_TAG:-nothing}). Build it first: docker build -f infra/Dockerfile --build-arg REEMCO_COMMIT=$TAG -t ${REPO}:$TAG ."
fi

if [ "$DRY_RUN" = "1" ]; then
  log "dry run: would start $TARGET with $TAG alongside $ACTIVE, switch the proxy only after health+search 200, then stop $ACTIVE"
  exit 0
fi

# Save the rollback target BEFORE mutating anything: the tag the currently
# active slot is serving. rollback.sh starts that slot again and switches back.
write_prev "$ACTIVE_TAG" "$ACTIVE"
log "rollback target recorded: $ACTIVE (${ACTIVE_TAG:-none})"

# Point the target slot at the new tag in the state file. The active slot keeps
# its tag, so both images stay addressable by compose.
if [ "$TARGET" = "app" ]; then
  NEW_BLUE="$TAG"
  NEW_GREEN="$GREEN_TAG"
else
  NEW_BLUE="$BLUE_TAG"
  NEW_GREEN="$TAG"
fi
write_state "$NEW_BLUE" "$NEW_GREEN" "$ACTIVE"

log "starting $TARGET with $TAG alongside $ACTIVE (${ACTIVE_TAG:-none})"
ensure_volume_ownership
if ! compose up -d --no-deps --force-recreate "$TARGET" >>"$LOG" 2>&1; then
  log "compose up failed for $TARGET — $ACTIVE is still serving; no switch happened"
  compose stop "$TARGET" >>"$LOG" 2>&1 || true
  exit 1
fi

if ! wait_ready "$TARGET" "$TAG"; then
  log "new build $TAG never became ready on $TARGET — stopping it; $ACTIVE keeps serving ${ACTIVE_TAG:-nothing} (AC-3)"
  compose stop "$TARGET" >>"$LOG" 2>&1 || true
  exit 1
fi

if ! switch_upstream "$TARGET"; then
  log "caddy reload failed — proxy kept ${ACTIVE}:3000; stopping $TARGET (AC-3)"
  compose stop "$TARGET" >>"$LOG" 2>&1 || true
  exit 1
fi

# From here the new build is the served one. Record it before verifying so the
# state file cannot describe an upstream that is no longer live.
write_state "$NEW_BLUE" "$NEW_GREEN" "$TARGET"

if /opt/reemco/scripts/verify.sh --tag "$TAG"; then
  log "deploy verified: $TAG on $TARGET"
else
  log "post-switch verify FAILED for $TAG — switching the proxy back to $ACTIVE"
  if ! switch_upstream "$ACTIVE"; then
    log "ROLLBACK SWITCH FAILED — page the on-call (proxy may still point at $TARGET)"
  fi
  # The active slot is the old one again; the target slot keeps the new tag
  # recorded (it will be overwritten by the next deploy or rollback).
  write_state "$NEW_BLUE" "$NEW_GREEN" "$ACTIVE"
  compose stop "$TARGET" >>"$LOG" 2>&1 || true
  exit 1
fi

log "stopping $ACTIVE (${ACTIVE_TAG:-none}) — kept stopped for rollback, not removed"
compose stop "$ACTIVE" >>"$LOG" 2>&1 || log "warning: could not stop $ACTIVE; it is idle (proxy points at $TARGET)"

log "deploy complete: $TAG is served by $TARGET; rollback target $ACTIVE (${ACTIVE_TAG:-none}) recorded in $PREV_FILE"
