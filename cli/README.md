# `dakflare` — desktop CLI

Installs and operates a DakFlare deployment. Zero dependencies, Node 20+.

```bash
# from a checkout
node cli/dakflare.mjs help

# or make it a global command
npm link          # then: dakflare help
```

## Two credentials, never mixed

This is the thing most tools get wrong, so it is stated everywhere:

| Plane | Credential | What it authorises | Where it lives |
|---|---|---|---|
| **Cloudflare account** | OAuth, obtained by `wrangler login` | create D1/KV, deploy, set secrets, read metrics | Wrangler's own store — **this CLI never keeps it** |
| **Deployment admin** | the `ADMIN_TOKEN` Worker secret | `/v1/admin/*` on **one** deployment: pairing, send, fleet, rules | `~/.config/dakflare/config.json`, mode `0600` |

They are not interchangeable. OAuth cannot call `/v1/admin/send`; the admin token cannot deploy.
`init` uses OAuth for the Cloudflare side and **generates** the admin token itself, so you never copy
one out of a dashboard. `doctor`, `pair`, `devices`, and `send` work without the Cloudflare account
being authenticated at all.

## Why Wrangler, not `cf`

`cf` is Cloudflare's newer unified CLI (beta). It is deliberately **not** this project's build/deploy
path, for three documented reasons:

1. **`cf` does not read `wrangler.toml`.** `cf dev`, `cf build` and `cf deploy` require
   `cloudflare.config.ts`; in an unmigrated Wrangler project they fail — and Cloudflare documents that
   automatic configuration can rewrite the project as a static site *without your Worker code or
   bindings*. Their own guidance: *"Until you migrate the project, keep using Wrangler for development
   and deployment, such as `wrangler dev` and `wrangler deploy`."*
2. **D1 schema versioning is a Wrangler workflow.** The D1 docs describe migrations as created and
   applied *with Wrangler*. `cf` offers `cf d1 query <DATABASE_ID> --sql`, which is a different
   workflow and takes an id, not a name. Our `d1_migrations` table is read by `/v1/admin/health`, so the
   migration runner is part of the contract with operators.
3. **Our conformance lane is local-first** — `wrangler dev --local` with Durable Object SQLite,
   hibernating sockets and alarms. `cf`'s local support is limited to selected KV/D1/R2 commands, and
   its project commands are remote-oriented.

`cf` is still the better tool for **account-level** work and needs no migration to use: `cf d1 list`,
`cf zones`, `cf dns records` run in any directory. When custom-domain setup lands (hardening S4), that
is the tool to reach for — Wrangler cannot manage DNS.

> **Do not run `cf dev`, `cf build`, or `cf deploy` in this repo** unless you have migrated it with
> `cf migrate`. Running them on an unmigrated project can overwrite the configuration as a static site.

## Commands

| Command | Does |
|---|---|
| `dakflare init` | checks `wrangler login`, deploys, generates + sets `ADMIN_TOKEN`, saves the target |
| `dakflare doctor` | health: version, migrations, bindings, counts; exits non-zero when unhealthy |
| `dakflare pair [--ttl 600]` | mints a pairing code and a `dakflare://pair?u=…&c=…` deep link |
| `dakflare devices` | lists paired devices with last-seen |
| `dakflare send <+E164> <text> --device <id>` | queues an outbound SMS |
| `dakflare use <url> --token <t>` | points at an existing deployment (verified before saving) |
| `dakflare whoami` | target, masked token, Cloudflare auth state |

## What it deliberately does not do

- **Choose a device for you.** `send` requires `--device`. Fleet placement and failover are planned
  (see the master plan's F-phases), and inventing a target now would hide the gap.
- **Store your Cloudflare credentials.** It shells out to Wrangler. If you are not logged in, it tells
  you to run `npx wrangler login` rather than asking for a token.
- **Print the admin token.** Only a `first4…last4` fingerprint is ever shown.
- **Read message contents.** `doctor` reports counts and timestamps; there is no command that dumps SMS
  bodies to a terminal.

## Config

`~/.config/dakflare/config.json`, created `0600`:

```json
{ "url": "https://dakflare-worker.<subdomain>.workers.dev", "token": "<admin token>", "installedAt": "…" }
```

On Windows the path is `%USERPROFILE%\.config\dakflare\`. If the file is lost, the token is
unrecoverable from the Worker — regenerate with `npx wrangler secret put ADMIN_TOKEN`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `not authenticated with Cloudflare` | run `npx wrangler login` |
| `network error reaching …` | wrong URL, offline, or Cloudflare Access in front without a service token |
| `HTTP 401` on every command | token does not match the deployment's `ADMIN_TOKEN` |
| `device_unknown` on send | that `device_id` is not in the D1 registry — `dakflare devices` |
| `FCM not configured` warning in `doctor` | expected; devices are reachable only while their socket is open |
