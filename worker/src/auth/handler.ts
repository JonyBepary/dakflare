/**
 * `/api/auth/*` — the Better Auth mount.
 *
 * Everything under this prefix is Better Auth's: passkey registration and
 * sign-in, TOTP enrolment, and the error envelopes it defines. We add exactly
 * four things around it:
 *
 *   1. A clear 503 when BETTER_AUTH_SECRET is absent, instead of a library
 *      exception with no operator-facing explanation.
 *   2. Audit rows for sign-in attempts. Better Auth's after-hooks do not run on
 *      a failed sign-in, so the outcome has to be read from the response here.
 *      Only the factor and the status are recorded — never a request body.
 *   3. The second-factor challenge after a passkey assertion, for accounts with
 *      TOTP enabled (see `beginSecondFactor`). The two-factor plugin mints that
 *      challenge only for `/sign-in/email|username|phone-number`, which this
 *      deployment does not enable, and `@better-auth/passkey` creates a full
 *      session without consulting `twoFactorEnabled`. Without this step a
 *      passkey would hand out a session and the account's authenticator would
 *      never be asked — the factor would exist but never be enforced.
 *   4. A short-lived "passkey asserted in this session" grant on the same
 *      successful assertion, for accounts that did NOT get a challenge (TOTP is
 *      off). `totp-routes.ts` spends it to enable an authenticator without a
 *      password; see `auth/step-up.ts`.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { getAuth } from "./settings";
import { signedCookieHeader } from "./session";
import { mintStepUpCookie } from "./step-up";

/** `better-auth.two_factor`, from the plugin's TWO_FACTOR_COOKIE_NAME. */
const TWO_FACTOR_COOKIE = "two_factor";

/** Ten minutes: the same window the plugin uses for its own challenge. */
const CHALLENGE_SECONDS = 10 * 60;

type Auth = NonNullable<ReturnType<typeof getAuth>>;

function expiredCookie(name: string, secure: boolean): string {
  return `${name}=; Max-Age=0; Path=/${secure ? "; Secure" : ""}`;
}

const SESSION_COOKIES = ["sessionToken", "sessionData", "accountData"] as const;

/**
 * Turn "this user passed the first factor" into a pending TOTP challenge,
 * without minting a session.
 *
 * This is the shared half of the passkey path: delete any session that was just
 * created (the caller does that), write the `2fa-` verification row the plugin's
 * `verify-totp` reads, seed its attempt budget, and set the signed `two_factor`
 * cookie. Password sign-in calls this too, so an account with TOTP gets exactly
 * the challenge a passkey gets — one implementation, one body shape.
 */
export async function startSecondFactorChallenge(
  auth: Auth,
  env: Env,
  req: Request,
  userId: string,
  options: { headers?: Headers; factorLabel?: string } = {}
): Promise<Response> {
  const ctx = await auth.$context;
  const identifier = `2fa-${crypto.randomUUID().replace(/-/g, "")}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_SECONDS * 1000);
  await ctx.internalAdapter.createVerificationValue({ value: userId, identifier, expiresAt });
  // The attempt budget `verify-totp` reads before checking a code. It starts at
  // "0 used"; `verifyTOTP` allows five and then burns the challenge.
  await ctx.internalAdapter.createVerificationValue({
    value: "0",
    identifier: `2fa-attempts-${identifier}`,
    expiresAt,
  });

  const challengeCookie = ctx.createAuthCookie(TWO_FACTOR_COOKIE, {
    maxAge: CHALLENGE_SECONDS,
  });
  const cookie = await signedCookieHeader(
    env,
    challengeCookie.name,
    identifier,
    challengeCookie.attributes,
    CHALLENGE_SECONDS
  );
  if (cookie === null) {
    return Response.json({ error: "auth_unavailable" }, { status: 503 });
  }

  const headers = options.headers ? new Headers(options.headers) : new Headers();
  headers.delete("set-cookie");
  headers.delete("content-length");
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.append("Set-Cookie", cookie);
  // Any session cookie Better Auth just set is dropped above; expire earlier
  // ones too, so a browser cannot keep a session minted before the challenge.
  const secure = challengeCookie.attributes.secure === true;
  for (const key of SESSION_COOKIES) {
    headers.append("Set-Cookie", expiredCookie(ctx.authCookies[key].name, secure));
  }

  await writeAudit(env, {
    action: "sign_in.second_factor",
    actor: { userId, label: options.factorLabel ?? "password" },
    subject: userId,
    detail: { factor: "totp" },
    ...requestMeta(req),
  });

  return new Response(
    JSON.stringify({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
    }),
    { status: 200, headers }
  );
}

/**
 * The passkey path: read the user out of the session Better Auth just created,
 * delete that session, then hand out the TOTP challenge instead.
 */
async function beginSecondFactor(
  auth: Auth,
  env: Env,
  req: Request,
  res: Response
): Promise<Response | null> {
  interface PasskeySignInBody {
    user?: { id?: unknown; twoFactorEnabled?: unknown };
    session?: { token?: unknown };
  }
  let payload: PasskeySignInBody | null = null;
  try {
    payload = (await res.clone().json()) as PasskeySignInBody;
  } catch {
    return null;
  }

  const userId = payload?.user?.id;
  const sessionToken = payload?.session?.token;
  // D1 returns 0/1 for a boolean column, so this is deliberately loose.
  const enabled = payload?.user?.twoFactorEnabled === true || payload?.user?.twoFactorEnabled === 1;
  if (typeof userId !== "string" || typeof sessionToken !== "string" || !enabled) return null;

  const ctx = await auth.$context;
  try {
    await ctx.internalAdapter.deleteSession(sessionToken);
  } catch (error) {
    // Failing closed matters more than the cleanup: without the delete the
    // browser still holds a valid session, so refuse to hand one out at all.
    console.error(`[auth] second-factor: session cleanup failed: ${String(error)}`);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  return await startSecondFactorChallenge(auth, env, req, userId, {
    headers: res.headers,
    factorLabel: "passkey",
  });
}

/**
 * Record "a passkey was asserted in this session" for the sensitive TOTP routes.
 *
 * The assertion has already created a fresh session by the time we see the
 * response; the grant names that session, so it authorises an enable only from
 * the browser that just performed the ceremony. A 2FA-on account never reaches
 * here (the challenge path above replaces the response), which is correct: it
 * has a current TOTP code and does not need this grant.
 */
async function withStepUpGrant(auth: Auth, env: Env, res: Response): Promise<Response> {
  interface PasskeySignInBody {
    user?: { id?: unknown };
    session?: { id?: unknown };
  }
  let payload: PasskeySignInBody | null = null;
  try {
    payload = (await res.clone().json()) as PasskeySignInBody;
  } catch {
    return res;
  }

  const userId = payload?.user?.id;
  const sessionId = payload?.session?.id;
  if (typeof userId !== "string" || typeof sessionId !== "string") return res;

  const ctx = await auth.$context;
  const cookie = await mintStepUpCookie(
    env,
    { path: "/", secure: ctx.authCookies.sessionToken.attributes.secure === true, httpOnly: true, sameSite: "strict" },
    userId,
    sessionId
  );
  if (cookie === null) return res;

  const headers = new Headers(res.headers);
  headers.append("Set-Cookie", cookie);
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function handleAuthRequest(req: Request, env: Env): Promise<Response> {
  const auth = getAuth(env);
  if (auth === null) {
    return Response.json({ error: "auth_unavailable" }, { status: 503 });
  }

  const res = await auth.handler(req);

  const path = new URL(req.url).pathname;
  const relative = path.startsWith("/api/auth") ? path.slice("/api/auth".length) : path;

  if (relative === "/passkey/verify-authentication" && res.ok) {
    const challenged = await beginSecondFactor(auth, env, req, res);
    if (challenged !== null) return challenged;
    return await withStepUpGrant(auth, env, res);
  }

  if (relative.startsWith("/sign-in/")) {
    const factor = relative.slice("/sign-in/".length).split("/")[0] || "unknown";
    await writeAudit(env, {
      action: res.ok ? "sign_in.success" : "sign_in.failure",
      actor: { userId: null, label: `better-auth:${factor}` },
      detail: { factor, status: res.status },
      ...requestMeta(req),
    });
  }

  return res;
}
