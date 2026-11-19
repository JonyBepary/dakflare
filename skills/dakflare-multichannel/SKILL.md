---
name: dakflare-multichannel
description: "Run a DakFlare deployment beyond SMS: register a per-account WhatsApp, Telegram, Messenger, Instagram, or personal-session connector, point the platform webhook at it, and read what happened. Use when a channel message did not arrive, a connector credential must be created or rotated, a webhook fails verification, or an inbound batch needs explaining. Triggers: add whatsapp, connect telegram, messenger webhook, instagram login, channel connector, edge incoming batch, read receipt, coexistence, personal channel reply."
---

# DakFlare: channels beside SMS

An SMS goes out through the handset radio. A channel message goes out through one external account:
a WhatsApp number, a Telegram bot, a Messenger Page, or an Instagram professional account. Each one is
a **connector** row, and each connector is addressed by its own Durable Object. Nothing about adding a
channel changes the SMS path.

## Pick the tier first

| Tier | Use it for | Where the work happens |
|---|---|---|
| `worker_do` | Official APIs | Cloudflare Worker + one `ChannelConnection` Durable Object per account |
| `edge_device` | Personal sessions on the paired phone | Android `NotificationListenerService` + `RemoteInput`, uploaded to `/v1/edge/incoming/batch` |

A personal session is observed, not logged in. The phone reads the notification stream of the
official app and keeps its reply action; it needs the user's notification-access grant. Do not expect
a personal connector to send a cold message to someone who has never messaged that account.

## Register a connector

Connectors are managed through the admin HTTP surface; the CLI does not have a connector command.
Send an operator session or `ADMIN_TOKEN` with `X-Dakflare-Client: cli`. A `dkf_agt_` token is
refused, and a member session is refused: credentials are owners-and-admins work.

```http
POST /v1/admin/connectors
{
  "channel": "whatsapp",
  "account_id": "123456789012345",
  "label": "Support line",
  "execution_tier": "worker_do",
  "auth_mode": "cloud_api",
  "secret": {
    "appSecret": "...",
    "verifyToken": "...",
    "accessToken": "..."
  }
}
```

- `channel` is one of `sms`, `whatsapp`, `telegram`, `messenger`, `instagram`. Webhook ingress is
  implemented for everything except `sms`; SMS still uses the device protocol.
- `account_id` is the platform's own identity: a phone number id, bot id, Page id, Instagram user id,
  or the paired `device_id` for a personal connector. It is immutable after creation because it
  selects the Durable Object.
- `auth_mode` depends on the channel. WhatsApp accepts `cloud_api` or `coexistence`; Telegram accepts
  `bot_api` or `business_bot`; Instagram accepts `unified_login`, `instagram_login`, or
  `facebook_login`. It is stored, never inferred from a token: the wrong mode sends a valid token to
  the wrong host and reads as an auth failure.
- `secret` is required and must contain the fields that platform needs (`appSecret`, `verifyToken`,
  `accessToken`; Messenger may use `pageAccessToken`; Telegram `botToken` and `secretToken`). It is
  sealed with AES-256-GCM and never returned. A response says only `secret_set` and
  `secret_updated_at`.

`GET /v1/admin/connectors` lists them. `PATCH /v1/admin/connectors/{id}` changes the label, tier,
auth mode, `enabled`, or rotates `secret`. `DELETE` removes the row and destroys the account's
Durable Object, which also stops its storage billing.

## Point the platform at the webhook

```
https://<worker>/v1/channels/<channel>/<connector_id>/webhook
```

`GET` is Meta's verification handshake for WhatsApp, Messenger, and Instagram; `POST` is delivery.
Telegram uses `POST` with `X-Telegram-Bot-Api-Secret-Token`. The platform's signature over the raw
body is the credential — there is no operator token on this path.

- `200` means the Durable Object accepted or deduplicated the events. D1 has not been written yet;
  the queue does that.
- `401` is a bad signature. Check that `appSecret` or `secretToken` matches the app that owns the
  webhook, not merely the account.
- `403` means the connector is disabled. `PATCH` with `"enabled": true`.
- `404` means no connector resolves for that channel and id, or the channel is `sms`.
- `413` means the body exceeded 256 KiB.

Meta retries for 36 hours, so a non-2xx must mean the payload is genuinely unusable, not merely
uninteresting. A delivery with nothing this product understands is still `200`.

WhatsApp Coexistence sends `smb_message_echoes` and `history` beside `messages`. They are skipped by
name: an echo would show the operator their own reply as an inbound customer message. Only
`field: messages` is stored. This is coexistence support, not history import.

The legacy `/v1/channels/whatsapp/webhook` still works from deployment-wide env variables, and uses
the same parser and sender as the connector route.

## Read the outcome honestly

- `SENT` is not delivery, and a webhook `200` is not delivery either. `messages.reply_state` moves
  forward only.
- `read` is folded to `delivered`. `messages.reply_state` is `queued | sent | failed | delivered`
  and has no `read`; a read receipt proves delivery.
- A WhatsApp receipt is keyed `<wamid>:<status>` internally so `sent` and `delivered` are both kept.
  Reading the row still uses the bare `wamid`.
- Messenger and Instagram outside the 24-hour window fail `window_expired`. Messenger may use the
  `HUMAN_AGENT` tag; WhatsApp requires a template. Telegram Bot API has no 24-hour window.

## Personal channels from the phone

`POST /v1/edge/incoming/batch` is P-256 device-authenticated. The body is
`{ device_id, messages: [{ channel, local_id, sender, body, received_at }] }`, at most 500 rows and
262,144 bytes. Channels are `whatsapp_personal`, `telegram_personal`, `messenger_personal`, and
`instagram_personal`. `local_id` is `notif:<package>:<id>:<postTime>`, so a re-post is one message.
The reply is `202 {accepted, deduplicated}`; `503` means retry, and the `local_id` makes the retry
safe.

A message too large for a batch of its own is left pending and reported in `EdgeFlushed.refused` with
its byte size. It is never truncated. Tell the operator which message is stuck rather than dropping
it.

**Known gap:** `MessagingNotificationBridge.sendReply` exists, but no Tauri command reaches it. A
personal channel can ingest but not yet reply from the console.

## If you are changing this code

- One Durable Object per `${channel}:${account_id}`. Never route two accounts into one object.
- `blockConcurrencyWhile` only in the constructor. Never across network or storage calls.
- Deduplicate in DO SQLite first; then `INGEST_QUEUE` → one `env.DB.batch` per delivery with
  `INSERT OR IGNORE`, each statement under 100 bound parameters.
- A failed batch retries and then lands in `ingest_dead_letters`. Never acknowledge a write that did
  not happen.
- Verify before you claim it works:
  `node test-support/channel-load-bench.mjs` must report 0 failed requests, 0 duplicate rows, and
  p95 under 5,000 ms.
