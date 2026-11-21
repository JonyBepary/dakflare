/**
 * One enqueue path for outbound SMS.
 *
 * Both the admin send route and the rules pipeline create an "ordinary command":
 * a Durable Object row plus a mirrored `messages` row whose id and `local_id` are
 * the command id. Keeping that pairing in one helper is what stops the two paths
 * from drifting — a rule reply must be indistinguishable from an operator send in
 * the command tracker and in `/v1/messages`.
 */

import type { Env } from "../index";
import { coreFetch } from "./core";

export interface OutboundCommandInput {
  deviceId: string;
  commandId: string;
  to: string;
  body: string;
  priority: string;
  expiresAt: number;
  simSlot?: number;
  /**
   * Dedupe key. When the Durable Object already has a command for this key it
   * returns that command instead of creating a second one, and `replayed` says
   * which happened.
   */
  idempotencyKey?: string | null;
}

/**
 * What the enqueue did. `replayed` is not an error: a retry with the same key is
 * supposed to look like success, which is the whole point of the key.
 */
export type EnqueueOutcome =
  | { ok: true; commandId: string; replayed: boolean }
  | { ok: false };

/**
 * Enqueue one command in the device's Durable Object, then mirror it into D1.
 *
 * Returns false when the DO could not accept the command. The caller decides
 * whether that is a 500 (admin send) or a reason to leave automation untouched
 * (rules). A D1 bookkeeping failure after a successful enqueue is deliberately
 * swallowed: the command exists and will be delivered, so it must not be reported
 * as a failed send.
 */
export async function enqueueOutboundCommand(
  env: Env,
  command: OutboundCommandInput
): Promise<EnqueueOutcome> {
  // The split agent Worker has no DEVICE namespace. It decides whether the send
  // is authorised, then asks the main Worker to put the command in the object
  // that owns the socket. Only the enqueue crosses: the authority check and the
  // audit row stay with the Worker that served the request.
  if (env.DEVICE === undefined && env.CORE !== undefined) {
    const answer = await coreFetch(env, "/v1/admin/agent/enqueue", {
      method: "POST",
      body: {
        device_id: command.deviceId,
        command_id: command.commandId,
        to: command.to,
        body: command.body,
        priority: command.priority,
        expires_at: command.expiresAt,
        idempotency_key: command.idempotencyKey ?? null,
        ...(command.simSlot !== undefined ? { sim_slot: command.simSlot } : {}),
      },
    });
    const data = (await answer.json().catch(() => null)) as
      | { command_id?: unknown; replayed?: unknown }
      | null;
    if (!answer.ok || data === null) {
      console.error(`[command] CORE enqueue rejected with HTTP ${answer.status}`);
      return { ok: false };
    }
    return {
      ok: true,
      commandId: typeof data.command_id === "string" ? data.command_id : command.commandId,
      replayed: data.replayed === true,
    };
  }

  const stub = env.DEVICE.get(env.DEVICE.idFromName(command.deviceId));
  let res: Response;
  try {
    res = await stub.fetch("https://do/__enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: command.commandId,
        to: command.to,
        body: command.body,
        priority: command.priority,
        expires_at: command.expiresAt,
        sim_slot: command.simSlot ?? 0,
        idempotency_key: command.idempotencyKey ?? null,
      }),
    });
  } catch (error) {
    console.error(`[command] DO unreachable: ${String(error)}`);
    return { ok: false };
  }
  if (!res.ok) {
    console.error(`[command] enqueue rejected with HTTP ${res.status}`);
    return { ok: false };
  }

  const answer = (await res.json().catch(() => null)) as
    | { replayed?: unknown; command_id?: unknown }
    | null;
  const replayed = answer?.replayed === true;
  // A replay returns the command that already exists, which is not the id this
  // call generated. Everything downstream has to use the DO's answer.
  const commandId =
    typeof answer?.command_id === "string" && answer.command_id !== ""
      ? answer.command_id
      : command.commandId;

  if (replayed) return { ok: true, commandId, replayed: true };

  await persistOutboundMessage(
    env,
    command.deviceId,
    commandId,
    command.to,
    command.body
  );
  return { ok: true, commandId, replayed: false };
}

/**
 * Mirror an outbound command into the operator log.
 *
 * `id = local_id = command_id` matches `routes/send.ts`: the command id is the
 * stable identity everywhere the row is read, and `(device_id, local_id)` keeps
 * a retry from duplicating it.
 */
export async function persistOutboundMessage(
  env: Env,
  deviceId: string,
  commandId: string,
  to: string,
  body: string,
  channel = "sms"
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, auto_reply, channel)
       VALUES (?, ?, ?, 'out', ?, ?, ?, 0, ?)
       ON CONFLICT(device_id, local_id) DO NOTHING`
    )
      .bind(commandId, deviceId, commandId, to, body, Date.now(), channel)
      .run();
  } catch (error) {
    // The command is already queued in the DO; a bookkeeping failure must not
    // turn a successful send into a 500.
    console.error(`[command] outbound message persist failed: ${String(error)}`);
  }
}

const RE_OTP_PIN =
  /(?:\b(?:otp|pin|passcode|secret\s+code|auth(?:entication)?\s+code|verification\s+code|security\s+code|one[\s-]time\s+password)\b|ওটিপি|গোলাপী\s*পিন|গোপন\s*(?:নম্বর|পিন)|ভেরিফিকেশন\s*(?:কোড)?|সিকিউরিটি\s*কোড|\bপিন\b)/iu;

/** Detect sensitive OTP or PIN bodies that must never trigger automations or webhooks. */
export function isOtpOrPinMessage(rawBody: string): boolean {
  const normalized = (rawBody || "")
    .normalize("NFKC")
    .replace(/[\u09E6-\u09EF]/g, (ch) => String(ch.charCodeAt(0) - 0x09e6));
  return RE_OTP_PIN.test(normalized);
}
