-- SMS Gateway v5 — operator-console truthfulness (PROTOCOL_CONTRACT_V5 §11.11–§11.12).
--
-- Four additive groups, no existing column or row is rewritten:
--
--   devices.label / devices.sim_slot   Operator-facing identity captured at pairing
--                                      (app) or minting (console). Nullable because
--                                      older clients do not report them, and "unknown"
--                                      must stay distinguishable from a default.
--
--   messages.reply_source / reply_ref / reply_command_id
--                                      Answer the question "what replied to this?".
--                                      reply_source is 'rule' today; reply_ref is the
--                                      rule id and reply_command_id is the queued
--                                      command, which is also the outbound row's id.
--
--   alerts                             A fact about a device, not a deployment metric.
--                                      The partial unique index keeps AT MOST ONE open
--                                      alert per (device, kind), so reconnects cannot
--                                      stack duplicates; acknowledging frees the slot
--                                      while the history stays queryable.
--
--   rule_hits                          Every successful rule reply, for the cooldown
--                                      and hourly-cap windows. Append-only; the
--                                      retention cron does not need it yet because one
--                                      row is written per automated reply and the
--                                      lookup is bounded by a time window.

ALTER TABLE devices ADD COLUMN label TEXT;
ALTER TABLE devices ADD COLUMN sim_slot INTEGER;

ALTER TABLE messages ADD COLUMN reply_source TEXT;
ALTER TABLE messages ADD COLUMN reply_ref TEXT;
ALTER TABLE messages ADD COLUMN reply_command_id TEXT;

CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY NOT NULL,
  device_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  raised_at       INTEGER NOT NULL,
  acknowledged_at INTEGER,
  detail          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open
  ON alerts(device_id, kind) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_raised ON alerts(raised_at DESC);

CREATE TABLE IF NOT EXISTS rule_hits (
  rule_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  replied_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_hits_rule ON rule_hits(rule_id, device_id, replied_at);
-- The pipeline loads a device's hits once per batch, so a device-first order is the
-- access pattern that actually runs.
CREATE INDEX IF NOT EXISTS idx_rule_hits_device ON rule_hits(device_id, replied_at);
