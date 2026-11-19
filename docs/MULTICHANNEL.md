# Multi-channel connectors

This note is for whoever works on the repository next. The reader-facing guide is
`apps/docs/content/docs/guides/multi-channel.mdx`; this file records what shipped and what it
assumes.

## What shipped

Four channels beside SMS — WhatsApp (Cloud API and Coexistence), Telegram (Bot API and Business
Bot), Facebook Messenger, and Instagram (Unified, Instagram, and Facebook login) — plus the
personal-account path from the paired Android handset.

- `worker/migrations/0018_channel_connectors.sql` adds `channel_connectors`, `contact_identities`,
  and `ingest_dead_letters`.
- `worker/src/routes/channel-connectors.ts` owns admin CRUD and the public webhook ingress.
- `sendConnectorOutbound` in the same file implements per-connector outbound (window, template, tag),
  but no route calls it yet; `/v1/channels/{channel}/send` still uses the env-credential plugins.
- `worker/src/channels/connection-do.ts` is one `ChannelConnection` Durable Object per
  `${channel}:${account_id}`.
- `worker/src/channels/ingest.ts` is the queue consumer and the only place a channel event becomes
  D1 rows.
- `worker/src/routes/edge-incoming.ts` receives the handset's personal-channel batches.
- `simulator/core/src/edge_channels.rs` chunks and uploads them; `MessagingNotificationBridge.kt`
  observes notifications and holds each `RemoteInput` reply handle.
- `test-support/channel-load-bench.mjs` is the burst and dedupe gate.

## Invariants

- **One Durable Object per external account.** The name is
  `env.CHANNEL_CONN.getByName(`${channel}:${account_id}`)`; there is no shared connection object.
  `channel` and `account_id` are immutable on a connector row for that reason.
- **`blockConcurrencyWhile` only in the constructor**, for local schema creation. Never across
  `fetch`, D1, KV, or Queue.
- **The Durable Object never writes D1.** Fresh events go through `INGEST_QUEUE`; the consumer does
  one `env.DB.batch` per delivery with `INSERT OR IGNORE`. Dedupe and the 24-hour window are local
  SQLite. Each statement stays under D1's 100-bound-parameter ceiling.
- **A failed ingest batch retries, then lands in `ingest_dead_letters`.** Nothing is acknowledged
  unless the write happened.
- **`read` is stored as `delivered`.** `messages.reply_state` has no `read`; read (and `played` /
  `seen`) are proof of delivery. Statuses the column cannot represent are skipped, not fatal.
- **Credentials are sealed with AES-256-GCM and never returned.** Responses expose `secret_set` and
  `secret_updated_at` only. `WEBHOOK_SECRET_KEY` rotation invalidates them like webhook secrets.
- **Every admin handler calls `assertHuman`** and additionally refuses a member session. An agent
  token or webhook turn cannot read or rotate a channel credential.
- **Coexistence is only `field: messages`.** `smb_message_echoes` and `history` are skipped by name,
  not stored. The legacy `/v1/channels/whatsapp/webhook` still works and shares the parser/sender.
- **The edge endpoint is bounded at 500 rows / 262,144 bytes per request.** A message too large for
  a batch of its own is left pending and reported in `EdgeFlushed.refused`; it is never truncated.
- **The benchmark passes only with 0 failed requests, 0 duplicate D1 rows, and p95 under 5 s.**

## Known gaps future work inherits

1. **`/v1/messages` cannot page across same-millisecond rows.** The cursor is `received_at < before`
   with `ORDER BY received_at DESC, id DESC`, so a page boundary that falls inside a group of rows
   sharing a millisecond skips the rest of that group. The benchmark works around it by refusing a
   workload that would put more than 200 events on one account and reading each device in one page.
   Fixing it needs a compound `(received_at, id)` cursor; do not paper over it in callers.
2. **Personal-channel replies are not wired.** `MessagingNotificationBridge.sendReply(channel,
   peerKey, text)` exists and dispatches through the official app's `RemoteInput`, but no Tauri
   command reaches it. The Android side is ready; the Rust command and its outbound queue are not.
