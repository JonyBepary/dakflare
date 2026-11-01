-- DakFlare v6.1 P5 — extraction drift.
--
-- One table, because a miss is an EVENT and the alert is a summary of them.
--
-- An `extract` node whose pattern stops matching is the quietest failure in the
-- system: the message was accepted, the flow ran, and it stopped at a step that
-- said nothing. Nothing errors, nothing retries, and the operator finds out when
-- somebody complains that their order was never confirmed.
--
-- So every miss is recorded with the field it was looking for, and two misses in
-- an hour raise one `extraction_drift` alert per device (the alerts table already
-- has a partial unique index on (device_id, kind) for open rows, so a bad template
-- shouts once rather than once per message).
--
--   extract_misses(id, device_id, flow_id, flow_version, node_id, field,
--                  message_local_id, at)
--
-- `field` is the capture group the node declares. It is what an operator needs to
-- see: "the amount group stopped matching" is actionable, "the flow halted" is not.
--
-- Retention: this is diagnostic history, pruned with the rest of the log by the
-- daily cron using the same MESSAGE_RETENTION_DAYS window.
--
--   npx cf d1 migrations apply 8d88069e-71cf-49a2-ba33-c150b02246b7
--
-- Take a backup first: docs/OPS_BACKUP.md.

CREATE TABLE IF NOT EXISTS extract_misses (
  id               TEXT PRIMARY KEY NOT NULL,
  device_id        TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  flow_id          TEXT NOT NULL,
  flow_version     INTEGER NOT NULL,
  node_id          TEXT NOT NULL,
  field            TEXT,
  message_local_id TEXT,
  body_preview     TEXT,
  at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extract_misses_window
  ON extract_misses(device_id, flow_id, at);
