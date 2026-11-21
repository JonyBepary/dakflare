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
# Overridable: WORKER_PORT, STUB_PORT, MODEL_PORT, ACK_TIMEOUT_MS, LEASE_MS,
# OFFLINE_ALERT_MS, STALE_SOCKET_MS, AUTH_PEPPER, AUTH_LOCKOUT_WINDOW_SECONDS,
# AUTH_PASSWORD_MODE, AUTH_BASE_URL, AUTH_TRUSTED_ORIGINS.
#
#   ./test-support/dev.sh
#
# Then, in another terminal:
#   node dakflare_test_harness.mjs pair
#   node dakflare_test_harness.mjs suite
#
# NOTE: this does not wipe state. For the fresh-state run required by the plan:
#   rm -rf worker/.wrangler/state

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORKER_DIR="$ROOT/worker"

WORKER_PORT="${WORKER_PORT:-8787}"
STUB_PORT="${STUB_PORT:-8790}"
# A deterministic OpenAI-compatible chat endpoint. Workers AI cannot run under
# `wrangler dev --local` (the binding needs a real account), so an agent turn or
# a webhook delivery has no model at all without this. It is a fixture, not a
# provider: the conformance assertions stay on Worker HTTP answers and D1 rows.
MODEL_PORT="${MODEL_PORT:-8791}"
ACK_TIMEOUT_MS="${ACK_TIMEOUT_MS:-1500}"
# The lease must be LONGER than the ack timeout, as it is in production
# (60 s vs 8 s), or the two timers cannot be told apart: `ack_wake` would close
# the socket at the same instant `lease_expiry` reverts the command, and the
# re-delivery path would never be exercised.
LEASE_MS="${LEASE_MS:-6000}"
OFFLINE_ALERT_MS="${OFFLINE_ALERT_MS:-5000}"
STALE_SOCKET_MS="${STALE_SOCKET_MS:-2000}"

# The split means two Workers, and `wrangler dev` runs them in one Miniflare
# instance with `-c` per Worker. That matters beyond convenience: the agent
# Worker reads the same D1 rows as the main Worker, and Miniflare allows only
# one process per persistence directory, so two `wrangler dev` processes cannot
# share a database. `AGENT_CONFIG` is the second `-c`.
if [ "${ACCOUNT_BACKED:-0}" = "1" ]; then
  MODE_ARGS=(-c wrangler.account.toml)
  AGENT_SOURCE="wrangler.agent.toml"
  AGENT_CONFIG="wrangler.agent.account.generated.toml"
  MIGRATE_DB="sms_gateway_preview"
  MIGRATE_FLAG="--remote"
  MODE_LABEL="account-backed (real PREVIEW D1 + KV)"
else
  MODE_ARGS=(-c wrangler.toml --local)
  AGENT_CONFIG="wrangler.agent.toml"
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

echo "[dev.sh] starting deterministic model stub on :$MODEL_PORT"
MODEL_PORT="$MODEL_PORT" node "$HERE/model-stub.mjs" &
PIDS+=($!)

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$MODEL_PORT/__health" >/dev/null 2>&1; then break; fi
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

EXTRA_VARS=()
if [ -n "${AUTH_PEPPER:-}" ]; then
  EXTRA_VARS+=(--var "AUTH_PEPPER:$AUTH_PEPPER")
fi
if [ -n "${AUTH_LOCKOUT_WINDOW_SECONDS:-}" ]; then
  EXTRA_VARS+=(--var "AUTH_LOCKOUT_WINDOW_SECONDS:$AUTH_LOCKOUT_WINDOW_SECONDS")
fi
if [ -n "${AUTH_PASSWORD_MODE:-}" ]; then
  EXTRA_VARS+=(--var "AUTH_PASSWORD_MODE:$AUTH_PASSWORD_MODE")
fi
if [ -n "${AUTH_BASE_URL:-}" ]; then
  EXTRA_VARS+=(--var "AUTH_BASE_URL:$AUTH_BASE_URL")
elif [ "$WORKER_PORT" != "8787" ]; then
  EXTRA_VARS+=(--var "AUTH_BASE_URL:http://127.0.0.1:$WORKER_PORT")
fi
if [ -n "${AUTH_TRUSTED_ORIGINS:-}" ]; then
  EXTRA_VARS+=(--var "AUTH_TRUSTED_ORIGINS:$AUTH_TRUSTED_ORIGINS")
elif [ "$WORKER_PORT" != "8787" ]; then
  EXTRA_VARS+=(--var "AUTH_TRUSTED_ORIGINS:http://127.0.0.1:$WORKER_PORT")
fi

if [ "${ACCOUNT_BACKED:-0}" = "1" ]; then
  # The agent Worker has to read the preview database, not a second local copy of
  # the production id. Generated, git-ignored, and rewritten on every start.
  PREVIEW_D1_ID="$(sed -n 's/^database_id = "\(.*\)"/\1/p' "$WORKER_DIR/wrangler.account.toml" | head -1)"
  node -e '
    const fs = require("fs");
    const [source, target, id] = process.argv.slice(1);
    const text = fs.readFileSync(source, "utf8")
      .replace(/database_name = "sms_gateway"/, "database_name = \"sms_gateway_preview\"")
      .replace(/database_id = "[^"]*"/, `database_id = "${id}"\nremote = true`);
    fs.writeFileSync(target, text);
  ' "$WORKER_DIR/$AGENT_SOURCE" "$WORKER_DIR/$AGENT_CONFIG" "$PREVIEW_D1_ID"
fi

echo "[dev.sh] starting Worker on :$WORKER_PORT ($MODE_LABEL, ACK_TIMEOUT_MS=$ACK_TIMEOUT_MS, LEASE_MS=$LEASE_MS)"
export HARNESS_ACK_TIMEOUT_MS="$ACK_TIMEOUT_MS"
export HARNESS_LEASE_MS="$LEASE_MS"
(
  cd "$WORKER_DIR"
  exec npx wrangler dev "${MODE_ARGS[@]}" -c "$AGENT_CONFIG" --port "$WORKER_PORT" --env-file .dev.vars \
    --var "ACK_TIMEOUT_MS:$ACK_TIMEOUT_MS" \
    --var "LEASE_MS:$LEASE_MS" \
    --var "OFFLINE_ALERT_MS:$OFFLINE_ALERT_MS" \
    --var "STALE_SOCKET_MS:$STALE_SOCKET_MS" \
    --var "FCM_BASE_URL:http://127.0.0.1:$STUB_PORT" \
    --var "GOOGLE_TOKEN_URL:http://127.0.0.1:$STUB_PORT/token" \
    --var "FCM_SERVICE_ACCOUNT_JSON:$SA_JSON" \
    --var "AI_CHAT_PROVIDER:openai-compatible" \
    --var "AI_CHAT_MODEL:model-stub" \
    --var "AI_CHAT_BASE_URL:http://127.0.0.1:$MODEL_PORT/v1" \
    --var "AI_PROVIDER_API_KEY:dev-model-stub-key" \
    --var "WEBHOOK_SECRET_KEY:dev-webhook-seal-key" \
    "${EXTRA_VARS[@]}"
) &
PIDS+=($!)

echo "[dev.sh] ready. Worker :$WORKER_PORT  Stub :$STUB_PORT"
wait
