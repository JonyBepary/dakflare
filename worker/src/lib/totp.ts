/**
 * Deployment TOTP verification, shared by MCP elicitation and the Worker-to-
 * Worker endpoint the split agent Worker calls. No MCP imports: the main
 * Worker can expose this without pulling the MCP SDK into its bundle.
 */

import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { coreFetch } from "./core";
import { getAuth, TOTP_DIGITS, TOTP_PERIOD } from "../auth/settings";
import {
  checkAuthLockout,
  clearAuthFailures,
  recordAuthFailure,
} from "./auth-limits";

/* ──────────────────────────────── TOTP ──────────────────────────────── */

interface TwoFactorSecretRow {
  userId: string;
  secret: string;
}

/**
 * The account whose TOTP code authorises this deployment.
 *
 * A human actor is checked against their own row. An agent token has no
 * account, so the owner (then an admin) with TOTP enabled stands in for "the
 * deployment approved this". No such account means no valid answer.
 */
async function findTotpSecret(env: Env, actor: AdminActor): Promise<TwoFactorSecretRow | null> {
  if (actor.userId !== null) {
    const row = await env.DB.prepare(
      `SELECT t."userId" AS userId, t.secret AS secret
         FROM "twoFactor" t
         JOIN "user" u ON u.id = t."userId"
        WHERE t."userId" = ? AND u."twoFactorEnabled" = 1
        LIMIT 1`
    )
      .bind(actor.userId)
      .first<TwoFactorSecretRow>();
    return row ?? null;
  }

  const row = await env.DB.prepare(
    `SELECT t."userId" AS userId, t.secret AS secret
       FROM "twoFactor" t
       JOIN "user" u ON u.id = t."userId"
      WHERE u."twoFactorEnabled" = 1 AND u.role IN ('owner', 'admin')
      ORDER BY CASE u.role WHEN 'owner' THEN 0 ELSE 1 END, u."createdAt" ASC
      LIMIT 1`
  ).first<TwoFactorSecretRow>();
  return row ?? null;
}

/**
 * Check a code with the plugin's own parameters.
 *
 * The decryption path is the one `auth/challenge.ts` uses: `symmetricDecrypt`
 * with the Better Auth context's secret config, then the `base32:` prefix is
 * decoded. Verification is `createOTP(secret, { digits, period }).verify`, the
 * same call the two-factor plugin makes.
 */
const RECENT_TOTP_USES = new Map<string, number>();

function isRecentTotpReuse(key: string, now: number): boolean {
  for (const [entryKey, expiresAt] of RECENT_TOTP_USES) {
    if (expiresAt <= now) RECENT_TOTP_USES.delete(entryKey);
  }
  const existing = RECENT_TOTP_USES.get(key);
  return existing !== undefined && existing > now;
}

function markTotpUsed(key: string, now: number): void {
  if (RECENT_TOTP_USES.size >= 256) {
    const oldest = RECENT_TOTP_USES.keys().next();
    if (!oldest.done) RECENT_TOTP_USES.delete(oldest.value);
  }
  RECENT_TOTP_USES.set(key, now + TOTP_PERIOD * 1000 * 3);
}

export async function verifyDeploymentTotp(env: Env, actor: AdminActor, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;

  // The split agent Worker has no BETTER_AUTH_SECRET/AUTH_GUARD. Its CORE
  // binding asks the main Worker to perform the same check.
  if (env.CORE !== undefined) {
    const answer = await coreFetch(env, "/v1/admin/agent/totp", {
      method: "POST",
      body: { actor, code },
    });
    if (!answer.ok) return false;
    const body = (await answer.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  }

  const auth = getAuth(env);
  if (auth === null) return false;

  const row = await findTotpSecret(env, actor);
  if (row === null) return false;

  const now = Date.now();
  const lockoutEmail = `mcp-totp:${row.userId}`;
  const before = await checkAuthLockout(env, { email: lockoutEmail, ip: "mcp" });
  if (before.locked) return false;

  const replayKey = `${row.userId}:${code}`;
  if (isRecentTotpReuse(replayKey, now)) return false;

  try {
    const ctx = await auth.$context;
    const decrypted = await symmetricDecrypt({ key: ctx.secretConfig, data: row.secret });
    const secret = decrypted.startsWith("base32:")
      ? base32.decode(decrypted.slice("base32:".length).toUpperCase())
      : decrypted;
    const ok = await createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD }).verify(code);
    if (!ok) {
      await recordAuthFailure(env, { email: lockoutEmail, ip: "mcp" });
      return false;
    }
    markTotpUsed(replayKey, now);
    await clearAuthFailures(env, lockoutEmail);
    return true;
  } catch {
    // A malformed row or a rotated secret is a failed verification, never a
    // pass and never a 500 that tells the caller which part broke.
    return false;
  }
}

