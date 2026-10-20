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

## Wrangler and `cf` — which does what

The project is **migrated to `cloudflare.config.ts`** (`cf migrate`, completed by hand for Durable Object
`exports`), and keeps `wrangler.toml` alongside it. That is deliberate, not leftover: each tool owns a
different job, and Cloudflare's migration guide itself tells you to keep using Wrangler for the gaps.

| Task | Tool | Why |
|---|---|---|
| **Deploy** | `cf deploy` (`npm run deploy:cf`) | `cf` reads `cloudflare.config.ts`; the config is the canonical one |
| **Local dev / conformance** | `wrangler dev --local` | `cf` has no local equivalent for Durable Object SQLite, alarms or hibernating sockets — and the whole test lane depends on them |
| **D1 migrations** | either: `cf d1 migrations apply` or `wrangler d1 migrations apply` | both support it, including `--local`. `cf` takes the database id, Wrangler takes the name |
| **Secrets** | `wrangler secret put --name dakflare-worker` | `cf` **cannot set a single secret yet**; its own migration guide says to use `npx wrangler` |
| **Live logs** | `wrangler tail dakflare-worker` | `cf` **cannot stream logs yet** |
| **Account / DNS / zones** | `cf d1 list`, `cf zones`, `cf dns` | Wrangler has no DNS support at all |

Two configs must not drift: bindings, vars, triggers and the DO export list are declared in **both**
`cloudflare.config.ts` and `wrangler.toml`. `npm run check:config` diffs the binding names.

> **The first `cf deploy` is a one-way door.** Switching Durable Object lifecycle from Wrangler's ordered
> `[[migrations]]` to `exports` cannot be rolled back to a version created before the switch. Run it with
> `cf deploy` — never a version upload — and only once `exports` lists every live class.
>
> **Never run `cf dev` or `cf build` on this project expecting the Wrangler behaviour** unless you intend
> to use the `cf` bundler path; local development stays on `wrangler dev --local`.

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
