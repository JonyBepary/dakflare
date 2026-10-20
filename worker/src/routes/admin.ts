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
import { err } from "../lib/errors";

/** `DELETE /v1/admin/devices/:device_id` — revoke a device in D1 and in its DO. */
export async function handleDeviceRevoke(env: Env, deviceId: string): Promise<Response> {
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

  return Response.json({ ok: true, d1_deleted: Number(d1.meta?.changes ?? 0) });
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
