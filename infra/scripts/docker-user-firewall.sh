#!/usr/bin/env bash
# REEA-1087 (F9) — close the Docker-published-port bypass of UFW.
#
#   sudo /opt/reemco/scripts/docker-user-firewall.sh apply
#   sudo /opt/reemco/scripts/docker-user-firewall.sh status
#   sudo /opt/reemco/scripts/docker-user-firewall.sh revert
#
# Docker publishes container ports by writing DNAT rules in the nat table and
# then FORWARDs the traffic, so a published port never traverses UFW's INPUT
# chain. `DOCKER-USER` is the documented hook that is evaluated first in the
# FORWARD path; with no rules in it, every published port is reachable from the
# internet regardless of `ufw status` (Blast Radius: the firewall's declared
# posture is not the enforced posture).
#
# This script installs a single jump from DOCKER-USER to a Reemco-owned chain
# and expresses the intended ingress set explicitly:
#
#   * ESTABLISHED/RELATED — return (container replies to allowed flows)
#   * ICMP / ICMPv6      — return (path-MTU discovery for container traffic)
#   * tcp 80, tcp 443    — return (HTTP/HTTPS published by the proxy)
#   * udp 443            — return (HTTP/3; compose publishes 443/udp)
#   * everything else arriving on the WAN interface — DROP
#
# The DROP is scoped with `-i <WAN interface>` so container EGRESS (app → the
# retailer adapters) is untouched: egress is forwarded on the bridge interface,
# not on the WAN interface, and would otherwise be dropped for every port that
# is not 80/443 (e.g. DNS upstreams, retailer APIs on other ports).
#
# Idempotency: the Reemco chain is flushed and rebuilt in full on every `apply`,
# and the DOCKER-USER jump is only inserted when it is not already present, so
# repeated runs (boot, docker restart, ansible) converge to the same ruleset.
#
# Persistence: installed by infra/systemd/reemco-docker-user-firewall.service,
# which runs after docker.service and is PartOf it, so a docker restart
# re-applies the rules instead of leaving DOCKER-USER empty again.
#
# Rollback Path: `revert` removes the jump and the chain, restoring the previous
# (Docker-default, empty DOCKER-USER) behaviour. Then
# `sudo systemctl disable --now reemco-docker-user-firewall.service`.
#
# Least Privilege note: this is defence-in-depth. The compensating check that a
# deploy cannot widen the published set is in assert-containers.sh.
set -euo pipefail

CHAIN="REEMCO-DOCKER-INGRESS"
IPT=iptables
IPT6=ip6tables

die() { printf 'docker-user-firewall: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v iptables >/dev/null 2>&1 || die "iptables not found"

wan_if() {
  local fam="$1" dev
  dev=$(ip "-$fam" route show default 2>/dev/null \
    | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
  printf '%s' "$dev"
}

ensure_chain() {
  local cmd="$1"
  "$cmd" -N "$CHAIN" 2>/dev/null || true
  "$cmd" -F "$CHAIN"
}

jump_present() {
  local cmd="$1"
  "$cmd" -C DOCKER-USER -j "$CHAIN" >/dev/null 2>&1
}

# Docker creates DOCKER-USER when the daemon starts. Create it if this runs
# before that (boot ordering edge) or if it was removed, so the jump can land.
ensure_docker_user() {
  local cmd="$1"
  "$cmd" -N DOCKER-USER 2>/dev/null || true
}

build_v4() {
  local wan
  wan=$(wan_if 4)
  [ -n "$wan" ] || die "no IPv4 default route; refusing to guess the WAN interface"
  ensure_docker_user "$IPT"
  ensure_chain "$IPT"
  "$IPT" -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$IPT" -A "$CHAIN" -p icmp -j RETURN
  "$IPT" -A "$CHAIN" -p tcp --dport 80 -j RETURN
  "$IPT" -A "$CHAIN" -p tcp --dport 443 -j RETURN
  "$IPT" -A "$CHAIN" -p udp --dport 443 -j RETURN
  "$IPT" -A "$CHAIN" -i "$wan" -j DROP
  if ! jump_present "$IPT"; then
    "$IPT" -I DOCKER-USER 1 -j "$CHAIN"
  fi
  printf 'applied IPv4 (WAN %s): tcp 80/443, udp 443 allowed; other WAN ingress dropped\n' "$wan"
}

build_v6() {
  local wan
  wan=$(wan_if 6)
  ensure_docker_user "$IPT6"
  ensure_chain "$IPT6"
  "$IPT6" -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$IPT6" -A "$CHAIN" -p ipv6-icmp -j RETURN
  "$IPT6" -A "$CHAIN" -p tcp --dport 80 -j RETURN
  "$IPT6" -A "$CHAIN" -p tcp --dport 443 -j RETURN
  "$IPT6" -A "$CHAIN" -p udp --dport 443 -j RETURN
  # If the host has no IPv6 default route, drop all remaining v6 forwarded
  # traffic rather than leaving it open: nothing should reach a container
  # except the published ports above.
  if [ -n "$wan" ]; then
    "$IPT6" -A "$CHAIN" -i "$wan" -j DROP
  else
    "$IPT6" -A "$CHAIN" -j DROP
  fi
  if ! jump_present "$IPT6"; then
    "$IPT6" -I DOCKER-USER 1 -j "$CHAIN"
  fi
  printf 'applied IPv6 (WAN %s): tcp 80/443, udp 443 allowed; other ingress dropped\n' "${wan:-none}"
}

apply() {
  build_v4
  build_v6
}

status() {
  echo "=== iptables -S DOCKER-USER (v4) ==="
  "$IPT" -S DOCKER-USER
  echo "=== iptables -S $CHAIN (v4) ==="
  "$IPT" -S "$CHAIN" 2>/dev/null || echo "(chain absent)"
  echo "=== ip6tables -S DOCKER-USER (v6) ==="
  "$IPT6" -S DOCKER-USER 2>/dev/null || echo "(ip6tables unavailable)"
  echo "=== ip6tables -S $CHAIN (v6) ==="
  "$IPT6" -S "$CHAIN" 2>/dev/null || echo "(chain absent)"
}

revert() {
  if jump_present "$IPT"; then
    "$IPT" -D DOCKER-USER -j "$CHAIN"
  fi
  "$IPT" -F "$CHAIN" 2>/dev/null || true
  "$IPT" -X "$CHAIN" 2>/dev/null || true
  if jump_present "$IPT6"; then
    "$IPT6" -D DOCKER-USER -j "$CHAIN"
  fi
  "$IPT6" -F "$CHAIN" 2>/dev/null || true
  "$IPT6" -X "$CHAIN" 2>/dev/null || true
  echo "reverted: DOCKER-USER has no Reemco jump; published ports are UFW-exempt again"
}

case "${1:-apply}" in
  apply) apply ;;
  status) status ;;
  revert) revert ;;
  *) die "usage: $0 {apply|status|revert}" ;;
esac
