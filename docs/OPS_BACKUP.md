# Backup and restore

Two different jobs, two different mechanisms. Neither one restores a Durable Object.

## 1. Time Travel — for mistakes, hours to a month

D1 keeps 30 days of point-in-time history. This is the first thing to reach for when a
migration, a purge or a bad deploy removed rows.

```bash
cd worker

# what is available
npx wrangler d1 time-travel info sms_gateway --remote

# a bookmark or a timestamp, e.g. 2026-10-30T08:00:00Z
npx wrangler d1 time-travel restore sms_gateway --remote --timestamp=2026-10-30T08:00:00Z
```

Restoring is in place: the database is rolled back, and the operation is itself
reversible for 30 days. Take a bookmark *before* a risky migration:

```bash
npx wrangler d1 time-travel info sms_gateway --remote   # copy the current bookmark
```

## 2. SQL export — for copies that leave the account

Time Travel does not protect against losing the account, and it is not an archive.

```bash
npx wrangler d1 export sms_gateway --remote --output=backup-$(date +%F).sql
```

The file contains every table and every row: messages, devices, rules, workflows, accounts,
passkeys, invites, the audit log. **It contains personal data and password verifiers** —
store it encrypted, and do not commit it. `*.sql` backups are gitignored by convention; keep
them outside the repo.

Schedule: before any migration, before a release deploy, and weekly otherwise. A cron on
whatever machine you trust is enough; there is no server-side export schedule.

## 3. The rehearsal (do this once a quarter)

An untested backup is a guess. The rehearsal is cheap:

```bash
npx wrangler d1 create dakflare_restore_test
npx wrangler d1 execute dakflare_restore_test --remote --file=backup-YYYY-MM-DD.sql
npx wrangler d1 execute dakflare_restore_test --remote --command \
  "SELECT (SELECT count(*) FROM devices) devices,
          (SELECT count(*) FROM messages) messages,
          (SELECT count(*) FROM \"user\") users,
          (SELECT count(*) FROM passkey) passkeys,
          (SELECT count(*) FROM audit_log) audit;"
```

Compare against the same query on `sms_gateway`, then delete the scratch database:

```bash
npx wrangler d1 delete dakflare_restore_test
```

Last rehearsed 2026-10-30: 18 tables, and identical counts on devices, messages, users,
passkeys and audit (2 / 150 / 1 / 1 / 10).

## 4. What a restore does not bring back

- **Durable Objects.** The command queue, replay-guard nonces, alarms and — once the
  auth guard exists — the lockout counters live in per-object SQLite storage, not in D1.
  A D1 restore leaves them as they are; a device whose queue was lost simply has nothing
  pending, and the phone re-syncs flows on its next poll.
- **KV.** The FCM token cache. It repopulates from the phone.
- **The phone's own database.** `simulator.db` holds the local thread and the wrapped
  identity key. Losing it means re-pairing, not data loss on the deployment.
- **Secrets.** `ADMIN_TOKEN`, `BETTER_AUTH_SECRET`, `AUTH_PEPPER`, `RESEND_API_KEY` are
  Worker secrets, not rows. A restored database with a rotated pepper means every stored
  password fails to verify until the matching pepper is restored — keep the pepper ring
  backed up wherever you keep secrets.

## 5. After a restore

1. `dakflare doctor` — schema, migrations, bindings, phone contact.
2. Sign in with the passkey; if the account table rolled back past its creation, the passkey
   is gone too and `dakflare auth reset` is the way back in.
3. Check one device's `last_seen` and send a test message; a restored D1 does not replay the
   queue.
