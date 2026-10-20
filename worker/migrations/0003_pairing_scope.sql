-- SMS Gateway v5 — pairing code scope and in-flight claim lease (security fix 1).
--
-- Three columns, three distinct jobs:
--
--   device_id   Binds a code to exactly one target device. NULL keeps the original
--               behaviour: the code may be redeemed by any device that does not
--               already exist. Without this, anyone holding ANY valid enrollment
--               code could redeem it against an ALREADY-PAIRED device_id and
--               overwrite that device's public key, taking it over.
--
--   purpose     'enroll' (default) may only register a device that does not exist
--               yet. 'rotate' is an explicit, admin-authorized key replacement for
--               an existing device and is the only purpose allowed to evict the
--               previous key holder. Keeping the distinction in the data, rather
--               than inferring it from whether the device happens to exist, is what
--               stops a race from turning an enrollment into a takeover.
--
--   claimed_at  The in-flight lease. A redemption atomically sets this to its own
--               `now` before calling the Durable Object, so a concurrent loser
--               claims zero rows and never reaches the DO — that is what removes
--               the phantom identity the old validate -> DO -> consume order could
--               create. A claim older than the lease window is treated as abandoned
--               and may be reclaimed, so a crashed isolate cannot wedge a code.
--
-- The code itself is still single-use: the row is deleted when the pairing
-- finishes, and a failed Durable Object call releases the lease (claimed_at back
-- to NULL) instead of burning the code.

ALTER TABLE pairing_codes ADD COLUMN device_id TEXT;
ALTER TABLE pairing_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'enroll';
ALTER TABLE pairing_codes ADD COLUMN claimed_at INTEGER;
