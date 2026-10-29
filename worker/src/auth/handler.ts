/**
 * `/api/auth/*` — the Better Auth mount.
 *
 * Everything under this prefix is Better Auth's: passkey registration and
 * sign-in, TOTP enrolment, and the error envelopes it defines. We add exactly
 * three things around it:
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
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { getAuth } from "./settings";
import { signedCookieHeader } from "./session";

/** `better-auth.two_factor`, from the plugin's TWO_FACTOR_COOKIE_NAME. */
const TWO_FACTOR_COOKIE = "two_factor";

/** Ten minutes: the same window the plugin uses for its own challenge. */
const CHALLENGE_SECONDS = 10 * 60;

type Auth = NonNullable<ReturnType<typeof getAuth>>;

function expiredCookie(name: string, secure: boolean): string {
  return `${name}=; Max-Age=0; Path=/${secure ? "; Secure" : ""}`;
}

/**
 * Turn the session Better Auth just created into a pending TOTP challenge.
 *
 * The steps are the ones the plugin performs for a password sign-in, in the
 * same order and with the same identifiers: delete the session, write the
 * `2fa-` verification row, seed its attempt budget, and set the signed
 * `two_factor` cookie that `verify-totp` / `verify-backup-code` read. Those
 * endpoints then own the actual check, the attempt count and the session they
 * hand back, so no verification logic is duplicated here.
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

  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  headers.delete("content-length");
  headers.append("Set-Cookie", cookie);
  // The session cookie this response would have set is dropped above; expire
  // any earlier one too, so a browser cannot keep a session minted before the
  // challenge existed.
  const secure = challengeCookie.attributes.secure === true;
  for (const name of [
    ctx.authCookies.sessionToken.name,
    ctx.authCookies.sessionData.name,
    ctx.authCookies.accountData.name,
  ]) {
    headers.append("Set-Cookie", expiredCookie(name, secure));
  }

  await writeAudit(env, {
    action: "sign_in.second_factor",
    actor: { userId, label: "passkey" },
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
