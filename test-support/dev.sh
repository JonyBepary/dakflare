#!/usr/bin/env bash
#
# test-support/dev.sh — start everything the conformance suite needs, with the
# timing that lets it exercise real alarms instead of sleeping for 8 seconds.
#
# It starts, in order:
#   1. the FCM / Google OAuth2 stub          (default :8790)
#   2. the Worker under `wrangler dev --local` (default :8787), with
#        - FCM_BASE_URL / GOOGLE_TOKEN_URL redirected at the stub
#        - FCM_SERVICE_ACCOUNT_JSON loaded from the stub fixture
#        - ACK_TIMEOUT_MS woven down so `ack_timeout` fires in ~1.5 s
#   3. `HARNESS_ACK_TIMEOUT_MS` exported so the harness waits the right amount.
#
# Overridable: WORKER_PORT, STUB_PORT, ACK_TIMEOUT_MS, OFFLINE_ALERT_MS,
# STALE_SOCKET_MS, FCM_STUB_PORT (plain env assignment, no CLI flags needed).
#
#   ./test-support/dev.sh            # foreground; Ctrl-C stops both
#
# Then, in another terminal:
#   node sms_gateway_test_harness.mjs pair
#   node sms_gateway_test_harness.mjs suite
#
# NOTE: this does NOT wipe state. For the fresh-state run required by the plan:
#   rm -rf worker/.wrangler/state
# and restart this script (it re-applies the D1 migration).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORKER_DIR="$ROOT/worker"

WORKER_PORT="${WORKER_PORT:-8787}"
STUB_PORT="${STUB_PORT:-8790}"
ACK_TIMEOUT_MS="${ACK_TIMEOUT_MS:-1500}"
OFFLINE_ALERT_MS="${OFFLINE_ALERT_MS:-5000}"
STALE_SOCKET_MS="${STALE_SOCKET_MS:-2000}"

# Two modes, one config. wrangler.toml marks D1 and KV `remote = true`, so:
#   ACCOUNT_BACKED=1  -> `wrangler dev`          : real D1 + KV, local Worker + DO
#   ACCOUNT_BACKED=0  -> `wrangler dev --local`  : everything local
# `--local` disables remote bindings, which is why the same wrangler.toml serves both.
if [ "${ACCOUNT_BACKED:-0}" = "1" ]; then
  MODE_FLAG=""
  MIGRATE_FLAG="--remote"
  MODE_LABEL="account-backed (real D1 + KV)"
else
  MODE_FLAG="--local"
  MIGRATE_FLAG="--local"
  MODE_LABEL="local"
fi

# The service-account fixture is single-line JSON with escaped newlines, so it
# survives being passed as a single --var value.
SA_JSON="$(node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "$HERE/stub-service-account.json")"

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

# Wait for the stub to answer before pointing the Worker at it.
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$STUB_PORT/__log" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

echo "[dev.sh] applying D1 migration ($MIGRATE_FLAG)"
( cd "$WORKER_DIR" && npx wrangler d1 migrations apply sms_gateway "$MIGRATE_FLAG" >/dev/null 2>&1 ) || true

echo "[dev.sh] starting Worker on :$WORKER_PORT ($MODE_LABEL, ACK_TIMEOUT_MS=$ACK_TIMEOUT_MS)"
export HARNESS_ACK_TIMEOUT_MS="$ACK_TIMEOUT_MS"
(
  cd "$WORKER_DIR"
  exec npx wrangler dev $MODE_FLAG --port "$WORKER_PORT" \
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
