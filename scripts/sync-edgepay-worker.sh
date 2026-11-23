#!/usr/bin/env bash
# Deploy the main DakFlare Worker code to the EdgePay-owned isolated Worker.
#
# Why this exists: `edgepay-dakflare-worker` is a second deployment of this
# repository's Worker against its own D1/KV/R2/queues. Without a sync lane it
# silently ages while `main` gains signature, rotation and scope fixes. This
# script runs from a systemd user timer (or by hand) and deploys `origin/main`
# when the Worker source or its isolated config changed.
#
# Design constraints:
#   - It never touches the operator's working tree: a detached worktree at
#     `origin/main` is checked out in the state directory.
#   - It never stores a Cloudflare credential. Wrangler uses the operator's
#     existing OAuth session (`~/.config/.wrangler`), matching the repository's
#     "deployment is sovereign, not a CI secret" rule.
#   - A deploy is only recorded after the new manifest route answers. A failed
#     upload leaves the previous version serving traffic.
#   - Refuse to run over a dirty worktree state, and serialize with flock.
#
# Manual use:
#   ./scripts/sync-edgepay-worker.sh              # deploy if main advanced
#   DAKFLARE_SYNC_DRY_RUN=1 ./scripts/sync-edgepay-worker.sh
#   DAKFLARE_SYNC_FORCE=1 ./scripts/sync-edgepay-worker.sh   # redeploy HEAD
set -euo pipefail

REPO="${DAKFLARE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${DAKFLARE_SYNC_BRANCH:-main}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dakflare"
STATE_FILE="$STATE_DIR/edgepay-worker.commit"
LOCK_HASH_FILE="$STATE_DIR/edgepay-worker.lockhash"
LOG_FILE="$STATE_DIR/edgepay-worker.log"
LOCK_FILE="$STATE_DIR/edgepay-worker.lock"
WORKTREE="$STATE_DIR/edgepay-worker-worktree"
CONFIG="worker/wrangler.edgepay.toml"
VERIFY_URL="${DAKFLARE_VERIFY_URL:-https://edgepay-dakflare-worker.sohelahmedjony.workers.dev/v1/integration/manifest}"

mkdir -p "$STATE_DIR"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG_FILE"
}

# One sync at a time. A timer tick that overlaps a slow npm ci exits quietly.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

cd "$REPO"
if ! git fetch --quiet origin "$BRANCH"; then
  log "fetch failed; keeping the current deployment"
  exit 1
fi
TARGET="$(git rev-parse "origin/$BRANCH")"
LAST="$(cat "$STATE_FILE" 2>/dev/null || true)"

if [ "${DAKFLARE_SYNC_FORCE:-0}" != "1" ] && [ "$TARGET" = "$LAST" ]; then
  exit 0
fi

if [ "${DAKFLARE_SYNC_DRY_RUN:-0}" = "1" ]; then
  echo "target=$TARGET last=${LAST:-none} config=$CONFIG"
  exit 0
fi

# A persistent detached worktree keeps node_modules between runs but never
# depends on the operator's current branch or uncommitted edits.
if [ -d "$WORKTREE/.git" ] || [ -f "$WORKTREE/.git" ]; then
  git -C "$WORKTREE" checkout --quiet --detach "$TARGET"
else
  git worktree add --quiet --detach "$WORKTREE" "$TARGET"
fi

# Only a Worker-source or isolated-config change needs a deploy. A docs-only
# commit still advances the recorded commit, so it is not re-examined forever.
if [ -n "$LAST" ] && git cat-file -e "$LAST^{commit}" 2>/dev/null; then
  if git diff --quiet "$LAST".."$TARGET" -- \
    worker/src \
    worker/package.json \
    worker/package-lock.json \
    "$CONFIG" \
    worker/migrations; then
    printf '%s\n' "$TARGET" >"$STATE_FILE"
    log "recorded $TARGET; no Worker change"
    exit 0
  fi
fi

cd "$WORKTREE/worker"

LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
PREV_LOCK="$(cat "$LOCK_HASH_FILE" 2>/dev/null || true)"
if [ "$LOCK_HASH" != "$PREV_LOCK" ] || [ ! -d node_modules ]; then
  if ! npm ci --no-audit --no-fund >>"$LOG_FILE" 2>&1; then
    log "npm ci failed for $TARGET"
    exit 1
  fi
  printf '%s\n' "$LOCK_HASH" >"$LOCK_HASH_FILE"
fi

# A code deploy against an old schema is the failure this guard exists for: the
# new Worker starts serving before the columns it reads exist. Leave the previous
# version live until a human applies the migration from the sync worktree.
PENDING_MIGRATIONS="$(npx wrangler d1 migrations list DB --remote --config wrangler.edgepay.toml 2>/dev/null \
  | grep -Eo '[0-9]{4}_[a-z0-9_]+\.sql' | sort -u | tr '\n' ' ' || true)"
if [ -n "$PENDING_MIGRATIONS" ]; then
  log "pending D1 migrations: $PENDING_MIGRATIONS; apply them before deploying $TARGET"
  exit 1
fi

# Wrangler refuses to upload when a `cf` build output is present; it would read
# a different configuration. Move it aside for this deploy.
if [ -d .cloudflare/output ]; then
  mv .cloudflare/output ".cloudflare/output.sync-backup-$(date +%s)"
fi

if ! npx wrangler deploy --config wrangler.edgepay.toml >>"$LOG_FILE" 2>&1; then
  log "deploy failed for $TARGET"
  exit 1
fi

# 200 and 401 both mean the manifest route exists; 404 means the old build.
for _ in 1 2 3 4 5; do
  status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$VERIFY_URL" || true)"
  case "$status" in
    200|401)
      printf '%s\n' "$TARGET" >"$STATE_FILE"
      log "deployed $TARGET (manifest HTTP $status)"
      exit 0
      ;;
  esac
  sleep 2
done

log "deployed $TARGET but manifest verification failed; will retry next run"
exit 1
