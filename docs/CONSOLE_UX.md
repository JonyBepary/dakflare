# DakFlare console — UX decisions

Status: adopted 2026-10-22. Supersedes the implicit model in the dashboard as built.
Wire behaviour this implies is normative in `PROTOCOL_CONTRACT_V5.md` §11.11–§11.12.

---

## 1. Decision: one pipeline, two authored forms, one reply per message

The console shipped two automation surfaces (Rules, Workflows) that both claimed to match
inbound SMS, with no stated relationship. Only one of them ran. That is the defect; the fix
is not a prettier Rules page.

**Adopted model**

| | Rules | Workflows |
|---|---|---|
| Job | One reply, with rate limits | Multi-step: extract, branch, reply |
| Runs | In the Worker, as the batch syncs | On the phone first (§11.9), Worker fallback |
| Latency | One sync interval | Immediate on the device |
| Offline | Needs the gateway | Works with the gateway unreachable |
| Authoring | Form | Canvas |

**Pipeline, enforced in the Worker:** for each newly accepted inbound message where the
device did not already reply (`auto_reply_sent` false), evaluate Rules by `priority DESC`.
The first rule that matches and is inside its cooldown and hourly cap replies; evaluation
stops. If a rule replied, flows are skipped for that message. If no rule replied, the flow
pipeline runs unchanged (§11.9). A device that replied itself suppresses both.

Consequences, stated in the UI rather than discovered:

- A message is answered at most once by automation.
- Rules are an online feature; workflows are device-primary. The console says so.
- `reply_source` / `reply_ref` on the message row make "what answered this?" answerable.

**Rejected alternatives.** Retiring Rules would delete rate limiting, which flows do not have.
Retiring Workflows would delete the only device-primary path. Implementing a third, device-side
rule engine duplicates the flow interpreter. The two-form pipeline is the smallest model that
keeps every capability and can be explained in one sentence.

---

## 2. Device state vocabulary

`ws_connected` alone cannot describe a phone. The console uses five words, and `IDLE` is
retired. Computed from `ws_connected`, `last_seen` (authenticated contact, §11.12), and
whether a push token exists (wake capability).

| State | Condition | Operator reading |
|---|---|---|
| `live` | Socket connected | Reachable now |
| `synced` | No socket, `last_seen` ≤ 15 min | Reachable on its next poll |
| `stale` | `last_seen` ≤ 24 h | May be asleep or backgrounded |
| `offline` | `last_seen` > 24 h, or never | Not answering; act |
| `unknown` | No `last_seen` recorded | Never synced since pairing |

Wake capability is a separate chip: `push` (FCM token present) or `poll-only`.
"Offline + poll-only" is the state that must raise an alert; "synced + poll-only" is normal.

---

## 3. Failure is a first-class state

The operator's first job is knowing the gateway stopped answering. The console therefore has:

- an **open-alert banner** on every console page, backed by `GET /v1/admin/alerts`;
- an alert row written when `offline_alert` fires (the Worker previously only logged to the
  console, which nobody reads), armed by *any* authenticated contact so poll-only devices
  are covered — not only by a WebSocket connect;
- an **acknowledge** action, so a known outage stops shouting without hiding the history;
- an optional `ALERT_WEBHOOK_URL` for out-of-band delivery.

An alert is a fact about a device, not a deployment health metric. `All systems nominal`
describes the deployment only and is never allowed to imply the fleet is reachable.

---

## 4. Information architecture

Nav: Overview · Devices · Messages · **Automation**.

Automation contains two tabs, `Rules` and `Workflows`, and a permanent one-paragraph
statement of the pipeline above. Neither tab is presented as the default: the difference is
latency/offline, not difficulty. Cross-links: a rule's test panel links to workflows; a
workflow's simulation panel links to rules.

Devices are named. `label` is captured at pairing (app) or minting (console), persisted in
D1, and shown wherever a device id appears. An id is secondary, monospaced, copyable.

---

## 5. Metrics that define "working"

These are the numbers the console may claim. Anything else is decoration.

| Metric | Definition | Why |
|---|---|---|
| Fleet availability | devices `live` or `synced` / paired devices | The gateway's actual uptime |
| Detection latency | `offline_alert` raised_at − last_seen | How long a dead phone stays invisible |
| Reply coverage | inbound rows with `auto_reply=1` / inbound rows | Whether automation is doing its job |
| Reply latency | reply command `SENT` − inbound `received_at` | The number recipients feel |
| Delivery rate | `DELIVERED` / (`SENT` + `DELIVERED`) | Carrier truth, not our optimism |
| Silent failures | acknowledged alerts with no reconnect before ack | The failure mode we must not have |

The first three are computable from data already stored. Delivery rate needs real carrier
receipts (Wave 2) and must not be shown until then.

---

## 6. State coverage the console must not skip

- **Pairing:** mint → *waiting for the phone* (poll) → *paired as X* / *expired*. Never a code
  that sits there after it has been spent.
- **Log:** live while the tab is visible, paused when hidden, with a visible "new" marker.
- **Send:** queued → acked → sent → delivered, with the failure reason at the stage it failed.
- **Empty:** explain the consequence, not the absence ("inbound SMS is stored but never
  answered automatically").
- **Unknown:** when a value was never reported (label, SIM), say so; never invent a default.

---

## 7. Out of scope here

Roles/RBAC (single-operator deployment), multi-tenant isolation, RCS. Mobile console is
triaged, not redesigned: readable, no horizontal scroll, canvas editing explicitly deferred
to desktop.
