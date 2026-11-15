-- Agent autonomy (pass 3, stage C).
--
-- `agent_autonomy` is a singleton: the window and the two daily caps a human
-- enabled. It is not a grant and does not authorise anything by itself; the
-- effect-shaped rows in `authority_grants` do. The row exists so the runtime can
-- say "off", "expired" or "cap reached" without reading the grant table.
--
-- `agent_usage` is per UTC day, and `tokens` is the AGENT's own loop counter.
-- It is deliberately separate from `ai_usage`, which is the console chat budget:
-- an autonomous loop must not be able to exhaust the operator's chat allowance.
--
-- Autonomy grants carry `agent_token_id = 'autonomy:agent'` in
-- `authority_grants`; that dedicated id keeps `(token, scope, target)` supersede
-- from colliding with a hand-approved grant for the same effect.

CREATE TABLE IF NOT EXISTS agent_autonomy (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0,
  sms_cap    INTEGER NOT NULL DEFAULT 10,
  write_cap  INTEGER NOT NULL DEFAULT 50,
  expires_at INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO agent_autonomy (id, enabled, sms_cap, write_cap, expires_at, updated_by, updated_at)
VALUES (1, 0, 10, 50, 0, '', 0)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_usage (
  day    TEXT PRIMARY KEY NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  sms    INTEGER NOT NULL DEFAULT 0
);

-- Autonomy grants need a real `agent_tokens` row because `authority_grants`
-- has a foreign key. This row is NOT a credential: `token_hash` is a fixed
-- non-secret and `resolveAgentToken` only accepts `dkf_agt_...` tokens, so no
-- request can authenticate as it. It exists so the dedicated grant namespace
-- (`autonomy:agent`) is a row a human can see and revoke with every other token.
INSERT INTO agent_tokens
  (id, name, token_hash, scopes_json, max_per_hour, sent_current_hour,
   hour_window_start, created_at, created_by)
VALUES
  ('autonomy:agent', 'agent autonomy (runtime)', 'autonomy-not-a-credential',
   '["sms:send:production","rules:write","flow_deploy_prod"]',
   0, 0, 0, 0, 'migration:0012')
ON CONFLICT(id) DO NOTHING;
