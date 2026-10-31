/**
 * Magic-link sign-in — AUTH_PLAN §1 factor 2.
 *
 * Two routes, both deliberately boring on the outside:
 *
 *   POST /v1/auth/magic-link          {email, next?} -> 202 {ok:true}
 *   POST /v1/auth/magic-link/consume  {token}       -> 200 {ok:true} + session cookie
 *                                                    | 410 {error:"expired"|"used"}
 *
 * The request route is not an account oracle. A known address, an unknown
 * address and a malformed body all get the same 202 body; the only observable
 * difference is whether mail leaves the Worker. The token is minted and hashed
 * before the account lookup in every case, so the miss path spends the same
 * hashing work rather than returning early. The only refusal is the deployment's
 * per-IP rate limit (429 with `retry_after`).
 *
 * The link lands on `/admin/magic`, which never consumes on page load — mail
 * scanners prefetch every URL. The token is spent only by the POST above.
 *
 * TOTP accounts do NOT get a session here. The consume call answers the same
 * `{twoFactorRedirect:true,twoFactorMethods:["totp"]}` challenge the passkey and
 * password first factors answer, with a `two_factor` cookie and every session
 * cookie expired. That is correct even though the HTTP status is 200: the
 * console calls `/v1/auth/me`, gets 401, and routes to the code step. A 200
 * without a usable session is the contract, not a bug.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import {
  clearAuthFailures,
  clientIp,
  rateLimitedResponse,
} from "../lib/auth-limits";
import { readJsonBoundedResult } from "../lib/body";
import {
  MAGIC_LINK_PATH,
  MAX_BODY_BYTES,
  magicLinkTtlSeconds,
  sanitizeAdminNext,
} from "../lib/config";
import { normalizeEmail } from "../lib/invites";
import { getAuth } from "./settings";
import { mailerFor } from "./mailer";
import { issueSessionCookie } from "./session";
import { startSecondFactorChallenge } from "./handler";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 32 random bytes, base64url — exactly the contract's token shape. */
function mintMagicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** SHA-256(token), hex. The only form a magic-link token is persisted in. */
async function hashMagicToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** The 202 every request path returns, whether the address exists or not. */
function accepted(): Response {
  return Response.json({ ok: true }, { status: 202, headers: NO_STORE });
}

/** 410 is the only "this token did not work" status; the body keeps expired and used apart. */
function tokenGone(kind: "expired" | "used"): Response {
  return Response.json({ error: kind }, { status: 410, headers: NO_STORE });
}

/**
 * Per-IP budget on both endpoints. The deployment's existing limiter is used
 * rather than a new binding: it is already the unauthenticated budget for
 * `/v1/auth/mode`, `/v1/auth/salt` and invite redemption. A 429 always carries
 * `Retry-After` and a body `retry_after` (see `rateLimitedResponse`).
 */
async function rateLimited(
  env: Env,
  req: Request,
  key: string,
  message: string
): Promise<Response | null> {
  if (!env.ADMIN_LIMITER) return null;
  try {
    const { success } = await env.ADMIN_LIMITER.limit({
      key: `${key}:${clientIp(req) ?? "local"}`,
    });
    if (!success) return rateLimitedResponse(60, message);
  } catch (error) {
    // A limiter outage degrades to the rest of the checks rather than failing
    // the sign-in path open or closed.
    console.error(`[auth] magic-link limiter failed: ${String(error)}`);
  }
  return null;
}

/** The public origin a link points at. `AUTH_BASE_URL` wins when it is set. */
function linkOrigin(req: Request, env: Env): string {
  const configured = env.AUTH_BASE_URL?.trim();
  if (configured !== undefined && configured !== "") {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(req.url).origin;
}

/* ------------------------------------------------------------------------- */
/* POST /v1/auth/magic-link                                                  */
/* ------------------------------------------------------------------------- */

export async function handleMagicLinkRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const limited = await rateLimited(
    env,
    req,
    "magic-request",
    "Too many sign-in link requests from this network. Try again in 60 seconds."
  );
  if (limited !== null) return limited;

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  // Malformed input is answered exactly like an unknown address: 202. There is
  // no "your body was wrong" branch for a caller to compare against a known one.
  if (!parsed.ok) return accepted();

  const email = normalizeEmail(parsed.value.email);
  if (email === null) return accepted();

  const ttl = magicLinkTtlSeconds(env);
  const now = Date.now();
  const expiresAt = now + ttl * 1000;

  // Mint and hash before the lookup, so a miss does the same expensive work as
  // a hit. The token on the miss path is discarded and never stored.
  const token = mintMagicToken();
  const tokenHash = await hashMagicToken(token);

  const user = await env.DB.prepare(`SELECT id FROM "user" WHERE email = ? LIMIT 1`)
    .bind(email)
    .first<{ id: string }>();

  if (user === null) {
    // Nothing is minted for an address with no account. The 202 above is the
    // only thing the caller sees, which is the whole point of the factor.
    return accepted();
  }

  const next = sanitizeAdminNext(parsed.value.next);
  const url =
    `${linkOrigin(req, env)}${MAGIC_LINK_PATH}` +
    `?token=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(email)}` +
    `&next=${encodeURIComponent(next)}`;

  // Everything that only a real account causes — the row write, the provider
  // call and the audit row — happens AFTER the 202 is on the wire. Awaiting the
  // provider here would make a known address measurably slower than an unknown
  // one, which is exactly the timing oracle the identical body is meant to
  // avoid. The no-op sender still logs "mail disabled" from this task.
  ctx.waitUntil(
    (async () => {
      try {
        await env.DB.prepare(
          `INSERT INTO magic_link (id, email, token_hash, expires_at, used_at, created_at, ip)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`
        )
          .bind(crypto.randomUUID(), email, tokenHash, expiresAt, now, clientIp(req))
          .run();

        const sent = await mailerFor(env).sendMagicLink({
          to: email,
          url,
          expiresInSeconds: ttl,
        });

        if (sent.ok) {
          await writeAudit(env, {
            action: "sign_in.magic_requested",
            // No address in the audit row. The subject is the account id.
            actor: { userId: user.id, label: "magic-link" },
            subject: user.id,
            detail: { factor: "magic_link", expires_in_s: ttl },
            ...requestMeta(req),
          });
        }
      } catch (error) {
        // The caller already has the neutral 202. Log the failure without the
        // address or token so an operator can see it without a leak.
        console.error(`[auth] magic-link delivery failed: ${String(error)}`);
      }
    })()
  );

  return accepted();
}

/* ------------------------------------------------------------------------- */
/* POST /v1/auth/magic-link/consume                                          */
/* ------------------------------------------------------------------------- */

interface MagicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  twoFactorEnabled: number;
}

export async function handleMagicLinkConsume(req: Request, env: Env): Promise<Response> {
  const limited = await rateLimited(
    env,
    req,
    "magic-consume",
    "Too many sign-in link attempts from this network. Try again in 60 seconds."
  );
  if (limited !== null) return limited;

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return tokenGone("expired");

  const token = parsed.value.token;
  if (typeof token !== "string" || token.length < 16 || token.length > 512) {
    // An unusable token is indistinguishable from an expired one. Saying
    // "malformed" would let a caller separate guesses from real tokens.
    return tokenGone("expired");
  }

  const tokenHash = await hashMagicToken(token);
  const now = Date.now();

  // ONE conditional UPDATE is the single-use gate: the "unused and unexpired"
  // decision and the write cannot be separated, so two concurrent requests
  // cannot both win. The loser sees `used_at` below and answers 410 used.
  const consumed = await env.DB.prepare(
    `UPDATE magic_link
        SET used_at = ?1
      WHERE token_hash = ?2
        AND used_at IS NULL
        AND expires_at > ?1
      RETURNING email`
  )
    .bind(now, tokenHash)
    .all<{ email: string }>();

  const row = consumed.results?.[0];
  if (!row) {
    const existing = await env.DB.prepare(
      `SELECT used_at FROM magic_link WHERE token_hash = ? LIMIT 1`
    )
      .bind(tokenHash)
      .first<{ used_at: number | null }>();
    if (existing !== null && existing.used_at !== null) return tokenGone("used");
    return tokenGone("expired");
  }

  const email = normalizeEmail(row.email);
  if (email === null) return tokenGone("expired");

  const user = await env.DB.prepare(
    `SELECT id, email, name, COALESCE(role, 'member') AS role,
            "twoFactorEnabled" AS twoFactorEnabled
       FROM "user"
      WHERE email = ?
      LIMIT 1`
  )
    .bind(email)
    .first<MagicUser>();
  // The account was deleted between request and consume. The token is spent;
  // there is nobody to sign in.
  if (user === null) return tokenGone("expired");

  const auth = getAuth(env);
  if (auth === null) {
    return Response.json(
      { error: "auth_unavailable" },
      { status: 503, headers: NO_STORE }
    );
  }

  const meta = requestMeta(req);

  // TOTP accounts owe a code. This is the same helper (and therefore the same
  // body shape) the passkey and password first factors use. The 200 deliberately
  // carries no usable session: `/v1/auth/me` will answer 401 and the console
  // routes to its code step.
  if (Number(user.twoFactorEnabled) === 1) {
    return await startSecondFactorChallenge(auth, env, req, user.id, {
      factorLabel: "magic_link",
    });
  }

  const issued = await issueSessionCookie(env, user.id, meta);
  if (!issued.ok) {
    return Response.json({ error: issued.error }, { status: issued.status, headers: NO_STORE });
  }

  await clearAuthFailures(env, email);

  await writeAudit(env, {
    action: "sign_in.success",
    // No address in the audit row; the account id is the subject.
    actor: { userId: user.id, label: "magic-link" },
    subject: user.id,
    detail: { factor: "magic_link" },
    ...meta,
  });

  return Response.json(
    { ok: true },
    { status: 200, headers: { "Set-Cookie": issued.cookie, ...NO_STORE } }
  );
}
