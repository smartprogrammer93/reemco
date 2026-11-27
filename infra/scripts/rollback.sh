#!/usr/bin/env bash
# REEA-1044 / REEA-1262 — roll back to the previously deployed build.
#
#   /opt/reemco/scripts/rollback.sh [--tag <sha>]
#
# With no --tag it reads /etc/reemco/image-tag.prev.env, which deploy.sh writes
# BEFORE every slot switch. That file now records both the previous tag and the
# slot that was serving it. A rollback is the same blue/green procedure as a
# deploy: start the previous build in the inactive slot, wait until it answers
# 200 on /api/health + a search, switch Caddy's upstream to it, verify, and only
# then stop the failed slot. There is never a window in which neither build
# answers (AC-3), and a rollback is a start + switch — not a rebuild.
#
# rollback.sh deliberately delegates to deploy.sh so there is exactly one
# tested engine; the only difference is where the tag comes from.
set -euo pipefail

PREV_FILE=/etc/reemco/image-tag.prev.env
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    *) echo "rollback.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TAG" ]; then
  [ -f "$PREV_FILE" ] || { echo "rollback.sh: no previous tag recorded — nothing to roll back to" >&2; exit 1; }
  TAG=$(sed -n 's/^REEMCO_IMAGE_TAG=//p' "$PREV_FILE" | tail -1)
fi
printf '%s' "$TAG" | grep -Eq '^[0-9a-f]{40}$' || { echo "rollback.sh: rollback tag '$TAG' is not a commit sha" >&2; exit 1; }

# deploy.sh re-records image-tag.prev.env from the currently active slot before
# it switches, so re-running rollback.sh toggles back — idempotent, and a failed
# rollback can itself be rolled back.
exec /opt/reemco/scripts/deploy.sh --tag "$TAG" --mode rollback
