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
 *
 * Hardening added since:
 *   - A batch reserves its row count against the device's daily D1 write budget
 *     (`/__reserve` on the device's Durable Object) BEFORE writing, so one device
 *     cannot exhaust the deployment's shared write allowance.
 *   - A thrown `env.DB.batch()` answers 503 `storage_unavailable` instead of letting
 *     an uncaught rejection surface as a 500. The rows were not written, and the
 *     `(device_id, local_id)` key makes the device's retry safe.
 */

import type { Env } from "../index";
import { err } from "../lib/errors";
import { RE_DEVICE_ID } from "../auth/canonical";
import { dispatchFlows, type AcceptedMessage } from "../flow/dispatch";
import { RE_WORKFLOW_ID } from "../lib/workflow";
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

/** Upper bound on device-reported flow runs per batch (500 messages max anyway). */
const MAX_FLOW_RUN_REPORTS = 1_000;

interface ReportedRun {
  localId: string;
  flowId: string;
  flowVersion: number;
  outcome: string;
}

interface ValidatedMessage {
  id: string;
  localId: string;
  peer: string;
  body: string;
  receivedAt: number;
  autoReply: number;
  /** "in" (default) or "out" for a message the DEVICE sent itself. */
  direction: "in" | "out";
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

  // M4: runs the DEVICE already performed for these messages. Recorded so the
  // Worker fallback can skip them; the device is the primary engine.
  const reportedRuns: ReportedRun[] = [];
  if (data.flow_runs !== undefined) {
    if (!Array.isArray(data.flow_runs)) return err("bad_request", 400);
    if (data.flow_runs.length > MAX_FLOW_RUN_REPORTS) return err("bad_request", 400);
    for (const entry of data.flow_runs) {
      if (!entry || typeof entry !== "object") return err("bad_request", 400);
      const row = entry as Record<string, unknown>;
      const localId = row.local_id;
      const flowId = row.flow_id;
      const flowVersion = row.flow_version;
      const outcome = row.outcome;
      if (typeof localId !== "string" || localId === "" || localId.length > MAX_ID_CHARS) {
        return err("bad_request", 400);
      }
      if (typeof flowId !== "string" || !RE_WORKFLOW_ID.test(flowId)) return err("bad_request", 400);
      if (
        typeof flowVersion !== "number" ||
        !Number.isInteger(flowVersion) ||
        flowVersion < 1
      ) {
        return err("bad_request", 400);
      }
      if (typeof outcome !== "string" || outcome === "" || outcome.length > 32) {
        return err("bad_request", 400);
      }
      reportedRuns.push({
        localId,
        flowId,
        flowVersion,
        outcome,
      });
    }
  }

  // ---- validate every row before writing anything (all-or-nothing) --------
  const now = Date.now();
  const validated: ValidatedMessage[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") return err("bad_request", 400);
    const row = entry as Record<string, unknown>;

    const localId = row.local_id;
    if (typeof localId !== "string" || localId === "") return err("bad_request", 400);
    if (localId.length > MAX_ID_CHARS) return err("bad_request", 400);

    // M4 mirroring: a device that sent an SMS locally reports it in the same
    // batch so the operator's log is complete. Absent means inbound, which keeps
    // older clients working unchanged.
    const rawDirection = row.direction;
    const direction = rawDirection === undefined ? "in" : rawDirection;
    if (direction !== "in" && direction !== "out") return err("bad_request", 400);

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
      direction,
    });
  }

  // ---- single transactional write ----------------------------------------
  // The Durable Object is resolved once here: it owns this device's daily write
  // budget and also serves the ack/pending tail of the request.
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));

  let accepted = 0;
  let duplicates = 0;
  if (validated.length > 0) {
    // Daily row budget, checked BEFORE the write. D1's write allowance is shared by
    // every device in the deployment, so a single looping device must not be able
    // to spend it all. A refusal is final for today: the rows are not written and
    // the device is told why, rather than silently losing (or endlessly retrying)
    // a batch it can never get in.
    let reservation: Response;
    try {
      reservation = await stub.fetch("https://do/__reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: validated.length }),
      });
    } catch (error) {
      console.error(`[incoming] write-budget reservation failed: ${String(error)}`);
      return err("storage_unavailable", 503);
    }
    if (reservation.status === 429) return err("daily_quota_exceeded", 429);
    if (!reservation.ok) {
      // An unverifiable budget is not a reason to spend it.
      console.error(`[incoming] write-budget reservation returned HTTP ${reservation.status}`);
      return err("storage_unavailable", 503);
    }

    const stmt = env.DB.prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, auto_reply)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, local_id) DO NOTHING`
    );
    let results: D1Result[];
    try {
      results = await env.DB.batch(
        validated.map((m) =>
          stmt.bind(
            m.id,
            deviceId,
            m.localId,
            m.direction,
            m.peer,
            m.body,
            m.receivedAt,
            m.autoReply
          )
        )
      );
    } catch (error) {
      // A thrown batch is a storage fault, not a client error. 503 tells the device
      // to retry, and `(device_id, local_id)` makes that retry idempotent — unlike
      // a 500, which reads as "your request was broken" and loses the batch.
      console.error(`[incoming] D1 batch failed for ${deviceId}: ${String(error)}`);
      return err("storage_unavailable", 503);
    }
    const acceptedMessages: AcceptedMessage[] = [];
    for (let i = 0; i < results.length; i++) {
      // `meta.changes` is 0 when `ON CONFLICT DO NOTHING` skipped the row.
      if ((results[i].meta?.changes ?? 0) > 0) {
        accepted++;
        const row = validated[i];
        // Outbound mirror rows are history, not triggers.
        if (row.direction === "in") {
          acceptedMessages.push({
            localId: row.localId,
            sender: row.peer,
            body: row.body,
            receivedAt: row.receivedAt,
          });
        }
      } else {
        duplicates++;
      }
    }

    // Persist the device's own runs, but only for rows this batch actually
    // inserted: a replayed batch must not inflate the run log with duplicates.
    if (reportedRuns.length > 0 && acceptedMessages.length > 0) {
      const acceptedIds = new Set(acceptedMessages.map((m) => m.localId));
      const rows = reportedRuns.filter((run) => acceptedIds.has(run.localId));
      if (rows.length > 0) {
        const now = Date.now();
        const stmt = env.DB.prepare(
          `INSERT INTO flow_runs (device_id, local_id, flow_id, flow_version, outcome, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id, local_id, flow_id, flow_version) DO NOTHING`
        );
        try {
          await env.DB.batch(
            rows.map((run) =>
              stmt.bind(deviceId, run.localId, run.flowId, run.flowVersion, run.outcome, now)
            )
          );
        } catch (error) {
          // Recording is best-effort: the messages are already durable, and the
          // worst case is the fallback running a flow the device also ran.
          console.error(`[flow] could not record device runs: ${String(error)}`);
        }
      }
    }

    // Flow fallback, only for rows that were actually inserted. A retried batch
    // is all duplicates, so it cannot send a second reply. A failure here must
    // not fail the upload: the messages are already durable.
    if (acceptedMessages.length > 0) {
      try {
        const enqueued = await dispatchFlows(env, deviceId, acceptedMessages);
        if (enqueued > 0) console.log(`[flow] enqueued ${enqueued} command(s) for ${deviceId}`);
      } catch (error) {
        console.error(`[flow] dispatch failed for ${deviceId}: ${String(error)}`);
      }
    }
  }

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
 * `DELETE /v1/messages?device_id=` — admin-only purge for one device.
 *
 * Exists for two reasons: test/simulator cleanup must not leave SMS bodies and
 * phone numbers in the production log for the whole retention window, and an
 * operator needs a real erasure path for a device they are decommissioning.
 * Scoped by `device_id` on purpose — there is no "delete everything".
 */
export async function handleMessagesPurge(env: Env, requestUrl: URL): Promise<Response> {
  const deviceId = requestUrl.searchParams.get("device_id");
  if (!deviceId) return err("bad_request", 400);
  if (!RE_DEVICE_ID.test(deviceId)) return err("bad_request", 400);

  // Flow-run records describe messages, so they must not outlive them.
  const [messages, runs] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM messages WHERE device_id = ?`).bind(deviceId),
    env.DB.prepare(`DELETE FROM flow_runs WHERE device_id = ?`).bind(deviceId),
  ]);

  return Response.json({
    ok: true,
    deleted: Number(messages.meta?.changes ?? 0),
    flow_runs_deleted: Number(runs.meta?.changes ?? 0),
  });
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
