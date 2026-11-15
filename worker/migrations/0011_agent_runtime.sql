-- Agent runtime (pass 3, stage A): single-use WebSocket upgrade tickets.
--
-- A ticket is minted by a human session at `POST /v1/admin/agent/ticket`,
-- expires in 60 s, is bound to the session that minted it and to the one
-- pinned agent object name, and is deleted on redemption. Only the SHA-256 of
-- the token is stored: a stolen database row cannot be replayed.
--
-- `agent_runtime_ticket_uses` is a short-lived tombstone, not a second ticket
-- table. It exists so a replay is refused as `already_used` instead of being
-- indistinguishable from a token that was never minted; mint prunes rows older
-- than ten minutes.

CREATE TABLE IF NOT EXISTS agent_runtime_tickets (
  token_hash  TEXT PRIMARY KEY NOT NULL,
  session_id  TEXT NOT NULL,
  object_name TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_tickets_expiry
  ON agent_runtime_tickets(expires_at);

CREATE TABLE IF NOT EXISTS agent_runtime_ticket_uses (
  token_hash TEXT PRIMARY KEY NOT NULL,
  used_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_ticket_uses_used
  ON agent_runtime_ticket_uses(used_at);
