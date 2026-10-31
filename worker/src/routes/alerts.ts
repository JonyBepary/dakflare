/**
 * Operator alerts — PROTOCOL_CONTRACT_V5 §11.11 and docs/CONSOLE_UX.md §3.
 *
 * An alert is a fact about a device ("this phone has been silent too long"), not a
 * deployment-health metric. The Worker used to only `console.warn` when the
 * `offline_alert` task fired, which nobody reads. `alerts` is the durable copy the
 * console banner reads, and acknowledgement is explicit so a known outage stops
 * shouting without deleting the history.
 */

import type { Env } from "../index";
import { err } from "../lib/errors";

/**
 * `GET /v1/admin/alerts` — newest first, open only by default.
 *
 * `?all=1` includes acknowledged rows for the history view. The limit is fixed at
 * 100: the banner needs a bounded answer, not pagination it will never use.
 */
export async function handleAlertsList(env: Env, requestUrl: URL): Promise<Response> {
  const includeAcknowledged = requestUrl.searchParams.get("all") === "1";
  // "Open" is unresolved *and* unacknowledged. A device that came back online
  // resolves its alert automatically, so it must not keep showing here.
  const where = includeAcknowledged
    ? ""
    : "WHERE a.acknowledged_at IS NULL AND a.resolved_at IS NULL";

  const rows = await env.DB.prepare(
    `SELECT a.id, a.device_id, d.label AS label, a.kind, a.raised_at,
            a.acknowledged_at, a.resolved_at, a.detail
       FROM alerts a
       LEFT JOIN devices d ON d.device_id = a.device_id
       ${where}
      ORDER BY a.raised_at DESC, a.id DESC
      LIMIT 100`
  ).all();

  return Response.json({ alerts: rows.results ?? [] });
}

/**
 * `POST /v1/admin/alerts/:id/ack` — acknowledge once; 404 for an unknown id.
 *
 * A second acknowledgement is a successful no-op: the operator asked for the state
 * they are already in, and inventing a 409 would only make the console handle an
 * error that has no action behind it.
 */
export async function handleAlertAck(env: Env, alertId: string): Promise<Response> {
  const id = alertId.trim();
  if (id === "") return err("bad_request", 400);

  const existing = await env.DB.prepare(
    `SELECT acknowledged_at FROM alerts WHERE id = ?`
  )
    .bind(id)
    .first<{ acknowledged_at: number | null }>();
  if (existing === null) return Response.json({ error: "not_found" }, { status: 404 });

  if (existing.acknowledged_at !== null) {
    return Response.json({ ok: true, id, acknowledged_at: existing.acknowledged_at });
  }

  const acknowledgedAt = Date.now();
  await env.DB.prepare(
    `UPDATE alerts SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`
  )
    .bind(acknowledgedAt, id)
    .run();

  return Response.json({ ok: true, id, acknowledged_at: acknowledgedAt });
}
