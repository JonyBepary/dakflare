---
name: dakflare-flows
description: Author, validate, debug or heal a DakFlare flow: the nine-node graph (Trigger, Extract, Set var, Condition, Switch, Delay, Webhook, Send SMS, Stop) that answers inbound SMS. Use when a reply did not fire, a graph fails validation, an extraction stopped matching, or a flow needs writing or changing. Triggers: auto reply, sms rule, flow graph, extract pattern, switch branch, why did the reply not send, workflow json, flows apply, flows heal, extraction drift.
---

# DakFlare: flows

A flow is a directed graph that runs on the handset with the screen off, and in the
Worker's WASM fallback when the phone is unreachable. The same graph, the same
engine: `simulator/flow`, compiled to `worker/src/wasm/flow.wasm`.

## The nine nodes

| type | data | outgoing edges |
|---|---|---|
| `trigger` | `{ kind: "incoming", sender?, body? }` | 1 |
| `extract` | `{ source: "body"\|"sender", pattern, flags? }` | 1 |
| `set_var` | `{ name, value }` | 1 |
| `condition` | `{ left, op, right? }` | 2: `true`, `false` |
| `switch` | `{ value, cases: string[] }` | one per case plus `default` |
| `delay` | `{ seconds }`, 1 to 300 | 1 |
| `webhook` | `{ url, body }`, https only | 1 |
| `send_sms` | `{ to, body }` | 1 |
| `stop` | `{ reason? }` | 0 |

An `extract` pattern must declare at least one named group: `(?<order>[A-Z0-9]{6})`.
The group becomes a variable. `set_var` binds one explicitly. Templates use
`{{name}}`, and `{{vars.name}}` is the same thing.

`delay` and `webhook` are actions the caller performs, in graph order. The handset
runs flows synchronously and makes no outbound calls, so it skips both and logs
that it did; a flow using one runs partially on the phone and completely in the
Worker.

## The two refusals that matter

**A cycle.** Refused with the edge and the node it returns to.

**A variable that is not bound on every path.** The validator intersects the
variables guaranteed by every incoming edge, so `{{amount}}` on a branch that never
extracts it is refused at save time rather than rendered as an empty string at 3am.
If you need it on both branches, extract it before the branch or set it with
`set_var`.

## Write a flow

The file is `{ id, name, graph, device_id?, enabled?, expected_previous_version? }`,
or a bare `{ nodes, edges }` if you pass `--id`. No coordinates are needed: the
Worker ranks every node by its longest distance from the trigger and lays it out.

```
dakflare flows apply flow.json --dry-run
dakflare flows apply flow.json
```

`--dry-run` returns `data.dry_run_diff`: nodes and edges added, removed or changed,
capture variables gained and lost, whether the layout would move. It writes nothing.

```
{
  "id": "wf_orders",
  "name": "Order confirmation",
  "graph": {
    "nodes": [
      { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
      { "id": "x1", "type": "extract",
        "data": { "source": "body", "pattern": "order (?<order>[A-Z0-9]{6})" } },
      { "id": "s1", "type": "send_sms",
        "data": { "to": "{{sender}}", "body": "Order {{order}} confirmed." } },
      { "id": "e1", "type": "stop", "data": {} }
    ],
    "edges": [
      { "id": "a", "source": "t1", "target": "x1" },
      { "id": "b", "source": "x1", "target": "s1" },
      { "id": "c", "source": "s1", "target": "e1" }
    ]
  }
}
```

Exit codes: `0` applied, `2` the graph is invalid (every issue is printed with its
path, e.g. `nodes[2].data.pattern: must declare at least one named group`), `5` a
`version_conflict` naming the stored version.

## When a reply did not fire

Work backwards, and let `trace` do the joining.

1. `dakflare trace <message-id>` says what happened in one word: `replied`,
   `queued`, `failed`, `suppressed_cooldown`, `suppressed_hourly_cap`, `no_match`
   or `paused_hitl_approval`, plus the reason.
2. `no_match` with a flow listed as `filtered` means the trigger filter or an
   `extract` did not match. Check the pattern against the real body.
3. `dakflare rules test --peer <sender> --body <text>` evaluates every rule and
   says why each would or would not reply.

## Extraction drift

An `extract` whose pattern stops matching is silent: the message was accepted and
the flow stopped at a step that said nothing. Two misses in an hour raise an
`extraction_drift` alert naming the flow and the capture group.

Heal it from new examples, and let the gate decide:

```
dakflare extract synthesize --samples new-template.json --group order
dakflare flows heal wf_orders --samples new-template.json --dry-run
dakflare flows heal wf_orders --samples new-template.json
```

The heal re-checks the real history: for every inbound body the OLD pattern
matched, the NEW one must capture the same value byte for byte. One difference and
nothing is written, the offenders are printed, and the exit code is `6`. That is
deliberate: a pattern that fixes today's template and changes what yesterday's
messages extract is worse than the drift.

## Rules, which are not flows

A rule is the short form: matcher, body matcher, reply template, cooldown, hourly
cap. It compiles to a graph, and rules run before flows.

```
dakflare rules apply rules.json --dry-run
dakflare rules apply rules.json
```

`apply` reports create, update or unchanged per rule. A rule with an empty reply
template matches without replying.

## Limits

200 nodes, 400 edges. Body 4,096 characters. Delay 300 seconds. At most 8 switch
cases. Names and ids are `[A-Za-z0-9_-]{1,64}`.
