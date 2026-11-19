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
import { writeAudit, type AdminActor } from "../audit";
import { err } from "../lib/errors";

/**
 * `GET /v1/admin/alerts` — newest first, open only by default.
 *
 * `?all=1` includes acknowledged rows for the history view. The limit is fixed at
 * 100: the banner needs a bounded answer, not pagination it will never use.
 */
export async function handleAlertsList(env: Env, requestUrl: URL): Promise<Response> {
  const includeAcknowledged = requestUrl.searchParams.get("all") === "1";
  // "Open" is unresolved *and* unacknowledged on active (non-archived) devices.
  const where = includeAcknowledged
    ? "WHERE (d.device_id IS NOT NULL AND d.archived_at IS NULL)"
    : "WHERE a.acknowledged_at IS NULL AND a.resolved_at IS NULL AND (d.device_id IS NOT NULL AND d.archived_at IS NULL)";

  const rows = await env.DB.prepare(
    `SELECT a.id, a.device_id, d.label AS label, a.kind, a.raised_at,
            a.acknowledged_at, a.acknowledged_by, a.resolved_at, a.detail
       FROM alerts a
       LEFT JOIN devices d ON d.device_id = a.device_id
       ${where}
      ORDER BY a.raised_at DESC, a.id DESC
      LIMIT 100`
  ).all();

  return Response.json({ alerts: rows.results ?? [] });
}

/**
 * `POST /v1/admin/alerts/ack-all` — acknowledge all currently open alerts.
 *
 * The actor is stored on every row it changes, and one audit row records the
 * batch. A call that opens nothing new is a no-op and writes no audit row.
 */
export async function handleAlertsAckAll(env: Env, actor?: AdminActor): Promise<Response> {
  const acknowledgedAt = Date.now();
  const acknowledgedBy = actor?.label ?? null;
  const res = await env.DB.prepare(
    `UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE acknowledged_at IS NULL`
  )
    .bind(acknowledgedAt, acknowledgedBy)
    .run();
  const count = Number(res.meta?.changes ?? 0);

  if (count > 0) {
    await writeAudit(env, {
      action: "alert.acknowledged_all",
      actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
      detail: { count, acknowledged_at: acknowledgedAt },
    });
  }

  return Response.json({
    ok: true,
    acknowledged_count: count,
    acknowledged_at: acknowledgedAt,
    acknowledged_by: acknowledgedBy,
  });
}

/**
 * `POST /v1/admin/alerts/:id/ack` — acknowledge once; 404 for an unknown id.
 *
 * A second acknowledgement is a successful no-op: the operator asked for the state
 * they are already in, and inventing a 409 would only make the console handle an
 * error that has no action behind it. The first actor and time are kept; the
 * acknowledgement is also written to `audit_log`, so "who acknowledged this" is
 * answerable from either the row or the log.
 */
export async function handleAlertAck(
  env: Env,
  alertId: string,
  actor?: AdminActor
): Promise<Response> {
  const id = alertId.trim();
  if (id === "") return err("bad_request", 400);

  const existing = await env.DB.prepare(
    `SELECT acknowledged_at, acknowledged_by, device_id, kind FROM alerts WHERE id = ?`
  )
    .bind(id)
    .first<{
      acknowledged_at: number | null;
      acknowledged_by: string | null;
      device_id: string;
      kind: string;
    }>();
  if (existing === null) return Response.json({ error: "not_found" }, { status: 404 });

  if (existing.acknowledged_at !== null) {
    return Response.json({
      ok: true,
      id,
      acknowledged_at: existing.acknowledged_at,
      acknowledged_by: existing.acknowledged_by,
    });
  }

  const acknowledgedAt = Date.now();
  const acknowledgedBy = actor?.label ?? null;
  const res = await env.DB.prepare(
    `UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ?
      WHERE id = ? AND acknowledged_at IS NULL`
  )
    .bind(acknowledgedAt, acknowledgedBy, id)
    .run();

  // Another request acknowledged between the read and the write. The winner's
  // actor and time are the truth; this call changed nothing and must not log.
  if (Number(res.meta?.changes ?? 0) === 0) {
    const current = await env.DB.prepare(
      `SELECT acknowledged_at, acknowledged_by FROM alerts WHERE id = ?`
    )
      .bind(id)
      .first<{ acknowledged_at: number | null; acknowledged_by: string | null }>();
    return Response.json({
      ok: true,
      id,
      acknowledged_at: current?.acknowledged_at ?? null,
      acknowledged_by: current?.acknowledged_by ?? null,
    });
  }

  await writeAudit(env, {
    action: "alert.acknowledged",
    actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
    subject: id,
    detail: {
      device_id: existing.device_id,
      kind: existing.kind,
      acknowledged_at: acknowledgedAt,
    },
  });

  return Response.json({
    ok: true,
    id,
    acknowledged_at: acknowledgedAt,
    acknowledged_by: acknowledgedBy,
  });
}
