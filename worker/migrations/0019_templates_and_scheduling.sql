-- 0019: message templates, an audience list, pacing policies and scheduled sends.
--
-- Kept in D1 because these are operator records, not per-account hot state.
-- The send itself is paced by the target Durable Object so a SIM is never
-- handed a burst and a cloud API is never called faster than its own limit.
--
-- `contacts` here is an audience list: who may be messaged and what variables
-- they carry. It is deliberately separate from `contact_identities`, which is
-- the conversation layer's identity graph (one human across several media).
-- An audience row is a recipient the operator chose; an identity row is a peer
-- that arrived on a channel. Do not merge them.

CREATE TABLE IF NOT EXISTS message_templates (
  id               TEXT PRIMARY KEY NOT NULL,
  name             TEXT NOT NULL UNIQUE,
  channel          TEXT NOT NULL DEFAULT 'any',
  body             TEXT NOT NULL,
  variables_json   TEXT NOT NULL DEFAULT '[]',
  wa_template_name TEXT,
  wa_language      TEXT DEFAULT 'en_US',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id         TEXT PRIMARY KEY NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'sms',
  peer       TEXT NOT NULL,
  name       TEXT,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  tags_json  TEXT NOT NULL DEFAULT '[]',
  timezone   TEXT NOT NULL DEFAULT 'UTC',
  opt_out    INTEGER NOT NULL DEFAULT 0 CHECK (opt_out IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel, peer)
);

CREATE INDEX IF NOT EXISTS idx_contacts_channel_optout ON contacts(channel, opt_out);

CREATE TABLE IF NOT EXISTS pacing_policies (
  id              TEXT PRIMARY KEY NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('device', 'connector')),
  target_id       TEXT NOT NULL UNIQUE,
  min_interval_ms INTEGER NOT NULL DEFAULT 10000,
  jitter_pct      INTEGER NOT NULL DEFAULT 25,
  max_per_hour    INTEGER NOT NULL DEFAULT 40,
  quiet_start_hour INTEGER NOT NULL DEFAULT 21,
  quiet_end_hour   INTEGER NOT NULL DEFAULT 8,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  updated_at      INTEGER NOT NULL
);

-- One row per message that will be, is being, or has been dispatched.
--
-- `id` is a UUID. For SMS it is also the command id sent to the handset: the
-- device only accepts UUID command ids, and using the same value on both sides
-- makes the dispatch idempotent. `pacing_key` is the bucket the scheduler
-- spends a token from: `sms:<device>` or `sms:<device>:<sim_slot>` for a SIM,
-- `<channel>:<account_id>` for a connector.
--
-- `timezone` is an IANA snapshot taken when the row is created. Quiet hours are
-- evaluated against that zone even if the contact later changes theirs; a bad
-- zone is rejected at insert (the route answers `bad_timezone`).
--
-- `status` moves forward: scheduled -> dispatching -> dispatched -> sent ->
-- delivered. The terminal outcomes (cancelled, skipped_*, failed, unknown) are
-- written once. A late `sent` receipt must never overwrite `delivered`.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id               TEXT PRIMARY KEY NOT NULL,
  campaign_id      TEXT,
  channel          TEXT NOT NULL,
  target_type      TEXT NOT NULL CHECK (target_type IN ('device', 'connector')),
  target_id        TEXT NOT NULL,
  pacing_key       TEXT NOT NULL,
  to_peer          TEXT NOT NULL,
  body             TEXT NOT NULL,
  template_id      TEXT,
  vars_json        TEXT NOT NULL DEFAULT '{}',
  policy_json      TEXT NOT NULL DEFAULT '{}',
  timezone         TEXT NOT NULL,
  sim_slot         INTEGER,
  send_at          INTEGER NOT NULL,
  expires_at       INTEGER,
  status           TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN (
      'scheduled', 'dispatching', 'dispatched', 'sent', 'delivered',
      'cancelled', 'skipped_opt_out', 'skipped_window', 'failed', 'unknown'
    )),
  attempts         INTEGER NOT NULL DEFAULT 0,
  shift_count      INTEGER NOT NULL DEFAULT 0,
  last_shift_reason TEXT,
  claim_token      TEXT,
  claimed_at       INTEGER,
  dispatched_at    INTEGER,
  sent_at          INTEGER,
  delivered_at     INTEGER,
  dispatch_ref     TEXT,
  idempotency_key  TEXT,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- The alarm's question: "what is due now?"
CREATE INDEX IF NOT EXISTS idx_scheduled_due
  ON scheduled_messages(status, send_at);

-- The per-bucket pacing question: "what has this target dispatched this hour?"
CREATE INDEX IF NOT EXISTS idx_scheduled_target_bucket
  ON scheduled_messages(pacing_key, status, dispatched_at);

-- Receipts resolve an external id back to the row that produced it.
CREATE INDEX IF NOT EXISTS idx_scheduled_dispatch_ref
  ON scheduled_messages(channel, dispatch_ref);

-- An operator-supplied idempotency key creates at most one row. The partial
-- form keeps every NULL from colliding, which a plain UNIQUE would not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_idempotency
  ON scheduled_messages(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The webhook badge: "when did this connector last answer, and why did the last
-- one fail?" Both are written best-effort on the hot ingress path, so a missing
-- value means no event yet, not an error.
ALTER TABLE channel_connectors ADD COLUMN last_webhook_at INTEGER;
ALTER TABLE channel_connectors ADD COLUMN last_error TEXT;
