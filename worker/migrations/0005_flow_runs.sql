-- M4 — device-reported flow runs.
--
-- The device is the primary flow engine: it runs a flow when the SMS arrives and
-- reports the run together with the message. The Worker's WASM interpreter is the
-- FALLBACK, so it must not run a flow the device already ran.
--
-- The dedupe key is the same tuple that makes the message upload idempotent, plus
-- the flow identity:
--
--   (device_id, local_id, flow_id, flow_version)
--
-- `flow_version` is deliberate. A graph edited after the message arrived is a
-- different flow, and a run of v1 must not suppress a legitimately different v2.
--
-- Rows are written only when a device reports them (a batch carrying `flow_runs`),
-- and are deleted with the message log by the admin purge endpoint, so they never
-- outlive the messages they describe.

CREATE TABLE IF NOT EXISTS flow_runs (
  device_id    TEXT NOT NULL,
  local_id     TEXT NOT NULL,
  flow_id      TEXT NOT NULL,
  flow_version INTEGER NOT NULL,
  outcome      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (device_id, local_id, flow_id, flow_version)
);

CREATE INDEX IF NOT EXISTS idx_flow_runs_device ON flow_runs(device_id, created_at);
