-- DakFlare — agent attachments and the deployment-wide SMS ceiling.
--
-- `agent_attachments` is metadata only. The bytes live in R2 under
-- `agent/<actor-hash>/<id>/<name>`; the row exists so the runtime can enforce
-- the 3-per-operator cap, the 24-hour expiry and the operator boundary without
-- listing a bucket. `actor_hash` is the SHA-256 prefix of the actor label, so
-- one operator's attachment id can never resolve for another even if it leaks.
--
-- `daily_sms_cap` is the DEPLOYMENT-wide ceiling, beside the per-window
-- `sms_cap`. The window cap bounds one operator's hour; this one bounds the
-- deployment's day, so two short windows on the same day cannot double the
-- total. `authorizeAct` reads it before it looks at a grant.
ALTER TABLE agent_autonomy ADD COLUMN daily_sms_cap INTEGER NOT NULL DEFAULT 20;

CREATE TABLE IF NOT EXISTS agent_attachments (
  id         TEXT PRIMARY KEY NOT NULL,
  actor_hash TEXT NOT NULL,
  actor      TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_attachments_actor
  ON agent_attachments(actor_hash, created_at);
