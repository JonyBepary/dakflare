/**
 * Inbound SMS batch — PROTOCOL_CONTRACT_V5 Rev C §1.3 (idempotency key is
 * `(device_id, local_id)`) and §8.
 * Port of master plan §5.4 (#17 hardening).
 *
 * Rev B defects fixed here:
 *   - `JSON.parse` sat outside any try/catch, so a malformed body threw a
 *     `SyntaxError` and the isolate answered 500 instead of `400 bad_request`.
 *   - `ack_command_ids.length` was read without an `Array.isArray` guard, so a
 *     JSON `null` or a string crashed the handler.
 *   - rows were inserted one `await` at a time in a loop and the loop could
 *     `return 400` mid-flight, leaving a partially committed batch (the first
 *     rows were already durable). Everything is now validated up front and
 *     written with ONE `env.DB.batch()`.
 *   - `received_at` was only checked for "parses", so year 9999 was accepted and
 *     poisoned the `received_at DESC` index that every admin read uses.
 */

import type { Env } from "../index";
import { err } from "../lib/errors";
import {
  MAX_ACK_IDS,
  MAX_BODY_CHARS,
  MAX_FCM_TOKEN_CHARS,
  MAX_ID_CHARS,
  MAX_INCOMING_MESSAGES,
  MAX_PEER_CHARS,
} from "../lib/config";

/** §17: accept `received_at` inside [now - 30 days, now + 1 day]. */
const RECEIVED_AT_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const RECEIVED_AT_FUTURE_MS = 24 * 60 * 60 * 1000;

interface ValidatedMessage {
  id: string;
  localId: string;
  peer: string;
  body: string;
  receivedAt: number;
  autoReply: number;
}

export async function handleIncomingBatch(
  _req: Request,
  env: Env,
  deviceId: string,
  rawBody: string
): Promise<Response> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    return err("bad_request", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return err("bad_request", 400);
  }
  const data = payload as Record<string, unknown>;

  const messages = data.messages ?? [];
  if (!Array.isArray(messages)) return err("bad_request", 400);
  // Unbounded arrays are unbounded D1 statements, DO work and billable rows.
  if (messages.length > MAX_INCOMING_MESSAGES) return err("bad_request", 400);

  const ackCommandIds: string[] = [];
  if (data.ack_command_ids !== undefined) {
    if (!Array.isArray(data.ack_command_ids)) return err("bad_request", 400);
    if (data.ack_command_ids.length > MAX_ACK_IDS) return err("bad_request", 400);
    for (const id of data.ack_command_ids) {
      if (typeof id === "string" && id !== "") ackCommandIds.push(id);
    }
  }

  const fcmToken =
    typeof data.fcm_token === "string" &&
    data.fcm_token !== "" &&
    data.fcm_token.length <= MAX_FCM_TOKEN_CHARS
      ? data.fcm_token
      : null;

  // ---- validate every row before writing anything (all-or-nothing) --------
  const now = Date.now();
  const validated: ValidatedMessage[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") return err("bad_request", 400);
    const row = entry as Record<string, unknown>;

    const localId = row.local_id;
    if (typeof localId !== "string" || localId === "") return err("bad_request", 400);
    if (localId.length > MAX_ID_CHARS) return err("bad_request", 400);

    const body = row.body;
    if (typeof body !== "string") return err("bad_request", 400);
    if (body.length > MAX_BODY_CHARS) return err("bad_request", 400);

    const sender = typeof row.sender_e164 === "string" && row.sender_e164 !== ""
      ? row.sender_e164
      : row.sender;
    if (typeof sender !== "string" || sender === "") return err("bad_request", 400);
    if (sender.length > MAX_PEER_CHARS) return err("bad_request", 400);

    const receivedAtRaw = row.received_at;
    if (typeof receivedAtRaw !== "string" && typeof receivedAtRaw !== "number") {
      return err("bad_request", 400);
    }
    const receivedAt = typeof receivedAtRaw === "number" ? receivedAtRaw : Date.parse(receivedAtRaw);
    if (!Number.isFinite(receivedAt)) return err("bad_request", 400);
    if (receivedAt < now - RECEIVED_AT_PAST_MS || receivedAt > now + RECEIVED_AT_FUTURE_MS) {
      return err("bad_request", 400);
    }

    validated.push({
      id: crypto.randomUUID(),
      localId,
      peer: sender,
      body,
      receivedAt,
      autoReply: row.auto_reply_sent || row.auto_reply ? 1 : 0,
    });
  }

  // ---- single transactional write ----------------------------------------
  let accepted = 0;
  let duplicates = 0;
  if (validated.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, auto_reply)
       VALUES (?, ?, ?, 'in', ?, ?, ?, ?)
       ON CONFLICT(device_id, local_id) DO NOTHING`
    );
    const results = await env.DB.batch(
      validated.map((m) =>
        stmt.bind(m.id, deviceId, m.localId, m.peer, m.body, m.receivedAt, m.autoReply)
      )
    );
    for (const result of results) {
      // `meta.changes` is 0 when `ON CONFLICT DO NOTHING` skipped the row.
      if ((result.meta?.changes ?? 0) > 0) accepted++;
      else duplicates++;
    }
  }

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  if (ackCommandIds.length > 0 || fcmToken) {
    await stub.fetch("https://do/__http_ack", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceId },
      body: JSON.stringify({ ack_command_ids: ackCommandIds, fcm_token: fcmToken }),
    });
  }

  const commands = await readPending(stub);
  return Response.json({ accepted, duplicates, commands });
}

/**
 * `GET /v1/messages?device_id=&limit=&before=` (admin, brief #19).
 * Newest first, both directions, strictly bounded.
 */
export async function handleMessagesList(env: Env, requestUrl: URL): Promise<Response> {
  const deviceId = requestUrl.searchParams.get("device_id");
  if (!deviceId) return err("bad_request", 400);

  const limit = clampLimit(requestUrl.searchParams.get("limit"));
  const beforeRaw = requestUrl.searchParams.get("before");
  const before =
    beforeRaw === null || beforeRaw.trim() === "" ? Number.MAX_SAFE_INTEGER : Number(beforeRaw);
  if (!Number.isFinite(before)) return err("bad_request", 400);

  const rows = await env.DB.prepare(
    `SELECT id, device_id, local_id, direction, peer, body, received_at, auto_reply
       FROM messages
      WHERE device_id = ? AND received_at < ?
      ORDER BY received_at DESC, id DESC
      LIMIT ?`
  )
    .bind(deviceId, before, limit)
    .all();

  return Response.json({ messages: rows.results ?? [], limit });
}

/** Default 50, hard maximum 200. */
function clampLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 50;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(200, Math.max(1, Math.trunc(parsed)));
}

/** Shared by the poll and incoming routes: one DO round-trip for the queue. */
export async function readPending(stub: DurableObjectStub): Promise<unknown[]> {
  const res = await stub.fetch("https://do/__pending", { method: "GET" });
  if (!res.ok) return [];
  const pending = (await res.json().catch(() => [])) as unknown;
  return Array.isArray(pending) ? pending : [];
}
