/**
 * TOTP management behind re-authentication — the fix for the password gate.
 *
 * `@better-auth/two-factor` 1.7.14 (pinned in `worker/package.json`) gates
 * `/two-factor/enable`, `/two-factor/disable` and `/two-factor/generate-backup-codes`
 * on `shouldRequirePassword` (`better-auth/dist/utils/password.mjs`): if the
 * account has a credential row, the endpoint demands the account password and
 * answers `INVALID_PASSWORD` without it. `allowPasswordless` does not change
 * that — it only makes the `password` field optional in the zod schema.
 *
 * The plugin exposes no hook for a re-authentication token, so these routes do
 * the plugin's work themselves, behind `requireRole({ fresh: true })` plus:
 *
 *   enable      a passkey assertion in THIS session (there is no TOTP code yet)
 *   disable     a current TOTP code, checked by the plugin's own verify-totp
 *   regenerate  a current TOTP code, checked the same way
 *
 * No route reads a `password` field, under either password mode. The Worker
 * therefore never sees a plaintext password to change a factor, and no route
 * runs PBKDF2: the step-up grant is one HMAC, and a code check is one HMAC-SHA1.
 *
 * What still belongs to the plugin, called rather than re-implemented:
 *   - the secret: `generateRandomString(32)`, encrypted with `symmetricEncrypt`
 *     exactly as `two-factor/index.mjs` does;
 *   - the `otpauth://` URI and the 6-digit/30-second window: `createOTP` from
 *     `@better-auth/utils/otp` 0.5.1 (the plugin's own dependency, imported at
 *     the same version better-auth 1.7.14 resolves);
 *   - the recovery-code set: the plugin's `generateRandomString(10, "a-z",
 *     "0-9", "A-Z")` pairs, JSON-encoded and `symmetricEncrypt`ed into the same
 *     `twoFactor.backupCodes` column;
 *   - the row shape (`twoFactor` table: secret, backupCodes, verified, userId)
 *     and `user.twoFactorEnabled`;
 *   - the verification of every code shown to this route: `auth.api.verifyTOTP`,
 *     which owns decryption, the window and the attempt accounting;
 *   - the enrolment confirmation: the console still posts the first code to
 *     `/api/auth/two-factor/verify-totp`, which flips `verified` to true and
 *     sets `user.twoFactorEnabled`. That endpoint is not password-gated.
 *
 * Pinned to better-auth 1.7.14. If the plugin changes the secret/backup-code
 * format, this file and `settings.ts`'s TOTP constants must move with it — the
 * comment above each call names the plugin source it mirrors.
 */

import {
  generateRandomString,
  symmetricEncrypt,
  type SecretConfig,
} from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import { requireRole } from "./guard";
import { getAuth, TOTP_DIGITS, TOTP_ISSUER, TOTP_PERIOD } from "./settings";
import { expiredStepUpCookie, verifyStepUp } from "./step-up";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: Record<string, unknown>, status = 200, headers: HeadersInit = NO_STORE): Response {
  return Response.json(body, { status, headers });
}

/** The plugin's table name (`twoFactor`), not a local invention. */
const TWO_FACTOR_TABLE = "twoFactor";

interface TwoFactorRow {
  id: string;
  secret: string;
  backupCodes: string;
  verified: boolean | number;
}

/**
 * The plugin's recovery-code set, byte for byte
 * (`two-factor/backup-codes/index.mjs`, `generateBackupCodesFn`):
 * ten codes, ten characters each, `xxxxx-xxxxx`, then one `symmetricEncrypt` of
 * the JSON array into `backupCodes`. The console shows them once; nothing here
 * stores a plaintext copy.
 */
function newBackupCodes(): string[] {
  return Array.from({ length: 10 })
    .map(() => generateRandomString(10, "a-z", "0-9", "A-Z"))
    .map((code) => `${code.slice(0, 5)}-${code.slice(5)}`);
}

async function encryptBackupCodes(secretConfig: string | SecretConfig, codes: string[]): Promise<string> {
  return await symmetricEncrypt({ key: secretConfig, data: JSON.stringify(codes) });
}

type AuthContext = Awaited<NonNullable<ReturnType<typeof getAuth>>["$context"]>;

/** The plugin's row, or `null`. `verified` is stored as 0/1 by D1. */
async function findRow(ctx: AuthContext, userId: string): Promise<TwoFactorRow | null> {
  return await ctx.adapter.findOne<TwoFactorRow>({
    model: TWO_FACTOR_TABLE,
    where: [{ field: "userId", value: userId }],
  });
}

/** A TOTP-enabled row that is still awaiting its first code is not "on". */
function isVerified(row: TwoFactorRow | null): boolean {
  return row !== null && (row.verified === true || row.verified === 1);
}

function expiredCookie(name: string, secure: boolean): string {
  return `${name}=; Max-Age=0; Path=/${secure ? "; Secure" : ""}`;
}

/**
 * A plaintext password is not a proof for these routes, under either mode.
 * Refusing the field explicitly (rather than ignoring it) makes the contract
 * testable: a caller that reaches for the plugin's old workaround gets a named
 * error, and no password is ever read into a variable here.
 */
function rejectPassword(body: Record<string, unknown>): Response | null {
  if (body.password === undefined) return null;
  return json(
    {
      error: "password_not_accepted",
      detail: "TOTP changes are confirmed by a passkey assertion or a current code; no password is accepted.",
    },
    400
  );
}

/* ------------------------------------------------------------------------- */
/* GET /v1/auth/totp                                                         */
/* ------------------------------------------------------------------------- */

/**
 * The console's probe. `get-totp-uri` cannot serve this: it is password-gated
 * for exactly the accounts this page is about, and it returns the secret, which
 * the console never needs again after enrolment. Two booleans, read from D1
 * behind a fresh session.
 */
export async function handleTotpStatus(req: Request, env: Env): Promise<Response> {
  const guard = await requireRole(req, env, ["owner", "admin", "member"], { fresh: true });
  if (!guard.ok) return guard.response;

  const auth = getAuth(env);
  if (auth === null) return json({ error: "auth_unavailable" }, 503);

  const ctx = await auth.$context;
  const row = await findRow(ctx, guard.user.id);
  return json({
    enabled: guard.user.twoFactorEnabled,
    verified: isVerified(row),
    secret_set: row !== null,
  });
}

/* ------------------------------------------------------------------------- */
/* POST /v1/auth/totp/enable                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Start (or restart) enrolment. A passkey assertion is the proof: the grant is
 * minted by `handler.ts` from `/passkey/verify-authentication` and bound to the
 * session that assertion created.
 *
 * The work is the plugin's `enableTwoFactor` with the password check removed:
 * same secret length, same encryption, same URI builder, same `verified: false`
 * row. The first code is still confirmed by the plugin's `verify-totp`, so an
 * abandoned enrolment never turns the factor on.
 */
export async function handleTotpEnable(req: Request, env: Env): Promise<Response> {
  const guard = await requireRole(req, env, ["owner", "admin", "member"], { fresh: true });
  if (!guard.ok) return guard.response;

  const auth = getAuth(env);
  if (auth === null) return json({ error: "auth_unavailable" }, 503);

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);
  const withPassword = rejectPassword(parsed.value);
  if (withPassword !== null) return withPassword;

  if (!(await verifyStepUp(req, env, guard.user.id, guard.user.sessionId))) {
    await writeAudit(env, {
      action: "totp.enable_refused",
      actor: { userId: guard.user.id, label: guard.user.email },
      subject: guard.user.id,
      detail: { reason: "reauth_required" },
      ...requestMeta(req),
    });
    return json({ error: "reauth_required" }, 403);
  }

  const ctx = await auth.$context;
  const existing = await findRow(ctx, guard.user.id);
  if (guard.user.twoFactorEnabled || isVerified(existing)) {
    return json({ error: "totp_already_enabled" }, 409);
  }

  // `two-factor/index.mjs`: generateRandomString(32), then symmetricEncrypt with
  // ctx.context.secretConfig. Generated secrets contain no ':' so they are used
  // as-is (the `base32:` prefix is only for imported secrets).
  const secret = generateRandomString(32);
  const encryptedSecret = await symmetricEncrypt({
    key: ctx.secretConfig,
    data: secret,
  });

  const backupCodes = newBackupCodes();
  const encryptedBackupCodes = await encryptBackupCodes(ctx.secretConfig, backupCodes);

  // `two-factor/index.mjs`: createOTP(secret, { digits, period }).url(issuer, email).
  const totpURI = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD }).url(
    TOTP_ISSUER,
    guard.user.email
  );

  const row = {
    secret: encryptedSecret,
    backupCodes: encryptedBackupCodes,
    verified: false,
  };
  if (existing !== null) {
    await ctx.adapter.update({
      model: TWO_FACTOR_TABLE,
      update: row,
      where: [{ field: "id", value: existing.id }],
    });
  } else {
    await ctx.adapter.create({
      model: TWO_FACTOR_TABLE,
      data: { ...row, userId: guard.user.id },
    });
  }

  const meta = requestMeta(req);
  await writeAudit(env, {
    action: "totp.enable",
    actor: { userId: guard.user.id, label: guard.user.email },
    subject: guard.user.id,
    detail: { factor: "totp", reauth: "passkey" },
    ...meta,
  });

  // Spend the grant: one enrolment per assertion.
  const secure = ctx.authCookies.sessionToken.attributes.secure === true;
  return json(
    { method: "totp", totpURI, backupCodes },
    200,
    { ...NO_STORE, "Set-Cookie": expiredStepUpCookie(secure) }
  );
}

/* ------------------------------------------------------------------------- */
/* POST /v1/auth/totp/disable                                                */
/* ------------------------------------------------------------------------- */

/**
 * Verify a current code through the plugin; `false` for anything it rejects.
 *
 * With a live session the plugin owns decryption and the 30-second window. Its
 * per-challenge attempt budget is sign-in-scoped, so these routes rely on the
 * session plus the code itself; a dedicated limiter would be the next hardening
 * step (the existing `handlePasswordRemove` has the same shape).
 */
async function verifyCurrentCode(
  auth: NonNullable<ReturnType<typeof getAuth>>,
  req: Request,
  code: unknown
): Promise<boolean> {
  if (typeof code !== "string" || code.length < 6 || code.length > 20) return false;
  try {
    await auth.api.verifyTOTP({ body: { code }, headers: req.headers });
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn the factor off. The current code is the proof, verified by the plugin
 * (window and decryption included); the writes mirror `disableTwoFactor` minus
 * the password check and minus its session rotation — expiring the cookie cache
 * is enough for the next read to see the new state.
 */
export async function handleTotpDisable(req: Request, env: Env): Promise<Response> {
  const guard = await requireRole(req, env, ["owner", "admin", "member"], { fresh: true });
  if (!guard.ok) return guard.response;

  const auth = getAuth(env);
  if (auth === null) return json({ error: "auth_unavailable" }, 503);

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);
  const withPassword = rejectPassword(parsed.value);
  if (withPassword !== null) return withPassword;

  const meta = requestMeta(req);

  if (!guard.user.twoFactorEnabled) return json({ error: "totp_not_enabled" }, 409);

  if (!(await verifyCurrentCode(auth, req, parsed.value.code))) {
    await writeAudit(env, {
      action: "totp.disable_refused",
      actor: { userId: guard.user.id, label: guard.user.email },
      subject: guard.user.id,
      detail: { reason: "invalid_code" },
      ...meta,
    });
    return json({ error: "invalid_code" }, 401);
  }

  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(guard.user.id, { twoFactorEnabled: false });
  await ctx.adapter.delete({
    model: TWO_FACTOR_TABLE,
    where: [{ field: "userId", value: guard.user.id }],
  });

  await writeAudit(env, {
    action: "totp.disable",
    actor: { userId: guard.user.id, label: guard.user.email },
    subject: guard.user.id,
    detail: { factor: "totp", reauth: "totp" },
    ...meta,
  });

  // The session data cookie still says twoFactorEnabled: true for up to the
  // five-minute cache. Drop it so the next get-session rebuilds from D1.
  const secure = ctx.authCookies.sessionToken.attributes.secure === true;
  return json(
    { ok: true },
    200,
    { ...NO_STORE, "Set-Cookie": expiredCookie(ctx.authCookies.sessionData.name, secure) }
  );
}

/* ------------------------------------------------------------------------- */
/* POST /v1/auth/totp/regenerate                                             */
/* ------------------------------------------------------------------------- */

/**
 * Replace the recovery-code set. Same proof as disable: a current TOTP code.
 * The old set stops working the moment the new one is written, which is the
 * behaviour the page describes.
 */
export async function handleTotpRegenerate(req: Request, env: Env): Promise<Response> {
  const guard = await requireRole(req, env, ["owner", "admin", "member"], { fresh: true });
  if (!guard.ok) return guard.response;

  const auth = getAuth(env);
  if (auth === null) return json({ error: "auth_unavailable" }, 503);

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);
  const withPassword = rejectPassword(parsed.value);
  if (withPassword !== null) return withPassword;

  const meta = requestMeta(req);

  if (!guard.user.twoFactorEnabled) return json({ error: "totp_not_enabled" }, 409);

  if (!(await verifyCurrentCode(auth, req, parsed.value.code))) {
    await writeAudit(env, {
      action: "totp.regenerate_refused",
      actor: { userId: guard.user.id, label: guard.user.email },
      subject: guard.user.id,
      detail: { reason: "invalid_code" },
      ...meta,
    });
    return json({ error: "invalid_code" }, 401);
  }

  const ctx = await auth.$context;
  const row = await findRow(ctx, guard.user.id);
  if (row === null) return json({ error: "totp_not_enabled" }, 409);

  const backupCodes = newBackupCodes();
  const encryptedBackupCodes = await encryptBackupCodes(ctx.secretConfig, backupCodes);
  await ctx.adapter.update({
    model: TWO_FACTOR_TABLE,
    update: { backupCodes: encryptedBackupCodes },
    where: [{ field: "id", value: row.id }],
  });

  await writeAudit(env, {
    action: "totp.codes_regenerated",
    actor: { userId: guard.user.id, label: guard.user.email },
    subject: guard.user.id,
    detail: { factor: "totp", reauth: "totp", count: backupCodes.length },
    ...meta,
  });

  return json({ status: true, backupCodes });
}
