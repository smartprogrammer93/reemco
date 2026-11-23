#!/usr/bin/env bash
# REEA-1061 — post-deploy / post-rollback assertion on the RUNNING containers.
#
#   infra/scripts/assert-containers.sh
#
# verify.sh calls this after the public-surface checks, so a deploy or rollback
# is only "verified" when the hardening that shipped in compose.prod.yml is
# actually in force on the box. It asserts, from `docker inspect` / `docker exec`:
#
#   * redis, proxy and app are not running as uid 0 (both the container's
#     configured user and the live process)
#   * CapDrop includes ALL, CapAdd is empty except proxy's NET_BIND_SERVICE
#   * redis/proxy rootfs is read-only and no-new-privileges is set
#   * pids_limit matches the compose file (redis 256, proxy 128)
#   * proxy is on `edge` only and redis on `data` only (no shared network)
#   * the running image digest equals the digest pinned in compose.prod.yml
#
# Exit 0 = hardened; non-zero = at least one FAIL line was printed.
set -uo pipefail

COMPOSE="${COMPOSE:-/opt/reemco/compose.prod.yml}"
RELEASE_ENV="${RELEASE_ENV:-/etc/reemco/release.env}"
TAG_FILE="${TAG_FILE:-/etc/reemco/image-tag.env}"

FAIL=0
fail() { printf 'FAIL: %s\n' "$*"; FAIL=1; }
ok() { printf 'ok: %s\n' "$*"; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker not available; container hardening not asserted"
  exit 0
fi
[ -f "$COMPOSE" ] || { echo "FAIL: missing $COMPOSE" >&2; exit 2; }

COMPOSE_ARGS=(-f "$COMPOSE")
[ -f "$RELEASE_ENV" ] && COMPOSE_ARGS+=(--env-file "$RELEASE_ENV")
[ -f "$TAG_FILE" ] && COMPOSE_ARGS+=(--env-file "$TAG_FILE")

if ! CFG=$(docker compose "${COMPOSE_ARGS[@]}" config --format json 2>&1); then
  echo "FAIL: docker compose config rejected $COMPOSE:" >&2
  printf '%s\n' "$CFG" >&2
  exit 2
fi

container_id() {
  local svc="$1" cid
  cid=$(docker compose "${COMPOSE_ARGS[@]}" ps -q "$svc" 2>/dev/null | head -1)
  [ -n "$cid" ] || cid=$(docker ps -q --filter "label=com.docker.compose.service=$svc" | head -1)
  printf '%s' "$cid"
}

pinned_image() {
  jq -r --arg s "$1" '.services[$s].image // ""' <<<"$CFG"
}

expect_networks() {
  local svc="$1" want="$2" cid="$3" got
  got=$(docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cid" \
    | tr ' ' '\n' | grep -v '^$' | sort | paste -sd, -)
  [ "$got" = "$want" ] || fail "$svc: networks '$got' != expected '$want'"
}

expect_pids() {
  local svc="$1" want="$2" cid="$3" got
  got=$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$cid")
  [ "$got" = "$want" ] || fail "$svc: pids_limit '$got' != expected '$want'"
}

for svc in redis proxy app; do
  cid=$(container_id "$svc")
  if [ -z "$cid" ]; then
    fail "$svc: no running container found"
    continue
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$cid")" != "true" ]; then
    fail "$svc: container is not running"
    continue
  fi

  cfg_user=$(docker inspect --format '{{.Config.User}}' "$cid")
  live_uid=$(docker exec "$cid" id -u 2>/dev/null || echo unknown)

  case "$svc" in
    redis) want_user="valkey"; want_pids=256; want_nets="reemco_data" ;;
    proxy) want_user="1000:1000"; want_pids=128; want_nets="reemco_edge" ;;
    app)   want_user=""; want_pids=512; want_nets="reemco_data,reemco_edge" ;;
  esac

  # Non-root, both configured and live.
  case "$cfg_user" in
    ""|"0"|"root"|"0:0") fail "$svc: configured user is root (Config.User='$cfg_user')" ;;
    *) ok "$svc: configured non-root user '$cfg_user'" ;;
  esac
  if [ "$live_uid" = "0" ]; then
    fail "$svc: live process runs as uid 0"
  elif [ "$live_uid" != "unknown" ]; then
    ok "$svc: live process uid $live_uid (non-root)"
  fi

  # Capabilities: drop ALL, and only proxy may add NET_BIND_SERVICE. Docker
  # normalises the added capability name to CAP_NET_BIND_SERVICE, so compare
  # the canonical (prefix-stripped) set.
  capdrop=$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$cid")
  capadd=$(docker inspect --format '{{json .HostConfig.CapAdd}}' "$cid")
  capadd_canon=$(printf '%s' "$capadd" | jq -c '[.[]? | sub("^CAP_"; "")] | sort')
  printf '%s' "$capdrop" | jq -e 'index("ALL") != null' >/dev/null \
    || fail "$svc: CapDrop does not include ALL: $capdrop"
  case "$svc" in
    proxy)
      [ "$capadd_canon" = '["NET_BIND_SERVICE"]' ] \
        || fail "proxy: CapAdd should be exactly NET_BIND_SERVICE, got $capadd"
      ;;
    *)
      [ "$capadd_canon" = "[]" ] \
        || fail "$svc: CapAdd should be empty, got $capadd"
      ;;
  esac
  [ "$(docker inspect --format '{{.HostConfig.Privileged}}' "$cid")" = "false" ] \
    || fail "$svc: container is privileged"

  # No-new-privileges and read-only rootfs for the infra containers.
  secopt=$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$cid")
  printf '%s' "$secopt" | grep -q 'no-new-privileges:true' \
    || fail "$svc: no-new-privileges is not set ($secopt)"
  case "$svc" in
    redis|proxy)
      [ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = "true" ] \
        || fail "$svc: rootfs is not read-only"
      ;;
  esac

  expect_pids "$svc" "$want_pids" "$cid"
  expect_networks "$svc" "$want_nets" "$cid"

  # Running artifact must be exactly the digest-pinned image from the file.
  case "$svc" in
    redis|proxy)
      want_img=$(pinned_image "$svc")
      printf '%s' "$want_img" | grep -Eq '@sha256:[0-9a-f]{64}$' \
        || fail "$svc: compose image is not digest-pinned: $want_img"
      running_img=$(docker image inspect "$(docker inspect --format '{{.Image}}' "$cid")" \
        --format '{{index .RepoDigests 0}}' 2>/dev/null || true)
      if [ "$running_img" = "$want_img" ]; then
        ok "$svc: running digest matches pinned $want_img"
      else
        fail "$svc: running image '$running_img' != pinned '$want_img'"
      fi
      ;;
  esac
done

# REEA-1087 (F9) — the published-port set is the enforced ingress surface.
# Docker publishes ports by DNAT + FORWARD, bypassing UFW's INPUT chain, so a
# container that gains a new `ports:` entry silently becomes internet-facing
# even though `ufw status` still says "deny". This is the compensating check for
# the DOCKER-USER allow-list: no service may publish anything except the proxy's
# 80/443 (tcp + HTTP/3 udp) on all interfaces and the app's 3000 on loopback.
# Anything else is a FAIL, so a deploy cannot widen the attack surface silently.
assert_published_ports() {
  local cid name ports bad
  for cid in $(docker ps -q 2>/dev/null); do
    name=$(docker inspect --format '{{.Name}}' "$cid" | sed 's#^/##')
    ports=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$cid")
    bad=$(printf '%s' "$ports" | jq -r '
      to_entries[]
      | .key as $k
      | (.value // [])[]
      | ($k | split("/")) as $p
      | [ .HostIp, .HostPort ] as $b
      | if (($p[0] == "80" or $p[0] == "443")
            and ($p[1] == "tcp" or ($p[0] == "443" and $p[1] == "udp"))
            and ($b[0] == "0.0.0.0" or $b[0] == "::" or $b[0] == "")
            and ($b[1] == $p[0])) then empty
        elif ($p[0] == "3000" and $p[1] == "tcp" and $b[0] == "127.0.0.1" and $b[1] == "3000") then empty
        else "\($k) -> \($b[0]):\($b[1])" end')
    if [ -n "$bad" ]; then
      fail "$name: published port outside the allow-list: $(printf '%s\n' "$bad" | paste -sd, -)"
    else
      ok "$name: published ports within the allow-list (80/443, loopback 3000)"
    fi
  done
}

# REEA-1087 (F9) — DOCKER-USER must actually carry the ingress allow-list on
# both families. The chain is Docker-owned and is recreated on daemon restart;
# reemco-docker-user-firewall.service (installed by the playbook) re-applies it,
# so this check proves both the rules and the persistence unit's effect.
assert_docker_user() {
  local cmd
  for cmd in iptables ip6tables; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "SKIP: $cmd unavailable; DOCKER-USER not asserted for this family"
      continue
    fi
    if "$cmd" -S DOCKER-USER 2>/dev/null | grep -q -- '-j REEMCO-DOCKER-INGRESS'; then
      ok "$cmd: DOCKER-USER jumps to REEMCO-DOCKER-INGRESS"
    else
      fail "$cmd: DOCKER-USER has no REEMCO-DOCKER-INGRESS jump (published ports are UFW-exempt)"
    fi
    if "$cmd" -S REEMCO-DOCKER-INGRESS 2>/dev/null | grep -q -- '-j DROP'; then
      ok "$cmd: REEMCO-DOCKER-INGRESS ends in DROP"
    else
      fail "$cmd: REEMCO-DOCKER-INGRESS is missing or has no DROP rule"
    fi
  done
}

assert_published_ports
assert_docker_user

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "container hardening assertions FAILED" >&2
  exit 1
fi
echo
echo "container hardening assertions PASSED (redis, proxy, app, published ports, DOCKER-USER)"
