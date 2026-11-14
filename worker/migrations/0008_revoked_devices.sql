-- A revoked device keeps a tombstone in `devices`: the row stays visible to the
-- console (which renders `revoked_at`), but its public key is cleared, so it can
-- no longer authenticate. Re-pairing the same device_id revives the row with the
-- new key (pair.ts clears `revoked_at` in its upsert).
ALTER TABLE devices ADD COLUMN revoked_at INTEGER;
