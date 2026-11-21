# `dakflare` operator CLI

A zero-dependency CLI for one DakFlare deployment. It talks to the Worker over `fetch`, keeps its
config in `~/.config/dakflare/config.json` (mode 600), and never needs a build step. The release
ships standalone Bun binaries; Node is only needed for `cf` (the deploy path) and for the source
fallback.

```bash
curl -fsSL https://raw.githubusercontent.com/JonyBepary/dakflare/main/install.sh | sh
dakflare setup
dakflare doctor
```

The installer prefers the prebuilt binary and the Worker pack, verifies their SHA-256, and starts
`dakflare setup`: it installs the pack, creates `pack/.dev.vars`, checks `cf` and `gh`, offers to
star the repository, and can hand off to `up`. `--source` installs the checkout; `--no-pack`
installs the CLI only; `--no-setup` skips the wizard. `--dry-run` previews the changes.

In an existing checkout, `npm install -g .` installs the same binary, and
`node cli/bin/dakflare.js` runs it without installing.

`init --local` writes `worker/.dev.vars` with a fresh `ADMIN_TOKEN`, `AUTH_PEPPER` and
`BETTER_AUTH_SECRET` for `wrangler dev`; it does not contact a Worker.

`dakflare up --email you@example.com` provisions a deployment end to end: resources, deploy, the first
owner and a pairing code. `--dry-run` prints the plan, `--yes` skips the questions.

`--pack <dir>` deploys a precompiled release pack: it fills the pack's D1/KV ids, applies
`migrations` with `cf d1 migrations apply --dir`, and runs `cf deploy --prebuilt`. It does not
install or build the Worker tree. `--checkout` forces the source path when a pack is installed.

## Commands

### Provision

| Command | Flags | What it does |
|---|---|---|
| `setup` | `--pack --checkout --yes --star --deploy --email --dry-run` | first-run wizard: pack or source, toolchain, secrets, star, optional `up` |
| `init` | `--url --token --token-file --local --force` | verify a Worker and save the URL and token |
| `up` | `--pack --checkout --email --yes --dry-run` | pack or source, local secrets, cf login, queues, migrations, prebuilt deploy, owner, pairing QR, saved config |
| `doctor` | `--max-age --serial` | config, health, schema, migrations, bindings, phone |
| `pair` | `--label --qr --ttl` | mint a pairing code; `--qr` renders it in the terminal |
| `devices` | none | list paired devices and their last contact |
| `revoke <id>` | `--yes` | revoke one device; the phone must pair again |

### Messaging

| Command | Flags | What it does |
|---|---|---|
| `send` | `--to --body --device --no-wait --wait --until --idempotency-key` | queue an SMS and follow it to the radio |
| `send --channel --connector` | `--template-id --human-agent-tag --comment-id --media-url` | send one message through an enabled connector instead of the radio |
| `status <id>` | `--device --wait --until` | read one command's state, or follow it |
| `audit` | `--tail --actor --limit` | read the audit log |

A send is asynchronous. `send` waits 10 s by default and exits from the outcome; `--no-wait` returns
as soon as the deployment queues it. Exit `75` means still in flight: check `status`, never send
again. `SENT` is not delivery; `DELIVERED` is. Pass `--idempotency-key` whenever a retry is possible.

`--channel` plus `--connector` posts to `/v1/channels/<channel>/<id>/send` and never touches the
radio. `--template-id` applies to WhatsApp, `--human-agent-tag` to Messenger, and `--comment-id` to
an Instagram comment reply. Without `--channel`, `send` behaves exactly as before.

### Channels

A connector is one external platform account with its credential sealed at rest
(AES-256-GCM). The credential is never returned after it is written, so `list` reports only whether
one is set and when it last changed.

| Command | Flags | What it does |
|---|---|---|
| `connectors list` | none | id, channel, account, label, secret presence, enabled state and the webhook URL |
| `connectors create` | `--channel --account-id --label --auth-mode --access-token --bot-token --app-secret --verify-token --secret-token --enabled --dry-run` | create `whatsapp`, `telegram`, `messenger` or `instagram` |
| `connectors update <id>` | `--label --enabled --auth-mode` and the credential flags | change metadata or rotate a credential; channel and account id are immutable |
| `connectors delete <id>` | `--yes` | remove the connector and its Durable Object |
| `webhooks list` | `--kind inbound\|outbound` | inbound triggers or outbound flow endpoints |
| `webhooks create` | `--name --dry-run` (inbound) or `--kind outbound --name --url --event --timeout-ms --dry-run` | mint a hook and print its signing secret once |
| `webhooks test <id>` | none | signed test ping to an outbound endpoint, with status and latency |
| `webhooks delete <id>` | `--yes` | remove a hook and its deliveries, either kind |
| `webhooks deliveries <id>` | none | the last 20 inbound deliveries, newest first |

### Templates, contacts and scheduling

| Command | Flags | What it does |
|---|---|---|
| `templates list` | none | id, channel and name, with variables |
| `templates create` | `--name --body --channel --dry-run` | store a `{{var \| fallback}}` body |
| `templates delete <id>` | `--yes` | remove a template |
| `contacts import <file>` | none | read RFC-4180 CSV and upsert in 50-row D1 batches |
| `schedule list` | `--status` | the paced queue, soonest first |
| `schedule create` | `--target --to --body --at --channel --template-id --dry-run` | queue one send; `--at` is ISO-8601 |
| `schedule cancel <id>` | `--yes` | cancel while it is still scheduled; a claimed row answers `not_cancellable` |

`schedule create` infers `target_type` from `--channel`: `sms` is a paired device, every other
channel is a connector id. Quiet hours and the hourly cap are applied by the Scheduler, not by the
CLI, so a shifted message keeps its row and is not lost.

`connectors create --dry-run` prints the request with every credential redacted and sends nothing.
The webhook URL is built from the Worker URL and the connector id; the API never stores or returns
it. Unlike a connector secret, a webhook signing secret is printed by `create` and must be stored
then, because the deployment keeps only a sealed copy for verification.

An **outbound** webhook is a URL a flow's `webhook` action may call. Its secret is sealed with
AES-256-GCM and printed once by `create`. The Worker signs `` `<unix-seconds>.<raw-body>` `` with
HMAC-SHA-256 and sends `X-Dakflare-Timestamp` and `X-Dakflare-Signature: sha256=<hex>`; verify
within 300 seconds so a replay cannot be re-used. Loopback, private, CGNAT, metadata and
non-http(s) targets are refused when the hook is created and again when it is called.

### Accounts and the agent control plane

`dakflare auth <subcommand>`:

| Subcommand | What it does |
|---|---|
| `bootstrap --email` | create the first owner, with no credential; enrol a passkey next |
| `invite --email [--role] [--ttl]` | mint a single-user invite |
| `invites` | list invites and whether they were used |
| `reset --email --yes` | delete an account and mint a fresh owner invite |
| `mint-agent-token --name --scope [--device] [--max-per-hour] [--ttl]` | mint a `dkf_agt_` token; printed once |
| `agent-tokens [--all]` | list tokens and their budgets |
| `revoke-agent-token <id> --yes` | stop a token on its next request |
| `approvals [--state PENDING]` | what agents wait on, with the ladder |
| `approve <id> --for 1m\|5m\|15m\|30m\|1h\|1d\|7d\|30d` | grant it, clamped per scope |
| `reject <id>` | refuse it; the agent may ask again |
| `grants [--token] [--live]` | what is currently allowed, and how often it was used |
| `grants revoke <grant-id> --yes` | close a grant window now |

`devices:revoke` and `auth:reset` are not scopes at all, so no token and no grant can hold them.
Production SMS is capped at one hour and must name recipients or a device; a production flow deploy
and a rules write are capped at one day.

### Automation

| Command | Flags | What it does |
|---|---|---|
| `flows apply <file>` | `--id --dry-run --force` | write one flow document and print the structural diff |
| `flows heal <id>` | `--samples --group --device --node --corpus-limit --dry-run` | re-check a new pattern against the real history; write it only if every old capture is unchanged |
| `rules list` | `--agent` | list auto-reply rules in priority order |
| `rules apply <file>` | `--dry-run` | write auto-reply rules |
| `rules update <id>` | `--enabled --disabled --name --reply --cooldown --max-per-hour` | update or pause/resume an existing rule |
| `rules delete <id>` | `--yes` | delete an auto-reply rule |
| `rules test` | `--peer --body --device` | run the rules against one message |
| `extract synthesize --samples <file>` | `--group --verify-d1-limit --device` | derive a regex from real messages and prove it |

### Provenance

| Command | Flags | What it does |
|---|---|---|
| `trace <id>` | `--device` | explain a message, command or approval request |
| `alerts` | `--all` | open operator alerts, newest first |
| `dlq` | `--device --limit` | read a device object's dead letters |
| `ws inspect` | `--device` | show a device's live sockets |

### Contract

| Command | What it does |
|---|---|
| `capabilities` | every command, its effect and its flags |
| `describe <command>` | purpose, usage and flags for one command |
| `schema <command>` | the flag contract as data; `schema states` for state machines |
| `examples <command>` | real invocations, including a failing one |
| `mcp serve` | bridge this deployment over MCP on stdio |
| `key fingerprint` | print the release signing certificate's SHA-256 |

## Machine contract

`--agent` prints one compact JSON document, never prompts and never uses colour. `--json` is accepted
on every command as the same envelope. Exit codes are semantic:

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | failed check or request |
| `2` | usage error |
| `3` | not found |
| `4` | permission denied |
| `5` | conflict, such as a stale `expected_previous_version` |
| `6` | precondition failed |
| `75` | still in flight |

## Examples

```bash
dakflare pair --qr
dakflare send --to +8801700000000 --body "Build finished" --idempotency-key build-42
dakflare status cmdf_01j... --wait
dakflare auth invite --email operator@example.com --role admin --ttl 900
dakflare auth mint-agent-token --name ci --scope sms:send,devices:read --max-per-hour 20
dakflare auth approvals
dakflare flows apply flow.json --dry-run
dakflare extract synthesize --samples samples.json
dakflare trace cmdf_01j...
dakflare capabilities --agent
```

The root README has the deployment model, the grant caps and the MCP tools. `OPS_DEPLOY.md` has
the Worker-side deploy and secret order.
