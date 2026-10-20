/**
 * Delivery-status batch — PROTOCOL_CONTRACT_V5 Rev C §6 and §8.
 * Port of master plan §5.4 with §6's enforcement added.
 *
 * Rev B declared the state machine in §4 and then issued unguarded
 * `UPDATE commands SET state = ?` from three places, so a duplicated or late
 * receipt regressed `DELIVERED` back to `ACKED_BY_DEVICE` or to `SENT`. The
 * transition is now guarded in SQL inside the Durable Object (§6.2) and this
 * route only reports what the storage layer accepted.
 *
 * §6.1: a rejected transition is a NO-OP THAT RETURNS SUCCESS, not an error —
 * a late receipt from Android is normal and must not be surfaced as a failure.
 */

import type { Env } from "../index";
import { err } from "../lib/errors";

/** §6.1 status targets the device may report. `PENDING` and `DISPATCHED` are edge-owned. */
const DEVICE_REPORTABLE_STATUSES = new Set([
  "ACKED_BY_DEVICE",
  "SENT",
  "DELIVERED",
  "FAILED",
  "EXPIRED",
]);

interface StatusUpdate {
  command_id: string;
  status: string;
}

export async function handleStatusBatch(
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

  const updates = data.updates ?? [];
  if (!Array.isArray(updates)) return err("bad_request", 400);

  const accepted: StatusUpdate[] = [];
  let ignored = 0;
  for (const entry of updates) {
    if (!entry || typeof entry !== "object") {
      ignored++;
      continue;
    }
    const row = entry as Record<string, unknown>;
    const commandId = row.command_id;
    const status = row.status;
    if (typeof commandId !== "string" || commandId === "") {
      ignored++;
      continue;
    }
    if (typeof status !== "string" || !DEVICE_REPORTABLE_STATUSES.has(status)) {
      ignored++;
      continue;
    }
    accepted.push({ command_id: commandId, status });
  }

  if (accepted.length === 0) {
    return Response.json({ applied: 0, rejected: 0, ignored });
  }

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  const res = await stub.fetch("https://do/__status_batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates: accepted }),
  });

  if (!res.ok) {
    // The DO reports per-update results; an outright failure is a server fault.
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  const result = (await res.json().catch(() => null)) as
    | { applied?: unknown; rejected?: unknown }
    | null;
  const applied = typeof result?.applied === "number" ? result.applied : 0;
  const rejected = typeof result?.rejected === "number" ? result.rejected : 0;

  // §6.1: applied and rejected both exit 200. A rejected transition is a
  // successful no-op, never an error.
  return Response.json({ applied, rejected, ignored });
}

/**
 * `GET /v1/sms/commands/:command_id?device_id=` (admin, brief #19).
 * Reads the command's current state straight out of the owning Durable Object,
 * which is the only place the state machine lives.
 */
export async function handleCommandStatus(
  env: Env,
  deviceId: string,
  commandId: string
): Promise<Response> {
  if (!deviceId) return err("bad_request", 400);
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  const res = await stub.fetch(
    `https://do/__command?command_id=${encodeURIComponent(commandId)}`,
    { method: "GET" }
  );
  if (!res.ok) return err("bad_request", 404);
  const payload = (await res.json().catch(() => null)) as { command?: unknown } | null;
  return Response.json({ command: payload?.command ?? null });
}
