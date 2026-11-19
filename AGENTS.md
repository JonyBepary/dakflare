# Notes for coding agents

DakFlare is a self-hosted SMS gateway: one Android handset, one Cloudflare Worker, one
console, one CLI. The phone is the radio; the Worker is the coordinator.

## Start here

```bash
dakflare capabilities --agent     # every command, its effect, its flags
dakflare describe <command>       # purpose, usage, flags
dakflare schema <command> --agent # the flag contract as data
dakflare schema states --agent    # state machines and transitions
dakflare examples <command>       # real invocations
dakflare schema --flow-v2 --json  # the canonical flow IR schema
dakflare ask "<intent>" --flow <id> --dry-run --ndjson   # what a patch request would be
dakflare fix --flow <id> --message "<a message>"         # why a pattern did not match
```

`--agent` prints one compact JSON document per call, never prompts, and never uses
colour. Exit codes are semantic: `0` ok, `1` failed, `2` usage, `3` not found,
`4` permission, `5` conflict, `6` precondition, `75` temporary.

The HTTP surface behind those commands is documented in `docs/AGENT_SURFACE.md`:
`/v1/agent/triage|telemetry|diagnose|synthesize`, and `/mcp` over streamable HTTP with
public OAuth discovery. A model never authorises a change; a grant does.

## Skills

Four focused skills live in `skills/`. Load the one that matches the task rather than
reading all of them:

| Skill | Load it when |
|---|---|
| `skills/dakflare-provision/` | installing, deploying, repairing, pairing or revoking |
| `skills/dakflare-messaging/` | sending, following, retrying, or reading delivery state |
| `skills/dakflare-flows/` | writing or debugging an auto-reply graph |
| `skills/dakflare-agents/` | managing agent tokens, approvals, authority grants, or MCP |

The layout is the standard `skills/<name>/SKILL.md` shape, so `npx skills add` can
install them into another repository unchanged.

## Things that are easy to get wrong

- **A send is asynchronous.** `send` waits 10 s by default and exits from the outcome;
  `--no-wait` returns as soon as the deployment queues it. Exit 75 means still in
  flight, so check it with `status` and never by sending again.
- **`SENT` is not delivery.** `verification.passed` is true only on `DELIVERED`. The
  landing page's "Not claimed" block and the CLI agree on this; keep it that way.
- **Idempotency is opt-in.** Pass `--idempotency-key` if a retry is possible; the same
  key returns the same `command_id` instead of a second SMS.
- **The CLI never touches Cloudflare.** Only provisioning does, through `cf`. Do not add
  a Cloudflare SDK to the CLI; `fetch` is built in and `cf` owns auth.
- **A webhook can answer but never act.** Its actor is `webhook:<id>`, so `authorizeAct`
  refuses every effect with `webhook_cannot_act` even when an autonomy window is open. A hook
  secret cannot be re-read: rotation is create, cut over, delete. Rotating
  `WEBHOOK_SECRET_KEY` invalidates every sealed secret at once and needs each hook recreated —
  `docs/AGENT_RUNTIME.md` has the procedure, `docs/ADR_001_AGENT_RUNTIME.md` the reasons.
- **A deploy is verified by evidence.** `cf deploy` can exit `1` on a deploy that worked, so
  `npm run verify:deploy` checks the version, live routes, the workflow binding and the
  migration ledger. `npm run deploy` refuses a dirty console tree, because `cf deploy` uploads
  whatever build sits in `worker/public/admin`.

## Repository shape

| Path | What |
|---|---|
| `worker/` | the Worker, D1 schema, Durable Objects, auth |
| `dashboard/` | the SvelteKit console, served by the Worker at `/admin` |
| `cli/` | `dakflare`, zero dependencies, Node 22+ |
| `simulator/` | the Android app (Tauri + Rust core) |
| `design/` | the landing page sources and tokens |
| `test-support/` | conformance harness, shared protocol vectors, dev stack |
| `docs/` | the master spec, the agent surface reference, runbooks, console and workflow notes, `STATE_MACHINES.md` (every state machine, and whether it is guarded, declared or derived), and `history/` for point-in-time plans |

## How this owner wants work done

Carry a task to resolution in one run: do not stop at a plan, a partial commit or a green
type-check while something you can finish is unfinished. When a choice is yours, take the
one that raises all three of user experience, developer experience and agent experience,
and never buy one by breaking another. Verify against the rendered thing and the running
deployment, not only against source: this repository has shipped three defects that every
static gate passed.

## Before you claim something works

`node dakflare_test_harness.mjs pair && node dakflare_test_harness.mjs suite` against a
local stack (`./test-support/dev.sh`), `cargo test` in `simulator/core` and
`simulator/flow`, `npm run typecheck && npm run check:config` in `worker/`, and
`npm run check` in `dashboard/`. A summary is a claim; the suite is evidence.
