/**
 * `GET /v1/admin/audit` — the Audit page's data source (AUTH_PLAN §5).
 *
 * Read-only, bounded, and row-shaped exactly as stored. `detail_json` is parsed
 * for the caller so the console does not have to; nothing else is transformed.
 */

import type { Env } from "../index";

interface AuditRow {
  id: string;
  at: number;
  actor_user: string | null;
  actor_label: string | null;
  action: string;
  subject: string | null;
  ip: string | null;
  user_agent: string | null;
  detail_json: string | null;
}

export async function handleAuditList(env: Env, requestUrl: URL): Promise<Response> {
  const rawLimit = Number(requestUrl.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 100;

  const action = requestUrl.searchParams.get("action");
  const actor = requestUrl.searchParams.get("actor");
  const beforeRaw = Number(requestUrl.searchParams.get("before"));
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (action !== null && action !== "") {
    where.push(`action = ?`);
    binds.push(action);
  }
  if (actor !== null && actor !== "") {
    where.push(`(actor_user = ? OR actor_label = ?)`);
    binds.push(actor, actor);
  }
  if (before !== null) {
    where.push(`at < ?`);
    binds.push(before);
  }

  const sql = `SELECT id, at, actor_user, actor_label, action, subject, ip, user_agent, detail_json
                 FROM audit_log
                ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                ORDER BY at DESC
                LIMIT ?`;

  const rows = await env.DB.prepare(sql)
    .bind(...binds, limit)
    .all<AuditRow>();

  const events = (rows.results ?? []).map((row) => ({
    ...row,
    detail: row.detail_json === null ? null : safeParse(row.detail_json),
  }));

  return Response.json({ events, limit });
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
