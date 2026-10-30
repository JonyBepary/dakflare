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

/**
 * What the caller is trying to do, not which roles may do it.
 *
 * The console has three roles but only two levels of trust: members read
 * everything operational and change nothing; owners and admins do both. Naming
 * the permission instead of listing roles keeps that policy in one place, so a
 * route cannot accidentally grant a member a mutation by forgetting to mention
 * it in a role list.
 */
/**
 * `self` is the account's own authentication: a member may set a password or
 * enrol an authenticator for themselves, while changing the console or the fleet
 * still needs owner/admin. AUTH_PLAN §6 says the second factor is optional for
 * every role, which is only true if every role can turn it on.
 */
export type Permission = "read" | "write" | "self";

const PERMISSION_ROLES: Record<Permission, readonly Role[]> = {
  read: ["owner", "admin", "member"],
  write: ["owner", "admin"],
  self: ["owner", "admin", "member"],
};

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
  /**
   * What the caller is trying to do, phrased to complete "cannot …", e.g.
   * "send SMS". Only used in the 403 sentence a member receives.
   */
  action?: string;
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

/**
 * The 403 a member receives on a mutation.
 *
 * A bare `forbidden` told an invited member nothing about why the console was
 * refusing them, so the sentence names the action that is out of reach while
 * making clear that reading it is allowed.
 */
export function forbiddenFor(permission: Permission, action?: string): Response {
  const message =
    permission === "write"
      ? `Members can read this but cannot ${action ?? "change it"}.`
      : "Members can read this.";
  return Response.json({ error: "forbidden", message }, { status: 403 });
}

export async function requireRole(
  req: Request,
  env: Env,
  permission: Permission,
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
  const allowed = PERMISSION_ROLES[permission];
  if (!allowed.includes(role)) {
    return { ok: false, response: forbiddenFor(permission, options.action) };
  }

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
