/**
 * `POST /v1/admin/auth/reset-user` — recovery for an account that cannot sign in.
 *
 * The lockout this exists for: an invite is redeemed, a session is issued, the
 * browser never finishes passkey enrolment, and the session is later lost. The
 * address now has a user, so `auth invite` refuses it (`already_registered`) and
 * `auth bootstrap` refuses it too. Without this route the only way back is a
 * manual D1 delete.
 *
 * ADMIN_TOKEN only, never a session cookie: it is the machine credential, and it
 * is exactly the credential a locked-out operator still holds. It deletes the
 * account's sessions, credential rows and passkeys, then mints a fresh owner
 * invite for the same address. Nothing is preserved except the audit trail.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import {
  clampInviteTtlSeconds,
  hashInviteToken,
  mintInviteToken,
  normalizeEmail,
} from "../lib/invites";

export async function handleResetUser(req: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const email = normalizeEmail(parsed.value.email);
  if (email === null) return err("bad_request", 400);

  const user = await env.DB.prepare(`SELECT id, role FROM "user" WHERE email = ?`)
    .bind(email)
    .first<{ id: string; role: string }>();
  if (user === null) {
    return Response.json({ error: "not_registered" }, { status: 404 });
  }

  // Order matters: children before the parent, so a partial failure leaves the
  // account intact rather than orphaned rows.
  await env.DB.prepare(`DELETE FROM session WHERE userId = ?`).bind(user.id).run();
  await env.DB.prepare(`DELETE FROM account WHERE userId = ?`).bind(user.id).run();
  await env.DB.prepare(`DELETE FROM passkey WHERE userId = ?`).bind(user.id).run();
  await env.DB.prepare(`DELETE FROM twoFactor WHERE userId = ?`).bind(user.id).run();
  await env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(user.id).run();

  // Any unspent invite for the address is stale by definition; replace it.
  await env.DB.prepare(`DELETE FROM invite WHERE email = ? AND used_at IS NULL`)
    .bind(email)
    .run();

  const role = user.role === "owner" || user.role === "admin" || user.role === "member"
    ? user.role
    : "member";
  const ttlSeconds = clampInviteTtlSeconds(parsed.value.expires_in_s);
  const token = mintInviteToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;

  await env.DB.prepare(
    `INSERT INTO invite (id, email, role, token_hash, expires_at, used_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`
  )
    .bind(id, email, role, await hashInviteToken(token), expiresAt, now)
    .run();

  await writeAudit(env, {
    action: "user.reset",
    actor: { userId: null, label: "admin-token" },
    subject: user.id,
    detail: { email, role, sessions: "deleted", invite: id },
    ...requestMeta(req),
  });

  return Response.json({ ok: true, id, email, role, expires_at: expiresAt, token });
}
