/**
 * Outbound commands — PROTOCOL_CONTRACT_V5 Rev C §6.1 (`PENDING` creation) and §8.
 * Port of master plan §5.4 with two port-brief fixes:
 *
 *   #18 persist outbound messages. `messages.direction` has always permitted
 *   'out' but Rev B never wrote an outbound row, so `GET /v1/messages` could only
 *   ever show half the conversation.
 *
 *   #9  one DO call per batch. Rev B called `/__enqueue` once per command inside a
 *   `for` loop with `await` (N serialised DO round-trips) and each call re-pushed
 *   every in-flight command over the socket; a batch of N enqueues re-sent
 *   command #1 N times. Batches now go through a single `/__enqueue_batch` call.
 *
 *   #12 `expires_in_s` is finite-checked and clamped to [1, 86400], default 600.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import {
  MAX_BODY_BYTES,
  MAX_BODY_CHARS,
  MAX_IDEMPOTENCY_KEY_CHARS,
  MAX_OUTBOUND_COMMANDS,
  MAX_PEER_CHARS,
  clampExpiresInS,
} from "../lib/config";
import { internalError } from "./pair";
import { enqueueOutboundCommand } from "../lib/commands";
import { enforceAgentSend } from "../lib/agent-send";

interface CommandPayload {
  command_id: string;
  to: string;
  body: string;
  priority: string;
  expires_at: number;
}

/** `POST /v1/sms/send` (admin) — enqueue exactly one outbound SMS. */
export async function handleSend(
  req: Request,
  env: Env,
  actor?: AdminActor
): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const deviceId = input.device_id;
  const to = input.to;
  const body = input.body;
  if (typeof deviceId !== "string" || deviceId === "") return err("bad_request", 400);
  if (typeof to !== "string" || to === "") return err("bad_request", 400);
  if (to.length > MAX_PEER_CHARS) return err("bad_request", 400);
  if (typeof body !== "string") return err("bad_request", 400);
  if (body.length > MAX_BODY_CHARS) return err("bad_request", 400);

  // An unregistered device_id resolves to a brand-new Durable Object that no
  // device will ever poll, so the command would sit PENDING until it expired
  // with no signal to the caller. Reject it up front rather than black-hole it.
  if (!(await deviceIsRegistered(env, deviceId))) return err("device_unknown", 404);

  // An agent token clears its target, its grant and its hourly budget before
  // anything is queued. A human caller passes straight through.
  //
  // Order is deliberate: the gate runs BEFORE the enqueue, so there is no window
  // in which a command is queued but its authority was refused. The cost is that
  // an idempotent REPLAY also spends one grant use and one budget unit for a
  // command it did not create. That is the safe direction (a retry can run out of
  // budget, never out of grants), and the replay is still reported honestly.
  const authority = await enforceAgentSend(env, actor, {
    deviceId,
    recipients: [to],
    allRecipients: false,
    ...(typeof input.reason === "string" ? { reason: input.reason.slice(0, 200) } : {}),
  });
  if (!authority.ok) return authority.response;

  const commandId = crypto.randomUUID();
  const expiresAt = Date.now() + clampExpiresInS(input.expires_in_s) * 1000;
  const priority = readPriority(input.priority);

  // The key travels in the body, not a header, because the canonical string
  // signs METHOD, PATH, timestamp, nonce and the body digest only. A header
  // would be the one input to this call that the device's signature does not
  // cover.
  const rawKey = input.idempotency_key;
  let idempotencyKey: string | null = null;
  if (rawKey !== undefined && rawKey !== null) {
    if (
      typeof rawKey !== "string" ||
      rawKey === "" ||
      rawKey.length > MAX_IDEMPOTENCY_KEY_CHARS
    ) {
      return err("bad_request", 400);
    }
    idempotencyKey = rawKey;
  }

  // Shared with the rules pipeline so the command id / message row pairing cannot
  // drift between an operator send and an automated reply.
  const queued = await enqueueOutboundCommand(env, {
    deviceId,
    commandId,
    to,
    body,
    priority,
    expiresAt,
    idempotencyKey,
  });
  if (!queued.ok) return internalError();

  // A replay created nothing: the command and its message row already exist, and
  // an audit row here would claim this call sent something.
  if (queued.replayed) {
    return Response.json({ command_id: queued.commandId, replayed: true });
  }

  // Metadata only: the recipient and the message body stay out of audit_log.
  await writeAudit(env, {
    action: "message.sent",
    actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
    subject: deviceId,
    // The grant id is what makes "what did that 15-minute grant actually do" a
    // query. It rides on this row rather than a second one per send.
    detail: {
      command_id: queued.commandId,
      count: 1,
      ...(authority.grantId === null ? {} : { grant_id: authority.grantId }),
    },
  });

  return Response.json({ command_id: queued.commandId, replayed: false });
}

/** `POST /v1/sms/send/batch` (admin) — enqueue many outbound SMS in one DO call. */
export async function handleSendBatch(
  req: Request,
  env: Env,
  actor?: AdminActor
): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const deviceId = input.device_id;
  const commands = input.commands;
  if (typeof deviceId !== "string" || deviceId === "") return err("bad_request", 400);
  if (!Array.isArray(commands)) return err("bad_request", 400);
  if (commands.length > MAX_OUTBOUND_COMMANDS) return err("bad_request", 400);
  if (!(await deviceIsRegistered(env, deviceId))) return err("device_unknown", 404);

  // Validate every entry before any side effect: all-or-nothing.
  const now = Date.now();
  const prepared: CommandPayload[] = [];
  for (const entry of commands) {
    if (!entry || typeof entry !== "object") return err("bad_request", 400);
    const item = entry as Record<string, unknown>;
    const to = item.to;
    const body = item.body;
    if (typeof to !== "string" || to === "") return err("bad_request", 400);
    if (to.length > MAX_PEER_CHARS) return err("bad_request", 400);
    if (typeof body !== "string") return err("bad_request", 400);
    if (body.length > MAX_BODY_CHARS) return err("bad_request", 400);
    // Refused here rather than at the Durable Object: the batch does not carry
    // per-entry replay semantics yet, and this route rebuilds each entry, so a
    // key would be dropped on the floor without a word.
    if (item.idempotency_key !== undefined && item.idempotency_key !== null) {
      return err("idempotency_key_not_supported_in_batch", 400);
    }
    prepared.push({
      command_id: crypto.randomUUID(),
      to,
      body,
      priority: readPriority(item.priority),
      expires_at: now + clampExpiresInS(item.expires_in_s) * 1000,
    });
  }

  if (prepared.length === 0) return Response.json({ command_ids: [] });

  // One grant has to cover EVERY recipient in the batch, not just one of them.
  const authority = await enforceAgentSend(env, actor, {
    deviceId,
    recipients: prepared.map((command) => command.to),
    allRecipients: true,
    ...(typeof input.reason === "string" ? { reason: input.reason.slice(0, 200) } : {}),
  });
  if (!authority.ok) return authority.response;

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  let res: Response;
  try {
    // ONE DO call for the whole batch — one push, one wake push, one lock
    // acquisition, instead of N.
    res = await stub.fetch("https://do/__enqueue_batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: prepared }),
    });
  } catch (error) {
    console.error(`[send] DO unreachable: ${String(error)}`);
    return internalError();
  }
  if (!res.ok) return internalError();

  // #18: persist one outbound `messages` row per command, in a single D1 batch.
  await env.DB.batch(
    prepared.map((command) =>
      env.DB.prepare(
        `INSERT INTO messages
           (id, device_id, local_id, direction, peer, body, received_at, auto_reply)
         VALUES (?, ?, ?, 'out', ?, ?, ?, 0)
         ON CONFLICT(device_id, local_id) DO NOTHING`
      ).bind(command.command_id, deviceId, command.command_id, command.to, command.body, now)
    )
  );

  await writeAudit(env, {
    action: "message.sent",
    actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
    subject: deviceId,
    detail: {
      command_ids: prepared.map((c) => c.command_id),
      count: prepared.length,
      ...(authority.grantId === null ? {} : { grant_id: authority.grantId }),
    },
  });

  return Response.json({ command_ids: prepared.map((c) => c.command_id) });
}

function readPriority(value: unknown): string {
  if (value === "high" || value === "normal" || value === "low") return value;
  return "normal";
}

/**
 * `devices` in D1 is the fleet registry written at pairing time (§11). A device
 * that is absent there has no Durable Object state and no public key, so it can
 * never authenticate and never poll.
 */
async function deviceIsRegistered(env: Env, deviceId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM devices WHERE device_id = ?`)
    .bind(deviceId)
    .first();
  return row !== null;
}
