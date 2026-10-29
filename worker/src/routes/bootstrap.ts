/**
 * `POST /v1/admin/bootstrap` — the first owner, for `dakflare init` (AUTH_PLAN §4).
 *
 * ADMIN_TOKEN only: this route never accepts a session cookie, because its whole
 * purpose is to exist before any user does. It creates a user with `role=owner`
 * and NO credential; the owner then enrols a passkey from the console. Refused
 * once an owner exists in `AUTH_MODE=new`, so a leaked machine token cannot mint
 * a second owner after the ladder is live.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { authMode, MAX_BODY_BYTES } from "../lib/config";
import { normalizeEmail } from "../lib/invites";

export async function handleBootstrap(req: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const email = normalizeEmail(parsed.value.email);
  if (email === null) return err("bad_request", 400);

  const rawName = parsed.value.name;
  const name =
    typeof rawName === "string" && rawName.trim() !== ""
      ? rawName.trim().slice(0, 120)
      : email.split("@")[0] || email;

  if (authMode(env) === "new") {
    const owner = await env.DB.prepare(
      `SELECT 1 AS ok FROM "user" WHERE role = 'owner' LIMIT 1`
    ).first<{ ok: number }>();
    if (owner !== null) {
      return Response.json({ error: "owner_exists" }, { status: 409 });
    }
  }

  const existing = await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
    .bind(email)
    .first<{ id: string }>();
  if (existing !== null) {
    return Response.json({ error: "already_registered", id: existing.id }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt", "twoFactorEnabled", role)
     VALUES (?, ?, ?, 1, NULL, ?, ?, 0, 'owner')`
  )
    .bind(id, name, email, now, now)
    .run();

  await writeAudit(env, {
    action: "user.bootstrap",
    actor: { userId: null, label: "admin-token" },
    subject: id,
    detail: { email, role: "owner", auth_mode: authMode(env) },
    ...requestMeta(req),
  });

  return Response.json({ ok: true, user: { id, email, name, role: "owner" } });
}
