/**
 * One id in, the whole story out.
 *
 * A reply goes wrong across four stores and the operator sees one symptom: the
 * message was not answered. The inbound row and its automation bookkeeping are in
 * D1, the command and its timers are in the device's Durable Object, the mailbox
 * facts are in `audit_log`, and an agent's ask is in `approval_requests`. This
 * module joins them in one call and reduces them to one verdict plus the lines
 * that justify it.
 *
 * The id may be a message, a command, or an approval request, in that order of
 * specificity. That order is deliberate: an approval request is the only one of
 * the three that is a QUESTION rather than a record, and answering "this is
 * paused for a human" needs the request row, not the absence of a command.
 */

import type { Env } from "../index";
import { deriveFate, type SummaryVerdict } from "./reply-fate";

export type TraceKind = "approval" | "message" | "command" | "unknown";

export interface TraceInput {
  id: string;
  /** Disambiguates a local_id, which is only unique within a device. */
  deviceId?: string;
}

export interface TraceResult {
  id: string;
  kind: TraceKind;
  device_id: string | null;
  verdict: SummaryVerdict;
  why: string[];
  message: Record<string, unknown> | null;
  command: Record<string, unknown> | null;
  automation: {
    rules: Array<Record<string, unknown>>;
    flows: Array<Record<string, unknown>>;
  };
  approval: Record<string, unknown> | null;
  audit: Array<Record<string, unknown>>;
  durable_object: Record<string, unknown> | null;
  warnings: string[];
}

interface MessageRow {
  id: string;
  device_id: string;
  local_id: string;
  direction: string;
  peer: string;
  body: string;
  received_at: number;
  auto_reply: number;
  reply_source: string | null;
  reply_ref: string | null;
  reply_command_id: string | null;
  reply_state: string | null;
  reply_error: string | null;
  reply_verdict: string | null;
  reply_verdict_detail_json: string | null;
}

interface ApprovalRow {
  id: string;
  agent_token_id: string;
  scope: string;
  target_json: string;
  state: string;
  requested_at: number;
  expires_at: number;
  grant_id: string | null;
}

const MESSAGE_COLUMNS = `id, device_id, local_id, direction, peer, body, received_at,
                         auto_reply, reply_source, reply_ref, reply_command_id,
                         reply_state, reply_error, reply_verdict, reply_verdict_detail_json`;

/**
 * Resolve an id and explain it.
 *
 * Every failure to reach the Durable Object degrades to a warning rather than an
 * error: the D1 half of the story is still worth telling, and "the object did not
 * answer" is itself a fact an operator needs.
 */
export async function traceMessage(env: Env, input: TraceInput): Promise<TraceResult> {
  const warnings: string[] = [];
  const id = input.id;

  /* ---- 1. an approval request ---------------------------------------- */
  const approval = await env.DB.prepare(
    `SELECT id, agent_token_id, scope, target_json, state, requested_at, expires_at, grant_id
       FROM approval_requests WHERE id = ?`
  )
    .bind(id)
    .first<ApprovalRow>();

  if (approval !== null) {
    const pending = approval.state === "PENDING" && approval.expires_at > Date.now();
    const fate = deriveFate({
      pending_approval: pending,
      reply_command_state: null,
      auto_reply: false,
      suppressed: null,
    });
    return {
      id,
      kind: "approval",
      device_id: null,
      verdict: fate.verdict,
      why:
        approval.state === "PENDING" && !pending
          ? ["the request expired before anyone answered it"]
          : fate.why,
      message: null,
      command: null,
      automation: { rules: [], flows: [] },
      approval: {
        ...approval,
        target: safeJson(approval.target_json),
        live: pending,
      },
      audit: await readAudit(env, approval.agent_token_id),
      durable_object: null,
      warnings,
    };
  }

  /* ---- 2. a message --------------------------------------------------- */
  const message = await findMessage(env, id, input.deviceId);
  if (message === null && input.deviceId === undefined) {
    warnings.push("no message with that id; searched every device");
  }

  if (message !== null) {
    const deviceId = message.device_id;
    const commandId = message.reply_command_id ?? message.id;

    const durable = await readDurableObject(env, deviceId, commandId, warnings);
    const commandState = readCommandState(durable, commandId) ?? null;

    const flowRuns = await env.DB.prepare(
      `SELECT flow_id, flow_version, outcome, created_at
         FROM flow_runs WHERE device_id = ? AND local_id = ?
        ORDER BY created_at DESC LIMIT 20`
    )
      .bind(deviceId, message.local_id)
      .all<Record<string, unknown>>();

    const suppression =
      message.reply_verdict === "suppressed_cooldown" ||
      message.reply_verdict === "suppressed_hourly_cap"
        ? message.reply_verdict
        : null;

    const fate = deriveFate({
      pending_approval: false,
      reply_command_state: commandState,
      auto_reply: Number(message.auto_reply) === 1,
      suppressed: suppression,
    });

    const why = [...fate.why];
    const detail = safeJson(message.reply_verdict_detail_json);
    if (suppression !== null && detail !== null) {
      const rule = typeof detail.rule_id === "string" ? detail.rule_id : "a rule";
      why.push(`rule ${rule} matched`);
      if (typeof detail.as_of === "number") {
        why.push(`decided at ${new Date(detail.as_of).toISOString()}`);
      }
    }
    if (message.reply_error) why.push(`the phone reported: ${message.reply_error}`);

    return {
      id,
      kind: "message",
      device_id: deviceId,
      verdict: fate.verdict,
      why,
      message: {
        id: message.id,
        local_id: message.local_id,
        direction: message.direction,
        peer: message.peer,
        received_at: message.received_at,
        auto_reply: Number(message.auto_reply) === 1,
        reply_source: message.reply_source,
        reply_ref: message.reply_ref,
        reply_command_id: message.reply_command_id,
        reply_state: message.reply_state,
        reply_error: message.reply_error,
        reply_verdict: message.reply_verdict,
        reply_verdict_detail: detail,
      },
      command:
        durable === null || commandId === null
          ? null
          : { command_id: commandId, state: commandState },
      automation: {
        rules: message.reply_ref === null ? [] : [{ rule_id: message.reply_ref }],
        flows: flowRuns.results ?? [],
      },
      approval: null,
      audit: await readAudit(env, commandId),
      durable_object: durable,
      warnings,
    };
  }

  /* ---- 3. a command with no message row ------------------------------- */
  if (input.deviceId !== undefined) {
    const durable = await readDurableObject(env, input.deviceId, id, warnings);
    const state = readCommandState(durable, id);
    if (state !== null) {
      const fate = deriveFate({
        pending_approval: false,
        reply_command_state: state,
        auto_reply: false,
        suppressed: null,
      });
      return {
        id,
        kind: "command",
        device_id: input.deviceId,
        verdict: fate.verdict,
        why: fate.why,
        message: null,
        command: { command_id: id, state },
        automation: { rules: [], flows: [] },
        approval: null,
        audit: await readAudit(env, id),
        durable_object: durable,
        warnings,
      };
    }
  }

  return {
    id,
    kind: "unknown",
    device_id: input.deviceId ?? null,
    verdict: "no_match",
    why: ["nothing on this deployment has that id: not a message, a command or an approval request"],
    message: null,
    command: null,
    automation: { rules: [], flows: [] },
    approval: null,
    audit: [],
    durable_object: null,
    warnings,
  };
}

async function findMessage(
  env: Env,
  id: string,
  deviceId: string | undefined
): Promise<MessageRow | null> {
  if (deviceId !== undefined) {
    return env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE device_id = ? AND (id = ? OR local_id = ?)
        LIMIT 1`
    )
      .bind(deviceId, id, id)
      .first<MessageRow>();
  }
  return env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? OR local_id = ? LIMIT 1`
  )
    .bind(id, id)
    .first<MessageRow>();
}

async function readDurableObject(
  env: Env,
  deviceId: string,
  commandId: string,
  warnings: string[]
): Promise<Record<string, unknown> | null> {
  try {
    const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
    const response = await stub.fetch(
      `https://do/__trace?id=${encodeURIComponent(commandId)}`,
      { method: "GET" }
    );
    if (!response.ok) {
      warnings.push(`the device object answered ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    warnings.push(`the device object is unreachable: ${String(error)}`);
    return null;
  }
}

/** The command's state, from the object's own row. D1 is not asked twice. */
function readCommandState(
  durable: Record<string, unknown> | null,
  commandId: string
): string | null {
  if (durable === null) return null;
  const command = durable.command as Record<string, unknown> | null | undefined;
  if (command === null || command === undefined) return null;
  if (command.command_id !== commandId) return null;
  return typeof command.state === "string" ? command.state : null;
}

/** The audit trail for one subject, newest first. Never a message body. */
async function readAudit(env: Env, subject: string): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await env.DB.prepare(
      `SELECT at, actor_label, action, subject, detail_json
         FROM audit_log
        WHERE subject = ? OR instr(detail_json, ?) > 0
        ORDER BY at DESC LIMIT 20`
    )
      .bind(subject, subject)
      .all<Record<string, unknown>>();
    return rows.results ?? [];
  } catch {
    return [];
  }
}

function safeJson(text: string | null): Record<string, unknown> | null {
  if (text === null || text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
