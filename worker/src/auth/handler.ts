/**
 * `/api/auth/*` — the Better Auth mount.
 *
 * Everything under this prefix is Better Auth's: passkey registration and
 * sign-in, TOTP enrolment, and the error envelopes it defines. We add exactly
 * two things around it:
 *
 *   1. A clear 503 when BETTER_AUTH_SECRET is absent, instead of a library
 *      exception with no operator-facing explanation.
 *   2. Audit rows for sign-in attempts. Better Auth's after-hooks do not run on
 *      a failed sign-in, so the outcome has to be read from the response here.
 *      Only the factor and the status are recorded — never a request body.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { getAuth } from "./settings";

export async function handleAuthRequest(req: Request, env: Env): Promise<Response> {
  const auth = getAuth(env);
  if (auth === null) {
    return Response.json({ error: "auth_unavailable" }, { status: 503 });
  }

  const res = await auth.handler(req);

  const path = new URL(req.url).pathname;
  const relative = path.startsWith("/api/auth") ? path.slice("/api/auth".length) : path;
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
