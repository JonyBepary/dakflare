# `dakflare` operator CLI

Zero-dependency Node 22+ CLI for one DakFlare deployment. It talks to the Worker over `fetch`, keeps
its config in `~/.config/dakflare/config.json` (mode 600), and never needs a build step.

```bash
npm install -g .                       # from the repo root, or: node cli/bin/dakflare.js ...
dakflare init --url https://example.workers.dev --token <ADMIN_TOKEN>
dakflare doctor
```

`init --local` writes `worker/.dev.vars` with a fresh `ADMIN_TOKEN`, `AUTH_PEPPER` and
`BETTER_AUTH_SECRET` for `wrangler dev`; it does not contact a Worker.

`dakflare up --email you@example.com` provisions a deployment end to end: resources, deploy, the first
owner and a pairing code. `--dry-run` prints the plan, `--yes` skips the questions.

## Commands

### Provision

| Command | Flags | What it does |
|---|---|---|
| `init` | `--url --token --token-file --local --force` | verify a Worker and save the URL and token |
| `up` | `--email --yes --dry-run` | resources, deploy, owner, pairing |
| `doctor` | `--max-age --serial` | config, health, schema, migrations, bindings, phone |
| `pair` | `--label --qr --ttl` | mint a pairing code; `--qr` renders it in the terminal |
| `devices` | none | list paired devices and their last contact |
| `revoke <id>` | `--yes` | revoke one device; the phone must pair again |

### Messaging

| Command | Flags | What it does |
|---|---|---|
| `send` | `--to --body --device --no-wait --wait --until --idempotency-key` | queue an SMS and follow it to the radio |
| `status <id>` | `--device --wait --until` | read one command's state, or follow it |
| `audit` | `--tail --actor --limit` | read the audit log |

A send is asynchronous. `send` waits 10 s by default and exits from the outcome; `--no-wait` returns
as soon as the deployment queues it. Exit `75` means still in flight: check `status`, never send
again. `SENT` is not delivery; `DELIVERED` is. Pass `--idempotency-key` whenever a retry is possible.

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
| `flows apply <file>` | `--dry-run --force` | write one flow document and print the structural diff |
| `flows heal <id>` | `--samples --node --corpus-limit --dry-run` | re-check a new pattern against the real history; write it only if every old capture is unchanged |
| `rules apply <file>` | `--dry-run` | write auto-reply rules |
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

The root README has the deployment model, the grant caps and the MCP tools. `docs/OPS_DEPLOY.md` has
the Worker-side deploy and secret order.
