/**
 * Account creation from an invite, and session introspection.
 *
 * `POST /v1/auth/redeem` is the only end-user registration path in this phase.
 * It consumes a single-use invite atomically, creates the user with the role the
 * invite carries, and issues a session so the console can immediately enrol the
 * first passkey (`/api/auth/passkey/generate-register-options`). There is no
 * password and no public sign-up: without a live invite this answers 403.
 *
 * The error is deliberately generic ("invite_invalid") for unknown, expired and
 * already-used tokens alike — the redeem endpoint must not become a way to probe
 * which invites exist.
 */

import { issueSessionCookie, requireRole } from "../auth";
import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { authMode, MAX_BODY_BYTES, passwordMode } from "../lib/config";
import { consumeInvite, hashInviteToken } from "../lib/invites";

export async function handleRedeemInvite(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `redeem:${ip}` });
    if (!success) return err("rate_limited", 429);
  }

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const token = parsed.value.token;
  if (typeof token !== "string" || token.length < 16 || token.length > 512) {
    return err("bad_request", 400);
  }

  if (env.BETTER_AUTH_SECRET === undefined || env.BETTER_AUTH_SECRET === "") {
    return Response.json({ error: "auth_unavailable" }, { status: 503 });
  }

  const now = Date.now();
  const invite = await consumeInvite(env, await hashInviteToken(token), now);
  if (invite === null) {
    await writeAudit(env, {
      action: "invite.redeem_failed",
      actor: { userId: null, label: "anonymous" },
      detail: { reason: "invalid_or_expired" },
      ...requestMeta(req),
    });
    return Response.json({ error: "invite_invalid" }, { status: 403 });
  }

  const existing = await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
    .bind(invite.email)
    .first<{ id: string }>();
  if (existing !== null) {
    // The invite is already consumed above. That is intentional: a token handed
    // to an address that already registered must not stay live for a retry.
    return Response.json({ error: "already_registered" }, { status: 409 });
  }

  const userId = crypto.randomUUID();
  const name = invite.email.split("@")[0] || invite.email;
  const isoTimestamp = new Date(now).toISOString();

  // Better Auth's own tables, written with its column names and its SQLite date
  // encoding (ISO-8601 text). No credential row: passkeys are enrolled next.
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt", "twoFactorEnabled", role)
     VALUES (?, ?, ?, 1, NULL, ?, ?, 0, ?)`
  )
    .bind(userId, name, invite.email, isoTimestamp, isoTimestamp, invite.role)
    .run();

  const meta = requestMeta(req);
  const session = await issueSessionCookie(env, userId, meta);
  if (!session.ok) {
    return Response.json({ error: session.error }, { status: session.status });
  }

  const actor = { userId, label: invite.email };
  await writeAudit(env, {
    action: "invite.redeemed",
    actor,
    subject: invite.id,
    detail: { email: invite.email, role: invite.role },
    ...meta,
  });
  await writeAudit(env, {
    action: "sign_in.success",
    actor,
    subject: userId,
    detail: { factor: "invite" },
    ...meta,
  });

  return Response.json(
    {
      ok: true,
      user: { id: userId, email: invite.email, name, role: invite.role },
      expires_at: session.expiresAt,
    },
    { headers: { "Set-Cookie": session.cookie } }
  );
}

/** `GET /v1/auth/me` — who this session is, and which auth mode is live. */
export async function handleAuthMe(req: Request, env: Env): Promise<Response> {
  const guard = await requireRole(req, env, "read", { fresh: true });
  if (!guard.ok) return guard.response;
  return Response.json({
    ok: true,
    user: guard.user,
    expires_at: guard.expiresAt,
    auth_mode: authMode(env),
  });
}

/**
 * `GET /v1/auth/mode` — the pre-auth probe the login page needs.
 *
 * The console cannot read `/v1/admin/health` before it has a session, so it used
 * to render the token form first and only discover the deployment's auth mode
 * afterwards. This endpoint answers that question with configuration only:
 * enums and booleans, never a count, a secret, a device id or anything derived
 * from an email. It accepts no body and reads no query parameter, so it cannot
 * be turned into an account oracle.
 *
 * Rate-limited with the existing ADMIN_LIMITER, keyed per IP: the response is
 * cheap and identical for everyone, but an unauthenticated endpoint should still
 * have a budget rather than invite scripted polling.
 */
export async function handleAuthMode(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `auth-mode:${ip}` });
    if (!success) return err("rate_limited", 429);
  }

  return Response.json({
    auth_mode: authMode(env),
    auth_configured: Boolean(env.BETTER_AUTH_SECRET),
    password_mode: passwordMode(env),
    password_configured:
      typeof env.AUTH_PEPPER === "string" && env.AUTH_PEPPER.trim() !== "",
    // Magic links are not mounted in this phase: there is no mail provider
    // binding, so advertising the factor would send the login page to a route
    // that cannot deliver a link.
    magic_link: false,
  });
}
