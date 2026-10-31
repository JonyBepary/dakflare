/**
 * Outbound poll — PROTOCOL_CONTRACT_V5 Rev E §1.3 ("no idempotency key needed:
 * read + ack"), §6.1 (`PENDING -> LEASED` when returned by poll), §8.
 *
 * The poll is two-step by design: it may carry `acks` from the previous cycle
 * AND return the next batch of commands, which is what makes the C2 flow
 * (`poll -> ack -> poll`) work without an extra round-trip.
 *
 * Rev E: acks are `{command_id, claim_token}` objects. A body still carrying
 * `ack_command_ids` is a v5.2.1 client and is refused rather than ignored.
 */

import type { Env } from "../index";
import { err } from "../lib/errors";
import { parseAcks } from "../lib/acks";
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

  if (data.ack_command_ids !== undefined) return err("bad_request", 400);
  const acks = parseAcks(data.acks);
  if (acks === null) return err("bad_request", 400);

  const fcmToken =
    typeof data.fcm_token === "string" && data.fcm_token !== "" ? data.fcm_token : null;

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));

  if (acks.length > 0 || fcmToken) {
    await stub.fetch("https://do/__http_ack", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceId },
      body: JSON.stringify({ acks, fcm_token: fcmToken }),
    });
  }

  const commands = await readPending(stub);
  return Response.json({ commands });
}
