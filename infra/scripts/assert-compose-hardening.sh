#!/usr/bin/env bash
# REEA-1061 — CI assertion over the rendered production compose file.
#
#   infra/scripts/assert-compose-hardening.sh [infra/compose.prod.yml]
#
# Renders the file with `docker compose config` (so it also proves the file is
# syntactically valid and its required env vars are wired) and then asserts the
# hardening invariants the cutover review asked for:
#
#   * every service has cap_drop ALL or an explicit non-root user
#   * no privileged container and no cap_add beyond NET_BIND_SERVICE
#   * no-new-privileges on every service
#   * the infra images (redis, proxy) are digest-pinned
#   * redis and proxy are read-only with a pids_limit and a tmpfs scratch path
#   * proxy and redis share no network; proxy is edge-only, redis is data-only
#   * the data plane has no gateway (`internal: true`)
#
# Exit 0 = all invariants hold. Non-zero = at least one FAIL line was printed.
# Run from the repo root in CI before the deploy step; it needs only the docker
# CLI (no daemon: `compose config` is client-side).
set -uo pipefail

COMPOSE="${1:-infra/compose.prod.yml}"

# `compose config` needs both required variables. Dummy values are fine — the
# assertion is about shape, not about which tag/hostname is live.
export REEMCO_IMAGE_TAG="${REEMCO_IMAGE_TAG:-0123456789abcdef0123456789abcdef01234567}"
# REEA-1262 — the second (standby) app slot needs its own tag placeholder too.
export REEMCO_IMAGE_TAG_GREEN="${REEMCO_IMAGE_TAG_GREEN:-89abcdef0123456789abcdef0123456789abcdef}"
export REEMCO_SITE_ADDRESS="${REEMCO_SITE_ADDRESS:-example.com}"

if [ ! -f "$COMPOSE" ]; then
  echo "FAIL: compose file not found: $COMPOSE" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker CLI not found; cannot render $COMPOSE" >&2
  exit 2
fi

# The production file references host-absolute paths that only exist on the box
# (/etc/reemco/app.env, /opt/reemco/Caddyfile). `compose config` refuses to
# render if an env_file is missing, which is exactly the case on a CI runner.
# Render a copy with those paths redirected to empty local placeholders: the
# invariants below are about service shape, not the contents of the files.
RENDER_DIR=$(mktemp -d)
trap 'rm -rf "$RENDER_DIR"' EXIT
: > "$RENDER_DIR/app.env"
: > "$RENDER_DIR/Caddyfile"
sed -e "s|/etc/reemco/app.env|$RENDER_DIR/app.env|g" \
    -e "s|/opt/reemco/Caddyfile|$RENDER_DIR/Caddyfile|g" \
    "$COMPOSE" > "$RENDER_DIR/compose.prod.yml"

if ! CFG=$(docker compose -f "$RENDER_DIR/compose.prod.yml" config --format json 2>&1); then
  echo "FAIL: docker compose config rejected $COMPOSE:" >&2
  printf '%s\n' "$CFG" >&2
  exit 2
fi

FAIL=0
fail() { printf 'FAIL: %s\n' "$*"; FAIL=1; }
ok() { printf 'ok: %s\n' "$*"; }

SERVICES=$(jq -r '.services | keys[]' <<<"$CFG")
[ -n "$SERVICES" ] || { fail "no services rendered from $COMPOSE"; }

is_nonroot() {
  case "$1" in
    ""|"0"|"root"|"0:0"|"0:"|*":0") return 1 ;;
    *) return 0 ;;
  esac
}

for svc in $SERVICES; do
  q() { jq -r --arg s "$svc" "$1" <<<"$CFG"; }

  user=$(q '.services[$s].user // ""')
  drop=$(q '[.services[$s].cap_drop[]?] | join(",")')
  add=$(q '[.services[$s].cap_add[]?] | join(",")')
  priv=$(q '.services[$s].privileged // false')
  secopt=$(q '[.services[$s].security_opt[]?] | join(",")')
  ro=$(q '.services[$s].read_only // false')
  pids=$(q '.services[$s].pids_limit // 0')
  image=$(q '.services[$s].image // ""')

  # Every service: cap_drop ALL or a non-root user.
  if printf '%s' "$drop" | tr ',' '\n' | grep -qx 'ALL'; then
    ok "$svc: cap_drop includes ALL"
  elif is_nonroot "$user"; then
    ok "$svc: runs as non-root user '$user'"
  else
    fail "$svc: neither cap_drop ALL nor a non-root user (user='${user:-<unset>}', cap_drop='${drop:-<unset>}')"
  fi

  # Never privileged; the only allowed added capability is NET_BIND_SERVICE.
  [ "$priv" = "true" ] && fail "$svc: privileged=true"
  if [ -n "$add" ]; then
    extra=$(printf '%s' "$add" | tr ',' '\n' | grep -vx 'NET_BIND_SERVICE' | paste -sd, -)
    [ -n "$extra" ] && fail "$svc: cap_add beyond NET_BIND_SERVICE: $extra"
  fi

  # no-new-privileges everywhere.
  printf '%s' "$secopt" | tr ',' '\n' | grep -qx 'no-new-privileges:true' \
    || fail "$svc: missing security_opt no-new-privileges:true"

  # The two infrastructure containers must be immutable + resource-capped.
  case "$svc" in
    redis|proxy)
      printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$' \
        || fail "$svc: image is not digest-pinned: $image"
      [ "$ro" = "true" ] || fail "$svc: read_only is not true"
      [ "${pids:-0}" -gt 0 ] 2>/dev/null || fail "$svc: pids_limit is unset"
      q '[.services[$s].tmpfs[]?] | length' | grep -qx '[1-9][0-9]*' \
        || fail "$svc: no tmpfs scratch path despite read_only rootfs"
      ;;
  esac
done

# Network segmentation. Proxy must only reach the app; redis only the app.
proxy_nets=$(jq -r '[.services.proxy.networks // {} | keys[]] | sort | join(",")' <<<"$CFG")
redis_nets=$(jq -r '[.services.redis.networks // {} | keys[]] | sort | join(",")' <<<"$CFG")
app_nets=$(jq -r '[.services.app.networks // {} | keys[]] | sort | join(",")' <<<"$CFG")
# REEA-1262 — the standby slot must carry the same network segmentation.
app_green_nets=$(jq -r '[.services.app_green.networks // {} | keys[]] | sort | join(",")' <<<"$CFG")

[ "$proxy_nets" = "edge" ] || fail "proxy networks should be exactly 'edge', got '$proxy_nets'"
[ "$redis_nets" = "data" ] || fail "redis networks should be exactly 'data', got '$redis_nets'"
[ "$app_nets" = "data,edge" ] || fail "app networks should be exactly 'data,edge', got '$app_nets'"
[ "$app_green_nets" = "data,edge" ] || fail "app_green networks should be exactly 'data,edge', got '$app_green_nets'"

shared=$(printf '%s\n%s\n' "$proxy_nets" "$redis_nets" | tr ',' '\n' | sort | uniq -d | paste -sd, -)
[ -z "$shared" ] || fail "proxy and redis share a network: $shared"

jq -e '.networks.data.internal == true' <<<"$CFG" >/dev/null \
  || fail "the data network must be internal (no gateway)"

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "compose hardening assertions FAILED for $COMPOSE" >&2
  exit 1
fi
echo
echo "compose hardening assertions PASSED for $COMPOSE"
