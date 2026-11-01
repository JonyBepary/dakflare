/**
 * Inbound SMS batch — PROTOCOL_CONTRACT_V5 Rev C §1.3 (idempotency key is
 * `(device_id, local_id)`) and §8.
 * Port of master plan §5.4 (#17 hardening).
 *
 * Rev B defects fixed here:
 *   - `JSON.parse` sat outside any try/catch, so a malformed body threw a
 *     `SyntaxError` and the isolate answered 500 instead of `400 bad_request`.
 *   - the ack list's length was read without an `Array.isArray` guard, so a
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
import { enqueueOutboundCommand } from "../lib/commands";
import {
  evaluateRules,
  type RuleHit,
  type RuleRecord,
} from "../lib/rule-graph";
import { RE_WORKFLOW_ID } from "../lib/workflow";
import { parseAcks } from "../lib/acks";
import {
  MAX_BODY_CHARS,
  MAX_FCM_TOKEN_CHARS,
  MAX_ID_CHARS,
  MAX_INCOMING_MESSAGES,
  MAX_PEER_CHARS,
} from "../lib/config";

/** §17: accept `received_at` inside [now - 30 days, now + 1 day]. */
// A gateway that was switched off for months still has real messages to hand
// over. The guard is for nonsense (epoch 0, a typo), not for an old phone.
const RECEIVED_AT_PAST_MS = 180 * 24 * 60 * 60 * 1000;
const RECEIVED_AT_FUTURE_MS = 24 * 60 * 60 * 1000;

/** Upper bound on device-reported flow runs per batch (500 messages max anyway). */
const MAX_FLOW_RUN_REPORTS = 1_000;

/**
 * `reply_error` is operator-facing prose. The contract caps it at 200 characters
 * so one device cannot put a paragraph in every console row.
 */
const MAX_REPLY_ERROR_CHARS = 200;

/** Every state a device may report for an outbound SMS (contract §11.10). */
const REPLY_STATES = ["queued", "sent", "failed", "delivered"] as const;
type ReplyState = (typeof REPLY_STATES)[number];

function isReplyState(value: unknown): value is ReplyState {
  return typeof value === "string" && (REPLY_STATES as readonly string[]).includes(value);
}

/**
 * Read the optional `state`/`error` pair from an outbound entry.
 *
 * `null` means "the client did not report it"; an unknown state or a non-string
 * error is a client contract violation and must fail the batch, never be
 * silently dropped — a reply whose state was discarded is exactly the
 * unanswered-looking row this endpoint exists to prevent.
 */
function readReplyState(
  row: Record<string, unknown>
): { state: ReplyState | null; error: string | null } | null {
  let state: ReplyState | null = null;
  if (row.state !== undefined && row.state !== null) {
    if (!isReplyState(row.state)) return null;
    state = row.state;
  }

  let error: string | null = null;
  if (row.error !== undefined && row.error !== null) {
    if (typeof row.error !== "string") return null;
    error = row.error.slice(0, MAX_REPLY_ERROR_CHARS);
  }

  return { state, error };
}

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
  /** Null for inbound rows and for clients that predate state reporting. */
  replyState: ReplyState | null;
  /** Only meaningful with `replyState === "failed"`; capped at 200 chars. */
  replyError: string | null;
}

/** A newly inserted inbound row, after D1 has confirmed the insert. */
interface AcceptedInbound extends AcceptedMessage {
  id: string;
  autoReply: number;
}

/** Rules reply through the ordinary command queue; 24 h is the flow fallback's TTL. */
const RULE_COMMAND_TTL_MS = 86_400_000;

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

  // §11.10 outbound history may travel as `outbound[]` (the frozen console
  // contract) or, for older clients, as `messages[]` entries with
  // `direction: "out"`. Both are validated identically below.
  const outbound = data.outbound ?? [];
  if (!Array.isArray(outbound)) return err("bad_request", 400);
  if (messages.length + outbound.length > MAX_INCOMING_MESSAGES) return err("bad_request", 400);

  // Rev E: acks are `{command_id, claim_token}` objects. A body still carrying
  // the retired v5.2.1 key is refused, not ignored: silence would leave the
  // phone believing it acknowledged while the lease churns underneath it.
  if (data.ack_command_ids !== undefined) return err("bad_request", 400);
  const acks = parseAcks(data.acks);
  if (acks === null) return err("bad_request", 400);

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

    // Per-message state only describes an outbound send. On an inbound row it
    // is a client bug, and storing it would make the console claim a received
    // message had a delivery state.
    let replyState: ReplyState | null = null;
    let replyError: string | null = null;
    if (direction === "out") {
      const parsed = readReplyState(row);
      if (parsed === null) return err("bad_request", 400);
      replyState = parsed.state;
      replyError = parsed.error;
    } else if (row.state !== undefined || row.error !== undefined) {
      return err("bad_request", 400);
    }

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
      replyState,
      replyError,
    });
  }

  // The frozen `outbound[]` shape { local_id, to, body, sent_at, state?, error? }.
  // It carries the same rows as `direction: "out"` and resolves to the same
  // `(device_id, local_id)` dedupe key.
  for (const entry of outbound) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return err("bad_request", 400);
    }
    const row = entry as Record<string, unknown>;

    const localId = row.local_id;
    if (typeof localId !== "string" || localId === "") return err("bad_request", 400);
    if (localId.length > MAX_ID_CHARS) return err("bad_request", 400);

    const to = row.to;
    if (typeof to !== "string" || to === "") return err("bad_request", 400);
    if (to.length > MAX_PEER_CHARS) return err("bad_request", 400);

    const body = row.body;
    if (typeof body !== "string") return err("bad_request", 400);
    if (body.length > MAX_BODY_CHARS) return err("bad_request", 400);

    const sentAtRaw = row.sent_at;
    if (typeof sentAtRaw !== "string" && typeof sentAtRaw !== "number") {
      return err("bad_request", 400);
    }
    const sentAt = typeof sentAtRaw === "number" ? sentAtRaw : Date.parse(sentAtRaw);
    if (!Number.isFinite(sentAt)) return err("bad_request", 400);
    if (sentAt < now - RECEIVED_AT_PAST_MS || sentAt > now + RECEIVED_AT_FUTURE_MS) {
      return err("bad_request", 400);
    }

    const parsed = readReplyState(row);
    if (parsed === null) return err("bad_request", 400);

    validated.push({
      id: crypto.randomUUID(),
      localId,
      peer: to,
      body,
      receivedAt: sentAt,
      autoReply: 0,
      direction: "out",
      replyState: parsed.state,
      replyError: parsed.error,
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

    // Inbound rows keep the original "insert once" rule: a replay must not
    // overwrite automation bookkeeping such as auto_reply/reply_source.
    const inboundStmt = env.DB.prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, auto_reply)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, local_id) DO NOTHING`
    );
    // Outbound rows are an upsert: the SAME (device_id, local_id) row goes
    // `queued` → `sent` → `delivered` (or `failed`) as the radio reports it.
    // The WHERE makes an identical replay a no-op, so `meta.changes` still
    // distinguishes "written" from "already there", and a collision with an
    // inbound row of the same local_id can never rewrite its state.
    const outboundStmt = env.DB.prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, auto_reply,
          reply_state, reply_error)
       VALUES (?, ?, ?, 'out', ?, ?, ?, 0, ?, ?)
       ON CONFLICT(device_id, local_id) DO UPDATE SET
         reply_state = excluded.reply_state,
         reply_error = excluded.reply_error
       WHERE messages.direction = 'out'
         AND (messages.reply_state IS NOT excluded.reply_state
              OR messages.reply_error IS NOT excluded.reply_error)`
    );
    let results: D1Result[];
    try {
      results = await env.DB.batch(
        validated.map((m) =>
          m.direction === "in"
            ? inboundStmt.bind(
                m.id,
                deviceId,
                m.localId,
                m.direction,
                m.peer,
                m.body,
                m.receivedAt,
                m.autoReply
              )
            : outboundStmt.bind(
                m.id,
                deviceId,
                m.localId,
                m.peer,
                m.body,
                m.receivedAt,
                m.replyState,
                m.replyError
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
    const acceptedInbound: AcceptedInbound[] = [];
    for (let i = 0; i < results.length; i++) {
      // `meta.changes` is 0 when an inbound `DO NOTHING` skipped the row, or
      // when an outbound upsert matched the same state it already held.
      if ((results[i].meta?.changes ?? 0) > 0) {
        accepted++;
        const row = validated[i];
        // Outbound mirror rows are history, not triggers. A `failed` row is
        // logged like any other, but it never enters the rules/flows pipeline,
        // so `auto_reply_sent` semantics stay exactly as they were.
        if (row.direction === "in") {
          const acceptedRow: AcceptedInbound = {
            id: row.id,
            localId: row.localId,
            sender: row.peer,
            body: row.body,
            receivedAt: row.receivedAt,
            autoReply: row.autoReply,
          };
          acceptedMessages.push(acceptedRow);
          acceptedInbound.push(acceptedRow);
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

    // §11.11: rules run BEFORE flows, for rows the device did not already answer.
    // A message is answered at most once by automation, so the local ids a rule
    // replied to are removed from the flow fallback below.
    let flowMessages = acceptedMessages;
    const ruleCandidates = acceptedInbound.filter((message) => message.autoReply === 0);
    if (ruleCandidates.length > 0) {
      try {
        const outcome = await applyRules(env, deviceId, ruleCandidates, now);
        if (outcome.replied.size > 0) {
          flowMessages = acceptedMessages.filter(
            (message) => !outcome.replied.has(message.localId)
          );
        }
      } catch (error) {
        // A rule-engine failure must not fail the upload; the messages are durable.
        // Leaving flows unchanged is the conservative fallback (no rule replied).
        console.error(`[rules] pipeline failed for ${deviceId}: ${String(error)}`);
      }
    }

    // Flow fallback, only for rows that were actually inserted. A retried batch
    // is all duplicates, so it cannot send a second reply. A failure here must
    // not fail the upload: the messages are already durable.
    if (flowMessages.length > 0) {
      try {
        const enqueued = await dispatchFlows(env, deviceId, flowMessages);
        if (enqueued > 0) console.log(`[flow] enqueued ${enqueued} command(s) for ${deviceId}`);
      } catch (error) {
        console.error(`[flow] dispatch failed for ${deviceId}: ${String(error)}`);
      }
    }
  }

  if (acks.length > 0 || fcmToken) {
    await stub.fetch("https://do/__http_ack", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceId },
      body: JSON.stringify({ acks, fcm_token: fcmToken }),
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
    `SELECT id, device_id, local_id, direction, peer, body, received_at, auto_reply,
            reply_source, reply_ref, reply_command_id, reply_state, reply_error,
            reply_verdict
       FROM messages
      WHERE device_id = ? AND received_at < ?
      ORDER BY received_at DESC, id DESC
      LIMIT ?`
  )
    .bind(deviceId, before, limit)
    .all();

  return Response.json({ messages: rows.results ?? [], limit });
}

/**
 * §11.11: evaluate Rules for newly accepted inbound messages and queue the first
 * reply. Returns the local ids that received a rule reply, so flows can skip them.
 *
 * Rules are ordered `priority DESC, id`; the first one that matches and is inside
 * both limits replies, and evaluation stops for that message. A hit is appended to
 * the in-memory history immediately, so two matching messages in one batch cannot
 * both bypass a cooldown or an hourly cap.
 */
export interface RuleOutcome {
  /** Local ids a rule replied to. */
  replied: Set<string>;
  /**
   * Local ids a rule MATCHED and was held back on, with the reason.
   *
   * Recorded at the moment of the decision because it cannot be recomputed: the
   * cooldown is measured against `now`, so re-evaluating an hour later would say
   * "would reply", which is the opposite of what happened.
   */
  suppressed: Map<string, { verdict: "suppressed_cooldown" | "suppressed_hourly_cap"; detail: Record<string, unknown> }>;
}

async function applyRules(
  env: Env,
  deviceId: string,
  messages: AcceptedInbound[],
  now: number
): Promise<RuleOutcome> {
  const replied = new Set<string>();
  const suppressed: RuleOutcome["suppressed"] = new Map();
  if (messages.length === 0) return { replied, suppressed };

  const rows = await env.DB.prepare(
    `SELECT id, name, enabled, priority, matcher_type, matcher_value,
            body_type, body_value, reply_template, cooldown_s, max_per_hour,
            sim_slot, allow_shortcode, device_id, updated_at
       FROM rules
      WHERE enabled = 1 AND (device_id IS NULL OR device_id = ?)
      ORDER BY priority DESC, id ASC`
  )
    .bind(deviceId)
    .all<RuleRecord>();
  const rules = rows.results ?? [];
  if (rules.length === 0) return { replied, suppressed };

  // Cooldown may be longer than the hourly window, so look back far enough for
  // whichever limit is stricter. The query is device-first and indexed.
  const lookbackMs = rules.reduce(
    (longest, rule) => Math.max(longest, Math.max(0, rule.cooldown_s) * 1000),
    3_600_000
  );
  const hitRows = await env.DB.prepare(
    `SELECT rule_id, device_id, replied_at
       FROM rule_hits
      WHERE device_id = ? AND replied_at >= ?`
  )
    .bind(deviceId, now - lookbackMs)
    .all<RuleHit>();
  const hits: RuleHit[] = [...(hitRows.results ?? [])];

  for (const message of messages) {
    const evaluations = await evaluateRules(
      rules,
      { peer: message.sender, body: message.body },
      { deviceId, now, hits }
    );

    // A rule that matched and was held back is the only "nothing went out" reason
    // that has to be recorded: every other one is derivable from rows that outlive
    // it. The highest-priority such rule names the reason.
    const held = evaluations.find(
      (evaluation) => !evaluation.matched && (evaluation.reason === "cooldown" || evaluation.reason === "hourly_cap")
    );
    if (held !== undefined) {
      suppressed.set(message.localId, {
        verdict: held.reason === "cooldown" ? "suppressed_cooldown" : "suppressed_hourly_cap",
        detail: {
          rule_id: held.rule_id,
          rule_name: held.name,
          cooldown_s: held.rule?.cooldown_s ?? null,
          max_per_hour: held.rule?.max_per_hour ?? null,
          as_of: now,
        },
      });
    }

    for (const evaluation of evaluations) {
      if (!evaluation.matched) continue;

      const replyBody = evaluation.reply_body.slice(0, MAX_BODY_CHARS);
      // The console documents an empty template as "match without sending a reply".
      if (replyBody.trim() === "") continue;

      const commandId = crypto.randomUUID();
      const queued = await enqueueOutboundCommand(env, {
        deviceId,
        commandId,
        to: message.sender,
        body: replyBody,
        priority: "normal",
        expiresAt: now + RULE_COMMAND_TTL_MS,
      });
      // A DO failure is not a reason to try lower-priority rules: the queue as a
      // whole is unavailable. Leave the message unanswered so flows may still run.
      // A rules reply never carries an idempotency key, so `replayed` is false.
      if (!queued.ok) break;

      try {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE messages
                SET auto_reply = 1, reply_source = 'rule',
                    reply_ref = ?, reply_command_id = ?
              WHERE device_id = ? AND local_id = ?`
          ).bind(evaluation.rule_id, commandId, deviceId, message.localId),
          env.DB.prepare(
            `INSERT INTO rule_hits (rule_id, device_id, replied_at) VALUES (?, ?, ?)`
          ).bind(evaluation.rule_id, deviceId, now),
        ]);
      } catch (error) {
        // The command is already queued. The in-memory hit below still prevents a
        // second reply through flows or later messages in this batch.
        console.error(`[rules] could not record reply for ${message.localId}: ${String(error)}`);
      }

      hits.push({ rule_id: evaluation.rule_id, device_id: deviceId, replied_at: now });
      replied.add(message.localId);
      // A message that replied was not suppressed, whatever a lower-priority rule
      // would have said about its own cooldown.
      suppressed.delete(message.localId);
      break;
    }
  }

  if (suppressed.size > 0) {
    try {
      await env.DB.batch(
        [...suppressed.entries()].map(([localId, entry]) =>
          env.DB.prepare(
            `UPDATE messages SET reply_verdict = ?, reply_verdict_detail_json = ?
              WHERE device_id = ? AND local_id = ?`
          ).bind(entry.verdict, JSON.stringify(entry.detail), deviceId, localId)
        )
      );
    } catch (error) {
      // Provenance is diagnostic. A message that was not answered still was not
      // answered, whether or not the reason reached D1.
      console.error(`[rules] could not record suppression for ${deviceId}: ${String(error)}`);
    }
  }

  return { replied, suppressed };
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
