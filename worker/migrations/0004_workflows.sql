-- SMS Gateway v5 — persisted workflow graphs.
--
-- The `rules` table is a flat matcher -> reply, which cannot represent the
-- multi-step processing pipeline the dashboard's canvas edits. This table stores
-- that pipeline as a single validated JSON document:
--
--   graph       The `{ nodes, edges }` document, exactly as `lib/workflow.ts`
--               normalises it. Nodes and edges live as JSON here; there is no
--               normalised node/edge table, because a graph is always read and
--               written whole (the canvas saves the whole document) and D1 has no
--               need to query inside it.
--
--   device_id   NULL means the workflow applies fleet-wide, otherwise it is
--               scoped to exactly one device. Same convention as `rules.device_id`.
--
--   version     Starts at 1 and increments on every successful save, so an editor
--               can detect that it is about to overwrite someone else's change.
--
--   enabled     0/1, stored as SQLite INTEGER like `rules.enabled`.
--
-- No execution engine reads this table yet: this migration adds the store and its
-- validation contract only. `idx_workflows_device` matches the only access pattern
-- the future dispatcher needs (the enabled workflows for a device or the fleet).

CREATE TABLE IF NOT EXISTS workflows (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  device_id  TEXT,
  graph      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflows_device ON workflows(device_id, enabled);
