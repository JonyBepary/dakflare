-- DakFlare — inbound webhook channel for the agent.
--
-- `webhooks` already exists (migration 0002) as the OUTBOUND endpoint registry
-- used by flow dispatch. This migration is additive: it adds a `kind`
-- discriminator plus the inbound-only columns, so one table keeps one notion of
-- "a registered webhook" without making the outbound dispatcher treat an
-- inbound row as a URL to POST to. Every pre-existing row becomes `outbound`.
--
-- An external service wakes the agent by POSTing a signed body to
-- `/v1/webhooks/:id`; the answer is stored on the delivery row and returned to
-- the caller. Nothing here is a credential for the agent: the signing secret
-- authorises an INGRESS delivery, and the turn it starts runs as the synthetic
-- actor `webhook:<id>`, which `authorizeAct` refuses for every act.
--
-- `secret_hash` is SHA-256(secret), as the storage contract asks. It CANNOT be
-- used to verify an HMAC: a one-way digest has no key material to compute the
-- expected tag with. `secret_sealed` therefore holds the same secret encrypted
-- with AES-256-GCM under a Worker-held key (`WEBHOOK_SECRET_KEY`, falling back
-- to ADMIN_TOKEN then BETTER_AUTH_SECRET — see routes/webhooks.ts). The hash
-- stays as the integrity check / one-way identifier; the sealed copy is what
-- makes HMAC verification possible without writing the secret to D1 in clear.
-- Better still is a dedicated key-management secret so a webhook leak and an
-- auth-secret leak are not the same incident; `WEBHOOK_SECRET_KEY` exists for
-- exactly that and the fallbacks keep a single-secret deployment working.

-- `inbound` rows use vertical='generic', target_url='', events_json='[]' and
-- secret_ring='' only to satisfy the 0002 NOT NULL columns; the inbound code
-- never reads any of them.
ALTER TABLE webhooks ADD COLUMN kind TEXT NOT NULL DEFAULT 'outbound';
ALTER TABLE webhooks ADD COLUMN secret_hash TEXT;
ALTER TABLE webhooks ADD COLUMN secret_sealed TEXT;
ALTER TABLE webhooks ADD COLUMN created_by TEXT;
ALTER TABLE webhooks ADD COLUMN last_delivery_at INTEGER;

CREATE INDEX idx_webhooks_kind ON webhooks(kind, enabled);

-- `id` is the caller's `x-dakflare-delivery`, and the primary key IS the
-- idempotency claim: the first insert wins, every later delivery reads the row
-- and replays the stored answer without running a second turn.
CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY NOT NULL,
  webhook_id    TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  received_at   INTEGER NOT NULL,
  body_json     TEXT,
  status        TEXT NOT NULL, -- running | succeeded | failed
  answer_text   TEXT,
  error         TEXT
);

CREATE INDEX idx_webhook_deliveries_webhook
  ON webhook_deliveries(webhook_id, received_at DESC);
