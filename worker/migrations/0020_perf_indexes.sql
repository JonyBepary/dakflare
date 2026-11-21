-- Performance indexes found by EXPLAIN QUERY PLAN against production and
-- verified on a local SQLite built from every prior migration.
--
-- 1. Messages pagination. idx_messages_device satisfied the range but left the
--    `id DESC` tie-break to a temp B-tree, so each page sorted every row for
--    the device. This replaces it with a covering index for the exact ORDER BY.
-- 2. Scheduled list. The console's default view orders by send_at with no
--    status filter, which cannot use idx_scheduled_due(status, send_at).
-- 3. Contacts list. ORDER BY created_at DESC had no index at all; the filtered
--    view also needs channel first.
DROP INDEX IF EXISTS idx_messages_device;
CREATE INDEX IF NOT EXISTS idx_messages_page
  ON messages(device_id, received_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_send_at
  ON scheduled_messages(send_at);

CREATE INDEX IF NOT EXISTS idx_contacts_created
  ON contacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_channel_created
  ON contacts(channel, created_at DESC);
