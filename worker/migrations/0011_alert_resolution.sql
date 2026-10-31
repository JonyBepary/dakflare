-- An offline alert now clears itself when the device reports again.
--
-- `acknowledged_at` is a human saying "I saw this"; `resolved_at` is the
-- condition going away. They are different facts, and until now only the first
-- existed, so a device that came back online kept an open `device_offline` alert
-- for ever — the console showed it as offline while it was demonstrably not.
--
-- The partial unique index moves with it: one *unresolved* alert per
-- (device, kind), so a reconnect that goes silent again raises a new alert rather
-- than being deduped into the old, already-resolved one.
ALTER TABLE alerts ADD COLUMN resolved_at INTEGER;

DROP INDEX IF EXISTS idx_alerts_open;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open
  ON alerts(device_id, kind) WHERE acknowledged_at IS NULL AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_alerts_unresolved
  ON alerts(device_id, kind) WHERE resolved_at IS NULL;
