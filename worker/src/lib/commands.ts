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

export interface OutboundCommandInput {
  deviceId: string;
  commandId: string;
  to: string;
  body: string;
  priority: string;
  expiresAt: number;
}

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
): Promise<boolean> {
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
      }),
    });
  } catch (error) {
    console.error(`[command] DO unreachable: ${String(error)}`);
    return false;
  }
  if (!res.ok) {
    console.error(`[command] enqueue rejected with HTTP ${res.status}`);
    return false;
  }

  await persistOutboundMessage(
    env,
    command.deviceId,
    command.commandId,
    command.to,
    command.body
  );
  return true;
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
  body: string
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, auto_reply)
       VALUES (?, ?, ?, 'out', ?, ?, ?, 0)
       ON CONFLICT(device_id, local_id) DO NOTHING`
    )
      .bind(commandId, deviceId, commandId, to, body, Date.now())
      .run();
  } catch (error) {
    // The command is already queued in the DO; a bookkeeping failure must not
    // turn a successful send into a 500.
    console.error(`[command] outbound message persist failed: ${String(error)}`);
  }
}
