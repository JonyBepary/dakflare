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
  const category = requestUrl.searchParams.get("category")?.trim().toLowerCase() ?? "";
  const query = requestUrl.searchParams.get("q")?.trim() ?? "";
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
  if (category !== "") {
    const categoryClauses: Record<string, string> = {
      auth: `(action LIKE 'auth.%' OR action LIKE 'sign_in.%' OR action LIKE 'totp.%' OR action LIKE 'password.%' OR action LIKE 'invite.%' OR action LIKE 'magic.%' OR action LIKE 'user.%')`,
      device: `action LIKE 'device.%'`,
      message: `(action LIKE 'message.%' OR action LIKE 'sms.%' OR action LIKE 'channel.%')`,
      automation: `(action LIKE 'rule.%' OR action LIKE 'workflow.%' OR action LIKE 'workflows.%' OR action LIKE 'flow.%')`,
      agent: `(action LIKE 'agent.%' OR action LIKE 'agent_token.%' OR action LIKE 'authority.%' OR action LIKE 'ai.%' OR action LIKE 'webhook.%' OR action LIKE 'mcp.%')`,
      security: `(action LIKE 'pepper.%' OR action LIKE 'totp.%' OR action LIKE 'auth.lockout%' OR action LIKE 'authority.%' OR action LIKE 'agent_token.%' OR action LIKE 'password.%')`,
    };
    const clause = categoryClauses[category];
    if (clause !== undefined) where.push(clause);
  }
  if (query !== "") {
    const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(
      `(action LIKE ? ESCAPE '\\' OR COALESCE(subject, '') LIKE ? ESCAPE '\\' OR COALESCE(actor_label, '') LIKE ? ESCAPE '\\')`
    );
    binds.push(escaped, escaped, escaped);
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
