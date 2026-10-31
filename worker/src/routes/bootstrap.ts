/**
 * `POST /v1/admin/bootstrap` — the first owner, for `dakflare` (AUTH_PLAN §4).
 *
 * ADMIN_TOKEN only: this route never accepts a session cookie, because its whole
 * purpose is to exist before any user does.
 *
 * It mints an **owner invite** rather than creating a user. A user created here
 * would have no credential and, once `AUTH_MODE=new`, no way to obtain one — the
 * console has no password field by design and `state` invites refuse an address
 * that already has an account. One path in instead: redeem the invite, create the
 * account, enrol a passkey.
 *
 * Refused once an owner exists in `AUTH_MODE=new`, so a leaked machine token
 * cannot mint a second owner after the ladder is live.
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

export async function handleBootstrap(req: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const email = normalizeEmail(parsed.value.email);
  if (email === null) return err("bad_request", 400);

  // One owner per deployment, always: there is no legacy mode in which a second
  // bootstrap could quietly mint a second full-admin credential.
  const owner = await env.DB.prepare(
    `SELECT 1 AS ok FROM "user" WHERE role = 'owner' LIMIT 1`
  ).first<{ ok: number }>();
  if (owner !== null) {
    return Response.json({ error: "owner_exists" }, { status: 409 });
  }

  // An address that already has an account cannot bootstrap again — it already
  // exists and needs an invite from an owner, not a second identity.
  const existing = await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
    .bind(email)
    .first<{ id: string }>();
  if (existing !== null) {
    return Response.json({ error: "already_registered", id: existing.id }, { status: 409 });
  }

  // A rerun means "give me a working link". Only the hash of a token is stored,
  // so an earlier open invite cannot be re-shown — it is replaced instead, which
  // also revokes a link that may have leaked before the operator used it.
  await env.DB.prepare(
    `DELETE FROM invite WHERE email = ? AND role = 'owner' AND used_at IS NULL`
  )
    .bind(email)
    .run();

  const ttlSeconds = clampInviteTtlSeconds(parsed.value.expires_in_s);
  const token = mintInviteToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;

  await env.DB.prepare(
    `INSERT INTO invite (id, email, role, token_hash, expires_at, used_at, created_by, created_at)
     VALUES (?, ?, 'owner', ?, ?, NULL, NULL, ?)`
  )
    .bind(id, email, await hashInviteToken(token), expiresAt, now)
    .run();

  await writeAudit(env, {
    action: "invite.bootstrap",
    actor: { userId: null, label: "admin-token" },
    subject: id,
    detail: { email, role: "owner", auth_mode: "new", expires_at: expiresAt },
    ...requestMeta(req),
  });

  // The raw token appears here and nowhere else, ever.
  return Response.json({ ok: true, id, email, role: "owner", expires_at: expiresAt, token });
}
