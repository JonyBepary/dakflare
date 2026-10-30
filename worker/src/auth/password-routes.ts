/**
 * Password endpoints — AUTH_PLAN §2, phase 4.
 *
 * Five routes, all of them policy around one construction (see `password.ts`):
 *
 *   POST   /v1/auth/salt                 pre-flight salt; identical shape for known and unknown
 *   POST   /v1/auth/sign-in/password     the two sign-in paths behind AUTH_PASSWORD_MODE
 *   POST   /v1/auth/password             set/replace, live session required
 *   DELETE /v1/auth/password             remove; TOTP code if enrolled, else the password
 *   POST   /v1/admin/auth/rotate-pepper  ADMIN_TOKEN only; see the note there
 *
 * They live inside `src/auth/` because they are protocol mechanics, not policy
 * about who may register: the route table only mounts them.
 *
 * User-enumeration rules, enforced here rather than documented:
 *   - `/salt` answers 200 with the same four fields whether the address exists,
 *     exists without a password, or does not exist.
 *   - sign-in answers one byte-identical 401 for unknown user and wrong secret,
 *     and does the same HMAC work in both cases (PBKDF2 too in server mode).
 *   - neither route records whether the user existed.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import {
  auditLockout,
  checkAuthLockout,
  clearAuthFailures,
  clientIp,
  lockoutResponse,
  rateLimitedResponse,
  recordAuthFailure,
} from "../lib/auth-limits";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES, passwordMode } from "../lib/config";
import { normalizeEmail } from "../lib/invites";
import { b64decode, b64encode } from "./base64";
import { requireRole } from "./guard";
import { startSecondFactorChallenge } from "./handler";
import {
  PASSWORD_ITERATIONS,
  buildPasswordRow,
  deriveMaterial,
  fakeSalt,
  formatPasswordRow,
  outerDigest,
  parseClientMaterial,
  parseMaterial,
  parsePasswordRow,
  plausiblePassword,
  randomSalt,
  verifyMaterial,
  type PasswordRow,
} from "./password";
import {
  findPepperVersion,
  loadPepperRing,
  ringAfterPrepend,
  type PepperRing,
} from "./pepper";
import { issueSessionCookie } from "./session";
import { getAuth } from "./settings";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: Record<string, unknown>, status = 200, headers: HeadersInit = NO_STORE): Response {
  return Response.json(body, { status, headers });
}

function passwordDisabled(): Response {
  return json({ error: "password_disabled", mode: "off" }, 403);
}

/**
 * The request shape does not fit the deployment's mode. Separate from
 * `password_disabled` so an operator sees "you sent a password to a free-tier
 * deployment" instead of "passwords are off".
 */
function modeMismatch(mode: string, detail: string): Response {
  return json({ error: "password_mode_mismatch", mode, detail }, 403);
}

/** True when any of the keys is over its window. Keys are namespaced strings. */
async function overLimit(env: Env, keys: string[]): Promise<boolean> {
  if (!env.ADMIN_LIMITER) return false;
  for (const key of keys) {
    const { success } = await env.ADMIN_LIMITER.limit({ key });
    if (!success) return true;
  }
  return false;
}

interface CredentialLookup {
  id: string;
  name: string;
  email: string;
  role: string;
  twoFactorEnabled: number;
  password: string | null;
}

/**
 * The user row plus the credential account, by email.
 *
 * One LEFT JOIN on purpose: an account with a passkey but no password and an
 * address with no account at all must both come back as "no row", and both must
 * spend the same work downstream.
 */
async function findCredential(env: Env, email: string): Promise<CredentialLookup | null> {
  return await env.DB.prepare(
    `SELECT u.id                        AS id,
            u.name                      AS name,
            u.email                     AS email,
            COALESCE(u.role, 'member')  AS role,
            u."twoFactorEnabled"        AS twoFactorEnabled,
            a.password                  AS password
       FROM "user" u
       LEFT JOIN account a
         ON a."userId" = u.id AND a."providerId" = 'credential'
      WHERE u.email = ?
      ORDER BY a."updatedAt" DESC
      LIMIT 1`
  )
    .bind(email)
    .first<CredentialLookup>();
}

/* ------------------------------------------------------------------------- */
/* POST /v1/auth/salt                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The pre-flight salt.
 *
 * For a user with a password: their salt, iteration count, provenance and pepper
 * version. For anything else — unknown address, account without a password,
 * unparseable row — the DETERMINISTIC fake salt from AUTH_PLAN §2. Returning a
 * fresh random salt on a miss would turn this into a user oracle, and a random
 * one would also be useless to a client that retries.
 *
 * Rate-limited per IP. The response carries no "known" flag and no timing branch.
 */
export async function handlePasswordSalt(req: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const email = normalizeEmail(parsed.value.email);
  if (email === null) return err("bad_request", 400);

  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  if (await overLimit(env, [`pw-salt:${ip}`])) {
    return rateLimitedResponse(60, "Too many salt requests from this network. Try again in 60 seconds.");
  }

  const loaded = loadPepperRing(env);
  if (!loaded.ok) return loaded.response;
  const ring = loaded.ring;

  const user = await findCredential(env, email);
  const row = user?.password ? parsePasswordRow(user.password) : null;
  // Always computed, even when a real row exists: the fake-salt HMAC then costs
  // the same in both branches, so the response is not a timing oracle either.
  const synthetic = await fakeSalt(ring, email);

  if (row !== null) {
    return json({
      salt: b64encode(row.salt),
      iterations: row.iterations,
      mode: row.mode,
      pepper_version: row.version,
    });
  }

  return json({
    salt: b64encode(synthetic),
    iterations: PASSWORD_ITERATIONS,
    mode: "c",
    pepper_version: ring.active.version,
  });
}

/* ------------------------------------------------------------------------- */
/* POST /v1/auth/sign-in/password                                            */
/* ------------------------------------------------------------------------- */

/**
 * Sign in with a password.
 *
 * `client-derived` accepts `{email, material}` and nothing else: the Worker must
 * never run PBKDF2 on the free tier, so a plaintext body is refused rather than
 * quietly derived.
 *
 * `server-kdf` accepts `{email, password}` and also `{email, material}`. The
 * material form is what keeps an account created on the free tier usable after
 * an upgrade, and it is strictly cheaper; `m=s` is recorded only when the Worker
 * itself ran the KDF. A successful server-mode sign-in over an `m=c` row rewrites
 * it as `m=s`, which is the one way that tag changes (AUTH_PLAN §2).
 *
 * Re-wrapping is also where pepper rotation completes: if the row's `p=` is not
 * the active version, success re-derives the outer layer with the active pepper
 * (the material is in hand) and compare-and-swaps the row. That is the
 * "re-derive on next sign-in" of §8, and the reason the rotate endpoint does not
 * need the password.
 */
export async function handlePasswordSignIn(req: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const email = normalizeEmail(parsed.value.email);
  if (email === null) return err("bad_request", 400);

  const mode = passwordMode(env);
  if (mode === "off") return passwordDisabled();

  const ip = clientIp(req);
  // One account window (5/15 min) and one IP window (20/15 min). The account
  // window is shared with the TOTP paths, so a password guess and a code guess
  // spend the same budget. Checked before the KDF/HMAC work and before D1.
  const before = checkAuthLockout(env, { email, ip });
  if (before.locked) return lockoutResponse(before);

  const loaded = loadPepperRing(env);
  if (!loaded.ok) return loaded.response;
  const ring = loaded.ring;

  let material: Uint8Array | null = null;
  let usedPassword = false;

  if (parsed.value.material !== undefined) {
    // Sign-in carries only the material: salt and iterations come from the row.
    material = parseMaterial(parsed.value);
    if (material === null) return err("bad_request", 400);
  } else if (typeof parsed.value.password === "string") {
    if (mode !== "server-kdf") {
      return modeMismatch(
        mode,
        "client-derived deployments accept {material}; the Worker does not run PBKDF2"
      );
    }
    if (plausiblePassword(parsed.value.password) === null) return err("bad_request", 400);
    usedPassword = true;
  } else {
    return err("bad_request", 400);
  }

  const meta = requestMeta(req);
  const user = await findCredential(env, email);
  const row = user?.password ? parsePasswordRow(user.password) : null;

  let verified: PasswordRow | null = null;

  if (row !== null && user !== null) {
    const candidate = usedPassword
      ? await deriveMaterial(parsed.value.password as string, row.salt, row.iterations)
      : (material as Uint8Array);
    const result = await verifyMaterial(row, candidate, ring);
    if (result.ok) {
      verified = row;
      material = candidate;
    } else if (result.reason === "pepper_missing") {
      // A row sealed with a version that is no longer in the ring. Log it: this
      // is an operator error (the old pepper was dropped too early), not a guess.
      console.error(`[auth] password row for user ${user.id} needs pepper v${row.version}`);
    }
  } else {
    // Unknown address OR no password row. Do the SAME work: fake salt, real
    // iteration count in server mode, the caller's material in client mode, and
    // compare against an all-zero digest that can never match.
    const salt = await fakeSalt(ring, email);
    const candidate = usedPassword
      ? await deriveMaterial(parsed.value.password as string, salt, PASSWORD_ITERATIONS)
      : (material as Uint8Array);
    await outerDigest(ring, ring.active.version, salt, candidate);
  }

  if (verified === null || user === null || material === null) {
    // Record first: the fifth failure is answered with 429, not 401, so the
    // lockout starts at the threshold. Unknown addresses are counted exactly
    // like known ones (same key, same response), so the lockout is not an
    // enumeration oracle.
    const after = await recordAuthFailure(env, { email, ip });
    if (after.locked) {
      await auditLockout(env, req, { email, factor: "password", lockout: after });
      return lockoutResponse(after);
    }
    await writeAudit(env, {
      action: "sign_in.failure",
      actor: { userId: null, label: "password" },
      detail: { factor: "password", mode, email: email.slice(0, 254) },
      ...meta,
    });
    // Byte-identical for unknown user, missing credential row and wrong secret.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Pepper rotation, completed without the password: the material is in hand and
  // the inner KDF output does not change.
  let migratedFrom: number | null = null;
  if (verified.version !== ring.active.version) {
    const digest = await outerDigest(ring, ring.active.version, verified.salt, material);
    if (digest !== null) {
      const rewritten = formatPasswordRow({
        version: ring.active.version,
        iterations: verified.iterations,
        // A server-mode sign-in may record that the Worker saw the password;
        // a material sign-in keeps the row's original provenance.
        mode: usedPassword ? "s" : verified.mode,
        salt: verified.salt,
        digest,
      });
      const write = await env.DB.prepare(
        `UPDATE account
            SET password = ?, "updatedAt" = ?
          WHERE "userId" = ? AND "providerId" = 'credential' AND password = ?`
      )
        .bind(rewritten, new Date().toISOString(), user.id, verified.raw)
        .run();
      if (Number(write.meta?.changes ?? 0) > 0) migratedFrom = verified.version;
    }
  }

  const auth = getAuth(env);
  if (auth === null) {
    return json(
      {
        error: "auth_unavailable",
        message: "BETTER_AUTH_SECRET is missing; a password can be verified but no session can be minted.",
      },
      503
    );
  }

  // TOTP accounts get the challenge, never a session — the same helper (and the
  // same body) the passkey handler uses.
  if (Number(user.twoFactorEnabled) === 1) {
    return await startSecondFactorChallenge(auth, env, req, user.id, { factorLabel: "password" });
  }

  const issued = await issueSessionCookie(env, user.id, meta);
  if (!issued.ok) {
    return Response.json({ error: issued.error }, { status: issued.status });
  }

  // Full authentication (no second factor): clear the account window. A TOTP
  // account does NOT clear here — its first factor is not the end of the
  // sign-in, and clearing would let a password holder reset the code lockout by
  // starting a new challenge.
  clearAuthFailures(email);

  await writeAudit(env, {
    action: "sign_in.success",
    actor: { userId: user.id, label: user.email },
    subject: user.id,
    detail: {
      factor: "password",
      kdf: usedPassword ? "server" : "client",
      mode,
      pepper_version: ring.active.version,
      ...(migratedFrom === null ? {} : { migrated_from_pepper: migratedFrom }),
    },
    ...meta,
  });

  return json(
    {
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      expires_at: issued.expiresAt,
    },
    200,
    { "Set-Cookie": issued.cookie, ...NO_STORE }
  );
}

/* ------------------------------------------------------------------------- */
/* POST /v1/auth/password                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Set or replace this account's password. A live session is required.
 *
 * `off` refuses; `client-derived` takes only the material; `server-kdf` takes a
 * plaintext or the material. The row is written through Better Auth's adapter so
 * `findCredentialAccount` (and therefore the TOTP plugin) sees it.
 */
export async function handlePasswordSet(req: Request, env: Env): Promise<Response> {
  const guard = await requireRole(req, env, "self", {
    fresh: true,
    action: "change authentication factors",
  });
  if (!guard.ok) return guard.response;

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const mode = passwordMode(env);
  if (mode === "off") return passwordDisabled();

  const auth = getAuth(env);
  if (auth === null) {
    return json({ error: "auth_unavailable", message: "BETTER_AUTH_SECRET is missing." }, 503);
  }

  const loaded = loadPepperRing(env);
  if (!loaded.ok) return loaded.response;
  const ring = loaded.ring;

  let salt: Uint8Array;
  let iterations: number;
  let material: Uint8Array;
  let provenance: "c" | "s";

  if (parsed.value.password !== undefined) {
    if (mode !== "server-kdf") {
      return modeMismatch(
        mode,
        "client-derived deployments accept {material, salt, iterations}; the Worker does not run PBKDF2"
      );
    }
    const password = plausiblePassword(parsed.value.password);
    if (password === null) return err("bad_request", 400);
    salt = randomSalt();
    iterations = PASSWORD_ITERATIONS;
    material = await deriveMaterial(password, salt, iterations);
    provenance = "s";
  } else if (parsed.value.material !== undefined) {
    const client = parseClientMaterial(parsed.value);
    if (client === null) return err("bad_request", 400);
    salt = client.salt;
    iterations = client.iterations;
    material = client.material;
    provenance = "c";
  } else {
    return err("bad_request", 400);
  }

  const row = await buildPasswordRow({ ring, salt, material, iterations, mode: provenance });
  if (row === null) {
    return json({ error: "auth_unavailable", message: "AUTH_PEPPER is missing or malformed." }, 503);
  }

  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findCredentialAccount(guard.user.id);
  if (existing) {
    await ctx.internalAdapter.updatePassword(guard.user.id, row);
  } else {
    await ctx.internalAdapter.createAccount({
      userId: guard.user.id,
      providerId: "credential",
      accountId: guard.user.id,
      password: row,
    });
  }

  await writeAudit(env, {
    action: "password.set",
    actor: { userId: guard.user.id, label: guard.user.email },
    subject: guard.user.id,
    detail: {
      kdf: provenance === "s" ? "server" : "client",
      iterations,
      pepper_version: ring.active.version,
      mode,
    },
    ...requestMeta(req),
  });

  return json({
    ok: true,
    mode,
    pepper_version: ring.active.version,
    iterations,
  });
}

/* ------------------------------------------------------------------------- */
/* DELETE /v1/auth/password                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Remove the password factor.
 *
 * A TOTP-enabled account proves the second factor with a code, checked by the
 * plugin's own `verifyTOTP` against the live session. Every other account proves
 * the password itself — as material in client-derived mode, as either shape in
 * server-kdf mode. Removing the last factor is refused elsewhere: the console
 * must not let a passkey-only account lose its only way in, which is a UI rule
 * and not enforceable here without knowing the account's passkeys. This endpoint
 * only removes the password row.
 */
export async function handlePasswordRemove(req: Request, env: Env): Promise<Response> {
  const guard = await requireRole(req, env, "self", {
    fresh: true,
    action: "change authentication factors",
  });
  if (!guard.ok) return guard.response;

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const auth = getAuth(env);
  if (auth === null) {
    return json({ error: "auth_unavailable", message: "BETTER_AUTH_SECRET is missing." }, 503);
  }

  const meta = requestMeta(req);
  const ip = clientIp(req);

  const before = checkAuthLockout(env, { email: guard.user.email, ip });
  if (before.locked) return lockoutResponse(before);

  if (guard.user.twoFactorEnabled) {
    const code = parsed.value.code;
    if (typeof code !== "string" || code.length < 6 || code.length > 20) {
      return err("bad_request", 400);
    }
    try {
      // Live session, so this verifies without creating another one.
      await auth.api.verifyTOTP({ body: { code }, headers: req.headers });
    } catch {
      const after = await recordAuthFailure(env, { email: guard.user.email, ip });
      if (after.locked) {
        await auditLockout(env, req, { email: guard.user.email, factor: "totp", lockout: after });
        return lockoutResponse(after);
      }
      await writeAudit(env, {
        action: "password.remove_failed",
        actor: { userId: guard.user.id, label: guard.user.email },
        subject: guard.user.id,
        detail: { factor: "totp" },
        ...meta,
      });
      return json({ error: "invalid_code" }, 401);
    }
  } else {
    const loaded = loadPepperRing(env);
    if (!loaded.ok) return loaded.response;
    const ring = loaded.ring;

    const user = await findCredential(env, guard.user.email);
    const row = user?.password ? parsePasswordRow(user.password) : null;
    if (row === null) return json({ error: "password_not_set" }, 409);

    let material: Uint8Array | null = null;
    if (parsed.value.material !== undefined) {
      material = parseMaterial(parsed.value);
      if (material === null) return err("bad_request", 400);
    } else if (typeof parsed.value.password === "string") {
      if (passwordMode(env) !== "server-kdf") {
        return modeMismatch(
          passwordMode(env),
          "client-derived deployments accept {material}; the Worker does not run PBKDF2"
        );
      }
      const password = plausiblePassword(parsed.value.password);
      if (password === null) return err("bad_request", 400);
      material = await deriveMaterial(password, row.salt, row.iterations);
    } else {
      return err("bad_request", 400);
    }

    const result = await verifyMaterial(row, material, ring);
    if (!result.ok) {
      const after = await recordAuthFailure(env, { email: guard.user.email, ip });
      if (after.locked) {
        await auditLockout(env, req, { email: guard.user.email, factor: "password", lockout: after });
        return lockoutResponse(after);
      }
      await writeAudit(env, {
        action: "password.remove_failed",
        actor: { userId: guard.user.id, label: guard.user.email },
        subject: guard.user.id,
        detail: { factor: "password" },
        ...meta,
      });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  clearAuthFailures(guard.user.email);

  const deleted = await env.DB.prepare(
    `DELETE FROM account WHERE "userId" = ? AND "providerId" = 'credential'`
  )
    .bind(guard.user.id)
    .run();

  await writeAudit(env, {
    action: "password.removed",
    actor: { userId: guard.user.id, label: guard.user.email },
    subject: guard.user.id,
    detail: {
      factor: guard.user.twoFactorEnabled ? "totp" : "password",
      deleted: Number(deleted.meta?.changes ?? 0),
    },
    ...meta,
  });

  return json({ ok: true });
}

/* ------------------------------------------------------------------------- */
/* POST /v1/admin/auth/rotate-pepper                                         */
/* ------------------------------------------------------------------------- */

interface VersionCounts {
  by_version: Record<string, number>;
  pending: number;
  total: number;
  malformed: number;
  missing_pepper: number;
}

/**
 * Count the stored rows by `p=` without rewriting anything.
 *
 * `pending` is the rotation work: rows not yet on the active version. They
 * re-wrap at sign-in. `missing_pepper` is the opposite and much worse — a row
 * sealed with a version the ring no longer has. Those accounts cannot sign in
 * until the old pepper is restored; the count is surfaced so "too early to drop
 * v1" is a number, not an outage.
 */
async function countVersions(env: Env, ring: PepperRing): Promise<VersionCounts> {
  const rows = await env.DB.prepare(
    `SELECT password FROM account WHERE "providerId" = 'credential' AND password IS NOT NULL`
  ).all<{ password: string }>();

  const byVersion: Record<string, number> = {};
  let pending = 0;
  let total = 0;
  let malformed = 0;
  let missingPepper = 0;

  for (const row of rows.results ?? []) {
    const parsed = parsePasswordRow(row.password);
    if (parsed === null) {
      malformed += 1;
      continue;
    }
    total += 1;
    byVersion[String(parsed.version)] = (byVersion[String(parsed.version)] ?? 0) + 1;
    if (parsed.version !== ring.active.version) pending += 1;
    if (!ring.byVersion.has(parsed.version)) missingPepper += 1;
  }

  return { by_version: byVersion, pending, total, malformed, missing_pepper: missingPepper };
}

/**
 * Rotate the pepper ring.
 *
 * What this endpoint does: validates the supplied 32-byte pepper, computes the
 * ring that results from prepending it, counts the rows still on older versions,
 * and audits `pepper.rotate`. When the new pepper is already the ring's active
 * entry it confirms the rotation and reports the remaining work.
 *
 * What it cannot do, and deliberately does not pretend to: re-derive the outer
 * layers itself. A stored row is `SHA-256(HMAC(pepper_v, salt ‖ material))`; the
 * material is not stored, and neither SHA-256 nor HMAC is invertible, so no
 * amount of pepper gets it back. The re-wrap therefore happens on the next
 * sign-in, where the client supplies the material and the inner PBKDF2 output is
 * unchanged — exactly what AUTH_PLAN §8 describes ("verify old, re-derive on next
 * sign-in"). Eagerly migrating would require storing the material recoverably,
 * which would turn a database-plus-pepper leak into instant account takeover
 * instead of PBKDF2 work per guess. Not worth it for an operation that costs one
 * extra HMAC on a request the user was making anyway.
 *
 * Ordering is load-bearing: the Worker cannot write its own secret, so the ring
 * must be installed first. Resulting rows are verified with the NEW version; a
 * deployment still holding only the old ring would lock those accounts out.
 * This endpoint refuses to be the cause of that.
 */
export async function handleRotatePepper(req: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const pepper = b64decode(parsed.value.pepper, 64);
  if (pepper === null || pepper.length !== 32) return err("bad_request", 400);

  const loaded = loadPepperRing(env);
  if (!loaded.ok) return loaded.response;
  const ring = loaded.ring;

  const next = ringAfterPrepend(ring, pepper);
  const installedVersion = findPepperVersion(ring, pepper);
  const counts = await countVersions(env, ring);
  const meta = requestMeta(req);

  if (installedVersion === null) {
    await writeAudit(env, {
      action: "pepper.rotate",
      actor: { userId: null, label: "admin-token" },
      detail: {
        installed: false,
        next_version: next.version,
        pending: counts.pending,
        by_version: counts.by_version,
      },
      ...meta,
    });
    return json({
      ok: true,
      installed: false,
      active_version: ring.active.version,
      next_version: next.version,
      // The exact secret value to install. The Worker cannot set its own secret.
      ring: next.raw,
      migrated: 0,
      pending: counts.pending,
      by_version: counts.by_version,
      total: counts.total,
      malformed: counts.malformed,
      missing_pepper: counts.missing_pepper,
      note:
        "Install `ring` with `wrangler secret put AUTH_PEPPER`, then call this endpoint again. " +
        "Rows re-wrap on their next sign-in; nothing is rewritten here.",
    });
  }

  if (installedVersion !== ring.active.version) {
    return json(
      {
        error: "pepper_not_active",
        active_version: ring.active.version,
        provided_version: installedVersion,
      },
      409
    );
  }

  await writeAudit(env, {
    action: "pepper.rotate",
    actor: { userId: null, label: "admin-token" },
    detail: {
      installed: true,
      active_version: ring.active.version,
      pending: counts.pending,
      by_version: counts.by_version,
    },
    ...meta,
  });

  return json({
    ok: true,
    installed: true,
    active_version: ring.active.version,
    ring: ring.raw,
    migrated: 0,
    pending: counts.pending,
    by_version: counts.by_version,
    total: counts.total,
    malformed: counts.malformed,
    missing_pepper: counts.missing_pepper,
    note:
      "Ring confirmed. Rows at older versions re-wrap on their next sign-in; " +
      "drop the oldest pepper only when pending reaches 0.",
  });
}
