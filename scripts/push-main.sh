#!/usr/bin/env bash
# scripts/push-main.sh — REEA-1108: push a coder commit to origin/main in one command.
#
# Why this exists: the remote is https, the repo has no credential helper, and git
# never reads $DEV_GITHUB_PAT on its own. A bare `git push` therefore asks for a
# username and dies in a non-interactive shell with
#   fatal: could not read Username for 'https://github.com'
# The token is resolved at run time (the DEV_GITHUB_PAT env binding when the lane
# has one, otherwise the Paperclip Secrets API for this agent) and handed to git
# through a one-shot credential helper shared by every authenticated git call
# (fetch, ls-remote, push): it is never written to .git/config, never echoed into
# the output, and never placed in a URL argument, so it cannot be read from `ps`.
#
# Usage:
#   scripts/push-main.sh              # push the current HEAD to origin/main
#   scripts/push-main.sh --ref <sha>  # push a specific commit
#   scripts/push-main.sh --dry-run    # check auth + fast-forward, do not push
#
# Guarantees:
#   * fast-forward only — refuses if origin/main is not an ancestor (no force-push,
#     landed history is never rewritten)
#   * idempotent — no-op when origin/main already equals the commit
#   * verifies the push by reading origin/main back; a non-zero exit means it did
#     not land
#   * on failure it writes a git bundle and attaches it to the current Paperclip
#     issue, so the bundle + pickup fallback cannot be forgotten
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "push-main: not inside a git repository" >&2
  exit 2
}
cd "$REPO_ROOT"

REF="HEAD"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)
      REF="${2:?--ref needs a commit}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      echo "push-main: unknown argument '$1' (see --help)" >&2
      exit 2
      ;;
  esac
done

SHA=$(git rev-parse --verify --quiet "$REF^{commit}") || {
  echo "push-main: cannot resolve '$REF' to a commit" >&2
  exit 2
}

ORIGIN=$(git remote get-url origin 2>/dev/null) || {
  echo "push-main: no 'origin' remote" >&2
  exit 2
}
case "$ORIGIN" in
  https://github.com/*) ;;
  *)
    echo "push-main: origin is '$ORIGIN'; expected an https://github.com/... remote" >&2
    exit 2
    ;;
esac
SLUG=${ORIGIN#https://github.com/}
SLUG=${SLUG%.git}

# --- idempotency pre-check --------------------------------------------------
# No-op detection must not depend on a readable token: a lane whose secret is not
# accessible still gets a clean exit 0 when the commit is already on origin/main.
# Read origin/main without credentials first (the remote is public); if that read
# is unavailable, fall back to the local origin/main ref. A local ref equal to
# $SHA is safe evidence: origin only ever fast-forwards, so a commit that was on
# origin/main stays there.
remote_main_tip() {
  GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$ORIGIN" refs/heads/main 2>/dev/null | cut -f1
}

already_landed() {
  local tip
  tip=$(remote_main_tip || true)
  if [ -z "$tip" ]; then
    tip=$(git rev-parse --verify --quiet origin/main 2>/dev/null || true)
  fi
  [ -n "$tip" ] || return 1
  [ "$tip" = "$SHA" ] && return 0
  # A commit already contained in origin/main is landed too; pushing it would be
  # a backwards non-fast-forward, so the no-op outcome is correct.
  git merge-base --is-ancestor "$SHA" "$tip" 2>/dev/null && return 0
  return 1
}

if already_landed; then
  echo "push-main: origin/main already contains $SHA — nothing to push"
  exit 0
fi

# --- run context ------------------------------------------------------------
# The run env file holds the Paperclip run JWT. It is used both to fetch the
# secret on demand and to attach the fallback bundle to the current issue.
if [ -z "${PAPERCLIP_API_KEY:-}" ] && [ -f /tmp/paperclip/env ]; then
  # shellcheck disable=SC1091
  . /tmp/paperclip/env
fi

# --- token resolution -------------------------------------------------------
# Prefer the adapter env binding; fall back to the run-scoped Paperclip secret API
# (the documented on-demand path when a secret_ref is not exported to the shell).
TOKEN="${DEV_GITHUB_PAT:-}"
if [ -z "$TOKEN" ] && [ -n "${PAPERCLIP_API_KEY:-}" ]; then
  API_BASE="${PAPERCLIP_API_URL%/}"
  TOKEN=$(curl -fsS -X POST \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID:-}" \
    "$API_BASE/api/agents/me/secrets/dev-github-pat/value" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).value||"")}catch{process.stdout.write("")}})' || true)
fi

# The credential helper below runs in a child shell, so the token must be
# exported for it. It is still never printed.
export DEV_GITHUB_PAT="$TOKEN"

# REEA-1135 (F6) — one credential helper for EVERY authenticated git call.
# Before this, fetch/ls-remote were handed an AUTH_URL that embedded the PAT
# (`https://x-access-token:<pat>@github.com/...`), so the token sat in those
# processes' argv and was visible in `ps` for the duration of the call. Passing
# the helper through `-c` instead keeps argv clean: the only token-bearing
# argument is the literal string `$DEV_GITHUB_PAT`, expanded by the helper's
# child shell from the environment. Still one-shot: nothing is written to
# .git/config and nothing is echoed.
CRED_HELPER='!f() { echo username=x-access-token; echo "password=$DEV_GITHUB_PAT"; }; f'

fallback_bundle() {
  local base remote bundle sha256 comment tmp_ref created
  # A bundle prerequisite must be an ancestor of the head, so use the merge-base
  # with the current remote tip — the remote tip itself may be ahead (non-FF).
  remote="${REMOTE:-}"
  if [ -z "$remote" ]; then
    remote=$(git rev-parse --verify --quiet origin/main 2>/dev/null || true)
  fi
  base=""
  if [ -n "$remote" ]; then
    base=$(git merge-base "$remote" "$SHA" 2>/dev/null || true)
  fi
  # An empty range (base == head) is not a failure: there is nothing to hand off
  # because origin/main already contains this commit.
  if [ -n "$base" ] && [ "$base" = "$SHA" ]; then
    echo "push-main: nothing to bundle — origin/main already contains $SHA" >&2
    return 1
  fi
  bundle="/tmp/reemco-$(git rev-parse --short "$SHA").bundle"
  # git bundle refuses a range built from bare object names (it records no ref
  # and calls the bundle "empty"), so export the head through a throwaway ref.
  tmp_ref="refs/push-main-export"
  git update-ref "$tmp_ref" "$SHA"
  created=0
  if [ -n "$base" ]; then
    git bundle create "$bundle" "$base..$tmp_ref" >/dev/null 2>&1 && created=1
  fi
  if [ "$created" = 0 ]; then
    git bundle create "$bundle" "$tmp_ref" >/dev/null 2>&1 && created=1
  fi
  git update-ref -d "$tmp_ref" 2>/dev/null || true
  if [ "$created" = 0 ]; then
    echo "push-main: could not create a bundle for $SHA" >&2
    return 0
  fi
  sha256=$(sha256sum "$bundle" | cut -d' ' -f1)
  echo "push-main: fallback bundle written to $bundle (sha256 $sha256)" >&2
  echo "push-main: base $base, head $SHA" >&2

  local attached="the bundle file"
  if [ -n "${PAPERCLIP_API_KEY:-}" ] && [ -n "${PAPERCLIP_COMPANY_ID:-}" ] &&
    [ -n "${PAPERCLIP_TASK_ID:-}" ]; then
    if curl -fsS -X POST \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID:-}" \
      -F "file=@$bundle" \
      "${PAPERCLIP_API_URL%/}/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments" >/dev/null; then
      echo "push-main: bundle attached to the current Paperclip issue" >&2
      attached="the issue attachment"
    else
      echo "push-main: bundle upload FAILED — attach $bundle by hand" >&2
      attached="$bundle (upload failed, attach it by hand)"
    fi
  else
    echo "push-main: no Paperclip run context; attach $bundle to the issue by hand" >&2
    attached="$bundle (attach it to the issue by hand)"
  fi

  comment="Commit $SHA is not on origin/main. Fallback bundle: $attached (sha256 $sha256, base $base). DevOps: \`git fetch <bundle> $SHA:refs/heads/main && scripts/push-main.sh --ref $SHA\`."
  echo "push-main: pickup request — $comment" >&2
}

fail_push() {
  # Any failure path is still a no-op success if the commit is already on
  # origin/main (e.g. a push that landed but could not be read back).
  if already_landed; then
    echo "push-main: $1" >&2
    echo "push-main: origin/main already contains $SHA — nothing to push (no-op)" >&2
    exit 0
  fi
  echo "push-main: $1" >&2
  if fallback_bundle; then
    exit 1
  fi
  # fallback_bundle found an empty range (base == head): already landed.
  echo "push-main: origin/main already contains $SHA — nothing to push (no-op)" >&2
  exit 0
}

if [ -z "$TOKEN" ]; then
  fail_push "no DEV_GITHUB_PAT (env binding empty and the Paperclip secret is not readable for this agent)"
fi

# --- fast-forward pre-flight ------------------------------------------------
# Origin's URL stays clean (`https://github.com/...`); the helper supplies the
# credential to the child process. No PAT in argv.
GIT_TERMINAL_PROMPT=0 git -c credential.helper="$CRED_HELPER" \
  fetch --no-tags --quiet origin refs/heads/main 2>/dev/null ||
  fail_push "could not fetch origin/main (auth rejected or network down)"
REMOTE=$(git rev-parse FETCH_HEAD)

if [ "$REMOTE" = "$SHA" ]; then
  echo "push-main: origin/main already equals $SHA — nothing to push"
  exit 0
fi

if ! git merge-base --is-ancestor "$REMOTE" "$SHA"; then
  fail_push "not a fast-forward: origin/main ($REMOTE) is not an ancestor of $SHA — rebase, do not force-push"
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "push-main: dry run OK — $REMOTE..$SHA is a fast-forward; nothing pushed"
  exit 0
fi

# --- push -------------------------------------------------------------------
# Same one-shot helper as the pre-flight: keeps the remote URL clean in git's
# output and the token out of .git/config (Least Privilege, no secret on disk).
GIT_TERMINAL_PROMPT=0 git \
  -c credential.helper="$CRED_HELPER" \
  push --quiet origin "$SHA:refs/heads/main" ||
  fail_push "git push failed (see the message above)"

PUSHED=$(GIT_TERMINAL_PROMPT=0 git -c credential.helper="$CRED_HELPER" \
  ls-remote --heads origin refs/heads/main | cut -f1)
if [ "$PUSHED" != "$SHA" ]; then
  fail_push "push did not land: origin/main is $PUSHED, expected $SHA"
fi

echo "push-main: origin/main = $SHA — deploy-selfhosted.yml runs on this push"
