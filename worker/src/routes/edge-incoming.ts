/**
 * `POST /v1/edge/incoming/batch` — the Android edge app's inbound batch.
 *
 * This is the handset equivalent of a Meta webhook: the phone is the radio and reports
 * messages it received while the Worker was not in the loop. It reuses the existing device
 * authentication verbatim (`verifyDeviceSignature`, §3.2 of the protocol contract and the
 * same canonical string every other device route signs) rather than inventing a second
 * scheme — a second scheme would be a second place for the replay guard to be forgotten.
 *
 * Once authenticated, each row is normalised into the same `NormalizedChannelEvent` a
 * WhatsApp/Messenger/Instagram webhook produces and handed to
 * `CHANNEL_CONN.getByName(`${channel}:${device_id}`)`. Dedupe and the 24-hour window are
 * therefore per device-channel, exactly like every other connector, instead of a second
 * ledger maintained here.
 *
 * Bounds are applied before anything is parsed row-by-row:
 *
 *   - the body is read through `MAX_BODY_BYTES` (256 KiB) inside the auth step, so an
 *     oversized upload never reaches `JSON.parse` — this handler answers `413` naming the
 *     byte limit;
 *   - at most 500 rows are accepted, matching `MAX_INCOMING_MESSAGES` on the SMS path.
 *
 * Idempotency is `local_id`: the DO's `seen_events` ledger turns a replay into
 * `deduplicated`, and the D1 `INSERT OR IGNORE` in `channels/ingest.ts` is the second line
 * of defence. Sending the same `local_id` twice is one message.
 */

import type { Env } from "../index";
import { verifyDeviceSignature } from "../auth/ecdsa";
import { err } from "../lib/errors";
import {
  MAX_BODY_BYTES,
  MAX_BODY_CHARS,
  MAX_ID_CHARS,
  MAX_INCOMING_MESSAGES,
  MAX_PEER_CHARS,
} from "../lib/config";
import type { NormalizedChannelEvent } from "../channels/connection-do";

/** Contract value; named locally so the endpoint documents its own ceiling. */
export const MAX_EDGE_MESSAGES = MAX_INCOMING_MESSAGES;

/**
 * A channel name becomes part of a Durable Object name, so it must be a stable slug. The
 * built-in connectors all match; anything else is a client bug, not a new medium.
 */
const RE_CHANNEL = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * `received_at` acceptance window, matching `routes/incoming.ts`: a phone that was switched
 * off for months still hands over real messages, but epoch 0 or year 9999 must not poison
 * the `received_at DESC` index every admin read uses.
 */
/**
 * Per-field ceilings for a personal-channel row. The batch budget (262 KiB) is what actually
 * bounds a request; these only keep one field from swallowing it whole. 32 KiB is comfortably
 * more than any messaging app's text limit and far under the batch ceiling.
 */
const MAX_EDGE_PEER_CHARS = 256;
const MAX_EDGE_BODY_CHARS = 32 * 1024;

const RECEIVED_AT_PAST_MS = 180 * 24 * 60 * 60 * 1000;
const RECEIVED_AT_FUTURE_MS = 24 * 60 * 60 * 1000;

interface EdgeRow {
  channel: string;
  localId: string;
  sender: string;
  body: string;
  receivedAt: number;
}

interface EdgePayload {
  device_id?: unknown;
  messages?: unknown;
}

export async function handleEdgeIncomingBatch(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Every gate has to pass before this handler is allowed to defer anything, and there is
  // nothing safe to defer here: the 202 promises the events reached the Durable Object.
  void ctx;

  // --- authentication (§3.2, shared with every device route) ---------------
  const auth = await verifyDeviceSignature(req, env);
  if (!auth.ok) {
    // The auth step is also the byte-cap enforcer. Re-shape only that one refusal so the
    // client is told the number it exceeded; every authentication code keeps its shape.
    if (auth.response.status === 413) {
      return Response.json(
        { error: "payload_too_large", limit_bytes: MAX_BODY_BYTES },
        { status: 413 }
      );
    }
    return auth.response;
  }
  const deviceId = auth.deviceId;

  // --- parse --------------------------------------------------------------
  let payload: EdgePayload;
  try {
    payload = JSON.parse(auth.body || "{}") as EdgePayload;
  } catch {
    return err("bad_request", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return err("bad_request", 400);
  }

  // The signature already proved which device this is. A body naming a different device is
  // either a client bug or an attempt to write into another handset's log; refuse it.
  if (payload.device_id !== undefined && payload.device_id !== deviceId) {
    return err("bad_request", 400);
  }

  const rawMessages = payload.messages ?? [];
  if (!Array.isArray(rawMessages)) return err("bad_request", 400);
  if (rawMessages.length > MAX_EDGE_MESSAGES) return err("bad_request", 400);

  // --- validate every row before enqueuing anything ------------------------
  const now = Date.now();
  const rows: EdgeRow[] = [];
  for (const entry of rawMessages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return err("bad_request", 400);
    }
    const row = entry as Record<string, unknown>;

    const channel = row.channel;
    if (typeof channel !== "string" || !RE_CHANNEL.test(channel)) return err("bad_request", 400);

    const localId = row.local_id;
    if (typeof localId !== "string" || localId === "" || localId.length > MAX_ID_CHARS) {
      return err("bad_request", 400);
    }

    // A personal-message peer is a display name or a handle, not an E.164 number the SMS path
    // can bound at 32 characters; the batch's 262 KiB budget is the real ceiling. The generous
    // per-field caps here only stop a single absurd string from occupying the whole budget.
    const sender = row.sender;
    if (typeof sender !== "string" || sender === "" || sender.length > MAX_EDGE_PEER_CHARS) {
      return err("bad_request", 400);
    }

    // An empty body is legitimate (a media message with no caption), a non-string is not. A
    // WhatsApp text is not an SMS: 4 KiB was the SMS column's limit, and applying it here both
    // truncated the client (which no longer clamps) and rejected long messages outright.
    const body = row.body;
    if (typeof body !== "string" || body.length > MAX_EDGE_BODY_CHARS) return err("bad_request", 400);

    const receivedRaw = row.received_at;
    if (typeof receivedRaw !== "string" && typeof receivedRaw !== "number") {
      return err("bad_request", 400);
    }
    const receivedAt =
      typeof receivedRaw === "number" ? receivedRaw : Date.parse(receivedRaw);
    if (!Number.isFinite(receivedAt)) return err("bad_request", 400);
    if (
      receivedAt < now - RECEIVED_AT_PAST_MS ||
      receivedAt > now + RECEIVED_AT_FUTURE_MS
    ) {
      return err("bad_request", 400);
    }

    rows.push({ channel, localId, sender, body, receivedAt });
  }

  if (rows.length === 0) {
    return Response.json({ accepted: 0, deduplicated: 0 }, { status: 202 });
  }

  // --- enqueue per device-channel -----------------------------------------
  // Grouping by channel keeps one DO call per medium in the batch, so a phone reporting
  // SMS and WhatsApp in one upload does not produce one round-trip per row.
  const byChannel = new Map<string, NormalizedChannelEvent[]>();
  for (const row of rows) {
    const event: NormalizedChannelEvent = {
      connectorId: `${row.channel}:${deviceId}`,
      channel: row.channel,
      accountId: deviceId,
      eventKind: "inbound_message",
      eventId: row.localId,
      peerId: row.sender,
      body: row.body,
      timestamp: row.receivedAt,
    };
    const bucket = byChannel.get(row.channel);
    if (bucket === undefined) byChannel.set(row.channel, [event]);
    else bucket.push(event);
  }

  let accepted = 0;
  let deduplicated = 0;
  try {
    for (const [channel, events] of byChannel) {
      const stub = env.CHANNEL_CONN.getByName(`${channel}:${deviceId}`);
      const result = await stub.ingestEvents(events);
      accepted += result.accepted;
      deduplicated += result.deduplicated;
    }
  } catch (error) {
    // The events did not reach dedupe/window storage, so they were not accepted. A 503
    // tells the phone to retry; `local_id` makes that retry safe.
    console.error(`[edge-incoming] ingest failed for ${deviceId}: ${String(error)}`);
    return err("storage_unavailable", 503);
  }

  return Response.json({ accepted, deduplicated }, { status: 202 });
}
