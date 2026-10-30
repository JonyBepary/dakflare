# CLI plan — one protocol, two faces

Status: proposal, 2026-10-30. Builds on `cli/bin/dakflare.js` (1,844 lines, zero
dependencies, Node 22+). Nothing here is implemented yet.

The goal is one CLI that a person at a terminal enjoys and an agent can drive without
guessing: same core, two renderings, and a result envelope that always says what
happened and what to run next.

## 1. Should the CLI drive Cloudflare through `cf` or the SDK?

**Neither, for almost everything. For provisioning, `cf`.**

The CLI has three tiers of work, and only one of them touches Cloudflare at all:

| Tier | Commands | Talks to | Credentials |
|---|---|---|---|
| Runtime | `send`, `devices`, `pair`, `revoke`, `audit`, `doctor` (and `status`, new in §5) | the operator's own Worker over HTTPS | the deployment's admin token |
| Local | `init`, `key` | nothing, or the local keystore | none |
| Provisioning | `up` | Cloudflare's API, via `cf` | `CLOUDFLARE_API_TOKEN` |

Tier 1 is 90% of usage and must never require a Cloudflare token. That is a security
property, not an accident: an operator sending an SMS should not be holding a
credential that can delete their DNS. Keeping the Cloudflare SDK out of the binary is
what keeps that property enforceable, because an SDK in `package.json` invites the next
feature to reach for it.

### Why `cf` and not the SDK

1. **It covers every Cloudflare operation DakFlare has.** Not "most" — the product's
   entire Cloudflare surface is Workers, D1, KV, Durable Objects, secrets, cron and
   logs, and all but one of those is a `cf` command. Verified against the installed
   `cf 1.0.0-beta.25`:

   | Operation | Command |
   |---|---|
   | Deploy the Worker and its assets | `cf deploy` |
   | Plan only | `cf deploy --dry-run` |
   | Create the database | `cf d1 create sms_gateway` |
   | Apply migrations | `cf d1 migrations apply <id> --remote` |
   | Seed or inspect rows | `cf d1 execute` |
   | Create the namespace | `cf kv namespaces create KV` |
   | Seed the namespace | `cf kv bulk put` |
   | Set one secret | `cf workers secrets update <NAME> --text … --worker …` |
   | Set several at once | `cf workers secrets bulk` |
   | Check the token before starting | `cf accounts tokens verify` |
   | Read logs after the fact | `cf logs query` |
   | Stream logs live | **none** — `wrangler tail` |

   Durable Objects, cron triggers and rate-limit bindings are not resources to create:
   they are declarations in `cloudflare.config.ts`, and `cf deploy` applies them. So the
   only hole in the whole list is a live log stream, and that is a TTY feature, not
   something an agent asks for.

2. **`--dry-run` is the `plan` half of plan/apply for free.** We do not write a planner
   or a diff engine; we run the deploy twice.

3. **`--secrets-file` collapses deploy and secrets into one step.** Today the install is
   three separate `wrangler secret put` prompts; it becomes one non-interactive command
   reading the file `dakflare init --local` already writes.

4. **`cf` is agent-native and says so.** Its help opens with a discovery banner, `cf cli
   search` returns compact JSON, `cf schema` returns the request contract. A wrapper
   inherits all of that instead of re-deriving it.

5. **A subprocess costs nothing at this scale.** Measured: `cf` cold-starts in 161–259 ms
   on this machine, and `up` makes about eight calls, so the whole provision pays under
   two seconds of overhead. The case where spawning per call would hurt — bulk writes —
   is already a single command (`cf kv bulk put`).

6. **The SDK is a dependency tree for zero calls.** The CLI installs with `npm i -g` and
   nothing else, which is why it runs on a stripped CI runner. Adding `cloudflare` to
   `package.json` buys no operation we cannot already reach, and it buys one thing we do
   not want: the temptation to fold provisioning into the process that sends SMS.

7. **Wrangler is not the answer either.** It is being sunset, its `--json` is per-command,
   and we would be writing a parser per command to paper over it.

### Where the SDK (or raw REST) would still be right

Nowhere today, and the rule for tomorrow: **if a command needs something `cf` cannot do,
it gets a `fetch` call for that one thing, not the SDK.** Node 22 has `fetch` built in,
so that costs no dependency and no abstraction to learn. The SDK earns its place only
when a caller needs typed models of dozens of endpoints and retry semantics we do not
want to write — which is a different product from this one.

The one thing to watch is that `cf` is a beta. The mitigation is not an SDK; it is a
version gate and a `--print` fallback, so an operator with an unexpected `cf` can still
see the exact commands and run them by hand.

### The one correction this forces

`worker/cloudflare.config.ts` says in a comment that *"`cf` cannot set a single secret
yet and cannot stream logs"*. The first half is now false: `cf workers secrets update`
exists and takes `--text`, so it is fully non-interactive. The second half mostly holds:
`cf logs query` reads Workers Logs after the fact, but there is no live tail, so
`wrangler tail` stays for that one job.

So the two-config split survives, but for one reason instead of two: **`wrangler` is kept
for `dev` and `tail`, not for secrets.** That comment needs correcting, and the deploy
sequence on the landing page can drop its `wrangler secret put` block.

## 2. Where the CLI is today

Measured, not assumed. The good news first: it is already past the bar that most CLIs
fail.

| Rule | Status | Evidence |
|---|---|---|
| stdout is data, stderr is diagnostics | **yes** | `out()` / `err()`, prompts via `readline` on `stderr` |
| Never hang waiting for input | **yes** | `confirm()` throws `confirmation_required` when `stdin` is not a TTY |
| `--json` on every command | **yes** | but see below |
| Colour respects `NO_COLOR` | **yes** | `isTTY && !NO_COLOR` |
| One envelope shape | **no** | `{ok, devices}`, `{ok, checks, summary}`, `{ok, command_id, state}` |
| Semantic exit codes | **no** | only 0, 1, 2 |
| Says what to do next | **partial** | `doctor` prints fixes; `send` does not |
| `--agent` | **no** | — |
| Idempotency on send | **no** | a retried `send` can double-text |
| Waits for the real outcome | **yes**, since slice 2a | `status` and `send --wait` follow the command to a terminal state |
| Discovery | **no** | `--help` is one screen per command |
| Provisioning | **no** | the operator runs `wrangler` by hand |

Two findings worth calling out:

- **`send` reports a race.** It reads `/v1/sms/commands/<id>` once, immediately after
  queueing, and prints whatever `state` it finds. On a healthy Worker that is usually
  `PENDING`; on a slow one it is `unknown`. Neither means anything to a caller.
- **JSON errors go to stdout.** That is the right call (one parseable document either
  way), and it should be written down as the contract rather than left as an accident:
  the exit code says pass or fail, the envelope says what and why.

## 3. The protocol

### 3.1 Streams and exit codes

`stdout` carries exactly one document: the result, or the error envelope. `stderr`
carries progress, warnings, prompts, and human diagnostics. Never the reverse.

| Code | Meaning | Retry? |
|---|---|---|
| 0 | success | — |
| 1 | a check or request failed | no |
| 2 | usage, missing config, missing local tool | no, fix the call |
| 3 | not found: device, command, message | no |
| 4 | permission: token rejected, role too low | no |
| 5 | conflict: already paired, already exists | no |
| 6 | precondition: device offline, migrations pending | after repair |
| 75 | temporary: timeout, 5xx, 429 | yes |

0, 1 and 2 keep their current meanings, so nothing that works today breaks.

This is a small-integer set on purpose, not `sysexits.h`. Codes 64 and up are
unmemorable at a prompt and nobody types them into a `case`; 75 is borrowed because
"temporary" is the one distinction that changes what a caller does, and it is the one
value worth being unusual for.

### 3.2 One envelope

Every command, human or agent, emits the same object. In TTY mode it is rendered; in
`--json` mode it is printed; in `--agent` mode it is printed compactly.

```json
{
  "schema_version": "1",
  "status": "accepted",
  "command": "send",
  "summary": "Queued cmd_01J9X to +8801540196080 on dev_pixel4a",
  "context": {
    "profile": "default",
    "worker_url": "https://dakflare-worker.example.workers.dev",
    "worker_version": "792a3652",
    "auth_mode": "new",
    "device_id": "dev_pixel4a"
  },
  "data": { "command_id": "cmd_01J9X", "to": "+8801540196080", "state": "PENDING", "encoding": "GSM-7" },
  "verification": {
    "passed": null,
    "state": "PENDING",
    "terminal": false,
    "reason": "awaiting_carrier",
    "next_command": "dakflare status cmd_01J9X --wait --timeout 30s --agent"
  },
  "warnings": []
}
```

`context` is not decoration. The most common agent failure is operating on the wrong
target, and echoing what was resolved turns that into a one-line diff instead of a
support ticket.

### 3.3 `--agent`

One flag, documented, that turns on the whole machine contract: no prompts, no colour,
no tables, compact JSON, bounded output, and a fail-fast `INPUT_REQUIRED` error listing
the flags that were missing. It is additive with auto-detection: `--agent` forces the
mode, `!isTTY`, `CI`, `TERM=dumb` and `NO_COLOR` each turn off the parts they can.

### 3.4 Errors are instructions

```json
{
  "schema_version": "1",
  "status": "error",
  "command": "send",
  "error": {
    "code": "DEVICE_OFFLINE_QUEUED",
    "category": "precondition",
    "message": "dev_pixel4a has not synced in 26h. The command is queued and an FCM wake was sent.",
    "retryable": false,
    "safe_to_retry": false,
    "remediation": [
      { "command": "dakflare status cmd_01J9X --agent", "description": "check the queue without sending again" },
      { "command": "dakflare doctor --agent", "description": "check handset reachability and the FCM token" }
    ]
  }
}
```

`retryable` says whether waiting could help. `safe_to_retry` says whether running the
same command again would cause a second effect. For an SMS those are different
questions, and conflating them is how an agent texts someone twice.

## 4. The output design system

The same three-layer token model the console uses, applied to text. Primitive values are
never referenced outside one paint function.

| Layer | Tokens | Used by |
|---|---|---|
| Primitive | `sgr.reset`, `sgr.bold`, `sgr.dim`, 24-bit and 256-colour fallbacks | `paint()` only |
| Semantic | `ok`, `warn`, `fail`, `skip`, `pending`, `terminal`, `ink`, `inkMuted`, `accent` | every command |
| Component | `doctor.line`, `table.cell`, `summary.line`, `next.command` | one renderer each |

The rule that makes it more than tidiness: **a semantic token resolves to an ANSI code in
TTY mode and to a string in JSON mode, and both come from the same table.** Today the
doctor prints `[PASS]` in green and the JSON says `"status": "pass"`; the mapping lives in
two places and will drift the first time one changes.

Colour resolves in order: `--agent` or `NO_COLOR` → none; `COLORTERM=truecolor` → the
console palette (`#1f6b45` ok, `#7a5310` warn, `#b23b20` fail, `#6b6153` muted); 256
colour → nearest of the same four; 16 colour → green/yellow/red/dim. The CLI then looks
like the product instead of like every other Node script.

## 5. The async truth model

This is the part that matters most, because DakFlare's `send` is not a request that
finishes. It is a command that travels:

```
PENDING → DISPATCHED → ACKED_BY_DEVICE → SENT → DELIVERED
   │           │                │           │
   └───────────┴→ EXPIRED       └───────────┴→ FAILED
```

`worker/src/durable-object.ts` already enforces this in SQL (`ALLOWED_PREDECESSORS`), so
the CLI should stop inventing its own vocabulary and read the states the Worker reports.

Four changes follow:

1. **`status <command-id>` is the missing verb.** Today `send` prints a `command_id` and
   nothing in the CLI can look it up again, so the id is write-only. The Worker already
   serves `GET /v1/sms/commands/<id>`.
2. **`verification.passed` is `true` only on `DELIVERED`.** `SENT` means the radio
   accepted it, which is exactly what the landing page's "Not claimed" block says. The
   CLI must not be the one place that overstates delivery.
3. **`--wait [duration]`** polls until a terminal state or the timeout. Progress is one
   line on stderr and only on a TTY, so stdout stays a single document; a JSONL event
   stream is deferred until something actually needs to watch a send in progress. This
   is the flag that makes `send` usable from CI without a hand-written loop.
4. **`--idempotency-key`** binds a caller-supplied key to the Durable Object, so a retry
   after a timeout returns the same `command_id` instead of a second SMS. Paired with
   `safe_to_retry: false`, it makes the dangerous case impossible rather than discouraged.

## 6. Discovery

An agent should never need the 1,844-line file in context. Four commands, each small:

| Command | Returns |
|---|---|
| `dakflare capabilities` | every command, one line, with `read_only` / `mutating` / `destructive` and its cost |
| `dakflare describe <cmd>` | purpose, one usage line, one example |
| `dakflare schema <cmd>` | JSON Schema for the flags and any `--input -` payload |
| `dakflare examples <cmd>` | two or three real invocations, including the failure one |

`capabilities` is the one that pays immediately: an agent can pick a command from twenty
lines instead of reading help for nine.

## 7. Provisioning: `dakflare up`

The only command that needs a Cloudflare credential, and it never holds one: it shells
out to `cf`, which owns auth.

```
dakflare up [--dry-run] [--print] [--yes] [--agent]
```

1. **Resolve** `cf` and its version. Absent → exit 2 with the install line, or print the
   raw command list with `--print` so the CLI is never the reason an install is blocked.
2. **Plan.** `cf deploy --dry-run` plus a resource check. Print what would be created.
3. **Apply.** Create D1 and KV if missing (converge, do not fail), write their ids into
   `cloudflare.config.ts` from the shipped template, apply migrations, then
   `cf deploy --secrets-file .dev.vars`.
4. **Verify.** Run the doctor checks against the new URL and return the envelope. Exit 0
   only if the deployment answers.

The prize here is step 3. `cloudflare.config.template.ts` already binds D1 **by name**
(`bindings.d1({ name: "sms_gateway" })`) and its own comment says `cf deploy` can
provision resources. If that holds, the two ids stop being something a human pastes, and
the checkpoint on the landing page ("paste the `database_id` and the KV `id` before step
02") becomes the CLI's job. That is the single most error-prone step in the install and
the one an agent will always get wrong.

**Spike before building:** confirm whether `cf deploy` creates the D1 database and the KV
namespace from a name binding. If it does, `up` is mostly `cf deploy` and the id
substitution is dead code we never write. If it does not, we call `cf d1 create` and
`cf kv namespaces create` first and substitute the returned ids.

## 8. Skills

The CLI teaches; the skills give the agent a starting point. Three, ~50 lines each, in
`skills/`, plus a pointer from `AGENTS.md`:

| Skill | Triggers on |
|---|---|
| `dakflare-provision` | a fresh install, a failing `doctor`, a missing secret |
| `dakflare-messaging` | sending with `--wait`, polling with `--limit`, reading receipts |
| `dakflare-flows` | authoring or validating a five-node flow graph |

Each states when to load it, the three commands that matter, and the one mistake to
avoid. That last part is what a generic man page cannot do.

## 9. Delivery

Four slices, each shippable and each worth its own commit.

| # | Slice | Done when |
|---|---|---|
| 1 | Envelope, exit codes, `--agent`, semantic tokens | every command emits `schema_version: 1`; `jq .status` works on success and failure; the TTY output is byte-identical to today except where a code changed |
| 2a | Truth, CLI half: `status`, `--wait`, `--until`, `verification` | **shipped** — proven live on EXPIRED, PENDING, timeout and unknown-id |
| 2b | Truth, server half: `--idempotency-key` in the Durable Object | a replayed `send` returns the same `command_id` instead of a second SMS |
| 3 | Discovery: `capabilities`, `describe`, `schema`, `examples` | `dakflare capabilities --agent` is under 40 lines and covers every command |
| 4 | Provisioning: `dakflare up` | a clean account goes from zero to a healthy doctor with one command and no pasted ids |

Slices 1 and 2 are the ones that change what is possible; 3 and 4 change how quickly
someone gets there. If only one ships, ship 2.

## 10. Not doing

- **An MCP server.** The CLI plus skills is the interface. A second surface means two
  contracts to keep in sync, and the agent already has a shell.
- **Wrapping the Cloudflare API.** `cf` is the escape hatch. If a command needs something
  `cf` cannot do, we add a `fetch` call for that one thing and say why in a comment.
- **A TUI.** `--wait` covers the one case where a human wants to watch.
- **Server-side pagination cursors** on `audit` in this pass. `--limit` and `--tail` are
  enough until someone has more than a few thousand rows, and a cursor is a contract we
  would have to keep.

## 11. Open questions

1. Does `cf deploy` provision D1 and KV from a name binding? (§7 — decides how much of
   `up` we write.)
2. Does `cf workers secrets update --text` take effect without a follow-up deploy, or is
   `--secrets-file` the only correct path? (Determines whether `up` is one deploy or two.)
3. Should `dakflare send` require `--wait` in `--agent` mode? An agent that gets
   `PENDING` and exits has not learned anything, but forcing a wait makes every CI call
   slow. Leaning: default `--wait 10s` in agent mode, explicit `--no-wait` to opt out.
