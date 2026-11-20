# Scheduled sends and pacing

A send can be queued for a time instead of being handed to the radio immediately. The
queue is D1 and the clock is one Durable Object. That split is deliberate: a cancellation
must be one conditional `UPDATE` in D1, not a message that happens to be inside an object's
alarm and can no longer be reached.

## The two stores

| Store | Owns |
|---|---|
| D1 `scheduled_messages` | the row, the status, the cancellation authority, the idempotency key |
| `Scheduler` Durable Object (`scheduler`) | the alarm, one token bucket per `pacing_key`, the minimum gap between submissions |

The object never holds a message body. Every alarm reads the earliest `status = 'scheduled'`
row from D1, so an eviction loses only pacing counters, and a cancel is visible immediately.

`POST /v1/scheduled` writes the row and then wakes the object. A wake failure is a `503`
`scheduler_unavailable`: the row is durable, and the five-minute cron reconciler will pick it
up. The caller may retry with the same `idempotency_key`.

## Create

The handler validates, in this order:

1. **Target.** `channel = sms` is a `device` target and must be a registered, unrevoked
   handset. Any other channel is a `connector` target; the connector must exist on that
   channel, be enabled, and be `worker_do`. An `edge_device` connector is refused: its
   credential lives on the phone, so the Worker cannot send for it.
2. **Peer.** `normalisePeer` cleans and bounds the address. SMS requires `+` and 8-15 digits.
3. **Body and template.** The body is non-empty and bounded. A `template_id` is resolved
   against `message_templates`; a WhatsApp send uses the template's `wa_template_name` and
   maps its variables to positional body parameters.
4. **Timezone.** The request's zone, else the audience row's zone, else `UTC`. The zone is
   resolved through `nextAllowedInstant` before anything is written; a bad IANA name is
   `400 bad_timezone`, never a silent UTC fallback.
5. **Policy.** A `pacing_policies` row for the target, overlaid with any request policy. The
   effective values are snapshotted into `policy_json`, so editing a policy later does not
   rewrite messages already queued.

The first `send_at` is shifted out of quiet hours at creation, and checked again at dispatch.

## Dispatch and the claim

The object arms one alarm at the earliest due row. On each firing it:

1. recovers claims older than the five-minute dispatch lease (SMS is requeued, because the
   command key makes the enqueue idempotent; a connector becomes `unknown`, because the
   platform may have accepted it);
2. checks the campaign deadline when one was supplied (`skipped_window`), the audience `opt_out` flag
   (`skipped_opt_out`), and quiet hours (update `send_at`, keep `scheduled`, consume no token
   and no attempt);
3. takes a token from the bucket for `pacing_key`, and checks the minimum gap;
4. **claims before the side effect**:
   `UPDATE ... SET status = 'dispatching' ... WHERE id = ? AND status = 'scheduled' RETURNING *`;
5. dispatches through the existing Worker path: `enqueueOutboundCommand` for SMS,
   `sendConnectorOutbound` for a platform;
6. fences the result with the claim token: `sent` when the transport accepted, `failed`,
   `skipped_window` or `skipped_opt_out` otherwise.

At most one send leaves per alarm. The next alarm is `min(next due row, now + the row's
8-15 s jitter)`, which is what turns the gap into real spacing. Carrier safety is a
submission property, not a radio guarantee: a backlog of ordinary commands can still burst
through the handset.

**Cancellation wins until the claim, and is refused after it.** `DELETE /v1/scheduled/:id`
is one conditional update from `scheduled` to `cancelled`. If it changes zero rows, the answer
is `409 not_cancellable` with the current status, not a success that pretends otherwise.

**At-most-once for cloud channels.** A crash after the platform accepted but before the
finalize leaves the row `dispatching`; recovery marks it `unknown`, an operator decision.
SMS can be recovered safely because the command id is the row's UUID and the idempotency key
is `sched:<id>`; a replay returns the existing command instead of a second SMS.

## Status and delivery

`scheduled → dispatching → sent` is the transport path. `sent` means the handset was queued
or the platform accepted the message; it is **not** delivery. `delivered` is reserved for a
platform receipt and is not written by the Scheduler today: the console's `messages` table
still carries the per-message delivery state. A scheduled row therefore stops at `sent`
unless a later mirror is added. `skipped_window`, `skipped_opt_out`, `failed` and `unknown`
are terminal and explained in `last_error`.

## Pacing policy

`pacing_policies` is one row per target (`device` or `connector`). The console and
`PUT /v1/admin/pacing/:targetType/:targetId` edit it; the route snapshots it at insert.

| Field | Meaning |
|---|---|
| `min_interval_ms` | the lower bound between submissions; the Scheduler adds an 8-15 s deterministic jitter per row for SMS |
| `jitter_pct` | the policy's jitter percentage; the token bucket and the SMS gap both bound it |
| `max_per_hour` | the bucket capacity, refilled at capacity/3600 per second |
| `quiet_start_hour` / `quiet_end_hour` | the recipient's local window; equal hours disable it |
| `timezone` | IANA zone; quiet hours are evaluated on its wall clock, DST-safe |

Defaults: SMS `10 s / 25% / 40 per hour / 21:00-08:00`; cloud `100 ms / 10% / 3600 per hour /
no quiet window`.

## Audience

`contacts` is an audience list, not the conversation identity graph. One row per
(channel, peer), with `attrs_json`, `tags_json`, `timezone` and `opt_out`. CSV import accepts
RFC-4180 with quoted commas, escaped quotes, CRLF and a BOM; it upserts in 50-row
`env.DB.batch()` chunks. An opted-out row is skipped at dispatch, not dropped at create, so
the preview can count it.

## Failure modes accepted

- A cancel that arrives in the milliseconds between the claim and the platform call returns
  `409` and the message goes out. The two stores cannot share a transaction.
- A STOP that arrives at the same instant as a send may lose; the check is immediately before
  the call, not atomic with it.
- A lost Scheduler wake delays messages up to five minutes, until the reconciler cron. A
  growing `scheduled` backlog is the signal to alert on.
- The token bucket resets if the object's storage is lost. It is a safety limit, not a billing
  ledger.
