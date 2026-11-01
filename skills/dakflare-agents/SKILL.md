---
name: dakflare-agents
description: Give an AI agent a bounded, time-boxed way to operate a DakFlare deployment: mint an agent token, approve a request, read the grant table, connect over MCP, and trace what an id became. Use when an agent needs to send SMS, when a send is refused for lack of a grant, when a token must be revoked, or when an approval round needs completing. Triggers: agent token, approval request, authority grant, dakflare mcp, agent quota, paused_hitl_approval, trace an id, revoke a token.
---

# DakFlare: letting an agent act

An agent is not an operator. It is an LLM with a prompt, and a prompt can be talked
into a loop that spends real money on real SMS. So it gets its own credential, and
that credential cannot act alone: a **scope** says what it may attempt, and a
**time-boxed grant** says what it may actually do, for how long, over which
recipients.

## One token

```
dakflare auth mint-agent-token --name "night shift" --scope messages:read,sms:send
```

The value is printed once and never stored: only a SHA-256 digest of the secret is
kept, so a lost token is replaced, never recovered. Give it to the agent and to
nothing else.

Scopes: `messages:read`, `devices:read`, `flows:read`, `audit:read`, `sms:send`,
`messages:purge`, `alerts:write`, `flows:write`, `devices:write`, `rules:write`,
`webhooks:write`, plus the ones that always need a grant (`sms:send:production`,
`enable_shortcode`, `dlq_bulk_replay`, `flow_deploy_prod`).

There is no scope for revoking a device or resetting an account. Those are absent on
purpose: no token can hold them and no grant can add them.

## What a send looks like

The first call does not send. It creates an approval request and returns `202` with
`sent: false`, the scope, the target, the eight-rung ladder and the scope's ceiling.

```
dakflare send --to +8801540196080 --body "order ready" --no-wait --agent
```

Exit `6` with `error.code: approval_required`. Nothing was sent, and repeating the
call returns the same request rather than queueing another.

A human answers, picking a duration from 1m, 5m, 15m, 30m, 1h, 1d, 7d, 30d:

```
dakflare auth approvals
dakflare auth approve <request-id> --for 15m
dakflare auth reject <request-id>
```

Then the same send succeeds. The grant is capped per scope whatever was asked for:
production SMS one hour and it must name its recipients, shortcode and DLQ 15
minutes, a production deploy or a rule write one day, reads 30 days. A request that
is clamped says so: `requested_s 2592000, granted_s 3600, clamped true`.

```
dakflare auth grants --live
dakflare auth grants revoke <grant-id> --yes
```

Revoking takes effect on the very next request, on a token or on a grant.

## The token's own budget

Each token has a fixed hourly SMS budget, 20 by default. The 21st send in the hour
is `429 agent_quota_exceeded` and exit `6`, with `resets_at`. It is a separate limit
from the grant on purpose: a grant bounds authority, the budget bounds volume, and a
runaway loop trips the second even while a human work is asleep.

## Over MCP

```
dakflare mcp serve --token-file ~/.dakflare-agent-token
```

Stdio JSON-RPC in, the Worker's `/v1/mcp` out. Point a client at it:

```json
{ "mcpServers": { "dakflare": {
    "command": "dakflare", "args": ["mcp", "serve", "--token-file", "/path/token"] } } }
```

`tools/list` is the permission surface: a tool the token's scopes do not cover is
not registered at all, so an out-of-scope call is method-not-found rather than a
refusal that advertises what the caller cannot use. Seven tools, each wrapping the
route of the same name: `list_devices`, `read_messages`, `command_status`,
`list_flows`, `get_flow`, `trace`, `send_sms`.

`send_sms` uses the protocol's multi-round-trip flow. With no grant it returns
`input_required` naming the approval request; take it to a human, and retry with
`inputResponses`. The retry re-reads the grant store, so nothing the client says in
`inputResponses` can widen a permission.

Authorization here is a static bearer, not OAuth: a conformant OAuth client cannot
negotiate it. That is documented rather than pretended away.

## When something did not go out

```
dakflare trace <id>
```

One word, then why. The id may be a message, a command or an approval request.

| verdict | what to do |
|---|---|
| `paused_hitl_approval` | a human must approve: `dakflare auth approvals` |
| `suppressed_cooldown` | a rule matched and its cooldown held it; wait or shorten it |
| `suppressed_hourly_cap` | the rule's hourly cap is spent; raise it if the volume is real |
| `no_match` | nothing matched; check the rule or the flow's extract |
| `queued` | the radio has not accepted it yet; check with `command_status` |
| `failed` | the reply command died; the trace names the phone's reason |
| `replied` | the radio accepted it. `SENT` is not delivery: see `command_status` |

## Revoke

```
dakflare auth agent-tokens
dakflare auth revoke-agent-token <token-id> --yes
```

A revoked token is `401` on its next request. `last_used_at` tells you whether it was
ever used, which is the question you actually have when a token is missing.

## The rules an agent should not need told

- `--agent` prints one compact JSON document, never prompts, never colours. Pass
  `--yes` on anything that asks.
- Exit codes are semantic: `0` ok, `1` failed, `2` usage, `3` not found, `4`
  permission, `5` conflict, `6` precondition, `75` temporary.
- `75` means in flight, not failed. Check with `status`, never by sending again.
- Pass `--idempotency-key` when a retry is possible: the same key returns the same
  command instead of a second SMS.
