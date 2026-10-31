# `dakflare` — operator CLI

Operate a self-hosted DakFlare deployment without `curl`, a dashboard tab, or
`adb` archaeology. Zero dependencies, Node 22+ (`fetch` is built in).

```bash
node cli/bin/dakflare.js --help
node cli/bin/dakflare.js doctor
npm link          # optional: makes `dakflare` global (root bin -> cli/bin/dakflare.js)
```

The CLI talks to exactly one Worker: the one in
`~/.config/dakflare/config.json`. It never calls Cloudflare's API, never
deploys, and never prints the admin token. `init --local` is the only command
that writes a secret file, and it generates fresh values.

## Commands

| Command | Does |
|---|---|
| `dakflare init` | verify `/v1/admin/health`, then save the Worker URL and admin token |
| `dakflare init --local` | write `worker/.dev.vars` with fresh `ADMIN_TOKEN`, `AUTH_PEPPER`, `BETTER_AUTH_SECRET` |
| `dakflare doctor` | checklist of config, health, schema, migrations, bindings, D1, phone and adb |
| `dakflare pair` | mint a pairing code and print the `dakflare://pair?u=…&c=…` link |
| `dakflare pair --qr` | the same, plus a terminal QR (`qrencode`, or the built-in encoder) |
| `dakflare devices` | list paired devices with label, SIM slot and last contact |
| `dakflare revoke <id>` | revoke a device in D1 and its Durable Object; asks first |
| `dakflare send --to <e164> --body <text>` | queue an outbound SMS and print its command id and state |
| `dakflare audit --tail` | read the audit log; says "not available on this deployment" on 404 |
| `dakflare key fingerprint` | print the release signing certificate's SHA-256 from the JKS |

Every command accepts `--json` and every command has its own `--help`.

## Config

`~/.config/dakflare/config.json`, written mode `600`:

```json
{
  "url": "https://<worker>.workers.dev",
  "token": "<ADMIN_TOKEN>",
  "installedAt": "2026-10-30T00:00:00.000Z"
}
```

The token is stored but never printed. If the file is missing, commands say to
run `dakflare init` and exit 2. `ADMIN_TOKEN` is unrecoverable from the Worker;
regenerate it with `npx wrangler secret put ADMIN_TOKEN --name dakflare-worker`.

## What `doctor` proves

| Check | Passes when |
|---|---|
| `config` | present, with `url` and `token`, mode `600` on POSIX |
| `health` | `/v1/admin/health` answers 200 (or 503 with a diagnosis) |
| `admin-token` | the Worker accepts the bearer token |
| `schema` | `schema_ready` is true and the counts query worked |
| `migrations` | every `worker/migrations/*.sql` in the checkout is in `migrations` |
| `bindings` | `DB`, `KV`, `DEVICE` and all rate limiters are bound |
| `fcm-binding` | FCM is present (optional; absent is a skip, not a failure) |
| `auth-mode` | reported and known; absent is a skip until phase 2 |
| `d1` | no `db_error`, counts readable |
| `phone` | the freshest device contacted within `--max-age` (default 60 min) |
| `phone-role` | `android.app.role.SMS` is held by the installed DakFlare package |
| `phone-build` | the installed package is readable; reports release vs debug |

`phone-role` and `phone-build` are skipped when `adb` is absent or no device is
attached. `--serial` / `ANDROID_SERIAL` select a device; `ADB` overrides the
binary. Exit 1 if any check fails; a skip is not a failure.

## Examples

```bash
# configure against an existing deployment
dakflare init --url https://dakflare-worker.example.workers.dev --token-file ~/.config/dakflare/admin-token

# local development secrets (does not contact a Worker)
dakflare init --local

# a pairing code as text, or with a QR for the phone camera
dakflare pair
dakflare pair --label "Mi A3" --qr

# queue one message; with several devices it uses the freshest, and says so
dakflare send --to +8801540196080 --body "cli probe"
dakflare send --to +8801540196080 --body "pinned phone" --device dev29b9c2248cb266c8

# scripts
dakflare doctor --json
dakflare devices --json
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success (including `audit` when the endpoint is absent) |
| 1 | a check failed, the Worker returned an error, or the keystore could not be read |
| 2 | usage error, missing config, missing tool, or a destructive command without confirmation |

## Deliberately deferred to phase 2

- **Invites and owner bootstrap.** `dakflare init` configures an existing
  deployment; it does not create users or invite anyone.
- **Audit.** `dakflare audit` is wired, but the Worker has no audit endpoint
  yet. It prints "not available on this deployment" on 404 instead of failing.
- **Secret rotation.** No command writes Cloudflare secrets. `init --local`
  rotates only the local `.dev.vars`.
- **Fleet routing.** `send` picks the freshest paired device when `--device` is
  omitted. There is no failover or per-line capacity logic yet.
