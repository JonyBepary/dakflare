-- DakFlare v6.0 — enterprise verticals, split-horizon bookkeeping, multi-SIM policy.
--
-- Additive on purpose. Every statement is CREATE ... IF NOT EXISTS or an
-- ALTER ... ADD COLUMN, so applying it twice is a no-op and a v5.2.1 Worker that
-- does not know these tables keeps working against the same database. The one
-- behavioural change it records is the split-horizon columns on workflows and
-- flow_runs, which only the v6 code reads.
--
-- Row counts here are read by the console and the CLI, not by the DO. The
-- Durable Object's own SQLite stays where it is: this file never touches it.
--
--   npx cf d1 migrations apply sms_gateway --local    # try it
--   Actions -> D1 migrations                          # apply it for real
--
-- Take a backup first: docs/OPS_BACKUP.md.

-- ---------------------------------------------------------------------------
-- 18. Webhook endpoints
--
-- `secret_ring` is a dual-ring value, "v2:whsec_...,v1:whsec_...", so a secret
-- can be rotated without a window where one side signs with a key the other does
-- not know. Every delivery carries both rings so a receiver can migrate at its
-- own pace.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhooks (
  id                  TEXT PRIMARY KEY NOT NULL,
  name                TEXT NOT NULL,
  vertical            TEXT NOT NULL CHECK (vertical IN ('generic', 'ecommerce', 'finance', 'healthcare', 'education')),
  target_url          TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  events_json         TEXT NOT NULL,
  secret_ring         TEXT NOT NULL,
  custom_headers_json TEXT,
  timeout_ms          INTEGER NOT NULL DEFAULT 10000,
  max_attempts        INTEGER NOT NULL DEFAULT 8,
  device_id           TEXT REFERENCES devices(device_id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 19. Webhook delivery ledger
--
-- One row per (webhook, event, idempotency key). The unique key is what makes a
-- retried enqueue safe: the Worker can re-run the same accepted batch without
-- dispatching the same delivery twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_deliveries (
  id               TEXT PRIMARY KEY NOT NULL,
  webhook_id       TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  payload_json     TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'DELIVERED', 'RETRYING', 'DEAD_LETTER')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_http_status INTEGER,
  last_error       TEXT,
  delivered_at     INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_deliveries_dispatch
  ON integration_deliveries(state, next_attempt_at);

-- ---------------------------------------------------------------------------
-- 20. Financial ledger (MFS and bank SMS, ISO 20022 camt.054 shaped)
--
-- `amount_minor` and `fee_minor` are integers because a ledger that stores money
-- as a float eventually loses a paisa. `UNIQUE(provider, trx_id)` is the
-- double-credit guard: forwarding the same bKash SMS twice cannot create two
-- rows, so it cannot credit an order twice either.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_transactions (
  id                  TEXT PRIMARY KEY NOT NULL,
  device_id           TEXT NOT NULL,
  message_id          TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  trx_id              TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('CRDT', 'DBIT')),
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'BDT',
  fee_minor           INTEGER NOT NULL DEFAULT 0,
  balance_after_minor INTEGER,
  counterparty        TEXT,
  status              TEXT NOT NULL DEFAULT 'UNCLAIMED' CHECK (status IN ('UNCLAIMED', 'CLAIMED', 'DISPUTED')),
  claimed_by_ref      TEXT,
  claimed_at          INTEGER,
  iso20022_json       TEXT NOT NULL,
  occurred_at         INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE(provider, trx_id)
);

CREATE INDEX IF NOT EXISTS idx_fin_trx_lookup
  ON financial_transactions(trx_id, status);

-- ---------------------------------------------------------------------------
-- 21. Interactive sessions
--
-- One row per outbound prompt awaiting a reply, correlated by (peer, state,
-- expires_at). A reply is matched by the sender number and the code table, so
-- no URL, no short link and no extra state on the handset is required.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interactive_sessions (
  id                  TEXT PRIMARY KEY NOT NULL,
  vertical            TEXT NOT NULL CHECK (vertical IN ('ecommerce', 'healthcare', 'education')),
  external_ref        TEXT NOT NULL,
  peer_e164           TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  sim_slot            INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL DEFAULT 'AWAITING_REPLY' CHECK (state IN ('AWAITING_REPLY', 'CONFIRMED', 'RESCHEDULE_REQUESTED', 'CANCELLED', 'EXPIRED')),
  expected_codes_json TEXT NOT NULL,
  metadata_json       TEXT NOT NULL,
  outbound_command_id TEXT,
  reply_message_id    TEXT,
  expires_at          INTEGER NOT NULL,
  resolved_at         INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interactive_peer_active
  ON interactive_sessions(peer_e164, state, expires_at);

-- ---------------------------------------------------------------------------
-- 22. Multi-SIM inventory and per-SIM pacing
--
-- `sent_current_hour` plus `hour_window_start` is a fixed-window token bucket.
-- It is stored per slot rather than derived from `messages` because the handset
-- needs the count before it sends, including while the Worker is unreachable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_sims (
  device_id         TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  sim_slot          INTEGER NOT NULL CHECK (sim_slot IN (1, 2)),
  subscription_id   INTEGER,
  carrier_name      TEXT,
  mcc_mnc           TEXT,
  msisdn_e164       TEXT,
  role_affinity     TEXT NOT NULL DEFAULT 'general' CHECK (role_affinity IN ('general', 'otp_high', 'bulk_edu', 'standby_failover')),
  max_per_hour      INTEGER NOT NULL DEFAULT 120,
  sent_current_hour INTEGER NOT NULL DEFAULT 0,
  hour_window_start INTEGER NOT NULL DEFAULT 0,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  radio_state       TEXT NOT NULL DEFAULT 'READY' CHECK (radio_state IN ('READY', 'DEGRADED', 'NO_SERVICE', 'LOCKED')),
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (device_id, sim_slot)
);

-- ---------------------------------------------------------------------------
-- Split-horizon execution bookkeeping
--
-- `execution_policy` is what the console and the handset read to decide where a
-- graph runs. The default keeps today's behaviour (handset first) so an existing
-- workflow keeps its meaning, and a rule compiled from the rules form can record
-- that it came from the form rather than the canvas.
-- ---------------------------------------------------------------------------
ALTER TABLE workflows ADD COLUMN execution_policy TEXT NOT NULL DEFAULT 'HYBRID_HANDSET_FIRST';
ALTER TABLE workflows ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'canvas';

-- What the handset did before the batch was uploaded: the nodes it ran, the
-- variables it extracted, and the node it stopped at when it needed the edge.
-- NULL means the handset ran no part of the graph (the v5.2.1 behaviour).
ALTER TABLE flow_runs ADD COLUMN checkpoint_json TEXT;
