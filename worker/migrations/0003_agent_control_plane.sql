-- DakFlare v6.1 P0 — the agent control plane.
--
-- Three tables, all additive: a v6.0 Worker that does not know them keeps
-- running against the same database, and every statement is CREATE ... IF NOT
-- EXISTS so applying this twice is a no-op.
--
--   agent_tokens       who an agent is, what it may attempt, and its own budget
--   approval_requests  what it asked for and nobody has answered yet
--   authority_grants   what a human actually handed over, and until when
--
-- The design note that matters: approval is a LEASE, not a flag. A grant has an
-- absolute deadline, an identified granter and a target, and it is checked on
-- every request rather than at grant time. That is what bounds the blast radius
-- of a prompt-injected agent without making a human click through every send.
--
-- Take a backup first: docs/OPS_BACKUP.md.
--   npx cf d1 migrations apply 8d88069e-71cf-49a2-ba33-c150b02246b7
-- (`cf` needs the database ID, not the name.)

-- ---------------------------------------------------------------------------
-- 23. Agent tokens
--
-- The token is `dkf_agt_<id>_<secret>`. `id` is the lookup key and is stored
-- plainly so a mint can be listed, revoked and named in an audit row without the
-- secret ever touching the database. `token_hash` is SHA-256 of the SECRET ONLY,
-- hex: the secret is 32 random bytes, so a plain digest is a preimage problem of
-- the same difficulty as the secret itself, and it lets the resolver compare a
-- fixed 32 bytes instead of a variable-length string.
--
-- Scopes live in `scopes_json` because SQLite has no array type and a join table
-- would buy nothing: a token has at most a dozen scopes and they are read as a
-- set with the token, never queried across tokens.
--
-- The quota is a fixed window on the token, not a token bucket, mirroring the
-- Durable Object's `write_budget`: one row, one conditional UPDATE, no drift and
-- no dependence on when the previous window happened to roll. `max_per_hour`
-- defaults to 20 because an agent that can send more than twenty SMS an hour
-- unattended is already the incident this table exists to prevent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_tokens (
  id                TEXT PRIMARY KEY NOT NULL,
  name              TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  scopes_json       TEXT NOT NULL,
  -- Optional: an agent bound to one handset. NULL means fleet-wide, which the
  -- grant layer then has to narrow per action.
  device_id         TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
  max_per_hour      INTEGER NOT NULL DEFAULT 20,
  sent_current_hour INTEGER NOT NULL DEFAULT 0,
  hour_window_start INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  created_by        TEXT NOT NULL,
  last_used_at      INTEGER,
  -- Token lifetime, independent of any grant. NULL = no expiry, which is the
  -- CLI's own choice when it mints one; a grant still has to be obtained before
  -- anything risky happens.
  expires_at        INTEGER,
  revoked_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_live
  ON agent_tokens(id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 24. Approval requests
--
-- One row per unanswered ask. `target_json` is the narrowing the request names,
-- and it is part of the uniqueness key: an agent re-asking for the same scope and
-- the same target gets the SAME request back instead of stacking a queue, which
-- is what stops a retry loop from becoming a notification flood for the operator.
--
-- `state` is the whole lifecycle. A row that is still PENDING past `expires_at`
-- is expired by definition; the column is written lazily so the console can show
-- it without a sweeper.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_requests (
  id              TEXT PRIMARY KEY NOT NULL,
  agent_token_id  TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  target_json     TEXT NOT NULL,
  reason          TEXT,
  state           TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  requested_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  decided_by      TEXT,
  decided_at      INTEGER,
  grant_id        TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_open
  ON approval_requests(state, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_one_open
  ON approval_requests(agent_token_id, scope, target_json)
  WHERE state = 'PENDING';

-- ---------------------------------------------------------------------------
-- 25. Authority grants
--
-- A time-boxed grant of one scope over one target, signed by a human. Every
-- column earns its place:
--
--   target_json        what it applies to. Never "everything" for a mutating
--                      scope: `sms:send:production` must name recipients or a
--                      device, which is enforced in lib/authority.ts and again
--                      by the grant creation route.
--   granted_by         an email or "admin-token". The audit needs a person.
--   expires_at         absolute, milliseconds. The check is `> now` on every
--                      request, so a late retry cannot use a closed window.
--   revoked_at         revoked is a timestamp, not a DELETE. The history of what
--                      was allowed, and for how long, is the point.
--   use_count          so "what did the 15-minute grant actually do" is a query
--                      rather than a reconstruction from the audit log.
--   approval_request_id  which ask produced it, so the console can show the pair.
--
-- The partial unique index enforces "at most one live grant per (token, scope,
-- target)". A second approval supersedes the first rather than stacking, so an
-- agent cannot accumulate authority by asking repeatedly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authority_grants (
  id                  TEXT PRIMARY KEY NOT NULL,
  agent_token_id      TEXT NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  scope               TEXT NOT NULL,
  target_json         TEXT NOT NULL,
  granted_by          TEXT NOT NULL,
  granted_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  use_count           INTEGER NOT NULL DEFAULT 0,
  last_used_at        INTEGER,
  approval_request_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_authority_grants_lookup
  ON authority_grants(agent_token_id, scope, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_authority_grants_one_live
  ON authority_grants(agent_token_id, scope, target_json)
  WHERE revoked_at IS NULL;
