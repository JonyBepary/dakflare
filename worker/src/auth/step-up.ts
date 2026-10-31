/**
 * The sensitive-action grant — "a passkey was asserted in this session".
 *
 * `@better-auth/two-factor` 1.7.14 has no hook for a re-authentication proof:
 * `shouldRequirePassword` (`better-auth/dist/utils/password.mjs`) returns true
 * whenever a credential row exists, and enable/disable/generate-backup-codes
 * then call `ctx.password.verify` with whatever string arrived in `password`.
 * Feeding it a token would abuse the password verifier and still mean putting a
 * "password" field on the wire, so we do not. The plugin's own writes are made
 * from `totp-routes.ts` instead, after this grant.
 *
 * The grant is minted in `handler.ts` when `/passkey/verify-authentication`
 * succeeds, and is a signed cookie — no D1 row, so minting costs one HMAC:
 *
 *   v1.<userId>.<sessionId>.<expiry-ms>
 *
 * It is bound to BOTH the user and the session that the assertion created, so a
 * grant from another session (or another account) is refused even though the
 * signature is valid. Five minutes is the window; the route that spends it
 * expires the cookie.
 */

import type { Env } from "../index";
import { signedCookieHeader } from "./session";

export const STEP_UP_COOKIE = "dakflare_stepup";

/** Five minutes: long enough to scan a QR code, short enough to be "just now". */
export const STEP_UP_SECONDS = 5 * 60;

interface CookieAttributes {
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string | boolean;
}

/** Read one cookie value from the request's `Cookie` header. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Mint the grant cookie for a session a passkey assertion just created.
 *
 * Attributes are the live session cookie's (path, Secure, SameSite), so the
 * grant cannot outlive or out-scope the session it is bound to.
 */
export async function mintStepUpCookie(
  env: Env,
  attributes: CookieAttributes,
  userId: string,
  sessionId: string
): Promise<string | null> {
  if (userId === "" || sessionId === "") return null;
  const expiry = Date.now() + STEP_UP_SECONDS * 1000;
  const payload = `v1.${userId}.${sessionId}.${expiry}`;
  return await signedCookieHeader(
    env,
    STEP_UP_COOKIE,
    payload,
    { ...attributes, path: "/" },
    STEP_UP_SECONDS
  );
}

/** The `Max-Age=0` cookie that spends the grant. */
export function expiredStepUpCookie(secure: boolean): string {
  return `${STEP_UP_COOKIE}=; Max-Age=0; Path=/${secure ? "; Secure" : ""}`;
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

/** Fixed-length XOR compare, for the signature. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * True when this request carries a grant minted for exactly this user and this
 * session, and it has not expired. Anything malformed is simply false.
 */
export async function verifyStepUp(
  req: Request,
  env: Env,
  userId: string,
  sessionId: string
): Promise<boolean> {
  const secret = env.BETTER_AUTH_SECRET;
  if (secret === undefined || secret === "" || sessionId === "") return false;

  const raw = readCookie(req, STEP_UP_COOKIE);
  if (raw === undefined || raw === "") return false;

  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return false;
  }

  const split = value.lastIndexOf(".");
  if (split <= 0 || split === value.length - 1) return false;
  const payload = value.slice(0, split);

  let provided: Uint8Array;
  try {
    const binary = atob(value.slice(split + 1));
    provided = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) provided[i] = binary.charCodeAt(i);
  } catch {
    return false;
  }

  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(provided, expected)) return false;

  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const [, grantUser, grantSession, rawExpiry] = parts;
  if (grantUser !== userId || grantSession !== sessionId) return false;

  const expiry = Number(rawExpiry);
  return Number.isFinite(expiry) && expiry > Date.now();
}
