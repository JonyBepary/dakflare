/**
 * `requireRole()` — the one auth entry point the rest of the Worker may use
 * (AUTH_PLAN §3 boundary).
 *
 * It resolves the Better Auth session, maps it to a role, and returns either the
 * actor or a ready-made 401/403 response in the shapes this Worker already uses
 * (`{ error: "unauthorized" }` / `{ error: "forbidden" }`). Policy stays here;
 * protocol mechanics stay in Better Auth.
 *
 * `{ fresh: true }` skips the signed cookie cache and reads D1, so a revoked
 * session or a demoted role is seen immediately on sensitive actions. The
 * default path is the five-minute cache, which is what keeps console browsing
 * from costing one D1 read per request.
 */

import type { Env } from "../index";
import { getAuth } from "./settings";

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  twoFactorEnabled: boolean;
  /**
   * The Better Auth session row this request resolved. Sensitive routes bind a
   * re-authentication grant to it (`auth/step-up.ts`), so a grant minted for one
   * session cannot be spent from another.
   */
  sessionId: string;
}

export type GuardResult =
  | { ok: true; user: AuthUser; expiresAt: number }
  | { ok: false; response: Response };

export interface RequireRoleOptions {
  /** Read D1 instead of the cookie cache. Use on security-sensitive actions. */
  fresh?: boolean;
}

function normalizeRole(value: unknown): Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
    ? (value as Role)
    : // Unknown, absent or future roles never grant more than a plain member.
      "member";
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

export async function requireRole(
  req: Request,
  env: Env,
  required: Role | readonly Role[],
  options: RequireRoleOptions = {}
): Promise<GuardResult> {
  const auth = getAuth(env);
  if (auth === null) {
    // Fail closed, but distinguish "auth is not configured here" from "you are
    // not signed in": a 401 would send the operator hunting for a session when
    // the real problem is a missing BETTER_AUTH_SECRET.
    return { ok: false, response: Response.json({ error: "auth_unavailable" }, { status: 503 }) };
  }

  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({
      headers: req.headers,
      ...(options.fresh === true ? { query: { disableCookieCache: true } } : {}),
    });
  } catch (error) {
    console.error(`[auth] session lookup failed: ${String(error)}`);
    return { ok: false, response: unauthorized() };
  }

  if (session === null || session === undefined || !session.user) {
    return { ok: false, response: unauthorized() };
  }

  const raw = session.user as unknown as Record<string, unknown>;
  // Role resolution: one column today. When the organization plugin lands, this
  // is the single place to consult membership — nothing else in the Worker reads
  // roles, so the change stays here.
  const role = normalizeRole(raw.role);
  const allowed = Array.isArray(required) ? required : [required as Role];
  if (!allowed.includes(role)) return { ok: false, response: forbidden() };

  const expiresAt =
    typeof session.session?.expiresAt === "number"
      ? session.session.expiresAt
      : new Date(session.session?.expiresAt ?? Date.now()).getTime();

  return {
    ok: true,
    user: {
      id: String(session.user.id),
      email: String(raw.email ?? ""),
      name: String(raw.name ?? ""),
      role,
      twoFactorEnabled: raw.twoFactorEnabled === true || raw.twoFactorEnabled === 1,
      sessionId: String(session.session?.id ?? ""),
    },
    expiresAt,
  };
}
