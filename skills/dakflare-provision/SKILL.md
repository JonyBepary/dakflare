---
name: dakflare-provision
description: "Install, configure or repair a DakFlare deployment: two Workers on Cloudflare, a D1 database, and one paired Android handset. Use when setting up DakFlare for the first time, when `dakflare doctor` reports a failure, when a secret or binding is missing, or when a device needs pairing or revoking. Triggers: install dakflare, set up the gateway, doctor fails, missing secret, pair a phone, revoke a device, deploy the worker."
---

# DakFlare: provisioning and repair

A deployment is three things: two Workers on the operator's own Cloudflare account — the public
one and the internal agent Worker behind it — a D1 database they share, and one Android handset
that holds the SIM. `dakflare up` is the one command that talks to Cloudflare: it drives `cf`,
with no wrangler fallback, and it deploys the agent Worker first because the main Worker's
`AGENT_SVC` binding names it. Every other command talks to the main Worker.

## Read this first

```bash
dakflare capabilities --agent
dakflare doctor --agent        # always run this before changing anything
```

`doctor` is the map. It reports config, health, schema, migrations, bindings and the
phone, and each failing check names the command that fixes it in the envelope's
`error.remediation`.

## The sequence

`dakflare setup` is the first-run wizard: it checks Node, npm, git, `cf` and `gh`, uses the
precompiled Worker pack by default (or a source checkout with `--checkout`), creates the local
secrets, and offers to star the repository and run `up`. It never stars without an interactive yes
or `--star`. `--dry-run` previews it; `--yes` skips prompts but still needs `--star`/`--deploy` for
those effects. The installer prefers the standalone CLI binary and pack; `--source` forces the
checkout, and a pack deploy needs no npm install or console build.

```bash
# 0. one-time wizard (the installer starts it on a terminal)
dakflare setup

# 1. sign in to Cloudflare locally
cf auth login

# 2. write the three local secrets into worker/.dev.vars
dakflare init --local

# 3. provision, migrate, deploy, create the owner, mint a pairing code
dakflare up --email you@example.com   # or: up --pack ~/.local/share/dakflare/pack

# 4. point the CLI at the Worker
dakflare init --url https://<worker>.workers.dev --token-file worker/.dev.vars
dakflare pair --qr          # another pairing code, when needed
```

`init --local` generates `ADMIN_TOKEN=...` in `worker/.dev.vars`, and `init --token-file`
reads either a raw token file or `ADMIN_TOKEN=` from `.dev.vars`; `up` also falls back
to `worker/.dev.vars` during fresh provisioning before `init --url` runs. Never commit
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
