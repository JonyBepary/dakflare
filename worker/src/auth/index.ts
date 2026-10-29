/**
 * The auth door.
 *
 * Per AUTH_PLAN §3, `src/auth/` exposes `requireRole()` and nothing else to the
 * rest of the Worker. This barrel is that surface: `requireRole` plus the two
 * mechanics the Worker genuinely needs to mount the library (the `/api/auth/*`
 * handler and the cookie for a server-created session). Settings, the Better
 * Auth instance and every plugin type stay internal to this directory.
 */

export { requireRole, forbidden, unauthorized, ROLES } from "./guard";
export type { AuthUser, GuardResult, RequireRoleOptions, Role } from "./guard";
export { handleAuthRequest } from "./handler";
export { createSessionForUser, sessionCookieHeader } from "./session";
