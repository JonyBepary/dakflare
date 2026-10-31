/**
 * audit_log writer — AUTH_PLAN §5.
 *
 * One function, one table. Call sites pass what they know; nothing here reads a
 * request body, so a message body or a bearer token cannot reach the log by
 * accident. `detail` is for ids, roles, statuses and counts only.
 *
 * Every write is best-effort: an audit failure must never fail the action it
 * describes (a paired device is still paired if the log write loses a D1 race),
 * but it is logged so the gap is visible in `wrangler tail`.
 */

import type { Env } from "./index";

/** Who acted. `null` userId means a machine credential (ADMIN_TOKEN) or a device. */
export interface AuditActor {
  userId: string | null;
  /** Human-readable for the console: an email, "admin-token", "pairing-code". */
  label: string;
}

/**
 * The caller an admin route resolved to. `role: "machine"` is the ADMIN_TOKEN
 * path (legacy mode, or a CLI request in new mode); it is never a human login.
 *
 * `role: "agent"` is a `dkf_agt_` token. It is a third credential type, not a
 * fifth role: it carries no Better Auth account, so `userId` is null and the two
 * agent fields below are the only identity the send gate needs.
 */
export interface AdminActor extends AuditActor {
  role: "owner" | "admin" | "member" | "machine" | "agent";
  canGrantOwner: boolean;
  /** Set only when the credential was an agent token. */
  agentTokenId?: string;
  /** The handset that token is bound to, or null when it is fleet-wide. */
  agentDeviceId?: string | null;
}

export interface AuditEvent {
  /** Dotted, stable: "invite.created", "sign_in.failure", "device.paired". */
  action: string;
  actor?: AuditActor | null;
  /** The thing acted on: an invite id, user id, device id, rule id. */
  subject?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** JSON-serialisable metadata. NEVER a token, password, message body or phone number. */
  detail?: Record<string, unknown> | null;
}

/** Request metadata worth keeping, read from Cloudflare-set headers only. */
export function requestMeta(req: Request): { ip: string | null; userAgent: string | null } {
  const ip = req.headers.get("CF-Connecting-IP");
  const ua = req.headers.get("User-Agent");
  return {
    ip: ip !== null && ip !== "" ? ip : null,
    // Truncated: a User-Agent is attacker-controlled and unbounded.
    userAgent: ua === null ? null : ua.slice(0, 400),
  };
}

/** Insert one audit row. Never throws. */
export async function writeAudit(env: Env, event: AuditEvent): Promise<void> {
  try {
    let detail: string | null = null;
    if (event.detail !== undefined && event.detail !== null) {
      detail = JSON.stringify(event.detail).slice(0, 4_000);
    }
    await env.DB.prepare(
      `INSERT INTO audit_log (id, at, actor_user, actor_label, action, subject, ip, user_agent, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        event.actor?.userId ?? null,
        event.actor?.label ?? null,
        event.action,
        event.subject ?? null,
        event.ip ?? null,
        event.userAgent ?? null,
        detail
      )
      .run();
  } catch (error) {
    console.error(`[audit] write failed for ${event.action}: ${String(error)}`);
  }
}
