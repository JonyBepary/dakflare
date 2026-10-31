---
name: dakflare-provision
description: Install, configure or repair a DakFlare deployment: a Worker on Cloudflare, a D1 database, and one paired Android handset. Use when setting up DakFlare for the first time, when `dakflare doctor` reports a failure, when a secret or binding is missing, or when a device needs pairing or revoking. Triggers: install dakflare, set up the gateway, doctor fails, missing secret, pair a phone, revoke a device, deploy the worker.
---

# DakFlare: provisioning and repair

A deployment is three things: a Worker on the operator's own Cloudflare account, a D1
database it owns, and one Android handset that holds the SIM. The CLI never talks to
Cloudflare — it talks to the Worker — so provisioning is `cf`/`wrangler` plus this CLI.

## Read this first

```bash
dakflare capabilities --agent
dakflare doctor --agent        # always run this before changing anything
```

`doctor` is the map. It reports config, health, schema, migrations, bindings and the
phone, and each failing check names the command that fixes it in the envelope's
`error.remediation`.

## The sequence

```bash
# 1. the edge
cd worker && npm install
cp wrangler.template.toml wrangler.toml
cp cloudflare.config.template.ts cloudflare.config.ts
npx wrangler d1 create sms_gateway
npx wrangler kv namespace create KV
npx wrangler d1 migrations apply sms_gateway --remote

# 2. the three secrets
npx wrangler secret put ADMIN_TOKEN --name dakflare-worker
npx wrangler secret put BETTER_AUTH_SECRET --name dakflare-worker
npx wrangler secret put AUTH_PEPPER --name dakflare-worker

# 3. deploy, then point the CLI at it
npm run deploy
dakflare init --url https://<worker>.workers.dev --token-file ~/.token
dakflare auth bootstrap --email you@example.com
dakflare pair --qr
```

## Two facts that cost time if you learn them the hard way

- **The ids are pasted, not guessed.** `d1 create` and `kv namespace create` print a
  `database_id` and an `id`; both go into `wrangler.toml` before step 2. The deploy
  fails without them, and the error does not say so.
- **`AUTH_MODE` decides which credential works.** `legacy` accepts `ADMIN_TOKEN` as a
  bearer; `new` requires a Better Auth session and treats `ADMIN_TOKEN` as a
  machine-only credential sent with `X-Dakflare-Client: cli`. `doctor` reports which
  mode the deployment is in.

## Repair order

1. `dakflare doctor --agent` — read `error.remediation` first.
2. `dakflare devices --agent` — is the phone still paired and recently seen?
3. `dakflare revoke <id> --yes` then `dakflare pair` — if the handset's identity is gone
   (reinstall, factory reset). Revoking is irreversible; the phone must pair again.

## The one mistake to avoid

Reinstalling the app to fix a pairing problem. The identity lives in the app's data
directory, so an uninstall also drops the battery whitelist and the pairing. Diagnose
with `doctor` and `devices` first.
