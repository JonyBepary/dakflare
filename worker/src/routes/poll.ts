/**
 * Outbound poll — PROTOCOL_CONTRACT_V5 Rev C §1.3 ("no idempotency key needed:
 * read + ack"), §6.1 (`PENDING -> DISPATCHED` when returned by poll), §8.
 * Port of master plan §5.4.
 *
 * The poll is two-step by design: it may carry `ack_command_ids` from the
 * previous cycle AND return the next batch of commands, which is what makes the
 * C2 flow (`poll -> ack -> poll`) work without an extra round-trip.
 */

import type { Env } from "../index";
import { err } from "../lib/errors";
import { MAX_ACK_IDS } from "../lib/config";
import { readPending } from "./incoming";

export async function handlePoll(
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

  const ackCommandIds: string[] = [];
  if (data.ack_command_ids !== undefined) {
    if (!Array.isArray(data.ack_command_ids)) return err("bad_request", 400);
    if (data.ack_command_ids.length > MAX_ACK_IDS) return err("bad_request", 400);
    for (const id of data.ack_command_ids) {
      if (typeof id === "string" && id !== "") ackCommandIds.push(id);
    }
  }

  const fcmToken =
    typeof data.fcm_token === "string" && data.fcm_token !== "" ? data.fcm_token : null;

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));

  if (ackCommandIds.length > 0 || fcmToken) {
    await stub.fetch("https://do/__http_ack", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceId },
      body: JSON.stringify({ ack_command_ids: ackCommandIds, fcm_token: fcmToken }),
    });
  }

  const commands = await readPending(stub);
  return Response.json({ commands });
}
