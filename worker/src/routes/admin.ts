/**
 * Administrative operations that are not part of the device protocol.
 *
 * Hardening S10. Two gaps the audit found:
 *
 *   1. There was no way to revoke a device. Deleting the D1 row did NOT revoke it,
 *      because `verifyDeviceSignature` resolves the public key from the DEVICE'S
 *      DURABLE OBJECT, not from D1. A lost or compromised phone kept working until
 *      someone edited the DO's SQLite by hand. Revocation therefore has to reach
 *      both stores.
 *
 *   2. Rules could be created (upsert) but never listed or deleted through the API,
 *      and `GET /v1/rules` only returns enabled rules for the calling device — so an
 *      operator could not see, let alone remove, a misconfigured global auto-reply
 *      rule without raw SQL. That is exactly how 33 test rules ended up live.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { err } from "../lib/errors";
import { internalError } from "./pair";

/** `DELETE /v1/admin/devices/:device_id` — revoke a device in D1 and in its DO. */
export async function handleDeviceRevoke(
  env: Env,
  deviceId: string,
  actor?: AdminActor
): Promise<Response> {
  if (!deviceId) return err("bad_request", 400);

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));

  // The DO first: if this fails, the device is still authenticating, and a D1-only
  // delete would leave the fleet view claiming it is gone while it keeps working.
  let revoked = false;
  try {
    const res = await stub.fetch("https://do/__revoke", { method: "POST" });
    revoked = res.ok;
  } catch {
    revoked = false;
  }
  if (!revoked) {
    return Response.json({ error: "revoke_failed" }, { status: 502 });
  }

  const d1 = await env.DB.prepare(`DELETE FROM devices WHERE device_id = ?`)
    .bind(deviceId)
    .run();

  await writeAudit(env, {
    action: "device.revoked",
    actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
    subject: deviceId,
    detail: { d1_deleted: Number(d1.meta?.changes ?? 0) },
  });

  return Response.json({ ok: true, d1_deleted: Number(d1.meta?.changes ?? 0) });
}

/**
 * `POST /v1/admin/devices/:device_id/archive` — hide a device without deleting it.
 *
 * Revoke is destructive by design (a compromised phone must lose its key AND its
 * history is not the operator's to keep). Archive is the other case: an
 * uninstalled phone whose 150-message history is still evidence. The row and
 * every message stay; only `GET /v1/devices` stops showing it.
 *
 * Deliberately no Durable Object call. An archived device is still a valid
 * device: it can authenticate, and its next authenticated request clears the
 * archive again (see `recordDeviceContact` in index.ts). Only revoke touches
 * the DO.
 */
export function handleDeviceArchive(
  env: Env,
  deviceId: string,
  actor?: AdminActor
): Promise<Response> {
  return setDeviceArchived(env, deviceId, true, actor);
}

/** `POST /v1/admin/devices/:device_id/unarchive` — make an archived device visible again. */
export function handleDeviceUnarchive(
  env: Env,
  deviceId: string,
  actor?: AdminActor
): Promise<Response> {
  return setDeviceArchived(env, deviceId, false, actor);
}

/**
 * The shared transition. `changed` reports whether this call moved the row, so a
 * repeated archive is a no-op 200 rather than a second audit entry claiming an
 * event that did not happen. The audit is written only on a real transition.
 */
async function setDeviceArchived(
  env: Env,
  deviceId: string,
  archived: boolean,
  actor?: AdminActor
): Promise<Response> {
  if (!deviceId) return err("bad_request", 400);

  const result = archived
    ? await env.DB.prepare(
        `UPDATE devices SET archived_at = ? WHERE device_id = ? AND archived_at IS NULL`
      )
        .bind(Date.now(), deviceId)
        .run()
    : await env.DB.prepare(
        `UPDATE devices SET archived_at = NULL WHERE device_id = ? AND archived_at IS NOT NULL`
      )
        .bind(deviceId)
        .run();

  const changed = Number(result.meta?.changes ?? 0) > 0;

  // Read back rather than trusting the input: an archive of an already-archived
  // device keeps the ORIGINAL timestamp, and the caller should see that value.
  const row = await env.DB.prepare(`SELECT archived_at FROM devices WHERE device_id = ?`)
    .bind(deviceId)
    .first<{ archived_at: number | null }>();
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

  if (changed) {
    await writeAudit(env, {
      action: archived ? "device.archived" : "device.unarchived",
      actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
      subject: deviceId,
      detail: { archived_at: row.archived_at ?? null },
    });
  }

  return Response.json({
    ok: true,
    device_id: deviceId,
    archived_at: row.archived_at ?? null,
    changed,
  });
}

/**
 * `GET /v1/admin/devices/:device_id/commands?limit=` — the device's queue.
 *
 * Proxied to the Durable Object because that is the only place command state
 * lives. An unknown device is not an error: its object simply has no commands,
 * which is exactly what the console should show.
 */
export async function handleDeviceCommands(
  env: Env,
  deviceId: string,
  requestUrl: URL
): Promise<Response> {
  const limit = requestUrl.searchParams.get("limit");
  // Re-encode rather than interpolate: `limit` is untrusted even on an admin route.
  const query = limit === null ? "" : `?limit=${encodeURIComponent(limit)}`;
  try {
    const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
    const res = await stub.fetch(`https://do/__commands${query}`, { method: "GET" });
    if (!res.ok) return internalError();
    return new Response(res.body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`[commands] DO unreachable for ${deviceId}: ${String(error)}`);
    return internalError();
  }
}

/** `GET /v1/admin/rules` — every rule, including disabled and other devices'. */
export async function handleRulesListAdmin(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, device_id, name, enabled, priority, matcher_type, matcher_value,
            body_type, body_value, reply_template, cooldown_s, max_per_hour,
            sim_slot, allow_shortcode, updated_at
       FROM rules
      ORDER BY device_id IS NULL DESC, priority DESC, name`
  ).all();
  return Response.json({ rules: rows.results ?? [] });
}

/** `DELETE /v1/admin/rules/:id` — remove a rule by id. */
export async function handleRuleDelete(env: Env, ruleId: string): Promise<Response> {
  if (!ruleId) return err("bad_request", 400);
  const result = await env.DB.prepare(`DELETE FROM rules WHERE id = ?`).bind(ruleId).run();
  const deleted = Number(result.meta?.changes ?? 0);
  if (deleted === 0) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true, deleted });
}
