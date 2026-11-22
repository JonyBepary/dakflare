-- DakFlare v6.3 — Generic Integration Surface v1.
--
-- Additive migration extending existing tables (0002 webhooks / integration_deliveries,
-- 0003 agent_tokens, 0015 webhooks inbound/outbound columns) without introducing
-- vertical-specific columns or a parallel token/queue system.
--
-- Apply locally:
--   npx wrangler d1 migrations apply sms_gateway --local

-- 1. Service-scoped integration tokens on top of `agent_tokens`.
--    `kind = 'service'` tokens may hold `sms:send:transactional` (unattended,
--    rate-limited, device/channel constrained); `kind = 'agent'` tokens keep
--    the strict human `sms:send:production` grant boundary.
ALTER TABLE agent_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'
  CHECK (kind IN ('agent', 'service'));
ALTER TABLE agent_tokens ADD COLUMN allowed_channels_json TEXT;
ALTER TABLE agent_tokens ADD COLUMN allowed_device_ids_json TEXT;
ALTER TABLE agent_tokens ADD COLUMN metadata_json TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_tokens_kind_live
  ON agent_tokens(kind, id) WHERE revoked_at IS NULL;

-- 2. Versioned signing key ID, content-class body policy, and generic metadata
--    on outbound webhooks.
ALTER TABLE webhooks ADD COLUMN signing_key_id TEXT NOT NULL DEFAULT 'k1';
ALTER TABLE webhooks ADD COLUMN body_policy TEXT NOT NULL DEFAULT 'redacted'
  CHECK (body_policy IN ('redacted', 'allowlisted_raw', 'full'));
ALTER TABLE webhooks ADD COLUMN body_allowlist_json TEXT;
ALTER TABLE webhooks ADD COLUMN metadata_json TEXT;

-- 3. End-to-end trace propagation and receiver ack summary on deliveries.
ALTER TABLE integration_deliveries ADD COLUMN trace_id TEXT;
ALTER TABLE integration_deliveries ADD COLUMN ack_json TEXT;

CREATE INDEX IF NOT EXISTS idx_integration_deliveries_webhook_state
  ON integration_deliveries(webhook_id, state, created_at DESC);
