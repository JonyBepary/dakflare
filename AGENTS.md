# Notes for coding agents

DakFlare is a self-hosted SMS gateway: one Android handset, one Cloudflare Worker, one
console, one CLI. The phone is the radio; the Worker is the coordinator.

## Start here

```bash
dakflare capabilities --agent     # every command, its effect, its flags
dakflare describe <command>       # purpose, usage, flags
dakflare schema <command> --agent # the flag contract as data
dakflare examples <command>       # real invocations
```

`--agent` prints one compact JSON document per call, never prompts, and never uses
colour. Exit codes are semantic: `0` ok, `1` failed, `2` usage, `3` not found,
`4` permission, `5` conflict, `6` precondition, `75` temporary.

## Skills

Three focused skills live in `skills/`. Load the one that matches the task rather than
reading all of them:

| Skill | Load it when |
|---|---|
| `skills/dakflare-provision/` | installing, deploying, repairing, pairing or revoking |
| `skills/dakflare-messaging/` | sending, following, retrying, or reading delivery state |
| `skills/dakflare-flows/` | writing or debugging an auto-reply graph |

The layout is the standard `skills/<name>/SKILL.md` shape, so `npx skills add` can
install them into another repository unchanged.

## Things that are easy to get wrong

- **A send is asynchronous.** `send` waits 10 s by default and exits from the outcome;
  `--no-wait` returns as soon as the deployment queues it. Exit 75 means still in
  flight — check it with `status`, never by sending again.
- **`SENT` is not delivery.** `verification.passed` is true only on `DELIVERED`. The
  landing page's "Not claimed" block and the CLI agree on this; keep it that way.
- **Idempotency is opt-in.** Pass `--idempotency-key` if a retry is possible; the same
  key returns the same `command_id` instead of a second SMS.
- **The CLI never touches Cloudflare.** Only provisioning does, through `cf`. Do not add
  a Cloudflare SDK to the CLI; `fetch` is built in and `cf` owns auth.

## Repository shape

| Path | What |
|---|---|
| `worker/` | the Worker, D1 schema, Durable Objects, auth |
| `dashboard/` | the SvelteKit console, served by the Worker at `/admin` |
| `cli/` | `dakflare`, zero dependencies, Node 22+ |
| `simulator/` | the Android app (Tauri + Rust core) |
| `design/` | the landing page sources and tokens |
| `test-support/` | conformance harness, shared protocol vectors, dev stack |
| `docs/` | plans and runbooks: `AUTH_PLAN.md`, `CLI_PLAN.md`, `OPS_BACKUP.md` |

## Before you claim something works

`node dakflare_test_harness.mjs pair && node dakflare_test_harness.mjs suite` against a
local stack (`./test-support/dev.sh`), and `cargo test` in `simulator/core`. A summary is
a claim; the suite is evidence.
