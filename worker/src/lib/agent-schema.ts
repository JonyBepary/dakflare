/**
 * Assistant schema version and migration steps.
 *
 * Kept out of `agent/runtime.ts` so the main Worker can read the version for
 * admin/attachment routes without importing the `agents` SDK. The Durable
 * Object is the only consumer of the migration SQL.
 */

/** The code's schema version. Bump it and append a step to `MIGRATIONS`. */
/** How long a socket session lives before it must reconnect. */
export const AGENT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Forward-only steps. Index 0 is version 1. A step must be idempotent enough to
 * survive a retry after a deploy that died between the DDL and the version
 * update: `CREATE TABLE IF NOT EXISTS` is the pattern to keep.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     version    INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Version 2 — the turn journal and the conversation.
  // `agent_messages` is kept (the brief asks for it unreferenced) so a
  // rollback does not lose a running object's transcript. The runtime now
  // reads and writes `cf_agents_session_*` through the Sessions capability;
  // migration 0014_agent_drop_messages.sql (next pass) drops this table.
  `CREATE TABLE IF NOT EXISTS agent_turns (
     session    TEXT NOT NULL,
     turn       INTEGER NOT NULL,
     state      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (session, turn)
   )`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
     call_id     TEXT PRIMARY KEY NOT NULL,
     session     TEXT NOT NULL,
     turn        INTEGER NOT NULL,
     tool        TEXT NOT NULL,
     args_hash   TEXT NOT NULL,
     state       TEXT NOT NULL,
     result_json TEXT,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session)`,
  `CREATE TABLE IF NOT EXISTS agent_messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     session    TEXT NOT NULL,
     role       TEXT NOT NULL,
     content    TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session, id)`,
  // Version 7 — one in-flight claim per turn key. The row is the mutual
  // exclusion: a second request with the same key cannot enter the model path
  // while the first is running. `expires_at` is the backstop for a turn whose
  // process died without releasing it.
  `CREATE TABLE IF NOT EXISTS agent_turn_claims (
     turn         TEXT PRIMARY KEY NOT NULL,
     message_hash TEXT NOT NULL,
     claimed_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL
   )`,
];

/**
 * One version per migration step.
 *
 * It used to be a hand-written 2 while the list held six steps, so a fresh
 * object applied `agent_turns` and stopped; the journal then failed with
 * "no such table: tool_calls" the first time an act ran. Deriving it makes that
 * drift impossible: add a step, the version moves with it.
 */
export const AGENT_SCHEMA_VERSION = MIGRATIONS.length;

