-- 0018: multi-channel connectors, cross-channel identities, and the ingest dead-letter row.
--
-- One row per external account: a WhatsApp phone number, a Telegram bot, a Messenger page, an
-- Instagram account, or the paired handset. The bytes of the credential live in `secret_sealed`
-- (AES-256-GCM, same seal as `WEBHOOK_SECRET_KEY` uses) and are never returned after creation;
-- `secret_hash` exists so rotation can be compared without opening the seal.
--
-- Deliberately NOT added here: a unique index on `messages (channel, conversation_id, local_id)`.
-- `messages` already has `UNIQUE(device_id, local_id)`, and channel rows are written with
-- `device_id = channel:<channel>:<account_id>`, so the pair already makes a replayed Meta event a
-- no-op. A second unique index over existing rows would be redundant at best and would fail the
-- migration if production already held a duplicate triple. Dedupe belongs where it already is.

CREATE TABLE IF NOT EXISTS channel_connectors (
  id            TEXT PRIMARY KEY NOT NULL,
  channel       TEXT NOT NULL
    CHECK (channel IN ('sms', 'whatsapp', 'telegram', 'messenger', 'instagram')),
  account_id    TEXT NOT NULL,
  execution_tier TEXT NOT NULL
    CHECK (execution_tier IN ('worker_do', 'edge_device')),
  auth_mode     TEXT
    CHECK (auth_mode IN (
      'unified_login', 'instagram_login', 'facebook_login',
      'cloud_api', 'coexistence', 'bot_api', 'business_bot', 'gateway',
      'mtproto', 'linked_device', 'android_notif', 'sim_radio'
    )),
  label         TEXT NOT NULL,
  secret_sealed TEXT,
  secret_hash   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_event_at INTEGER,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (channel, account_id)
);

-- Webhook ingress resolves a connector by its account id on every POST, so this is the index that
-- keeps that lookup off a table scan.
CREATE INDEX IF NOT EXISTS idx_channel_connectors_lookup
  ON channel_connectors (channel, enabled, account_id);

-- One human, several media. `peer_id` is whatever that medium calls them: E.164, wa_id, chat_id,
-- PSID or IGSID. The primary key is the medium's own identity, so the same person arriving twice on
-- the same account is one row.
CREATE TABLE IF NOT EXISTS contact_identities (
  contact_id   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  peer_id      TEXT NOT NULL,
  display_name TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (channel, account_id, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_identities_by_contact
  ON contact_identities (contact_id, channel);

-- A batch that exhausted its retries. Kept in D1 rather than dropped: a lost inbound message is
-- indistinguishable from a customer who was ignored, and that is the one failure this product
-- cannot afford to make silently.
CREATE TABLE IF NOT EXISTS ingest_dead_letters (
  id        TEXT PRIMARY KEY NOT NULL,
  queue     TEXT NOT NULL,
  body_json TEXT NOT NULL,
  attempts  INTEGER NOT NULL,
  failed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_dead_letters_age ON ingest_dead_letters (failed_at);
