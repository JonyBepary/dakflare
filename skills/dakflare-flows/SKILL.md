---
name: dakflare-flows
description: Author, validate or debug a DakFlare flow: the five-node graph (Trigger, Extract, Condition, Send SMS, Stop) that answers inbound SMS on the handset. Use when a rule needs writing or changing, when an auto-reply did not fire, or when a graph fails validation. Triggers: auto reply, sms rule, flow graph, trigger extract condition, why did the reply not send, workflow json.
---

# DakFlare: flows

A flow is a directed graph of exactly five node types, edited in the console and compiled
to the handset. It runs on the phone, with the screen off, without the Worker — that is
why an auto-reply survives a dropped connection.

## The five nodes

| Node | Does |
|---|---|
| `trigger` | receives the inbound SMS. A flow has **exactly one**, and it is the entry |
| `extract` | pulls a pattern (a regex, an OTP, an order id) out of the body or the sender |
| `condition` | tests the extracted value; branches `true` and `false` |
| `send_sms` | hands a reply to the radio. `to` accepts `{{sender}}`, `body` accepts `{{body}}` and extracted names |
| `stop` | halts the flow. The branch that does not match ends here |

## The shape

```json
{
  "nodes": [
    { "id": "n_trigger", "type": "trigger", "data": { "kind": "incoming", "body": { "mode": "keyword", "value": "DAKFLARE-GATE-1" } } },
    { "id": "n_send",    "type": "send_sms", "data": { "to": "{{sender}}", "body": "DakFlare gate ok." } },
    { "id": "n_stop",    "type": "stop", "data": {} }
  ],
  "edges": [ { "source": "n_trigger", "target": "n_send" } ]
}
```

## Validation, before it runs

The graph is checked before it is saved, and the same rule runs on the phone:

- exactly one trigger, and it is the only entry
- no loops, and every node reachable from the trigger
- every `send_sms` reachable through a `condition` branch, or it can never fire

## Debugging a reply that did not fire

1. `dakflare doctor --agent` — is the phone paired, awake and holding the default-SMS role?
2. `dakflare audit --tail 10 --json` — did the message arrive, and did a run start?
3. `dakflare status <command-id>` — if a reply was queued, did the radio take it?

A message that matched nothing is not an error: the run is logged either way, and the
`stop` branch is a real outcome.

## The one mistake to avoid

Adding a second `send_sms` on the `false` branch to "cover both cases". A non-matching
message is supposed to stop; a flow that always replies turns every inbound message into
an echo, including the carrier's own notifications.
