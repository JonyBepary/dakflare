/**
 * `INGEST_QUEUE` consumer — the only place a channel event becomes D1 rows.
 *
 * The Durable Object (`channels/connection-do.ts`) already deduplicated and advanced the
 * 24-hour window in colocated SQLite before it enqueued anything. This consumer therefore
 * does three things and no more:
 *
 *   1. one `env.DB.batch([...])` per delivery — D1 counts a batch as one query, and writes
 *      cost far more than reads, so 50 events must not be 50 round-trips;
 *   2. `INSERT OR IGNORE` for the message, which is the second line of defence against a
 *      replayed batch (`UNIQUE(device_id, local_id)` does the work);
 *   3. a conversation upsert on the existing `UNIQUE(channel, account_id, peer_id)`.
 *
 * Two defects in the scaffold this replaces:
 *
 *   - It wrote a platform `read` receipt straight into `messages.reply_state`, whose CHECK
 *     constraint is `queued|sent|failed|delivered`. `read` is not a member. This module maps
 *     `read` (and `played`/`seen`) to `delivered`: a read receipt is proof of delivery, and
 *     dropping it would leave a genuinely delivered message looking merely `sent` forever.
 *     Any status the table cannot represent is SKIPPED rather than written, so a future
 *     platform status can never fail the whole batch.
 *   - It acked the batch unconditionally, so a failed D1 write vanished. Success acks;
 *     a thrown batch retries every message until `max_retries` (3) exhausts into
 *     `dakflare-ingest-dlq`. Nothing is swallowed.
 *
 * The status update is guarded by the same predecessor rule the handset path enforces
 * (`routes/incoming.ts`): `reply_state` only moves forward, and `delivered` / `failed` are
 * terminal. A late or duplicated receipt cannot resurrect or regress a settled row.
 */

import type { Env } from "../index";
import type { NormalizedChannelEvent } from "./connection-do";
import { whatsappMessageIdFromEventId } from "./whatsapp-cloud";
import { mirrorScheduledStatus } from "../lib/scheduled";

/** D1's documented ceiling: 100 bound parameters in a single statement. */
export const MAX_BOUND_PARAMS = 100;

/** The four states `messages.reply_state` is allowed to hold. */
export const REPLY_STATES = ["queued", "sent", "failed", "delivered"] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

/**
 * Map a platform status onto the column's vocabulary, or `null` when there is no honest
 * representation.
 *
 * `read` is the case the scaffold got wrong. Messenger/Instagram send `read`, WhatsApp
 * sends `read`/`played`; all of them arrived, so they are stored as `delivered`.
 */
export function normalizeReplyState(status: string): ReplyState | null {
  switch (status.trim().toLowerCase()) {
    case "queued":
    case "pending":
    case "accepted":
    case "sending":
      return "queued";
    case "sent":
      return "sent";
    case "delivered":
    case "read":
    case "played":
    case "seen":
      return "delivered";
    case "failed":
    case "error":
    case "undelivered":
    case "rejected":
    case "bounced":
      return "failed";
    default:
      return null;
  }
}

/** The D1 `device_id` channel rows are filed under, matching the connector's own writers. */
export function channelDeviceId(channel: string, accountId: string): string {
  return `channel:${channel}:${accountId}`;
}

/** Conversation id; also the primary key shape used by the rest of the channel code. */
function conversationId(channel: string, accountId: string, peerId: string): string {
  return `${channel}:${accountId}:${peerId}`;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Consume one delivery. Returns the number of rows D1 reports as changed, so the caller can
 * log coalescing (50 events in, 50 message rows + N conversation updates out).
 *
 * Throws only what `env.DB.batch()` throws, after retrying every message: a queue consumer
 * must never acknowledge a write that did not happen.
 */
export async function consumeIngestBatch(
  batch: MessageBatch<NormalizedChannelEvent>,
  env: Env
): Promise<number> {
  if (batch.messages.length === 0) {
    batch.ackAll();
    return 0;
  }

  // Prepared once per delivery; only the bindings differ. Each is far below the 100-param
  // ceiling — 8, 8 and 6 respectively — so 50 events produce 100 small statements, not 100
  // wide ones.
  const conversationStmt = env.DB.prepare(
    `INSERT INTO conversations
       (id, channel, account_id, peer_id, session_state, window_expires_at,
        last_inbound_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'WINDOW_OPEN', ?, ?, ?, ?)
     ON CONFLICT(channel, account_id, peer_id) DO UPDATE SET
       session_state     = 'WINDOW_OPEN',
       -- A replayed or out-of-order event must not shrink an open window or move
       -- last_inbound_at backwards.
       window_expires_at = MAX(COALESCE(conversations.window_expires_at, 0),
                               excluded.window_expires_at),
       last_inbound_at   = MAX(COALESCE(conversations.last_inbound_at, 0),
                               excluded.last_inbound_at),
       updated_at        = excluded.updated_at
     -- Replayed event: both timestamps are already at least as new, so the row is
     -- left untouched and D1 reports zero changes instead of a phantom write.
     WHERE excluded.window_expires_at > COALESCE(conversations.window_expires_at, 0)
        OR excluded.last_inbound_at   > COALESCE(conversations.last_inbound_at, 0)`
  );

  const messageStmt = env.DB.prepare(
    `INSERT OR IGNORE INTO messages
       (id, device_id, local_id, direction, peer, body, received_at, channel, conversation_id)
     VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?)`
  );

  const statusStmt = env.DB.prepare(
    `UPDATE messages
        SET reply_state = ?
      WHERE channel = ? AND device_id = ? AND local_id = ? AND direction = 'out'
        AND (
          reply_state IS NULL
          OR (reply_state = 'queued' AND ? IN ('sent', 'delivered', 'failed'))
          OR (reply_state = 'sent'   AND ? IN ('delivered', 'failed'))
        )`
  );

  const statements: D1PreparedStatement[] = [];
  const now = Date.now();

  for (const msg of batch.messages) {
    const event = msg.body;

    if (event.eventKind === "inbound_message") {
      const accountId = event.accountId || "default";
      const convId = conversationId(event.channel, accountId, event.peerId);
      const deviceId = channelDeviceId(event.channel, accountId);

      // A peer-less event cannot own a conversation row (`peer_id` is NOT NULL and a
      // conversation keyed on '' would merge every anonymous sender). The message is
      // still worth keeping, so only the upsert is skipped.
      if (event.peerId !== "") {
        statements.push(
          conversationStmt.bind(
            convId,
            event.channel,
            accountId,
            event.peerId,
            event.timestamp + TWENTY_FOUR_HOURS_MS,
            event.timestamp,
            now,
            now
          )
        );
      }

      statements.push(
        messageStmt.bind(
          crypto.randomUUID(),
          deviceId,
          event.eventId,
          event.peerId,
          event.body ?? "",
          event.timestamp,
          event.channel,
          convId
        )
      );
      continue;
    }

    if (event.eventKind === "status_update" && typeof event.status === "string") {
      const state = normalizeReplyState(event.status);
      // No honest representation: skip rather than write an illegal value or fail the batch.
      if (state === null) continue;

      const accountId = event.accountId || "default";
      // A WhatsApp receipt is keyed `<wamid>:<status>` in the DO so two real
      // receipts for one message are not collapsed as replays. The message row
      // is still keyed by the bare wamid.
      const localId =
        event.channel === "whatsapp"
          ? whatsappMessageIdFromEventId(event.eventId)
          : event.eventId;
      statements.push(
        statusStmt.bind(
          state,
          event.channel,
          channelDeviceId(event.channel, accountId),
          localId,
          state,
          state
        )
      );

      // The same receipt advances the scheduled row that produced this message.
      // `localId` is the platform message id the Scheduler stored as
      // `dispatch_ref`; `read`/`played`/`seen` already folded to `delivered`
      // above. `queued` is not a scheduled outcome, so it only touches the
      // per-message record.
      if (state !== "queued") {
        statements.push(
          mirrorScheduledStatus(env.DB, event.channel, localId, state, now, event.errorCode)
        );
      }
    }
  }

  if (statements.length === 0) {
    batch.ackAll();
    return 0;
  }

  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    // The writes did NOT happen. Retry every message; after `max_retries` the queue moves
    // them to `dakflare-ingest-dlq`, where `consumeIngestDeadLetter` keeps them.
    console.error(
      `[ingest] D1 batch failed (${statements.length} statement(s)): ${String(error)}`
    );
    for (const msg of batch.messages) msg.retry();
    return 0;
  }

  let written = 0;
  for (const result of results) {
    written += Number(result.meta?.changes ?? 0);
  }

  batch.ackAll();
  return written;
}

/**
 * Terminal landing place for a batch that exhausted its retries.
 *
 * One batch, then ack. If this write also fails the messages are retried (the DLQ consumer
 * has `max_retries = 1`); a dead-letter row that silently disappeared would be the one
 * failure this product cannot make, because a lost inbound message is indistinguishable
 * from a customer who was ignored.
 */
export async function consumeIngestDeadLetter(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  if (batch.messages.length === 0) {
    batch.ackAll();
    return;
  }

  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO ingest_dead_letters (id, queue, body_json, attempts, failed_at)
     VALUES (?, ?, ?, ?, ?)`
  );

  const failedAt = Date.now();
  const statements = batch.messages.map((msg) =>
    stmt.bind(
      crypto.randomUUID(),
      batch.queue,
      safeJson(msg.body),
      typeof msg.attempts === "number" ? msg.attempts : 0,
      failedAt
    )
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error(
      `[ingest] dead-letter write failed (${statements.length} row(s)): ${String(error)}`
    );
    for (const msg of batch.messages) msg.retry();
    return;
  }

  batch.ackAll();
}

/** `JSON.stringify` that never throws and never returns `undefined`. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}
