/**
 * Invite policy — AUTH_PLAN §4.
 *
 * Policy, not protocol: this lives outside `src/auth/` on purpose. `src/auth/`
 * exposes the Better Auth mechanics (`requireRole`, the `/api/auth` mount);
 * invite-only registration, the bootstrap owner and the audit table are ours.
 *
 * An invite is a row with an email, a role, an expiry and a single use. The raw
 * token is returned exactly once, at creation, and only its SHA-256 is stored —
 * a database leak cannot be replayed against `POST /v1/auth/redeem`.
 */

import type { Env } from "../index";

export const INVITE_ROLES = ["owner", "admin", "member"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export interface InviteRow {
  id: string;
  email: string;
  role: InviteRole;
  expires_at: number;
  used_at: number | null;
  created_by: string | null;
  created_at: number;
}

/** Default 7 days, clamped to [60 s, 30 days]. */
export function clampInviteTtlSeconds(value: unknown): number {
  const fallback = 7 * 24 * 60 * 60;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(30 * 24 * 60 * 60, Math.max(60, Math.floor(n)));
}

/** Lowercase, trimmed, syntactic check. Returns null for anything unusable. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  // Deliberately loose: deliverability is the mail provider's problem, and a
  // stricter regex rejects valid addresses (plus-addressing, IDN) for no gain.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** SHA-256(token), hex. The only form an invite token is ever persisted in. */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** `dki_` + 32 random bytes, base64url. */
export function mintInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let b64 = "";
  for (const byte of bytes) b64 += String.fromCharCode(byte);
  return `dki_${btoa(b64).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

/**
 * Verify-only: is there a live, unused invite for this address?
 *
 * Used by the `databaseHooks.user.create.before` gate, which covers every
 * Better Auth-created user (magic link, passkey-first, future factors). The
 * consuming path is `POST /v1/auth/redeem`; this gate deliberately does not
 * burn the invite, so a failed creation elsewhere leaves it usable.
 */
export async function hasLiveInvite(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM invite
      WHERE email = ? AND used_at IS NULL AND expires_at > ?
      LIMIT 1`
  )
    .bind(email.toLowerCase(), Date.now())
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * Atomically consume an invite by token hash.
 *
 * ONE statement: the "unused and unexpired" decision and the write cannot be
 * separated by a concurrent redeem, so exactly one caller gets the row.
 */
export async function consumeInvite(
  env: Env,
  tokenHash: string,
  now: number
): Promise<{ id: string; email: string; role: InviteRole } | null> {
  const result = await env.DB.prepare(
    `UPDATE invite
        SET used_at = ?1
      WHERE token_hash = ?2
        AND used_at IS NULL
        AND expires_at > ?1
      RETURNING id, email, role`
  )
    .bind(now, tokenHash)
    .all<{ id: string; email: string; role: string }>();

  const row = result.results?.[0];
  if (!row) return null;
  const role = (INVITE_ROLES as readonly string[]).includes(row.role)
    ? (row.role as InviteRole)
    : "member";
  return { id: row.id, email: row.email, role };
}
