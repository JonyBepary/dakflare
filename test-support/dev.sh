#!/usr/bin/env bash
#
# test-support/dev.sh — start everything the conformance suite needs, with the
# timing that lets it exercise real alarms instead of sleeping for eight seconds.
#
# Two modes, deliberately different config files:
#
#   ACCOUNT_BACKED=0 (default)  -> wrangler dev --local
#                                  everything local; cannot reach production
#   ACCOUNT_BACKED=1            -> wrangler dev --config wrangler.account.toml
#                                  local Worker + DO, real PREVIEW D1 + KV
#
# The account-backed lane points at `sms_gateway_preview`, never the production
# database: the suite writes rules and messages, and those must not land in the
# database a real phone will pair against.
#
# Overridable: WORKER_PORT, STUB_PORT, ACK_TIMEOUT_MS, OFFLINE_ALERT_MS,
# STALE_SOCKET_MS.
#
#   ./test-support/dev.sh
#
# Then, in another terminal:
#   node sms_gateway_test_harness.mjs pair
#   node sms_gateway_test_harness.mjs suite
#
# NOTE: this does not wipe state. For the fresh-state run required by the plan:
#   rm -rf worker/.wrangler/state

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORKER_DIR="$ROOT/worker"

WORKER_PORT="${WORKER_PORT:-8787}"
STUB_PORT="${STUB_PORT:-8790}"
ACK_TIMEOUT_MS="${ACK_TIMEOUT_MS:-1500}"
OFFLINE_ALERT_MS="${OFFLINE_ALERT_MS:-5000}"
STALE_SOCKET_MS="${STALE_SOCKET_MS:-2000}"

if [ "${ACCOUNT_BACKED:-0}" = "1" ]; then
  MODE_ARGS=(--config wrangler.account.toml --env-file .dev.vars)
  MIGRATE_DB="sms_gateway_preview"
  MIGRATE_FLAG="--remote"
  MODE_LABEL="account-backed (real PREVIEW D1 + KV)"
else
  MODE_ARGS=(--local)
  MIGRATE_DB="sms_gateway"
  MIGRATE_FLAG="--local"
  MODE_LABEL="local"
fi

PIDS=()
cleanup() {
  echo
  echo "[dev.sh] shutting down..."
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

echo "[dev.sh] starting FCM/OAuth stub on :$STUB_PORT"
node "$HERE/fcm-stub.mjs" --port "$STUB_PORT" &
PIDS+=($!)

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$STUB_PORT/__log" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# Read the service-account fixture ONLY AFTER the stub is up: fcm-stub.mjs
# generates the keypair if the file is missing (it is git-ignored), and minifies
# it so it survives as a single `--var` value.
SA_JSON="$(node -e '
  const fs = require("fs");
  const p = process.argv[1];
  if (!fs.existsSync(p)) { process.stderr.write("missing " + p + "\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(p, "utf8"))));
' "$HERE/stub-service-account.json")"

echo "[dev.sh] applying D1 migration ($MIGRATE_DB $MIGRATE_FLAG)"
( cd "$WORKER_DIR" && npx wrangler d1 migrations apply "$MIGRATE_DB" "$MIGRATE_FLAG" >/dev/null 2>&1 ) || true

echo "[dev.sh] starting Worker on :$WORKER_PORT ($MODE_LABEL, ACK_TIMEOUT_MS=$ACK_TIMEOUT_MS)"
export HARNESS_ACK_TIMEOUT_MS="$ACK_TIMEOUT_MS"
(
  cd "$WORKER_DIR"
  exec npx wrangler dev "${MODE_ARGS[@]}" --port "$WORKER_PORT" \
    --var "ACK_TIMEOUT_MS:$ACK_TIMEOUT_MS" \
    --var "OFFLINE_ALERT_MS:$OFFLINE_ALERT_MS" \
    --var "STALE_SOCKET_MS:$STALE_SOCKET_MS" \
    --var "FCM_BASE_URL:http://127.0.0.1:$STUB_PORT" \
    --var "GOOGLE_TOKEN_URL:http://127.0.0.1:$STUB_PORT/token" \
    --var "FCM_SERVICE_ACCOUNT_JSON:$SA_JSON"
) &
PIDS+=($!)

echo "[dev.sh] ready. Worker :$WORKER_PORT  Stub :$STUB_PORT"
wait
