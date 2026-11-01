-- DakFlare v6.1 P3 — provenance.
--
-- One column, and only because this one fact cannot be recomputed later.
--
-- A message's reply fate is mostly derivable at read time: `reply_command_id`
-- plus the command's state says replied / queued / failed, and a flow's
-- `flow_runs` row says automation ran. What cannot be recomputed is a
-- SUPPRESSION: a rule that matched and was held back by its cooldown or its
-- hourly cap. Re-evaluating an hour later would answer "would reply", which is
-- the opposite of what happened, so the decision is recorded when it is made.
--
--   reply_verdict   suppressed_cooldown | suppressed_hourly_cap | NULL
--   reply_verdict_detail_json
--                   which rule, and the numbers behind it, so the trace can say
--                   "rule X, cooldown 300 s, last reply 41 s ago" instead of a
--                   single word.
--
-- NULL means "no suppression recorded", which is the case for every reply, for
-- every message no automation matched, and for every row written before this
-- migration. The trace treats NULL as "nothing suppressed" rather than as
-- unknown, because a suppression is the only thing this column can hold.
--
--   npx cf d1 migrations apply 8d88069e-71cf-49a2-ba33-c150b02246b7
--
-- Take a backup first: docs/OPS_BACKUP.md.

ALTER TABLE messages ADD COLUMN reply_verdict TEXT
  CHECK (reply_verdict IS NULL OR reply_verdict IN ('suppressed_cooldown', 'suppressed_hourly_cap'));

ALTER TABLE messages ADD COLUMN reply_verdict_detail_json TEXT;
