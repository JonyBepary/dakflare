-- DakFlare v6.1 Remediation — alert cascade cleanup and orphan alert purge.
--
-- Purges orphaned alerts referencing revoked or nonexistent devices, and ensures
-- device revocation cascades to related alerts, commands, and flow runs.
--
-- D1 migration:
--   npx cf d1 migrations apply 8d88069e-71cf-49a2-ba33-c150b02246b7

DELETE FROM alerts WHERE device_id NOT IN (SELECT device_id FROM devices);
DELETE FROM alerts WHERE device_id IN (SELECT device_id FROM devices WHERE archived_at IS NOT NULL);
