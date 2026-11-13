---
name: dakflare-provision
description: Install, configure or repair a DakFlare deployment: a Worker on Cloudflare, a D1 database, and one paired Android handset. Use when setting up DakFlare for the first time, when `dakflare doctor` reports a failure, when a secret or binding is missing, or when a device needs pairing or revoking. Triggers: install dakflare, set up the gateway, doctor fails, missing secret, pair a phone, revoke a device, deploy the worker.
---

# DakFlare: provisioning and repair

A deployment is three things: a Worker on the operator's own Cloudflare account, a D1
database it owns, and one Android handset that holds the SIM. `dakflare up` is the one
command that talks to Cloudflare: it drives `cf`, with no wrangler fallback. Every
other command talks to the Worker.

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
# 1. sign in to Cloudflare locally
cf auth login

# 2. write the three local secrets into worker/.dev.vars
dakflare init --local

# 3. provision, migrate, deploy, create the owner, mint a pairing code
dakflare up --email you@example.com

# 4. point the CLI at the Worker
dakflare init --url https://<worker>.workers.dev --token-file ~/.token
dakflare pair --qr          # another pairing code, when needed
```

The admin token `init --local` generated is the `ADMIN_TOKEN` line in
`worker/.dev.vars`; put that value in `~/.token` before step 4. Never commit
`.dev.vars`.

`up --dry-run` prints the plan and changes nothing. Every step converges, so running
it again on a live deployment repairs it rather than replacing it.

## Two facts that cost time if you learn them the hard way

- **The ids are written, not pasted.** `up` finds `sms_gateway` by exact name, creates
  it only when absent, and writes the D1 and KV ids into
  `worker/cloudflare.config.ts`, which is the file `cf deploy` reads. Ids pasted into
  `wrangler.toml` are invisible to that deploy.
- **Unified Authentication.** Operators authenticate with a passkey through Better Auth
  in the console; a password factor exists where enabled. Automated CLI and machine
  workflows use an admin token or a scoped agent token. `doctor` reports the admin
  token and the auth mode it sees.

## Repair order

1. `dakflare doctor --agent` — read `error.remediation` first.
2. `dakflare devices --agent` — is the phone still paired and recently seen?
3. `dakflare revoke <id> --yes` then `dakflare pair` — if the handset's identity is gone
   (reinstall, factory reset). Revoking is irreversible; the phone must pair again.

## The one mistake to avoid

Reinstalling the app to fix a pairing problem. The identity lives in the app's data
directory, so an uninstall also drops the battery whitelist and the pairing. Diagnose
with `doctor` and `devices` first.
