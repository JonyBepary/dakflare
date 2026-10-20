-- SMS Gateway v5 — D1 schema.
-- Implements PROTOCOL_CONTRACT_V5 Rev C §1.3 (idempotency keys), §6 (command
-- metadata mirrored for admin reads), §7.3 (`rules.id TEXT PRIMARY KEY NOT NULL`).
--
-- S01: `rules.id` is declared NOT NULL because SQLite treats each NULL in a
-- non-INTEGER PRIMARY KEY as distinct, so an id-less insert used to create
-- untargetable duplicate rules that were then served to devices.
-- S02: `rules.device_id` is nullable: NULL = global rule, otherwise per-device.

CREATE TABLE IF NOT EXISTS pairing_codes (
  code       TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at);

CREATE TABLE IF NOT EXISTS devices (
  device_id  TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  fcm_token  TEXT,
  paired_at  INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY NOT NULL,
  device_id   TEXT NOT NULL,
  local_id    TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  peer        TEXT NOT NULL,
  body        TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  auto_reply  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(device_id, direction, received_at DESC);

CREATE TABLE IF NOT EXISTS rules (
  id              TEXT PRIMARY KEY NOT NULL,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 0,
  matcher_type    TEXT NOT NULL,
  matcher_value   TEXT NOT NULL,
  body_type       TEXT NOT NULL,
  body_value      TEXT NOT NULL,
  reply_template  TEXT NOT NULL,
  cooldown_s      INTEGER NOT NULL DEFAULT 60,
  max_per_hour    INTEGER NOT NULL DEFAULT 10,
  sim_slot        INTEGER NOT NULL DEFAULT 0,
  allow_shortcode INTEGER NOT NULL DEFAULT 0,
  device_id       TEXT,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled, priority DESC);
CREATE INDEX IF NOT EXISTS idx_rules_device ON rules(device_id, enabled, priority DESC);
