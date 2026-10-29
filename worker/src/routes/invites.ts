/**
 * Invite administration — AUTH_PLAN §4.
 *
 * An owner (or ADMIN_TOKEN in the legacy/machine path) mints an invite for an
 * email. The response is the only time the raw token exists outside the
 * invitee's hands; the database stores only its hash. There is no public
 * registration endpoint and no way to create an account without one of these
 * rows (or the bootstrap owner).
 */

import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { forbidden } from "../auth";
import type { Env } from "../index";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import {
  INVITE_ROLES,
  clampInviteTtlSeconds,
  hashInviteToken,
  mintInviteToken,
  normalizeEmail,
} from "../lib/invites";
import type { InviteRole } from "../lib/invites";

interface InviteSummary {
  id: string;
  email: string;
  role: string;
  expires_at: number;
  used_at: number | null;
  created_by: string | null;
  created_at: number;
}

/** `POST /v1/admin/invites` — create a single-use invite. */
export async function handleCreateInvite(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const email = normalizeEmail(parsed.value.email);
  if (email === null) return err("bad_request", 400);

  const rawRole = parsed.value.role;
  const role: InviteRole =
    rawRole === undefined || rawRole === null
      ? "member"
      : typeof rawRole === "string" && (INVITE_ROLES as readonly string[]).includes(rawRole)
        ? (rawRole as InviteRole)
        : "member";
  if (rawRole !== undefined && rawRole !== null && role !== rawRole) return err("bad_request", 400);

  // Only an owner may mint another owner. An admin token counts as an owner
  // (it is the bootstrap credential), a session-backed admin does not.
  if (role === "owner" && !actor.canGrantOwner) return forbidden();

  // An invite for someone who already has an account is a no-op at redeem time;
  // refusing here keeps the list honest.
  const existing = await env.DB.prepare(`SELECT 1 AS ok FROM "user" WHERE email = ?`)
    .bind(email)
    .first<{ ok: number }>();
  if (existing !== null) {
    return Response.json({ error: "already_registered" }, { status: 409 });
  }

  const ttlSeconds = clampInviteTtlSeconds(parsed.value.expires_in_s);
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const token = mintInviteToken();
  const id = crypto.randomUUID();
  const actorUserId = actor.userId;
  const actorLabel = actor.label;

  await env.DB.prepare(
    `INSERT INTO invite (id, email, role, token_hash, expires_at, used_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(id, email, role, await hashInviteToken(token), expiresAt, actorUserId, now)
    .run();

  await writeAudit(env, {
    action: "invite.created",
    actor: { userId: actorUserId, label: actorLabel },
    subject: id,
    detail: { email, role, expires_at: expiresAt },
  });

  // The raw token appears here and nowhere else, ever.
  return Response.json({ id, email, role, expires_at: expiresAt, token });
}

/** `GET /v1/admin/invites` — pending and spent invites (never the token hash). */
export async function handleListInvites(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, email, role, expires_at, used_at, created_by, created_at
       FROM invite
      ORDER BY created_at DESC
      LIMIT 200`
  ).all<InviteSummary>();
  return Response.json({ invites: rows.results ?? [], now: Date.now() });
}

/** `DELETE /v1/admin/invites/:id` — revoke an unspent invite. */
export async function handleDeleteInvite(
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  if (!id) return err("bad_request", 400);
  const result = await env.DB.prepare(`DELETE FROM invite WHERE id = ?`).bind(id).run();
  const deleted = Number(result.meta?.changes ?? 0);
  if (deleted === 0) return Response.json({ error: "not_found" }, { status: 404 });

  await writeAudit(env, {
    action: "invite.revoked",
    actor: {
      userId: actor.userId,
      label: actor.label,
    },
    subject: id,
  });
  return Response.json({ ok: true, deleted });
}
