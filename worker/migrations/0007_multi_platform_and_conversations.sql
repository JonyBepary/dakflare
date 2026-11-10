-- DakFlare v7.0 — Multi-Platform Messaging, Conversations, and Versioned Automations
--
-- Adds multi-channel primitives (SMS, WhatsApp, Telegram, Signal, Plugins),
-- conversation session windows (e.g. WhatsApp 24-hour service window),
-- immutable workflow versioning, audience list filtering, and plugin registry tables.
--
-- D1 migration:
--   npx cf d1 migrations apply sms_gateway

-- 1. Multi-platform message attributes
ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, received_at);

-- 2. Conversation session and policy window tracking
CREATE TABLE IF NOT EXISTS conversations (
  id                 TEXT PRIMARY KEY NOT NULL,
  channel            TEXT NOT NULL DEFAULT 'sms',
  account_id         TEXT NOT NULL DEFAULT 'default',
  peer_id            TEXT NOT NULL,
  session_state      TEXT NOT NULL DEFAULT 'NO_SESSION'
    CHECK (session_state IN ('NO_SESSION', 'WINDOW_OPEN', 'TEMPLATE_ONLY', 'OPTED_OUT')),
  window_expires_at  INTEGER,
  last_inbound_at    INTEGER,
  last_outbound_at   INTEGER,
  metadata_json      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(channel, account_id, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_lookup ON conversations(channel, account_id, peer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_window ON conversations(session_state, window_expires_at);

-- 3. Unified workflow attributes (parity with rules)
ALTER TABLE workflows ADD COLUMN channel TEXT NOT NULL DEFAULT 'all';
ALTER TABLE workflows ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE workflows ADD COLUMN cooldown_s INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflows ADD COLUMN max_per_hour INTEGER NOT NULL DEFAULT 0;

-- 4. Immutable workflow versions for diffing and one-click rollback
CREATE TABLE IF NOT EXISTS workflow_versions (
  id           TEXT PRIMARY KEY NOT NULL,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  graph_json   TEXT NOT NULL,
  author       TEXT NOT NULL DEFAULT 'operator',
  commit_note  TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_lookup ON workflow_versions(workflow_id, version DESC);

-- 5. Audience and Contact Lists for targeted routing
CREATE TABLE IF NOT EXISTS audience_lists (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audience_members (
  list_id    TEXT NOT NULL REFERENCES audience_lists(id) ON DELETE CASCADE,
  peer_norm  TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'sms',
  label      TEXT,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (list_id, peer_norm, channel)
);

CREATE INDEX IF NOT EXISTS idx_audience_members_peer ON audience_members(peer_norm, channel);

-- 6. Plugin registry and capability manifests
CREATE TABLE IF NOT EXISTS plugin_repos (
  id                 TEXT PRIMARY KEY NOT NULL,
  url                TEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  public_key_ed25519 TEXT NOT NULL,
  last_synced_at     INTEGER,
  etag               TEXT
);

CREATE TABLE IF NOT EXISTS installed_plugins (
  id               TEXT PRIMARY KEY NOT NULL,
  repo_id          TEXT REFERENCES plugin_repos(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  version          TEXT NOT NULL,
  kind             TEXT NOT NULL,
  runtime          TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PAUSED_PERMISSIONS', 'DISABLED')),
  installed_at     INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_installed_plugins_kind ON installed_plugins(kind, status);
