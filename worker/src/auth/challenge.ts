/**
 * Resolve the account behind a sign-in TOTP challenge.
 *
 * `/api/auth/two-factor/verify-totp` belongs to the plugin and takes only a
 * code: the account is carried by the signed `two_factor` cookie. The lockout
 * has to be keyed by the account's email, and the code has to be checked
 * *before* the plugin's per-challenge attempt budget writes a D1 row. So this
 * reads the same cookie the plugin will read, verifies the signature this Worker
 * put on it (`signedCookieHeader`, `session.ts`), follows the verification row
 * to the user, and decrypts the TOTP secret with the plugin's own primitives.
 *
 * This is deliberately not the authorization decision. A valid code still goes
 * through `auth.handler`, which consumes the challenge and mints the session; a
 * tampered cookie only fails to resolve, and the plugin then answers the request
 * exactly as it did before this module existed.
 */

import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { symmetricDecrypt } from "better-auth/crypto";
import type { Env } from "../index";
import { normalizeEmail } from "../lib/invites";
import { getAuth, TOTP_DIGITS, TOTP_PERIOD } from "./settings";

/** `twoFactor` table, as the plugin names it. */
const TWO_FACTOR_TABLE = "twoFactor";
const BASE32_PREFIX = "base32:";

export interface SignInChallenge {
  email: string;
  identifier: string;
  /** Decrypted secret, ready for the plugin's own `createOTP` verifier. */
  secret: string | Uint8Array;
}

interface TwoFactorRow {
  secret: string;
  verified: boolean | number;
}

/** Cookie values are `encodeURIComponent(token.base64(HMAC-SHA256(secret, token)))`. */
async function verifySignedValue(value: string, secret: string): Promise<string | null> {
  const decoded = decodeURIComponent(value);
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0 || dot === decoded.length - 1) return null;
  const token = decoded.slice(0, dot);
  const signature = decoded.slice(dot + 1);

  let bytes: Uint8Array;
  try {
    const binary = atob(signature);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(token));
  return ok ? token : null;
}

function readCookie(header: string | null, nameSuffix: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === nameSuffix || name.endsWith(`.${nameSuffix}`)) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * The account and secret this request is challenging, or `null` when there is
 * no valid sign-in challenge (a live-session verify, a forged cookie, an expired
 * row, or an enrolment that has not been confirmed yet).
 */
export async function resolveSignInChallenge(
  env: Env,
  req: Request
): Promise<SignInChallenge | null> {
  const secret = env.BETTER_AUTH_SECRET;
  if (secret === undefined || secret === "") return null;

  const raw = readCookie(req.headers.get("Cookie"), "two_factor");
  if (raw === null) return null;

  const identifier = await verifySignedValue(raw, secret);
  if (identifier === null) return null;

  const auth = getAuth(env);
  if (auth === null) return null;
  const ctx = await auth.$context;

  const verification = await ctx.internalAdapter.findVerificationValue(identifier);
  if (!verification) return null;
  const user = await ctx.internalAdapter.findUserById(verification.value);
  if (!user) return null;

  const email = normalizeEmail(user.email);
  if (email === null) return null;

  const row = await ctx.adapter.findOne<TwoFactorRow>({
    model: TWO_FACTOR_TABLE,
    where: [{ field: "userId", value: user.id }],
  });
  // The plugin refuses a sign-in verify before the enrolment is confirmed. Do
  // the same here: no secret to check means the plugin should answer, not us.
  if (row === null || !(row.verified === true || row.verified === 1)) return null;

  const decrypted = await symmetricDecrypt({ key: ctx.secretConfig, data: row.secret });
  const totpSecret = decrypted.startsWith(BASE32_PREFIX)
    ? base32.decode(decrypted.slice(BASE32_PREFIX.length).toUpperCase())
    : decrypted;

  return { email, identifier, secret: totpSecret };
}

/**
 * Check a code with the plugin's own TOTP parameters. This is the same
 * `createOTP(secret, { digits, period }).verify(code)` call the plugin makes;
 * doing it first means a wrong guess never reaches the plugin's D1-backed
 * per-challenge attempt counter.
 */
export async function verifyChallengeCode(challenge: SignInChallenge, code: unknown): Promise<boolean> {
  if (typeof code !== "string") return false;
  try {
    return await createOTP(challenge.secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD }).verify(code);
  } catch {
    return false;
  }
}
