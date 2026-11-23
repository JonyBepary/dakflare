#!/usr/bin/env bash
# Check for, or explicitly deploy, a verified DakFlare update to the EdgePay
# isolated Worker.
#
# Default mode is CHECK. Nothing is deployed unless `--deploy` is passed by an
# operator (the EdgePay CLI passes it after an explicit confirmation). The
# systemd timer runs `--check --notify` only.
#
# A candidate must be:
#   1. on origin/main (never a PR head or another branch);
#   2. verified by the repository's Conformance Pipeline (`pipeline.yml`)
#      with status=completed and conclusion=success;
#   3. at least `--min-age-hours` old since that CI run (default 24h), so a
#      late-night merge waits for a deliberate update;
#   4. a Worker-source/migration/config change (docs-only commits are not a
#      reason to deploy).
#
# D1 migrations are never applied implicitly. `--apply-migrations` is required,
# and the operator confirms it in the EdgePay CLI before this script runs.
#
# Manual use:
#   ./scripts/sync-edgepay-worker.sh                       # check, human output
#   ./scripts/sync-edgepay-worker.sh --check --json
#   ./scripts/sync-edgepay-worker.sh --deploy --min-age-hours 24
#   ./scripts/sync-edgepay-worker.sh --deploy --apply-migrations
#   ./scripts/sync-edgepay-worker.sh --deploy --commit <sha>
set -euo pipefail

MODE="check"
JSON=0
NOTIFY=0
MIN_AGE_HOURS="${DAKFLARE_MIN_AGE_HOURS:-24}"
APPLY_MIGRATIONS=0
TARGET_SHA=""

REPO="${DAKFLARE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${DAKFLARE_SYNC_BRANCH:-main}"
REPO_SLUG="${DAKFLARE_REPO_SLUG:-JonyBepary/dakflare}"
WORKFLOW="${DAKFLARE_CI_WORKFLOW:-pipeline.yml}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dakflare"
STATE_FILE="$STATE_DIR/edgepay-worker.commit"
LOCK_HASH_FILE="$STATE_DIR/edgepay-worker.lockhash"
LOG_FILE="$STATE_DIR/edgepay-worker.log"
LOCK_FILE="$STATE_DIR/edgepay-worker.lock"
WORKTREE="$STATE_DIR/edgepay-worker-worktree"
CONFIG="worker/wrangler.edgepay.toml"
VERIFY_URL="${DAKFLARE_VERIFY_URL:-https://edgepay-dakflare-worker.sohelahmedjony.workers.dev/v1/integration/manifest}"

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --deploy) MODE="deploy" ;;
    --json) JSON=1 ;;
    --notify) NOTIFY=1 ;;
    --apply-migrations) APPLY_MIGRATIONS=1 ;;
    --min-age-hours)
      [ "$#" -ge 2 ] || { echo "--min-age-hours needs a value" >&2; exit 2; }
      MIN_AGE_HOURS="$2"
      shift
      ;;
    --commit)
      [ "$#" -ge 2 ] || { echo "--commit needs a value" >&2; exit 2; }
      TARGET_SHA="$2"
      shift
      ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

case "$MIN_AGE_HOURS" in
  ''|*[!0-9]*) echo "--min-age-hours must be a non-negative integer" >&2; exit 2 ;;
esac

mkdir -p "$STATE_DIR"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG_FILE"
}

# One operation at a time. A timer check that overlaps an operator deploy exits.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  [ "$JSON" -eq 1 ] && printf '{"ok":false,"reason":"busy"}\n'
  exit 0
fi

cd "$REPO"
if ! git fetch --quiet origin "$BRANCH"; then
  log "fetch failed; keeping the current deployment"
  [ "$JSON" -eq 1 ] && printf '{"ok":false,"reason":"fetch_failed"}\n'
  exit 1
fi

TARGET="${TARGET_SHA:-$(git rev-parse "origin/$BRANCH")}"
LAST="$(cat "$STATE_FILE" 2>/dev/null || true)"

# A candidate must be reachable from origin/main. This rejects PR heads and
# feature branches even if someone passes --commit.
if ! git merge-base --is-ancestor "$TARGET" "origin/$BRANCH"; then
  REASON="commit_not_on_main"
  ELIGIBLE=0
  AVAILABLE=0
  WORKER_CHANGED=0
  PENDING=""
  CI_STATUS="missing"
  CI_CONCLUSION="missing"
  CI_URL=""
  CI_CREATED=""
  AGE_HOURS=""
else
  # Worker-source relevance. Docs/scripts/tests are not a reason to deploy.
  WORKER_CHANGED=1
  MIGRATIONS_CHANGED=0
  FORWARD_OK=1
  if [ -n "$LAST" ] && git cat-file -e "$LAST^{commit}" 2>/dev/null; then
    # Deployed -> target must be a forward update. This refuses a rollback via
    # --commit as well as a branch that merely contains the deployed commit.
    if ! git merge-base --is-ancestor "$LAST" "$TARGET"; then
      FORWARD_OK=0
    fi
    if git diff --quiet "$LAST".."$TARGET" -- \
      worker/src \
      worker/migrations \
      worker/package.json \
      worker/package-lock.json \
      "$CONFIG"; then
      WORKER_CHANGED=0
    fi
    if ! git diff --quiet "$LAST".."$TARGET" -- worker/migrations; then
      MIGRATIONS_CHANGED=1
    fi
  fi

  # CI verification. `gh` is the operator's existing authenticated session.
  CI_JSON="[]"
  if command -v gh >/dev/null 2>&1; then
    CI_JSON="$(gh run list \
      --repo "$REPO_SLUG" \
      --workflow "$WORKFLOW" \
      --branch "$BRANCH" \
      --commit "$TARGET" \
      --limit 1 \
      --json status,conclusion,createdAt,url,headSha 2>/dev/null || echo '[]')"
  fi
  CI_STATUS="$(printf '%s' "$CI_JSON" | jq -r '.[0].status // "missing"')"
  CI_CONCLUSION="$(printf '%s' "$CI_JSON" | jq -r '.[0].conclusion // "missing"')"
  CI_URL="$(printf '%s' "$CI_JSON" | jq -r '.[0].url // ""')"
  CI_CREATED="$(printf '%s' "$CI_JSON" | jq -r '.[0].createdAt // ""')"
  CI_SHA="$(printf '%s' "$CI_JSON" | jq -r '.[0].headSha // ""')"
  if [ -n "$CI_SHA" ] && [ "$CI_SHA" != "$TARGET" ]; then
    CI_STATUS="mismatch"
    CI_CONCLUSION="mismatch"
  fi

  AGE_HOURS=""
  AGE_OK=0
  if [ -n "$CI_CREATED" ]; then
    CI_EPOCH="$(date -d "$CI_CREATED" +%s 2>/dev/null || echo '')"
    if [ -n "$CI_EPOCH" ]; then
      AGE_HOURS=$(( ( $(date +%s) - CI_EPOCH ) / 3600 ))
      if [ "$AGE_HOURS" -ge "$MIN_AGE_HOURS" ]; then AGE_OK=1; fi
    fi
  fi

  # Pending migrations are reported even in check mode. A deploy is blocked
  # until the operator passes --apply-migrations.
  PENDING=""
  if [ -d "$REPO/worker/node_modules" ]; then
    PENDING="$(cd "$REPO/worker" && npx wrangler d1 migrations list DB --remote --config wrangler.edgepay.toml 2>/dev/null \
      | grep -Eo '[0-9]{4}_[a-z0-9_]+\.sql' | sort -u | tr '\n' ' ' || true)"
  fi

  AVAILABLE=0
  REASON="up_to_date"
  if [ "$FORWARD_OK" -ne 1 ]; then
    REASON="not_a_forward_update"
  elif [ "$TARGET" != "$LAST" ] && [ "$WORKER_CHANGED" -eq 1 ]; then
    AVAILABLE=1
    REASON="available"
  elif [ "$TARGET" != "$LAST" ]; then
    REASON="no_worker_change"
  fi

  ELIGIBLE=0
  if [ "$AVAILABLE" -eq 1 ]; then
    if [ "$CI_STATUS" != "completed" ] || [ "$CI_CONCLUSION" != "success" ]; then
      REASON="ci_not_green"
    elif [ "$AGE_OK" -ne 1 ]; then
      REASON="soak_window"
    elif [ -n "$PENDING" ] && [ "$APPLY_MIGRATIONS" -ne 1 ] && [ "$MODE" = "deploy" ]; then
      REASON="pending_migrations"
    else
      ELIGIBLE=1
      REASON="ok"
    fi
  fi
fi

if [ "$JSON" -eq 1 ]; then
  jq -n \
    --arg deployed "$LAST" \
    --arg target "$TARGET" \
    --arg branch "$BRANCH" \
    --argjson worker_changed "$WORKER_CHANGED" \
    --argjson migrations_changed "$MIGRATIONS_CHANGED" \
    --argjson available "$AVAILABLE" \
    --argjson eligible "$ELIGIBLE" \
    --arg reason "$REASON" \
    --arg ci_status "$CI_STATUS" \
    --arg ci_conclusion "$CI_CONCLUSION" \
    --arg ci_url "$CI_URL" \
    --arg ci_created "$CI_CREATED" \
    --arg age_hours "$AGE_HOURS" \
    --argjson min_age_hours "$MIN_AGE_HOURS" \
    --arg pending "$PENDING" \
    '{
      ok: true,
      deployed_commit: $deployed,
      target_commit: $target,
      branch: $branch,
      worker_changed: $worker_changed,
      migrations_changed: $migrations_changed,
      available: $available,
      eligible: $eligible,
      reason: $reason,
      ci: {status: $ci_status, conclusion: $ci_conclusion, url: $ci_url, created_at: $ci_created},
      age_hours: (if $age_hours == "" then null else ($age_hours | tonumber) end),
      min_age_hours: $min_age_hours,
      pending_migrations: ($pending | split(" ") | map(select(length > 0)))
    }'
else
  echo "deployed:   ${LAST:-none}"
  echo "target:     $TARGET"
  echo "worker:     $([ "$WORKER_CHANGED" -eq 1 ] && echo changed || echo unchanged)"
  echo "migration files: $([ "$MIGRATIONS_CHANGED" -eq 1 ] && echo changed || echo unchanged)"
  echo "ci:         $CI_STATUS/$CI_CONCLUSION${CI_URL:+ $CI_URL}"
  echo "soak:       ${AGE_HOURS:-?}h (minimum ${MIN_AGE_HOURS}h)"
  echo "migrations: ${PENDING:-none pending}"
  echo "available:  $AVAILABLE"
  echo "eligible:   $ELIGIBLE ($REASON)"
fi

if [ "$MODE" = "check" ]; then
  if [ "$NOTIFY" -eq 1 ] && [ "$AVAILABLE" -eq 1 ] && [ "$ELIGIBLE" -eq 1 ] && [ -z "$PENDING" ]; then
    if command -v notify-send >/dev/null 2>&1; then
      notify-send "DakFlare update available" \
        "Commit ${TARGET:0:12} passed CI and the ${MIN_AGE_HOURS}h soak. Run: edgepay dakflare worker update"
    fi
  fi
  log "check: target=$TARGET available=$AVAILABLE eligible=$ELIGIBLE reason=$REASON pending='${PENDING:-none}'"
  exit 0
fi

# ---- deploy mode -----------------------------------------------------------
if [ "$ELIGIBLE" -ne 1 ]; then
  log "deploy refused for $TARGET: $REASON"
  echo "Refusing to deploy: $REASON" >&2
  exit 1
fi
if [ -n "$PENDING" ] && [ "$APPLY_MIGRATIONS" -ne 1 ]; then
  log "deploy refused for $TARGET: pending migrations $PENDING"
  echo "Pending D1 migrations: $PENDING" >&2
  echo "Re-run with --apply-migrations after reviewing them." >&2
  exit 1
fi

# A persistent detached worktree keeps node_modules between runs but never
# depends on the operator's current branch or uncommitted edits.
if [ -d "$WORKTREE/.git" ] || [ -f "$WORKTREE/.git" ]; then
  git -C "$WORKTREE" checkout --quiet --detach "$TARGET"
else
  git worktree add --quiet --detach "$WORKTREE" "$TARGET"
fi

cd "$WORKTREE/worker"

LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
PREV_LOCK="$(cat "$LOCK_HASH_FILE" 2>/dev/null || true)"
if [ "$LOCK_HASH" != "$PREV_LOCK" ] || [ ! -d node_modules ]; then
  if ! npm ci --no-audit --no-fund >>"$LOG_FILE" 2>&1; then
    log "npm ci failed for $TARGET"
    echo "npm ci failed; see $LOG_FILE" >&2
    exit 1
  fi
  printf '%s\n' "$LOCK_HASH" >"$LOCK_HASH_FILE"
fi

# The check above runs in the operator's current worktree; the target may add
# a migration file that is not present there. Recompute from the detached
# target worktree, and refuse if anything is pending without --apply-migrations.
PENDING_TARGET="$(npx wrangler d1 migrations list DB --remote --config wrangler.edgepay.toml 2>/dev/null \
  | grep -Eo '[0-9]{4}_[a-z0-9_]+\.sql' | sort -u | tr '\n' ' ' || true)"
if [ -n "$PENDING_TARGET" ] && [ "$APPLY_MIGRATIONS" -ne 1 ]; then
  log "deploy refused for $TARGET: target worktree has pending migrations $PENDING_TARGET"
  echo "Pending D1 migrations in the target: $PENDING_TARGET" >&2
  echo "Re-run with --apply-migrations after reviewing them." >&2
  exit 1
fi
if [ -n "$PENDING_TARGET" ] && [ "$APPLY_MIGRATIONS" -eq 1 ]; then
  if ! npx wrangler d1 migrations apply DB --remote --config wrangler.edgepay.toml >>"$LOG_FILE" 2>&1; then
    log "migration apply failed for $TARGET"
    echo "D1 migration apply failed; see $LOG_FILE" >&2
    exit 1
  fi
fi

# Wrangler refuses to upload when a `cf` build output is present; it would read
# a different configuration. Move it aside for this deploy.
if [ -d .cloudflare/output ]; then
  mv .cloudflare/output ".cloudflare/output.sync-backup-$(date +%s)"
fi

if ! npx wrangler deploy --config wrangler.edgepay.toml >>"$LOG_FILE" 2>&1; then
  log "deploy failed for $TARGET"
  echo "Worker deploy failed; see $LOG_FILE" >&2
  exit 1
fi

# 200 and 401 both mean the manifest route exists; 404 means the old build.
for _ in 1 2 3 4 5; do
  status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$VERIFY_URL" || true)"
  case "$status" in
    200|401)
      printf '%s\n' "$TARGET" >"$STATE_FILE"
      log "deployed $TARGET (manifest HTTP $status)"
      echo "Deployed $TARGET"
      exit 0
      ;;
  esac
  sleep 2
done

log "deployed $TARGET but manifest verification failed; state not advanced"
echo "Deployed $TARGET, but the manifest check failed; state not advanced." >&2
exit 1
