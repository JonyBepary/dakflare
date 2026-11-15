-- DakFlare — AI console assistant (pass 1).
--
-- Three additive tables. A Worker that predates them keeps running, and every
-- statement is CREATE ... IF NOT EXISTS so applying this twice is a no-op.
--
--   ai_settings           one row: which provider/model the console talks to
--   assistant_proposals   drafts a model produced, that a human may accept
--   ai_usage              daily prompt+completion tokens, the spend ceiling
--
-- The design note that matters: the API KEY IS NOT HERE. `AI_CHAT_API_KEY` is a
-- Worker secret, read per request, and its only D1 footprint is the boolean the
-- settings route computes from its presence. A backup of this database must not
-- be able to charge the operator's model account.
--
--   npx cf d1 migrations apply 8d88069e-71cf-49a2-ba33-c150b02246b7
-- (`cf` needs the database ID, not the name.)

-- ---------------------------------------------------------------------------
-- ai_settings — a singleton.
--
-- The `CHECK (id = 1)` is the whole reason this is not a settings KV pair: one
-- row, one UPDATE, and a second row is a schema violation rather than a race
-- between two consoles. `provider` is one of `workers-ai` | `openai-compatible`;
-- the registry refuses anything else at read time too, so a hand-edited row
-- cannot reach an adapter that did not validate it.
--
-- `base_url` is NULL for workers-ai. For an OpenAI-compatible provider it is the
-- https origin (or a localhost http origin) the adapter POSTs to.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_settings (
  id         INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  base_url   TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- assistant_proposals — a draft, not a change.
--
-- The id is minted by the server (`ap_<random>`), never accepted from a client
-- or a model: a caller that could name an id could name someone else's pending
-- proposal. `payload_json` is the validated payload the accept route re-checks
-- before it writes anything.
--
-- Expiry is 15 minutes and consumption is a timestamp, not a DELETE: the row is
-- evidence of what was offered, and a consumed proposal cannot be replayed.
-- `consumed_at IS NULL AND expires_at > now` is the only condition under which
-- accept will read one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assistant_proposals (
  id           TEXT PRIMARY KEY NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);

-- The accept lookup and a future sweeper both start at `expires_at`.
CREATE INDEX IF NOT EXISTS idx_assistant_proposals_expiry
  ON assistant_proposals(expires_at);

-- ---------------------------------------------------------------------------
-- ai_usage — one row per UTC day.
--
-- A token budget is a spend ceiling, so it is counted by actual usage where the
-- provider reports it and by a conservative estimate where it does not. The day
-- key is a text `YYYY-MM-DD`, computed in UTC, so the budget rolls at midnight
-- UTC rather than at a local hour that moves twice a year.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage (
  day    TEXT PRIMARY KEY NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0
);
