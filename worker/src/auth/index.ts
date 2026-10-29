/**
 * The auth door.
 *
 * Per AUTH_PLAN §3, `src/auth/` exposes `requireRole()` and the mechanics the
 * rest of the Worker genuinely needs to mount and run the library: the
 * `/api/auth/*` handler, the cookie for a server-created session, and the
 * password routes (phase 4). Settings, the Better Auth instance, the pepper ring
 * and the password construction stay internal to this directory.
 *
 * Adding the password handlers here rather than in `routes/` is deliberate: they
 * are protocol mechanics (which body shape, which KDF, which comparison), and
 * the route table in `index.ts` should only mount them.
 */

export { requireRole, forbidden, unauthorized, ROLES } from "./guard";
export type { AuthUser, GuardResult, RequireRoleOptions, Role } from "./guard";
export { handleAuthRequest, startSecondFactorChallenge } from "./handler";
export { createSessionForUser, issueSessionCookie, sessionCookieHeader } from "./session";
export {
  handlePasswordRemove,
  handlePasswordSalt,
  handlePasswordSet,
  handlePasswordSignIn,
  handleRotatePepper,
} from "./password-routes";
