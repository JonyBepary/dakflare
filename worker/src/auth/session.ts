/**
 * Session cookie minting for sessions we create server-side.
 *
 * Better Auth creates the session row; this turns its opaque token into the
 * cookie the rest of Better Auth (and therefore `requireRole`) already reads.
 * The signing is Better Auth's own scheme (`better-call`): value is
 * `token.<base64 HMAC-SHA256(secret, token)>`, URI-encoded, with the cookie
 * name and attributes taken from the live auth context so the `__Secure-`
 * prefix and SameSite policy cannot drift from the library's.
 */

import type { Env } from "../index";
import { getAuth } from "./settings";

const SESSION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Create a session row for a user we just created (invite redemption).
 *
 * Better Auth owns the row shape, token generation and expiry, so this goes
 * through its internal adapter rather than inserting into `session` by hand.
 */
export async function createSessionForUser(
  env: Env,
  userId: string,
  meta: { ip: string | null; userAgent: string | null }
): Promise<{ token: string; expiresAt: number } | null> {
  const auth = getAuth(env);
  if (auth === null) return null;
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false, {
    ipAddress: meta.ip ?? "",
    userAgent: meta.userAgent ?? "",
  });
  if (!session) return null;
  return {
    token: session.token,
    expiresAt: new Date(session.expiresAt).getTime(),
  };
}

export async function sessionCookieHeader(
  env: Env,
  token: string,
  maxAgeSeconds: number = SESSION_SECONDS
): Promise<string | null> {
  const auth = getAuth(env);
  const secret = env.BETTER_AUTH_SECRET;
  if (auth === null || secret === undefined || secret === "") return null;

  const ctx = await auth.$context;
  const cookie = ctx.authCookies.sessionToken;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token))
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  const value = encodeURIComponent(`${token}.${btoa(binary)}`);

  const attrs = cookie.attributes;
  const parts = [`${cookie.name}=${value}`, `Max-Age=${Math.floor(maxAgeSeconds)}`];
  if (attrs.path) parts.push(`Path=${attrs.path}`);
  if (attrs.httpOnly) parts.push("HttpOnly");
  if (attrs.secure) parts.push("Secure");
  if (attrs.sameSite) {
    const sameSite = String(attrs.sameSite);
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`);
  }
  return parts.join("; ");
}
