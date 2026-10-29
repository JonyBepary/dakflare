/**
 * Cookie minting for the two things Better Auth hands back as a value we must
 * put on the wire ourselves: a session we created server-side (invite
 * redemption) and, in `handler.ts`, the second-factor challenge cookie for a
 * passkey sign-in.
 *
 * Better Auth creates the rows; this turns an opaque token into the cookie the
 * rest of Better Auth (and therefore `requireRole`) already reads. The signing
 * is Better Auth's own scheme (`better-call`): value is
 * `token.<base64 HMAC-SHA256(secret, token)>`, URI-encoded, with the cookie
 * name and attributes taken from the live auth context so the `__Secure-`
 * prefix and SameSite policy cannot drift from the library's.
 */

import type { Env } from "../index";
import { getAuth } from "./settings";

const SESSION_SECONDS = 7 * 24 * 60 * 60;

interface CookieAttributes {
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string | boolean;
}

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

/**
 * `<name>=<signed value>; Max-Age=…` — the attributes come from the live auth
 * context, never from a literal here.
 */
export async function signedCookieHeader(
  env: Env,
  name: string,
  token: string,
  attributes: CookieAttributes,
  maxAgeSeconds: number
): Promise<string | null> {
  const secret = env.BETTER_AUTH_SECRET;
  if (secret === undefined || secret === "") return null;

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

  const parts = [`${name}=${value}`];
  if (maxAgeSeconds <= 0) parts.push("Max-Age=0");
  else parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  if (attributes.path) parts.push(`Path=${attributes.path}`);
  if (attributes.httpOnly) parts.push("HttpOnly");
  if (attributes.secure) parts.push("Secure");
  if (attributes.sameSite) {
    const sameSite = String(attributes.sameSite);
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`);
  }
  return parts.join("; ");
}

export async function sessionCookieHeader(
  env: Env,
  token: string,
  maxAgeSeconds: number = SESSION_SECONDS
): Promise<string | null> {
  const auth = getAuth(env);
  if (auth === null) return null;
  const ctx = await auth.$context;
  const cookie = ctx.authCookies.sessionToken;
  return signedCookieHeader(env, cookie.name, token, cookie.attributes, maxAgeSeconds);
}
