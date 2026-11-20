---
name: dakflare-messaging
description: "Send an SMS through a DakFlare deployment, follow it to the radio, and read what happened. Use when a task needs to send a text, check whether one was delivered, read inbound messages, or retry a send safely. Triggers: send sms, text message, delivery status, did it arrive, retry the send, idempotency key, inbound messages."
---

# DakFlare: sending and checking a message

A DakFlare deployment is one Android handset plus a Worker. `dakflare send` queues a
command in the phone's Durable Object; the phone's gateway collects it, hands it to the
radio, and reports the outcome back. That round trip takes about three seconds when the
socket is up, and up to five minutes when the phone has fallen back to polling.

## Read this first

```bash
dakflare capabilities --agent          # every command, its effect, its flags
dakflare schema send --agent           # the flag contract as data
dakflare schema states --agent         # state machines and transitions
```

## Sending

```bash
dakflare send --to +8801540196080 --body "deploy ack"
```

By default this **waits up to 10 seconds** and exits from the outcome, not from the
request:

| exit | meaning |
|---|---|
| 0 | the radio accepted it (`SENT`, or `DELIVERED` if you asked for it) |
| 1 | `FAILED` or `EXPIRED` |
| 75 | still in flight when the budget ran out — **not** a failure |

`--no-wait` returns as soon as the deployment has it (exit 0 means "queued").

## Retrying safely

A retried send can text someone twice. If you might retry, pass a key:

```bash
dakflare send --to +8801540196080 --body "otp 849201" --idempotency-key "order-4411-otp"
```

The same key returns the **same `command_id`** with `replayed: true` instead of sending
again, and sets `safe_to_retry: true` in the `network` error envelope if the HTTP post
itself times out before a `command_id` comes back. Without a key, a `--wait` poll
timeout exits `75` with `data.timed_out: true` and `data.command_id` (check with
`status`, never send again), while a network timeout before queueing returns an error
envelope with `safe_to_retry: false`.

## Checking

```bash
dakflare status <command-id> --wait 60s --agent
```

`verification.passed` is `true` only on `DELIVERED`. `SENT` means the radio accepted the
message, which is **not** a claim that it arrived — no carrier report is guaranteed. Do
not tell a user "delivered" on the strength of `SENT`.

## Scheduling and templates

A send can be queued instead of handed to the radio now:

```bash
dakflare schedule create --target <device_id> --to +8801540196080 \
  --body "reminder" --at 2026-11-20T18:30:00+06:00
dakflare schedule list --status scheduled --agent
dakflare schedule cancel <scheduled_id> --yes
```

`--channel` defaults to `sms` (a device target); any other channel is a connector id.
The Scheduler applies the target's quiet hours and hourly cap, so the row may move later
than `--at`; it is not lost. `cancel` succeeds only while the row is still `scheduled`.
After the claim it answers `409 not_cancellable`, which means the message is already on
its way.

Templates render `{{name | fallback}}`; `contacts import` reads RFC-4180 CSV:

```bash
dakflare templates create --name order_ready --body "Hi {{1}}, order {{2}} is ready." --channel whatsapp
dakflare contacts import audience.csv
```

In the queue, `sent` means the transport accepted the message, not that the handset
delivered it. Delivery is reported on the message row, not the scheduled row.

## The one mistake to avoid

Treating exit 75 as a failure and re-running `send`. It means the command is still
queued. Check it with `status`; the id is in the envelope you already have.
